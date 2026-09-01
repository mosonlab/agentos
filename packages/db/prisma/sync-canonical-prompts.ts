import {
  CodexServiceTier,
  Prisma,
  PrismaClient,
  RepoPermission,
  RunnerPreference,
  TaskStatus,
} from "@prisma/client";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { catalogRunnerForModel } from "../src/agent-contract.js";
import { loadAgentSources, roleSourceStructureDifferences, type AgentSources, type RoleSource } from "../src/agent-sources.js";
import {
  applyCanonicalInstallation,
  planCanonicalInstallation,
  type CanonicalInstallationAction,
  type CanonicalInstallationRow,
} from "../src/canonical-template-installation.js";
import {
  loadAllTemplateStepSources,
  LEGACY_ALL_PRIOR_OUTPUTS,
  templateStepStructureDifferences,
  type CanonicalTemplateName,
  type TemplateStepSource,
} from "../src/template-sources.js";

const REGRESSION_AGENT_NAME = "regression-verifier";
const REGRESSION_AGENT_SOURCE = "review-coordinator-sol";
const SPEC_REVALIDATOR_AGENT_NAME = "spec-revalidator";
const SPEC_REVALIDATOR_AGENT_SOURCE = "review-coordinator-sol";

type AssigneeTransition = { from: readonly (string | null)[]; to: string };
const ASSIGNEE_TRANSITIONS = new Map<string, AssigneeTransition>([
  ["compound-engineer-workflow:10", { from: ["review-coordinator-opus", "review-coordinator-sol"], to: REGRESSION_AGENT_NAME }],
  ["direct-engineer-workflow:6", { from: ["review-coordinator-opus", "review-coordinator-sol"], to: REGRESSION_AGENT_NAME }],
  ["direct-engineer-workflow:1", { from: [null], to: SPEC_REVALIDATOR_AGENT_NAME }],
]);

const STEP_NAME_TRANSITIONS = new Map([
  ["compound-engineer-workflow:11", { from: "Merge readiness", to: "Merge authorization" }],
  ["direct-engineer-workflow:7", { from: "Merge readiness", to: "Merge authorization" }],
]);

const STEP_BASE_TRANSITIONS = new Map([
  ["compound-engineer-workflow:6", { from: null, to: 5 }],
  ["direct-engineer-workflow:3", { from: null, to: 2 }],
]);

const runtimeConfigRefusal = (agent: { model: string; runnerPreference: RunnerPreference }): string | null => {
  const expected = catalogRunnerForModel(agent.model);
  if (!expected || agent.runnerPreference === RunnerPreference.AUTO || agent.runnerPreference === RunnerPreference.INHERIT
    || expected === agent.runnerPreference) return null;
  return `Model ${agent.model} requires ${expected}, but this Agent stores ${agent.runnerPreference}`;
};

type PreservedTaskAssignments = { archived: number; nonTodo: number; started: number; output: number };
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
  preservedTaskAssignments: PreservedTaskAssignments;
  updatedSteps: Record<string, Record<number, number>>;
  updatedRoles: Record<string, number>;
};

type ProjectRow = { id: string; slug: string };
type ProjectMap = Map<string, ProjectRow>;

const mutationCounterNames = [
  "createdCanonicalTemplates",
  "createdAgents",
  "createdAgentRepoGrants",
  "adoptedAssignees",
  "adoptedStepBases",
  "adoptedPriorOutputDeclarations",
  "renamedSteps",
  "migratedTasks",
  "adoptedAgentDefaults",
  "runtimeDriftNotices",
] as const;

const sortedProjectRows = (rows: readonly ProjectRow[]): ProjectRow[] => [...rows].sort((left, right) => (
  left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0
));

const emptyProjectCounters = (
  templateSources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
  roleNames: readonly string[],
): ProjectCounters => ({
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
  updatedSteps: Object.fromEntries([...templateSources].map(([name, steps]) => [
    name,
    Object.fromEntries(steps.map((step) => [step.stepIndex, 0])),
  ])),
  updatedRoles: Object.fromEntries(roleNames.map((name) => [name, 0])),
});

const finalizeUpdated = (counters: ProjectCounters): void => {
  const scalar = mutationCounterNames.reduce((sum, name) => sum + counters[name], 0);
  const steps = Object.values(counters.updatedSteps)
    .flatMap((byStep) => Object.values(byStep))
    .reduce((sum, count) => sum + count, 0);
  const roles = Object.values(counters.updatedRoles).reduce((sum, count) => sum + count, 0);
  counters.updated = scalar + steps + roles;
};

const projectError = (project: ProjectRow, message: string): Error => new Error(`Project ${project.slug}: ${message}`);

const projectFor = (projects: ProjectMap, projectId: string): ProjectRow => {
  const project = projects.get(projectId);
  if (!project) throw new Error(`Project ${projectId} was not found`);
  return project;
};

const increment = <K extends keyof ProjectCounters>(
  countersByProject: Map<string, ProjectCounters>,
  projectId: string,
  field: K,
  amount = 1,
): void => {
  const counters = countersByProject.get(projectId);
  if (!counters) throw new Error(`Project ${projectId} was not found`);
  const value = counters[field];
  if (typeof value !== "number") throw new Error(`Project ${projectId} counter ${String(field)} is not scalar`);
  (counters[field] as number) = value + amount;
};

const addPreserved = (
  countersByProject: Map<string, ProjectCounters>,
  projectId: string,
  field: keyof PreservedTaskAssignments,
): void => {
  const counters = countersByProject.get(projectId);
  if (!counters) throw new Error(`Project ${projectId} was not found`);
  counters.preservedTaskAssignments[field] += 1;
};

const addStepUpdate = (
  countersByProject: Map<string, ProjectCounters>,
  projectId: string,
  templateName: string,
  stepIndex: number,
  amount: number,
): void => {
  const counters = countersByProject.get(projectId);
  if (!counters) throw new Error(`Project ${projectId} was not found`);
  const byStep = counters.updatedSteps[templateName];
  if (!byStep || byStep[stepIndex] === undefined) {
    throw new Error(`Project ${projectId} has no counter for ${templateName} step ${stepIndex}`);
  }
  byStep[stepIndex] += amount;
};

const addRoleUpdate = (
  countersByProject: Map<string, ProjectCounters>,
  projectId: string,
  roleName: string,
  amount: number,
): void => {
  const counters = countersByProject.get(projectId);
  if (!counters) throw new Error(`Project ${projectId} was not found`);
  if (counters.updatedRoles[roleName] === undefined) {
    throw new Error(`Project ${projectId} has no counter for Agent ${roleName}`);
  }
  counters.updatedRoles[roleName] += amount;
};

const transitionStepInclude = {
  assigneeAgent: { select: { name: true } },
  _count: { select: { tasks: true } },
} as const;

const readCanonicalTemplateRows = async (tx: Prisma.TransactionClient, name: CanonicalTemplateName) => tx.taskTemplate.findMany({
  where: { name },
  include: { steps: { orderBy: { stepIndex: "asc" }, include: transitionStepInclude } },
});

const readCanonicalInstallationRows = async (
  tx: Prisma.TransactionClient,
  templateSources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
): Promise<CanonicalInstallationRow[]> => {
  const installationRows: CanonicalInstallationRow[] = [];
  for (const templateName of templateSources.keys()) {
    const rows = await readCanonicalTemplateRows(tx, templateName);
    installationRows.push(...rows.map((row) => ({
      ...row,
      name: templateName,
      steps: row.steps as unknown as CanonicalInstallationRow["steps"],
    })));
  }
  return installationRows;
};

export const parseInstallFullProjectId = (args: readonly string[] = process.argv.slice(2)): string | null => {
  if (args.length === 0) return null;
  if (args[0] !== "--install-full") throw new Error(`Unknown argument ${args[0]}`);
  const projectId = args[1];
  if (args.length !== 2 || !projectId) {
    throw new Error("--install-full requires exactly one Project id");
  }
  return projectId;
};

type FullInstallTarget = ProjectRow & { environmentId: string };

const preflightFullInstallTarget = async (
  tx: Prisma.TransactionClient,
  requestedId: string,
  roleNames: readonly string[],
): Promise<FullInstallTarget> => {
  const target = await tx.project.findUnique({
    where: { id: requestedId },
    select: {
      id: true,
      slug: true,
      environments: { select: { id: true, name: true } },
    },
  });
  if (!target) throw new Error(`Project ${requestedId} was not found`);
  const project = { id: target.id, slug: target.slug };
  if (target.environments.length === 0) {
    throw projectError(project, `Project has no Environment; --install-full requires exactly one`);
  }
  if (target.environments.length !== 1) {
    throw projectError(project, `Project has ${target.environments.length} Environments; --install-full requires exactly one`);
  }
  const archived = await tx.agent.findFirst({
    where: { projectId: target.id, name: { in: [...roleNames] }, archivedAt: { not: null } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  if (archived) {
    throw projectError(project, `Agent ${archived.name} (${archived.id}) is archived; --install-full will not resurrect it`);
  }
  return { ...project, environmentId: target.environments[0]!.id };
};

const createSpecialCanonicalAgent = async (
  tx: Prisma.TransactionClient,
  project: ProjectRow,
  sources: AgentSources,
  role: RoleSource,
  sourceName: string,
  permissions: RepoPermission | null,
): Promise<{ created: boolean; grants: number }> => {
  const existing = await tx.agent.findUnique({
    where: { projectId_name: { projectId: project.id, name: role.name } },
    select: { id: true, archivedAt: true },
  });
  if (existing?.archivedAt) {
    throw projectError(project, `Agent ${role.name} (${existing.id}) is archived; sync will not resurrect it`);
  }
  if (existing) return { created: false, grants: 0 };

  const source = await tx.agent.findUnique({
    where: { projectId_name: { projectId: project.id, name: sourceName } },
    select: {
      id: true,
      environmentId: true,
      disabledTools: true,
      archivedAt: true,
      repoAccess: { select: { projectId: true, repoId: true, mountPath: true, permissions: true } },
    },
  });
  if (!source || source.archivedAt) {
    throw projectError(project, `Cannot create ${role.name}: active source Agent ${sourceName} was not found`);
  }
  const created = await tx.agent.create({ data: {
    projectId: project.id,
    environmentId: source.environmentId,
    name: role.name,
    title: role.title,
    model: role.model,
    runnerPreference: role.runnerPreference,
    inboxAccess: role.inboxAccess,
    disabledTools: source.disabledTools,
    foundationalPrompt: sources.foundationalPrompt,
    rolePrompt: role.rolePrompt,
    runtimeConfigCustomized: false,
    runtimeConfigDriftNoticeFingerprint: null,
    codexServiceTier: CodexServiceTier.DEFAULT,
    archivedAt: null,
  } });
  const grants = source.repoAccess.length === 0
    ? 0
    : (await tx.agentRepoAccess.createMany({ data: source.repoAccess.map((grant) => ({
      ...grant,
      agentId: created.id,
      ...(permissions === null ? {} : { permissions }),
    })) })).count;
  return { created: true, grants };
};

const migrateSpecialCanonicalAgents = async (
  tx: Prisma.TransactionClient,
  canonicalProject: ProjectRow,
  sources: AgentSources,
  rolesByName: ReadonlyMap<string, RoleSource>,
  countersByProject: Map<string, ProjectCounters>,
): Promise<void> => {
  const regressionRole = rolesByName.get(REGRESSION_AGENT_NAME);
  if (!regressionRole) throw projectError(canonicalProject, `Canonical role ${REGRESSION_AGENT_NAME} was not found`);
  const regression = await createSpecialCanonicalAgent(
    tx,
    canonicalProject,
    sources,
    regressionRole,
    REGRESSION_AGENT_SOURCE,
    null,
  );
  if (regression.created) increment(countersByProject, canonicalProject.id, "createdAgents");
  if (regression.grants > 0) increment(countersByProject, canonicalProject.id, "createdAgentRepoGrants", regression.grants);

  const revalidatorRole = rolesByName.get(SPEC_REVALIDATOR_AGENT_NAME);
  if (!revalidatorRole) throw projectError(canonicalProject, `Canonical role ${SPEC_REVALIDATOR_AGENT_NAME} was not found`);
  const revalidator = await createSpecialCanonicalAgent(
    tx,
    canonicalProject,
    sources,
    revalidatorRole,
    SPEC_REVALIDATOR_AGENT_SOURCE,
    RepoPermission.GIT_READ,
  );
  if (revalidator.created) increment(countersByProject, canonicalProject.id, "createdAgents");
  if (revalidator.grants > 0) increment(countersByProject, canonicalProject.id, "createdAgentRepoGrants", revalidator.grants);
};

const installMissingAgents = async (
  tx: Prisma.TransactionClient,
  target: FullInstallTarget,
  sources: AgentSources,
  rolesByName: ReadonlyMap<string, RoleSource>,
  roleNames: readonly string[],
  countersByProject: Map<string, ProjectCounters>,
): Promise<void> => {
  const existing = await tx.agent.findMany({
    where: { projectId: target.id, archivedAt: null, name: { in: [...roleNames] } },
    select: { id: true, name: true },
  });
  const existingNames = new Set(existing.map(({ name }) => name));
  const createdNames = new Set<string>();
  for (const name of roleNames) {
    if (existingNames.has(name)) continue;
    const role = rolesByName.get(name);
    if (!role) throw projectError(target, `Canonical role ${name} was not found in sources`);
    await tx.agent.create({ data: {
      projectId: target.id,
      environmentId: target.environmentId,
      name: role.name,
      title: role.title,
      model: role.model,
      runnerPreference: role.runnerPreference,
      inboxAccess: role.inboxAccess,
      foundationalPrompt: sources.foundationalPrompt,
      rolePrompt: role.rolePrompt,
      runtimeConfigCustomized: false,
      runtimeConfigDriftNoticeFingerprint: null,
      codexServiceTier: CodexServiceTier.DEFAULT,
      disabledTools: [],
      archivedAt: null,
    } });
    createdNames.add(name);
    increment(countersByProject, target.id, "createdAgents");
  }

  if (createdNames.size === 0) return;
  const targetAgents = await tx.agent.findMany({
    where: { projectId: target.id, archivedAt: null, name: { in: [...roleNames] } },
    select: { id: true, name: true },
  });
  const agentByName = new Map(targetAgents.map((agent) => [agent.name, agent.id]));
  for (const name of createdNames) {
    const role = rolesByName.get(name)!;
    const agentId = agentByName.get(name);
    if (!agentId) throw projectError(target, `Agent ${name} was not found after installation`);
    for (const collaboratorName of role.collaborators) {
      const allowedAgentId = agentByName.get(collaboratorName);
      if (!allowedAgentId) {
        throw projectError(target, `Agent ${name} references unknown collaborator ${collaboratorName}`);
      }
      await tx.agentCollaboration.create({ data: {
        agentId,
        allowedAgentId,
        projectId: target.id,
      } });
    }
  }
};

type PersistedCanonicalAgent = {
  id: string;
  projectId: string;
  name: string;
  archivedAt: Date | null;
  title: string;
  model: string;
  runtimeConfigCustomized: boolean;
  runtimeConfigDriftNoticeFingerprint: string | null;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  collaborators: { allowedAgent: { name: string } }[];
};

const synchronizeAgents = async (
  tx: Prisma.TransactionClient,
  projects: ProjectMap,
  canonicalProject: ProjectRow,
  sources: AgentSources,
  rolesByName: ReadonlyMap<string, RoleSource>,
  roleNames: readonly string[],
  countersByProject: Map<string, ProjectCounters>,
  runtimeConfigAdoptions: Array<{
    name: string;
    from: { model: string; runnerPreference: RunnerPreference };
    to: { model: string; runnerPreference: RunnerPreference };
  }>,
): Promise<void> => {
  const canonicalAgentRows = await tx.agent.findMany({
    where: { name: { in: [...roleNames] } },
    select: {
      id: true,
      projectId: true,
      name: true,
      archivedAt: true,
      title: true,
      model: true,
      runtimeConfigCustomized: true,
      runtimeConfigDriftNoticeFingerprint: true,
      runnerPreference: true,
      inboxAccess: true,
      collaborators: { select: { allowedAgent: { select: { name: true } } } },
    },
  });
  const presentAgents = canonicalAgentRows.filter((agent) => agent.archivedAt === null);
  const byProject = new Map<string, PersistedCanonicalAgent[]>();
  for (const agent of presentAgents) {
    const list = byProject.get(agent.projectId) ?? [];
    list.push(agent);
    byProject.set(agent.projectId, list);
  }
  const canonicalAgents = byProject.get(canonicalProject.id) ?? [];
  const canonicalNames = new Set(canonicalAgents.map(({ name }) => name));
  for (const name of roleNames) {
    if (canonicalNames.has(name)) continue;
    const archived = canonicalAgentRows.find((agent) => (
      agent.projectId === canonicalProject.id && agent.name === name && agent.archivedAt !== null
    ));
    if (archived) throw projectError(canonicalProject, `Agent ${name} (${archived.id}) is archived`);
    throw projectError(canonicalProject, `Agent ${name} was not found`);
  }

  for (const agent of presentAgents) {
    const project = projectFor(projects, agent.projectId);
    const role = rolesByName.get(agent.name);
    if (!role) continue;
    const differences = roleSourceStructureDifferences(agent, role);
    const runtimeDifferences = differences.filter((difference) => difference === "model" || difference === "runnerPreference");
    const structuralDifferences = differences.filter((difference) => difference !== "model" && difference !== "runnerPreference");
    const runtimeRefusal = runtimeConfigRefusal(agent);
    if (structuralDifferences.length > 0) {
      throw projectError(project, `Agent ${agent.name} (${agent.id}) differs from canonical Markdown structure: ${structuralDifferences.join(", ")}`);
    }
    if (runtimeRefusal) {
      throw projectError(project, `Agent ${agent.name} (${agent.id}) has an invalid runtime configuration: ${runtimeRefusal}`);
    }
    const adoptsCanonicalDefaults = runtimeDifferences.length > 0 && !agent.runtimeConfigCustomized;
    if (adoptsCanonicalDefaults) {
      const adopted = await tx.agent.updateMany({
        where: {
          id: agent.id,
          model: agent.model,
          runnerPreference: agent.runnerPreference,
          runtimeConfigCustomized: false,
        },
        data: {
          model: role.model,
          runnerPreference: role.runnerPreference,
          runtimeConfigDriftNoticeFingerprint: null,
        },
      });
      if (adopted.count !== 1) {
        throw projectError(project, `Agent ${agent.name} (${agent.id}) changed while its canonical runtime configuration was being adopted`);
      }
      increment(countersByProject, project.id, "adoptedAgentDefaults");
      runtimeConfigAdoptions.push({
        name: agent.name,
        from: { model: agent.model, runnerPreference: agent.runnerPreference },
        to: { model: role.model, runnerPreference: role.runnerPreference },
      });
    }
    if (runtimeDifferences.length > 0 && agent.runtimeConfigCustomized) {
      const fingerprint = JSON.stringify({
        canonical: { model: role.model, runnerPreference: role.runnerPreference },
        production: { model: agent.model, runnerPreference: agent.runnerPreference },
      });
      if (agent.runtimeConfigDriftNoticeFingerprint !== fingerprint) {
        const claimed = await tx.agent.updateMany({
          where: {
            id: agent.id,
            model: agent.model,
            runnerPreference: agent.runnerPreference,
            runtimeConfigCustomized: true,
            runtimeConfigDriftNoticeFingerprint: agent.runtimeConfigDriftNoticeFingerprint,
          },
          data: { runtimeConfigDriftNoticeFingerprint: fingerprint },
        });
        if (claimed.count !== 1) {
          throw projectError(project, `Agent ${agent.name} (${agent.id}) changed while canonical runtime drift was being recorded`);
        }
        const chatId = process.env["FEISHU_DEFAULT_CHAT_ID"];
        const thread = chatId ? (
          await tx.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
          ?? await tx.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } }).catch(() => null)
        ) : null;
        await tx.inboxMessage.create({ data: {
          from: "AGENT",
          agentId: agent.id,
          kind: "TEXT",
          body: [
            "Canonical runtime drift detected",
            `Agent: ${agent.name}`,
            `Canonical: model=${role.model}, runner=${role.runnerPreference}`,
            `Production: model=${agent.model}, runner=${agent.runnerPreference}`,
            `runtimeConfigCustomized=${agent.runtimeConfigCustomized}`,
          ].join("\n"),
          ...(thread ? { threadId: thread.id } : {}),
        } });
        increment(countersByProject, project.id, "runtimeDriftNotices");
      }
    } else if (!adoptsCanonicalDefaults && agent.runtimeConfigDriftNoticeFingerprint !== null) {
      await tx.agent.updateMany({
        where: {
          id: agent.id,
          model: agent.model,
          runnerPreference: agent.runnerPreference,
          runtimeConfigCustomized: agent.runtimeConfigCustomized,
          runtimeConfigDriftNoticeFingerprint: agent.runtimeConfigDriftNoticeFingerprint,
        },
        data: { runtimeConfigDriftNoticeFingerprint: null },
      });
    }

    const promptUpdate = await tx.agent.updateMany({
      where: {
        id: agent.id,
        archivedAt: null,
        OR: [
          { foundationalPrompt: { not: sources.foundationalPrompt } },
          { rolePrompt: { not: role.rolePrompt } },
        ],
      },
      data: { foundationalPrompt: sources.foundationalPrompt, rolePrompt: role.rolePrompt },
    });
    if (promptUpdate.count > 0) addRoleUpdate(countersByProject, project.id, role.name, promptUpdate.count);
  }
};

type RegressionStep = { id: string; projectId: string; templateName: CanonicalTemplateName; stepIndex: number; templateId: string };

const syncCanonicalTemplates = async (
  tx: Prisma.TransactionClient,
  projects: ProjectMap,
  templateSources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
  countersByProject: Map<string, ProjectCounters>,
): Promise<RegressionStep[]> => {
  const regressionSteps: RegressionStep[] = [];
  for (const [templateName, steps] of templateSources) {
    const templates = await tx.taskTemplate.findMany({
      where: { name: templateName },
      select: { id: true, projectId: true },
    });
    if (templates.length === 0) {
      throw new Error(`Template ${templateName} was not found`);
    }
    for (const template of templates) {
      const project = projectFor(projects, template.projectId);
      increment(countersByProject, project.id, "templates");
      const persistedSteps = await tx.taskTemplateStep.findMany({
        where: { taskTemplateId: template.id },
        select: {
          id: true,
          stepIndex: true,
          name: true,
          taskTemplateId: true,
          prompt: true,
          layer: true,
          assigneeAgentId: true,
          assigneeAgent: { select: { name: true } },
          assigneeType: true,
          approvalGate: true,
          outputKind: true,
          attachmentsFromPrevious: true,
          priorOutputKinds: true,
          opensPullRequest: true,
          requiresCommit: true,
          baseFromStepIndex: true,
          spawnPolicy: true,
          _count: { select: { tasks: true } },
        },
        orderBy: { stepIndex: "asc" },
      });
      if (persistedSteps.length !== steps.length) {
        throw projectError(project, `Template ${templateName} (${template.id}) has structural drift: expected ${steps.length} steps, found ${persistedSteps.length}`);
      }
      const persistedByIndex = new Map(persistedSteps.map((step) => [step.stepIndex, step]));
      for (const step of steps) {
        const persisted = persistedByIndex.get(step.stepIndex);
        if (!persisted) {
          const expectedIndexes = new Set(steps.map((source) => source.stepIndex));
          const unexpected = persistedSteps.find((candidate) => !expectedIndexes.has(candidate.stepIndex));
          if (unexpected) {
            throw projectError(
              project,
              `Template ${templateName} (${template.id}), ${templateName} step ${unexpected.stepIndex} (${unexpected.id}) has structural drift: expected canonical step ${step.stepIndex}`,
            );
          }
          throw projectError(project, `Template ${templateName} (${template.id}) step ${step.stepIndex} was not found`);
        }
        const differences = templateStepStructureDifferences(persisted, step);
        const transition = ASSIGNEE_TRANSITIONS.get(`${templateName}:${step.stepIndex}`);
        const adoptsCanonicalAssignee = differences.includes("agent")
          && transition?.from.includes(persisted.assigneeAgent?.name ?? null) === true
          && transition.to === step.agentName;
        const baseTransition = STEP_BASE_TRANSITIONS.get(`${templateName}:${step.stepIndex}`);
        const adoptsCanonicalBase = differences.includes("baseFromStepIndex")
          && baseTransition?.from === persisted.baseFromStepIndex
          && baseTransition.to === step.baseFromStepIndex;
        const adoptsCanonicalPriorOutput = differences.includes("priorOutputKinds")
          && persisted.priorOutputKinds.length === 1
          && persisted.priorOutputKinds[0] === LEGACY_ALL_PRIOR_OUTPUTS;
        const nameTransition = STEP_NAME_TRANSITIONS.get(`${templateName}:${step.stepIndex}`);
        const adoptsCanonicalName = differences.includes("name")
          && nameTransition?.from === persisted.name
          && nameTransition.to === step.name;
        const adoptedDifferences = new Set([
          ...(adoptsCanonicalAssignee ? ["agent"] : []),
          ...(adoptsCanonicalBase ? ["baseFromStepIndex"] : []),
          ...(adoptsCanonicalPriorOutput ? ["priorOutputKinds"] : []),
          ...(adoptsCanonicalName ? ["name"] : []),
        ]);
        if (differences.some((difference) => !adoptedDifferences.has(difference))) {
          throw projectError(
            project,
            `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) differs from canonical Markdown structure: ${differences.join(", ")}`,
          );
        }
        const protectInUse = (): void => {
          if (persisted._count.tasks > 0) {
            throw projectError(
              project,
              `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) is referenced by instantiated tasks; canonical sync will not mutate it`,
            );
          }
        };
        if (adoptsCanonicalAssignee) {
          protectInUse();
          const assignee = step.agentName === null
            ? null
            : await tx.agent.findFirst({
              where: { projectId: template.projectId, name: transition!.to, archivedAt: null },
              select: { id: true },
            });
          if (step.agentName !== null && !assignee) {
            throw projectError(
              project,
              `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) cannot adopt ${transition!.to}: active target Agent was not found`,
            );
          }
          await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: { assigneeAgentId: assignee?.id ?? null } });
          increment(countersByProject, project.id, "adoptedAssignees");
        }
        if (adoptsCanonicalBase) {
          protectInUse();
          await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: { baseFromStepIndex: baseTransition!.to } });
          increment(countersByProject, project.id, "adoptedStepBases");
        }
        if (adoptsCanonicalPriorOutput) {
          await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: { priorOutputKinds: step.priorOutputKinds } });
          increment(countersByProject, project.id, "adoptedPriorOutputDeclarations");
        }
        if (adoptsCanonicalName) {
          protectInUse();
          await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: { name: nameTransition!.to } });
          increment(countersByProject, project.id, "renamedSteps");
        }
        if (step.agentName === REGRESSION_AGENT_NAME) {
          regressionSteps.push({
            id: persisted.id,
            projectId: template.projectId,
            templateName,
            stepIndex: step.stepIndex,
            templateId: template.id,
          });
        }
        if (persisted._count.tasks > 0 && persisted.prompt !== step.prompt) {
          throw projectError(
            project,
            `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) is referenced by instantiated tasks; canonical sync will not mutate its prompt`,
          );
        }
        if (persisted.prompt !== step.prompt) {
          await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: { prompt: step.prompt } });
          addStepUpdate(countersByProject, project.id, templateName, step.stepIndex, 1);
        }
      }
    }
  }
  return regressionSteps;
};

const migrateRegressionTasks = async (
  tx: Prisma.TransactionClient,
  projects: ProjectMap,
  regressionSteps: readonly RegressionStep[],
  countersByProject: Map<string, ProjectCounters>,
): Promise<void> => {
  for (const step of regressionSteps) {
    const project = projectFor(projects, step.projectId);
    const target = await tx.agent.findFirst({
      where: { projectId: step.projectId, name: REGRESSION_AGENT_NAME, archivedAt: null },
      select: { id: true },
    });
    if (!target) {
      throw projectError(
        project,
        `Template ${step.templateName} (${step.templateId}), ${step.templateName} step ${step.stepIndex} (${step.id}) has no active ${REGRESSION_AGENT_NAME} Agent`,
      );
    }
    const tasks = await tx.task.findMany({
      where: {
        templateStepId: step.id,
        assigneeAgent: { name: { in: ["review-coordinator-opus", "review-coordinator-sol"] } },
      },
      select: {
        id: true,
        assigneeAgentId: true,
        status: true,
        archivedAt: true,
        _count: { select: { runs: true, sessions: true } },
        stepOutput: { select: { id: true } },
      },
    });
    for (const task of tasks) {
      if (task.archivedAt) {
        addPreserved(countersByProject, step.projectId, "archived");
        continue;
      }
      if (task.status !== TaskStatus.TODO) {
        addPreserved(countersByProject, step.projectId, "nonTodo");
        continue;
      }
      if (task._count.runs > 0 || task._count.sessions > 0) {
        addPreserved(countersByProject, step.projectId, "started");
        continue;
      }
      if (task.stepOutput) {
        addPreserved(countersByProject, step.projectId, "output");
        continue;
      }
      const adopted = await tx.task.updateMany({
        where: {
          id: task.id,
          assigneeAgentId: task.assigneeAgentId,
          status: TaskStatus.TODO,
          archivedAt: null,
          runs: { none: {} },
          sessions: { none: {} },
          stepOutput: { is: null },
        },
        data: { assigneeAgentId: target.id },
      });
      if (adopted.count !== 1) {
        throw projectError(project, `Regression task ${task.id} changed while canonical routing was being adopted`);
      }
      await tx.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: `Canonical routing reassigned this unstarted regression step to ${REGRESSION_AGENT_NAME}`,
        metadata: {
          kind: "canonicalRouting.regressionVerifier",
          schemaVersion: 1,
          fromAgentId: task.assigneeAgentId,
          toAgentId: target.id,
        },
      } });
      increment(countersByProject, step.projectId, "migratedTasks");
    }
  }
};

const sumCounters = (
  projectRows: readonly ProjectRow[],
  countersByProject: Map<string, ProjectCounters>,
  templateSources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
  roleNames: readonly string[],
): ProjectCounters => {
  const total = emptyProjectCounters(templateSources, roleNames);
  for (const project of projectRows) {
    const counters = countersByProject.get(project.id);
    if (!counters) continue;
    total.templates += counters.templates;
    for (const name of mutationCounterNames) total[name] += counters[name];
    for (const field of Object.keys(total.preservedTaskAssignments) as (keyof PreservedTaskAssignments)[]) {
      total.preservedTaskAssignments[field] += counters.preservedTaskAssignments[field];
    }
    for (const [templateName, byStep] of Object.entries(counters.updatedSteps)) {
      for (const [stepIndex, count] of Object.entries(byStep)) {
        total.updatedSteps[templateName]![Number(stepIndex)]! += count;
      }
    }
    for (const [roleName, count] of Object.entries(counters.updatedRoles)) total.updatedRoles[roleName]! += count;
  }
  finalizeUpdated(total);
  return total;
};

export const main = async (
  database?: PrismaClient,
  requestedInstallFullProjectId?: string | null,
): Promise<void> => {
  const installFullProjectId = requestedInstallFullProjectId === undefined
    ? parseInstallFullProjectId()
    : requestedInstallFullProjectId;
  const [templateSources, sources] = await Promise.all([loadAllTemplateStepSources(), loadAgentSources()]);
  const rolesByName = new Map(sources.roles.map((role) => [role.name, role]));
  const roleNames = [...rolesByName.keys()];

  const prisma = database ?? new PrismaClient();
  const ownsPrisma = database === undefined;
  try {
    if (installFullProjectId !== null) {
      const requested = await prisma.project.findUnique({ where: { id: installFullProjectId }, select: { id: true } });
      if (!requested) throw new Error(`Project ${installFullProjectId} was not found`);
    }

    const result = await prisma.$transaction(async (tx) => {
      // This read is intentionally first in the transaction. The full-install
      // target and its complete Environment set are re-read after outer
      // preflight and before any write, so deletion or topology drift fails
      // closed without a partial installation.
      const fullInstallTarget = installFullProjectId === null
        ? null
        : await preflightFullInstallTarget(tx, installFullProjectId, roleNames);
      const projectRows = sortedProjectRows(await tx.project.findMany({
        select: { id: true, slug: true },
        orderBy: { slug: "asc" },
      }));
      const projects = new Map(projectRows.map((project) => [project.id, project]));
      const canonicalProject = projectRows.find(({ slug }) => slug === "agentos-example");
      if (!canonicalProject) throw new Error("Canonical project agentos-example was not found");
      if (fullInstallTarget && !projects.has(fullInstallTarget.id)) {
        throw new Error(`Project ${installFullProjectId} was not found`);
      }
      const countersByProject = new Map(projectRows.map((project) => [
        project.id,
        emptyProjectCounters(templateSources, roleNames),
      ]));

      const installationRows = await readCanonicalInstallationRows(tx, templateSources);
      const installationPlan = planCanonicalInstallation(installationRows, templateSources, [canonicalProject.id]);
      const plannedRefusal = installationPlan.find((action): action is Extract<CanonicalInstallationAction, { kind: "refused" }> => action.kind === "refused");
      if (plannedRefusal) {
        const project = projectFor(projects, plannedRefusal.projectId);
        throw projectError(project, plannedRefusal.reason);
      }
      for (const action of installationPlan) {
        if (action.kind === "create" || action.kind === "rollover") {
          increment(countersByProject, action.projectId, "createdCanonicalTemplates");
        }
      }

      await migrateSpecialCanonicalAgents(tx, canonicalProject, sources, rolesByName, countersByProject);

      const runtimeConfigAdoptions: Array<{
        name: string;
        from: { model: string; runnerPreference: RunnerPreference };
        to: { model: string; runnerPreference: RunnerPreference };
      }> = [];
      await synchronizeAgents(
        tx,
        projects,
        canonicalProject,
        sources,
        rolesByName,
        roleNames,
        countersByProject,
        runtimeConfigAdoptions,
      );

      await applyCanonicalInstallation(tx, installationPlan, templateSources, {
        projectLabel: (projectId) => projects.get(projectId)?.slug,
      });
      const regressionSteps = await syncCanonicalTemplates(tx, projects, templateSources, countersByProject);
      await migrateRegressionTasks(tx, projects, regressionSteps, countersByProject);

      if (fullInstallTarget) {
        await installMissingAgents(tx, fullInstallTarget, sources, rolesByName, roleNames, countersByProject);
        const postSyncRows = await readCanonicalInstallationRows(tx, templateSources);
        const fullInstallationPlan = planCanonicalInstallation(
          postSyncRows,
          templateSources,
          [fullInstallTarget.id],
        );
        for (const action of fullInstallationPlan) {
          if (action.kind === "create" || action.kind === "rollover") {
            increment(countersByProject, action.projectId, "createdCanonicalTemplates");
          }
        }
        await applyCanonicalInstallation(tx, fullInstallationPlan, templateSources, {
          projectLabel: (projectId) => projects.get(projectId)?.slug,
        });
      }
      for (const counters of countersByProject.values()) finalizeUpdated(counters);
      return { projectRows, countersByProject, runtimeConfigAdoptions };
    }, { timeout: 120_000 });

    for (const adoption of result.runtimeConfigAdoptions) {
      console.log(
        `Canonical runtime config adopted for Agent ${adoption.name}: `
        + `from model=${adoption.from.model}, runnerPreference=${adoption.from.runnerPreference} `
        + `to model=${adoption.to.model}, runnerPreference=${adoption.to.runnerPreference}`,
      );
    }
    const projects = Object.fromEntries(sortedProjectRows(result.projectRows).map((project) => [
      project.slug,
      result.countersByProject.get(project.id)!,
    ]));
    const totals = sumCounters(result.projectRows, result.countersByProject, templateSources, roleNames);
    console.log(JSON.stringify({ projects, totals }));
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
};

const invokedScript = process.argv[1];
if (invokedScript && fileURLToPath(import.meta.url) === resolve(invokedScript)) await main();
