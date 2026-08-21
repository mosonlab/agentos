import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import { activateChainSuccessor, applyInboxDecisionTx, Prisma, PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { instantiateTemplate } from "./templates.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const seedExecutableChain = async () => {
  const project = await db.project.create({ data: { name: "Chain", slug: `chain-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo" } });
  await db.agentRepoAccess.create({ data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" } });
  const chainId = `chain-${Date.now()}`;
  const predecessor = await db.task.create({ data: {
    projectId: project.id, name: "First", description: "first", assigneeAgentId: agent.id, repoId: repo.id,
    status: "DONE", chainId, chainIndex: 0,
  } });
  const successor = await db.task.create({ data: {
    projectId: project.id, name: "Second", description: "second", assigneeAgentId: agent.id, repoId: repo.id,
    chainId, chainIndex: 1,
  } });
  return { project, agent, repo, predecessor, successor };
};

const completionBody = (runnerId: string, fencingToken: string, output = "Finished work") => ({
  runnerId, fencingToken, exitCode: 0, terminalEventSeen: true, terminalSuccess: true, output, cleanupStatus: "SUCCEEDED",
});

const seedRunningRun = async (taskId: string, projectId: string, agentId: string, repoId: string) => {
  const runnerId = `runner-${Date.now()}`;
  const fencingToken = `1:${taskId}:${Date.now()}`;
  const run = await db.run.create({ data: {
    projectId, taskId, agentId, repoId, runNumber: 1, dedupeKey: `task:${taskId}:run:1`, runner: "CLAUDE",
    runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000), status: "RUNNING", model: "claude", promptHash: "hash",
  } });
  await db.session.create({ data: { runId: run.id, projectId, agentId, taskId, runner: "CLAUDE", executionStatus: "RUNNING" } });
  return { run, runnerId, fencingToken };
};

// Provisioned by ./test-workspace-root.js above, or by whatever the caller
// exported as RUNNER_WORKSPACE_ROOT. This used to be the literal
// /private/tmp/agentos-api-dbtest-workspaces, which is a macOS-only path: on
// Linux /private is not writable and every runner-token test here died at
// mkdir before it reached an assertion.
const isolatedRoot = process.env.RUNNER_WORKSPACE_ROOT!;

const withRunnerToken = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const priorToken = process.env.RUNNER_TOKEN;
  const priorRoot = process.env.RUNNER_WORKSPACE_ROOT;
  mkdirSync(isolatedRoot, { recursive: true });
  process.env.RUNNER_TOKEN = "runner-db-token";
  process.env.RUNNER_WORKSPACE_ROOT = isolatedRoot;
  try {
    return await operation();
  } finally {
    if (priorToken === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = priorToken;
    if (priorRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT; else process.env.RUNNER_WORKSPACE_ROOT = priorRoot;
  }
};

test("concurrent chain advance creates exactly one successor run with no client-visible conflict", async () => {
  const { predecessor, successor } = await seedExecutableChain();
  const otherDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const call = (client: PrismaClient) => client.$transaction(
    (tx) => activateChainSuccessor(tx, predecessor, {}, new Date()),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  try {
    await assert.doesNotReject(Promise.all([call(db), call(otherDb)]));
  } finally {
    await otherDb.$disconnect();
  }
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 1);
});

test("chain activation sees an older active run hidden behind a newer terminal run", async () => {
  const { project, agent, repo, predecessor, successor } = await seedExecutableChain();
  // Older run still waiting on the inbox; a newer retry already failed. The
  // latest-run-only read used to see only FAILED and double-start the successor.
  await db.run.create({ data: {
    projectId: project.id, taskId: successor.id, agentId: agent.id, repoId: repo.id, runNumber: 1,
    dedupeKey: `task:${successor.id}:run:1`, runner: "CLAUDE", status: "WAITING_INBOX", model: "claude", promptHash: "hash",
  } });
  await db.run.create({ data: {
    projectId: project.id, taskId: successor.id, agentId: agent.id, repoId: repo.id, runNumber: 2,
    dedupeKey: `task:${successor.id}:run:2`, runner: "CLAUDE", status: "FAILED", model: "claude", promptHash: "hash",
  } });
  const result = await db.$transaction((tx) => activateChainSuccessor(tx, predecessor, {}, new Date()));
  assert.equal(result.nextTaskId, successor.id);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 2);
});

test("runner completion and manual successor start serialize to one run without duplicate evidence", { timeout: 20_000 }, async () => {
  const { project, agent, repo, predecessor, successor } = await seedExecutableChain();
  await db.task.update({ where: { id: predecessor.id }, data: { status: "DOING" } });
  const running = await seedRunningRun(predecessor.id, project.id, agent.id, repo.id);
  const completionClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const startClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let completionLocked!: () => void;
  let startAttempted!: () => void;
  let releaseCompletion!: () => void;
  const completionHasLock = new Promise<void>((resolve) => { completionLocked = resolve; });
  const startReachedLock = new Promise<void>((resolve) => { startAttempted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  let completionIntercepted = false;
  let startIntercepted = false;
  const instrumentTransactions = (
    client: PrismaClient,
    onQuery: (pending: Promise<unknown>) => Promise<unknown>,
  ): PrismaClient => new Proxy(client, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return (...args: unknown[]) => onQuery(Reflect.apply(txTarget.$queryRaw, txTarget, args));
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;
  const completionDb = instrumentTransactions(completionClient, async (pending) => {
    const result = await pending;
    if (!completionIntercepted) {
      completionIntercepted = true;
      completionLocked();
      await release;
    }
    return result;
  });
  const startDb = instrumentTransactions(startClient, async (pending) => {
    if (!startIntercepted) {
      startIntercepted = true;
      startAttempted();
    }
    return pending;
  });
  const priorOperator = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-db-token";
  try {
    await withRunnerToken(async () => {
      const completion = createApp(completionDb).request(`/runner/runs/${running.run.id}/complete`, {
        method: "POST", headers: { Authorization: "Bearer runner-db-token", "Content-Type": "application/json" },
        body: JSON.stringify(completionBody(running.runnerId, running.fencingToken, "race artifact")),
      });
      await completionHasLock;
      const manualStart = createApp(startDb).request(`/tasks/${successor.id}/start`, {
        method: "POST", headers: { Authorization: "Bearer operator-db-token" },
      });
      await startReachedLock;
      releaseCompletion();
      const [completed, started] = await Promise.all([completion, manualStart]);
      assert.equal(completed.status, 200);
      assert.equal(started.status, 409);
      assert.equal((await started.json() as { error: string }).error, "Task already has an active run");
    });
  } finally {
    if (priorOperator === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorOperator;
    await Promise.all([completionClient.$disconnect(), startClient.$disconnect()]);
  }
  assert.equal(await db.run.count({ where: { taskId: successor.id, status: "QUEUED" } }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: successor.id } }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: predecessor.id, actorType: "runner" } }), 1);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: predecessor.id, body: "race artifact" } }), 1);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: successor.id } }), 0);
});

test("automatic advancement skips a legacy DONE gap and queues the later TODO", async () => {
  const { project, agent, repo, predecessor, successor } = await seedExecutableChain();
  await db.task.update({ where: { id: successor.id }, data: { status: "DONE" } });
  const later = await db.task.create({ data: {
    projectId: project.id,
    assigneeAgentId: agent.id,
    repoId: repo.id,
    chainId: predecessor.chainId,
    chainIndex: 2,
    name: "Third",
    description: "third",
  } });
  await db.$transaction((tx) => activateChainSuccessor(tx, predecessor, {}, new Date()));
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.equal(await db.run.count({ where: { taskId: later.id, status: "QUEUED" } }), 1);
});

test("automatic advancement reselects after the observed successor is deleted", async () => {
  const { project, agent, repo, predecessor, successor } = await seedExecutableChain();
  const later = await db.task.create({ data: {
    projectId: project.id,
    assigneeAgentId: agent.id,
    repoId: repo.id,
    chainId: predecessor.chainId,
    chainIndex: 2,
    name: "Third",
    description: "third",
  } });
  const deleteDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let deleted = false;
  try {
    await db.$transaction(async (tx) => {
      const task = new Proxy(tx.task, { get(target, property, receiver) {
        if (property !== "findFirst") return Reflect.get(target, property, receiver);
        return async (args: any) => {
          const candidate = await tx.task.findFirst(args);
          if (!deleted) {
            deleted = true;
            await deleteDb.task.delete({ where: { id: successor.id } });
          }
          return candidate;
        };
      } });
      const instrumented = new Proxy(tx, { get(target, property, receiver) {
        return property === "task" ? task : Reflect.get(target, property, receiver);
      } });
      await activateChainSuccessor(instrumented as any, predecessor, {}, new Date());
    });
  } finally {
    await deleteDb.$disconnect();
  }
  assert.equal(deleted, true);
  assert.equal(await db.task.count({ where: { id: successor.id } }), 0);
  assert.equal(await db.run.count({ where: { taskId: later.id, status: "QUEUED" } }), 1);
});

test("an unrelated successor patch between observation and lock is re-read and still queues", async () => {
  const { predecessor, successor } = await seedExecutableChain();
  const patchDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let patched = false;
  try {
    await db.$transaction(async (tx) => {
      const task = new Proxy(tx.task, { get(target, property, receiver) {
        if (property !== "findFirst") return Reflect.get(target, property, receiver);
        return async (args: any) => {
          const candidate = await tx.task.findFirst(args as any);
          if (!patched) {
            patched = true;
            await patchDb.task.update({ where: { id: successor.id }, data: { description: "harmless operator edit" } });
          }
          return candidate;
        };
      } });
      const instrumentedTx = new Proxy(tx, { get(target, property, receiver) {
        return property === "task" ? task : Reflect.get(target, property, receiver);
      } });
      await activateChainSuccessor(instrumentedTx as any, predecessor, {}, new Date());
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } finally {
    await patchDb.$disconnect();
  }
  assert.equal(patched, true);
  assert.equal(await db.run.count({ where: { taskId: successor.id, status: "QUEUED" } }), 1);
});

test("repeating DONE after the successor finished never resurrects or requeues it", async () => {
  const { predecessor, successor } = await seedExecutableChain();
  await db.task.update({ where: { id: predecessor.id }, data: { status: "REVIEW" } });
  const priorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-db-token";
  const patchDone = () => createApp(db).request(`/tasks/${predecessor.id}`, {
    method: "PATCH", headers: { Authorization: "Bearer operator-db-token", "Content-Type": "application/json" }, body: JSON.stringify({ status: "DONE" }),
  });
  try {
    assert.equal((await patchDone()).status, 200);
    await db.run.updateMany({ where: { taskId: successor.id }, data: { status: "SUCCEEDED" } });
    await db.task.update({ where: { id: successor.id }, data: { status: "DONE" } });
    assert.equal((await patchDone()).status, 200);
  } finally {
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorToken;
  }
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, "DONE");
});

test("non-template run completion advances a follow-up-only task and persists output", async () => {
  const { project, agent, repo, predecessor, successor } = await seedExecutableChain();
  await db.task.update({ where: { id: predecessor.id }, data: { status: "DOING", chainId: null, chainIndex: null, followUpTaskId: successor.id } });
  await db.task.update({ where: { id: successor.id }, data: { chainId: null, chainIndex: null } });
  const { run, runnerId, fencingToken } = await seedRunningRun(predecessor.id, project.id, agent.id, repo.id);
  const response = await withRunnerToken(() => createApp(db).request(`/runner/runs/${run.id}/complete`, {
    method: "POST", headers: { Authorization: "Bearer runner-db-token", "Content-Type": "application/json" },
    body: JSON.stringify(completionBody(runnerId, fencingToken, "reviewable artifact")),
  }));
  assert.equal(response.status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, "DONE");
  assert.equal(await db.run.count({ where: { taskId: successor.id, status: "QUEUED" } }), 1);
  assert.equal((await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: predecessor.id } })).body, "reviewable artifact");
});

test("gated non-template run completion creates an OPEN card and reviewable output", async () => {
  const { project, agent, repo, predecessor } = await seedExecutableChain();
  await db.task.update({ where: { id: predecessor.id }, data: { status: "DOING", approvalGate: true } });
  const { run, runnerId, fencingToken } = await seedRunningRun(predecessor.id, project.id, agent.id, repo.id);
  const response = await withRunnerToken(() => createApp(db).request(`/runner/runs/${run.id}/complete`, {
    method: "POST", headers: { Authorization: "Bearer runner-db-token", "Content-Type": "application/json" },
    body: JSON.stringify(completionBody(runnerId, fencingToken, "gate artifact")),
  }));
  assert.equal(response.status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, "REVIEW");
  const gate = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: predecessor.id, status: "OPEN" } });
  assert.equal(gate.dedupeKey, `gate:task:${predecessor.id}:run:${run.id}`);
  assert.match(gate.body, /gate artifact/);
});

const completeIntoHumanGate = async () => {
  const seeded = await seedExecutableChain();
  await db.task.update({ where: { id: seeded.predecessor.id }, data: { status: "DOING" } });
  await db.task.update({ where: { id: seeded.successor.id }, data: { assigneeType: "HUMAN", assigneeAgentId: null, repoId: null } });
  const running = await seedRunningRun(seeded.predecessor.id, seeded.project.id, seeded.agent.id, seeded.repo.id);
  const response = await withRunnerToken(() => createApp(db).request(`/runner/runs/${running.run.id}/complete`, {
    method: "POST", headers: { Authorization: "Bearer runner-db-token", "Content-Type": "application/json" },
    body: JSON.stringify(completionBody(running.runnerId, running.fencingToken)),
  }));
  assert.equal(response.status, 200);
  const gate = await db.inboxMessage.findFirstOrThrow({ where: { gateTaskId: seeded.successor.id, status: "OPEN" } });
  return { ...seeded, gate };
};

const seedDuplicateGateCards = async () => {
  const seeded = await seedExecutableChain();
  await db.task.update({ where: { id: seeded.predecessor.id }, data: { status: "REVIEW" } });
  const run = await db.run.create({ data: {
    projectId: seeded.project.id, taskId: seeded.predecessor.id, agentId: seeded.agent.id, repoId: seeded.repo.id,
    runNumber: 1, dedupeKey: `task:${seeded.predecessor.id}:duplicate-gates`, runner: "CLAUDE",
    model: seeded.agent.model, promptHash: "hash", status: "SUCCEEDED",
  } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: seeded.agent.id,
    taskId: seeded.predecessor.id, runner: "CLAUDE",
  } });
  const first = await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: seeded.agent.id, sessionId: session.id, taskId: seeded.predecessor.id,
    gateTaskId: seeded.predecessor.id, kind: "MULTIPLE_CHOICE", body: "first gate card",
    choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    dedupeKey: `gate:duplicate:first:${seeded.predecessor.id}`,
  } });
  const second = await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: seeded.agent.id, sessionId: session.id, taskId: seeded.predecessor.id,
    gateTaskId: seeded.predecessor.id, kind: "MULTIPLE_CHOICE", body: "second gate card",
    choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    dedupeKey: `gate:duplicate:second:${seeded.predecessor.id}`,
  } });
  const unrelated = await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: seeded.agent.id, sessionId: session.id, taskId: seeded.successor.id,
    gateTaskId: seeded.successor.id, kind: "MULTIPLE_CHOICE", body: "unrelated gate",
    choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    dedupeKey: `gate:unrelated:${seeded.successor.id}`,
  } });
  return { ...seeded, first, second, unrelated };
};

const assertDuplicateGateCardsHaveOneWinner = async (firstDecision: "approve" | "reject") => {
  const { predecessor, successor, first, second, unrelated } = await seedDuplicateGateCards();
  const secondDecision = firstDecision === "approve" ? "reject" : "approve";
  const decide = (inboxMessageId: string, decision: "approve" | "reject", event: string) => db.$transaction(
    (tx) => applyInboxDecisionTx(tx, { inboxMessageId, externalEventId: event, decision }),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );

  const winner = await decide(first.id, firstDecision, `duplicate-winner-${firstDecision}-${Date.now()}`);
  const loser = await decide(second.id, secondDecision, `duplicate-loser-${secondDecision}-${Date.now()}`);
  const replay = await decide(first.id, firstDecision, `duplicate-replay-${firstDecision}-${Date.now()}`);

  assert.equal(winner.duplicate, false);
  assert.equal(winner.gateAction, firstDecision === "approve" ? "approved" : "rejected");
  assert.deepEqual(loser, { duplicate: true, resumed: false });
  assert.deepEqual(replay, { duplicate: true, resumed: false });
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: first.id } })).status, "ANSWERED");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: second.id } })).status, "CLOSED");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: unrelated.id } })).status, "OPEN");
  assert.equal(await db.inboxDecision.count({ where: { inboxMessageId: { in: [first.id, second.id] } } }), 1);
  assert.equal(await db.inboxMessage.count({ where: { replyToMessageId: { in: [first.id, second.id] } } }), 1);

  if (firstDecision === "approve") {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, "DONE");
    assert.equal(await db.run.count({ where: { taskId: successor.id } }), 1);
    assert.equal(await db.taskActivity.count({ where: { taskId: predecessor.id, body: "Approval gate approved" } }), 1);
  } else {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, "TODO");
    assert.equal(await db.run.count({ where: { taskId: predecessor.id } }), 2);
    assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
    assert.equal(await db.taskActivity.count({ where: { taskId: predecessor.id, body: "Approval gate rejected; step queued again" } }), 1);
  }
};

test("rejecting a gate on a non-template HUMAN successor requeues its chain predecessor", async () => {
  const { predecessor, successor, gate } = await completeIntoHumanGate();
  const decision = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id, externalEventId: `reject-${Date.now()}`, decision: "reject",
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  assert.equal(decision.gateAction, "rejected");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, "TODO");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, "TODO");
  assert.equal(await db.run.count({ where: { taskId: predecessor.id } }), 2);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: gate.id } })).status, "ANSWERED");
});

test("approving a gate on a non-template HUMAN successor completes it", async () => {
  const { successor, gate } = await completeIntoHumanGate();
  const decision = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id, externalEventId: `approve-${Date.now()}`, decision: "approve",
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  assert.equal(decision.gateAction, "approved");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, "DONE");
});

test("duplicate OPEN gate cards allow approve then reject to have exactly one winner", async () => {
  await assertDuplicateGateCardsHaveOneWinner("approve");
});

test("duplicate OPEN gate cards allow reject then approve to have exactly one winner", async () => {
  await assertDuplicateGateCardsHaveOneWinner("reject");
});

test("completion status CAS preserves a concurrent operator DONE decision", async () => {
  const { project, agent, repo, predecessor } = await seedExecutableChain();
  await db.task.update({ where: { id: predecessor.id }, data: { status: "DOING", chainId: null, chainIndex: null } });
  const { run, runnerId, fencingToken } = await seedRunningRun(predecessor.id, project.id, agent.id, repo.id);
  let readObserved!: () => void;
  let resumeCompletion!: () => void;
  const readReady = new Promise<void>((resolve) => { readObserved = resolve; });
  const resume = new Promise<void>((resolve) => { resumeCompletion = resolve; });
  let intercepted = false;
  const completionDb = new Proxy(db, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const runDelegate = new Proxy(tx.run, { get(runTarget, runProperty, runReceiver) {
        if (runProperty !== "findFirst" || intercepted) return Reflect.get(runTarget, runProperty, runReceiver);
        return async (args: Parameters<typeof tx.run.findFirst>[0]) => {
          const result = await tx.run.findFirst(args);
          intercepted = true;
          readObserved();
          await resume;
          return result;
        };
      } });
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        return txProperty === "run" ? runDelegate : Reflect.get(txTarget, txProperty, txReceiver);
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;
  const responsePromise = withRunnerToken(() => createApp(completionDb).request(`/runner/runs/${run.id}/complete`, {
    method: "POST", headers: { Authorization: "Bearer runner-db-token", "Content-Type": "application/json" },
    body: JSON.stringify(completionBody(runnerId, fencingToken)),
  }));
  await readReady;
  await db.task.update({ where: { id: predecessor.id }, data: { status: "DONE" } });
  resumeCompletion();
  assert.equal((await responsePromise).status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, "DONE");
});

test("operator DONE closes the gate card and a later approval is a duplicate no-op", async () => {
  const { project, agent, repo, predecessor } = await seedExecutableChain();
  await db.task.update({ where: { id: predecessor.id }, data: { status: "REVIEW", approvalGate: true } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: predecessor.id, agentId: agent.id, repoId: repo.id, runNumber: 1,
    dedupeKey: `task:${predecessor.id}:run:1`, runner: "CLAUDE", model: agent.model, promptHash: "hash", status: "SUCCEEDED",
  } });
  const session = await db.session.create({ data: { runId: run.id, projectId: project.id, agentId: agent.id, taskId: predecessor.id, runner: "CLAUDE" } });
  const gate = await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: agent.id, sessionId: session.id, taskId: predecessor.id, gateTaskId: predecessor.id,
    kind: "MULTIPLE_CHOICE", body: "approve", choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:${predecessor.id}`,
  } });
  const priorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-db-token";
  try {
    const response = await createApp(db).request(`/tasks/${predecessor.id}`, {
      method: "PATCH", headers: { Authorization: "Bearer operator-db-token", "Content-Type": "application/json" }, body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 200);
  } finally {
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorToken;
  }
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: gate.id } })).status, "CLOSED");
  const result = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id, externalEventId: `late-${Date.now()}`, decision: "approve",
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  assert.equal(result.duplicate, true);
});

test("template gate PATCH and Inbox approval have one winner and queue the successor at most once", async () => {
  const { project, agent, repo, predecessor, successor } = await seedExecutableChain();
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: "Race template", description: "race", variables: [],
  } });
  await db.task.update({
    where: { id: predecessor.id },
    data: { status: "REVIEW", templateId: template.id, approvalGate: false },
  });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: predecessor.id, agentId: agent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${predecessor.id}:race-approve`, runner: "CLAUDE",
    model: agent.model, promptHash: "hash", status: "SUCCEEDED",
  } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: project.id, agentId: agent.id, taskId: predecessor.id, runner: "CLAUDE",
  } });
  const gate = await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: agent.id, sessionId: session.id, taskId: predecessor.id,
    gateTaskId: predecessor.id, kind: "MULTIPLE_CHOICE", body: "approve",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:race-approve:${predecessor.id}`,
  } });
  const priorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-db-token";
  try {
    const [patch, decision] = await Promise.all([
      createApp(db).request(`/tasks/${predecessor.id}`, {
        method: "PATCH", headers: { Authorization: "Bearer operator-db-token", "Content-Type": "application/json" },
        body: JSON.stringify({ status: "DONE" }),
      }),
      db.$transaction((tx) => applyInboxDecisionTx(tx, {
        inboxMessageId: gate.id, externalEventId: `race-approve-${Date.now()}`, decision: "approve",
      }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
    ]);
    assert.equal(patch.status, 200);
    assert.equal(decision.duplicate || decision.gateAction === "approved", true);
  } finally {
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorToken;
  }

  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, "DONE");
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 1);
  const winnerActivities = await db.taskActivity.count({ where: {
    taskId: predecessor.id,
    body: { in: ["Approval gate approved", "Status changed: REVIEW → DONE"] },
  } });
  assert.equal(winnerActivities, 1);
  assert.ok(["ANSWERED", "CLOSED"].includes(
    (await db.inboxMessage.findUniqueOrThrow({ where: { id: gate.id } })).status,
  ));

  // Both channel replays remain side-effect free after the race settles.
  const replay = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id, externalEventId: `race-approve-replay-${Date.now()}`, decision: "approve",
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  assert.equal(replay.duplicate, true);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 1);
});

test("HUMAN gate PATCH and Inbox rejection have one durable winner", async () => {
  const { predecessor, successor, gate } = await completeIntoHumanGate();
  const priorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-db-token";
  let decision: Awaited<ReturnType<typeof applyInboxDecisionTx>>;
  let patchStatus: number;
  try {
    const results = await Promise.all([
      createApp(db).request(`/tasks/${successor.id}`, {
        method: "PATCH", headers: { Authorization: "Bearer operator-db-token", "Content-Type": "application/json" },
        body: JSON.stringify({ status: "DONE" }),
      }),
      db.$transaction((tx) => applyInboxDecisionTx(tx, {
        inboxMessageId: gate.id, externalEventId: `race-reject-${Date.now()}`, decision: "reject",
      }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
    ]);
    // Which racer wins is the point of the test, so the PATCH's own status is
    // asserted per branch below rather than pinned to 200 here. On a laptop the
    // PATCH always won; on a CI runner the rejection can land first, and then
    // the PATCH is correctly refused.
    patchStatus = results[0].status;
    decision = results[1];
  } finally {
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorToken;
  }

  const settledGate = await db.inboxMessage.findUniqueOrThrow({ where: { id: gate.id } });
  const settledPredecessor = await db.task.findUniqueOrThrow({ where: { id: predecessor.id } });
  const settledSuccessor = await db.task.findUniqueOrThrow({ where: { id: successor.id } });
  if (settledGate.status === "CLOSED") {
    assert.equal(patchStatus!, 200);
    assert.equal(decision!.duplicate, true);
    assert.equal(settledPredecessor.status, "DONE");
    assert.equal(settledSuccessor.status, "DONE");
    assert.equal(await db.run.count({ where: { taskId: predecessor.id } }), 1);
  } else {
    assert.equal(patchStatus!, 409);
    assert.equal(settledGate.status, "ANSWERED");
    assert.equal(decision!.gateAction, "rejected");
    assert.equal(settledPredecessor.status, "TODO");
    assert.equal(settledSuccessor.status, "TODO");
    assert.equal(await db.run.count({ where: { taskId: predecessor.id } }), 2);
  }
  const winnerActivities = await db.taskActivity.count({ where: {
    OR: [
      { taskId: successor.id, body: "Status changed: REVIEW → DONE" },
      { taskId: predecessor.id, body: "Approval gate rejected; step queued again" },
    ],
  } });
  assert.equal(winnerActivities, 1);
});

test("predecessor PATCH DONE and HUMAN-gate reject use predecessor-to-gate lock order", { timeout: 20_000 }, async () => {
  const { predecessor, successor, gate } = await completeIntoHumanGate();
  // Recreate the legitimate P -> G activation edge while preserving the OPEN
  // HUMAN gate on G. Before the fix, reject locked G -> P and this interleaving
  // deterministically deadlocked against PATCH's P -> G order.
  await db.task.update({ where: { id: predecessor.id }, data: { status: "REVIEW" } });

  const patchClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const rejectClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let patchHasPredecessor!: () => void;
  let releasePatch!: () => void;
  let rejectReachedOrderBarrier!: () => void;
  const predecessorLocked = new Promise<void>((resolve) => { patchHasPredecessor = resolve; });
  const patchMayContinue = new Promise<void>((resolve) => { releasePatch = resolve; });
  const lockOrderObserved = new Promise<void>((resolve) => { rejectReachedOrderBarrier = resolve; });
  let patchPaused = false;
  const instrumentedPatchClient = new Proxy(patchClient, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return async (...args: any[]) => {
          const result = await (tx.$queryRaw as any)(...args);
          if (!patchPaused
            && args[1] === predecessor.projectId
            && args[2] === predecessor.chainId
            && args[3] === predecessor.chainIndex) {
            patchPaused = true;
            patchHasPredecessor();
            await patchMayContinue;
          }
          return result;
        };
      } });
      return operation(instrumentedTx);
    }, options as any);
  } }) as PrismaClient;

  let firstRejectLock = true;
  const reject = () => rejectClient.$transaction(async (tx) => {
    const instrumentedTx = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
      if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
      return async (...args: any[]) => {
        if (!firstRejectLock) return (tx.$queryRaw as any)(...args);
        firstRejectLock = false;
        const taskId = args[1];
        // Fixed order: the first P lock waits behind PATCH, so release PATCH as
        // soon as the attempt is made. Old order: first acquire G, then release
        // PATCH; PATCH and reject proceed into the P/G cycle and PostgreSQL
        // reports 40P01.
        if (taskId === predecessor.id) rejectReachedOrderBarrier();
        const result = await (tx.$queryRaw as any)(...args);
        if (taskId === successor.id) rejectReachedOrderBarrier();
        return result;
      };
    } });
    return applyInboxDecisionTx(instrumentedTx as any, {
      inboxMessageId: gate.id, externalEventId: `predecessor-patch-reject-${Date.now()}`, decision: "reject",
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  const priorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-db-token";
  try {
    const patchPromise = createApp(instrumentedPatchClient).request(`/tasks/${predecessor.id}`, {
      method: "PATCH", headers: { Authorization: "Bearer operator-db-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    await predecessorLocked;
    const rejectPromise = reject();
    await lockOrderObserved;
    releasePatch();
    const [patchResponse, decision] = await Promise.all([patchPromise, rejectPromise]);
    assert.equal(patchResponse.status, 200);
    assert.equal(decision.gateAction, "rejected");
  } finally {
    releasePatch();
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorToken;
    await Promise.all([patchClient.$disconnect(), rejectClient.$disconnect()]);
  }

  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: gate.id } })).status, "ANSWERED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).status, "TODO");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, "TODO");
  assert.equal(await db.run.count({ where: { taskId: predecessor.id } }), 2);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: predecessor.id, body: "Approval gate rejected; step queued again",
  } }), 1);
});

// A parked successor used to hang: the CAS matches TODO/DOING/REVIEW, so a
// BACKLOG or archived row makes updateMany match zero rows while the re-read
// returns the same row forever — inside the caller's transaction.
//
// The boundary these tests rely on is Prisma's interactive-transaction timeout,
// not Promise.race: losing a race does not cancel a database operation, but an
// expired transaction is closed server-side and the loop dies at its own next
// statement with P2028. The node:test timeout is a second ceiling and the
// disposable client's $disconnect releases the row locks on the failing path.
const activateOnParkedSuccessor = async (predecessor: Parameters<typeof activateChainSuccessor>[1]) => {
  const hangDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  try {
    return await hangDb.$transaction(
      (tx) => activateChainSuccessor(tx, predecessor, {}, new Date()),
      { maxWait: 2_000, timeout: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } finally {
    await hangDb.$disconnect();
  }
};

const latestActivity = async (taskId: string): Promise<string> => (
  await db.taskActivity.findFirstOrThrow({ where: { taskId }, orderBy: { createdAt: "desc" } })
).body;

test("a BACKLOG successor is parked, not spun on", { timeout: 20_000 }, async () => {
  const { predecessor, successor } = await seedExecutableChain();
  await db.task.update({ where: { id: successor.id }, data: { status: "BACKLOG" } });
  await activateOnParkedSuccessor(predecessor);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, "BACKLOG");
  assert.match(await latestActivity(successor.id), /parked in Backlog/);
});

test("an archived successor is parked, not spun on", { timeout: 20_000 }, async () => {
  const { predecessor, successor } = await seedExecutableChain();
  await db.task.update({ where: { id: successor.id }, data: { archivedAt: new Date() } });
  await activateOnParkedSuccessor(predecessor);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.match(await latestActivity(successor.id), /is archived and was not queued/);
});

test("a successor parked between observation and lock is caught by the locked re-read", { timeout: 20_000 }, async () => {
  const { predecessor, successor } = await seedExecutableChain();
  const parkDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const hangDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let parked = false;
  try {
    await hangDb.$transaction(async (tx) => {
      const task = new Proxy(tx.task, { get(target, property, receiver) {
        if (property !== "findFirst") return Reflect.get(target, property, receiver);
        return async (args: any) => {
          const candidate = await tx.task.findFirst(args as any);
          if (!parked) {
            parked = true;
            await parkDb.task.update({ where: { id: successor.id }, data: { status: "BACKLOG" } });
          }
          return candidate;
        };
      } });
      const instrumentedTx = new Proxy(tx, { get(target, property, receiver) {
        return property === "task" ? task : Reflect.get(target, property, receiver);
      } });
      return activateChainSuccessor(instrumentedTx as any, predecessor, {}, new Date());
    }, { maxWait: 2_000, timeout: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } finally {
    await parkDb.$disconnect();
    await hangDb.$disconnect();
  }
  assert.equal(parked, true);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, "BACKLOG");
  assert.match(await latestActivity(successor.id), /parked in Backlog/);
});

// --- batch 2.5: GET /tasks/:taskId/chain and the GET /tasks extension --------

const OPERATOR = "operator-db-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const operatorGet = async (path: string): Promise<{ status: number; body: any }> => asOperator(async () => {
  const response = await createApp(db).request(path, { headers: { Authorization: `Bearer ${OPERATOR}` } });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

/** A real three-step template, instantiated through instantiateTemplate so the
 *  chain under test is the one the product actually creates. */
const seedTemplateChain = async (label: string, stepCount = 3) => {
  const project = await db.project.create({ data: { name: label, slug: `${label}-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo" } });
  await db.agentRepoAccess.create({ data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: `${label}-template`, description: "t", variables: [],
    steps: { create: Array.from({ length: stepCount }, (_, index) => ({
      stepIndex: index + 1,
      name: `Step ${index + 1}`,
      // The last step mirrors the seeded nine-step template: a HUMAN approval gate.
      assigneeType: index + 1 === stepCount ? "HUMAN" as const : "AGENT" as const,
      assigneeAgentId: index + 1 === stepCount ? null : agent.id,
      approvalGate: index + 1 === stepCount,
      prompt: `do step ${index + 1}`,
    })) },
  } });
  const chain = await instantiateTemplate(db, project.id, template.id, { repoId: repo.id, variables: {} });
  return { project, agent, repo, template, chain };
};

test("a pinned successor fails explicitly without its source commit and advances linearly once recorded", async () => {
  const { template, chain } = await seedTemplateChain("pinned-base", 3);
  const pinnedStep = await db.taskTemplateStep.findFirstOrThrow({
    where: { taskTemplateId: template.id, stepIndex: 2 },
  });
  await db.taskTemplateStep.update({
    where: { id: pinnedStep.id },
    data: { baseFromStepIndex: 1 },
  });
  const predecessor = chain.tasks[0]!;
  const predecessorRun = await db.run.findFirstOrThrow({ where: { taskId: predecessor.id } });
  const implementationBaseSha = "b".repeat(40);
  await db.run.update({
    where: { id: predecessorRun.id },
    data: { status: "SUCCEEDED" },
  });
  await db.task.update({ where: { id: predecessor.id }, data: { status: "DONE" } });

  await assert.rejects(
    () => db.$transaction((tx) => activateChainSuccessor(tx, predecessor)),
    /Pinned task .* cannot activate from step 1: referenced step has no recorded commitSha/u,
  );
  assert.equal(await db.run.count({ where: { taskId: chain.tasks[1]!.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.tasks[1]!.id } })).status, "TODO");

  const commitSha = "a".repeat(40);
  await db.taskStepOutput.create({ data: {
    taskId: predecessor.id,
    runId: predecessorRun.id,
    kind: "implementation",
    body: "implemented",
    commitSha,
  } });
  await assert.rejects(
    () => db.$transaction((tx) => activateChainSuccessor(tx, predecessor)),
    /Pinned task .* cannot activate from step 1: referenced step has no recorded implementation baseSha/u,
  );
  assert.equal(await db.run.count({ where: { taskId: chain.tasks[1]!.id } }), 0);

  await db.run.update({
    where: { id: predecessorRun.id },
    data: { baseSha: implementationBaseSha },
  });
  const advanced = await db.$transaction((tx) => activateChainSuccessor(tx, predecessor));
  assert.equal(advanced.nextTaskId, chain.tasks[1]!.id);
  const pinnedRun = await db.run.findFirstOrThrow({ where: { taskId: chain.tasks[1]!.id } });
  assert.equal(pinnedRun.targetBranch, commitSha);
  assert.equal(pinnedRun.branch, chain.branchName);
});

test("GET /tasks/:id/chain returns every step in order with startable and gate flags", async () => {
  const { chain } = await seedTemplateChain("chainroute", 9);
  const { status, body } = await operatorGet(`/tasks/${chain.tasks[3]!.id}/chain`);
  assert.equal(status, 200);
  assert.equal(body.chainId, chain.chainId);
  assert.equal(body.total, 9);
  assert.equal(body.done, 0);
  assert.deepEqual(body.steps.map((step: any) => step.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(body.steps.map((step: any) => step.stepName), Array.from({ length: 9 }, (_, index) => `Step ${index + 1}`));

  const last = body.steps[8];
  assert.equal(last.assigneeType, "HUMAN");
  assert.equal(last.approvalGate, true);
  assert.equal(last.startable, false, "a human gate step is never startable");

  // Step 1 already holds the run instantiateTemplate queued, so it is the
  // current execution and every successor is dependency-blocked.
  assert.equal(body.steps[0].startable, false);
  assert.equal(body.steps[0].startAction, null);
  assert.equal(body.steps[0].currentExecution, true);
  assert.equal(body.steps[0].latestRun.status, "QUEUED");
  assert.equal(body.steps[1].startable, false);
  assert.equal(body.steps[1].startAction, null);
  assert.equal(body.steps[1].latestRun, null);

  await db.run.updateMany({ where: { taskId: chain.tasks[0]!.id }, data: { status: "SUCCEEDED" } });
  await db.task.update({ where: { id: chain.tasks[0]!.id }, data: { status: "DONE" } });
  const advanced = await operatorGet(`/tasks/${chain.tasks[3]!.id}/chain`);
  assert.equal(advanced.body.steps[1].startable, true);
  assert.equal(advanced.body.steps[1].startAction, "start");
});

test("GET /tasks/:id/chain returns an empty envelope for a task with no chain", async () => {
  const { project } = await seedTemplateChain("nochain", 2);
  const loner = await db.task.create({ data: { projectId: project.id, name: "Loner", description: "d" } });
  const { status, body } = await operatorGet(`/tasks/${loner.id}/chain`);
  assert.equal(status, 200);
  assert.deepEqual(body, { chainId: null, total: 0, done: 0, steps: [] });
});

test("GET /tasks/:id/chain is 404 for a task that does not exist", async () => {
  const { status } = await operatorGet("/tasks/task-that-never-existed/chain");
  assert.equal(status, 404);
});

test("E1: a chainId with a null chainIndex is its own 1/1 chain and never joins another", async () => {
  const { project, chain } = await seedTemplateChain("e1", 3);
  const orphan = await db.task.create({ data: {
    projectId: project.id, name: "Broken row", description: "d", chainId: chain.chainId, chainIndex: null, status: "DONE",
  } });

  const alone = await operatorGet(`/tasks/${orphan.id}/chain`);
  assert.equal(alone.status, 200);
  assert.equal(alone.body.total, 1);
  assert.equal(alone.body.done, 1);
  assert.equal(alone.body.steps.length, 1);
  assert.equal(alone.body.steps[0].position, 1);
  assert.equal(alone.body.steps[0].taskId, orphan.id);

  // …and the sibling rows never see it, so nobody's position shifts.
  const sibling = await operatorGet(`/tasks/${chain.tasks[0]!.id}/chain`);
  assert.equal(sibling.body.total, 3);
  assert.equal(sibling.body.steps.some((step: any) => step.taskId === orphan.id), false);
});

test("E2: two projects sharing one chainId stay separate in both chain reads", async () => {
  const first = await seedTemplateChain("e2a", 3);
  const second = await seedTemplateChain("e2b", 3);
  // instantiateTemplate generates UUIDs, so a collision has to be written by
  // hand. @@unique([chainId, chainIndex]) is global rather than per-project, so
  // the two chains can only share an id at *disjoint* indices — which is
  // precisely the case the (projectId, chainId) grouping key exists for: under a
  // chainId-only key the first project's cards would read 6 steps, not 3.
  const shared = `shared-${Date.now()}`;
  await db.task.updateMany({ where: { chainId: first.chain.chainId }, data: { chainId: shared } });
  for (const [offset, task] of second.chain.tasks.entries()) {
    await db.task.update({ where: { id: task.id }, data: { chainId: shared, chainIndex: 11 + offset } });
  }

  const firstChain = await operatorGet(`/tasks/${first.chain.tasks[0]!.id}/chain`);
  assert.equal(firstChain.body.total, 3, "three steps, never six");
  const secondChain = await operatorGet(`/tasks/${second.chain.tasks[0]!.id}/chain`);
  assert.equal(secondChain.body.total, 3);

  // The global GET /tasks call site has no projectId at all; the grouping key is
  // (projectId, chainId), so neither project reads the other's progress.
  const global = await operatorGet("/tasks");
  const firstCard = global.body.find((task: any) => task.id === first.chain.tasks[0]!.id);
  const secondCard = global.body.find((task: any) => task.id === second.chain.tasks[0]!.id);
  assert.equal(firstCard.chainProgress.total, 3);
  assert.equal(secondCard.chainProgress.total, 3);
});

test("GET /tasks reports the same chainProgress on every card of a chain", async () => {
  const { project, chain } = await seedTemplateChain("progress", 3);
  await db.task.update({ where: { id: chain.tasks[0]!.id }, data: { status: "DONE" } });
  const { body } = await operatorGet(`/tasks?projectId=${project.id}`);
  assert.equal(body.length, 3);
  for (const task of body) {
    assert.equal(task.chainProgress.total, 3);
    assert.equal(task.chainProgress.done, 1);
    assert.equal(task.chainProgress.chainId, chain.chainId);
  }
  // GET /tasks is ordered by creation time, not by chain position. Template
  // tasks may share one PostgreSQL timestamp, so bind each position to the task
  // identity instead of treating an otherwise unspecified tie order as API
  // semantics.
  const positionByTask = new Map(body.map((task: any) => [task.id, task.chainProgress.position]));
  assert.deepEqual(chain.tasks.map((task) => positionByTask.get(task.id)), [1, 2, 3]);
});

test("GET /tasks counts archived chain rows toward progress but omits them from the board", async () => {
  const { project, chain } = await seedTemplateChain("archivedprogress", 3);
  await db.task.update({ where: { id: chain.tasks[0]!.id }, data: { status: "DONE", archivedAt: new Date() } });
  const board = await operatorGet(`/tasks?projectId=${project.id}`);
  assert.equal(board.body.length, 2, "the archived row is off the board");
  assert.equal(board.body[0].chainProgress.total, 3, "but it still counts toward m");
  assert.equal(board.body[0].chainProgress.done, 1);

  const all = await operatorGet(`/tasks?projectId=${project.id}&archived=all`);
  assert.equal(all.body.length, 3);
  const onlyArchived = await operatorGet(`/tasks?projectId=${project.id}&archived=true`);
  assert.equal(onlyArchived.body.length, 1);
  const rejected = await operatorGet(`/tasks?projectId=${project.id}&archived=maybe`);
  assert.equal(rejected.status, 400);
});

test("GET /tasks carries the last recurring fire so a collapsed automation row can render it", async () => {
  const { project, agent, repo } = await seedTemplateChain("lastfire", 2);
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Nightly", description: "work",
    scheduleKind: "CRON", cron: "0 9 * * *", timezone: "UTC", runAt: new Date("2026-08-15T09:00:00Z"),
  } });
  const beforeFire = await operatorGet(`/tasks?projectId=${project.id}`);
  const collapsedBefore = beforeFire.body.find((task: any) => task.id === definition.id);
  assert.equal(collapsedBefore.recurringLastFiredAt, null);
  assert.equal(collapsedBefore.recurringFireCount, 0);

  await db.task.create({ data: {
    projectId: project.id, name: "Nightly — copy", description: "work", recurringSourceTaskId: definition.id, source: "CRON",
  } });
  const afterFire = await operatorGet(`/tasks?projectId=${project.id}`);
  const collapsedAfter = afterFire.body.find((task: any) => task.id === definition.id);
  assert.notEqual(collapsedAfter.recurringLastFiredAt, null);
  assert.equal(collapsedAfter.recurringFireCount, 1);
});

test("M2 at the ceiling: a step whose runs are all spent is not startable", async () => {
  const { project, agent, repo, chain } = await seedTemplateChain("budget", 3);
  const step = chain.tasks[1]!;
  await db.task.update({ where: { id: step.id }, data: { maxSessionsPerTask: 2 } });
  for (const runNumber of [1, 2]) {
    await db.run.create({ data: {
      projectId: project.id, taskId: step.id, agentId: agent.id, repoId: repo.id, runNumber,
      dedupeKey: `task:${step.id}:run:${runNumber}`, runner: "CLAUDE", model: "claude", promptHash: "hash", status: "FAILED",
    } });
  }
  const { body } = await operatorGet(`/tasks/${step.id}/chain`);
  const rendered = body.steps.find((candidate: any) => candidate.taskId === step.id);
  assert.equal(rendered.startable, false, "two terminal runs against a ceiling of two is spent");
});

// --- review fixes: gate rejection joins the mutex (SOL-REVIEW M2) ------------

test("rejecting a gate onto an archived predecessor refuses and leaves the decision open", async () => {
  // `enqueueTaskRun` never checked the *task's* archive state and the runner
  // claims only unarchived TODO/DOING tasks, so the old behaviour queued a run
  // nothing would ever claim, on a task the operator had put away — and closed
  // the gate on the way past. Throwing rolls the whole transaction back.
  const { predecessor, successor, gate } = await completeIntoHumanGate();
  await db.task.update({ where: { id: predecessor.id }, data: { archivedAt: new Date() } });
  const runsBefore = await db.run.count({ where: { taskId: predecessor.id } });

  await assert.rejects(
    () => db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: gate.id, externalEventId: `reject-archived-${Date.now()}`, decision: "reject",
    }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
    /archived/,
  );

  // Nothing moved: no run, no status change, and the gate is still the human's
  // to decide once they unarchive the step.
  assert.equal(await db.run.count({ where: { taskId: predecessor.id } }), runsBefore);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: gate.id } })).status, "OPEN");
  assert.equal(await db.inboxDecision.count({ where: { inboxMessageId: gate.id } }), 0);
  assert.notEqual((await db.task.findUniqueOrThrow({ where: { id: predecessor.id } })).archivedAt, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, "REVIEW");

  // Unarchive and the same decision goes through.
  await db.task.update({ where: { id: predecessor.id }, data: { archivedAt: null } });
  const decision = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id, externalEventId: `reject-ok-${Date.now()}`, decision: "reject",
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  assert.equal(decision.gateAction, "rejected");
  assert.equal(await db.run.count({ where: { taskId: predecessor.id } }), runsBefore + 1);
});

test("the runner claim never hands out a run whose task is archived", async () => {
  // Defense in depth for the same class: `enqueueTaskRun` refuses archived
  // tasks and archive refuses tasks with active runs, so this state should be
  // unreachable. Written directly, it must still not be claimable.
  const { project, agent, repo, predecessor } = await seedExecutableChain();
  await db.run.create({ data: {
    projectId: project.id, taskId: predecessor.id, agentId: agent.id, repoId: repo.id, runNumber: 1,
    dedupeKey: `task:${predecessor.id}:run:1`, runner: "CLAUDE", model: "claude", promptHash: "hash",
    status: "QUEUED", readyAt: new Date(),
  } });
  await db.task.update({ where: { id: predecessor.id }, data: { status: "TODO", archivedAt: new Date() } });
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "runner-db-token";
  const claim = () => createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: "Bearer runner-db-token", "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "runner-1" }),
  });
  try {
    // 204 is the control plane's "nothing to claim".
    assert.equal((await claim()).status, 204);
    // Positive control, so this test can actually fail: the only thing keeping
    // the run back is the archive flag, and clearing it makes it claimable.
    await db.task.update({ where: { id: predecessor.id }, data: { archivedAt: null } });
    const response = await claim();
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).run.taskId, predecessor.id);
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = prior;
  }
});
