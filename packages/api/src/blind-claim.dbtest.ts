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
  });
  await db.run.deleteMany({ where: { taskId: { in: chain.tasks.map((task) => task.id) } } });
  const priorTasks = chain.tasks.filter((task) => task.chainIndex !== null && task.chainIndex < stepIndex);
  await db.task.updateMany({
    where: { id: { in: priorTasks.map((task) => task.id) } },
    data: { status: "DONE" },
  });
  await db.taskStepOutput.createMany({ data: priorTasks.map((task) => ({
    taskId: task.id,
    kind: `step-${task.chainIndex}`,
    body: `persisted output from step ${task.chainIndex}`,
  })) });
  const target = chain.tasks.find((task) => task.chainIndex === stepIndex);
  assert.ok(target, `canonical step ${stepIndex} must exist`);
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
  return response.json() as Promise<{ run: { id: string }; priorOutputs: Array<{ body: string }> }>;
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
});
