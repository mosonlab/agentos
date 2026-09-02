import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  applyInboxDecisionTx,
  DependencyProvisioning,
  Prisma,
  PrismaClient,
} from "@anneal/db";
import { buildPrompt } from "@anneal/runner/adapters";
import type { ClaimedTask } from "@anneal/runner/api";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "gate-feedback-runner-token";

let db: PrismaClient;
const priorRunnerToken = process.env.RUNNER_TOKEN;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const seedGate = async () => {
  const suffix = randomUUID();
  const project = await db.project.create({ data: {
    name: `Gate feedback ${suffix}`,
    slug: `gate-feedback-${suffix}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `gate-feedback-agent-${suffix}`,
    title: "Gate feedback agent",
    model: "claude",
    foundationalPrompt: "Foundation",
    rolePrompt: "Implement the requested correction.",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `gate-feedback-repo-${suffix}`,
    remoteUrl: "https://example.test/gate-feedback.git",
    mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    assigneeAgentId: agent.id,
    repoId: repo.id,
    name: "Implement gate feedback",
    description: "Revise the implementation after operator review.",
    status: "REVIEW",
    approvalGate: true,
    targetBranch: "feature/gate-feedback",
  } });
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    runner: "CLAUDE",
    model: agent.model,
    promptHash: "first-attempt",
    status: "SUCCEEDED",
    branch: "feature/gate-feedback",
    targetBranch: "feature/gate-feedback",
    pushedBranch: "feature/gate-feedback",
    endedAt: new Date(),
  } });
  const session = await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    agentId: agent.id,
    taskId: task.id,
    runner: "CLAUDE",
  } });
  const gate = await db.inboxMessage.create({ data: {
    from: "AGENT",
    agentId: agent.id,
    sessionId: session.id,
    taskId: task.id,
    gateTaskId: task.id,
    kind: "MULTIPLE_CHOICE",
    body: "Approve the implementation",
    choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    dedupeKey: `gate:${task.id}`,
  } });
  return { task, gate };
};

const rejectAndClaim = async (note?: string): Promise<ClaimedTask> => {
  const { gate } = await seedGate();
  const decision = await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id,
    externalEventId: `gate-feedback-${randomUUID()}`,
    decision: "reject",
    ...(note === undefined ? {} : { note }),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  assert.equal(decision.gateAction, "rejected");

  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: `gate-feedback-runner-${randomUUID()}`, leaseSeconds: 60 }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<ClaimedTask>;
};

test("gate rejection feedback reaches the requeued run prompt verbatim", async () => {
  const note = "Preserve `requestId` idempotency; do not combine choice and text submission.";
  const claim = await rejectAndClaim(note);

  assert.equal(claim.run.runNumber, 2);
  assert.equal(claim.operatorFeedback, note);
  assert.match(buildPrompt(claim), new RegExp(`Operator feedback on previous attempt:\\n- ${note.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
});

test("gate rejection without feedback retains the existing no-note prompt context", async () => {
  const claim = await rejectAndClaim();
  const prompt = buildPrompt(claim);

  assert.equal(claim.run.runNumber, 2);
  assert.equal(claim.operatorFeedback, undefined);
  assert.doesNotMatch(prompt, /Operator feedback on previous attempt:/u);
  assert.match(prompt, /Task: Implement gate feedback\nRevise the implementation after operator review\./u);
});

test("corrupt overlong stored gate feedback fails the claim instead of disappearing", async () => {
  const { task, gate } = await seedGate();
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: gate.id,
    externalEventId: `gate-feedback-${randomUUID()}`,
    decision: "reject",
    note: "valid feedback",
  }), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  const activity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: task.id, metadata: { path: ["approvalGateFeedback"], equals: true } },
  });
  await db.taskActivity.update({
    where: { id: activity.id },
    data: { metadata: { approvalGateFeedback: true, note: "x".repeat(8_001) } },
  });

  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: `gate-feedback-runner-${randomUUID()}`, leaseSeconds: 60 }),
  });

  assert.equal(response.status, 500);
});
