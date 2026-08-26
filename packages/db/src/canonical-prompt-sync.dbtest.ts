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

import { isMergeReadinessStep } from "./merge-tail.js";
import { isIntegratorStep } from "./merge-integrator.js";

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

const snapshotInstantiatedTasks = async (taskIds: string[]) => {
  const rows = await prisma.task.findMany({
    where: { id: { in: taskIds } },
    include: { runs: true, sessions: true },
    orderBy: { id: "asc" },
  });
  return JSON.stringify(rows);
};

test("sync rolls the exact old graphs forward without touching instantiated evidence", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const agents = new Map((await prisma.agent.findMany({ where: { projectId: project.id } })).map((agent) => [agent.name, agent]));
  const source = agents.get("review-coordinator-opus")!;
  const adjudicator = agents.get("review-adjudicator-opus")!;
  const copiedEnvironment = await prisma.environment.create({
    data: { projectId: project.id, name: "canonical-sync-adjudicator-source", networking: "OPEN", allowedHosts: [] },
  });
  const repo = await prisma.repo.create({
    data: { projectId: project.id, name: "canonical-sync-adjudicator-repo", remoteUrl: "https://github.com/acme/adjudicator.git", mountPath: "/repo" },
  });
  await prisma.agent.update({ where: { id: source.id }, data: { environmentId: copiedEnvironment.id, disabledTools: ["task_output", "inbox_ask"] } });
  await prisma.agentRepoAccess.create({ data: {
    projectId: project.id, agentId: source.id, repoId: repo.id, mountPath: "/review", permissions: "GIT_READ",
  } });
  await prisma.agent.delete({ where: { id: adjudicator.id } });

  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: ["direct-engineer-workflow", "compound-engineer-workflow"] } },
    include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
  });
  const taskIds: string[] = [];
  const stepIds: string[] = [];
  for (const template of templates) {
    const removeIndex = template.name === "direct-engineer-workflow" ? 8 : 13;
    await prisma.taskTemplateStep.delete({ where: { taskTemplateId_stepIndex: { taskTemplateId: template.id, stepIndex: removeIndex } } });
    const updates = template.name === "direct-engineer-workflow"
      ? [
        [3, "review-coordinator-opus", "must-fix", false, 1], [4, "senior-dev", "fixed-implementation", true, null],
        [5, "regression-verifier", "regression-verification", true, null], [6, "review-coordinator", "merge-authorization", true, null],
        [7, "merge-integrator", "merge-result", true, null],
      ] as const
      : [
        [7, "review-coordinator-opus", "must-fix", false, 5], [8, "senior-dev", "fixed-implementation", true, null],
        [9, "regression-verifier", "regression-verification", true, null], [10, "librarian", "documentation", true, null],
        [11, "review-coordinator", "merge-authorization", true, null], [12, "merge-integrator", "merge-result", true, null],
      ] as const;
    for (const [stepIndex, agentName, outputKind, attachmentsFromPrevious, baseFromStepIndex] of updates) {
      const step = template.steps.find((candidate) => candidate.stepIndex === stepIndex)!;
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: {
        assigneeAgentId: agents.get(agentName)!.id,
        outputKind,
        attachmentsFromPrevious,
        baseFromStepIndex,
      } });
    }
    const oldSteps = await prisma.taskTemplateStep.findMany({ where: { taskTemplateId: template.id }, orderBy: { stepIndex: "asc" } });
    for (const [index, step] of oldSteps.entries()) {
      await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { layer: index + 1 } });
      stepIds.push(step.id);
      // Keep the later routing-adoption regression isolated: this test owns
      // the template-row preservation proof, so its historical evidence must
      // not hold a foreign key that would prevent the separate Agent-copy
      // fixture from removing the old verifier row.
      const taskAssigneeId = step.assigneeAgentId === agents.get("regression-verifier")?.id ? source.id : step.assigneeAgentId;
      const task = await prisma.task.create({ data: {
        projectId: project.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `legacy-${template.name}-${step.stepIndex}`,
        description: `operator-owned description ${template.name} ${step.stepIndex}`,
        assigneeAgentId: taskAssigneeId,
        assigneeType: step.assigneeType,
        status: index % 2 === 0 ? TaskStatus.TODO : TaskStatus.DONE,
      } });
      taskIds.push(task.id);
      if (index === 0) {
        const run = await prisma.run.create({ data: {
          projectId: project.id, taskId: task.id, agentId: taskAssigneeId!, runNumber: 1,
          dedupeKey: `canonical-sync-legacy:${task.id}`, runner: "CODEX", model: agents.get(step.assigneeAgentId === source.id ? source.name : "default")?.model ?? "gpt-5.6-sol:medium", promptHash: "legacy-snapshot",
        } });
        await prisma.session.create({ data: {
          runId: run.id, projectId: project.id, agentId: taskAssigneeId!, taskId: task.id, runner: "CODEX",
        } });
      }
    }
  }
  const beforeTasks = await snapshotInstantiatedTasks(taskIds);
  const beforeSteps = JSON.stringify(await prisma.taskTemplateStep.findMany({ where: { id: { in: stepIds } }, orderBy: { id: "asc" } }));

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);

  const afterTasks = await snapshotInstantiatedTasks(taskIds);
  const afterSteps = JSON.stringify(await prisma.taskTemplateStep.findMany({ where: { id: { in: stepIds } }, orderBy: { id: "asc" } }));
  assert.equal(afterTasks, beforeTasks);
  assert.equal(afterSteps, beforeSteps);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: "direct-engineer-workflow-legacy-v1" } }), 1);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: "compound-engineer-workflow-legacy-v1" } }), 1);
  const direct = await prisma.taskTemplate.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } }, include: { steps: { orderBy: { stepIndex: "asc" } } } });
  const full = await prisma.taskTemplate.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } }, include: { steps: { orderBy: { stepIndex: "asc" } } } });
  assert.deepEqual(direct.steps.map(({ layer }) => layer), [1, 2, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(full.steps.map(({ layer }) => layer), [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 12]);

  const legacyDirect = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow-legacy-v1" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const legacyFull = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow-legacy-v1" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  for (const [legacyTemplate, readinessIndex, integratorIndex] of [
    [legacyDirect, 6, 7],
    [legacyFull, 11, 12],
  ] as const) {
    const readiness = legacyTemplate.steps.find(({ stepIndex }) => stepIndex === readinessIndex)!;
    const integrator = legacyTemplate.steps.find(({ stepIndex }) => stepIndex === integratorIndex)!;
    assert.equal(isMergeReadinessStep({
      stepIndex: readiness.stepIndex,
      outputKind: readiness.outputKind,
      taskTemplateName: legacyTemplate.name,
    }), true);
    assert.equal(isIntegratorStep({
      stepIndex: integrator.stepIndex,
      outputKind: integrator.outputKind,
      taskTemplate: { name: legacyTemplate.name },
    }), true);
  }

  const copied = await prisma.agent.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: "review-adjudicator-opus" } } });
  assert.equal(copied.environmentId, copiedEnvironment.id);
  assert.deepEqual(copied.disabledTools, ["task_output", "inbox_ask"]);
  assert.equal(await prisma.agentRepoAccess.count({ where: { agentId: copied.id, repoId: repo.id, mountPath: "/review", permissions: "GIT_READ" } }), 1);

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: "direct-engineer-workflow-legacy-v1" } }), 1);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: "compound-engineer-workflow-legacy-v1" } }), 1);
});

test("sync upgrades only the exact frozen-base review agent defaults", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const names = ["review-coordinator", "review-coordinator-sol"];
  const frozenBase = { model: "openai-codex/gpt-5.6-sol:high", runnerPreference: RunnerPreference.PI };
  const frozenSolBase = { model: "openai-codex/gpt-5.6-sol:high", runnerPreference: RunnerPreference.PI };

  await prisma.agent.updateMany({ where: { projectId: project.id, name: "review-coordinator" }, data: frozenBase });
  await prisma.agent.updateMany({ where: { projectId: project.id, name: "review-coordinator-sol" }, data: frozenSolBase });
  await prisma.agent.updateMany({
    where: { projectId: project.id, name: "review-coordinator" },
    data: { title: "Unrelated drift" },
  });

  const rejected = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(rejected.status, 0, rejected.output);
  assert.match(rejected.output, /Agent review-coordinator .* differs from canonical Markdown structure: title/u);
  const rolledBack = await prisma.agent.findMany({
    where: { projectId: project.id, name: { in: names } },
    select: { name: true, model: true, runnerPreference: true },
  });
  assert.equal(rolledBack.length, 2);
  assert.ok(rolledBack.every((agent) => (agent.name === "review-coordinator"
    ? agent.model === frozenBase.model && agent.runnerPreference === frozenBase.runnerPreference
    : agent.model === frozenSolBase.model && agent.runnerPreference === frozenSolBase.runnerPreference)));

  await prisma.agent.updateMany({
    where: { projectId: project.id, name: "review-coordinator" },
    data: { title: "Review Coordinator" },
  });
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":2/u);

  const upgraded = await prisma.agent.findMany({
    where: { projectId: project.id, name: { in: names } },
    select: { name: true, model: true, runnerPreference: true },
  });
  assert.equal(upgraded.length, 2);
  assert.ok(upgraded.every((agent) => agent.runnerPreference === RunnerPreference.PI
    && agent.model === "openai-codex/gpt-5.6-sol:xhigh"));
});

test("sync adopts the exact model-only executioner transition", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  await prisma.agent.update({
    where: { projectId_name: { projectId: project.id, name: "implementation-plan-executioner" } },
    data: {
      model: "gpt-5.6-sol:medium",
      runnerPreference: RunnerPreference.CODEX,
      runtimeConfigCustomized: false,
    },
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":1/u);

  const executioner = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "implementation-plan-executioner" } },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true },
  });
  assert.deepEqual(executioner, {
    model: "gpt-5.6-sol:high",
    runnerPreference: RunnerPreference.CODEX,
    runtimeConfigCustomized: false,
  });
});

test("sync preserves an operator-selected model and runner", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  await prisma.agent.update({
    where: { projectId_name: { projectId: project.id, name: "spec" } },
    data: { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE, runtimeConfigCustomized: true },
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"preservedAgentOverrides":0/u);

  const spec = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "spec" } },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true },
  });
  assert.deepEqual(spec, {
    model: "claude-opus-5:medium",
    runnerPreference: RunnerPreference.CLAUDE,
    runtimeConfigCustomized: true,
  });
});

test("sync recreates a missing regression verifier and restores canonical bindings", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "review-coordinator-sol" } },
  });
  const existingVerifier = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier" } },
  });
  const regressionSteps = await prisma.taskTemplateStep.findMany({
    where: {
      outputKind: "regression-verification",
      taskTemplate: { projectId: project.id },
    },
    select: { id: true, taskTemplate: { select: { name: true } } },
  });
  await prisma.taskTemplateStep.updateMany({
    where: { id: { in: regressionSteps.map(({ id }) => id) } },
    data: { assigneeAgentId: source.id },
  });
  await prisma.agent.delete({ where: { id: existingVerifier.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdAgents":1/u);
  assert.match(synced.output, /"adoptedAssignees":2/u);

  const verifier = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier" } },
  });
  assert.equal(verifier.model, "claude-opus-5:medium");
  assert.equal(verifier.runnerPreference, RunnerPreference.CLAUDE);
  assert.equal(verifier.inboxAccess, false);
  const canonicalSteps = regressionSteps.filter(({ taskTemplate }) =>
    taskTemplate.name === "compound-engineer-workflow" || taskTemplate.name === "direct-engineer-workflow");
  assert.equal(await prisma.taskTemplateStep.count({
    where: { id: { in: canonicalSteps.map(({ id }) => id) }, assigneeAgentId: verifier.id },
  }), 2);
});

test("sync refuses canonical step drift when instantiated tasks would be mutated", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "review-coordinator-sol" } },
  });
  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
  });
  const step = await prisma.taskTemplateStep.findFirstOrThrow({
    where: { taskTemplateId: template.id, outputKind: "regression-verification" },
  });
  await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { assigneeAgentId: source.id } });
  const task = await prisma.task.create({ data: {
    projectId: project.id,
    templateId: template.id,
    templateStepId: step.id,
    name: "referenced regression",
    description: "operator-owned evidence",
    assigneeAgentId: source.id,
    assigneeType: "AGENT",
    status: TaskStatus.TODO,
  } });
  const refused = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /referenced by instantiated tasks/u);
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: step.id } })).assigneeAgentId, source.id);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).description, "operator-owned evidence");
  const canonicalRegression = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier" } },
    select: { id: true },
  });
  await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { assigneeAgentId: canonicalRegression.id } });
});

test("sync upgrades only unstarted blind-review tasks with the exact legacy prompt", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const template = await prisma.taskTemplate.findFirstOrThrow({
    where: { projectId: project.id, name: "direct-engineer-workflow" },
  });
  const step = await prisma.taskTemplateStep.findFirstOrThrow({
    where: { taskTemplateId: template.id, outputKind: "must-fix" },
  });
  const agent = await prisma.agent.findUniqueOrThrow({
    where: { id: step.assigneeAgentId! },
  });
  const repo = await prisma.repo.findFirstOrThrow({ where: { projectId: project.id } });
  const legacyPrompt = "Blind-review the complete integrated implementation diff using the immutable implementationBaseSha and implementationHeadSha in the platform-pinned claim metadata; verify both endpoints resolve in this detached checkout. Persist your independent findings as an intermediate AgentOS task output before reading the first review. The successful task_output response unlocks predecessor step outputs; only then read them, apply the canonical merge matrix, and replace the intermediate output with the closed must-fix list. Do not write or commit any review report file.";
  const suffix = "\nFeature brief:\nKeep this exact feature brief.\nPersist the final must-fix output for this step through the AgentOS task output endpoint.";
  const makeTask = (name: string, description = `${legacyPrompt}${suffix}`) => prisma.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    templateId: template.id,
    templateStepId: step.id,
    name,
    description,
    assigneeAgentId: agent.id,
    assigneeType: "AGENT",
    status: TaskStatus.TODO,
  } });
  const eligible = await makeTask("Eligible blind review");
  const started = await makeTask("Started blind review");
  await prisma.run.create({ data: {
    projectId: project.id,
    taskId: started.id,
    agentId: agent.id,
    repoId: repo.id,
    runNumber: 1,
    dedupeKey: `task:${started.id}:run:1`,
    runner: "CLAUDE",
    model: agent.model,
    promptHash: "started-blind-review",
  } });
  const operatorEdited = await makeTask("Operator-edited blind review", `Operator-owned prefix${suffix}`);

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"migratedTaskPrompts":1/u);
  assert.match(synced.output, /"preservedBlindReviewPrompts":\{[^}]*"started":1/u);

  const migrated = await prisma.task.findUniqueOrThrow({ where: { id: eligible.id } });
  assert.equal(migrated.description, `${step.prompt}${suffix}`);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: started.id } })).description, `${legacyPrompt}${suffix}`);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: operatorEdited.id } })).description, `Operator-owned prefix${suffix}`);
  assert.equal(await prisma.taskActivity.count({
    where: { taskId: eligible.id, metadata: { path: ["kind"], equals: "canonicalTaskPrompt.blindReviewOutputV1" } },
  }), 1);

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"migratedTaskPrompts":0/u);
  assert.equal(await prisma.taskActivity.count({
    where: { taskId: eligible.id, metadata: { path: ["kind"], equals: "canonicalTaskPrompt.blindReviewOutputV1" } },
  }), 1);
});

test("sync refuses a seven-step canonical shape with structural drift before mutation", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
  });
  const step = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: template.id, stepIndex: 7 } },
  });
  await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { outputKind: "drifted-output" } });
  const beforeLegacyCount = await prisma.taskTemplate.count({ where: { projectId: project.id, name: "direct-engineer-workflow-legacy-v1" } });
  const refused = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /direct-engineer-workflow step 7 .* differs from canonical Markdown structure/u);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: "direct-engineer-workflow-legacy-v1" } }), beforeLegacyCount);
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: step.id } })).outputKind, "drifted-output");
});
