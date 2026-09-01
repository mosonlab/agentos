/**
 * Multi-Project canonical prompt sync acceptance coverage.
 *
 * Requires a scratch PostgreSQL server. The test creates and drops its own
 * schema and never touches an existing database.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @anneal/db -- src/canonical-prompt-sync-multi-project.dbtest.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import {
  CodexServiceTier,
  Prisma,
  PrismaClient,
  RunnerPreference,
  TaskStatus,
} from "@prisma/client";

import { loadAgentSources, type AgentSources, type RoleSource } from "./agent-sources.js";
import {
  LEGACY_ALL_PRIOR_OUTPUTS,
  loadAllTemplateStepSources,
  type CanonicalTemplateName,
} from "./template-sources.js";

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
const schema = `canonical_prompt_sync_multi_${randomBytes(4).toString("hex")}`;
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

type FixtureProject = { id: string; slug: string; environmentId: string };
type ProjectCounters = {
  templates: number;
  createdCanonicalTemplates: number;
  createdAgents: number;
  createdAgentRepoGrants: number;
  adoptedAssignees: number;
  adoptedStepBases: number;
  adoptedPriorOutputDeclarations: number;
  renamedSteps: number;
  migratedTasks: number;
  adoptedAgentDefaults: number;
  runtimeDriftNotices: number;
  updated: number;
  preservedTaskAssignments: { archived: number; nonTodo: number; started: number; output: number };
  updatedSteps: Record<string, Record<string, number>>;
  updatedRoles: Record<string, number>;
};

let prisma: PrismaClient;
let sources: AgentSources;
let rolesByName: Map<string, RoleSource>;
let templateSources: Awaited<ReturnType<typeof loadAllTemplateStepSources>>;
let canonicalProject: FixtureProject;

const canonicalTemplateNames = (): string[] => [...templateSources.keys()];
const canonicalRoleNames = (): string[] => sources.roles.map(({ name }) => name);

const zeroSteps = (): Record<string, Record<string, number>> => Object.fromEntries(
  [...templateSources.entries()].map(([name, steps]) => [
    name,
    Object.fromEntries(steps.map(({ stepIndex }) => [String(stepIndex), 0])),
  ]),
);

const zeroRoles = (): Record<string, number> => Object.fromEntries(
  sources.roles.map(({ name }) => [name, 0]),
);

const zeroCounters = (): ProjectCounters => ({
  templates: 0,
  createdCanonicalTemplates: 0,
  createdAgents: 0,
  createdAgentRepoGrants: 0,
  adoptedAssignees: 0,
  adoptedStepBases: 0,
  adoptedPriorOutputDeclarations: 0,
  renamedSteps: 0,
  migratedTasks: 0,
  adoptedAgentDefaults: 0,
  runtimeDriftNotices: 0,
  updated: 0,
  preservedTaskAssignments: { archived: 0, nonTodo: 0, started: 0, output: 0 },
  updatedSteps: zeroSteps(),
  updatedRoles: zeroRoles(),
});

const summaryFrom = (output: string): { projects: Record<string, ProjectCounters>; totals: ProjectCounters } => {
  const line = output.trim().split("\n").at(-1);
  assert.ok(line, `sync did not print a summary: ${output}`);
  return JSON.parse(line) as { projects: Record<string, ProjectCounters>; totals: ProjectCounters };
};

const createProject = async (slug: string, withEnvironment = true): Promise<FixtureProject> => {
  const project = await prisma.project.create({ data: { name: `A2 ${slug}`, slug } });
  if (!withEnvironment) return { id: project.id, slug, environmentId: "" };
  const environment = await prisma.environment.create({
    data: { projectId: project.id, name: "local", networking: "OPEN", allowedHosts: [] },
  });
  return { id: project.id, slug, environmentId: environment.id };
};

const createEnvironment = async (projectId: string, name: string): Promise<string> => (
  (await prisma.environment.create({
    data: { projectId, name, networking: "OPEN", allowedHosts: [] },
  })).id
);

const role = (name: string): RoleSource => {
  const source = rolesByName.get(name);
  assert.ok(source, `source role ${name} must be present`);
  return source;
};

const createAgent = async (
  project: FixtureProject,
  name: string,
  overrides: Partial<Prisma.AgentUncheckedCreateInput> = {},
) => {
  const source = role(name);
  return prisma.agent.create({
    data: {
      projectId: project.id,
      environmentId: project.environmentId,
      name: source.name,
      title: source.title,
      model: source.model,
      runnerPreference: source.runnerPreference,
      inboxAccess: source.inboxAccess,
      foundationalPrompt: sources.foundationalPrompt,
      rolePrompt: source.rolePrompt,
      runtimeConfigCustomized: false,
      runtimeConfigDriftNoticeFingerprint: null,
      codexServiceTier: CodexServiceTier.DEFAULT,
      disabledTools: [],
      archivedAt: null,
      ...overrides,
    },
  });
};

const createAgents = async (project: FixtureProject, names: readonly string[]): Promise<Map<string, string>> => {
  const allNames = new Set(names);
  for (const name of names) for (const collaborator of role(name).collaborators) allNames.add(collaborator);
  const ids = new Map<string, string>();
  for (const name of allNames) ids.set(name, (await createAgent(project, name)).id);
  for (const name of allNames) {
    const source = role(name);
    for (const collaboratorName of source.collaborators) {
      await prisma.agentCollaboration.create({
        data: {
          agentId: ids.get(name)!,
          allowedAgentId: ids.get(collaboratorName)!,
          projectId: project.id,
        },
      });
    }
  }
  return ids;
};

const canonicalTemplate = async (name: CanonicalTemplateName) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: canonicalProject.id } });
  return prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name } },
    include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
  });
};

const templateAssigneeNames = async (name: CanonicalTemplateName): Promise<string[]> => {
  const source = await canonicalTemplate(name);
  return [...new Set(source.steps.flatMap(({ assigneeAgent }) => assigneeAgent ? [assigneeAgent.name] : []))];
};

const copyTemplate = async (
  project: FixtureProject,
  name: CanonicalTemplateName,
  agentIds?: Map<string, string>,
) => {
  const source = await canonicalTemplate(name);
  const target = await prisma.taskTemplate.create({
    data: {
      projectId: project.id,
      name: source.name,
      description: source.description,
      variables: source.variables,
    },
  });
  for (const step of source.steps) {
    await prisma.taskTemplateStep.create({
      data: {
        taskTemplateId: target.id,
        stepIndex: step.stepIndex,
        layer: step.layer,
        name: step.name,
        assigneeAgentId: step.assigneeAgent ? agentIds?.get(step.assigneeAgent.name) ?? null : null,
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
        spawnPolicy: step.spawnPolicy === null ? Prisma.JsonNull : step.spawnPolicy as Prisma.InputJsonValue,
      },
    });
  }
  return target;
};

const deleteProject = async (projectId: string): Promise<void> => {
  // Inbox messages intentionally SetNull their Agent relation, so remove the
  // messages first when a fixture exercises customized-runtime notices.
  const agentIds = (await prisma.agent.findMany({ where: { projectId }, select: { id: true } })).map(({ id }) => id);
  if (agentIds.length > 0) await prisma.inboxMessage.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.project.delete({ where: { id: projectId } });
};

const assertSummaryShape = (summary: { projects: Record<string, ProjectCounters>; totals: ProjectCounters }): void => {
  const expectedCounters = Object.keys(zeroCounters()).sort();
  for (const counter of [...Object.values(summary.projects), summary.totals]) {
    assert.deepEqual(Object.keys(counter).sort(), expectedCounters);
    assert.deepEqual(Object.keys(counter.updatedSteps).sort(), canonicalTemplateNames().sort());
    for (const [name, steps] of Object.entries(zeroSteps())) {
      assert.deepEqual(Object.keys(counter.updatedSteps[name]!).sort(), Object.keys(steps).sort());
    }
    assert.deepEqual(Object.keys(counter.updatedRoles).sort(), canonicalRoleNames().sort());
    assert.deepEqual(Object.keys(counter.preservedTaskAssignments).sort(), ["archived", "nonTodo", "output", "started"]);
    const nested = Object.values(counter.updatedSteps).flatMap((steps) => Object.values(steps))
      .reduce((sum, count) => sum + count, 0);
    const roles = Object.values(counter.updatedRoles).reduce((sum, count) => sum + count, 0);
    const scalar = counter.createdCanonicalTemplates + counter.createdAgents + counter.createdAgentRepoGrants
      + counter.adoptedAssignees + counter.adoptedStepBases + counter.adoptedPriorOutputDeclarations
      + counter.renamedSteps + counter.migratedTasks + counter.adoptedAgentDefaults + counter.runtimeDriftNotices;
    assert.equal(counter.updated, scalar + nested + roles);
  }
};

const downgradeDirectToHistoricalSevenStep = async (projectId: string): Promise<void> => {
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

before(async () => {
  sources = await loadAgentSources();
  rolesByName = new Map(sources.roles.map((source) => [source.name, source]));
  templateSources = await loadAllTemplateStepSources();
  const migrated = command(["prisma", "migrate", "deploy"]);
  assert.equal(migrated.status, 0, migrated.output);
  const seeded = command(["tsx", "prisma/seed.ts"]);
  assert.equal(seeded.status, 0, seeded.output);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  const row = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const environment = await prisma.environment.findUniqueOrThrow({
    where: { projectId_name: { projectId: row.id, name: "local" } },
  });
  canonicalProject = { id: row.id, slug: row.slug, environmentId: environment.id };
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

test("ordinary sync covers active canonical Agents in every Project and preserves partial inventories", async (t) => {
  const project = await createProject(`a2-agents-${randomBytes(4).toString("hex")}`);
  const names = ["senior-dev", "review-coordinator-sol", "default"] as const;
  await createAgents(project, names);
  const canonicalDefault = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: canonicalProject.id, name: "default" } },
    select: {
      id: true,
      foundationalPrompt: true,
      rolePrompt: true,
      model: true,
      runnerPreference: true,
      runtimeConfigCustomized: true,
      runtimeConfigDriftNoticeFingerprint: true,
    },
  });
  const operatorChatId = `a2-agents-${randomBytes(4).toString("hex")}`;
  const previousChatId = process.env["FEISHU_DEFAULT_CHAT_ID"];
  process.env["FEISHU_DEFAULT_CHAT_ID"] = operatorChatId;
  t.after(async () => {
    if (previousChatId === undefined) delete process.env["FEISHU_DEFAULT_CHAT_ID"];
    else process.env["FEISHU_DEFAULT_CHAT_ID"] = previousChatId;
    await deleteProject(project.id);
    await prisma.agent.update({
      where: { id: canonicalDefault.id },
      data: {
        foundationalPrompt: canonicalDefault.foundationalPrompt,
        rolePrompt: canonicalDefault.rolePrompt,
        model: canonicalDefault.model,
        runnerPreference: canonicalDefault.runnerPreference,
        runtimeConfigCustomized: canonicalDefault.runtimeConfigCustomized,
        runtimeConfigDriftNoticeFingerprint: canonicalDefault.runtimeConfigDriftNoticeFingerprint,
      },
    });
    await prisma.inboxThread.deleteMany({ where: { channel: "FEISHU", externalChatId: operatorChatId, sessionId: null } });
  });

  const secondSenior = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "senior-dev" } },
    select: { id: true },
  });
  const secondSol = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "review-coordinator-sol" } },
    select: { id: true },
  });
  const compatibleCustomized = { model: "openai-codex/gpt-5.6-luna:max", runnerPreference: RunnerPreference.PI };
  await prisma.agent.update({
    where: { id: canonicalDefault.id },
    data: { foundationalPrompt: "canonical foundational drift", rolePrompt: "canonical default drift" },
  });
  await prisma.agent.update({
    where: { id: secondSenior.id },
    data: {
      foundationalPrompt: "second Project foundational drift",
      rolePrompt: "second Project role drift",
      model: "gpt-5.6-sol:medium",
      runnerPreference: RunnerPreference.CODEX,
    },
  });
  await prisma.agent.update({
    where: { id: secondSol.id },
    data: { ...compatibleCustomized, runtimeConfigCustomized: true },
  });
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  const syncedDefault = await prisma.agent.findUniqueOrThrow({
    where: { id: canonicalDefault.id },
    select: { foundationalPrompt: true, rolePrompt: true },
  });
  assert.deepEqual(syncedDefault, { foundationalPrompt: sources.foundationalPrompt, rolePrompt: role("default").rolePrompt });
  const syncedSenior = await prisma.agent.findUniqueOrThrow({
    where: { id: secondSenior.id },
    select: { foundationalPrompt: true, rolePrompt: true, model: true, runnerPreference: true },
  });
  assert.deepEqual(syncedSenior, {
    foundationalPrompt: sources.foundationalPrompt,
    rolePrompt: role("senior-dev").rolePrompt,
    model: role("senior-dev").model,
    runnerPreference: role("senior-dev").runnerPreference,
  });
  const customized = await prisma.agent.findUniqueOrThrow({
    where: { id: secondSol.id },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true, runtimeConfigDriftNoticeFingerprint: true },
  });
  const expectedFingerprint = JSON.stringify({
    canonical: { model: role("review-coordinator-sol").model, runnerPreference: role("review-coordinator-sol").runnerPreference },
    production: compatibleCustomized,
  });
  assert.deepEqual(customized, { ...compatibleCustomized, runtimeConfigCustomized: true, runtimeConfigDriftNoticeFingerprint: expectedFingerprint });
  assert.equal(await prisma.agent.count({ where: { projectId: project.id, name: "implementation-plan-executioner" } }), 0);
  assert.equal(await prisma.agent.count({ where: { projectId: project.id, name: "regression-verifier" } }), 0);
  assert.equal(await prisma.agent.count({ where: { projectId: project.id, name: "spec-revalidator" } }), 0);
  const summary = summaryFrom(synced.output);
  assertSummaryShape(summary);
  assert.equal(summary.projects[project.slug]!.adoptedAgentDefaults, 1);
  assert.equal(summary.projects[project.slug]!.runtimeDriftNotices, 1);
  assert.equal(summary.projects[project.slug]!.updatedRoles["senior-dev"], 1);
  assert.equal(summary.projects[canonicalProject.slug]!.updatedRoles.default, 1);
});

test("structural or invalid runtime drift in one Project refuses and rolls back every Project", async (t) => {
  const project = await createProject(`a2-agent-refusal-${randomBytes(4).toString("hex")}`);
  await createAgents(project, ["default", "senior-dev"]);
  const defaultAgent = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "default" } },
  });
  const seniorAgent = await prisma.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "senior-dev" } },
  });
  const before = JSON.stringify(await prisma.agent.findMany({
    where: { projectId: { in: [canonicalProject.id, project.id] }, name: { in: ["default", "senior-dev"] } },
    select: { id: true, projectId: true, name: true, title: true, model: true, runnerPreference: true, foundationalPrompt: true, rolePrompt: true },
    orderBy: [{ projectId: "asc" }, { name: "asc" }],
  }));
  t.after(async () => deleteProject(project.id));
  await prisma.agent.update({ where: { id: defaultAgent.id }, data: { title: "operator structural drift" } });
  await prisma.agent.update({
    where: { id: seniorAgent.id },
    data: { model: "gpt-5.6-sol:medium", runnerPreference: RunnerPreference.CLAUDE },
  });
  const driftedBefore = JSON.stringify(await prisma.agent.findMany({
    where: { projectId: { in: [canonicalProject.id, project.id] }, name: { in: ["default", "senior-dev"] } },
    select: { id: true, projectId: true, name: true, title: true, model: true, runnerPreference: true, foundationalPrompt: true, rolePrompt: true },
    orderBy: [{ projectId: "asc" }, { name: "asc" }],
  }));
  const refused = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, new RegExp(`Agent default \\(${defaultAgent.id}\\)|Agent senior-dev \\(${seniorAgent.id}\\)`));
  const after = JSON.stringify(await prisma.agent.findMany({
    where: { projectId: { in: [canonicalProject.id, project.id] }, name: { in: ["default", "senior-dev"] } },
    select: { id: true, projectId: true, name: true, title: true, model: true, runnerPreference: true, foundationalPrompt: true, rolePrompt: true },
    orderBy: [{ projectId: "asc" }, { name: "asc" }],
  }));
  assert.equal(after, driftedBefore);
  assert.notEqual(driftedBefore, before);
});

test("partial template rows synchronize across Projects, leave missing rows valid, and adopt transitions", async (t) => {
  const partial = await createProject(`a2-pr-only-${randomBytes(4).toString("hex")}`);
  const partialAgentNames = await templateAssigneeNames("pr-engineer-workflow");
  const partialAgents = await createAgents(partial, partialAgentNames);
  const pr = await copyTemplate(partial, "pr-engineer-workflow", partialAgents);
  const prStep = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: pr.id, stepIndex: 1 } },
  });
  await prisma.taskTemplateStep.update({ where: { id: prStep.id }, data: { prompt: "partial Project prompt drift" } });

  const empty = await createProject(`a2-no-templates-${randomBytes(4).toString("hex")}`);
  const transition = await createProject(`a2-transitions-${randomBytes(4).toString("hex")}`);
  const transitionNames = new Set<string>();
  for (const name of ["compound-engineer-workflow", "direct-engineer-workflow"] as const) {
    for (const agentName of await templateAssigneeNames(name)) transitionNames.add(agentName);
  }
  const transitionAgents = await createAgents(transition, [...transitionNames]);
  const compound = await copyTemplate(transition, "compound-engineer-workflow", transitionAgents);
  const direct = await copyTemplate(transition, "direct-engineer-workflow", transitionAgents);
  const compoundStep10 = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: compound.id, stepIndex: 10 } },
  });
  const compoundStep6 = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: compound.id, stepIndex: 6 } },
  });
  const compoundStep11 = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: compound.id, stepIndex: 11 } },
  });
  const compoundStep2 = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: compound.id, stepIndex: 2 } },
  });
  const directStep1 = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: direct.id, stepIndex: 1 } },
  });
  const directStep3 = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: direct.id, stepIndex: 3 } },
  });
  const directStep7 = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: direct.id, stepIndex: 7 } },
  });
  const oldAssignee = transitionAgents.get("review-coordinator-sol")!;
  const directStep6 = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: direct.id, stepIndex: 6 } },
  });
  await prisma.taskTemplateStep.update({ where: { id: directStep6.id }, data: { assigneeAgentId: oldAssignee } });
  await prisma.taskTemplateStep.update({ where: { id: compoundStep6.id }, data: { baseFromStepIndex: null } });
  await prisma.taskTemplateStep.update({ where: { id: compoundStep11.id }, data: { name: "Merge readiness" } });
  await prisma.taskTemplateStep.update({ where: { id: compoundStep2.id }, data: { priorOutputKinds: [LEGACY_ALL_PRIOR_OUTPUTS] } });
  await prisma.taskTemplateStep.update({ where: { id: directStep1.id }, data: { assigneeAgentId: null } });
  await prisma.taskTemplateStep.update({ where: { id: directStep3.id }, data: { baseFromStepIndex: null } });
  await prisma.taskTemplateStep.update({ where: { id: directStep7.id }, data: { name: "Merge readiness" } });
  const task = await prisma.task.create({
    data: {
      projectId: transition.id,
      templateId: compound.id,
      templateStepId: compoundStep10.id,
      name: "eligible regression transition",
      description: "canonical transition fixture",
      assigneeAgentId: oldAssignee,
      assigneeType: "AGENT",
      status: TaskStatus.TODO,
    },
  });

  t.after(async () => {
    await deleteProject(partial.id);
    await deleteProject(empty.id);
    await deleteProject(transition.id);
  });
  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: prStep.id } })).prompt,
    (await canonicalTemplate("pr-engineer-workflow")).steps[0]!.prompt);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: partial.id, name: { in: ["compound-engineer-workflow", "direct-engineer-workflow"] } } }), 0);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: empty.id } }), 0);
  assert.equal(await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: compoundStep10.id } }).then(({ assigneeAgentId }) => assigneeAgentId), transitionAgents.get("regression-verifier"));
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: compoundStep6.id } })).baseFromStepIndex, 5);
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: compoundStep11.id } })).name, "Merge authorization");
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: directStep1.id } })).assigneeAgentId, transitionAgents.get("spec-revalidator"));
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: directStep3.id } })).baseFromStepIndex, 2);
  assert.equal((await prisma.taskTemplateStep.findUniqueOrThrow({ where: { id: directStep7.id } })).name, "Merge authorization");
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).assigneeAgentId, transitionAgents.get("regression-verifier"));
  assert.equal(await prisma.taskActivity.count({ where: { taskId: task.id, body: { contains: "Canonical routing reassigned" } } }), 1);
  const summary = summaryFrom(synced.output);
  assertSummaryShape(summary);
  assert.equal(summary.projects[partial.slug]!.templates, 1);
  assert.equal(summary.projects[empty.slug]!.templates, 0);
  assert.equal(summary.projects[transition.slug]!.adoptedAssignees, 2);
  assert.equal(summary.projects[transition.slug]!.adoptedStepBases, 2);
  assert.equal(summary.projects[transition.slug]!.adoptedPriorOutputDeclarations, 1);
  assert.equal(summary.projects[transition.slug]!.renamedSteps, 2);
  assert.equal(summary.projects[transition.slug]!.migratedTasks, 1);
});

test("full installation fills only the addressed Project's missing inventory and is idempotent", async (t) => {
  const project = await createProject(`a2-install-full-${randomBytes(4).toString("hex")}`);
  const existingNames = ["senior-dev-luna", "review-coordinator-sol", "review-coordinator-opus", "senior-dev"] as const;
  const directNames = await templateAssigneeNames("direct-engineer-workflow");
  const initialNames = [...new Set([...existingNames, ...directNames])];
  const agents = await createAgents(project, initialNames);
  const pr = await copyTemplate(project, "pr-engineer-workflow", agents);
  const prStep = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: pr.id, stepIndex: 1 } },
  });
  await prisma.taskTemplateStep.update({ where: { id: prStep.id }, data: { prompt: "operator PR prompt drift" } });
  const customized = { model: "openai-codex/gpt-5.6-luna:max", runnerPreference: RunnerPreference.PI };
  await prisma.agent.update({
    where: { id: agents.get("review-coordinator-sol")! },
    data: { ...customized, runtimeConfigCustomized: true },
  });
  await copyTemplate(project, "direct-engineer-workflow", agents);
  await downgradeDirectToHistoricalSevenStep(project.id);
  const repoCountBefore = await prisma.repo.count({ where: { projectId: project.id } });
  const accessCountBefore = await prisma.agentRepoAccess.count({ where: { projectId: project.id } });
  const secretGrantCountBefore = await prisma.agentSecretGrant.count({ where: { agent: { projectId: project.id } } });
  t.after(async () => deleteProject(project.id));

  const installed = command(["tsx", "prisma/sync-canonical-prompts.ts", "--install-full", project.id]);
  assert.equal(installed.status, 0, installed.output);
  const allAgents = await prisma.agent.findMany({
    where: { projectId: project.id },
    include: { collaborators: { select: { allowedAgent: { select: { name: true } } } } },
    orderBy: { name: "asc" },
  });
  assert.deepEqual(allAgents.map(({ name }) => name), canonicalRoleNames());
  for (const agent of allAgents) {
    const source = role(agent.name);
    assert.equal(agent.title, source.title);
    assert.equal(agent.model, agent.runtimeConfigCustomized ? customized.model : source.model);
    assert.equal(agent.runnerPreference, agent.runtimeConfigCustomized ? customized.runnerPreference : source.runnerPreference);
    assert.equal(agent.inboxAccess, source.inboxAccess);
    assert.equal(agent.foundationalPrompt, sources.foundationalPrompt);
    assert.equal(agent.rolePrompt, source.rolePrompt);
    assert.equal(agent.codexServiceTier, CodexServiceTier.DEFAULT);
    assert.deepEqual(agent.disabledTools, []);
    assert.equal(agent.archivedAt, null);
    assert.deepEqual(agent.collaborators.map(({ allowedAgent }) => allowedAgent.name).sort(), [...source.collaborators].sort());
  }
  assert.deepEqual(await prisma.taskTemplate.findMany({ where: { projectId: project.id }, select: { name: true }, orderBy: { name: "asc" } }),
    canonicalTemplateNames().sort().map((name) => ({ name })));
  const installedPr = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "pr-engineer-workflow" } },
    include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
  });
  assert.deepEqual(installedPr.variables, ["branchName"]);
  assert.equal(installedPr.steps[0]!.prompt, (await canonicalTemplate("pr-engineer-workflow")).steps[0]!.prompt);
  assert.equal(await prisma.taskTemplate.count({ where: { projectId: project.id, name: { contains: "legacy" } } }), 1);
  assert.equal(await prisma.repo.count({ where: { projectId: project.id } }), repoCountBefore);
  assert.equal(await prisma.agentRepoAccess.count({ where: { projectId: project.id } }), accessCountBefore);
  assert.equal(await prisma.agentSecretGrant.count({ where: { agent: { projectId: project.id } } }), secretGrantCountBefore);
  const installedSummary = summaryFrom(installed.output);
  assertSummaryShape(installedSummary);
  assert.equal(installedSummary.projects[project.slug]!.createdAgents, canonicalRoleNames().length - initialNames.length);
  assert.equal(installedSummary.projects[project.slug]!.createdCanonicalTemplates, 2);
  assert.equal(installedSummary.projects[project.slug]!.runtimeDriftNotices, 1);

  const second = command(["tsx", "prisma/sync-canonical-prompts.ts", "--install-full", project.id]);
  assert.equal(second.status, 0, second.output);
  const secondSummary = summaryFrom(second.output);
  assertSummaryShape(secondSummary);
  assert.deepEqual(secondSummary.projects[project.slug], zeroCounters());
});

test("full installation refuses unknown, environment-invalid, and archived targets without mutations", async (t) => {
  const unknownId = `missing-project-${randomBytes(4).toString("hex")}`;
  const unknown = command(["tsx", "prisma/sync-canonical-prompts.ts", "--install-full", unknownId]);
  assert.notEqual(unknown.status, 0, unknown.output);
  assert.match(unknown.output, new RegExp(unknownId, "u"));

  const noEnvironment = await createProject(`a2-install-no-env-${randomBytes(4).toString("hex")}`, false);
  const twoEnvironments = await createProject(`a2-install-two-env-${randomBytes(4).toString("hex")}`);
  await createEnvironment(twoEnvironments.id, "second");
  const archived = await createProject(`a2-install-archived-${randomBytes(4).toString("hex")}`);
  const archivedAgent = await createAgent(archived, "default", { archivedAt: new Date() });
  const projectIds = [noEnvironment.id, twoEnvironments.id, archived.id];
  const before = JSON.stringify(await prisma.project.findMany({
    where: { id: { in: projectIds } },
    include: {
      environments: { orderBy: { name: "asc" } },
      agents: { orderBy: { name: "asc" } },
      taskTemplates: { orderBy: { name: "asc" }, include: { steps: { orderBy: { stepIndex: "asc" } } } },
    },
    orderBy: { id: "asc" },
  }));
  t.after(async () => {
    await deleteProject(noEnvironment.id);
    await deleteProject(twoEnvironments.id);
    await deleteProject(archived.id);
  });
  for (const projectId of projectIds) {
    const refused = command(["tsx", "prisma/sync-canonical-prompts.ts", "--install-full", projectId]);
    assert.notEqual(refused.status, 0, refused.output);
    assert.match(refused.output, new RegExp(`Project ${projectId === noEnvironment.id ? noEnvironment.slug : projectId === twoEnvironments.id ? twoEnvironments.slug : archived.slug}:`));
  }
  assert.equal((await prisma.agent.findUniqueOrThrow({ where: { id: archivedAgent.id } })).archivedAt !== null, true);
  const after = JSON.stringify(await prisma.project.findMany({
    where: { id: { in: projectIds } },
    include: {
      environments: { orderBy: { name: "asc" } },
      agents: { orderBy: { name: "asc" } },
      taskTemplates: { orderBy: { name: "asc" }, include: { steps: { orderBy: { stepIndex: "asc" } } } },
    },
    orderBy: { id: "asc" },
  }));
  assert.equal(after, before);
});

test("summary reports every Project, nested canonical keys, lexical slugs, and field-wise totals", async (t) => {
  const active = await createProject(`aaa-a2-summary-${randomBytes(4).toString("hex")}`);
  const agents = await createAgents(active, await templateAssigneeNames("pr-engineer-workflow"));
  const template = await copyTemplate(active, "pr-engineer-workflow", agents);
  const firstStep = await prisma.taskTemplateStep.findUniqueOrThrow({
    where: { taskTemplateId_stepIndex: { taskTemplateId: template.id, stepIndex: 1 } },
  });
  await prisma.taskTemplateStep.update({ where: { id: firstStep.id }, data: { prompt: "summary prompt drift" } });
  const senior = await prisma.agent.findUniqueOrThrow({ where: { id: agents.get("senior-dev")! } });
  await prisma.agent.update({
    where: { id: senior.id },
    data: {
      foundationalPrompt: "summary foundational drift",
      rolePrompt: "summary role drift",
      model: "gpt-5.6-sol:medium",
      runnerPreference: RunnerPreference.CODEX,
    },
  });
  const zero = await createProject(`zzz-a2-summary-${randomBytes(4).toString("hex")}`);
  t.after(async () => {
    await deleteProject(active.id);
    await deleteProject(zero.id);
  });

  const synced = command(["tsx", "prisma/sync-canonical-prompts.ts"]);
  assert.equal(synced.status, 0, synced.output);
  const summary = summaryFrom(synced.output);
  assertSummaryShape(summary);
  const slugs = Object.keys(summary.projects);
  assert.deepEqual(slugs, [...slugs].sort());
  assert.ok(slugs.includes(canonicalProject.slug));
  assert.ok(slugs.includes(active.slug));
  assert.ok(slugs.includes(zero.slug));
  const activeCounters = summary.projects[active.slug]!;
  const zeroProjectCounters = summary.projects[zero.slug]!;
  assert.equal(activeCounters.templates, 1);
  assert.equal(activeCounters.updatedSteps["pr-engineer-workflow"]!["1"], 1);
  assert.equal(activeCounters.updatedRoles["senior-dev"], 1);
  assert.equal(activeCounters.adoptedAgentDefaults, 1);
  assert.equal(zeroProjectCounters.templates, 0);
  assert.deepEqual(zeroProjectCounters, zeroCounters());
  for (const key of Object.keys(zeroProjectCounters) as Array<keyof ProjectCounters>) {
    if (key === "preservedTaskAssignments" || key === "updatedSteps" || key === "updatedRoles") continue;
    const sum = Object.values(summary.projects).reduce((total, counters) => total + Number(counters[key]), 0);
    assert.equal(summary.totals[key], sum, `${key} total`);
  }
  for (const key of ["archived", "nonTodo", "started", "output"] as const) {
    assert.equal(summary.totals.preservedTaskAssignments[key], Object.values(summary.projects)
      .reduce((sum, counters) => sum + counters.preservedTaskAssignments[key], 0));
  }
  for (const name of canonicalTemplateNames()) for (const step of Object.keys(zeroSteps()[name]!)) {
    assert.equal(summary.totals.updatedSteps[name]![step], Object.values(summary.projects)
      .reduce((sum, counters) => sum + counters.updatedSteps[name]![step]!, 0));
  }
  for (const name of canonicalRoleNames()) {
    assert.equal(summary.totals.updatedRoles[name], Object.values(summary.projects)
      .reduce((sum, counters) => sum + counters.updatedRoles[name]!, 0));
  }
});
