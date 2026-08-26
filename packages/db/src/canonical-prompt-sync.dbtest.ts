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

/**
 * The graph that preceded the adjudication node's removal, expressed as the
 * single step this sync deletes. The fixture reopens that hole so the row on
 * disk is the exact adjudication-era graph the transition table enumerates.
 */
const ADJUDICATION_STEPS = {
  "direct-engineer-workflow": { stepIndex: 4, layer: 3, baseFromStepIndex: 1 },
  "compound-engineer-workflow": { stepIndex: 8, layer: 7, baseFromStepIndex: 5 },
} as const;

test("sync rolls the exact adjudication-era graphs forward without touching instantiated evidence", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const agents = new Map((await prisma.agent.findMany({ where: { projectId: project.id } })).map((agent) => [agent.name, agent]));
  const source = agents.get("review-coordinator-opus")!;
  const adjudicator = await prisma.agent.create({ data: {
    projectId: project.id,
    environmentId: source.environmentId,
    name: "review-adjudicator-opus",
    title: "Review Adjudicator (Opus)",
    model: source.model,
    foundationalPrompt: source.foundationalPrompt,
    rolePrompt: source.rolePrompt,
    runnerPreference: source.runnerPreference,
  } });

  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: ["direct-engineer-workflow", "compound-engineer-workflow"] } },
    include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
  });
  const taskIds: string[] = [];
  const stepIds: string[] = [];
  const legacyNames = new Map<string, string>();
  for (const template of templates) {
    legacyNames.set(template.name, `${template.name}-legacy-pre-adjudication-${template.id}`);
    const adjudication = ADJUDICATION_STEPS[template.name as keyof typeof ADJUDICATION_STEPS];
    // Walk down so the (template, stepIndex) unique never collides while the
    // hole opens; every step the adjudication node preceded also sat one layer
    // later than it does now.
    for (const step of [...template.steps].reverse()) {
      if (step.stepIndex < adjudication.stepIndex) continue;
      await prisma.taskTemplateStep.update({
        where: { id: step.id },
        data: { stepIndex: step.stepIndex + 1, layer: step.layer + 1 },
      });
    }
    await prisma.taskTemplateStep.create({ data: {
      taskTemplateId: template.id,
      stepIndex: adjudication.stepIndex,
      layer: adjudication.layer,
      name: "Opus adjudication",
      assigneeAgentId: adjudicator.id,
      assigneeType: "AGENT",
      approvalGate: false,
      outputKind: "must-fix",
      attachmentsFromPrevious: true,
      opensPullRequest: false,
      baseFromStepIndex: adjudication.baseFromStepIndex,
      prompt: `Adjudicate the two review reports for ${template.name}.`,
    } });
    // The adjudication-era compound graph still gated its spec and revise-plan
    // steps; the zero-gate transition removed those gates from the sources this
    // fixture derives from, so it restores them to land on the exact
    // enumerated historical shape.
    if (template.name === "compound-engineer-workflow") {
      await prisma.taskTemplateStep.updateMany({
        where: { taskTemplateId: template.id, stepIndex: { in: [1, 4] } },
        data: { approvalGate: true },
      });
    }

    const oldSteps = await prisma.taskTemplateStep.findMany({ where: { taskTemplateId: template.id }, orderBy: { stepIndex: "asc" } });
    for (const [index, step] of oldSteps.entries()) {
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
        // Finished: the rollover guard refuses to rename a row whose chains are
        // still running, and that refusal is proved separately. This test owns
        // the proof that a rollover leaves finished evidence byte-identical.
        status: TaskStatus.DONE,
      } });
      taskIds.push(task.id);
      if (index === 0) {
        const run = await prisma.run.create({ data: {
          projectId: project.id, taskId: task.id, agentId: taskAssigneeId!, runNumber: 1,
          dedupeKey: `canonical-sync-legacy:${task.id}`, runner: "CODEX", model: agents.get("default")?.model ?? "gpt-5.6-sol:medium", promptHash: "legacy-snapshot",
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
  for (const legacyName of legacyNames.values()) {
    assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: legacyName } }), 1);
  }
  const direct = await prisma.taskTemplate.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } }, include: { steps: { orderBy: { stepIndex: "asc" } } } });
  const full = await prisma.taskTemplate.findUniqueOrThrow({ where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } }, include: { steps: { orderBy: { stepIndex: "asc" } } } });
  assert.deepEqual(direct.steps.map(({ layer }) => layer), [1, 2, 2, 3, 4, 5, 6]);
  assert.deepEqual(full.steps.map(({ layer }) => layer), [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11]);

  const legacyDirect = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: legacyNames.get("direct-engineer-workflow")! } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const legacyFull = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: legacyNames.get("compound-engineer-workflow")! } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  for (const [legacyTemplate, readinessIndex, integratorIndex] of [
    [legacyDirect, 7, 8],
    [legacyFull, 12, 13],
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

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  for (const legacyName of legacyNames.values()) {
    assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: legacyName } }), 1);
  }
});

test("sync rolls the pre-zero-gate compound graph forward and leaves the direct row in place", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const full = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
    select: { id: true },
  });
  const directBefore = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
    select: { id: true },
  });
  // Regate spec and revise-plan: that is exactly the graph that preceded the
  // zero-gate transition, and nothing else about it moved.
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: full.id, stepIndex: { in: [1, 4] } },
    data: { approvalGate: true },
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);

  const legacyName = `compound-engineer-workflow-legacy-pre-zero-gate-${full.id}`;
  const legacy = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: legacyName } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.equal(legacy.id, full.id);
  const fresh = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  assert.notEqual(fresh.id, full.id);
  assert.deepEqual(fresh.steps.map(({ approvalGate }) => approvalGate), Array.from({ length: 12 }, () => false));
  // The regated ordinals are frozen with the renamed row, and its merge tail
  // stays recognized at the ordinals it was created under.
  assert.deepEqual(legacy.steps.filter(({ approvalGate }) => approvalGate).map(({ stepIndex }) => stepIndex), [1, 4]);
  const readiness = legacy.steps.find(({ stepIndex }) => stepIndex === 11)!;
  const integrator = legacy.steps.find(({ stepIndex }) => stepIndex === 12)!;
  assert.equal(isMergeReadinessStep({
    stepIndex: readiness.stepIndex,
    outputKind: readiness.outputKind,
    taskTemplateName: legacyName,
  }), true);
  assert.equal(isIntegratorStep({
    stepIndex: integrator.stepIndex,
    outputKind: integrator.outputKind,
    taskTemplate: { name: legacyName },
  }), true);
  // The direct graph did not change in this transition, so its row is updated
  // in place rather than rolled over.
  const directAfter = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
    select: { id: true },
  });
  assert.equal(directAfter.id, directBefore.id);
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

test("sync refuses a seven-step canonical shape with structural drift before mutation", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "direct-engineer-workflow" } },
  });
  const step = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: template.id, stepIndex: 7 } },
  });
  await prisma.taskTemplateStep.update({ where: { id: step.id }, data: { outputKind: "drifted-output" } });
  const beforeLegacyCount = await prisma.taskTemplate.count({ where: { projectId: project.id, name: { startsWith: "direct-engineer-workflow-legacy" } } });
  const refused = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /direct-engineer-workflow step 7 .* differs from canonical Markdown structure/u);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: { startsWith: "direct-engineer-workflow-legacy" } } }), beforeLegacyCount);
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: step.id } })).outputKind, "drifted-output");
});
