import { PrismaClient, Prisma, RunnerPreference, TaskStatus } from "@prisma/client";

import { CANONICAL_AGENT_RUNTIME_TRANSITIONS, catalogRunnerForModel } from "../src/agent-contract.js";
import { loadAgentSources, roleSourceStructureDifferences } from "../src/agent-sources.js";
import {
  INTEGRATOR_TEMPLATE_NAME,
  legacyRegressionFirstThirteenStepTemplateName,
} from "../src/merge-integrator.js";
import {
  isPreChainLeaseTemplate,
  isPrePlanDecisionsTemplate,
  legacyChainLeaseTemplateName,
  legacyPlanDecisionsTemplateName,
  legacyTemplateShapeRefusal,
  type PersistedTransitionStep,
} from "../src/canonical-template-transition.js";
import {
  loadAllTemplateStepSources,
  templateStepStructureDifferences,
  type CanonicalTemplateName,
  type TemplateStepSource,
} from "../src/template-sources.js";

const REGRESSION_AGENT_NAME = "regression-verifier";
const REGRESSION_AGENT_SOURCE = "review-coordinator-sol";
const ADJUDICATOR_AGENT_NAME = "review-adjudicator-opus";
const ADJUDICATOR_AGENT_SOURCE = "review-coordinator-opus";
const CANONICAL_TEMPLATE_DESCRIPTIONS = new Map([
  ["compound-engineer-workflow", "Thirteen-step Full Assurance workflow with parallel independent code review, fresh Opus adjudication, refreshed exact-head regression verification, mechanical readiness, and mechanical merge execution."],
  ["direct-engineer-workflow", "Direct-tier workflow: implementation from the task brief, parallel independent code review with fresh Opus adjudication, fix application, refreshed exact-head regression verification, mechanical readiness, and mechanical merge execution."],
]);
const CANONICAL_STEP_NAMES = new Map([
  ["compound-engineer-workflow", [
    "Write a spec", "Plan", "Plan review", "Revise plan", "Implementation", "Code review (Sol)",
    "Code review (Opus blind)", "Opus adjudication", "Apply review fixes", "Librarian",
    "Regression verification", "Merge authorization", "Merge execution",
  ]],
  ["direct-engineer-workflow", [
    "Implementation", "Code review (Sol)", "Code review (Opus blind)", "Opus adjudication",
    "Apply review fixes", "Regression verification", "Merge authorization", "Merge execution",
  ]],
]);
const LEGACY_TEMPLATE_NAMES = new Map([
  ["compound-engineer-workflow", "compound-engineer-workflow-legacy-v1"],
  ["direct-engineer-workflow", "direct-engineer-workflow-legacy-v1"],
]);
const LEGACY_BLIND_REVIEW_PROMPTS = [
  "Blind-review the complete integrated implementation diff using the immutable implementationBaseSha and implementationHeadSha in the platform-pinned claim metadata; verify both endpoints resolve in this detached checkout. Persist your independent findings as an intermediate AgentOS task output before reading the first review. The successful task_output response unlocks predecessor step outputs; only then read them, apply the canonical merge matrix, and replace the intermediate output with the closed must-fix list. Do not write or commit any review report file.",
] as const;
type AssigneeTransition = { from: readonly string[]; to: string };
const ASSIGNEE_TRANSITIONS = new Map<string, AssigneeTransition>([
  ["compound-engineer-workflow:11", { from: ["review-coordinator-opus", "review-coordinator-sol"], to: REGRESSION_AGENT_NAME }],
  ["direct-engineer-workflow:6", { from: ["review-coordinator-opus", "review-coordinator-sol"], to: REGRESSION_AGENT_NAME }],
]);

const STEP_NAME_TRANSITIONS = new Map([
  ["compound-engineer-workflow:12", { from: "Merge readiness", to: "Merge authorization" }],
  ["direct-engineer-workflow:7", { from: "Merge readiness", to: "Merge authorization" }],
]);

const STEP_BASE_TRANSITIONS = new Map([
  ["compound-engineer-workflow:6", { from: null, to: 5 }],
  ["direct-engineer-workflow:2", { from: null, to: 1 }],
]);

const runtimeConfigRefusal = (agent: { model: string; runnerPreference: RunnerPreference }): string | null => {
  const expected = catalogRunnerForModel(agent.model);
  if (!expected || agent.runnerPreference === RunnerPreference.AUTO || agent.runnerPreference === RunnerPreference.INHERIT
    || expected === agent.runnerPreference) return null;
  return `Model ${agent.model} requires ${expected}, but this Agent stores ${agent.runnerPreference}`;
};

const regressionFirstCompoundContract = (canonical: TemplateStepSource[]): TemplateStepSource[] => canonical.map((step) => {
  if (step.stepIndex === 10) return { ...canonical[10]!, stepIndex: 10, layer: 9 };
  if (step.stepIndex === 11) return { ...canonical[9]!, stepIndex: 11, layer: 10 };
  return step;
});

type CanonicalTransaction = Prisma.TransactionClient;
type CanonicalSources = Map<CanonicalTemplateName, TemplateStepSource[]>;

const transitionStepInclude = {
  assigneeAgent: { select: { name: true } },
  _count: { select: { tasks: true } },
} as const;

const readCanonicalTemplateRows = async (tx: CanonicalTransaction, name: string) => tx.taskTemplate.findMany({
  where: { name },
  include: { steps: { orderBy: { stepIndex: "asc" }, include: transitionStepInclude } },
});

/**
 * Validate every named row before the transition begins. A row with the old
 * exact shape is the only row eligible for a fixed legacy-v1 rename. A row
 * with the current count is checked in the normal canonical sync loop below,
 * which retains its narrow, named adoption rules for already-reviewed source
 * edits. Any other count or an unrecognized old shape is a structural refusal.
 */
const preflightCanonicalTemplateRows = async (
  tx: CanonicalTransaction,
  templateSources: CanonicalSources,
): Promise<void> => {
  for (const [templateName, steps] of templateSources) {
    const rows = await readCanonicalTemplateRows(tx, templateName);
    if (rows.length === 0) throw new Error(`Template ${templateName} was not found`);
    const legacyName = LEGACY_TEMPLATE_NAMES.get(templateName);
    if (!legacyName) throw new Error(`No legacy identity is defined for canonical template ${templateName}`);
    for (const row of rows) {
      const persistedSteps = row.steps as unknown as PersistedTransitionStep[];
      const legacy = legacyTemplateShapeRefusal(templateName, persistedSteps);
      if (legacy === "legacy") {
        const existingLegacy = await tx.taskTemplate.findUnique({
          where: { projectId_name: { projectId: row.projectId, name: legacyName } },
          select: { id: true },
        });
        if (existingLegacy) {
          throw new Error(`Canonical template ${templateName} on project ${row.projectId} cannot rename to ${legacyName}: target already exists`);
        }
        continue;
      }
      if (persistedSteps.length !== steps.length) {
        throw new Error(`Canonical template ${templateName} on project ${row.projectId} has structural drift: expected ${steps.length} steps, found ${persistedSteps.length}`);
      }
      const duplicateIndexes = new Set<number>();
      for (const step of persistedSteps) {
        if (duplicateIndexes.has(step.stepIndex)) {
          throw new Error(`Canonical template ${templateName} on project ${row.projectId} has structural drift: duplicate stepIndex ${step.stepIndex}`);
        }
        duplicateIndexes.add(step.stepIndex);
      }
    }
  }
};

const createCanonicalTemplate = async (
  tx: CanonicalTransaction,
  projectId: string,
  templateName: string,
  steps: readonly TemplateStepSource[],
): Promise<void> => {
  const description = CANONICAL_TEMPLATE_DESCRIPTIONS.get(templateName);
  const stepNames = CANONICAL_STEP_NAMES.get(templateName);
  if (!description || !stepNames) throw new Error(`No canonical template metadata is defined for ${templateName}`);
  const template = await tx.taskTemplate.create({
    data: {
      projectId,
      name: templateName,
      description,
      variables: ["branchName"],
    },
  });
  for (const step of steps) {
    const name = stepNames[step.stepIndex - 1];
    if (!name) throw new Error(`Missing canonical template step name ${templateName}:${step.stepIndex}`);
    const assigneeAgentId = step.agentName
      ? (await tx.agent.findFirst({
        where: { projectId, name: step.agentName, archivedAt: null },
        select: { id: true },
      }))?.id ?? null
      : null;
    if (step.agentName && !assigneeAgentId) {
      throw new Error(`Canonical template ${templateName} step ${step.stepIndex} cannot bind ${step.agentName}: active Agent was not found in project ${projectId}`);
    }
    await tx.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: step.stepIndex,
        layer: step.layer,
        name,
        assigneeAgentId,
        assigneeType: step.agentName === null ? "HUMAN" : "AGENT",
        runner: null,
        approvalGate: step.approvalGate,
        outputKind: step.outputKind,
        prompt: step.prompt,
        opensPullRequest: step.opensPullRequest,
        attachmentsFromPrevious: step.attachmentsFromPrevious,
        baseFromStepIndex: step.baseFromStepIndex,
        spawnPolicy: step.spawnPolicy ?? Prisma.JsonNull,
      },
    });
  }
};

const transitionRegressionFirstCompoundTemplate = async (
  tx: CanonicalTransaction,
  templateSources: CanonicalSources,
): Promise<number> => {
  const canonical = templateSources.get(INTEGRATOR_TEMPLATE_NAME);
  if (!canonical) throw new Error(`Canonical template ${INTEGRATOR_TEMPLATE_NAME} was not found`);
  const prior = regressionFirstCompoundContract(canonical);
  const rows = await readCanonicalTemplateRows(tx, INTEGRATOR_TEMPLATE_NAME);
  let created = 0;
  for (const row of rows) {
    const matchesPrior = row.steps.length === prior.length
      && row.steps.every((step, index) => step.stepIndex === index + 1
        && templateStepStructureDifferences(step, prior[index]!).length === 0);
    if (!matchesPrior) continue;
    const unfinishedTasks = await tx.task.count({
      where: { templateId: row.id, archivedAt: null, status: { not: TaskStatus.DONE } },
    });
    if (unfinishedTasks > 0) {
      throw new Error(`${INTEGRATOR_TEMPLATE_NAME} ${row.id} still has ${unfinishedTasks} unfinished tasks; canonical rollover requires its existing chains to finish first`);
    }
    if (row.webhookSecretId !== null || row.webhookRepoId !== null
      || row.webhookPayloadMapping !== null || row.webhookPausedAt !== null
      || row.webhookReplayWindowSec !== null) {
      throw new Error(`${INTEGRATOR_TEMPLATE_NAME} ${row.id} has webhook configuration; canonical rollover will not move operator-owned trigger state`);
    }
    const legacyName = legacyRegressionFirstThirteenStepTemplateName(row.id);
    const collision = await tx.taskTemplate.findUnique({
      where: { projectId_name: { projectId: row.projectId, name: legacyName } },
      select: { id: true },
    });
    if (collision) {
      throw new Error(`Canonical template ${INTEGRATOR_TEMPLATE_NAME} on project ${row.projectId} cannot rename to ${legacyName}: target already exists`);
    }
    await tx.taskTemplate.update({ where: { id: row.id }, data: { name: legacyName } });
    await createCanonicalTemplate(tx, row.projectId, INTEGRATOR_TEMPLATE_NAME, canonical);
    created += 1;
  }
  return created;
};

const transitionCanonicalTemplateRows = async (
  tx: CanonicalTransaction,
  templateSources: Awaited<ReturnType<typeof loadAllTemplateStepSources>>,
): Promise<number> => {
  let created = 0;
  for (const [templateName, steps] of templateSources) {
    const rows = await readCanonicalTemplateRows(tx, templateName);
    const legacyName = LEGACY_TEMPLATE_NAMES.get(templateName)!;
    for (const row of rows) {
      const persistedSteps = row.steps as unknown as PersistedTransitionStep[];
      if (legacyTemplateShapeRefusal(templateName, persistedSteps) !== "legacy") continue;
      await tx.taskTemplate.update({ where: { id: row.id }, data: { name: legacyName } });
      await createCanonicalTemplate(tx, row.projectId, templateName, steps);
      created += 1;
    }
  }
  return created;
};

const transitionPreChainLeaseTemplates = async (
  tx: CanonicalTransaction,
  templateSources: CanonicalSources,
): Promise<number> => {
  let created = 0;
  for (const [templateName, canonical] of templateSources) {
    const rows = await readCanonicalTemplateRows(tx, templateName);
    for (const row of rows) {
      if (!isPreChainLeaseTemplate(
        templateName,
        row.steps as unknown as PersistedTransitionStep[],
        canonical,
      )) continue;
      const unfinishedTasks = await tx.task.count({
        where: { templateId: row.id, archivedAt: null, status: { not: TaskStatus.DONE } },
      });
      if (unfinishedTasks > 0) {
        throw new Error(`${templateName} ${row.id} still has ${unfinishedTasks} unfinished tasks; canonical rollover requires its existing chains to finish first`);
      }
      if (row.webhookSecretId !== null || row.webhookRepoId !== null
        || row.webhookPayloadMapping !== null || row.webhookPausedAt !== null
        || row.webhookReplayWindowSec !== null) {
        throw new Error(`${templateName} ${row.id} has webhook configuration; canonical rollover will not move operator-owned trigger state`);
      }
      const legacyName = legacyChainLeaseTemplateName(templateName, row.id);
      const collision = await tx.taskTemplate.findUnique({
        where: { projectId_name: { projectId: row.projectId, name: legacyName } },
        select: { id: true },
      });
      if (collision) {
        throw new Error(`Canonical template ${templateName} on project ${row.projectId} cannot rename to ${legacyName}: target already exists`);
      }
      await tx.taskTemplate.update({ where: { id: row.id }, data: { name: legacyName } });
      await createCanonicalTemplate(tx, row.projectId, templateName, canonical);
      created += 1;
    }
  }
  return created;
};

const transitionPrePlanDecisionsTemplates = async (
  tx: CanonicalTransaction,
  templateSources: CanonicalSources,
): Promise<number> => {
  let created = 0;
  for (const [templateName, canonical] of templateSources) {
    const rows = await readCanonicalTemplateRows(tx, templateName);
    for (const row of rows) {
      if (!isPrePlanDecisionsTemplate(
        templateName,
        row.steps as unknown as PersistedTransitionStep[],
        canonical,
      )) continue;
      const unfinishedTasks = await tx.task.count({
        where: { templateId: row.id, archivedAt: null, status: { not: TaskStatus.DONE } },
      });
      if (unfinishedTasks > 0) {
        throw new Error(`${templateName} ${row.id} still has ${unfinishedTasks} unfinished tasks; canonical rollover requires its existing chains to finish first`);
      }
      if (row.webhookSecretId !== null || row.webhookRepoId !== null
        || row.webhookPayloadMapping !== null || row.webhookPausedAt !== null
        || row.webhookReplayWindowSec !== null) {
        throw new Error(`${templateName} ${row.id} has webhook configuration; canonical rollover will not move operator-owned trigger state`);
      }
      const legacyName = legacyPlanDecisionsTemplateName(templateName, row.id);
      const collision = await tx.taskTemplate.findUnique({
        where: { projectId_name: { projectId: row.projectId, name: legacyName } },
        select: { id: true },
      });
      if (collision) {
        throw new Error(`Canonical template ${templateName} on project ${row.projectId} cannot rename to ${legacyName}: target already exists`);
      }
      await tx.taskTemplate.update({ where: { id: row.id }, data: { name: legacyName } });
      await createCanonicalTemplate(tx, row.projectId, templateName, canonical);
      created += 1;
    }
  }
  return created;
};

// Every canonical template, every step of each, and every role under agents/
// is synced. Omitting any source here would let a prompt edit silently miss
// production, so the loader owns the complete template inventory.
const main = async (): Promise<void> => {
  const [templateSources, sources] = await Promise.all([loadAllTemplateStepSources(), loadAgentSources()]);
  const rolesByName = new Map(sources.roles.map((role) => [role.name, role]));
  const roleNames = [...rolesByName.keys()];

  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const canonicalProject = await tx.project.findUnique({
        where: { slug: "agentos-example" },
        select: { id: true },
      });
      if (!canonicalProject) throw new Error("Canonical project agentos-example was not found");
      await preflightCanonicalTemplateRows(tx, templateSources);
      let createdAgents = 0;
      let createdAgentRepoGrants = 0;
      const regressionRole = rolesByName.get(REGRESSION_AGENT_NAME);
      if (!regressionRole) throw new Error(`Canonical role ${REGRESSION_AGENT_NAME} was not found`);
      const existingRegressionAgent = await tx.agent.findUnique({
        where: { projectId_name: { projectId: canonicalProject.id, name: REGRESSION_AGENT_NAME } },
        select: { id: true, archivedAt: true },
      });
      if (existingRegressionAgent?.archivedAt) {
        throw new Error(`Canonical Agent ${REGRESSION_AGENT_NAME} is archived; sync will not resurrect it`);
      }
      if (!existingRegressionAgent) {
        const source = await tx.agent.findUnique({
          where: { projectId_name: { projectId: canonicalProject.id, name: REGRESSION_AGENT_SOURCE } },
          select: {
            environmentId: true,
            disabledTools: true,
            archivedAt: true,
            repoAccess: { select: { projectId: true, repoId: true, mountPath: true, permissions: true } },
          },
        });
        if (!source || source.archivedAt) {
          throw new Error(`Cannot create ${REGRESSION_AGENT_NAME}: active source Agent ${REGRESSION_AGENT_SOURCE} was not found`);
        }
        const created = await tx.agent.create({ data: {
          projectId: canonicalProject.id,
          environmentId: source.environmentId,
          name: regressionRole.name,
          title: regressionRole.title,
          model: regressionRole.model,
          runnerPreference: regressionRole.runnerPreference,
          inboxAccess: regressionRole.inboxAccess,
          disabledTools: source.disabledTools,
          foundationalPrompt: sources.foundationalPrompt,
          rolePrompt: regressionRole.rolePrompt,
        } });
        if (source.repoAccess.length > 0) {
          createdAgentRepoGrants = (await tx.agentRepoAccess.createMany({ data: source.repoAccess.map((grant) => ({
            ...grant,
            agentId: created.id,
          })) })).count;
        }
        createdAgents = 1;
      }
      const adjudicatorRole = rolesByName.get(ADJUDICATOR_AGENT_NAME);
      if (!adjudicatorRole) throw new Error(`Canonical role ${ADJUDICATOR_AGENT_NAME} was not found`);
      const existingAdjudicatorAgent = await tx.agent.findUnique({
        where: { projectId_name: { projectId: canonicalProject.id, name: ADJUDICATOR_AGENT_NAME } },
        select: { id: true, archivedAt: true },
      });
      if (existingAdjudicatorAgent?.archivedAt) {
        throw new Error(`Canonical Agent ${ADJUDICATOR_AGENT_NAME} is archived; sync will not resurrect it`);
      }
      if (!existingAdjudicatorAgent) {
        const source = await tx.agent.findUnique({
          where: { projectId_name: { projectId: canonicalProject.id, name: ADJUDICATOR_AGENT_SOURCE } },
          select: {
            environmentId: true,
            disabledTools: true,
            archivedAt: true,
            repoAccess: { select: { projectId: true, repoId: true, mountPath: true, permissions: true } },
          },
        });
        if (!source || source.archivedAt) {
          throw new Error(`Cannot create ${ADJUDICATOR_AGENT_NAME}: active source Agent ${ADJUDICATOR_AGENT_SOURCE} was not found`);
        }
        const created = await tx.agent.create({ data: {
          projectId: canonicalProject.id,
          environmentId: source.environmentId,
          name: adjudicatorRole.name,
          title: adjudicatorRole.title,
          model: adjudicatorRole.model,
          runnerPreference: adjudicatorRole.runnerPreference,
          inboxAccess: adjudicatorRole.inboxAccess,
          disabledTools: source.disabledTools,
          foundationalPrompt: sources.foundationalPrompt,
          rolePrompt: adjudicatorRole.rolePrompt,
        } });
        if (source.repoAccess.length > 0) {
          createdAgentRepoGrants += (await tx.agentRepoAccess.createMany({ data: source.repoAccess.map((grant) => ({
            ...grant,
            agentId: created.id,
          })) })).count;
        }
        createdAgents += 1;
      }
      const createdCanonicalTemplates = await transitionRegressionFirstCompoundTemplate(tx, templateSources)
        + await transitionCanonicalTemplateRows(tx, templateSources)
        + await transitionPreChainLeaseTemplates(tx, templateSources)
        + await transitionPrePlanDecisionsTemplates(tx, templateSources);
      const updatedSteps: Record<string, Record<number, number>> = {};
      let adoptedAssignees = 0;
      let adoptedStepBases = 0;
      let renamedSteps = 0;
      let templateCount = 0;
      const regressionSteps: Array<{ id: string; projectId: string }> = [];
      const blindReviewSteps: Array<{ id: string; prompt: string }> = [];
      for (const [templateName, steps] of templateSources) {
        const templates = await tx.taskTemplate.findMany({
          where: { name: templateName },
          select: { id: true, projectId: true },
        });
        if (templates.length === 0) throw new Error(`Template ${templateName} was not found`);
        templateCount += templates.length;
        const templateIds = templates.map((template) => template.id);
        const present = await tx.taskTemplateStep.count({ where: { taskTemplateId: { in: templateIds } } });
        const expected = templates.length * steps.length;
        if (present !== expected) {
          throw new Error(`Expected ${expected} total steps on ${templates.length} ${templateName} templates; found ${present}`);
        }

        const updated: Record<number, number> = {};
        for (const step of steps) {
          const persistedSteps = await tx.taskTemplateStep.findMany({
            where: { taskTemplateId: { in: templateIds }, stepIndex: step.stepIndex },
            select: {
              id: true,
              name: true,
              taskTemplateId: true,
              prompt: true,
              layer: true,
              assigneeAgent: { select: { name: true } },
              assigneeType: true,
              approvalGate: true,
              outputKind: true,
              attachmentsFromPrevious: true,
              opensPullRequest: true,
              baseFromStepIndex: true,
              spawnPolicy: true,
              _count: { select: { tasks: true } },
            },
          });
          if (persistedSteps.length !== templates.length) {
            throw new Error(`Expected step ${step.stepIndex} on ${templates.length} ${templateName} templates; found ${persistedSteps.length}`);
          }
          for (const persisted of persistedSteps) {
            const differences = templateStepStructureDifferences(persisted, step);
            const transition = ASSIGNEE_TRANSITIONS.get(`${templateName}:${step.stepIndex}`);
            const adoptsCanonicalAssignee = differences.includes("agent")
              && transition?.from.includes(persisted.assigneeAgent?.name ?? "") === true
              && transition.to === step.agentName;
            const baseTransition = STEP_BASE_TRANSITIONS.get(`${templateName}:${step.stepIndex}`);
            const adoptsCanonicalBase = differences.includes("baseFromStepIndex")
              && baseTransition?.from === persisted.baseFromStepIndex
              && baseTransition.to === step.baseFromStepIndex;
            const adoptedDifferences = new Set([
              ...(adoptsCanonicalAssignee ? ["agent"] : []),
              ...(adoptsCanonicalBase ? ["baseFromStepIndex"] : []),
            ]);
            if (differences.some((difference) => !adoptedDifferences.has(difference))) {
              throw new Error(`${templateName} step ${step.stepIndex} on template ${persisted.taskTemplateId} differs from canonical Markdown structure: ${differences.join(", ")}`);
            }
            if (adoptsCanonicalAssignee) {
              if (persisted._count.tasks > 0) {
                throw new Error(`${templateName} step ${step.stepIndex} on template ${persisted.taskTemplateId} is referenced by instantiated tasks; canonical sync will not mutate it`);
              }
              const projectId = templates.find(({ id }) => id === persisted.taskTemplateId)?.projectId;
              const assignee = projectId
                ? await tx.agent.findFirst({
                  where: { projectId, name: transition.to, archivedAt: null },
                  select: { id: true },
                })
                : null;
              if (!assignee) {
                throw new Error(`${templateName} step ${step.stepIndex} cannot adopt ${transition.to}: active target Agent was not found in the template project`);
              }
              await tx.taskTemplateStep.update({
                where: { id: persisted.id },
                data: { assigneeAgentId: assignee.id },
              });
              adoptedAssignees += 1;
            }
            if (adoptsCanonicalBase) {
              if (persisted._count.tasks > 0) {
                throw new Error(`${templateName} step ${step.stepIndex} on template ${persisted.taskTemplateId} is referenced by instantiated tasks; canonical sync will not mutate it`);
              }
              await tx.taskTemplateStep.update({
                where: { id: persisted.id },
                data: { baseFromStepIndex: baseTransition.to },
              });
              adoptedStepBases += 1;
            }
            const nameTransition = STEP_NAME_TRANSITIONS.get(`${templateName}:${step.stepIndex}`);
            if (nameTransition?.from === persisted.name) {
              if (persisted._count.tasks > 0) {
                throw new Error(`${templateName} step ${step.stepIndex} on template ${persisted.taskTemplateId} is referenced by instantiated tasks; canonical sync will not mutate it`);
              }
              await tx.taskTemplateStep.update({
                where: { id: persisted.id },
                data: { name: nameTransition.to },
              });
              renamedSteps += 1;
            }
            if (step.agentName === REGRESSION_AGENT_NAME) {
              const projectId = templates.find(({ id }) => id === persisted.taskTemplateId)?.projectId;
              if (!projectId) throw new Error(`Template project was not found for regression step ${persisted.id}`);
              regressionSteps.push({ id: persisted.id, projectId });
            }
            if (step.outputKind === "must-fix") {
              blindReviewSteps.push({ id: persisted.id, prompt: step.prompt });
            }
          }
          if (persistedSteps.some((persisted) => persisted._count.tasks > 0 && persisted.prompt !== step.prompt)) {
            throw new Error(`${templateName} step ${step.stepIndex} on template ${templateName} is referenced by instantiated tasks; canonical sync will not mutate its prompt`);
          }
          updated[step.stepIndex] = (await tx.taskTemplateStep.updateMany({
            where: { taskTemplateId: { in: templateIds }, stepIndex: step.stepIndex, prompt: { not: step.prompt } },
            data: { prompt: step.prompt },
          })).count;
        }
        updatedSteps[templateName] = updated;
      }

      let migratedTasks = 0;
      const preservedTaskAssignments = { archived: 0, nonTodo: 0, started: 0, output: 0 };
      for (const step of regressionSteps) {
        const target = await tx.agent.findFirst({
          where: { projectId: step.projectId, name: REGRESSION_AGENT_NAME, archivedAt: null },
          select: { id: true },
        });
        if (!target) throw new Error(`Regression step ${step.id} has no active ${REGRESSION_AGENT_NAME} in its project`);
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
            preservedTaskAssignments.archived += 1;
            continue;
          }
          if (task.status !== TaskStatus.TODO) {
            preservedTaskAssignments.nonTodo += 1;
            continue;
          }
          if (task._count.runs > 0 || task._count.sessions > 0) {
            preservedTaskAssignments.started += 1;
            continue;
          }
          if (task.stepOutput) {
            preservedTaskAssignments.output += 1;
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
          if (adopted.count !== 1) throw new Error(`Regression task ${task.id} changed while canonical routing was being adopted`);
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
          migratedTasks += 1;
        }
      }

      let migratedTaskPrompts = 0;
      const preservedBlindReviewPrompts = { archived: 0, nonTodo: 0, started: 0, output: 0, unrecognized: 0 };
      for (const step of blindReviewSteps) {
        const tasks = await tx.task.findMany({
          where: { templateStepId: step.id },
          select: {
            id: true,
            status: true,
            archivedAt: true,
            description: true,
            _count: { select: { runs: true, sessions: true } },
            stepOutput: { select: { id: true } },
          },
        });
        for (const task of tasks) {
          const legacyPrompt = LEGACY_BLIND_REVIEW_PROMPTS.find((prompt) => task.description.startsWith(prompt));
          if (!legacyPrompt) {
            if (!task.description.startsWith(step.prompt)) preservedBlindReviewPrompts.unrecognized += 1;
            continue;
          }
          if (task.archivedAt) {
            preservedBlindReviewPrompts.archived += 1;
            continue;
          }
          if (task.status !== TaskStatus.TODO) {
            preservedBlindReviewPrompts.nonTodo += 1;
            continue;
          }
          if (task._count.runs > 0 || task._count.sessions > 0) {
            preservedBlindReviewPrompts.started += 1;
            continue;
          }
          if (task.stepOutput) {
            preservedBlindReviewPrompts.output += 1;
            continue;
          }
          const description = `${step.prompt}${task.description.slice(legacyPrompt.length)}`;
          const adopted = await tx.task.updateMany({
            where: {
              id: task.id,
              description: task.description,
              status: TaskStatus.TODO,
              archivedAt: null,
              runs: { none: {} },
              sessions: { none: {} },
              stepOutput: { is: null },
            },
            data: { description },
          });
          if (adopted.count !== 1) throw new Error(`Blind-review task ${task.id} changed while its canonical prompt was being adopted`);
          await tx.taskActivity.create({ data: {
            taskId: task.id,
            actorType: "control-plane",
            body: "Canonical sync updated this unstarted blind-review step to the versioned output protocol",
            metadata: {
              kind: "canonicalTaskPrompt.blindReviewOutputV1",
              schemaVersion: 1,
            },
          } });
          migratedTaskPrompts += 1;
        }
      }

      const presentAgents = await tx.agent.findMany({
        where: { projectId: canonicalProject.id, archivedAt: null, name: { in: roleNames } },
        select: {
          id: true,
          name: true,
          title: true,
          model: true,
          runtimeConfigCustomized: true,
          runnerPreference: true,
          inboxAccess: true,
          collaborators: { select: { allowedAgent: { select: { name: true } } } },
        },
      });
      const agentsByName = new Map<string, typeof presentAgents>();
      for (const agent of presentAgents) {
        const matches = agentsByName.get(agent.name) ?? [];
        matches.push(agent);
        agentsByName.set(agent.name, matches);
      }
      for (const name of roleNames) {
        if (!agentsByName.has(name)) throw new Error(`Agent ${name} was not found`);
      }
      const updatedRoles: Record<string, number> = {};
      let adoptedAgentDefaults = 0;
      let preservedAgentOverrides = 0;
      for (const name of roleNames) {
        const role = rolesByName.get(name)!;
        for (const agent of agentsByName.get(name)!) {
          const differences = roleSourceStructureDifferences(agent, role);
          const runtimeDifferences = differences.filter((difference) => difference === "model" || difference === "runnerPreference");
          const structuralDifferences = differences.filter((difference) => difference !== "model" && difference !== "runnerPreference");
          const transition = CANONICAL_AGENT_RUNTIME_TRANSITIONS.get(name);
          const adoptsCanonicalDefaults = structuralDifferences.length === 0
            && runtimeDifferences.length > 0
            && !agent.runtimeConfigCustomized
            && transition?.from.model === agent.model
            && transition.from.runnerPreference === agent.runnerPreference
            && transition.to.model === role.model
            && transition.to.runnerPreference === role.runnerPreference;
          if (structuralDifferences.length > 0) {
            throw new Error(`Agent ${name} (${agent.id}) differs from canonical Markdown structure: ${structuralDifferences.join(", ")}`);
          }
          if (runtimeDifferences.length > 0 && runtimeConfigRefusal(agent)) {
            throw new Error(`Agent ${name} (${agent.id}) has an invalid runtime configuration: ${runtimeConfigRefusal(agent)}`);
          }
          if (adoptsCanonicalDefaults) {
            await tx.agent.update({
              where: { id: agent.id },
              data: transition.to,
            });
            adoptedAgentDefaults += 1;
          } else if (runtimeDifferences.length > 0 && !agent.runtimeConfigCustomized) {
            await tx.agent.update({
              where: { id: agent.id },
              data: { runtimeConfigCustomized: true },
            });
            preservedAgentOverrides += 1;
          }
        }
        updatedRoles[name] = (await tx.agent.updateMany({
          where: {
            projectId: canonicalProject.id,
            archivedAt: null,
            name,
            OR: [
              { foundationalPrompt: { not: sources.foundationalPrompt } },
              { rolePrompt: { not: role.rolePrompt } },
            ],
          },
          data: { foundationalPrompt: sources.foundationalPrompt, rolePrompt: role.rolePrompt },
        })).count;
      }
      return {
        templates: templateCount,
        createdCanonicalTemplates,
        createdAgents,
        createdAgentRepoGrants,
        adoptedAssignees,
        adoptedStepBases,
        renamedSteps,
        migratedTasks,
        migratedTaskPrompts,
        preservedTaskAssignments,
        preservedBlindReviewPrompts,
        adoptedAgentDefaults,
        preservedAgentOverrides,
        updatedSteps,
        updatedRoles,
      };
    }, { timeout: 30_000 });
    const updated = result.createdCanonicalTemplates + result.createdAgents + result.createdAgentRepoGrants + result.adoptedAssignees + result.adoptedStepBases
      + result.renamedSteps + result.migratedTasks + result.migratedTaskPrompts + result.adoptedAgentDefaults + Object.values(result.updatedSteps)
      .flatMap((byStep) => Object.values(byStep))
      .reduce((sum, count) => sum + count, 0)
      + Object.values(result.updatedRoles).reduce((sum, count) => sum + count, 0);
    console.log(JSON.stringify({ ...result, updated }));
  } finally {
    await prisma.$disconnect();
  }
};

await main();
