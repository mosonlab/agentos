import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { enqueueTaskRun, INTEGRATOR_TEMPLATE_NAME, PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";
import { instantiateTemplate } from "./templates.js";

const execFileAsync = promisify(execFile);
const DB_DIRECTORY = fileURLToPath(new URL("../../db", import.meta.url));
const RUNNER_TOKEN = "blind-claim-runner-token";
const OPERATOR_TOKEN = "blind-claim-operator-token";
const UNIQUE_PREDECESSOR_FINDING = {
  id: "SOL-UNIQUE-1",
  severity: "P1",
  file: "src/unique.ts",
  line: 17,
  title: "Unique predecessor defect",
  evidence: "Only the predecessor review observed this defect.",
  requiredFix: "Close the unique defect.",
} as const;

let db: PrismaClient;
const priorRunnerToken = process.env.RUNNER_TOKEN;
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const seedCanonicalTemplate = async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "prisma/seed.ts"],
    { cwd: DB_DIRECTORY, env: { ...process.env, DATABASE_URL: testDatabaseUrl } },
  );
  assert.equal(stderr, "", stderr);
  assert.match(stdout, /Seeded .* agents\//u);

  const template = await db.taskTemplate.findFirstOrThrow({
    where: { name: INTEGRATOR_TEMPLATE_NAME },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const repo = await db.repo.create({ data: {
    projectId: template.projectId,
    name: "blind-claim-repo",
    remoteUrl: "https://github.com/acme/blind-claim.git",
    mountPath: "/repo",
    defaultBranch: "main",
  } });
  const agentIds = [...new Set(template.steps.flatMap((step) => step.assigneeAgentId ? [step.assigneeAgentId] : []))];
  await db.agentRepoAccess.createMany({ data: agentIds.map((agentId) => ({
    projectId: template.projectId,
    agentId,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  })) });
  return { template, repo };
};

const queueCanonicalStep = async (
  template: Awaited<ReturnType<typeof seedCanonicalTemplate>>["template"],
  repoId: string,
  stepIndex: number,
) => {
  const chain = await instantiateTemplate(db, template.projectId, template.id, {
    repoId,
    variables: { branchName: `blind-claim-step-${stepIndex}` },
    autoStart: true,
  });
  await db.run.deleteMany({ where: { taskId: { in: chain.tasks.map((task) => task.id) } } });
  const priorTasks = chain.tasks.filter((task) => task.chainIndex !== null && task.chainIndex < stepIndex);
  await db.task.updateMany({
    where: { id: { in: priorTasks.map((task) => task.id) } },
    data: { status: "DONE" },
  });
  const target = chain.tasks.find((task) => task.chainIndex === stepIndex);
  assert.ok(target, `canonical step ${stepIndex} must exist`);
  const sourceStepIndex = template.steps.find((step) => step.stepIndex === stepIndex)?.baseFromStepIndex ?? null;
  const sourceTask = sourceStepIndex === null
    ? null
    : priorTasks.find((task) => task.chainIndex === sourceStepIndex) ?? null;
  const sourceRun = sourceTask
    ? await db.$transaction((tx) => enqueueTaskRun(tx as never, sourceTask.id))
    : null;
  if (sourceRun) {
    await db.run.update({
      where: { id: sourceRun.id },
      data: { status: "SUCCEEDED", baseSha: "b".repeat(40) },
    });
  }
  await db.taskStepOutput.createMany({ data: priorTasks.map((task) => ({
    taskId: task.id,
    ...(task.id === sourceTask?.id && sourceRun ? { runId: sourceRun.id } : {}),
    kind: `step-${task.chainIndex}`,
    body: `persisted output from step ${task.chainIndex}`,
    commitSha: String(task.chainIndex).padStart(40, "0"),
  })) });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, target.id));
  return { run, chain };
};

const claim = async () => {
  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "blind-claim-runner", leaseSeconds: 60 }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    run: {
      id: string;
      targetBranch: string;
      pinnedBaseSha: string | null;
      implementationBaseSha: string | null;
      implementationHeadSha: string | null;
    };
    priorOutputs: Array<{ body: string }>;
    sessionToken: string;
    fencingToken: string;
  }>;
};

const reviewReport = (kind: "sol-findings" | "blind-findings", headSha: string, baseSha = "b".repeat(40)) => JSON.stringify({
  schemaVersion: 1,
  headSha,
  reviewedBase: baseSha,
  reviewedHead: headSha,
  findings: kind === "sol-findings" ? [UNIQUE_PREDECESSOR_FINDING] : [],
  ...(kind === "sol-findings" ? { commandsRun: ["git diff --check"] } : {}),
});

const prepareReviewReport = async (
  chain: Awaited<ReturnType<typeof queueCanonicalStep>>["chain"],
  stepIndex: number,
  kind: "sol-findings" | "blind-findings",
  headSha: string,
  baseSha = "b".repeat(40),
) => {
  const task = chain.tasks.find((candidate) => candidate.chainIndex === stepIndex);
  assert.ok(task, `review task ${stepIndex} must exist`);
  await db.task.update({ where: { id: task.id }, data: { status: "TODO" } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx as never, task.id));
  const now = new Date();
  await db.run.update({ where: { id: run.id }, data: {
    status: "SUCCEEDED",
    baseSha: baseSha,
    startedAt: now,
    endedAt: now,
  } });
  await db.taskStepOutput.deleteMany({ where: { taskId: task.id } });
  await db.taskStepOutput.create({ data: {
    taskId: task.id,
    runId: run.id,
    kind,
    body: reviewReport(kind, headSha, baseSha),
    commitSha: headSha,
  } });
  await db.task.update({ where: { id: task.id }, data: { status: "DONE" } });
  return { task, run };
};

test("blind session cannot read Sol evidence before or after its immutable report", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const blind = await queueCanonicalStep(template, repo.id, 7);
  const claimed = await claim();
  assert.equal(claimed.run.id, blind.run.id);
  assert.deepEqual(claimed.priorOutputs, []);

  const activityPath = `/session/runs/${blind.run.id}/chain/steps/6/activity`;
  const before = await createApp(db).request(activityPath, {
    headers: { Authorization: `Bearer ${claimed.sessionToken}` },
  });
  assert.equal(before.status, 403);

  const body = reviewReport("blind-findings", claimed.run.targetBranch);
  const persisted = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind: "blind-findings",
      body,
      commitSha: claimed.run.targetBranch,
    }),
  });
  const persistedText = await persisted.text();
  assert.equal(persisted.status, 200, persistedText);
  assert.deepEqual((JSON.parse(persistedText) as { predecessorOutputs: unknown[] }).predecessorOutputs, []);

  const rewrite = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind: "blind-findings",
      body: reviewReport("blind-findings", claimed.run.targetBranch, "c".repeat(40)),
      commitSha: claimed.run.targetBranch,
    }),
  });
  assert.equal(rewrite.status, 409);
  assert.match(await rewrite.text(), /immutable/u);

  const after = await createApp(db).request(activityPath, {
    headers: { Authorization: `Bearer ${claimed.sessionToken}` },
  });
  assert.equal(after.status, 403);
  const status = await createApp(db).request(`/session/runs/${blind.run.id}/status`, {
    headers: { Authorization: `Bearer ${claimed.sessionToken}` },
  });
  assert.equal(status.status, 200, await status.text());
});

test("adjudication claim refuses incomplete review evidence by name", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const adjudication = await queueCanonicalStep(template, repo.id, 8);
  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "adjudication-claim-runner", leaseSeconds: 60 }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /Adjudication claim refused/u);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: adjudication.run.id } })).status, "QUEUED");
});

test("adjudication claim refuses a non-DONE sibling and a mismatched report head", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const adjudication = await queueCanonicalStep(template, repo.id, 8);
  const headSha = adjudication.run.targetBranch!;
  const sol = await prepareReviewReport(adjudication.chain, 6, "sol-findings", headSha);
  const blind = await prepareReviewReport(adjudication.chain, 7, "blind-findings", headSha);
  await db.task.update({ where: { id: blind.task.id }, data: { status: "REVIEW" } });
  let response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "adjudication-claim-runner", leaseSeconds: 60 }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /blind-findings task .* not DONE/u);

  await db.task.update({ where: { id: blind.task.id }, data: { status: "DONE" } });
  await db.taskStepOutput.update({ where: { taskId: sol.task.id }, data: {
    commitSha: "d".repeat(40),
    body: reviewReport("sol-findings", "d".repeat(40)),
  } });
  response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "adjudication-claim-runner", leaseSeconds: 60 }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /sol-findings output .* expected/u);
});

test("adjudication claim succeeds only after both immutable reports match the pinned range", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const adjudication = await queueCanonicalStep(template, repo.id, 8);
  const headSha = adjudication.run.targetBranch!;
  await prepareReviewReport(adjudication.chain, 6, "sol-findings", headSha);
  await prepareReviewReport(adjudication.chain, 7, "blind-findings", headSha);

  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "adjudication-claim-runner", leaseSeconds: 60 }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const claimBody = JSON.parse(responseText) as {
    run: { id: string; implementationBaseSha: string | null; implementationHeadSha: string | null };
    priorOutputs: Array<{ kind: string; body: string }>;
  };
  assert.equal(claimBody.run.id, adjudication.run.id);
  assert.equal(claimBody.run.implementationBaseSha, "b".repeat(40));
  assert.equal(claimBody.run.implementationHeadSha, headSha);
  assert.ok(claimBody.priorOutputs.some((output) => output.kind === "sol-findings"));
  assert.ok(claimBody.priorOutputs.some((output) => output.kind === "blind-findings"));
});
