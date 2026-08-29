import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  DIRECT_TEMPLATE_NAME,
  enqueueTaskRun,
  INTEGRATOR_TEMPLATE_NAME,
  legacyTemplateName,
  PrismaClient,
  RepoPermission,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { GitHubReadError } from "./github-read.js";
import { runDbScript } from "./test-db-script.js";
import { resetTestDb, setupTestDb } from "./testdb.js";
import { instantiateTemplate } from "./templates.js";

const RUNNER_TOKEN = "parallel-review-runner-token";
const OPERATOR_TOKEN = "parallel-review-operator-token";
const IMPLEMENTATION_BASE = "1".repeat(40);
const IMPLEMENTATION_HEAD = "2".repeat(40);
const SPECIFICATION_BRIEF = "Parallel review specification fixture brief.";
const BOUND_SPECIFICATION_BRIEF = [
  "Keep direct-chain intent fixed.",
  "",
  "Background: oldRouteName is current behavior.",
  "",
  "Changes:",
  "1. Revalidate oldHandler while preserving claim ordering.",
  "",
  "Out of scope: compound templates.",
  "",
  "Constraints: existing chains remain unchanged.",
  "",
  "Acceptance: bound claims materialize the refreshed brief.",
  "",
  "Route: implementation=senior-dev - claim-time materialization",
].join("\n");
let materializedSpecification = SPECIFICATION_BRIEF;
const specificationReads: Array<{ repository: string; path: string; commitSha: string }> = [];
const specificationReader = {
  readFileAtCommit: async (repository: string, path: string, commitSha: string): Promise<Uint8Array> => {
    specificationReads.push({ repository, path, commitSha });
    return new TextEncoder().encode(materializedSpecification);
  },
};

type Claim = {
  task: {
    id: string;
    chainIndex: number | null;
    chainLayer: number | null;
  };
  run: {
    id: string;
    taskId: string;
    runNumber: number;
    branch: string | null;
    targetBranch: string | null;
    implementationBaseSha: string | null;
    implementationHeadSha: string | null;
    pinnedBaseSha: string | null;
  };
  specificationMaterialization: {
    kind: "direct-implementation";
    path: string;
    body: string;
  } | null;
  fencingToken: string;
  sessionToken: string;
};

type CanonicalInstallation = {
  projectId: string;
  directTemplateId: string;
  fullTemplateId: string;
  repoId: string;
};

type DirectFixture = CanonicalInstallation & {
  chainId: string;
  branchName: string;
  implementationTaskId: string;
  solTaskId: string;
  blindTaskId: string;
  fixTaskId: string;
};

type BoundDirectFixture = DirectFixture & {
  revalidationTaskId: string;
};

type FullFixture = CanonicalInstallation & {
  chainId: string;
  branchName: string;
  implementationTaskId: string;
  solTaskId: string;
  blindTaskId: string;
};

let db: PrismaClient;
const previousEnvironment = {
  runner: process.env.RUNNER_TOKEN,
  operator: process.env.OPERATOR_TOKEN,
};

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  db = setupTestDb();
});

beforeEach(async () => {
  materializedSpecification = SPECIFICATION_BRIEF;
  specificationReads.length = 0;
  await resetTestDb(db);
  await runDbScript("seed.ts");
  await runDbScript("sync-canonical-prompts.ts");
});

after(async () => {
  await db.$disconnect();
  if (previousEnvironment.runner === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = previousEnvironment.runner;
  if (previousEnvironment.operator === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousEnvironment.operator;
});

const request = async (
  path: string,
  method: "GET" | "POST" | "PATCH",
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> => {
  const response = await createApp(db, { specificationReader }).request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
};

const runnerRequest = (path: string, body: Record<string, unknown>) => request(path, "POST", RUNNER_TOKEN, body);
const operatorRequest = (path: string, method: "POST" | "PATCH", body?: Record<string, unknown>) =>
  request(path, method, OPERATOR_TOKEN, body);

const seedRepoGrants = async (projectId: string): Promise<string> => {
  const repo = await db.repo.create({
    data: {
      projectId,
      name: "parallel-review-repo",
      remoteUrl: "https://github.com/example/parallel-review.git",
      mountPath: "/repo",
      defaultBranch: "main",
    },
  });
  const agents = await db.agent.findMany({ where: { projectId }, select: { id: true } });
  await db.agentRepoAccess.createMany({
    data: agents.map(({ id: agentId }) => ({
      projectId,
      agentId,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: RepoPermission.GIT_WRITE,
    })),
  });
  return repo.id;
};

const canonicalInstallation = async (): Promise<CanonicalInstallation> => {
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const [direct, full] = await Promise.all([
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    }),
    db.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    }),
  ]);
  assert.deepEqual(direct.steps.map((step) => step.layer), [1, 2, 3, 3, 4, 5, 6, 7]);
  assert.deepEqual(full.steps.map((step) => step.layer), [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11]);
  return {
    projectId: project.id,
    directTemplateId: direct.id,
    fullTemplateId: full.id,
    repoId: await seedRepoGrants(project.id),
  };
};

const instantiateDirect = async (brief = SPECIFICATION_BRIEF): Promise<DirectFixture> => {
  const installation = await canonicalInstallation();
  const branchName = `parallel/direct-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const chain = await instantiateTemplate(db, installation.projectId, installation.directTemplateId, {
    repoId: installation.repoId,
    variables: { branchName },
    description: brief,
    autoStart: true,
  });
  const byIndex = new Map(chain.tasks.map((task) => [task.chainIndex, task]));
  return {
    ...installation,
    chainId: chain.chainId,
    branchName,
    implementationTaskId: byIndex.get(1)!.id,
    solTaskId: byIndex.get(2)!.id,
    blindTaskId: byIndex.get(3)!.id,
    fixTaskId: byIndex.get(4)!.id,
  };
};

const instantiateBoundDirect = async (brief = BOUND_SPECIFICATION_BRIEF): Promise<BoundDirectFixture> => {
  const installation = await canonicalInstallation();
  const predecessor = await db.task.create({
    data: {
      projectId: installation.projectId,
      repoId: installation.repoId,
      name: "Bound direct predecessor",
      description: "Complete to dispatch revalidation",
      chainId: `predecessor-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      chainIndex: 1,
      chainLayer: 1,
      status: TaskStatus.TODO,
      assigneeType: "HUMAN",
    },
  });
  const branchName = `parallel/bound-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const chain = await instantiateTemplate(db, installation.projectId, installation.directTemplateId, {
    repoId: installation.repoId,
    variables: { branchName },
    description: brief,
    afterTaskId: predecessor.id,
  });
  assert.equal(chain.tasks.length, 8);
  const byIndex = new Map(chain.tasks.map((task) => [task.chainIndex, task]));
  const dispatched = await operatorRequest(`/tasks/${predecessor.id}`, "PATCH", { status: TaskStatus.DONE });
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
  return {
    ...installation,
    chainId: chain.chainId,
    branchName,
    revalidationTaskId: byIndex.get(1)!.id,
    implementationTaskId: byIndex.get(2)!.id,
    solTaskId: byIndex.get(3)!.id,
    blindTaskId: byIndex.get(4)!.id,
    fixTaskId: byIndex.get(5)!.id,
  };
};

/** Full Assurance has approval-gated planning nodes. This fixture completes
 * those already-reviewed nodes as historical evidence, then enters the real
 * implementation-to-parallel-review boundary through the runner API. */
const instantiateFullAtReviewFrontier = async (): Promise<FullFixture> => {
  const installation = await canonicalInstallation();
  const branchName = `parallel/full-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const chain = await instantiateTemplate(db, installation.projectId, installation.fullTemplateId, {
    repoId: installation.repoId,
    variables: { branchName },
    description: SPECIFICATION_BRIEF,
    autoStart: false,
  });
  const byIndex = new Map(chain.tasks.map((task) => [task.chainIndex, task]));
  const priorIds = chain.tasks.filter((task) => (task.chainIndex ?? 0) < 5).map((task) => task.id);
  await db.task.updateMany({ where: { id: { in: priorIds } }, data: { status: TaskStatus.DONE } });
  const specificationTask = byIndex.get(1)!;
  await db.taskStepOutput.create({ data: {
    taskId: specificationTask.id,
    kind: "spec",
    body: JSON.stringify({ schemaVersion: 1, headSha: IMPLEMENTATION_BASE, spec: SPECIFICATION_BRIEF }),
    commitSha: IMPLEMENTATION_BASE,
  } });
  const revisedPlanTask = byIndex.get(4)!;
  await db.taskStepOutput.create({ data: {
    taskId: revisedPlanTask.id,
    kind: "revised-plan",
    body: JSON.stringify({
      schemaVersion: 1,
      headSha: IMPLEMENTATION_BASE,
      summary: "Parallel review fixture plan approved without revisions.",
      addressedFindingIds: [],
      declinedFindings: [],
    }),
    commitSha: IMPLEMENTATION_BASE,
  } });
  const implementation = byIndex.get(5)!;
  await db.$transaction((tx) => enqueueTaskRun(tx, implementation.id));
  return {
    ...installation,
    chainId: chain.chainId,
    branchName,
    implementationTaskId: implementation.id,
    solTaskId: byIndex.get(6)!.id,
    blindTaskId: byIndex.get(7)!.id,
  };
};

const claim = async (runnerId: string): Promise<Claim> => {
  const result = await runnerRequest("/runner/tasks/claim", { runnerId, leaseSeconds: 120 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as Claim;
};

const persistSessionOutput = async (
  claimed: Claim,
  kind: string,
  body: Record<string, unknown>,
  commitSha: string,
): Promise<void> => {
  const response = await createApp(db).request(`/session/runs/${claimed.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind,
      body: JSON.stringify(body),
      commitSha,
    }),
  });
  const responseBody = await response.json();
  assert.equal(response.status, 200, JSON.stringify(responseBody));
};

const complete = async (
  claimed: Claim,
  runnerId: string,
  options: {
    outputKind?: string;
    output?: Record<string, unknown>;
    headSha?: string;
    baseSha?: string;
    branch?: string;
    failed?: boolean;
  } = {},
): Promise<{ status: number; body: unknown }> => {
  const headSha = options.headSha ?? IMPLEMENTATION_HEAD;
  if (options.output && options.outputKind) {
    await persistSessionOutput(claimed, options.outputKind, options.output, headSha);
  }
  return runnerRequest(`/runner/runs/${claimed.run.id}/complete`, {
    runnerId,
    fencingToken: claimed.fencingToken,
    exitCode: options.failed ? 1 : 0,
    terminalEventSeen: !options.failed,
    terminalSuccess: !options.failed,
    ...(options.failed ? {
      failureClass: "TASK_FAILED",
      retryable: false,
      failureReason: "parallel-review fixture failure",
    } : {}),
    branch: options.branch ?? claimed.run.branch ?? "parallel/review-head",
    pushedBranch: options.branch ?? claimed.run.branch ?? "parallel/review-head",
    baseSha: options.baseSha ?? IMPLEMENTATION_BASE,
    headSha: options.failed ? null : headSha,
    pushStatus: options.failed ? "FAILED" : "SUCCEEDED",
    cleanupStatus: "SUCCEEDED",
    workspaceRetained: false,
  });
};

const implementationOutput = (headSha = IMPLEMENTATION_HEAD) => ({
  schemaVersion: 1,
  headSha,
  baseSha: IMPLEMENTATION_BASE,
  summary: "parallel review integration fixture implementation",
  testsRun: ["npm test -- parallel review"],
});

const reviewOutput = (kind: "sol-findings" | "blind-findings") => ({
  schemaVersion: 1,
  headSha: IMPLEMENTATION_HEAD,
  reviewedBase: IMPLEMENTATION_BASE,
  reviewedHead: IMPLEMENTATION_HEAD,
  findings: [],
  ...(kind === "sol-findings" ? { commandsRun: ["git diff --check"] } : {}),
});

const completeImplementation = async (fixture: DirectFixture | FullFixture, runnerId = "implementation-runner"): Promise<Claim> => {
  const claimed = await claim(runnerId);
  assert.equal(claimed.run.taskId, fixture.implementationTaskId);
  assert.equal(claimed.run.implementationBaseSha, null);
  const result = await complete(claimed, runnerId, {
    outputKind: "implementation",
    output: implementationOutput(),
    baseSha: IMPLEMENTATION_BASE,
    branch: fixture.branchName,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return claimed;
};

const reviewClaims = async (
  fixture: DirectFixture | FullFixture,
  firstRunner = "sol-runner",
  secondRunner = "blind-runner",
) => {
  const first = await claim(firstRunner);
  const second = await claim(secondRunner);
  const reviewTasks = new Set([fixture.solTaskId, fixture.blindTaskId]);
  assert.ok(reviewTasks.has(first.run.taskId));
  assert.ok(reviewTasks.has(second.run.taskId));
  assert.notEqual(first.run.taskId, second.run.taskId);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: first.run.id } })).runnerId, firstRunner);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: second.run.id } })).runnerId, secondRunner);
  for (const claimed of [first, second]) {
    assert.equal(claimed.run.implementationBaseSha, IMPLEMENTATION_BASE);
    assert.equal(claimed.run.implementationHeadSha, IMPLEMENTATION_HEAD);
    assert.equal(claimed.run.pinnedBaseSha, IMPLEMENTATION_HEAD);
    assert.equal(claimed.run.targetBranch, IMPLEMENTATION_HEAD);
  }
  assert.ok(specificationReads.length >= 2);
  assert.ok(specificationReads.every(({ commitSha, path }) => (
    commitSha === IMPLEMENTATION_HEAD && path === `.chain/${fixture.branchName}/spec.md`
  )));
  return { first, second };
};

const completeReview = async (claimed: Claim, runnerId: string, kind: "sol-findings" | "blind-findings") => {
  const result = await complete(claimed, runnerId, {
    outputKind: kind,
    output: reviewOutput(kind),
    headSha: IMPLEMENTATION_HEAD,
    baseSha: IMPLEMENTATION_BASE,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
};

const queuedRunsFor = (taskIds: string[]) => db.run.findMany({
  where: { taskId: { in: taskIds }, status: RunStatus.QUEUED },
  select: { id: true, taskId: true, runNumber: true, promptHash: true },
});

test("Direct sync instantiates a parallel review frontier claimable by distinct runners with one pinned range", async () => {
  const fixture = await instantiateDirect();
  const implementation = await completeImplementation(fixture);
  assert.deepEqual(implementation.specificationMaterialization, {
    kind: "direct-implementation",
    path: `.chain/${fixture.branchName}/spec.md`,
    body: SPECIFICATION_BRIEF,
  });

  const queued = await queuedRunsFor([fixture.solTaskId, fixture.blindTaskId]);
  assert.equal(queued.length, 2);
  assert.ok(queued.every(({ promptHash }) => promptHash === null));
  const { first, second } = await reviewClaims(fixture);
  assert.notEqual(first.run.id, second.run.id);
  assert.deepEqual(new Set([first.task.chainLayer, second.task.chainLayer]), new Set([2]));
  assert.deepEqual(new Set([first.task.chainIndex, second.task.chainIndex]), new Set([2, 3]));
});

test("bound revalidation PATCH becomes implementation spec.md authority for both reviews", async () => {
  const fixture = await instantiateBoundDirect();
  const revalidation = await claim("revalidation-runner");
  assert.equal(revalidation.run.taskId, fixture.revalidationTaskId);
  for (const attempted of [
    BOUND_SPECIFICATION_BRIEF.replace("Keep direct-chain intent fixed", "Remove direct-chain revalidation"),
    BOUND_SPECIFICATION_BRIEF.replace("Revalidate oldHandler", "Delete oldHandler"),
    BOUND_SPECIFICATION_BRIEF.replace("Out of scope: compound templates.", "Out of scope: nothing."),
    BOUND_SPECIFICATION_BRIEF.replace("Constraints: existing chains remain unchanged.", "Constraints: compatibility may break."),
    BOUND_SPECIFICATION_BRIEF.replace("Acceptance: bound claims materialize the refreshed brief.", "Acceptance: no verification."),
    BOUND_SPECIFICATION_BRIEF.replace("Route: implementation=senior-dev", "Route: implementation=frontend-dev"),
  ]) {
    const refused = await request(
      `/session/runs/${revalidation.run.id}/task`,
      "PATCH",
      revalidation.sessionToken,
      { fencingToken: revalidation.fencingToken, description: attempted },
    );
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
  }
  const refreshedBrief = BOUND_SPECIFICATION_BRIEF
    .replace("oldRouteName is current behavior", "newRouteName is current behavior")
    .replace("oldHandler", "newHandler");
  const patched = await request(
    `/session/runs/${revalidation.run.id}/task`,
    "PATCH",
    revalidation.sessionToken,
    { fencingToken: revalidation.fencingToken, description: refreshedBrief },
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const implementationDescription = (await db.task.findUniqueOrThrow({
    where: { id: fixture.implementationTaskId },
    select: { description: true },
  })).description;
  assert.match(implementationDescription, new RegExp(refreshedBrief, "u"));
  assert.match(implementationDescription, /Implement this task/u);

  const completedRevalidation = await complete(revalidation, "revalidation-runner", {
    outputKind: "revalidation",
    output: {
      schemaVersion: 1,
      headSha: IMPLEMENTATION_BASE,
      outcome: "updated",
      summary: "Refreshed descriptive route names.",
      changedReferences: ["route names"],
    },
    headSha: IMPLEMENTATION_BASE,
    baseSha: IMPLEMENTATION_BASE,
    branch: fixture.branchName,
  });
  assert.equal(completedRevalidation.status, 200, JSON.stringify(completedRevalidation.body));

  const implementation = await completeImplementation(fixture, "bound-implementation-runner");
  assert.deepEqual(implementation.specificationMaterialization, {
    kind: "direct-implementation",
    path: `.chain/${fixture.branchName}/spec.md`,
    body: refreshedBrief,
  });
  materializedSpecification = refreshedBrief;
  const reviews = await reviewClaims(fixture, "bound-sol-runner", "bound-blind-runner");
  assert.notEqual(reviews.first.run.id, reviews.second.run.id);
});

test("a collapsed premise waits in Inbox and an operator choice resumes revalidation", async () => {
  const fixture = await instantiateBoundDirect();
  const revalidation = await claim("premise-collapse-runner");
  assert.equal(revalidation.run.taskId, fixture.revalidationTaskId);
  await db.session.update({
    where: { runId: revalidation.run.id },
    data: { providerConversationId: "premise-collapse-conversation" },
  });
  const choices = [
    { id: "cancel-chain", label: "cancel this chain" },
    { id: "operator-rewrite", label: "operator rewrites the brief, then continue" },
    { id: "proceed-reading", label: "proceed with the step's proposed reading" },
  ];
  const question = await request(
    `/session/runs/${revalidation.run.id}/inbox/questions`,
    "POST",
    revalidation.sessionToken,
    {
      fencingToken: revalidation.fencingToken,
      requestId: "premise-collapse-question",
      body: "The implementation premise is already delivered at current HEAD.",
      choices,
      chatId: "premise-collapse-chat",
    },
  );
  assert.equal(question.status, 201, JSON.stringify(question.body));
  const messageId = (question.body as { id: string }).id;
  const waitingRun = await db.run.findUniqueOrThrow({ where: { id: revalidation.run.id } });
  const waitingSession = await db.session.findUniqueOrThrow({ where: { runId: revalidation.run.id } });
  assert.equal(waitingRun.status, RunStatus.WAITING_INBOX);
  assert.equal(waitingSession.executionStatus, SessionExecutionStatus.WAITING_INBOX);
  assert.equal(waitingSession.waitingOnMessageId, messageId);

  const decision = await operatorRequest(`/inbox/messages/${messageId}/decision`, "POST", {
    requestId: "premise-collapse-decision",
    decision: "operator-rewrite",
  });
  assert.equal(decision.status, 201, JSON.stringify(decision.body));
  const resumedRun = await db.run.findUniqueOrThrow({ where: { id: revalidation.run.id } });
  const resumedSession = await db.session.findUniqueOrThrow({ where: { runId: revalidation.run.id } });
  assert.equal(resumedRun.status, RunStatus.QUEUED);
  assert.equal(resumedSession.executionStatus, SessionExecutionStatus.REQUESTED);
  assert.equal(resumedSession.waitingOnMessageId, null);
  assert.match(resumedSession.resumeInput ?? "", /operator-rewrite/u);
});

test("revalidation cancellation requires the durable cancel-chain decision and parks the chain", async () => {
  const fixture = await instantiateBoundDirect();
  const initial = await claim("premise-cancel-runner");
  assert.equal(initial.run.taskId, fixture.revalidationTaskId);
  const noDecision = await request(
    `/session/runs/${initial.run.id}/revalidation/cancel`,
    "POST",
    initial.sessionToken,
    { fencingToken: initial.fencingToken },
  );
  assert.equal(noDecision.status, 403, JSON.stringify(noDecision.body));
  await db.session.update({
    where: { runId: initial.run.id },
    data: { providerConversationId: "premise-cancel-conversation" },
  });
  const question = await request(
    `/session/runs/${initial.run.id}/inbox/questions`,
    "POST",
    initial.sessionToken,
    {
      fencingToken: initial.fencingToken,
      requestId: "premise-cancel-question",
      body: "The implementation premise is already delivered at current HEAD.",
      choices: [
        { id: "cancel-chain", label: "cancel this chain" },
        { id: "operator-rewrite", label: "operator rewrites the brief, then continue" },
        { id: "proceed-reading", label: "proceed with the step's proposed reading" },
      ],
      chatId: "premise-cancel-chat",
    },
  );
  assert.equal(question.status, 201, JSON.stringify(question.body));
  const openQuestion = await request(
    `/session/runs/${initial.run.id}/revalidation/cancel`,
    "POST",
    initial.sessionToken,
    { fencingToken: initial.fencingToken },
  );
  assert.equal(openQuestion.status, 401, JSON.stringify(openQuestion.body));
  const messageId = (question.body as { id: string }).id;
  const decision = await operatorRequest(`/inbox/messages/${messageId}/decision`, "POST", {
    requestId: "premise-cancel-decision",
    decision: "cancel-chain",
  });
  assert.equal(decision.status, 201, JSON.stringify(decision.body));
  const resumed = await claim("premise-cancel-runner");
  assert.equal(resumed.run.id, initial.run.id);
  const cancelled = await request(
    `/session/runs/${resumed.run.id}/revalidation/cancel`,
    "POST",
    resumed.sessionToken,
    { fencingToken: resumed.fencingToken },
  );
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const run = await db.run.findUniqueOrThrow({ where: { id: resumed.run.id } });
  assert.equal(run.cancelRequestId, `revalidation:${run.id}:cancel`);
  assert.match(run.cancelReason ?? "", /operator selected cancel this chain/u);
  assert.ok(run.cancelRequestedAt);
  assert.ok(run.sessionTokenRevokedAt);
  const activityCount = await db.taskActivity.count({
    where: { metadata: { path: ["requestId"], equals: run.cancelRequestId } },
  });
  const wrongFenceReplay = await request(
    `/session/runs/${resumed.run.id}/revalidation/cancel`,
    "POST",
    resumed.sessionToken,
    { fencingToken: "wrong-replay-fence" },
  );
  assert.equal(wrongFenceReplay.status, 409, JSON.stringify(wrongFenceReplay.body));
  const replay = await request(
    `/session/runs/${resumed.run.id}/revalidation/cancel`,
    "POST",
    resumed.sessionToken,
    { fencingToken: resumed.fencingToken },
  );
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, cancelled.body);
  assert.equal(await db.taskActivity.count({
    where: { metadata: { path: ["requestId"], equals: run.cancelRequestId } },
  }), activityCount);
  const revokedStatus = await request(
    `/session/runs/${resumed.run.id}/status`,
    "GET",
    resumed.sessionToken,
  );
  assert.equal(revokedStatus.status, 401, JSON.stringify(revokedStatus.body));
  const chainTasks = await db.task.findMany({ where: { chainId: fixture.chainId }, orderBy: { chainIndex: "asc" } });
  assert.equal(chainTasks.length, 8);
  assert.ok(chainTasks.every((task) => task.status === TaskStatus.BACKLOG));
  assert.ok(chainTasks.every((task) => task.failureReason === run.cancelReason));
});

test("revalidation cancellation refuses a non-spec-revalidator session", async () => {
  const ordinary = await instantiateDirect();
  const implementation = await claim("non-revalidator-runner");
  assert.equal(implementation.run.taskId, ordinary.implementationTaskId);
  const denied = await request(
    `/session/runs/${implementation.run.id}/revalidation/cancel`,
    "POST",
    implementation.sessionToken,
    { fencingToken: implementation.fencingToken },
  );
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
});

for (const wrongDecision of ["proceed-reading", "operator-rewrite"] as const) {
  test(`revalidation cancellation rejects an answered ${wrongDecision} decision`, async () => {
    const fixture = await instantiateBoundDirect();
    const initial = await claim(`${wrongDecision}-runner`);
    assert.equal(initial.run.taskId, fixture.revalidationTaskId);
    await db.session.update({
      where: { runId: initial.run.id },
      data: { providerConversationId: `${wrongDecision}-conversation` },
    });
    const question = await request(
      `/session/runs/${initial.run.id}/inbox/questions`,
      "POST",
      initial.sessionToken,
      {
        fencingToken: initial.fencingToken,
        requestId: `${wrongDecision}-question`,
        body: "The premise collapsed.",
        choices: [
          { id: "cancel-chain", label: "cancel this chain" },
          { id: "operator-rewrite", label: "operator rewrites the brief, then continue" },
          { id: "proceed-reading", label: "proceed with the step's proposed reading" },
        ],
        chatId: `${wrongDecision}-chat`,
      },
    );
    assert.equal(question.status, 201, JSON.stringify(question.body));
    const answered = await operatorRequest(
      `/inbox/messages/${(question.body as { id: string }).id}/decision`,
      "POST",
      { requestId: `${wrongDecision}-decision`, decision: wrongDecision },
    );
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    const resumed = await claim(`${wrongDecision}-runner`);
    const denied = await request(
      `/session/runs/${resumed.run.id}/revalidation/cancel`,
      "POST",
      resumed.sessionToken,
      { fencingToken: resumed.fencingToken },
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal((await db.run.findUniqueOrThrow({ where: { id: resumed.run.id } })).cancelRequestId, null);
  });
}

test("a faithful direct brief ending in the prior-output reminder remains claimable", async () => {
  const brief = "Preserve this exact ending.\nRead the prior template steps' persisted outputs before working.";
  materializedSpecification = brief;
  const fixture = await instantiateDirect(brief);
  await completeImplementation(fixture, "reminder-implementation");
  const reviewed = await claim("reminder-review");
  assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(reviewed.run.taskId));
});

test("a faithful direct spec with one conventional final newline remains claimable", async () => {
  const brief = "Preserve this exact ending without a final newline.";
  materializedSpecification = `${brief}\n`;
  const fixture = await instantiateDirect(brief);
  await completeImplementation(fixture, "final-newline-implementation");
  const reviewed = await claim("final-newline-review");
  assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(reviewed.run.taskId));
});

test("a transient specification read failure retries and claims without parking", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "transient-read-implementation");
  let reads = 0;
  const response = await createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (reads === 1) throw new GitHubReadError("TLS handshake eof", "transport");
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  }).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "transient-read-review", leaseSeconds: 120 }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.equal(reads, 2);
  assert.equal(await db.run.count({
    where: { taskId: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: RunStatus.FAILED },
  }), 0);
  assert.equal(await db.task.count({
    where: { id: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: TaskStatus.BACKLOG },
  }), 0);
  assert.equal(await db.inboxMessage.count({
    where: { body: { contains: "spec-transcription" } },
  }), 0);
});

test("persistent transient specification reads defer observably and a later poll claims without operator action", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "persistent-read-implementation");
  let reads = 0;
  let unavailable = true;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (unavailable) throw new GitHubReadError(`proxy flap ${reads}`, "transport");
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  });
  const poll = (runnerId: string) => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 120 }),
  });
  const deferredResponse = await poll("persistent-read-review");
  assert.equal(deferredResponse.status, 204, await deferredResponse.text());
  assert.equal(reads, 3);

  const deferral = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { taskId: true, metadata: true },
  });
  const evidence = deferral.metadata as Record<string, unknown>;
  assert.equal(evidence.classification, "transient");
  assert.equal(evidence.attempt, 1);
  assert.equal(evidence.runId === undefined, false);
  assert.equal(typeof evidence.nextAttemptAt, "string");
  assert.match(String(evidence.lastUnderlyingError), /last failure: proxy flap 3/u);

  const deferredRun = await db.run.findFirstOrThrow({
    where: { taskId: deferral.taskId, status: RunStatus.QUEUED },
  });
  assert.ok(deferredRun.readyAt.getTime() > deferredRun.createdAt.getTime());
  assert.equal(deferredRun.leaseGeneration, 0);
  assert.equal(deferredRun.runnerId, null);
  assert.equal(deferredRun.fencingToken, null);
  assert.equal(await db.session.count({ where: { runId: deferredRun.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: deferral.taskId } })).status, TaskStatus.TODO);
  assert.equal(await db.inboxMessage.count({ where: { taskId: deferral.taskId } }), 0);

  unavailable = false;
  await db.run.update({ where: { id: deferredRun.id }, data: { readyAt: new Date(0) } });
  const claimedResponse = await poll("recovered-read-review");
  const claimedText = await claimedResponse.text();
  assert.equal(claimedResponse.status, 200, claimedText);
  assert.equal((JSON.parse(claimedText) as Claim).run.id, deferredRun.id);
  assert.equal(reads, 4);
});

test("transient specification read deferrals follow the backoff schedule and clamp to the budget deadline", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "backoff-read-implementation");
  let reads = 0;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        throw new GitHubReadError(`proxy flap ${reads}`, "transport");
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "backoff-read-review", leaseSeconds: 120 }),
  });

  assert.equal((await poll()).status, 204);
  const first = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  const runId = String((first.metadata as Record<string, unknown>).runId);
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  assert.equal((await poll()).status, 204);

  let deferrals = await db.taskActivity.findMany({
    where: {
      taskId: first.taskId,
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { id: true, metadata: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  assert.deepEqual(deferrals.map(({ metadata }) => {
    const evidence = metadata as Record<string, unknown>;
    return [evidence.attempt, evidence.delayMs];
  }), [[1, 15_000], [2, 30_000]]);

  await db.taskActivity.update({
    where: { id: deferrals[0]!.id },
    data: { createdAt: new Date(Date.now() - 299_000) },
  });
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  assert.equal((await poll()).status, 204);
  deferrals = await db.taskActivity.findMany({
    where: {
      taskId: first.taskId,
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { id: true, metadata: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const third = deferrals.map(({ metadata }) => metadata as Record<string, unknown>)
    .find((evidence) => evidence.attempt === 3);
  assert.ok(third);
  assert.equal(third.delayMs, 60_000);
  assert.equal(third.nextAttemptAt, third.budgetDeadlineAt);
  assert.equal(reads, 9);
});

test("a resumed run starts a fresh transient specification read budget", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "resumed-read-implementation");
  let reads = 0;
  let unavailable = true;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (unavailable) throw new GitHubReadError(`proxy flap ${reads}`, "transport");
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "resumed-read-review", leaseSeconds: 120 }),
  });

  assert.equal((await poll()).status, 204);
  const staleDeferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  const runId = String((staleDeferral.metadata as Record<string, unknown>).runId);
  unavailable = false;
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  const firstClaim = await poll();
  const firstClaimText = await firstClaim.text();
  assert.equal(firstClaim.status, 200, firstClaimText);
  assert.equal((JSON.parse(firstClaimText) as Claim).run.id, runId);
  await db.taskActivity.update({
    where: { id: staleDeferral.id },
    data: { createdAt: new Date(Date.now() - 6 * 60_000) },
  });
  await db.run.update({
    where: { id: runId },
    data: {
      status: RunStatus.QUEUED,
      readyAt: new Date(0),
      runnerId: null,
      fencingToken: null,
      leaseExpiresAt: null,
    },
  });
  unavailable = true;

  assert.equal((await poll()).status, 204);
  const resumed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(resumed.status, RunStatus.QUEUED);
  const currentEpisode = await db.taskActivity.findMany({
    where: {
      taskId: staleDeferral.taskId,
      createdAt: { gt: resumed.claimedAt! },
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { metadata: true },
  });
  assert.equal(currentEpisode.length, 1);
  assert.equal((currentEpisode[0]!.metadata as Record<string, unknown>).attempt, 1);
  assert.equal(reads, 7);
});

test("an expired transient specification read budget fails even if the repository read recovered", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "exhausted-read-implementation");
  let reads = 0;
  let unavailable = true;
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (unavailable) throw new GitHubReadError(`proxy flap ${reads}`, "transport");
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "exhausted-read-review", leaseSeconds: 120 }),
  });
  const first = await poll();
  assert.equal(first.status, 204, await first.text());
  const deferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { id: true, taskId: true, metadata: true },
  });
  const runId = String((deferral.metadata as Record<string, unknown>).runId);
  await db.taskActivity.update({
    where: { id: deferral.id },
    data: { createdAt: new Date(Date.now() - 6 * 60_000) },
  });
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  await db.run.updateMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      id: { not: runId },
      status: RunStatus.QUEUED,
    },
    data: { readyAt: new Date(Date.now() + 60_000) },
  });
  unavailable = false;

  const exhausted = await poll();
  assert.equal(exhausted.status, 204, await exhausted.text());
  assert.equal(reads, 3);
  const failed = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(failed.status, RunStatus.FAILED);
  assert.equal(failed.retryable, false);
  assert.match(failed.failureReason ?? "", /transient read deferral budget exhausted after 300000ms/u);
  assert.match(failed.failureReason ?? "", /last failure: proxy flap 3/u);
  assert.equal((failed.failureReason?.match(/Spec transcription claim refused/gu) ?? []).length, 1);
  assert.equal(failed.leaseGeneration, 0);
  assert.equal(failed.runnerId, null);
  assert.equal(failed.fencingToken, null);
  assert.equal(await db.session.count({ where: { runId } }), 0);
  const task = await db.task.findUniqueOrThrow({ where: { id: deferral.taskId } });
  assert.equal(task.status, TaskStatus.BACKLOG);
  assert.equal(task.failureReason, failed.failureReason);
  const settlement = await db.taskActivity.findFirstOrThrow({
    where: {
      taskId: deferral.taskId,
      metadata: { path: ["exhaustedCondition"], equals: "specification-read-claim-deferred" },
    },
  });
  assert.equal((settlement.metadata as Record<string, unknown>).classification, "transient");
  assert.equal(await db.inboxMessage.count({
    where: { dedupeKey: `spec-transcription-unreadable:${runId}` },
  }), 1);
});

test("one poll settles every review sibling whose transient specification read budget expired", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "sibling-exhaustion-implementation");
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        throw new GitHubReadError("shared proxy flap", "transport");
      },
    },
  });
  const poll = () => app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "sibling-exhaustion-review", leaseSeconds: 120 }),
  });

  assert.equal((await poll()).status, 204);
  assert.equal((await poll()).status, 204);
  const deferrals = await db.taskActivity.findMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
    select: { id: true, metadata: true },
  });
  assert.equal(deferrals.length, 2);
  const runIds = deferrals.map(({ metadata }) => String((metadata as Record<string, unknown>).runId));
  await db.taskActivity.updateMany({
    where: { id: { in: deferrals.map(({ id }) => id) } },
    data: { createdAt: new Date(Date.now() - 6 * 60_000) },
  });
  await db.run.updateMany({ where: { id: { in: runIds } }, data: { readyAt: new Date(0) } });

  assert.equal((await poll()).status, 204);
  assert.equal(await db.run.count({
    where: { id: { in: runIds }, status: RunStatus.FAILED },
  }), 2);
  assert.equal(await db.task.count({
    where: { id: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: TaskStatus.BACKLOG },
  }), 2);
});

test("a review cancelled during transient specification-read deferral is never claimed", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "cancelled-read-implementation");
  let reads = 0;
  let blockNextRead = false;
  let announceReadStarted!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { announceReadStarted = resolve; });
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  const app = createApp(db, {
    specificationReader: {
      readFileAtCommit: async () => {
        reads += 1;
        if (blockNextRead) {
          blockNextRead = false;
          announceReadStarted();
          await readReleased;
        }
        throw new GitHubReadError("proxy flap before cancellation", "transport");
      },
    },
  });
  const first = await app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "cancelled-read-review", leaseSeconds: 120 }),
  });
  assert.equal(first.status, 204, await first.text());
  const deferral = await db.taskActivity.findFirstOrThrow({
    where: { metadata: { path: ["condition"], equals: "specification-read-claim-deferred" } },
    select: { taskId: true, metadata: true },
  });
  const runId = String((deferral.metadata as Record<string, unknown>).runId);
  await db.run.update({ where: { id: runId }, data: { readyAt: new Date(0) } });
  await db.run.updateMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      id: { not: runId },
      status: RunStatus.QUEUED,
    },
    data: { readyAt: new Date(Date.now() + 60_000) },
  });
  blockNextRead = true;
  const pendingClaim = app.request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "post-deferral-review", leaseSeconds: 120 }),
  });
  await readStarted;
  const cancelled = await operatorRequest(`/runs/${runId}/cancel`, "POST", {
    requestId: "cancel-during-spec-read-deferral",
    reason: "operator no longer needs this review",
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  releaseRead();
  const afterCancellation = await pendingClaim;
  assert.equal(afterCancellation.status, 204, await afterCancellation.text());
  assert.equal(reads, 6);
  const cancelledRun = await db.run.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(cancelledRun.status, RunStatus.CANCELLED);
  assert.equal(cancelledRun.runnerId, null);
  assert.equal(cancelledRun.fencingToken, null);
  assert.equal(await db.session.count({ where: { runId } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: deferral.taskId } })).status, TaskStatus.REVIEW);
  assert.equal(await db.taskActivity.count({
    where: {
      taskId: deferral.taskId,
      metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
    },
  }), 1);
});

test("a repository change between verification and claim triggers verification against the new repository", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "repository-change-implementation");
  const repositoriesRead: string[] = [];
  const response = await createApp(db, {
    specificationReader: {
      readFileAtCommit: async (repository) => {
        repositoriesRead.push(repository);
        if (repositoriesRead.length === 1) {
          await db.repo.update({
            where: { id: fixture.repoId },
            data: { remoteUrl: "https://github.com/example/replaced-review.git" },
          });
        }
        return new TextEncoder().encode(SPECIFICATION_BRIEF);
      },
    },
  }).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "repository-change-review", leaseSeconds: 120 }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const reviewed = JSON.parse(responseText) as Claim;
  assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(reviewed.run.taskId));
  assert.deepEqual(repositoriesRead, [
    "example/parallel-review",
    "example/replaced-review",
  ]);
});

test("a faithful rolled-over compound chain still resolves the approved specification", async () => {
  const fixture = await instantiateFullAtReviewFrontier();
  await db.taskTemplate.update({
    where: { id: fixture.fullTemplateId },
    data: { name: legacyTemplateName(INTEGRATOR_TEMPLATE_NAME, "pre-zero-gate", fixture.fullTemplateId) },
  });
  await completeImplementation(fixture, "legacy-compound-implementation");
  const reviewed = await claim("legacy-compound-review");
  assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(reviewed.run.taskId));
});

test("an unreadable review candidate is parked without blocking an unrelated claim in the same poll", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture, "unreadable-implementation");
  const unrelatedChain = await instantiateTemplate(db, fixture.projectId, fixture.directTemplateId, {
    repoId: fixture.repoId,
    variables: { branchName: `parallel/unrelated-${Date.now()}` },
    description: "unrelated implementation brief",
    autoStart: true,
  });
  const unrelatedImplementationTask = unrelatedChain.tasks.find((task) => task.chainIndex === 1);
  assert.ok(unrelatedImplementationTask);

  const response = await createApp(db, { specificationReader: null }).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "unrelated-runner", leaseSeconds: 120 }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const claimed = JSON.parse(responseText) as Claim;
  assert.equal(claimed.run.taskId, unrelatedImplementationTask.id);

  const failedReviews = await db.run.findMany({
    where: {
      taskId: { in: [fixture.solTaskId, fixture.blindTaskId] },
      status: RunStatus.FAILED,
    },
    select: { id: true, taskId: true, failureReason: true, retryable: true },
  });
  assert.equal(failedReviews.length, 2);
  assert.ok(failedReviews.every((run) => run.retryable === false && run.failureReason?.includes("spec-transcription-unreadable")));
  for (const failed of failedReviews) {
    assert.ok(failed.taskId);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: failed.taskId } })).status, TaskStatus.BACKLOG);
    assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `spec-transcription-unreadable:${failed.id}` } }), 1);
  }
});

test("tampered direct and compound materializations refuse claim with the named reason without starving the sibling", async () => {
  for (const shape of ["direct", "compound"] as const) {
    await resetTestDb(db);
    await runDbScript("seed.ts");
    await runDbScript("sync-canonical-prompts.ts");
    materializedSpecification = shape === "direct"
      ? `Feature brief:\n${SPECIFICATION_BRIEF}\nPersist the final implementation output for this step through the Anneal task output endpoint.`
      : "tampered specification";
    specificationReads.length = 0;
    const fixture = shape === "direct"
      ? await instantiateDirect()
      : await instantiateFullAtReviewFrontier();
    await completeImplementation(fixture, `${shape}-implementation`);

    const refused = await runnerRequest("/runner/tasks/claim", {
      runnerId: `${shape}-review`,
      leaseSeconds: 120,
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    const refusalBody = refused.body as { error: string; reason: string };
    assert.equal(refusalBody.reason, "spec-transcription-mismatch");
    assert.match(refusalBody.error, /Spec transcription claim refused: spec-transcription-mismatch/u);
    assert.equal(specificationReads.length, 1);

    const failed = await db.run.findFirstOrThrow({
      where: { taskId: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: RunStatus.FAILED },
      select: { id: true, taskId: true, failureReason: true, retryable: true },
    });
    assert.equal(failed.retryable, false);
    assert.ok(failed.taskId);
    assert.match(failed.failureReason ?? "", /spec-transcription-mismatch/u);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: failed.taskId } })).status, TaskStatus.BACKLOG);
    assert.equal(await db.inboxMessage.count({ where: { dedupeKey: `spec-transcription-mismatch:${failed.id}` } }), 1);
    const refusalActivity = await db.taskActivity.findFirstOrThrow({
      where: {
        taskId: failed.taskId,
        metadata: { path: ["condition"], equals: "spec-transcription-mismatch" },
      },
    });
    assert.equal((refusalActivity.metadata as Record<string, unknown>).classification, "non-transient");
    assert.equal(await db.taskActivity.count({
      where: {
        taskId: failed.taskId,
        metadata: { path: ["condition"], equals: "specification-read-claim-deferred" },
      },
    }), 0);

    materializedSpecification = SPECIFICATION_BRIEF;
    const sibling = await claim(`${shape}-sibling`);
    assert.ok([fixture.solTaskId, fixture.blindTaskId].includes(sibling.run.taskId));
    assert.notEqual(sibling.run.taskId, failed.taskId);
  }
});

test("the HTTP join stays closed after the first review and creates one fix-step run after the second", async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture);
  const { first, second } = await reviewClaims(fixture);
  const firstKind = first.run.taskId === fixture.solTaskId ? "sol-findings" : "blind-findings";
  const secondKind = second.run.taskId === fixture.solTaskId ? "sol-findings" : "blind-findings";

  await completeReview(first, first.run.taskId === fixture.solTaskId ? "sol-runner" : "blind-runner", firstKind);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 0);
  await completeReview(second, second.run.taskId === fixture.solTaskId ? "sol-runner" : "blind-runner", secondKind);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId, status: RunStatus.QUEUED } }), 1);
});

test("simultaneous review completions serialize the join to exactly one fix-step run", { timeout: 20_000 }, async () => {
  const fixture = await instantiateDirect();
  await completeImplementation(fixture);
  const { first, second } = await reviewClaims(fixture, "simultaneous-sol", "simultaneous-blind");
  const firstIsSol = first.run.taskId === fixture.solTaskId;
  await Promise.all([
    completeReview(first, firstIsSol ? "simultaneous-sol" : "simultaneous-blind", firstIsSol ? "sol-findings" : "blind-findings"),
    completeReview(second, firstIsSol ? "simultaneous-blind" : "simultaneous-sol", firstIsSol ? "blind-findings" : "sol-findings"),
  ]);
  assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1);
});

test("failed, parked, and archived-Agent review siblings fail-stop the join until repaired", async () => {
  for (const mode of ["failed", "parked", "archived-agent"] as const) {
    await resetTestDb(db);
    await runDbScript("seed.ts");
    await runDbScript("sync-canonical-prompts.ts");
    const fixture = await instantiateDirect();
    const blindBeforeImplementation = fixture.blindTaskId;

    if (mode === "parked") {
      await db.task.update({ where: { id: blindBeforeImplementation }, data: { status: TaskStatus.BACKLOG } });
    } else if (mode === "archived-agent") {
      await db.task.update({ where: { id: blindBeforeImplementation }, data: { status: TaskStatus.BACKLOG } });
      const blindTask = await db.task.findUniqueOrThrow({
        where: { id: blindBeforeImplementation },
        select: { assigneeAgentId: true },
      });
      assert.ok(blindTask.assigneeAgentId);
      const archived = await operatorRequest(`/agents/${blindTask.assigneeAgentId}/archive`, "POST");
      assert.equal(archived.status, 200, JSON.stringify(archived.body));
      // This models an archived assignee already stored on a runnable chain
      // node, which is reachable from pre-protocol data and concurrent control
      // plane repair. Activation must park it rather than enqueueing work.
      await db.task.update({ where: { id: blindBeforeImplementation }, data: { status: TaskStatus.TODO } });
    }

    await completeImplementation(fixture, `${mode}-implementation`);
    const solClaim = await claim(`${mode}-sol`);
    assert.equal(solClaim.run.taskId, fixture.solTaskId);
    await completeReview(solClaim, `${mode}-sol`, "sol-findings");
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 0, mode);

    let repairedClaim: Claim;
    if (mode === "failed") {
      const blindClaim = await claim("failed-blind");
      assert.equal(blindClaim.run.taskId, fixture.blindTaskId);
      const failed = await complete(blindClaim, "failed-blind", { failed: true });
      assert.equal(failed.status, 200, JSON.stringify(failed.body));
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.blindTaskId } })).status, TaskStatus.REVIEW);
      const retry = await operatorRequest(`/tasks/${fixture.blindTaskId}/retry`, "POST");
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      repairedClaim = await claim("failed-blind-repair");
    } else if (mode === "parked") {
      const started = await operatorRequest(`/tasks/${fixture.blindTaskId}/start`, "POST");
      assert.equal(started.status, 201, JSON.stringify(started.body));
      repairedClaim = await claim("parked-blind-repair");
    } else {
      const blindTask = await db.task.findUniqueOrThrow({
        where: { id: fixture.blindTaskId },
        select: { assigneeAgentId: true, status: true, failureReason: true },
      });
      assert.equal(blindTask.status, TaskStatus.REVIEW);
      assert.match(blindTask.failureReason ?? "", /Assignee .* is archived/u);
      assert.ok(blindTask.assigneeAgentId);
      const unarchived = await operatorRequest(`/agents/${blindTask.assigneeAgentId}/unarchive`, "POST");
      assert.equal(unarchived.status, 200, JSON.stringify(unarchived.body));
      await db.task.update({ where: { id: fixture.blindTaskId }, data: { status: TaskStatus.BACKLOG } });
      const started = await operatorRequest(`/tasks/${fixture.blindTaskId}/start`, "POST");
      assert.equal(started.status, 201, JSON.stringify(started.body));
      repairedClaim = await claim("archived-agent-blind-repair");
    }

    assert.equal(repairedClaim.run.taskId, fixture.blindTaskId);
    await completeReview(repairedClaim, `${mode}-blind-repair`, "blind-findings");
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId } }), 1, mode);
    assert.equal(await db.run.count({ where: { taskId: fixture.fixTaskId, status: RunStatus.QUEUED } }), 1, mode);
  }
});

test("Full Assurance reaches its layer-6 review pair and one runner can claim both sequentially", async () => {
  const fixture = await instantiateFullAtReviewFrontier();
  await completeImplementation(fixture, "single-runner");
  const { first, second } = await reviewClaims(fixture, "single-runner", "single-runner");
  assert.equal(first.task.chainLayer, 6);
  assert.equal(second.task.chainLayer, 6);
  assert.equal(first.run.implementationBaseSha, IMPLEMENTATION_BASE);
  assert.equal(second.run.implementationHeadSha, IMPLEMENTATION_HEAD);

  const firstIsSol = first.run.taskId === fixture.solTaskId;
  await completeReview(first, "single-runner", firstIsSol ? "sol-findings" : "blind-findings");
  assert.equal(await db.run.count({ where: { taskId: { in: [fixture.solTaskId, fixture.blindTaskId] }, status: RunStatus.QUEUED } }), 0);
  await completeReview(second, "single-runner", firstIsSol ? "blind-findings" : "sol-findings");
  assert.equal(await db.run.count({ where: { task: { chainId: fixture.chainId, chainIndex: 8 } } }), 1);
});
