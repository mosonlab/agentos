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
  canonicalStepAdoptions,
  canonicalStepDrift,
  REGRESSION_VERIFIER_AGENT_NAME,
  SPEC_REVALIDATOR_AGENT_NAME,
} from "../src/canonical-step-adoption.js";
import {
  canonicalSyncSummary,
  canonicalSyncSummaryLine,
  emptyCanonicalSyncCounters,
  recordRolePromptUpdate,
  recordStepPromptUpdate,
  type CanonicalSyncCounters,
  type CanonicalSyncProjectOutcome,
} from "../src/canonical-sync-report.js";
import {
  applyCanonicalInstallation,
  planCanonicalInstallation,
  type CanonicalInstallationAction,
  type CanonicalInstallationRow,
} from "../src/canonical-template-installation.js";
import {
  loadAllTemplateStepSources,
  type CanonicalTemplateName,
  type TemplateStepSource,
} from "../src/template-sources.js";

const SENIOR_DEV_SOL_AGENT_NAME = "senior-dev-sol";
const SENIOR_DEV_OPUS_AGENT_NAME = "senior-dev-opus";

// Canonical roles that no template step binds, so ordinary synchronization
// never creates them: each is created once from an active source Agent row.
const SPECIAL_CANONICAL_AGENTS: readonly {
  name: string;
  source: string;
  permissions: RepoPermission | null;
}[] = [
  { name: REGRESSION_VERIFIER_AGENT_NAME, source: "review-coordinator-sol", permissions: null },
  { name: SPEC_REVALIDATOR_AGENT_NAME, source: "review-coordinator-sol", permissions: RepoPermission.GIT_READ },
  { name: SENIOR_DEV_SOL_AGENT_NAME, source: "senior-dev", permissions: null },
  { name: SENIOR_DEV_OPUS_AGENT_NAME, source: "senior-dev", permissions: null },
];

const runtimeConfigRefusal = (agent: { model: string; runnerPreference: RunnerPreference }): string | null => {
  const expected = catalogRunnerForModel(agent.model);
  if (!expected || agent.runnerPreference === RunnerPreference.AUTO || agent.runnerPreference === RunnerPreference.INHERIT
    || expected === agent.runnerPreference) return null;
  return `Model ${agent.model} requires ${expected}, but this Agent stores ${agent.runnerPreference}`;
};

type ProjectRow = { id: string; slug: string };

const sortedProjectRows = (rows: readonly ProjectRow[]): ProjectRow[] => [...rows].sort((left, right) => (
  left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0
));

const projectError = (project: ProjectRow, message: string): Error => new Error(`Project ${project.slug}: ${message}`);

const transitionStepInclude = {
  assigneeAgent: { select: { name: true } },
  _count: { select: { tasks: true } },
} as const;

const readCanonicalTemplateRows = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  name: CanonicalTemplateName,
) => tx.taskTemplate.findMany({
  where: { projectId, name },
  include: { steps: { orderBy: { stepIndex: "asc" }, include: transitionStepInclude } },
});

const readCanonicalInstallationRows = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  templateSources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
): Promise<CanonicalInstallationRow[]> => {
  const installationRows: CanonicalInstallationRow[] = [];
  for (const templateName of templateSources.keys()) {
    const rows = await readCanonicalTemplateRows(tx, projectId, templateName);
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
  counters: CanonicalSyncCounters,
): Promise<void> => {
  for (const special of SPECIAL_CANONICAL_AGENTS) {
    const role = rolesByName.get(special.name);
    if (!role) throw projectError(canonicalProject, `Canonical role ${special.name} was not found`);
    const outcome = await createSpecialCanonicalAgent(
      tx,
      canonicalProject,
      sources,
      role,
      special.source,
      special.permissions,
    );
    if (outcome.created) counters.createdAgents += 1;
    if (outcome.grants > 0) counters.createdAgentRepoGrants += outcome.grants;
  }
};

const installMissingAgents = async (
  tx: Prisma.TransactionClient,
  target: FullInstallTarget,
  sources: AgentSources,
  rolesByName: ReadonlyMap<string, RoleSource>,
  roleNames: readonly string[],
  counters: CanonicalSyncCounters,
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
    counters.createdAgents += 1;
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

const synchronizeAgents = async (
  tx: Prisma.TransactionClient,
  project: ProjectRow,
  requireCompleteInventory: boolean,
  sources: AgentSources,
  rolesByName: ReadonlyMap<string, RoleSource>,
  roleNames: readonly string[],
  counters: CanonicalSyncCounters,
  runtimeConfigAdoptions: Array<{
    name: string;
    from: { model: string; runnerPreference: RunnerPreference };
    to: { model: string; runnerPreference: RunnerPreference };
  }>,
): Promise<void> => {
  const canonicalAgentRows = await tx.agent.findMany({
    where: { projectId: project.id, name: { in: [...roleNames] } },
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
  if (requireCompleteInventory) {
    const canonicalNames = new Set(presentAgents.map(({ name }) => name));
    for (const name of roleNames) {
      if (canonicalNames.has(name)) continue;
      const archived = canonicalAgentRows.find((agent) => agent.name === name && agent.archivedAt !== null);
      if (archived) throw projectError(project, `Agent ${name} (${archived.id}) is archived`);
      throw projectError(project, `Agent ${name} was not found`);
    }
  }

  for (const agent of presentAgents) {
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
      counters.adoptedAgentDefaults += 1;
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
        counters.runtimeDriftNotices += 1;
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
    if (promptUpdate.count > 0) recordRolePromptUpdate(counters, role.name, promptUpdate.count);
  }
};

type RegressionStep = { id: string; templateName: CanonicalTemplateName; stepIndex: number; templateId: string };

const syncCanonicalTemplates = async (
  tx: Prisma.TransactionClient,
  project: ProjectRow,
  templateSources: ReadonlyMap<CanonicalTemplateName, readonly TemplateStepSource[]>,
  counters: CanonicalSyncCounters,
): Promise<RegressionStep[]> => {
  const regressionSteps: RegressionStep[] = [];
  for (const [templateName, steps] of templateSources) {
    const templates = await tx.taskTemplate.findMany({
      where: { projectId: project.id, name: templateName },
      select: { id: true, projectId: true },
    });
    for (const template of templates) {
      counters.templates += 1;
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
          optional: true,
          outputKind: true,
          attachmentsFromPrevious: true,
          priorOutputKinds: true,
          opensPullRequest: true,
          requiresCommit: true,
          provisionDependencies: true,
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
        const drift = canonicalStepDrift(templateName, persisted, step, "adopt");
        if (drift.length > 0) {
          throw projectError(
            project,
            `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) differs from canonical Markdown structure: ${drift.join(", ")}`,
          );
        }
        for (const adoption of canonicalStepAdoptions(templateName, persisted, step)) {
          if (adoption.refusesReferencedStep && persisted._count.tasks > 0) {
            throw projectError(
              project,
              `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) is referenced by instantiated tasks; canonical sync will not mutate it`,
            );
          }
          if (adoption.write.kind === "bind-agent") {
            const assignee = await tx.agent.findFirst({
              where: { projectId: template.projectId, name: adoption.write.agentName, archivedAt: null },
              select: { id: true },
            });
            if (!assignee) {
              throw projectError(
                project,
                `Template ${templateName} (${template.id}), ${templateName} step ${step.stepIndex} (${persisted.id}) cannot adopt ${adoption.write.agentName}: active target Agent was not found`,
              );
            }
            await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: { assigneeAgentId: assignee.id } });
          } else {
            await tx.taskTemplateStep.update({ where: { id: persisted.id }, data: adoption.write.data });
          }
          counters[adoption.counter] += 1;
        }
        if (step.agentName === REGRESSION_VERIFIER_AGENT_NAME) {
          regressionSteps.push({
            id: persisted.id,
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
          recordStepPromptUpdate(counters, templateName, step.stepIndex, 1);
        }
      }
    }
  }
  return regressionSteps;
};

const migrateRegressionTasks = async (
  tx: Prisma.TransactionClient,
  project: ProjectRow,
  regressionSteps: readonly RegressionStep[],
  counters: CanonicalSyncCounters,
): Promise<void> => {
  for (const step of regressionSteps) {
    const target = await tx.agent.findFirst({
      where: { projectId: project.id, name: REGRESSION_VERIFIER_AGENT_NAME, archivedAt: null },
      select: { id: true },
    });
    if (!target) {
      throw projectError(
        project,
        `Template ${step.templateName} (${step.templateId}), ${step.templateName} step ${step.stepIndex} (${step.id}) has no active ${REGRESSION_VERIFIER_AGENT_NAME} Agent`,
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
        counters.preservedTaskAssignments.archived += 1;
        continue;
      }
      if (task.status !== TaskStatus.TODO) {
        counters.preservedTaskAssignments.nonTodo += 1;
        continue;
      }
      if (task._count.runs > 0 || task._count.sessions > 0) {
        counters.preservedTaskAssignments.started += 1;
        continue;
      }
      if (task.stepOutput) {
        counters.preservedTaskAssignments.output += 1;
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
        body: `Canonical routing reassigned this unstarted regression step to ${REGRESSION_VERIFIER_AGENT_NAME}`,
        metadata: {
          kind: "canonicalRouting.regressionVerifier",
          schemaVersion: 1,
          fromAgentId: task.assigneeAgentId,
          toAgentId: target.id,
        },
      } });
      counters.migratedTasks += 1;
    }
  }
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
  const reportKeys = { templateSteps: templateSources, roleNames };

  const prisma = database ?? new PrismaClient();
  const ownsPrisma = database === undefined;
  try {
    const projectRows = sortedProjectRows(await prisma.project.findMany({
      select: { id: true, slug: true },
      orderBy: { slug: "asc" },
    }));
    if (installFullProjectId !== null && !projectRows.some(({ id }) => id === installFullProjectId)) {
      throw new Error(`Project ${installFullProjectId} was not found`);
    }
    const canonicalProject = projectRows.find(({ slug }) => slug === "agentos-example");
    if (!canonicalProject) throw new Error("Canonical project agentos-example was not found");
    const orderedProjects = [
      canonicalProject,
      ...projectRows.filter(({ id }) => id !== canonicalProject.id),
    ];
    const outcomes: CanonicalSyncProjectOutcome[] = [];
    const runtimeConfigAdoptions: Array<{
      name: string;
      from: { model: string; runnerPreference: RunnerPreference };
      to: { model: string; runnerPreference: RunnerPreference };
    }> = [];

    for (const project of orderedProjects) {
      try {
        const result = await prisma.$transaction(async (tx) => {
          // For a full installation, this must remain the first transaction
          // read so target deletion or Environment drift fails without writes.
          const fullInstallTarget = installFullProjectId === project.id
            ? await preflightFullInstallTarget(tx, project.id, roleNames)
            : null;
          if (!fullInstallTarget) {
            const present = await tx.project.findUnique({
              where: { id: project.id },
              select: { id: true },
            });
            if (!present) throw projectError(project, "Project was not found");
          }

          const projectCounters = emptyCanonicalSyncCounters(reportKeys);
          const transactionAdoptions: typeof runtimeConfigAdoptions = [];
          const installationRows = await readCanonicalInstallationRows(tx, project.id, templateSources);
          const installationPlan = planCanonicalInstallation(
            installationRows,
            templateSources,
            project.id === canonicalProject.id ? [project.id] : [],
          );
          const plannedRefusal = installationPlan.find((action): action is Extract<CanonicalInstallationAction, { kind: "refused" }> => action.kind === "refused");
          if (plannedRefusal) throw projectError(project, plannedRefusal.reason);
          for (const action of installationPlan) {
            if (action.kind === "create" || action.kind === "rollover") {
              projectCounters.createdCanonicalTemplates += 1;
            }
          }

          if (project.id === canonicalProject.id) {
            await migrateSpecialCanonicalAgents(tx, canonicalProject, sources, rolesByName, projectCounters);
          }
          await synchronizeAgents(
            tx,
            project,
            project.id === canonicalProject.id,
            sources,
            rolesByName,
            roleNames,
            projectCounters,
            transactionAdoptions,
          );

          await applyCanonicalInstallation(tx, installationPlan, templateSources, {
            projectLabel: () => project.slug,
          });
          const regressionSteps = await syncCanonicalTemplates(tx, project, templateSources, projectCounters);
          await migrateRegressionTasks(tx, project, regressionSteps, projectCounters);

          if (fullInstallTarget) {
            await installMissingAgents(tx, fullInstallTarget, sources, rolesByName, roleNames, projectCounters);
            const postSyncRows = await readCanonicalInstallationRows(tx, project.id, templateSources);
            const fullInstallationPlan = planCanonicalInstallation(postSyncRows, templateSources, [project.id]);
            for (const action of fullInstallationPlan) {
              if (action.kind === "create" || action.kind === "rollover") {
                projectCounters.createdCanonicalTemplates += 1;
              }
            }
            await applyCanonicalInstallation(tx, fullInstallationPlan, templateSources, {
              projectLabel: () => project.slug,
            });
          }
          return { counters: projectCounters, runtimeConfigAdoptions: transactionAdoptions };
        }, { timeout: 120_000 });
        outcomes.push({ kind: "synced", slug: project.slug, counters: result.counters });
        runtimeConfigAdoptions.push(...result.runtimeConfigAdoptions);
      } catch (error) {
        if (project.id === canonicalProject.id || project.id === installFullProjectId) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const prefix = `Project ${project.slug}: `;
        const reason = message.startsWith(prefix) ? message.slice(prefix.length) : message;
        outcomes.push({ kind: "refused", slug: project.slug, reason: reason.replace(/\s+/gu, " ").trim() });
      }
    }

    for (const adoption of runtimeConfigAdoptions) {
      console.log(
        `Canonical runtime config adopted for Agent ${adoption.name}: `
        + `from model=${adoption.from.model}, runnerPreference=${adoption.from.runnerPreference} `
        + `to model=${adoption.to.model}, runnerPreference=${adoption.to.runnerPreference}`,
      );
    }
    const summary = canonicalSyncSummary(outcomes, reportKeys);
    for (const outcome of outcomes) {
      if (outcome.kind === "refused") console.log(`REFUSED ${outcome.slug}: ${outcome.reason}`);
      else console.log(`SYNCED ${outcome.slug}: ${JSON.stringify(summary.projects[outcome.slug])}`);
    }
    console.log(canonicalSyncSummaryLine(summary));
  } finally {
    if (ownsPrisma) await prisma.$disconnect();
  }
};

const invokedScript = process.argv[1];
if (invokedScript && fileURLToPath(import.meta.url) === resolve(invokedScript)) await main();
