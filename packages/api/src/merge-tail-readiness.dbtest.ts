import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  AssigneeType,
  type ChangedFile,
  INTEGRATOR_SENTINEL_MODEL,
  PrismaClient,
  TaskStatus,
} from "@agentos/db";

import type { GitHubReader, PullRequestSnapshot } from "./github-read.js";
import type { MergeLeaseAcquirer, MergeLeaseReleaser } from "./merge-lease.js";
import { READINESS_CLAIM_LEASE_MS, readinessTick } from "./merge-readiness-worker.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
const releasedChainLeases: string[] = [];
const releaseChainLease: MergeLeaseReleaser = async (chainId) => {
  releasedChainLeases.push(chainId);
  return { outcome: "released", ref: "refs/merge-lease/holder", sha: "lease-fixture" };
};
beforeEach(async () => {
  releasedChainLeases.length = 0;
  await resetTestDb(db);
});
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BRANCH = "agentos/merge-tail-test";
const NEWER_CLAIM = "merge-readiness-claim:new-worker|2099-01-01T00:00:00.000Z";

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
  files: ChangedFile[] = [],
  pullRequest = snapshot(),
): GitHubReader => ({
  readPullRequest: async () => pullRequest,
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files }),
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
    makeAgent("review-coordinator-sol"),
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
      taskTemplateId: template.id, stepIndex: 5, layer: 5, name: "Regression", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: regressionAgent.id, prompt: "verify", approvalGate: false,
      outputKind: "regression-verification", opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 6, layer: 6, name: "Readiness", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: reviewAgent.id, prompt: "mechanical", approvalGate: false,
      outputKind: "merge-authorization", opensPullRequest: false,
    } }),
    db.taskTemplateStep.create({ data: {
      taskTemplateId: template.id, stepIndex: 7, layer: 7, name: "Merge", assigneeType: AssigneeType.AGENT,
      assigneeAgentId: integratorAgent.id, prompt: "merge", approvalGate: false,
      outputKind: "merge-result", opensPullRequest: false,
    } }),
  ]);
  const chainId = `tail-${Date.now()}`;
  const regression = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: regressionStep.id,
    name: "Regression", description: "verify", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: regressionAgent.id, status: TaskStatus.DONE, chainId, chainIndex: 5, chainLayer: 5, targetBranch: "main",
  } });
  const readiness = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: readinessStep.id,
    name: "Readiness", description: "authorize", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: reviewAgent.id, status: TaskStatus.TODO, chainId, chainIndex: 6, chainLayer: 6, targetBranch: "main",
  } });
  const integrator = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: integratorStep.id,
    name: "Merge", description: "merge", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: integratorAgent.id, status: TaskStatus.TODO, chainId, chainIndex: 7, chainLayer: 7,
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
  await db.task.update({
    where: { id: seeded.regression.id },
    data: { failureReason: "readiness evaluation failed: GitHub read failed: fetch failed" },
  });
  assert.deepEqual(await readinessTick(db, reader()), { claimed: 1, authorized: 1, reviewing: 0, requeued: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).failureReason, null);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seeded.readiness.id } });
  assert.equal(output.commitSha, HEAD);
  assert.equal((await db.run.count({ where: { taskId: seeded.integrator.id } })), 1);
});

test("a defense-list diff opens one blind review and blocks authorization until exact-head approval", async () => {
  const seeded = await seedReadiness();
  const guarded = reader([{ filename: "scripts/merge-gate.sh", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }]);
  assert.deepEqual(await readinessTick(db, guarded), { claimed: 1, authorized: 0, reviewing: 1, requeued: 0, stopped: 0 });
  assert.equal(await db.taskStepOutput.count({ where: { taskId: seeded.readiness.id } }), 0);
  const review = await db.task.findFirstOrThrow({ where: { projectId: seeded.project.id, name: "Autonomous merge tail: independent review" } });
  const reviewRun = await db.run.findFirstOrThrow({ where: { taskId: review.id } });
  assert.equal(reviewRun.model, "gpt-5.6-sol:medium");
  await db.taskActivity.create({ data: {
    taskId: seeded.readiness.id,
    actorType: "control-plane",
    body: `Independent review approved exact head ${HEAD}`,
    metadata: { kind: "mergeTail.reviewObligation", schemaVersion: 1, state: "approved", reviewTaskId: review.id, headSha: HEAD, baseSha: BASE },
  } });
  await db.task.update({ where: { id: seeded.readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
  assert.deepEqual(await readinessTick(db, guarded), { claimed: 1, authorized: 1, reviewing: 0, requeued: 0, stopped: 0 });
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
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: compare++ === 0
      ? []
      : [{ filename: "packages/api/src/example.test.ts", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }] }),
  };
  assert.deepEqual(await readinessTick(db, testEditReader), { claimed: 1, authorized: 0, reviewing: 1, requeued: 0, stopped: 0 });
  const obligation = await db.taskActivity.findFirstOrThrow({ where: { taskId: seeded.readiness.id, body: { startsWith: "Independent review obligation opened" } } });
  assert.match(JSON.stringify(obligation.metadata), /existing-test-lines-modified/u);
});

test("base drift invalidates a head-bound PASS and returns the chain to regression", async () => {
  const seeded = await seedReadiness();
  const driftedBase = "d".repeat(40);
  assert.deepEqual(await readinessTick(db, reader([], snapshot({ baseSha: driftedBase })), new Date(), 5, releaseChainLease), { claimed: 1, authorized: 0, reviewing: 0, requeued: 1, stopped: 0 });
  const [readiness, regression] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.TODO);
  assert.equal(regression.status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 2);
  const compensated = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id },
    orderBy: { runNumber: "desc" },
  });
  assert.equal(compensated.runNumber, 2);
  assert.equal(compensated.maxRunsPerTask, 6);
  assert.equal(compensated.budgetGrants, 1);
  assert.deepEqual(releasedChainLeases, [], "base drift requeue keeps the chain lease");
});

test("ordinary base requeue reuses an approved exact-head review", async () => {
  const seeded = await seedReadiness();
  const driftedBase = "d".repeat(40);
  await db.taskActivity.create({ data: {
    taskId: seeded.readiness.id,
    actorType: "control-plane",
    body: `Independent review approved exact head ${HEAD}`,
    metadata: {
      kind: "mergeTail.reviewObligation", schemaVersion: 1, state: "approved",
      reviewTaskId: "prior-review", headSha: HEAD, baseSha: BASE,
    },
  } });
  assert.equal((await readinessTick(db, reader([], snapshot({ baseSha: driftedBase })))).requeued, 1);
  const freshRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.regression.id }, orderBy: { runNumber: "desc" },
  });
  await db.run.update({ where: { id: freshRun.id }, data: { status: "SUCCEEDED", headSha: HEAD } });
  await db.taskStepOutput.update({ where: { taskId: seeded.regression.id }, data: {
    runId: freshRun.id,
    body: JSON.stringify({
      schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: driftedBase, gateVerdict: "PASS",
    }),
    commitSha: HEAD,
  } });
  await db.task.update({ where: { id: seeded.regression.id }, data: { status: TaskStatus.DONE } });
  const guarded = reader(
    [{ filename: "scripts/merge-gate.sh", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }],
    snapshot({ baseSha: driftedBase }),
  );
  assert.deepEqual(await readinessTick(db, guarded), {
    claimed: 1, authorized: 1, reviewing: 0, requeued: 0, stopped: 0,
  });
  assert.equal(await db.task.count({ where: { name: "Autonomous merge tail: independent review" } }), 0);
});

test("future and wrong-index readiness steps are never claimed", async () => {
  const future = await seedReadiness();
  await db.task.update({ where: { id: future.regression.id }, data: { status: TaskStatus.TODO } });
  assert.deepEqual(await readinessTick(db, reader()), { claimed: 0, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 });
  assert.equal(await db.inboxMessage.count(), 0);

  await db.task.update({ where: { id: future.regression.id }, data: { status: TaskStatus.DONE } });
  await db.taskTemplateStep.update({ where: { id: future.readiness.templateStepId! }, data: { stepIndex: 9 } });
  assert.deepEqual(await readinessTick(db, reader()), { claimed: 0, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 });
});

test("an expired orphaned DOING readiness claim is reclaimed after restart", async () => {
  const seeded = await seedReadiness();
  await db.task.update({ where: { id: seeded.readiness.id }, data: {
    status: TaskStatus.DOING,
    failureReason: "merge-readiness-claim:dead-worker|2000-01-01T00:00:00.000Z",
  } });
  assert.deepEqual(await readinessTick(db, reader()), { claimed: 1, authorized: 1, reviewing: 0, requeued: 0, stopped: 0 });
});

test("an incomplete compare response and a behind head fail closed", async () => {
  const incomplete = await seedReadiness();
  const maxFiles = Array.from({ length: 300 }, (_, index) => ({
    filename: `docs/benign-${index}.md`, previousFilename: null, patch: "+new",
  }));
  const incompleteReader: GitHubReader = {
    readPullRequest: async () => snapshot(),
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: false, files: maxFiles }),
  };
  assert.deepEqual(await readinessTick(db, incompleteReader, new Date(), 5, releaseChainLease), { claimed: 1, authorized: 0, reviewing: 0, requeued: 0, stopped: 1 });
  assert.match((await db.task.findUniqueOrThrow({ where: { id: incomplete.readiness.id } })).failureReason ?? "", /completeness/u);
  assert.deepEqual(releasedChainLeases, [incomplete.readiness.chainId]);

  await resetTestDb(db);
  releasedChainLeases.length = 0;
  const behind = await seedReadiness();
  const behindReader: GitHubReader = {
    readPullRequest: async () => snapshot(),
    compareCommits: async () => ({ status: "behind", behindBy: 1, filesComplete: true, files: [] }),
  };
  assert.deepEqual(await readinessTick(db, behindReader), { claimed: 1, authorized: 0, reviewing: 0, requeued: 1, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: behind.regression.id } })).status, TaskStatus.TODO);
  assert.deepEqual(releasedChainLeases, []);
});

test("an absent runner-created PR identity stops loudly before authorization", async () => {
  const seeded = await seedReadiness();
  await db.run.updateMany({ where: { taskId: seeded.regression.id }, data: {
    pullRequestNumber: null, pullRequestUrl: null,
  } });
  assert.deepEqual(await readinessTick(db, reader(), new Date(), 5, releaseChainLease), { claimed: 1, authorized: 0, reviewing: 0, requeued: 0, stopped: 1 });
  assert.match((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).failureReason ?? "", /pull-request target/u);
  assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);
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

test("the merge lease is handed back for the length of an independent review", async () => {
  const seeded = await seedReadiness();
  const guarded = reader([{ filename: "scripts/merge-gate.sh", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }]);
  assert.deepEqual(await readinessTick(db, guarded, new Date(), 5, releaseChainLease), { claimed: 1, authorized: 0, reviewing: 1, requeued: 0, stopped: 0 });
  assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);
});

test("a contended lease leaves readiness for a later tick instead of authorizing", async () => {
  const seeded = await seedReadiness();
  const asked: string[] = [];
  const contended: MergeLeaseAcquirer = async (chainId) => {
    asked.push(chainId);
    return { outcome: "contended" };
  };
  const started = new Date();
  assert.deepEqual(
    await readinessTick(db, reader(), started, 5, releaseChainLease, contended),
    { claimed: 1, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 },
  );
  assert.deepEqual(asked, [seeded.readiness.chainId]);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: seeded.readiness.id } }), 0);
  assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DOING);
  assert.deepEqual(releasedChainLeases, []);

  // The claim, not a retry counter, is what brings it back: once the claim
  // expires the next tick re-evaluates and takes the lease it could not get.
  const acquired: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
  assert.deepEqual(
    await readinessTick(
      db,
      reader(),
      new Date(started.getTime() + (READINESS_CLAIM_LEASE_MS * 2)),
      5,
      releaseChainLease,
      acquired,
    ),
    { claimed: 1, authorized: 1, reviewing: 0, requeued: 0, stopped: 0 },
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: seeded.integrator.id } }), 1);
});

test("a stale worker cannot stop readiness after a newer worker owns the claim", async () => {
  const seeded = await seedReadiness();
  let startRead!: () => void;
  let finishRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { startRead = resolve; });
  const readMayFinish = new Promise<void>((resolve) => { finishRead = resolve; });
  const delayed: GitHubReader = {
    readPullRequest: async () => {
      startRead();
      await readMayFinish;
      return snapshot({ baseSha: null });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };
  const tick = readinessTick(db, delayed, new Date(), 5, releaseChainLease);
  await readStarted;
  await db.task.update({
    where: { id: seeded.readiness.id },
    data: { status: TaskStatus.DOING, failureReason: NEWER_CLAIM },
  });
  finishRead();

  assert.deepEqual(await tick, { claimed: 1, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 });
  const [readiness, regression] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.DOING);
  assert.equal(readiness.failureReason, NEWER_CLAIM);
  assert.equal(regression.status, TaskStatus.DONE);
  assert.deepEqual(releasedChainLeases, []);
});

test("a stale worker cannot requeue regression after a newer worker owns the claim", async () => {
  const seeded = await seedReadiness();
  let startRead!: () => void;
  let finishRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { startRead = resolve; });
  const readMayFinish = new Promise<void>((resolve) => { finishRead = resolve; });
  const delayed: GitHubReader = {
    readPullRequest: async () => {
      startRead();
      await readMayFinish;
      return snapshot({ headRefOid: "c".repeat(40) });
    },
    compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
  };
  const tick = readinessTick(db, delayed);
  await readStarted;
  await db.task.update({
    where: { id: seeded.readiness.id },
    data: { status: TaskStatus.DOING, failureReason: NEWER_CLAIM },
  });
  finishRead();

  assert.deepEqual(await tick, { claimed: 1, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 });
  assert.equal(await db.run.count({ where: { taskId: seeded.regression.id } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.regression.id } })).status, TaskStatus.DONE);
});

test("an unreachable merge lease acquire stops with a durable reason", async () => {
  const seeded = await seedReadiness();
  const unreachable: MergeLeaseAcquirer = async () => ({ outcome: "unreachable", detail: "spawn bash ENOENT" });
  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, unreachable),
    { claimed: 1, authorized: 0, reviewing: 0, requeued: 0, stopped: 1 },
  );
  const readiness = await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } });
  assert.equal(readiness.status, TaskStatus.REVIEW);
  assert.match(readiness.failureReason ?? "", /merge lease acquire is unreachable.*ENOENT/u);
  assert.deepEqual(releasedChainLeases, [seeded.readiness.chainId]);
});

test("a worker that acquired then lost its claim releases unless a successor owns the lease window", async () => {
  const abandoned = await seedReadiness();
  const loseToOperator: MergeLeaseAcquirer = async () => {
    await db.task.update({
      where: { id: abandoned.readiness.id },
      data: { status: TaskStatus.REVIEW, failureReason: "operator parked readiness" },
    });
    return { outcome: "acquired" };
  };
  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, loseToOperator),
    { claimed: 1, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 },
  );
  assert.deepEqual(releasedChainLeases, [abandoned.readiness.chainId]);

  await resetTestDb(db);
  releasedChainLeases.length = 0;
  const succeeded = await seedReadiness();
  const loseToWorker: MergeLeaseAcquirer = async () => {
    await db.task.update({
      where: { id: succeeded.readiness.id },
      data: { status: TaskStatus.DOING, failureReason: NEWER_CLAIM },
    });
    return { outcome: "acquired" };
  };
  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 5, releaseChainLease, loseToWorker),
    { claimed: 1, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 },
  );
  assert.deepEqual(releasedChainLeases, []);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: succeeded.readiness.id } })).failureReason, NEWER_CLAIM);
});

test("eligible readiness is not hidden behind the first hundred ineligible candidates", async () => {
  const seeded = await seedReadiness();
  await db.task.createMany({ data: Array.from({ length: 100 }, (_, index) => ({
    projectId: seeded.readiness.projectId,
    repoId: seeded.readiness.repoId,
    templateId: seeded.readiness.templateId,
    templateStepId: seeded.readiness.templateStepId,
    name: `Blocked readiness ${index}`,
    description: "regression is not done",
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: seeded.readiness.assigneeAgentId,
    status: TaskStatus.TODO,
    chainId: `blocked-tail-${index}`,
    chainIndex: seeded.readiness.chainIndex,
    chainLayer: seeded.readiness.chainLayer,
    targetBranch: "main",
    createdAt: new Date(0),
  })) });

  assert.deepEqual(
    await readinessTick(db, reader(), new Date(), 1),
    { claimed: 1, authorized: 1, reviewing: 0, requeued: 0, stopped: 0 },
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readiness.id } })).status, TaskStatus.DONE);
});
