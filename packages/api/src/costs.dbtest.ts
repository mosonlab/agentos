import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, RunStatus, SessionExecutionStatus } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-costs-token";

const call = async (path: string): Promise<{ status: number; body: any }> => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    });
    return { status: response.status, body: await response.json() };
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

const seed = async () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.round(performance.now() * 1_000)}`;
  const project = await db.project.create({ data: { name: "Costs", slug: `costs-${suffix}` } });
  const otherProject = await db.project.create({ data: { name: "Other", slug: `other-${suffix}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const otherEnvironment = await db.environment.create({ data: { projectId: otherProject.id, name: "local", allowedHosts: [] } });
  const [agent, secondAgent, otherAgent] = await Promise.all([
    db.agent.create({ data: {
      projectId: project.id, environmentId: environment.id, name: "alpha", title: "Alpha", model: "model-alpha",
      foundationalPrompt: "foundation", rolePrompt: "role",
    } }),
    db.agent.create({ data: {
      projectId: project.id, environmentId: environment.id, name: "beta", title: "Beta", model: "model-beta",
      foundationalPrompt: "foundation", rolePrompt: "role",
    } }),
    db.agent.create({ data: {
      projectId: otherProject.id, environmentId: otherEnvironment.id, name: "other", title: "Other", model: "model-other",
      foundationalPrompt: "foundation", rolePrompt: "role",
    } }),
  ]);
  const [alphaTask, betaTask, oldTask, activeTask, otherTask] = await Promise.all([
    db.task.create({ data: { projectId: project.id, assigneeAgentId: agent.id, name: "Alpha task", description: "work" } }),
    db.task.create({ data: { projectId: project.id, assigneeAgentId: secondAgent.id, name: "Beta task", description: "work" } }),
    db.task.create({ data: { projectId: project.id, assigneeAgentId: agent.id, name: "Old task", description: "work" } }),
    db.task.create({ data: { projectId: project.id, assigneeAgentId: agent.id, name: "Active task", description: "work" } }),
    db.task.create({ data: { projectId: otherProject.id, assigneeAgentId: otherAgent.id, name: "Other task", description: "work" } }),
  ]);
  const now = Date.now();
  const inWindow = new Date(now - 2 * 24 * 60 * 60 * 1_000);
  const yesterday = new Date(now - 1 * 24 * 60 * 60 * 1_000);
  const old = new Date(now - 40 * 24 * 60 * 60 * 1_000);
  const createRun = async (input: {
    projectId: string; taskId: string; agentId: string; model: string; status: RunStatus; startedAt: Date;
    costUsd?: string | null; inputTokens?: number | null;
  }) => {
    const run = await db.run.create({ data: {
      projectId: input.projectId, taskId: input.taskId, agentId: input.agentId, runNumber: 1,
      dedupeKey: `costs:${suffix}:${input.taskId}:${input.startedAt.getTime()}`, runner: "CODEX", model: input.model,
      promptHash: "hash", status: input.status, startedAt: input.startedAt, endedAt: input.startedAt,
    } });
    await db.session.create({ data: {
      runId: run.id, projectId: input.projectId, taskId: input.taskId, agentId: input.agentId,
      runner: "CODEX", executionStatus: input.status === RunStatus.RUNNING ? SessionExecutionStatus.RUNNING : SessionExecutionStatus.SUCCEEDED,
      startedAt: input.startedAt, endedAt: input.startedAt, costUsd: input.costUsd ?? null,
      inputTokens: input.inputTokens ?? null, outputTokens: 1, cachedInputTokens: 0, totalTokens: (input.inputTokens ?? 0) + 1,
    } });
    return run;
  };
  const alpha = await createRun({
    projectId: project.id, taskId: alphaTask.id, agentId: agent.id, model: agent.model,
    status: RunStatus.SUCCEEDED, startedAt: inWindow, costUsd: "1.25", inputTokens: 10,
  });
  const beta = await createRun({
    projectId: project.id, taskId: betaTask.id, agentId: secondAgent.id, model: secondAgent.model,
    status: RunStatus.FAILED, startedAt: yesterday, costUsd: "2.50", inputTokens: 20,
  });
  await createRun({
    projectId: project.id, taskId: oldTask.id, agentId: agent.id, model: agent.model,
    status: RunStatus.SUCCEEDED, startedAt: old, costUsd: "99.00", inputTokens: 99,
  });
  await createRun({
    projectId: project.id, taskId: activeTask.id, agentId: agent.id, model: agent.model,
    status: RunStatus.RUNNING, startedAt: inWindow, costUsd: "50.00", inputTokens: 50,
  });
  await createRun({
    projectId: otherProject.id, taskId: otherTask.id, agentId: otherAgent.id, model: otherAgent.model,
    status: RunStatus.SUCCEEDED, startedAt: inWindow, costUsd: "75.00", inputTokens: 75,
  });
  return { project, alpha, beta, inWindow, yesterday, createRun };
};

test("costs route aggregates settled runs by day and agent, excluding active, old, and foreign rows", async () => {
  const { project, alpha, beta, inWindow, yesterday } = await seed();

  const response = await call(`/projects/${project.id}/costs`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    totalUsd: "3.75",
    runCount: 2,
    avgUsd: "1.875",
    daily: [
      { date: inWindow.toISOString().slice(0, 10), byAgent: { alpha: "1.25" } },
      { date: yesterday.toISOString().slice(0, 10), byAgent: { beta: "2.5" } },
    ],
    byAgent: [
      { agent: "beta", usd: "2.5", runs: 1, avgUsd: "2.5" },
      { agent: "alpha", usd: "1.25", runs: 1, avgUsd: "1.25" },
    ],
    topRuns: [
      { taskName: "Beta task", agent: "beta", model: "model-beta", usd: "2.5", startedAt: beta.startedAt!.toISOString() },
      { taskName: "Alpha task", agent: "alpha", model: "model-alpha", usd: "1.25", startedAt: alpha.startedAt!.toISOString() },
    ],
  });
});

test("costs route accepts an explicit day window and rejects malformed values", async () => {
  const { project } = await seed();
  const response = await call(`/projects/${project.id}/costs?days=7`);
  assert.equal(response.status, 200);
  assert.equal(response.body.runCount, 2);

  const invalid = await call(`/projects/${project.id}/costs?days=not-a-number`);
  assert.equal(invalid.status, 400);
});

test("costs route counts settled runs with unknown cost without presenting them as spend", async () => {
  const { project, alpha, inWindow, createRun } = await seed();
  const task = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: alpha.agentId, name: "Unpriced task", description: "work",
  } });
  await createRun({
    projectId: project.id, taskId: task.id, agentId: alpha.agentId, model: "model-alpha",
    status: RunStatus.CANCELLED, startedAt: inWindow, costUsd: null, inputTokens: 100,
  });

  const response = await call(`/projects/${project.id}/costs`);
  assert.equal(response.status, 200);
  assert.equal(response.body.totalUsd, "3.75");
  assert.equal(response.body.runCount, 3);
  assert.equal(response.body.avgUsd, "1.25");
  assert.deepEqual(response.body.byAgent, [
    { agent: "beta", usd: "2.5", runs: 1, avgUsd: "2.5" },
    { agent: "alpha", usd: "1.25", runs: 2, avgUsd: "0.625" },
  ]);
  assert.equal(response.body.topRuns.length, 2);
  assert.ok(response.body.topRuns.every((run: { taskName: string }) => run.taskName !== "Unpriced task"));
});
