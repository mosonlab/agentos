import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, RunStatus, SessionExecutionStatus, TaskStatus } from "@agentos/db";

import { suspendForInbox } from "./inbox.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "active-cancel-operator";
const RUNNER = "active-cancel-runner-token";
const RUNNER_ID = "active-cancel-runner";

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const priorOperator = process.env.OPERATOR_TOKEN;
  const priorRunner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  try {
    const response = await createApp(db).request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorOperator;
    if (priorRunner === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorRunner;
  }
};

let sequence = 0;
const seed = async (status: RunStatus, leaseExpiresAt = new Date(Date.now() + 600_000)) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Cancellation", slug: `cancel-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/repo.git",
    mountPath: "/repo", defaultBranch: "main",
  } });
  const successor = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, name: "Successor", description: "must stay stopped",
    assigneeAgentId: agent.id, status: TaskStatus.TODO,
  } });
  const task = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, name: "Active", description: "cancel me",
    assigneeAgentId: agent.id, status: status === RunStatus.QUEUED ? TaskStatus.TODO : TaskStatus.DOING,
    followUpTaskId: successor.id,
  } });
  const owned = status === RunStatus.QUEUED ? {} : {
    runnerId: RUNNER_ID,
    fencingToken: `fence-${suffix}`,
    leaseGeneration: 1,
    leaseExpiresAt,
    heartbeatAt: new Date(),
    claimedAt: new Date(),
  };
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: task.id, agentId: agent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${task.id}:run:1`, status,
    runner: "CODEX", model: agent.model, promptHash: "hash", branch: `codex/cancel-${suffix}`,
    workspacePath: `/scratch/${suffix}`, ...owned,
  } });
  const session = status === RunStatus.QUEUED ? null : await db.session.create({ data: {
    runId: run.id, projectId: project.id, taskId: task.id, agentId: agent.id, runner: "CODEX",
    executionStatus: status === RunStatus.RUNNING
      ? SessionExecutionStatus.RUNNING
      : status === RunStatus.WAITING_INBOX ? SessionExecutionStatus.WAITING_INBOX : SessionExecutionStatus.PROVISIONING,
  } });
  return { project, task, successor, run, session };
};

const heartbeat = (runId: string, fencingToken: string) => call("POST", `/runner/runs/${runId}/heartbeat`, RUNNER, {
  runnerId: RUNNER_ID, fencingToken, leaseSeconds: 60, processAlive: true,
  lastProgressEventAt: null, inFlightTool: null,
});

test("every live provider status exposes one idempotent cancellation through heartbeat and acknowledgement", async () => {
  for (const status of [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING]) {
    const seeded = await seed(status);
    const requestId = `cancel-${status.toLowerCase()}`;
    const requested = await call("POST", `/runs/${seeded.run.id}/cancel`, OPERATOR, { requestId, reason: `stop ${status}` });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.cancellationState, "requested");

    const duplicate = await call("POST", `/runs/${seeded.run.id}/cancel`, OPERATOR, { requestId, reason: "ignored duplicate wording" });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.requestId, requestId);
    assert.equal((await call("POST", `/runs/${seeded.run.id}/cancel`, OPERATOR, { requestId: `${requestId}-other`, reason: "other" })).status, 409);

    const observed = await heartbeat(seeded.run.id, seeded.run.fencingToken!);
    assert.equal(observed.status, 200);
    assert.equal(observed.body.cancellation.requestId, requestId);
    assert.equal(observed.body.cancellation.reason, `stop ${status}`);

    const acknowledged = await call("POST", `/runner/runs/${seeded.run.id}/cancel/acknowledge`, RUNNER, {
      runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken, requestId,
    });
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.body.status, RunStatus.CANCELLED);
    assert.equal((await call("POST", `/runner/runs/${seeded.run.id}/cancel/acknowledge`, RUNNER, {
      runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken, requestId,
    })).status, 200);

    const [run, task, successor, runs] = await Promise.all([
      db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
      db.task.findUniqueOrThrow({ where: { id: seeded.successor.id } }),
      db.run.count({ where: { taskId: seeded.task.id } }),
    ]);
    assert.equal(run.status, RunStatus.CANCELLED);
    assert.equal(run.workspacePath, seeded.run.workspacePath);
    assert.equal(run.workspaceRetained, true);
    assert.ok(run.cancelAcknowledgedAt);
    assert.equal(task.status, TaskStatus.REVIEW);
    assert.equal(successor.status, TaskStatus.TODO);
    assert.equal(runs, 1);

    const lateCompletion = await call("POST", `/runner/runs/${seeded.run.id}/complete`, RUNNER, {
      runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken, exitCode: 0,
      terminalEventSeen: true, terminalSuccess: true, pushStatus: "NOT_REQUESTED",
      cleanupStatus: "RETAINED", workspaceRetained: true,
    });
    assert.equal(lateCompletion.status, 409);
  }
});

test("QUEUED and WAITING_INBOX cancellation settle immediately without a provider acknowledgement", async () => {
  for (const status of [RunStatus.QUEUED, RunStatus.WAITING_INBOX]) {
    const seeded = await seed(status);
    const response = await call("POST", `/runs/${seeded.run.id}/cancel`, OPERATOR, {
      requestId: `cancel-immediate-${status.toLowerCase()}`, reason: "operator stop",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.cancellationState, "acknowledged");
    const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
    assert.equal(run.status, RunStatus.CANCELLED);
    assert.ok(run.cancelAcknowledgedAt);
    if (seeded.session) {
      const session = await db.session.findUniqueOrThrow({ where: { id: seeded.session.id } });
      assert.equal(session.executionStatus, SessionExecutionStatus.CANCELLED);
    }
  }
});

test("lease reconciliation settles an unacknowledged cancellation without retrying", async () => {
  const now = new Date();
  const seeded = await seed(RunStatus.RUNNING, new Date(now.getTime() - 1_000));
  await db.run.update({ where: { id: seeded.run.id }, data: {
    cancelRequestId: "cancel-expired", cancelReason: "stop after runner loss", cancelRequestedAt: new Date(now.getTime() - 2_000),
  } });
  assert.equal(await reconcileDatabaseRuns(db, now), 1);
  const [run, count, successor] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    db.run.count({ where: { taskId: seeded.task.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.successor.id } }),
  ]);
  assert.equal(run.status, RunStatus.CANCELLED);
  assert.equal(run.cancelAcknowledgedAt?.toISOString(), now.toISOString());
  assert.equal(count, 1);
  assert.equal(successor.status, TaskStatus.TODO);
});

test("a cancellation intent fences out a late Inbox suspension", async () => {
  const seeded = await seed(RunStatus.RUNNING);
  await db.session.update({
    where: { id: seeded.session!.id },
    data: { providerConversationId: "conversation-before-cancel" },
  });
  const requested = await call("POST", `/runs/${seeded.run.id}/cancel`, OPERATOR, {
    requestId: "cancel-before-inbox", reason: "stop before question",
  });
  assert.equal(requested.status, 200);
  assert.equal(requested.body.cancellationState, "requested");
  await assert.rejects(
    suspendForInbox(db, {
      runId: seeded.run.id,
      fencingToken: seeded.run.fencingToken!,
      requestId: "late-question",
      body: "This must not be delivered",
      choices: [],
      chatId: "chat-after-cancel",
    }),
    /Run is not resumable/u,
  );
  assert.equal(await db.inboxMessage.count({ where: { sessionId: seeded.session!.id } }), 0);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).status, RunStatus.RUNNING);
});

test("a completion that commits first remains authoritative", async () => {
  const seeded = await seed(RunStatus.RUNNING);
  const completed = await call("POST", `/runner/runs/${seeded.run.id}/complete`, RUNNER, {
    runnerId: RUNNER_ID, fencingToken: seeded.run.fencingToken, exitCode: 1,
    terminalEventSeen: true, terminalSuccess: false, failureReason: "finished first",
    retryable: false, pushStatus: "NOT_REQUESTED", cleanupStatus: "RETAINED", workspaceRetained: true,
  });
  assert.equal(completed.status, 200);
  const cancellation = await call("POST", `/runs/${seeded.run.id}/cancel`, OPERATOR, {
    requestId: "cancel-too-late", reason: "too late",
  });
  assert.equal(cancellation.status, 200);
  assert.equal(cancellation.body.cancellationState, "terminal");
  const run = await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.cancelRequestId, null);
});
