import { AssigneeType, CodexServiceTier, Prisma, PrismaClient, TaskStatus } from "@prisma/client";

import { CANONICAL_AGENT_RUNTIME_TRANSITIONS, DIRECT_TEMPLATE_NAME } from "../src/agent-contract.js";
import { loadAgentSources } from "../src/agent-sources.js";
import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_TEMPLATE_NAME,
  legacyHumanTwelveStepTemplateName,
  legacyNineStepTemplateName,
  legacyRegressionFirstTwelveStepTemplateName,
  legacyTenStepTemplateName,
} from "../src/merge-integrator.js";
import { canonicalTemplateStepName, loadAllTemplateStepSources } from "../src/template-sources.js";

// The loader this seed used to carry moved to `packages/db/src/agent-sources.ts`
// so that OSS-B0's first-run onboarding can read the same `agents/` contract
// without running this seed, which creates the internal multi-role
// installation. Nothing this file seeds changed with the move.
const prisma = new PrismaClient();

const HISTORICAL_NINE_STEP_CONTRACT = [
  [1, "spec", AssigneeType.AGENT, "spec", true],
  [2, "plan", AssigneeType.AGENT, "plan", false],
  [3, "review-coordinator", AssigneeType.AGENT, "plan-review", false],
  [4, "plan-reviser", AssigneeType.AGENT, "revised-plan", true],
  [5, "implementation-plan-executioner", AssigneeType.AGENT, "implementation", false],
  [6, "review-coordinator", AssigneeType.AGENT, "code-review", false],
  [7, "senior-dev", AssigneeType.AGENT, "fixed-implementation", false],
  [8, "librarian", AssigneeType.AGENT, "documentation", false],
  [9, null, AssigneeType.HUMAN, "approval", true],
] as const;

const main = async (): Promise<void> => {
  const [sources, templateStepsByName] = await Promise.all([loadAgentSources(), loadAllTemplateStepSources()]);
  const templateSteps = templateStepsByName.get(INTEGRATOR_TEMPLATE_NAME)!;
  const directTemplateSteps = templateStepsByName.get(DIRECT_TEMPLATE_NAME)!;
  const project = await prisma.project.upsert({
    where: { slug: "agentos-example" },
    update: {},
    create: {
      name: "AgentOS Example",
      slug: "agentos-example",
      yamlDocument: "# Managed by AgentOS; YAML sync arrives after v1.\n",
    },
  });

  const environment = await prisma.environment.upsert({
    where: { projectId_name: { projectId: project.id, name: "local" } },
    update: {},
    create: {
      projectId: project.id,
      name: "local",
      networking: "OPEN",
      allowedHosts: [],
    },
  });

  for (const role of sources.roles) {
    const existing = await prisma.agent.findUnique({
      where: { projectId_name: { projectId: project.id, name: role.name } },
      select: { model: true, runnerPreference: true, runtimeConfigCustomized: true },
    });
    const transition = CANONICAL_AGENT_RUNTIME_TRANSITIONS.get(role.name);
    const isCanonicalRuntimeTransition = existing !== null
      && existing.runtimeConfigCustomized === false
      && transition?.from.model === existing.model
      && transition.from.runnerPreference === existing.runnerPreference
      && transition.to.model === role.model
      && transition.to.runnerPreference === role.runnerPreference;
    const runtimeConfigCustomized = existing?.runtimeConfigCustomized === true
      || (existing !== null
        && !isCanonicalRuntimeTransition
        && (existing.model !== role.model || existing.runnerPreference !== role.runnerPreference));
    const useCanonicalRuntimeConfig = !runtimeConfigCustomized;
    await prisma.agent.upsert({
      where: { projectId_name: { projectId: project.id, name: role.name } },
      update: {
        environmentId: environment.id,
        title: role.title,
        ...(useCanonicalRuntimeConfig ? { model: role.model, runnerPreference: role.runnerPreference } : {}),
        runtimeConfigCustomized,
        inboxAccess: role.inboxAccess,
        foundationalPrompt: sources.foundationalPrompt,
        rolePrompt: role.rolePrompt,
      },
      create: {
        projectId: project.id,
        environmentId: environment.id,
        name: role.name,
        title: role.title,
        model: role.model,
        runtimeConfigCustomized: false,
        codexServiceTier: CodexServiceTier.DEFAULT,
        runnerPreference: role.runnerPreference,
        inboxAccess: role.inboxAccess,
        foundationalPrompt: sources.foundationalPrompt,
        rolePrompt: role.rolePrompt,
      },
    });
  }

  const agentByName = new Map((await prisma.agent.findMany({ where: { projectId: project.id } })).map((agent) => [agent.name, agent]));
  const seededAgentIds = sources.roles.map((role) => {
    const agent = agentByName.get(role.name);
    if (!agent) throw new Error(`Missing seeded agent ${role.name}`);
    return agent.id;
  });
  // The agents/ contract no longer seeds skills; this clears links a prior
  // seed created, so a re-seeded installation matches the contract.
  await prisma.agentSkill.deleteMany({ where: { agentId: { in: seededAgentIds } } });
  await prisma.agentCollaboration.deleteMany({ where: { agentId: { in: seededAgentIds } } });
  for (const role of sources.roles) {
    const agent = agentByName.get(role.name)!;
    for (const collaboratorName of role.collaborators) {
      const collaborator = agentByName.get(collaboratorName);
      if (!collaborator || !seededAgentIds.includes(collaborator.id)) {
        throw new Error(`Agent ${role.name} references unknown collaborator ${collaboratorName}`);
      }
      await prisma.agentCollaboration.create({
        data: { agentId: agent.id, allowedAgentId: collaborator.id, projectId: project.id },
      });
    }
  }
  const template = await prisma.$transaction(async (tx) => {
    const existing = await tx.taskTemplate.findUnique({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      include: { steps: { include: { assigneeAgent: { select: { name: true } } }, orderBy: { stepIndex: "asc" } } },
    });
    const historicalIntegrator = existing?.steps.find((step) => step.stepIndex === 10);
    const isHistoricalNineStepTemplate = existing?.steps.length === HISTORICAL_NINE_STEP_CONTRACT.length
      && HISTORICAL_NINE_STEP_CONTRACT.every(([stepIndex, agentName, assigneeType, outputKind, approvalGate], index) => {
        const step = existing.steps[index];
        return step?.stepIndex === stepIndex
          && (step.assigneeAgent?.name ?? null) === agentName
          && step.assigneeType === assigneeType
          && step.outputKind === outputKind
          && step.approvalGate === approvalGate;
      });
    const isHistoricalTenStepTemplate = existing?.steps.length === 10
      && existing.steps.every((step, index) => step.stepIndex === index + 1)
      && historicalIntegrator?.outputKind === INTEGRATOR_OUTPUT_KIND
      && historicalIntegrator.assigneeAgent?.name === INTEGRATOR_AGENT_NAME;
    const isHistoricalHumanTwelveStepTemplate = existing?.steps.length === 12
      && existing.steps[10]?.assigneeType === AssigneeType.HUMAN
      && existing.steps[10]?.outputKind === "approval"
      && existing.steps[11]?.assigneeAgent?.name === INTEGRATOR_AGENT_NAME
      && existing.steps[11]?.outputKind === INTEGRATOR_OUTPUT_KIND;
    const isRegressionFirstTwelveStepTemplate = existing?.steps.length === 12
      && existing.steps.every((step, index) => step.stepIndex === index + 1)
      && existing.steps[8]?.assigneeAgent?.name === "regression-verifier"
      && existing.steps[8]?.outputKind === "regression-verification"
      && existing.steps[9]?.assigneeAgent?.name === "librarian"
      && existing.steps[9]?.outputKind === "documentation"
      && existing.steps[10]?.outputKind === "merge-authorization"
      && existing.steps[11]?.assigneeAgent?.name === INTEGRATOR_AGENT_NAME
      && existing.steps[11]?.outputKind === INTEGRATOR_OUTPUT_KIND;
    if (existing && isRegressionFirstTwelveStepTemplate) {
      const unfinishedTasks = await tx.task.count({
        where: { templateId: existing.id, archivedAt: null, status: { not: TaskStatus.DONE } },
      });
      if (unfinishedTasks > 0) {
        throw new Error(`${INTEGRATOR_TEMPLATE_NAME} ${existing.id} still has ${unfinishedTasks} unfinished tasks; canonical rollover requires its existing chains to finish first`);
      }
      if (existing.webhookSecretId !== null || existing.webhookRepoId !== null
        || existing.webhookPayloadMapping !== null || existing.webhookPausedAt !== null
        || existing.webhookReplayWindowSec !== null) {
        throw new Error(`${INTEGRATOR_TEMPLATE_NAME} ${existing.id} has webhook configuration; canonical rollover will not move operator-owned trigger state`);
      }
    }

    // A template whose step meanings changed cannot be rewritten in place:
    // materialized tasks keep foreign keys to those rows. Preserve the entire
    // template under a seed-minted legacy identity; then the canonical upsert
    // below creates a new template for new Runs. Runtime mechanical recognition
    // remains limited to legacy shapes that actually carried an integrator.
    const legacyName = existing && isHistoricalHumanTwelveStepTemplate
      ? legacyHumanTwelveStepTemplateName(existing.id)
      : existing && isRegressionFirstTwelveStepTemplate
      ? legacyRegressionFirstTwelveStepTemplateName(existing.id)
      : existing && isHistoricalNineStepTemplate
      ? legacyNineStepTemplateName(existing.id)
      : existing && isHistoricalTenStepTemplate
        ? legacyTenStepTemplateName(existing.id)
        : null;
    if (existing && legacyName) {
      await tx.taskTemplate.update({
        where: { id: existing.id },
        data: { name: legacyName },
      });
    }

    return tx.taskTemplate.upsert({
      where: { projectId_name: { projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME } },
      update: {
        description: "Twelve-step Full Assurance workflow with dual independent code review, refreshed exact-head regression verification, mechanical readiness, and mechanical merge execution.",
        variables: ["branchName"],
      },
      create: {
        projectId: project.id,
        name: INTEGRATOR_TEMPLATE_NAME,
        description: "Twelve-step Full Assurance workflow with dual independent code review, refreshed exact-head regression verification, mechanical readiness, and mechanical merge execution.",
        variables: ["branchName"],
      },
    });
  });
  for (const step of templateSteps) {
    const { stepIndex, agentName, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious, baseFromStepIndex, spawnPolicy } = step;
    const name = canonicalTemplateStepName(INTEGRATOR_TEMPLATE_NAME, stepIndex);
    const assigneeType = agentName === null ? AssigneeType.HUMAN : AssigneeType.AGENT;
    const assigneeAgentId: string | null = agentName ? (agentByName.get(agentName)?.id ?? null) : null;
    if (agentName && !assigneeAgentId) throw new Error(`Missing seeded agent ${agentName}`);
    await prisma.taskTemplateStep.upsert({
      where: { taskTemplateId_stepIndex: { taskTemplateId: template.id, stepIndex } },
      update: { name, assigneeAgentId, assigneeType, runner: null, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious, baseFromStepIndex, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
      create: { taskTemplateId: template.id, stepIndex, name, assigneeAgentId, assigneeType, runner: null, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious, baseFromStepIndex, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
    });
  }

  const historicalDirect = await prisma.taskTemplate.findUnique({
    where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  if (historicalDirect?.steps.length === 6
    && historicalDirect.steps[5]?.assigneeType === AssigneeType.HUMAN
    && historicalDirect.steps[5]?.outputKind === "approval") {
    await prisma.taskTemplate.update({
      where: { id: historicalDirect.id },
      data: { name: `${DIRECT_TEMPLATE_NAME}-legacy-human-6-${historicalDirect.id}` },
    });
  }
  const directTemplate = await prisma.taskTemplate.upsert({
    where: { projectId_name: { projectId: project.id, name: DIRECT_TEMPLATE_NAME } },
    update: {
      description: "Direct-tier workflow: implementation from the task brief, dual independent code review with blind adjudication, fix application, refreshed exact-head regression verification, mechanical readiness, and mechanical merge execution.",
      variables: ["branchName"],
    },
    create: {
      projectId: project.id,
      name: DIRECT_TEMPLATE_NAME,
      description: "Direct-tier workflow: implementation from the task brief, dual independent code review with blind adjudication, fix application, refreshed exact-head regression verification, mechanical readiness, and mechanical merge execution.",
      variables: ["branchName"],
    },
  });
  for (const step of directTemplateSteps) {
    const { stepIndex, agentName, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious, baseFromStepIndex, spawnPolicy } = step;
    const name = canonicalTemplateStepName(DIRECT_TEMPLATE_NAME, stepIndex);
    const assigneeType = agentName === null ? AssigneeType.HUMAN : AssigneeType.AGENT;
    const assigneeAgentId: string | null = agentName ? (agentByName.get(agentName)?.id ?? null) : null;
    if (agentName && !assigneeAgentId) throw new Error(`Missing seeded agent ${agentName}`);
    await prisma.taskTemplateStep.upsert({
      where: { taskTemplateId_stepIndex: { taskTemplateId: directTemplate.id, stepIndex } },
      update: { name, assigneeAgentId, assigneeType, runner: null, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious, baseFromStepIndex, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
      create: { taskTemplateId: directTemplate.id, stepIndex, name, assigneeAgentId, assigneeType, runner: null, approvalGate, outputKind, prompt, opensPullRequest, attachmentsFromPrevious, baseFromStepIndex, spawnPolicy: spawnPolicy ?? Prisma.JsonNull },
    });
  }

  console.log(`Seeded ${project.name} from agents/ with ${sources.roles.length} agents, the twelve-step feature template, and the seven-step direct template.`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
