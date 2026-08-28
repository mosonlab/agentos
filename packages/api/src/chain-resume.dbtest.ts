import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
const OPERATOR_TOKEN = "chain-resume-operator-token";
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const callResume = async (taskId: string, requestId: string) => {
  const response = await createApp(db).request(`/tasks/${taskId}/chain/resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};

const seedHeldChain = async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const project = await db.project.create({ data: { name: "Resume", slug: `resume-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `resume-agent-${suffix}`,
    title: "Resume agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `resume-repo-${suffix}`,
    remoteUrl: "https://example.test/resume.git",
    mountPath: "/repo",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const chainId = `resume-chain-${suffix}`;
  const predecessor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    name: "First",
    description: "first",
    chainId,
    chainIndex: 0,
    chainLayer: 1,
    status: TaskStatus.DONE,
  } });
  const successor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    name: "Second",
    description: "second",
    chainId,
    chainIndex: 1,
    chainLayer: 2,
    status: TaskStatus.TODO,
  } });
  const later = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    name: "Third",
    description: "third",
    chainId,
    chainIndex: 2,
    chainLayer: 3,
    status: TaskStatus.TODO,
  } });
  const control = await db.chainControl.create({ data: {
    projectId: project.id,
    chainId,
    state: ChainControlState.HELD,
    heldLayer: 1,
    heldAt: new Date("2026-08-28T00:00:00.000Z"),
    holdRequestId: "hold-1",
    holdReason: "inspect output",
    holdGeneration: 1,
  } });
  await db.chainControlEvent.create({ data: {
    chainControlId: control.id,
    kind: ChainControlState.HELD,
    layer: 1,
    actorType: "operator",
    requestId: "hold-1",
    reason: "inspect output",
    holdGeneration: 1,
  } });
  return { project, agent, repo, predecessor, successor, later, control };
};

test("Resume releases a completed held layer and activates only its immediate successor layer", async () => {
  const chain = await seedHeldChain();
  const resumed = await callResume(chain.successor.id, "resume-1");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.duplicate, false);
  assert.equal(resumed.body.control.state, "released");
  assert.equal(resumed.body.control.releaseRequestId, "resume-1");
  assert.equal(resumed.body.control.holdGeneration, 1);
  assert.equal(await db.run.count({ where: { taskId: chain.successor.id, status: RunStatus.QUEUED } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chain.later.id } }), 0);
  assert.equal(await db.chainControlEvent.count({ where: { chainControlId: chain.control.id } }), 2);
  const released = await db.chainControlEvent.findFirstOrThrow({
    where: { chainControlId: chain.control.id, kind: ChainControlState.RELEASED },
  });
  assert.equal(released.layer, 1);
  assert.equal(released.requestId, "resume-1");
  assert.equal(released.reason, null);
  assert.equal(released.holdGeneration, 1);
});
