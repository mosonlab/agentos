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

const reviewBody = (headSha: string, findings: unknown[] = []) => JSON.stringify({
  schemaVersion: 1,
  headSha,
  reviewedBase: "b".repeat(40),
  reviewedHead: headSha,
  findings,
});

const closedReviewBody = (headSha: string, findings: unknown[]) => JSON.stringify({
  schemaVersion: 1,
  headSha,
  reviewedBase: "b".repeat(40),
  reviewedHead: headSha,
  findings,
  dispositions: findings.map((finding) => ({
    id: (finding as { id: string }).id,
    disposition: "ADOPTED",
    reason: "Verified against the reviewed implementation.",
  })),
  mustFixIds: findings.map((finding) => (finding as { id: string }).id),
});

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
  assert.match(stdout, /twelve-step feature template/u);

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
  return { run, expectedPriorOutputs: priorTasks.length };
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

test("canonical blind-review claims omit prior outputs while attached steps retain them", async () => {
  const { template, repo } = await seedCanonicalTemplate();

  const attached = await queueCanonicalStep(template, repo.id, 6);
  const attachedClaim = await claim();
  assert.equal(attachedClaim.run.id, attached.run.id);
  assert.equal(attachedClaim.priorOutputs.length, attached.expectedPriorOutputs);
  assert.ok(attachedClaim.priorOutputs.some((output) => output.body === "persisted output from step 5"));

  const blind = await queueCanonicalStep(template, repo.id, 7);
  const blindClaim = await claim();
  assert.equal(blindClaim.run.id, blind.run.id);
  assert.deepEqual(blindClaim.priorOutputs, []);
  assert.equal(blindClaim.run.pinnedBaseSha, "5".padStart(40, "0"));
  assert.equal(blindClaim.run.targetBranch, blindClaim.run.pinnedBaseSha);
  assert.equal(blindClaim.run.implementationBaseSha, "b".repeat(40));
  assert.equal(blindClaim.run.implementationHeadSha, blindClaim.run.pinnedBaseSha);
  const blindTask = await db.task.findUniqueOrThrow({ where: { id: blind.run.taskId! } });
  const predecessor = await db.task.findFirstOrThrow({ where: {
    chainId: blindTask.chainId,
    chainIndex: 6,
  } });
  await db.taskStepOutput.update({
    where: { taskId: predecessor.id },
    data: {
      kind: "sol-findings",
      body: JSON.stringify({
        schemaVersion: 1,
        headSha: blindClaim.run.targetBranch,
        reviewedBase: "b".repeat(40),
        reviewedHead: blindClaim.run.targetBranch,
        findings: [UNIQUE_PREDECESSOR_FINDING],
        commandsRun: ["git diff --check"],
      }),
    },
  });
  const independentBody = reviewBody(blindClaim.run.targetBranch);
  const finalBody = closedReviewBody(blindClaim.run.targetBranch, [UNIQUE_PREDECESSOR_FINDING]);

  const prematureClose = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${blindClaim.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: blindClaim.fencingToken,
      kind: "must-fix",
      body: finalBody,
      commitSha: blindClaim.run.targetBranch,
      metadata: { phase: "closed-must-fix" },
    }),
  });
  assert.equal(prematureClose.status, 409);

  const persisted = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${blindClaim.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: blindClaim.fencingToken,
      kind: "must-fix",
      body: independentBody,
      commitSha: blindClaim.run.targetBranch,
      metadata: { phase: "independent-findings" },
    }),
  });
  assert.equal(persisted.status, 200);
  const intermediate = await persisted.json() as { predecessorOutputs: Array<{ body: string }> };
  assert.deepEqual(intermediate.predecessorOutputs, []);

  const unlock = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${blindClaim.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: blindClaim.fencingToken,
      kind: "must-fix",
      body: independentBody,
      commitSha: blindClaim.run.targetBranch,
      metadata: { phase: "predecessor-evidence-unlocked" },
    }),
  });
  assert.equal(unlock.status, 200);
  const unlocked = await unlock.json() as { predecessorOutputs: Array<{ body: string }> };
  assert.equal(unlocked.predecessorOutputs.length, blind.expectedPriorOutputs);
  assert.ok(unlocked.predecessorOutputs.some((output) => output.body.includes(UNIQUE_PREDECESSOR_FINDING.id)));
  const unlockedOutput = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: blind.run.taskId! } });
  assert.equal(unlockedOutput.body, independentBody, "unlock must not publish a pre-adjudication final body");
  assert.deepEqual(unlockedOutput.metadata, { phase: "predecessor-evidence-unlocked" });

  const closed = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${blindClaim.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: blindClaim.fencingToken,
      kind: "must-fix",
      body: finalBody,
      commitSha: blindClaim.run.targetBranch,
      metadata: { phase: "closed-must-fix" },
    }),
  });
  assert.equal(closed.status, 200);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: blind.run.taskId! } });
  assert.deepEqual(output.metadata, { phase: "closed-must-fix" });
  assert.ok((JSON.parse(output.body) as { mustFixIds: string[] }).mustFixIds.includes(UNIQUE_PREDECESSOR_FINDING.id));
  const rewrite = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${blindClaim.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: blindClaim.fencingToken,
      kind: "must-fix",
      body: closedReviewBody(blindClaim.run.targetBranch, []),
      commitSha: blindClaim.run.targetBranch,
      metadata: { phase: "closed-must-fix" },
    }),
  });
  assert.equal(rewrite.status, 409);
  assert.equal((await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: blind.run.taskId! } })).body, finalBody);
  const archived = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: blind.run.taskId!,
    metadata: { path: ["kind"], equals: "canonicalTaskOutput.blindIndependentFindings" },
  } });
  assert.equal(archived.body, independentBody);
});

test("canonical blind review cannot complete from intermediate findings", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const blind = await queueCanonicalStep(template, repo.id, 7);
  const claimed = await claim();
  const intermediate = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind: "must-fix",
      body: reviewBody(claimed.run.targetBranch),
      commitSha: claimed.run.targetBranch,
      metadata: { phase: "independent-findings" },
    }),
  });
  assert.equal(intermediate.status, 200);

  const completed = await createApp(db).request(`/runner/runs/${blind.run.id}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "blind-claim-runner",
      fencingToken: claimed.fencingToken,
      exitCode: 0,
      signal: null,
      terminalEventSeen: true,
      terminalSuccess: true,
      terminationReason: null,
      branch: blind.run.branch,
      baseSha: "b".repeat(40),
      headSha: claimed.run.targetBranch,
      pushStatus: "NOT_REQUESTED",
      cleanupStatus: "SUCCEEDED",
      workspaceRetained: false,
    }),
  });
  assert.equal(completed.status, 200, await completed.text());
  const task = await db.task.findUniqueOrThrow({ where: { id: blind.run.taskId! } });
  assert.equal(task.status, "REVIEW");
  assert.match(task.failureReason ?? "", /closed-must-fix phase/u);
});

test("canonical blind review refuses incomplete and internally inconsistent final artifacts", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const blind = await queueCanonicalStep(template, repo.id, 7);
  const claimed = await claim();
  const independentFinding = {
    id: "OPUS-1",
    severity: "P1",
    file: "src/independent.ts",
    line: 9,
    title: "Independent defect",
    evidence: "The blind review verified the defect independently.",
    requiredFix: "Close the independent defect.",
  } as const;
  const independentBody = reviewBody(claimed.run.targetBranch, [independentFinding]);
  for (const phase of ["independent-findings", "predecessor-evidence-unlocked"] as const) {
    const response = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fencingToken: claimed.fencingToken,
        kind: "must-fix",
        body: independentBody,
        commitSha: claimed.run.targetBranch,
        metadata: { phase },
      }),
    });
    assert.equal(response.status, 200, await response.text());
  }

  const stub = JSON.stringify({
    schemaVersion: 1,
    headSha: claimed.run.targetBranch,
    reviewedBase: "b".repeat(40),
    reviewedHead: claimed.run.targetBranch,
    findings: [],
    dispositions: [{ id: "PROBE", disposition: "REJECTED", reason: "placeholder" }],
    mustFixIds: [],
  });
  const incomplete = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind: "must-fix",
      body: stub,
      commitSha: claimed.run.targetBranch,
      metadata: { phase: "closed-must-fix" },
    }),
  });
  assert.equal(incomplete.status, 409);
  assert.match(await incomplete.text(), /missing: OPUS-1/u);
  const stillUnlocked = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: blind.run.taskId! } });
  assert.deepEqual(stillUnlocked.metadata, { phase: "predecessor-evidence-unlocked" });
  assert.equal(stillUnlocked.body, independentBody);

  const wrongMustFix = JSON.stringify({
    schemaVersion: 1,
    headSha: claimed.run.targetBranch,
    reviewedBase: "b".repeat(40),
    reviewedHead: claimed.run.targetBranch,
    findings: [independentFinding],
    dispositions: [{ id: independentFinding.id, disposition: "ADOPTED", reason: "verified" }],
    mustFixIds: [],
  });
  const inconsistent = await createApp(db).request(`/session/runs/${blind.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claimed.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: claimed.fencingToken,
      kind: "must-fix",
      body: wrongMustFix,
      commitSha: claimed.run.targetBranch,
      metadata: { phase: "closed-must-fix" },
    }),
  });
  assert.equal(inconsistent.status, 409);
  assert.match(await inconsistent.text(), /mustFixIds must exactly equal final P0\/P1 finding ids/u);
  assert.deepEqual(
    (await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: blind.run.taskId! } })).metadata,
    { phase: "predecessor-evidence-unlocked" },
  );
});

test("operator retry re-resolves a pinned step to the recorded implementation commit", async () => {
  const { template, repo } = await seedCanonicalTemplate();
  const blind = await queueCanonicalStep(template, repo.id, 7);
  await db.run.update({ where: { id: blind.run.id }, data: { status: "FAILED" } });

  const retried = await createApp(db).request(`/tasks/${blind.run.taskId}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  assert.equal(retried.status, 201);
  const body = await retried.json() as { targetBranch: string; branch: string | null };
  assert.equal(body.targetBranch, "5".padStart(40, "0"));
  assert.notEqual(body.targetBranch, body.branch, "a pinned retry must not use the chain branch as its base");
});
