import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  PrismaClient,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
const RUNNER_TOKEN = "chain-activation-runner-token";
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

const seedRunningHeldChain = async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const project = await db.project.create({ data: { name: "Activation", slug: `activation-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `activation-agent-${suffix}`,
    title: "Activation agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: `activation-repo-${suffix}`,
    remoteUrl: "https://example.test/activation.git",
    mountPath: "/repo",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const chainId = `activation-chain-${suffix}`;
  const predecessor = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    name: "First",
    description: "first",
    chainId,
    chainIndex: 0,
    chainLayer: 1,
    status: TaskStatus.DOING,
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
  const run = await db.run.create({ data: {
    projectId: project.id,
    taskId: predecessor.id,
    agentId: agent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${predecessor.id}:run:1`,
    runner: "CLAUDE",
    model: "claude",
    status: RunStatus.RUNNING,
    runnerId: "activation-runner",
    fencingToken: "activation-fence",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    promptHash: "activation-prompt",
  } });
  await db.session.create({ data: {
    runId: run.id,
    projectId: project.id,
    agentId: agent.id,
    taskId: predecessor.id,
    runner: "CLAUDE",
    executionStatus: SessionExecutionStatus.RUNNING,
  } });
  const control = await db.chainControl.create({ data: {
    projectId: project.id,
    chainId,
    state: ChainControlState.HELD,
    heldLayer: 1,
    heldAt: new Date("2026-08-28T00:00:00.000Z"),
    holdRequestId: "hold-activation",
    holdGeneration: 1,
  } });
  await db.chainControlEvent.create({ data: {
    chainControlId: control.id,
    kind: ChainControlState.HELD,
    layer: 1,
    actorType: "operator",
    requestId: "hold-activation",
    holdGeneration: 1,
  } });
  return { project, predecessor, successor, run, control };
};

test("completion under a held Chain persists output and withholds successor activation", async () => {
  const chain = await seedRunningHeldChain();
  const response = await createApp(db).request(`/runner/runs/${chain.run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "activation-runner",
      fencingToken: "activation-fence",
      exitCode: 0,
      terminalEventSeen: true,
      terminalSuccess: true,
      cleanupStatus: "SUCCEEDED",
      output: "completed under hold",
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.predecessor.id } })).status, TaskStatus.DONE);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: chain.run.id } })).status, RunStatus.SUCCEEDED);
  assert.equal(await db.run.count({ where: { taskId: chain.successor.id } }), 0);
  const activity = await db.taskActivity.findFirst({
    where: { taskId: chain.predecessor.id, body: { contains: "activation withheld" } },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(activity, "completion records why the successor was withheld");
});
