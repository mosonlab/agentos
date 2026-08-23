/**
 * The canonical prompt sync's frozen-base agent transition against PostgreSQL.
 *
 * Requires a scratch server. It creates and drops its own schema and never
 * touches an existing one.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @agentos/db
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { PrismaClient, RunnerPreference, TaskStatus } from "@prisma/client";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const schema = `canonical_prompt_sync_${randomBytes(4).toString("hex")}`;
const databaseUrl = (() => {
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return url.href;
})();
const command = (args: string[]) => {
  const result = spawnSync("npx", args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

let prisma: PrismaClient;

before(async () => {
  const migrated = command(["prisma", "migrate", "deploy"]);
  assert.equal(migrated.status, 0, migrated.output);
  const seeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(seeded.status, 0, seeded.output);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
});

after(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  try {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.$disconnect();
  }
});

test("sync upgrades only the exact frozen-base review agent defaults", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const names = ["review-coordinator", "review-coordinator-sol"];
  const frozenBase = { model: "gpt-5.6-sol:high", runnerPreference: RunnerPreference.CODEX };

  await prisma.agent.updateMany({ where: { projectId: project.id, name: { in: names } }, data: frozenBase });
  await prisma.agent.updateMany({
    where: { projectId: project.id, name: "review-coordinator" },
    data: { title: "Unrelated drift" },
  });

  const rejected = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(rejected.status, 0, rejected.output);
  assert.match(rejected.output, /Agent review-coordinator .* differs from canonical Markdown structure: title, model, runnerPreference/u);
  const rolledBack = await prisma.agent.findMany({
    where: { projectId: project.id, name: { in: names } },
    select: { model: true, runnerPreference: true },
  });
  assert.equal(rolledBack.length, 2);
  assert.ok(rolledBack.every((agent) => agent.model === frozenBase.model
    && agent.runnerPreference === frozenBase.runnerPreference));

  await prisma.agent.updateMany({
    where: { projectId: project.id, name: "review-coordinator" },
    data: { title: "Review Coordinator" },
  });
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":2/u);

  const upgraded = await prisma.agent.findMany({
    where: { projectId: project.id, name: { in: names } },
    select: { model: true, runnerPreference: true },
  });
  assert.equal(upgraded.length, 2);
  assert.ok(upgraded.every((agent) => agent.model === "openai-codex/gpt-5.6-sol:high"
    && agent.runnerPreference === RunnerPreference.PI));
});

test("sync creates the narrow verifier and migrates only never-run TODO regression tasks", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "review-coordinator-sol" } },
  });
  const existingVerifier = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier" } },
  });
  const repo = await prisma.repo.create({ data: {
    projectId: project.id,
    name: "canonical-sync-repo",
    remoteUrl: "https://github.com/acme/canonical-sync.git",
    mountPath: "/repo",
  } });
  await prisma.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: source.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: ["compound-engineer-workflow", "direct-engineer-workflow"] } },
    select: { id: true, name: true },
  });
  const templateIds = templates.map(({ id }) => id);
  const regressionSteps = await prisma.taskTemplateStep.findMany({
    where: { taskTemplateId: { in: templateIds }, outputKind: "regression-verification" },
  });
  assert.equal(regressionSteps.length, 2);
  await prisma.taskTemplateStep.updateMany({
    where: { id: { in: regressionSteps.map(({ id }) => id) } },
    data: { assigneeAgentId: source.id },
  });
  const reviewSteps = await prisma.taskTemplateStep.findMany({
    where: { taskTemplateId: { in: templateIds }, outputKind: "sol-findings" },
    select: { id: true },
  });
  assert.equal(reviewSteps.length, 2);
  await prisma.taskTemplateStep.updateMany({
    where: { id: { in: reviewSteps.map(({ id }) => id) } },
    data: { baseFromStepIndex: null },
  });
  const readinessSteps = await prisma.taskTemplateStep.findMany({
    where: { taskTemplateId: { in: templateIds }, outputKind: "merge-authorization" },
    select: { id: true },
  });
  await prisma.taskTemplateStep.updateMany({
    where: { id: { in: readinessSteps.map(({ id }) => id) } },
    data: { name: "Merge readiness" },
  });

  const direct = templates.find(({ name }) => name === "direct-engineer-workflow")!;
  const directRegression = regressionSteps.find(({ taskTemplateId }) => taskTemplateId === direct.id)!;
  const makeTask = (name: string) => prisma.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    templateId: direct.id,
    templateStepId: directRegression.id,
    name,
    description: "verify",
    assigneeAgentId: source.id,
    assigneeType: "AGENT",
    status: TaskStatus.TODO,
  } });
  const eligible = await makeTask("Eligible regression");
  const started = await makeTask("Started regression");
  await prisma.run.create({ data: {
    projectId: project.id,
    taskId: started.id,
    agentId: source.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${started.id}:run:1`,
    runner: "PI",
    model: source.model,
    promptHash: "started",
  } });
  const outputBound = await makeTask("Output-bound regression");
  await prisma.taskStepOutput.create({ data: {
    taskId: outputBound.id,
    kind: "regression-verification",
    body: "legacy evidence",
  } });

  await prisma.agent.delete({ where: { id: existingVerifier.id } });
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdAgents":1/u);
  assert.match(synced.output, /"createdAgentRepoGrants":1/u);
  assert.match(synced.output, /"adoptedAssignees":2/u);
  assert.match(synced.output, /"adoptedStepBases":2/u);
  assert.match(synced.output, /"renamedSteps":2/u);
  assert.match(synced.output, /"migratedTasks":1/u);
  assert.match(synced.output, /"started":1/u);
  assert.match(synced.output, /"output":1/u);

  const verifier = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier" } },
  });
  assert.equal(verifier.model, "openai-codex/gpt-5.6-sol:medium");
  assert.equal(verifier.runnerPreference, RunnerPreference.PI);
  assert.equal(verifier.inboxAccess, false);
  assert.equal(await prisma.agentRepoAccess.count({ where: { agentId: verifier.id, repoId: repo.id } }), 1);
  assert.equal(await prisma.taskTemplateStep.count({
    where: { id: { in: regressionSteps.map(({ id }) => id) }, assigneeAgentId: verifier.id },
  }), 2);
  assert.equal(await prisma.taskTemplateStep.count({
    where: {
      OR: [
        { taskTemplateId: templates.find(({ name }) => name === "compound-engineer-workflow")!.id, stepIndex: 6, baseFromStepIndex: 5 },
        { taskTemplateId: direct.id, stepIndex: 2, baseFromStepIndex: 1 },
      ],
    },
  }), 2);
  assert.equal(await prisma.taskTemplateStep.count({
    where: { id: { in: readinessSteps.map(({ id }) => id) }, name: "Merge authorization" },
  }), 2);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: eligible.id } })).assigneeAgentId, verifier.id);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: started.id } })).assigneeAgentId, source.id);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: outputBound.id } })).assigneeAgentId, source.id);
  assert.equal(await prisma.taskActivity.count({
    where: { taskId: eligible.id, metadata: { path: ["kind"], equals: "canonicalRouting.regressionVerifier" } },
  }), 1);
});
