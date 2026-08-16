import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { activateChainSuccessor, applyInboxDecisionTx, Prisma, type PrismaClient } from "@agentos/db";

import { createApp } from "./app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

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

test("concurrent chain advance creates exactly one successor run with no client-visible conflict", async () => {
  const { predecessor, successor } = await seedExecutableChain();
  const calls = [1, 2].map(() => db.$transaction(
    (tx) => activateChainSuccessor(tx, predecessor, {}, new Date()),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  ));
  await assert.doesNotReject(Promise.all(calls));
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 1);
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
      method: "PATCH", headers: { Authorization: "Bearer operator-db-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
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
