/**
 * Issue #114: what a run produced has to outlive the run.
 *
 * The runner has always sent the tail of a run's output on every completion,
 * succeeded or failed (see `packages/runner/src/run-output.test.ts`, which
 * drives the real `executeClaim` and asserts the exact payloads reproduced
 * below). This handler read it in one place only — synthesizing a
 * `TaskStepOutput` for a *successful* run whose task had a template, chain or
 * follow-up — and dropped it everywhere else. A failed run therefore left the
 * system with no record of what it had found, which is the case where the
 * record is worth the most: an incident could afterwards only be guessed at.
 *
 * The second defect is one of identity rather than loss. When a task already
 * had an output row, the completion transaction restamped that row's `runId`
 * and `metadata` with the completing run's while leaving the body written by an
 * earlier run — a row that claimed to be run 2's work while its text was run
 * 1's. Which run's output *counts* when more than one has produced something is
 * a cardinality question this table cannot express yet, and it is answered by
 * issue #121; this test only pins the lie shut.
 */

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, PrismaClient, TaskStatus } from "@agentos/db";

import { hashToken } from "./auth.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-run-output";
const RUNNER = "runner-run-output";
const isolatedRoot = process.env.RUNNER_WORKSPACE_ROOT!;

const withTokens = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = [
    ["OPERATOR_TOKEN", process.env.OPERATOR_TOKEN],
    ["RUNNER_TOKEN", process.env.RUNNER_TOKEN],
    ["RUNNER_WORKSPACE_ROOT", process.env.RUNNER_WORKSPACE_ROOT],
  ] as const;
  mkdirSync(isolatedRoot, { recursive: true });
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  process.env.RUNNER_WORKSPACE_ROOT = isolatedRoot;
  try {
    return await operation();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

const call = async (
  method: string, path: string, token: string, body?: unknown,
): Promise<{ status: number; body: any }> => withTokens(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) as any };
});

let sequence = 0;
const seedTask = async (options: { chained: boolean }) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Run output", slug: `run-output-${suffix}` } });
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
    projectId: project.id, name: "Find the inbox deadlock", description: "work", assigneeAgentId: agent.id,
    repoId: repo.id, status: TaskStatus.TODO, targetBranch: "master",
    ...(options.chained ? { chainId: `chain-${suffix}`, chainIndex: 0 } : {}),
  } });
  return { project, agent, repo, task };
};

/**
 * Puts a queued run into the state a successful claim leaves behind. The claim
 * route is exercised by its own tests; what these need is the *session*
 * credential a claim issues, because the output route below is the only
 * production writer of a step output and it authenticates with one.
 */
const claimRun = async (runId: string, runnerId: string) => {
  const sessionToken = `agos_session_${runId}`;
  const fencingToken = `fence-${runId}`;
  const now = new Date();
  const run = await db.run.update({ where: { id: runId }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseGeneration: 1,
    leaseExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenHash: hashToken(sessionToken),
    sessionTokenExpiresAt: new Date(now.getTime() + 600_000),
    sessionTokenRevokedAt: null,
    claimedAt: now, heartbeatAt: now, startedAt: now,
  } });
  await db.session.create({ data: {
    runId, projectId: run.projectId, agentId: run.agentId, taskId: run.taskId, runner: run.runner,
    executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: run.taskId! }, data: { status: TaskStatus.DOING } });
  return { run, sessionToken, fencingToken };
};

const enqueue = async (taskId: string): Promise<string> => {
  await db.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, taskId));
  return (run as { id: string }).id;
};

/**
 * Both payloads are the objects `packages/runner/src/run-output.test.ts`
 * observed on the wire out of a real `executeClaim`: a stub agent that prints
 * to stdout and exits 1, and one that emits the adapter's terminal `result`
 * event and exits 0. Only the volatile fields (runner id, fencing token, shas)
 * are parameterised. Keep the two files in step — a shape invented here would
 * make these tests agree with nothing.
 */
const FAILED_TAIL = "reproduced the deadlock: workers 3 and 7 both hold the inbox advisory lock\n"
  + "the fix needs the lock ordering inverted in reconcile.ts";
const SUCCEEDED_TAIL = "inverted the lock ordering in reconcile.ts and added the regression test";
const SHA = "02283bb8e9a08426394a5d2dc471b19bbaea22d7";

const failedCompletion = (runnerId: string, fencingToken: string, branch: string) => ({
  runnerId,
  fencingToken,
  exitCode: 1,
  signal: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  terminationReason: null,
  failureClass: "TASK_FAILED",
  retryable: false,
  failureReason: "Error: session ended without a result",
  output: FAILED_TAIL,
  failureEnvelope: {
    version: 1,
    phase: "EXECUTE",
    runnerClass: "TASK_FAILED",
    exitCode: 1,
    signal: null,
    terminationReason: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    agentExited: true,
    providerError: null,
    stderrSummary: "Error: session ended without a result",
    stdoutSummary: FAILED_TAIL,
    timedOut: false,
    transient: false,
    timeoutMs: null,
  },
  branch,
  baseSha: SHA,
  headSha: SHA,
  pushStatus: "NOT_REQUESTED",
  cleanupStatus: "SUCCEEDED",
  workspaceRetained: false,
});

const succeededCompletion = (runnerId: string, fencingToken: string, branch: string) => ({
  runnerId,
  fencingToken,
  exitCode: 0,
  signal: null,
  terminalEventSeen: true,
  terminalSuccess: true,
  terminationReason: null,
  output: SUCCEEDED_TAIL,
  branch,
  baseSha: SHA,
  headSha: SHA,
  pushStatus: "SUCCEEDED",
  pushRemote: "https://github.com/acme/widgets.git",
  pushedBranch: branch,
  deliveryInstructions: `Branch '${branch}' was pushed. This step does not open a pull request.`,
  cleanupStatus: "SUCCEEDED",
  workspaceRetained: false,
});

test("a failed run's output survives on the run that produced it", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    failedCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "FAILED");
  // The whole of issue #114: before this, the tail this failure arrived with
  // was read by nothing and stored nowhere, and the run's own account of what
  // it found died in the handler that received it.
  assert.equal(closed.output, FAILED_TAIL);
  // And it stays telemetry. The deliverables table is not where a failure's
  // stdout belongs, and nothing downstream may read this as a step's product.
  assert.equal(await db.taskStepOutput.count({ where: { taskId: task.id } }), 0);
});

test("the tail is kept off the task read routes that serialize whole run rows", async () => {
  const { project, task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");
  await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    failedCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).output, FAILED_TAIL);

  // Both routes spread whole run rows into their responses, so a 500k forensic
  // column would ride along on every poll of the board and the task page. The
  // evidence is on the row for whoever goes looking; it is not part of the
  // shape either client asks for.
  const detail = await call("GET", `/tasks/${task.id}`, OPERATOR);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.runs.length, 1);
  assert.equal("output" in detail.body.runs[0], false);
  assert.equal(detail.body.runs[0].failureReason, "Error: session ended without a result");

  const list = await call("GET", `/tasks?projectId=${project.id}`, OPERATOR);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const listed = (list.body as Array<{ id: string; runs: Array<Record<string, unknown>> }>)
    .find((row) => row.id === task.id);
  assert.ok(listed, "the task must still be listed");
  assert.equal("output" in listed.runs[0]!, false);
});

test("a successful run's output is kept on its run as well", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  const completed = await call(
    "POST", `/runner/runs/${runId}/complete`, RUNNER,
    succeededCompletion("runner-1", fencingToken, run.branch ?? "master"),
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "SUCCEEDED");
  // A plain task has no template, chain or follow-up, so this tail used to be
  // discarded too — success was no protection, only a different branch of the
  // same omission.
  assert.equal(closed.output, SUCCEEDED_TAIL);
});

test("a runner too old to send an output completes exactly as it always did", async () => {
  const { task } = await seedTask({ chained: false });
  const runId = await enqueue(task.id);
  const { run, fencingToken } = await claimRun(runId, "runner-1");

  // The same real payload with the field removed, which is what a runner
  // predating it sends: `output` is optional on the wire and this is the whole
  // of the backward-compatibility contract. The column stays NULL — the honest
  // answer for a run whose tail was never reported — and nothing else about the
  // completion changes.
  const { output: _omitted, ...oldRunnerBody } = succeededCompletion(
    "runner-1", fencingToken, run.branch ?? "master",
  );
  const completed = await call("POST", `/runner/runs/${runId}/complete`, RUNNER, oldRunnerBody);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.succeeded, true);

  const closed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(closed.status, "SUCCEEDED");
  assert.equal(closed.output, null);
  assert.equal(closed.headSha, SHA, "the rest of the completion landed as usual");
});

test("a later run does not restamp the output row an earlier run wrote", async () => {
  const { task } = await seedTask({ chained: true });
  const firstRunId = await enqueue(task.id);
  const first = await claimRun(firstRunId, "runner-1");

  // The only production writer of a step output: the agent's own session,
  // through the MCP output tool's route.
  const written = await call("PUT", `/session/runs/${firstRunId}/output`, first.sessionToken, {
    fencingToken: first.fencingToken,
    kind: "result",
    body: "The deadlock is in reconcile.ts; here is the patch and its proof.",
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));

  const firstCompleted = await call(
    "POST", `/runner/runs/${firstRunId}/complete`, RUNNER,
    failedCompletion("runner-1", first.fencingToken, first.run.branch ?? "master"),
  );
  assert.equal(firstCompleted.status, 200, JSON.stringify(firstCompleted.body));

  // An operator reruns the step: the fourth run-creating path, and the one an
  // operator actually reaches from a task that landed in review.
  const retried = await call("POST", `/tasks/${task.id}/retry`, OPERATOR);
  assert.equal(retried.status, 201, JSON.stringify(retried.body));
  const second = await claimRun(retried.body.id as string, "runner-2");

  // Run 2 succeeds without writing an output of its own — the agent simply did
  // not call the tool, which is ordinary.
  const secondCompleted = await call(
    "POST", `/runner/runs/${second.run.id}/complete`, RUNNER,
    succeededCompletion("runner-2", second.fencingToken, second.run.branch ?? "master"),
  );
  assert.equal(secondCompleted.status, 200, JSON.stringify(secondCompleted.body));

  const row = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: task.id } });
  // One act of authorship: body, author and metadata all still run 1's. The
  // restamp used to move two of the three and leave the body behind.
  assert.equal(row.body, "The deadlock is in reconcile.ts; here is the patch and its proof.");
  assert.equal(row.runId, firstRunId);
  assert.equal(row.metadata, null);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: task.id } }), 1);

  // Neither run lost its own tail to the other's completion.
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: firstRunId } })).output, FAILED_TAIL);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: second.run.id } })).output, SUCCEEDED_TAIL);
});
