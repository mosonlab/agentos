/**
 * R5: a long diagnosis must not be what kills the run that wrote it.
 *
 * `failureReason` used to be `z.string().max(4000)` on the completion route, so
 * a session that reported a thorough failure got a 400 from zod and lost the
 * whole completion — the report, the run's disposition, everything — to the
 * length of its own evidence. It is now truncated at the boundary instead.
 *
 * The second half is the way back out: PATCH /tasks/:id could not write
 * `failureReason` at all, so a task carrying a stale reason had no way to shed
 * it short of a database edit.
 */

import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, PrismaClient, TaskStatus } from "@anneal/db";

import { hashToken } from "./auth.js";
import { FAILURE_REASON_LIMIT } from "./failure-reason.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-failure-reason";
const RUNNER = "runner-failure-reason";

const call = async (
  method: string, path: string, token: string, body?: unknown,
): Promise<{ status: number; body: any }> => {
  const prior = [["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN], ["RUNNER_TOKEN", process.env.RUNNER_TOKEN]] as const;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const response = await createApp(db).request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

let sequence = 0;
const seedTask = async () => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Failure reason", slug: `failure-reason-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "claude-opus-5:high", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "master",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Step", description: "work", assigneeAgentId: agent.id,
    repoId: repo.id, status: TaskStatus.TODO, targetBranch: "master",
  } });
  return { project, agent, repo, task };
};

const queueRun = async (taskId: string) =>
  await db.$transaction((tx) => enqueueTaskRun(tx as never, taskId)) as { id: string };

const claimRun = async (taskId: string) => {
  const queued = await queueRun(taskId);
  const now = new Date();
  const fencingToken = `fence-${queued.id}`;
  const run = await db.run.update({ where: { id: queued.id }, data: {
    status: "RUNNING", runnerId: "runner-1", fencingToken, leaseGeneration: 1,
    leaseExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenHash: hashToken(`agos_session_${queued.id}`),
    sessionTokenExpiresAt: new Date(now.getTime() + 600_000),
    claimedAt: now, heartbeatAt: now, startedAt: now,
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: run.projectId, agentId: run.agentId, taskId: run.taskId, runner: run.runner,
    executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DOING } });
  return { run, fencingToken };
};

const DIAGNOSIS = `${"the inbox advisory lock is taken in two orders; ".repeat(300)}TAIL MARKER`;

test("a completion whose failure reason exceeds the limit is truncated, not refused", async () => {
  const { task } = await seedTask();
  const { run, fencingToken } = await claimRun(task.id);
  assert.ok(DIAGNOSIS.length > FAILURE_REASON_LIMIT, "the fixture has to exceed the limit");

  const completed = await call("POST", `/runner/runs/${run.id}/complete`, RUNNER, {
    runnerId: "runner-1",
    fencingToken,
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    failureClass: "TASK_FAILED",
    retryable: false,
    failureReason: DIAGNOSIS,
    branch: run.branch ?? "master",
    pushStatus: "NOT_REQUESTED",
    cleanupStatus: "SUCCEEDED",
    workspaceRetained: false,
  });
  // Before R5 this was a 400 from zod's `too_big`, and the run stayed RUNNING
  // with no disposition at all.
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const closed = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(closed.status, "FAILED");
  assert.equal(closed.failureReason?.length, FAILURE_REASON_LIMIT);
  assert.ok(closed.failureReason!.startsWith("the inbox advisory lock is taken in two orders;"));
  assert.match(closed.failureReason!, /\[truncated by the API: \d+ characters exceeded the 4000-character limit\]$/u);
  assert.equal(closed.failureReason!.includes("TAIL MARKER"), false);
});

test("an operator clears a stale failure reason with an explicit null", async () => {
  const { task } = await seedTask();
  await db.task.update({ where: { id: task.id }, data: { failureReason: "gate formed no verdict" } });

  const patched = await call("PATCH", `/tasks/${task.id}`, OPERATOR, { failureReason: null });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.failureReason, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).failureReason, null);
});

test("a patched failure reason is bounded by the same truncation", async () => {
  const { task } = await seedTask();

  const patched = await call("PATCH", `/tasks/${task.id}`, OPERATOR, { failureReason: DIAGNOSIS });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const stored = (await db.task.findUniqueOrThrow({ where: { id: task.id } })).failureReason;
  assert.equal(stored?.length, FAILURE_REASON_LIMIT);
  assert.match(stored!, /\[truncated by the API: \d+ characters exceeded the 4000-character limit\]$/u);
});

// A status change takes the locked write path; the reason has to travel with it
// rather than be dropped by the branch that happens to serve the request.
test("a failure reason clears on the same request that moves the status", async () => {
  const { task } = await seedTask();
  await db.task.update({ where: { id: task.id }, data: {
    status: TaskStatus.BACKLOG, failureReason: "gate formed no verdict",
  } });

  const patched = await call("PATCH", `/tasks/${task.id}`, OPERATOR, { status: "TODO", failureReason: null });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const after = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.status, TaskStatus.TODO);
  assert.equal(after.failureReason, null);
});

// The `opensPullRequest` branch is a third write path through the same route,
// and it is the one an operator uses while re-aiming a failed task.
test("a failure reason clears alongside an opensPullRequest edit", async () => {
  const { task } = await seedTask();
  await db.task.update({ where: { id: task.id }, data: { failureReason: "gate formed no verdict" } });

  const patched = await call("PATCH", `/tasks/${task.id}`, OPERATOR, {
    opensPullRequest: false, failureReason: null,
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  const edited = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(edited.opensPullRequest, false);
  assert.equal(edited.failureReason, null);
});

// A cancellation reason lands on the Run, the Task and the Session as a failure
// reason, so it goes through the same door rather than a rejecting `.max()`.
test("an over-long cancellation reason is truncated instead of refused", async () => {
  const { task } = await seedTask();
  const run = await queueRun(task.id);

  const cancelled = await call("POST", `/runs/${run.id}/cancel`, OPERATOR, {
    requestId: "cancel-long-reason", reason: DIAGNOSIS,
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  const stopped = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(stopped.failureReason?.length, FAILURE_REASON_LIMIT);
  assert.match(stopped.failureReason!, /\[truncated by the API: \d+ characters exceeded the 4000-character limit\]$/u);
});
