import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  INTEGRATOR_SENTINEL_MODEL,
  PrismaClient,
  TaskStatus,
} from "@agentos/db";

import type { GitHubReader, PullRequestSnapshot } from "./github-read.js";
import { readinessTick } from "./merge-readiness-worker.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BRANCH = "agentos/merge-tail-test";

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets",
  number: 41,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "main",
  headRefOid: HEAD,
  baseSha: BASE,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: [],
  checkContexts: [],
  headCommitOid: HEAD,
  readAt: new Date().toISOString(),
  ...overrides,
});

const reader = (
  files: Array<{ filename: string; patch: string | null }> = [],
  pullRequest = snapshot(),
): GitHubReader => ({
  readPullRequest: async () => pullRequest,
  compareCommits: async () => ({ files }),
});

const seedReadiness = async () => {
  const project = await db.project.create({ data: { name: "Merge tail", slug: `merge-tail-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const makeAgent = (name: string, model = "gpt-5.6-sol:high") => db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name,
    title: name,
    model,
    runnerPreference: model === INTEGRATOR_SENTINEL_MODEL ? "INHERIT" : "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const [regressionAgent, reviewAgent, integratorAgent] = await Promise.all([
    makeAgent("review-coordinator-opus"),
    makeAgent("review-coordinator"),
    makeAgent("merge-integrator", INTEGRATOR_SENTINEL_MODEL),
  ]);
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "widgets",
    remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo",
    defaultBranch: "main",
  } });
  for (const agent of [regressionAgent, reviewAgent, integratorAgent]) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id,
      agentId: agent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE",
    } });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: "direct-engineer-workflow",
    description: "autonomous direct tail",
    variables: [],
  } });
  const [regressionStep, readinessStep, integratorStep] = await Promise.all([
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 5, name: "Regression", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgent.id, prompt: "verify", approvalGate: false,
      outputKind: "regression-verification", opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 6, name: "Readiness", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: reviewAgent.id, prompt: "mechanical", approvalGate: false,
      outputKind: "merge-authorization", opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 7, name: "Merge", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: integratorAgent.id, prompt: "merge", approvalGate: false,
      outputKind: "merge-result", opensPullRequest: false,
    } }),
  ]);
  const chainId = `tail-${Date.now()}`;
  const regression = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: regressionStep.id,
    name: "Regression", description: "verify", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: regressionAgent.id, status: TaskStatus.DONE, chainId, chainIndex: 5, targetBranch: "main",
  } });
  const readiness = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: readinessStep.id,
    name: "Readiness", description: "authorize", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: reviewAgent.id, status: TaskStatus.TODO, chainId, chainIndex: 6, targetBranch: "main",
  } });
  const integrator = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: integratorStep.id,
    name: "Merge", description: "merge", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: integratorAgent.id, status: TaskStatus.TODO, chainId, chainIndex: 7,
    targetBranch: "main", opensPullRequest: false,
  } });
  const run = await db.run.create({ data: {
    projectId: project.id, taskId: regression.id, agentId: regressionAgent.id, repoId: repo.id,
    runNumber: 1, dedupeKey: `task:${regression.id}:run:1`, runner: "CODEX", model: regressionAgent.model,
    promptHash: "hash", status: "SUCCEEDED", branch: BRANCH, pushedBranch: BRANCH,
    targetBranch: "main", headSha: HEAD, pullRequestNumber: 41,
    pullRequestUrl: "https://github.com/acme/widgets/pull/41",
  } });
  await db.taskStepOutput.create({ data: {
    taskId: regression.id,
    runId: run.id,
    kind: "regression-verification",
    body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: BASE, gateVerdict: "PASS" }),
    commitSha: HEAD,
  } });
  return { project, repo, regression, readiness, integrator };
};

test("clean exact-head readiness authorizes and queues mechanical merge", async () => {
  const seeded = await seedReadiness();
  assert.deepEqual(await readinessTick(db, reader()), { claimed: 1, authorized: 1, reviewing: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seeded.readiness.id } });
  assert.equal(output.commitSha, HEAD);
  assert.equal((await db.run.count({ where: { taskId: seeded.integrator.id } })), 1);
});

test("a defense-list diff opens one blind review and blocks authorization until exact-head approval", async () => {
  const seeded = await seedReadiness();
  const guarded = reader([{ filename: "scripts/merge-gate.sh", patch: "@@ -1 +1 @@\n-old\n+new" }]);
  assert.deepEqual(await readinessTick(db, guarded), { claimed: 1, authorized: 0, reviewing: 1, stopped: 0 });
  assert.equal(await db.taskStepOutput.count({ where: { taskId: seeded.readiness.id } }), 0);
  const review = await db.task.findFirstOrThrow({ where: { followUpTaskId: seeded.readiness.id, name: "Autonomous merge tail: independent review" } });
  const reviewRun = await db.run.findFirstOrThrow({ where: { taskId: review.id } });
  assert.equal(reviewRun.model, "gpt-5.6-sol:medium");
  await db.taskActivity.create({ data: {
    taskId: seeded.readiness.id,
    actorType: "control-plane",
    body: `Independent review approved exact head ${HEAD}`,
    metadata: { kind: "mergeTail.reviewObligation", schemaVersion: 1, state: "approved", reviewTaskId: review.id, headSha: HEAD, baseSha: BASE },
  } });
  await db.task.update({ where: { id: seeded.readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
  assert.deepEqual(await readinessTick(db, guarded), { claimed: 1, authorized: 1, reviewing: 0, stopped: 0 });
});

test("a conflict resolution that edits existing test lines opens the same review obligation", async () => {
  const seeded = await seedReadiness();
  await db.taskActivity.create({ data: {
    taskId: seeded.regression.id,
    actorType: "control-plane",
    body: "resolver completed",
    metadata: {
      kind: "mergeTail.repairResult", schemaVersion: 1, repairKind: "refresh-conflict",
      startHeadSha: "c".repeat(40), targetHeadSha: BASE, resolvedHeadSha: HEAD,
    },
  } });
  let compare = 0;
  const testEditReader: GitHubReader = {
    readPullRequest: async () => snapshot(),
    compareCommits: async () => ({ files: compare++ === 0
      ? []
      : [{ filename: "packages/api/src/example.test.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] }),
  };
  assert.deepEqual(await readinessTick(db, testEditReader), { claimed: 1, authorized: 0, reviewing: 1, stopped: 0 });
  const obligation = await db.taskActivity.findFirstOrThrow({ where: { taskId: seeded.readiness.id, body: { startsWith: "Independent review obligation opened" } } });
  assert.match(JSON.stringify(obligation.metadata), /existing-test-lines-modified/u);
});

test("base drift invalidates a head-bound PASS and returns the chain to regression", async () => {
  const seeded = await seedReadiness();
  const driftedBase = "d".repeat(40);
  assert.deepEqual(await readinessTick(db, reader([], snapshot({ baseSha: driftedBase }))), { claimed: 1, authorized: 0, reviewing: 0, stopped: 1 });
  const [readiness, regression] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.REVIEW);
  assert.equal(regression.status, TaskStatus.REVIEW);
  assert.match(readiness.failureReason ?? "", new RegExp(driftedBase));
});

test("manual start cannot turn server-owned readiness into a model run", async () => {
  const seeded = await seedReadiness();
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "merge-tail-readiness-operator";
  try {
    const response = await createApp(db).request(`/tasks/${seeded.readiness.id}/start`, {
      method: "POST",
      headers: { Authorization: "Bearer merge-tail-readiness-operator", "Content-Type": "application/json" },
    });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /server-owned/u);
    assert.equal(await db.run.count({ where: { taskId: seeded.readiness.id } }), 0);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
});
