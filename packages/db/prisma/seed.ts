import { AssigneeType, CodexServiceTier, PrismaClient } from "@prisma/client";

import { DIRECT_TEMPLATE_NAME } from "../src/agent-contract.js";
import { loadAgentSources } from "../src/agent-sources.js";
import {
  applyCanonicalInstallation,
  planCanonicalInstallation,
  type CanonicalInstallationRow,
} from "../src/canonical-template-installation.js";
import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_TEMPLATE_NAME,
  legacyHumanTwelveStepTemplateName,
  legacyNineStepTemplateName,
  legacyRegressionFirstThirteenStepTemplateName,
  legacyTenStepTemplateName,
} from "../src/merge-integrator.js";
import { loadAllTemplateStepSources } from "../src/template-sources.js";

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

type HistoricalSeedTemplate = Readonly<{
  id: string;
  steps: readonly {
    stepIndex: number;
    assigneeType: AssigneeType;
    approvalGate: boolean;
    outputKind: string;
    assigneeAgent: { name: string } | null;
  }[];
}>;

const historicalSeedLegacyName = (
  templateName: "compound-engineer-workflow" | "direct-engineer-workflow",
  existing: HistoricalSeedTemplate,
): string | null => {
  if (templateName === "direct-engineer-workflow") {
    return existing.steps.length === 6
      && existing.steps[5]?.assigneeType === AssigneeType.HUMAN
      && existing.steps[5]?.outputKind === "approval"
      ? `${templateName}-legacy-human-6-${existing.id}`
      : null;
  }

  const historicalIntegrator = existing.steps.find((step) => step.stepIndex === 10);
  const isHistoricalNineStepTemplate = existing.steps.length === HISTORICAL_NINE_STEP_CONTRACT.length
    && HISTORICAL_NINE_STEP_CONTRACT.every(([stepIndex, agentName, assigneeType, outputKind, approvalGate], index) => {
      const step = existing.steps[index];
      return step?.stepIndex === stepIndex
        && (step.assigneeAgent?.name ?? null) === agentName
        && step.assigneeType === assigneeType
        && step.outputKind === outputKind
        && step.approvalGate === approvalGate;
    });
  const isHistoricalTenStepTemplate = existing.steps.length === 10
    && existing.steps.every((step, index) => step.stepIndex === index + 1)
    && historicalIntegrator?.outputKind === INTEGRATOR_OUTPUT_KIND
    && historicalIntegrator.assigneeAgent?.name === INTEGRATOR_AGENT_NAME;
  const isHistoricalHumanTwelveStepTemplate = existing.steps.length === 12
    && existing.steps[10]?.assigneeType === AssigneeType.HUMAN
    && existing.steps[10]?.outputKind === "approval"
    && existing.steps[11]?.assigneeAgent?.name === INTEGRATOR_AGENT_NAME
    && existing.steps[11]?.outputKind === INTEGRATOR_OUTPUT_KIND;
  const isRegressionFirstThirteenStepTemplate = existing.steps.length === 13
    && existing.steps.every((step, index) => step.stepIndex === index + 1)
    && existing.steps[9]?.assigneeAgent?.name === "regression-verifier"
    && existing.steps[9]?.outputKind === "regression-verification"
    && existing.steps[10]?.assigneeAgent?.name === "librarian"
    && existing.steps[10]?.outputKind === "documentation"
    && existing.steps[11]?.outputKind === "merge-authorization"
    && existing.steps[12]?.assigneeAgent?.name === INTEGRATOR_AGENT_NAME
    && existing.steps[12]?.outputKind === INTEGRATOR_OUTPUT_KIND;

  if (isHistoricalHumanTwelveStepTemplate) return legacyHumanTwelveStepTemplateName(existing.id);
  if (isRegressionFirstThirteenStepTemplate) return legacyRegressionFirstThirteenStepTemplateName(existing.id);
  if (isHistoricalNineStepTemplate) return legacyNineStepTemplateName(existing.id);
  if (isHistoricalTenStepTemplate) return legacyTenStepTemplateName(existing.id);
  return null;
};

const main = async (): Promise<void> => {
  const [sources, templateStepsByName] = await Promise.all([loadAgentSources(), loadAllTemplateStepSources()]);
  const project = await prisma.project.upsert({
    where: { slug: "agentos-example" },
    update: {},
    create: {
      name: "Anneal Example",
      slug: "agentos-example",
      yamlDocument: "# Managed by Anneal; YAML sync arrives after v1.\n",
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
      select: { runtimeConfigCustomized: true },
    });
    const runtimeConfigCustomized = existing?.runtimeConfigCustomized === true;
    const useCanonicalRuntimeConfig = !runtimeConfigCustomized;
    await prisma.agent.upsert({
      where: { projectId_name: { projectId: project.id, name: role.name } },
      update: {
        environmentId: environment.id,
        title: role.title,
        ...(useCanonicalRuntimeConfig ? { model: role.model, runnerPreference: role.runnerPreference } : {}),
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
  const canonicalNames = [INTEGRATOR_TEMPLATE_NAME, DIRECT_TEMPLATE_NAME] as const;
  await prisma.$transaction(async (tx) => {
    const installationRows: CanonicalInstallationRow[] = [];
    for (const templateName of canonicalNames) {
      const existing = await tx.taskTemplate.findUnique({
        where: { projectId_name: { projectId: project.id, name: templateName } },
        include: {
          steps: {
            include: { assigneeAgent: { select: { name: true } } },
            orderBy: { stepIndex: "asc" },
          },
        },
      });
      if (!existing) continue;
      installationRows.push({
        ...existing,
        name: templateName,
        steps: existing.steps as unknown as CanonicalInstallationRow["steps"],
        legacyNameOverride: historicalSeedLegacyName(templateName, existing),
      });
    }

    const plan = planCanonicalInstallation(installationRows, templateStepsByName, [project.id]);
    await applyCanonicalInstallation(
      tx,
      plan,
      templateStepsByName,
      { synchronizeCurrent: true },
    );
    const templates = await tx.taskTemplate.findMany({
      where: { projectId: project.id, name: { in: [...canonicalNames] } },
    });
    if (templates.length !== canonicalNames.length) {
      throw new Error(`Canonical installation produced ${templates.length} of ${canonicalNames.length} templates`);
    }
  }, { timeout: 30_000 });

  console.log(`Seeded ${project.name} from agents/ with ${sources.roles.length} agents, the twelve-step feature template, and the eight-step bound-capable direct template.`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
