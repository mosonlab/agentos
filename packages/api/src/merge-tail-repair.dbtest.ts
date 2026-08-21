import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  activateChainSuccessor,
  AssigneeType,
  PrismaClient,
  TaskStatus,
} from "@agentos/db";

import { handleRegressionCompletion } from "./app.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BRANCH = "agentos/repair-test";

const seedRegression = async () => {
  const project = await db.project.create({ data: { name: "Repair", slug: `repair-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const makeAgent = (name: string) => db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name, title: name,
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const [regressionAgent, resolverAgent, fixAgent] = await Promise.all([
    makeAgent("review-coordinator-opus"), makeAgent("merge-resolver"), makeAgent("senior-dev"),
  ]);
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "widgets", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "main",
  } });
  for (const agent of [regressionAgent, resolverAgent, fixAgent]) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
    } });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: "direct-engineer-workflow", description: "tail", variables: [],
  } });
  const [fixStep, regressionStep] = await Promise.all([
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 4, name: "Fix", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: fixAgent.id, prompt: "fix", approvalGate: false, outputKind: "fixed-implementation",
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 5, name: "Regression", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgent.id, prompt: "verify", approvalGate: false, outputKind: "regression-verification",
    } }),
  ]);
  const chainId = `chain-${Date.now()}`;
  await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: fixStep.id,
    name: "Fix", description: "fix", assigneeType: AssigneeType.AGENT, assigneeAgentId: fixAgent.id,
    status: TaskStatus.DONE, chainId, chainIndex: 4, targetBranch: "main",
  } });
  const regression = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: regressionStep.id,
    name: "Regression", description: "verify", assigneeType: AssigneeType.AGENT, assigneeAgentId: regressionAgent.id,
    status: TaskStatus.DOING, chainId, chainIndex: 5, targetBranch: "main",
  } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: regression.id, agentId: regressionAgent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${regression.id}:run:1`, runner: "CODEX", model: regressionAgent.model,
    promptHash: "hash", status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
    targetBranch: "main", headSha: HEAD,
  } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: project.id, agentId: regressionAgent.id, taskId: regression.id,
    runner: "CODEX", executionStatus: "SUCCEEDED",
  } });
  return { project, template, repo, regressionAgent, regression, run, session };
};

const verdict = (outcome: "refresh-conflict" | "gate-fail") => JSON.stringify(outcome === "refresh-conflict"
  ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, summary: "merge conflict" }
  : { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE, gateVerdict: "FAIL", summary: "suite failed" });

const exercise = async (outcome: "refresh-conflict" | "gate-fail") => {
  const seeded = await seedRegression();
  await db.taskStepOutput.create({ data: {
    taskId: seeded.regression.id, runId: seeded.run.id, kind: "regression-verification",
    body: verdict(outcome), commitSha: HEAD,
  } });
  const input = {
    task: seeded.regression,
    run: { id: seeded.run.id, agentId: seeded.regressionAgent.id, branch: BRANCH, headSha: HEAD, sessionId: seeded.session.id },
    now: new Date(),
  };
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, input)), "handled");
  return { ...seeded, input };
};

test("a refresh conflict creates exactly one resolver and its completion re-runs regression", async () => {
  const seeded = await exercise("refresh-conflict");
  const repair = await db.task.findFirstOrThrow({ where: { followUpTaskId: seeded.regression.id } });
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } })).name, "merge-resolver");
  assert.equal(await db.task.count({ where: { followUpTaskId: seeded.regression.id } }), 1);
  await db.run.updateMany({ where: { taskId: repair.id }, data: { status: "SUCCEEDED" } });
  await db.task.update({ where: { id: repair.id }, data: { status: TaskStatus.DONE } });
  await db.$transaction((tx) => activateChainSuccessor(tx, repair));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);

  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled");
  assert.equal(await db.task.count({ where: { followUpTaskId: seeded.regression.id } }), 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
});

test("a gate FAIL creates one fix-agent task and a second FAIL escalates with both heads in activity", async () => {
  const seeded = await exercise("gate-fail");
  const repair = await db.task.findFirstOrThrow({ where: { followUpTaskId: seeded.regression.id } });
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: repair.assigneeAgentId! } })).name, "senior-dev");
  assert.equal(await db.$transaction((tx) => handleRegressionCompletion(tx, seeded.input)), "handled");
  assert.equal(await db.task.count({ where: { followUpTaskId: seeded.regression.id } }), 1);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
  const trail = await db.taskActivity.findMany({ where: { taskId: seeded.regression.id }, select: { body: true } });
  assert.match(trail.map(({ body }) => body).join("\n"), new RegExp(`${HEAD}.*${BASE}`, "s"));
});

test("a resolver process failure escalates instead of leaving regression silently parked", async () => {
  const seeded = await exercise("refresh-conflict");
  const repair = await db.task.findFirstOrThrow({ where: { followUpTaskId: seeded.regression.id } });
  const run = await db.run.findFirstOrThrow({ where: { taskId: repair.id } });
  const runnerId = "merge-tail-repair-runner";
  const fencingToken = `repair:${run.id}:1`;
  await db.run.update({ where: { id: run.id }, data: {
    status: "RUNNING", runnerId, fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000),
  } });
  await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, agentId: repair.assigneeAgentId!, taskId: repair.id,
    runner: "CODEX", executionStatus: "RUNNING",
  } });
  await db.task.update({ where: { id: repair.id }, data: { status: TaskStatus.DOING } });
  const prior = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "merge-tail-repair-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${run.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-repair-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId, fencingToken, exitCode: 1, terminalEventSeen: true, terminalSuccess: false,
        failureClass: "TASK_FAILED", failureReason: "resolver crashed", retryable: false,
        cleanupStatus: "SUCCEEDED",
      }),
    });
    assert.equal(response.status, 200);
  } finally {
    if (prior === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = prior;
  }
  const regression = await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } });
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.match(regression.failureReason ?? "", /failed without closing/u);
  assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.regression.id } }), 1);
});
