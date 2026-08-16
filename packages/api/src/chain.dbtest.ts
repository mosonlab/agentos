import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import { activateChainSuccessor, applyInboxDecisionTx, Prisma, PrismaClient } from "@agentos/db";

import { createApp } from "./app.js";
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

const withRunnerToken = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const priorToken = process.env.RUNNER_TOKEN;
  const priorRoot = process.env.RUNNER_WORKSPACE_ROOT;
  const isolatedRoot = "/private/tmp/agentos-api-dbtest-workspaces";
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
  let arrived = 0;
  let release!: () => void;
  const bothAtClaim = new Promise<void>((resolve) => { release = resolve; });
  const call = (client: PrismaClient) => client.$transaction(async (tx) => {
    const task = new Proxy(tx.task, { get(target, property, receiver) {
      if (property !== "updateMany") return Reflect.get(target, property, receiver);
      return async (args: Parameters<typeof tx.task.updateMany>[0]) => {
        arrived += 1;
        if (arrived === 2) release();
        await bothAtClaim;
        return tx.task.updateMany(args);
      };
    } });
    const instrumentedTx = new Proxy(tx, { get(target, property, receiver) {
      return property === "task" ? task : Reflect.get(target, property, receiver);
    } });
    return activateChainSuccessor(instrumentedTx as any, predecessor, {}, new Date());
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  try {
    await assert.doesNotReject(Promise.all([call(db), call(otherDb)]));
  } finally {
    await otherDb.$disconnect();
  }
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 1);
});

test("an unrelated successor patch between read and claim retries and still queues", async () => {
  const { predecessor, successor } = await seedExecutableChain();
  const patchDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let patched = false;
  try {
    await db.$transaction(async (tx) => {
      const task = new Proxy(tx.task, { get(target, property, receiver) {
        if (property !== "updateMany") return Reflect.get(target, property, receiver);
        return async (args: Parameters<typeof tx.task.updateMany>[0]) => {
          if (!patched) {
            patched = true;
            await patchDb.task.update({ where: { id: successor.id }, data: { description: "harmless operator edit" } });
          }
          return tx.task.updateMany(args);
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
