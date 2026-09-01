/**
 * The canonical prompt sync's canonical runtime adoption against PostgreSQL.
 *
 * Requires a scratch server. It creates and drops its own schema and never
 * touches an existing one.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @anneal/db
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { Prisma, PrismaClient, RepoPermission, RunnerPreference, TaskStatus } from "@prisma/client";

import { loadAgentSources } from "./agent-sources.js";
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

type CanonicalRuntime = { model: string; runnerPreference: RunnerPreference };

let prisma: PrismaClient;
let canonicalRuntimes: Map<string, CanonicalRuntime>;

const canonicalRuntime = (name: string): CanonicalRuntime => {
  const runtime = canonicalRuntimes.get(name);
  assert.ok(runtime, `role source must contain ${name}`);
  return runtime;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const runtimeAdoptionPattern = (
  name: string,
  from: CanonicalRuntime,
  to: CanonicalRuntime,
): RegExp => new RegExp(
  `Canonical runtime config adopted for Agent ${escapeRegex(name)}: `
  + `from model=${escapeRegex(from.model)}, runnerPreference=${from.runnerPreference} `
  + `to model=${escapeRegex(to.model)}, runnerPreference=${to.runnerPreference}`,
  "u",
);

before(async () => {
  canonicalRuntimes = new Map((await loadAgentSources()).roles.map((role) => [role.name, {
    model: role.model,
    runnerPreference: role.runnerPreference,
  }]));
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

const downgradeDirectTemplateToHistoricalSevenStep = async (projectId: string): Promise<void> => {
  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId, name: "direct-engineer-workflow" } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const revalidation = template.steps.find(({ stepIndex }) => stepIndex === 1);
  assert.equal(revalidation?.outputKind, "revalidation");
  await prisma.taskTemplateStep.delete({ where: { id: revalidation!.id } });
  for (const step of template.steps.filter(({ stepIndex }) => stepIndex > 1)) {
    await prisma.taskTemplateStep.update({
      where: { id: step.id },
      data: {
        stepIndex: step.stepIndex - 1,
        layer: step.layer - 1,
        baseFromStepIndex: step.baseFromStepIndex === null ? null : step.baseFromStepIndex - 1,
      },
    });
  }
};

test("sync creates the pull-request template when the pre-existing canonical installation has none", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const preExistingTemplateSnapshot = JSON.stringify(await prisma.taskTemplate.findMany({
    where: {
      projectId: project.id,
      name: { in: ["compound-engineer-workflow", "direct-engineer-workflow"] },
    },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  }));
  const existing = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "pr-engineer-workflow" } },
  });
  await prisma.taskTemplate.delete({ where: { id: existing.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":1/u);

  const created = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "pr-engineer-workflow" } },
    include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
  });
  assert.deepEqual(created.variables, ["branchName"]);
  assert.deepEqual(created.steps.map(({ assigneeAgent }) => assigneeAgent?.name), [
    "senior-dev-luna", "review-coordinator-sol", "review-coordinator-opus", "senior-dev",
  ]);
  assert.equal(JSON.stringify(await prisma.taskTemplate.findMany({
    where: {
      projectId: project.id,
      name: { in: ["compound-engineer-workflow", "direct-engineer-workflow"] },
    },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  })), preExistingTemplateSnapshot);

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"createdCanonicalTemplates":0/u);

  const canonicalPrompt = created.steps[0]!.prompt;
  await prisma.taskTemplateStep.update({
    where: { id: created.steps[0]!.id },
    data: { prompt: "controlled PR prompt drift" },
  });
  const restored = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(restored.status, 0, restored.output);
  assert.equal(
    (await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: created.steps[0]!.id } })).prompt,
    canonicalPrompt,
  );
});

test("sync creates the canonical-project PR template when a same-name row exists elsewhere", async () => {
  const canonicalProject = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const canonicalTemplate = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: "pr-engineer-workflow" } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  const foreignProject = await prisma.project.create({
    data: { name: "Foreign PR template", slug: `foreign-pr-${randomBytes(4).toString("hex")}` },
  });
  const environment = await prisma.environment.create({
    data: { projectId: foreignProject.id, name: "local", allowedHosts: [] },
  });
  const foreignAgents = new Map<string, string>();
  for (const source of canonicalTemplate.steps.map(({ assigneeAgent }) => assigneeAgent!)) {
    if (foreignAgents.has(source.name)) continue;
    const created = await prisma.agent.create({ data: {
      projectId: foreignProject.id,
      environmentId: environment.id,
      name: source.name,
      title: source.title,
      model: source.model,
      runnerPreference: source.runnerPreference,
      inboxAccess: source.inboxAccess,
      foundationalPrompt: source.foundationalPrompt,
      rolePrompt: source.rolePrompt,
      disabledTools: source.disabledTools,
    } });
    foreignAgents.set(source.name, created.id);
  }
  const foreignTemplate = await prisma.taskTemplate.create({ data: {
    projectId: foreignProject.id,
    name: canonicalTemplate.name,
    description: canonicalTemplate.description,
    variables: canonicalTemplate.variables,
  } });
  for (const step of canonicalTemplate.steps) {
    await prisma.taskTemplateStep.create({ data: {
      taskTemplateId: foreignTemplate.id,
      stepIndex: step.stepIndex,
      layer: step.layer,
      name: step.name,
      assigneeAgentId: foreignAgents.get(step.assigneeAgent!.name)!,
      assigneeType: step.assigneeType,
      runner: step.runner,
      approvalGate: step.approvalGate,
      outputKind: step.outputKind,
      prompt: step.prompt,
      opensPullRequest: step.opensPullRequest,
      requiresCommit: step.requiresCommit,
      attachmentsFromPrevious: step.attachmentsFromPrevious,
      priorOutputKinds: step.priorOutputKinds,
      baseFromStepIndex: step.baseFromStepIndex,
      spawnPolicy: step.spawnPolicy === null ? Prisma.JsonNull : step.spawnPolicy,
    } });
  }
  await prisma.taskTemplate.delete({ where: { id: canonicalTemplate.id } });
  const foreignBefore = JSON.stringify(await prisma.taskTemplate.findUniqueOrThrow({
    where: { id: foreignTemplate.id },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  }));

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":1/u);
  await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: "pr-engineer-workflow" } },
  });
  assert.equal(JSON.stringify(await prisma.taskTemplate.findUniqueOrThrow({
    where: { id: foreignTemplate.id },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  })), foreignBefore);
  await prisma.project.delete({ where: { id: foreignProject.id } });
});

test("sync rolls the checkout Regression prompt generation once and preserves chain prompt lineage", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const templateNames = ["direct-engineer-workflow", "compound-engineer-workflow"] as const;
  const runnerResolver = '"${AGENTOS_TOOLS:?AGENTOS_TOOLS is required}/regression-verification.sh"';
  const checkoutResolver = "scripts/regression-verification.sh";
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: [...templateNames] } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  });
  assert.equal(templates.length, templateNames.length);

  const taskIds: string[] = [];
  const legacyTemplateIds: string[] = [];
  const retired = new Map<string, { templateId: string; regressionTaskId: string; prompt: string }>();
  t.after(async () => {
    await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    await prisma.taskTemplate.deleteMany({ where: { id: { in: legacyTemplateIds } } });
  });

  for (const template of templates) {
    const regression = template.steps.find(({ outputKind }) => outputKind === "regression-verification-v2");
    assert.ok(regression);
    assert.equal(regression.prompt.split(runnerResolver).length - 1, 3);
    const outgoingPrompt = regression.prompt.replaceAll(runnerResolver, checkoutResolver);
    assert.doesNotMatch(outgoingPrompt, /AGENTOS_TOOLS/u);
    await prisma.taskTemplateStep.update({ where: { id: regression.id }, data: { prompt: outgoingPrompt } });

    const chainId = `pre-runner-tools-${template.name}-${randomBytes(4).toString("hex")}`;
    let regressionTaskId = "";
    for (const step of template.steps) {
      const task = await prisma.task.create({ data: {
        projectId: project.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `retired tooling ${template.name} ${step.stepIndex}`,
        description: "prompt-generation rollover fixture",
        assigneeAgentId: step.assigneeAgentId,
        assigneeType: step.assigneeType,
        status: TaskStatus.DONE,
        chainId,
        chainIndex: step.stepIndex,
        chainLayer: step.layer,
      } });
      taskIds.push(task.id);
      if (step.id === regression.id) regressionTaskId = task.id;
    }
    assert.notEqual(regressionTaskId, "");
    retired.set(template.name, { templateId: template.id, regressionTaskId, prompt: outgoingPrompt });
  }

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":2/u);

  for (const templateName of templateNames) {
    const old = retired.get(templateName)!;
    const legacyName = `${templateName}-legacy-pre-runner-provided-regression-tooling-${old.templateId}`;
    const legacy = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: legacyName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(legacy.id, old.templateId);
    legacyTemplateIds.push(legacy.id);
    assert.equal(legacy.steps.find(({ outputKind }) => outputKind === "regression-verification-v2")?.prompt, old.prompt);
    const oldTask = await prisma.task.findUniqueOrThrow({
      where: { id: old.regressionTaskId },
      include: { templateStep: true },
    });
    assert.equal(oldTask.templateStep?.prompt, old.prompt);

    const current = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: templateName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.notEqual(current.id, old.templateId);
    const currentRegression = current.steps.find(({ outputKind }) => outputKind === "regression-verification-v2");
    assert.ok(currentRegression);
    assert.equal(currentRegression.prompt.split(runnerResolver).length - 1, 3);
    assert.doesNotMatch(currentRegression.prompt, /`scripts\/regression-verification\.sh/u);

    const newTask = await prisma.task.create({ data: {
      projectId: project.id,
      templateId: current.id,
      templateStepId: currentRegression.id,
      name: `current tooling ${templateName}`,
      description: "successor prompt fixture",
      assigneeAgentId: currentRegression.assigneeAgentId,
      assigneeType: currentRegression.assigneeType,
      status: TaskStatus.DONE,
      chainId: `runner-tools-current-${templateName}-${randomBytes(4).toString("hex")}`,
      chainIndex: currentRegression.stepIndex,
      chainLayer: currentRegression.layer,
    } });
    taskIds.push(newTask.id);
    const instantiated = await prisma.task.findUniqueOrThrow({
      where: { id: newTask.id },
      include: { templateStep: true },
    });
    assert.equal(instantiated.templateStep?.prompt, currentRegression.prompt);
  }

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"createdCanonicalTemplates":0/u);
  assert.equal(await prisma.taskTemplate.count({
    where: { projectId: project.id, name: { contains: "legacy-pre-runner-provided-regression-tooling" } },
  }), 2);
});

test("sync rolls parked and not-yet-started v1 chains forward without changing them", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  // The canonical source is now eight-step for bound chains. Reconstruct the
  // exact seven-step direct row that a pre-revalidation chain persisted so the
  // rollover proves those task and prompt rows remain untouched.
  await downgradeDirectTemplateToHistoricalSevenStep(project.id);
  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: ["direct-engineer-workflow", "compound-engineer-workflow"] } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const oldPrompt = "Acquire before fetch and emit the v1 Regression contract.";
  const legacyTaskIds: string[] = [];
  for (const template of templates) {
    await prisma.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id, outputKind: "regression-verification-v2" },
      data: { outputKind: "regression-verification", prompt: oldPrompt },
    });
    const regressionIndex = template.steps.find(({ outputKind }) => outputKind === "regression-verification-v2")!.stepIndex;
    const parked = template.name === "compound-engineer-workflow";
    const chainId = `${parked ? "parked" : "not-started"}-v1-${template.id}`;
    for (const step of template.steps) {
      const task = await prisma.task.create({ data: {
        projectId: project.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `parked-v1-${template.name}-${step.stepIndex}`,
        description: "parked v1 rollover compatibility fixture",
        assigneeAgentId: step.assigneeAgentId,
        assigneeType: step.assigneeType,
        status: !parked
          ? TaskStatus.TODO
          : step.stepIndex < regressionIndex
          ? TaskStatus.DONE
          : step.stepIndex === regressionIndex
            ? TaskStatus.BACKLOG
            : TaskStatus.TODO,
        chainId,
        chainIndex: step.stepIndex,
        chainLayer: step.layer,
      } });
      legacyTaskIds.push(task.id);
    }
  }

  const legacyBefore = await snapshotInstantiatedTasks(legacyTaskIds);
  const activeTarget = await prisma.task.findFirstOrThrow({
    where: { id: { in: legacyTaskIds }, status: TaskStatus.BACKLOG },
    include: { assigneeAgent: { select: { model: true } } },
  });
  const activeRun = await prisma.run.create({ data: {
    projectId: activeTarget.projectId,
    taskId: activeTarget.id,
    agentId: activeTarget.assigneeAgentId!,
    runNumber: 1,
    dedupeKey: `parked-v1-active:${activeTarget.id}`,
    runner: "CODEX",
    model: activeTarget.assigneeAgent!.model,
    promptHash: "parked-v1-active",
  } });

  const refusedWhileActive = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(refusedWhileActive.status, 0, refusedWhileActive.output);
  assert.match(refusedWhileActive.output, /tasks with active Runs or no chain identity/u);
  await prisma.run.delete({ where: { id: activeRun.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdCanonicalTemplates":2/u);
  assert.equal(await snapshotInstantiatedTasks(legacyTaskIds), legacyBefore);

  for (const template of templates) {
    const legacyName = `${template.name}-legacy-pre-narrow-regression-lease-${template.id}`;
    const legacy = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: legacyName } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.equal(legacy.id, template.id);
    const legacyRegression = legacy.steps.find(({ outputKind }) => outputKind === "regression-verification")!;
    assert.equal(legacyRegression.prompt, oldPrompt);
    const readiness = legacy.steps.find(({ outputKind }) => outputKind === "merge-authorization")!;
    const integrator = legacy.steps.find(({ outputKind }) => outputKind === "merge-result")!;
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

    const current = await prisma.taskTemplate.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: template.name } },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    assert.notEqual(current.id, template.id);
    const currentRegression = current.steps.find(({ outputKind }) => outputKind === "regression-verification-v2")!;
    assert.match(currentRegression.prompt, /AGENTOS_TOOLS:\?AGENTOS_TOOLS is required/u);
    assert.doesNotMatch(currentRegression.prompt, /Run `scripts\/regression-verification\.sh/u);
    assert.match(currentRegression.prompt, /script persists the one allowed v2 outcome/u);
  }

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /"createdCanonicalTemplates":0/u);
  await prisma.task.deleteMany({ where: { id: { in: legacyTaskIds } } });
});

test("sync rolls the exact adjudication-era graphs forward without touching instantiated evidence", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  // The direct adjudication generation predates the revalidation node too.
  await downgradeDirectTemplateToHistoricalSevenStep(project.id);
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
      requiresCommit: false,
      attachmentsFromPrevious: true,
      opensPullRequest: false,
      baseFromStepIndex: adjudication.baseFromStepIndex,
      prompt: `Adjudicate the two review reports for ${template.name}.`,
    } });
    await prisma.taskTemplateStep.updateMany({
      where: { taskTemplateId: template.id, outputKind: "regression-verification-v2" },
      data: { outputKind: "regression-verification" },
    });
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
  assert.deepEqual(direct.steps.map(({ layer }) => layer), [1, 2, 3, 3, 4, 5, 6, 7]);
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
  await prisma.taskTemplateStep.updateMany({
    where: { taskTemplateId: full.id, outputKind: "regression-verification-v2" },
    data: { outputKind: "regression-verification" },
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

test("sync adopts any uncustomized canonical runtime drift", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const names = ["review-coordinator", "review-coordinator-sol"];
  const driftedCoordinator = { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE };
  const driftedSol = { model: "gpt-5.6-sol:medium", runnerPreference: RunnerPreference.CODEX };
  const coordinatorSource = canonicalRuntime("review-coordinator");
  const solSource = canonicalRuntime("review-coordinator-sol");

  await prisma.agent.updateMany({ where: { projectId: project.id, name: "review-coordinator" }, data: driftedCoordinator });
  await prisma.agent.updateMany({ where: { projectId: project.id, name: "review-coordinator-sol" }, data: driftedSol });
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
    ? agent.model === driftedCoordinator.model && agent.runnerPreference === driftedCoordinator.runnerPreference
    : agent.model === driftedSol.model && agent.runnerPreference === driftedSol.runnerPreference)));

  await prisma.agent.updateMany({
    where: { projectId: project.id, name: "review-coordinator" },
    data: { title: "Review Coordinator" },
  });
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":2/u);
  assert.match(synced.output, runtimeAdoptionPattern("review-coordinator", driftedCoordinator, coordinatorSource));
  assert.match(synced.output, runtimeAdoptionPattern("review-coordinator-sol", driftedSol, solSource));

  const upgraded = await prisma.agent.findMany({
    where: { projectId: project.id, name: { in: names } },
    select: { name: true, model: true, runnerPreference: true },
  });
  assert.equal(upgraded.length, 2);
  assert.ok(upgraded.every((agent) => {
    const source = canonicalRuntime(agent.name);
    return agent.model === source.model && agent.runnerPreference === source.runnerPreference;
  }));
});

test("sync adopts uncustomized model-only runtime drift", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const executionerSource = canonicalRuntime("implementation-plan-executioner");
  await prisma.agent.update({
    where: { projectId_name: { projectId: project.id, name: "implementation-plan-executioner" } },
    data: {
      model: "gpt-5.6-sol:medium",
      runnerPreference: RunnerPreference.CODEX,
      runtimeConfigCustomized: false,
      runtimeConfigDriftNoticeFingerprint: "stale-runtime-drift",
    },
  });
  const driftNoticeCountBefore = await prisma.inboxMessage.count({
    where: { body: { startsWith: "Canonical runtime drift detected" } },
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":1/u);

  const executioner = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "implementation-plan-executioner" } },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true, runtimeConfigDriftNoticeFingerprint: true },
  });
  assert.deepEqual(executioner, {
    ...executionerSource,
    runtimeConfigCustomized: false,
    runtimeConfigDriftNoticeFingerprint: null,
  });
  assert.equal(await prisma.inboxMessage.count({
    where: { body: { startsWith: "Canonical runtime drift detected" } },
  }), driftNoticeCountBefore);
});

test("sync notifies once per current customized runtime drift without overwriting it", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const originalProduction = { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE };
  const changedProduction = { model: "claude-opus-5:high", runnerPreference: RunnerPreference.CLAUDE };
  const mergeResolverSource = canonicalRuntime("merge-resolver");
  const mergeResolver = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "merge-resolver" } },
    select: {
      id: true,
      model: true,
      runnerPreference: true,
      runtimeConfigCustomized: true,
      runtimeConfigDriftNoticeFingerprint: true,
    },
  });
  const existingNoticeIds = new Set((await prisma.inboxMessage.findMany({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
    select: { id: true },
  })).map(({ id }) => id));
  const operatorChatId = `canonical-drift-dbtest-${randomBytes(4).toString("hex")}`;
  const previousOperatorChatId = process.env["FEISHU_DEFAULT_CHAT_ID"];
  process.env["FEISHU_DEFAULT_CHAT_ID"] = operatorChatId;
  t.after(async () => {
    if (previousOperatorChatId === undefined) delete process.env["FEISHU_DEFAULT_CHAT_ID"];
    else process.env["FEISHU_DEFAULT_CHAT_ID"] = previousOperatorChatId;
    const createdNoticeIds = (await prisma.inboxMessage.findMany({
      where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
      select: { id: true },
    })).map(({ id }) => id).filter((id) => !existingNoticeIds.has(id));
    if (createdNoticeIds.length > 0) await prisma.inboxMessage.deleteMany({ where: { id: { in: createdNoticeIds } } });
    await prisma.agent.update({
      where: { id: mergeResolver.id },
      data: {
        model: mergeResolver.model,
        runnerPreference: mergeResolver.runnerPreference,
        runtimeConfigCustomized: mergeResolver.runtimeConfigCustomized,
        runtimeConfigDriftNoticeFingerprint: mergeResolver.runtimeConfigDriftNoticeFingerprint,
      },
    });
    await prisma.inboxThread.deleteMany({
      where: { channel: "FEISHU", externalChatId: operatorChatId, sessionId: null },
    });
  });
  await prisma.agent.update({
    where: { id: mergeResolver.id },
    data: { ...originalProduction, runtimeConfigCustomized: true },
  });

  const firstSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(firstSync.status, 0, firstSync.output);
  assert.match(firstSync.output, /"runtimeDriftNotices":1/u);

  const afterFirstSync = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "merge-resolver" } },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true },
  });
  assert.deepEqual(afterFirstSync, { ...originalProduction, runtimeConfigCustomized: true });

  const firstNotice = await prisma.inboxMessage.findMany({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(firstNotice.length, 1);
  assert.equal(firstNotice[0]!.from, "AGENT");
  assert.equal(firstNotice[0]!.kind, "TEXT");
  assert.notEqual(firstNotice[0]!.threadId, null);
  assert.equal((await prisma.inboxThread.findUniqueOrThrow({
    where: { id: firstNotice[0]!.threadId! },
  })).externalChatId, operatorChatId);
  assert.match(firstNotice[0]!.body, /Agent: merge-resolver/u);
  assert.match(firstNotice[0]!.body, new RegExp(
    `Canonical: model=${escapeRegex(mergeResolverSource.model)}, runner=${mergeResolverSource.runnerPreference}`,
    "u",
  ));
  assert.match(firstNotice[0]!.body, /Production: model=claude-opus-5:medium, runner=CLAUDE/u);
  assert.match(firstNotice[0]!.body, /runtimeConfigCustomized=true/u);

  const unchangedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(unchangedSync.status, 0, unchangedSync.output);
  assert.match(unchangedSync.output, /"runtimeDriftNotices":0/u);
  assert.equal(await prisma.inboxMessage.count({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
  }), 1);

  await prisma.agent.update({ where: { id: mergeResolver.id }, data: changedProduction });
  const changedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(changedSync.status, 0, changedSync.output);
  assert.match(changedSync.output, /"runtimeDriftNotices":1/u);

  const notices = await prisma.inboxMessage.findMany({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(notices.length, 2);
  assert.match(notices[1]!.body, /Production: model=claude-opus-5:high, runner=CLAUDE/u);
  const afterChangedSync = await prisma.agent.findUniqueOrThrow({
    where: { id: mergeResolver.id },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true },
  });
  assert.deepEqual(afterChangedSync, { ...changedProduction, runtimeConfigCustomized: true });

  await prisma.agent.update({ where: { id: mergeResolver.id }, data: originalProduction });
  const returnedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(returnedSync.status, 0, returnedSync.output);
  assert.match(returnedSync.output, /"runtimeDriftNotices":1/u);
  assert.equal(await prisma.inboxMessage.count({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
  }), 3);

  await prisma.agent.update({ where: { id: mergeResolver.id }, data: mergeResolverSource });
  const resolvedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(resolvedSync.status, 0, resolvedSync.output);
  assert.match(resolvedSync.output, /"runtimeDriftNotices":0/u);

  await prisma.agent.update({ where: { id: mergeResolver.id }, data: originalProduction });
  const reappearedSync = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(reappearedSync.status, 0, reappearedSync.output);
  assert.match(reappearedSync.output, /"runtimeDriftNotices":1/u);
  assert.equal(await prisma.inboxMessage.count({
    where: { agentId: mergeResolver.id, body: { startsWith: "Canonical runtime drift detected" } },
  }), 4);

});

test("sync adopts uncustomized runtime drift without promoting it", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const defaultSource = canonicalRuntime("default");
  const agent = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "default" } },
    select: {
      id: true,
      model: true,
      runnerPreference: true,
      runtimeConfigCustomized: true,
      runtimeConfigDriftNoticeFingerprint: true,
    },
  });
  const existingNoticeIds = new Set((await prisma.inboxMessage.findMany({
    where: { agentId: agent.id, body: { startsWith: "Canonical runtime drift detected" } },
    select: { id: true },
  })).map(({ id }) => id));
  t.after(async () => {
    const createdNoticeIds = (await prisma.inboxMessage.findMany({
      where: { agentId: agent.id, body: { startsWith: "Canonical runtime drift detected" } },
      select: { id: true },
    })).map(({ id }) => id).filter((id) => !existingNoticeIds.has(id));
    if (createdNoticeIds.length > 0) await prisma.inboxMessage.deleteMany({ where: { id: { in: createdNoticeIds } } });
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        model: agent.model,
        runnerPreference: agent.runnerPreference,
        runtimeConfigCustomized: agent.runtimeConfigCustomized,
        runtimeConfigDriftNoticeFingerprint: agent.runtimeConfigDriftNoticeFingerprint,
      },
    });
  });
  const production = { model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE };
  await prisma.agent.update({
    where: { id: agent.id },
    data: { ...production, runtimeConfigCustomized: false, runtimeConfigDriftNoticeFingerprint: "stale-runtime-drift" },
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"adoptedAgentDefaults":1/u);
  assert.match(synced.output, /"runtimeDriftNotices":0/u);
  assert.match(synced.output, runtimeAdoptionPattern("default", production, defaultSource));

  assert.deepEqual(await prisma.agent.findUniqueOrThrow({
    where: { id: agent.id },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true, runtimeConfigDriftNoticeFingerprint: true },
  }), {
    ...defaultSource,
    runtimeConfigCustomized: false,
    runtimeConfigDriftNoticeFingerprint: null,
  });
  const notices = await prisma.inboxMessage.findMany({
    where: { agentId: agent.id, body: { startsWith: "Canonical runtime drift detected" } },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(notices.length, existingNoticeIds.size);
});

test("sync recreates a missing regression verifier and restores canonical bindings", async () => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const verifierSource = canonicalRuntime("regression-verifier");
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "review-coordinator-sol" } },
  });
  const existingVerifier = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "regression-verifier" } },
  });
  const regressionSteps = await prisma.taskTemplateStep.findMany({
    where: {
      outputKind: "regression-verification-v2",
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
  assert.equal(verifier.model, verifierSource.model);
  assert.equal(verifier.runnerPreference, verifierSource.runnerPreference);
  assert.equal(verifier.inboxAccess, false);
  const canonicalSteps = regressionSteps.filter(({ taskTemplate }) =>
    taskTemplate.name === "compound-engineer-workflow" || taskTemplate.name === "direct-engineer-workflow");
  assert.equal(await prisma.taskTemplateStep.count({
    where: { id: { in: canonicalSteps.map(({ id }) => id) }, assigneeAgentId: verifier.id },
  }), 2);
});

test("sync recreates a missing spec revalidator with read-only repository coverage", async (t) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const source = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "review-coordinator-sol" } },
  });
  const existingRevalidator = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "spec-revalidator" } },
  });
  const revalidationSteps = await prisma.taskTemplateStep.findMany({
    where: { outputKind: "revalidation", taskTemplate: { projectId: project.id } },
    select: { id: true },
  });
  assert.ok(revalidationSteps.length > 0);
  await prisma.taskTemplateStep.updateMany({
    where: { id: { in: revalidationSteps.map(({ id }) => id) } },
    data: { assigneeAgentId: null },
  });

  const repo = await prisma.repo.create({
    data: {
      projectId: project.id,
      name: `canonical-sync-revalidator-${randomBytes(4).toString("hex")}`,
      remoteUrl: "file:///tmp/agentos-canonical-sync-revalidator.git",
      mountPath: "/workspace/canonical-sync-revalidator",
      dependencyProvisioning: "NONE",
    },
  });
  await prisma.agentRepoAccess.create({
    data: {
      agentId: source.id,
      repoId: repo.id,
      projectId: project.id,
      mountPath: repo.mountPath,
      permissions: RepoPermission.GIT_WRITE,
    },
  });
  t.after(async () => {
    await prisma.repo.delete({ where: { id: repo.id } });
  });

  await prisma.agent.delete({ where: { id: existingRevalidator.id } });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.match(synced.output, /"createdAgents":1/u);
  assert.match(synced.output, /"createdAgentRepoGrants":1/u);

  const revalidator = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "spec-revalidator" } },
  });
  assert.equal(revalidator.model, "openai-codex/gpt-5.6-luna:xhigh");
  assert.equal(revalidator.runnerPreference, RunnerPreference.PI);
  assert.equal(revalidator.inboxAccess, true);
  assert.equal(await prisma.taskTemplateStep.count({
    where: { id: { in: revalidationSteps.map(({ id }) => id) }, assigneeAgentId: revalidator.id },
  }), revalidationSteps.length);
  assert.deepEqual(await prisma.agentRepoAccess.findMany({
    where: { agentId: revalidator.id, repoId: repo.id },
    select: { mountPath: true, permissions: true },
  }), [{ mountPath: repo.mountPath, permissions: RepoPermission.GIT_READ }]);
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
    where: { taskTemplateId: template.id, outputKind: "regression-verification-v2" },
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

test("sync refuses an eight-step canonical shape with structural drift before mutation", async () => {
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
  assert.match(
    refused.output,
    new RegExp(`Project ${project.slug}: Template direct-engineer-workflow \\(${template.id}\\), direct-engineer-workflow step 7 \\(${step.id}\\) differs from the canonical source in outputKind`, "u"),
  );
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: { startsWith: "direct-engineer-workflow-legacy" } } }), beforeLegacyCount);
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: step.id } })).outputKind, "drifted-output");
});
