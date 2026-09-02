import { AssigneeType, PrismaClient, RunnerKind, RunnerPreference } from "@prisma/client";

import {
  DIRECT_TEMPLATE_NAME,
  IMPLEMENTATION_PLAN_OUTPUT_KINDS,
  catalogRunnerForModel,
  isTemplateRunnerInherited,
} from "../src/agent-contract.js";
import { loadAgentSources, roleSourceStructureDifferences, type RoleSource } from "../src/agent-sources.js";
import { canonicalStepDrift } from "../src/canonical-step-adoption.js";
import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  integratorBindingValid,
} from "../src/merge-integrator.js";
import {
  loadAllTemplateStepSources,
  templateMetadataDifferences,
  type CanonicalTemplateName,
  type PersistedTemplateStepStructure,
  type TemplateStepSource,
} from "../src/template-sources.js";

const prisma = new PrismaClient();

type VerificationProject = { id: string; slug: string };
type VerificationContext = {
  project: VerificationProject;
  partial: boolean;
};

type AgentRow = {
  id: string;
  name: string;
  title: string;
  model: string;
  runtimeConfigCustomized: boolean;
  runnerPreference: RunnerPreference;
  inboxAccess: boolean;
  foundationalPrompt: string;
  rolePrompt: string;
  collaborators: Array<{ allowedAgent: { name: string } }>;
};

type TemplateStepRow = {
  id: string;
  stepIndex: number;
  name: string;
  layer: number;
  assigneeType: AssigneeType;
  prompt: string;
  approvalGate: boolean;
  attachmentsFromPrevious: boolean;
  priorOutputKinds: string[];
  spawnPolicy: PersistedTemplateStepStructure["spawnPolicy"];
  runner: RunnerKind | null;
  outputKind: string;
  opensPullRequest: boolean;
  requiresCommit: boolean;
  provisionDependencies: boolean;
  baseFromStepIndex: number | null;
  assigneeAgent: { id: string; name: string; model: string } | null;
};

type TemplateRow = {
  id: string;
  name: string;
  description: string;
  variables: string[];
  steps: TemplateStepRow[];
};

const scopedError = (context: VerificationContext, message: string): string => (
  context.partial ? `Project ${context.project.slug}: ${message}` : message
);

const agentLabel = (agent: Pick<AgentRow, "id" | "name">): string => `${agent.name} (${agent.id})`;
const templateLabel = (template: Pick<TemplateRow, "id" | "name">): string => `${template.name} (${template.id})`;
const stepLabel = (template: Pick<TemplateRow, "name">, step: Pick<TemplateStepRow, "id" | "stepIndex">): string => (
  `${template.name} step ${step.stepIndex} (${step.id})`
);
const agentReference = (context: VerificationContext, agent: Pick<AgentRow, "id" | "name">): string => (
  context.partial ? `Agent ${agentLabel(agent)}` : agent.name
);
const templateReference = (context: VerificationContext, template: TemplateRow): string => (
  context.partial ? templateLabel(template) : template.name
);
const stepReference = (context: VerificationContext, template: TemplateRow, step: TemplateStepRow): string => (
  context.partial ? `${templateLabel(template)}, ${stepLabel(template, step)}` : `${template.name} step ${step.stepIndex}`
);

const parseProjectArgument = (): string | null => {
  const args = process.argv.slice(2);
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--project" && args[1]) return args[1];
  throw new Error("Usage: db:verify-agent-template [--project <projectId>]");
};

const verifyAgent = (
  agent: AgentRow,
  expected: RoleSource,
  foundationalPrompt: string,
  context: VerificationContext,
): void => {
  const differences = roleSourceStructureDifferences(agent, expected);
  const runtimeDifferences = differences.filter((difference) => difference === "model" || difference === "runnerPreference");
  const structuralDifferences = differences.filter((difference) => difference !== "model" && difference !== "runnerPreference");
  if (structuralDifferences.length > 0) {
    throw new Error(scopedError(context, `${agentReference(context, agent)} differs from canonical Markdown structure: ${structuralDifferences.join(", ")}`));
  }
  if (runtimeDifferences.length > 0 && !agent.runtimeConfigCustomized) {
    const message = "runtime model/runner differs from canonical defaults without an operator override";
    throw new Error(scopedError(context, `${agentReference(context, agent)} ${message}`));
  }
  if (agent.foundationalPrompt !== foundationalPrompt) {
    const message = "foundational prompt differs from its canonical Markdown source";
    throw new Error(scopedError(context, `${agentReference(context, agent)} ${message}`));
  }
  if (agent.rolePrompt !== expected.rolePrompt) {
    const message = "role prompt differs from its canonical Markdown source";
    throw new Error(scopedError(context, `${agentReference(context, agent)} ${message}`));
  }
  const catalogRunner = catalogRunnerForModel(agent.model);
  if (catalogRunner && catalogRunner !== agent.runnerPreference) {
    const message = `runner/model mismatch: ${agent.runnerPreference}/${agent.model}`;
    throw new Error(scopedError(context, `${agentReference(context, agent)} ${message}`));
  }
};

const verifyTemplateMetadata = (
  template: TemplateRow,
  templateName: CanonicalTemplateName,
  context: VerificationContext,
): void => {
  const differences = templateMetadataDifferences(template, templateName);
  if (differences.length > 0) {
    throw new Error(scopedError(context, `${templateReference(context, template)} differs from canonical template metadata: ${differences.join(", ")}`));
  }
};

/**
 * The verifier states the zero-tolerance stance against the same adoption
 * roster the plan and the sync consult: a persisted step that the sync would
 * still have to adopt has not been installed yet, so it is drift here.
 */
const verifyTemplateStep = (
  template: TemplateRow,
  templateName: CanonicalTemplateName,
  step: TemplateStepRow,
  expected: TemplateStepSource,
  context: VerificationContext,
): void => {
  const differences = canonicalStepDrift(templateName, step, expected, "refuse-all");
  if (step.stepIndex !== expected.stepIndex) differences.unshift("stepIndex");
  if (!isTemplateRunnerInherited(step.runner)) differences.push("runner");
  if (step.prompt !== expected.prompt) differences.push("prompt");
  if (differences.length > 0) {
    throw new Error(scopedError(
      context,
      `${stepReference(context, template, step)} differs from canonical Markdown structure: ${differences.join(", ")}`,
    ));
  }
};

const verifyTemplate = (
  template: TemplateRow,
  templateName: CanonicalTemplateName,
  expectedSteps: readonly TemplateStepSource[],
  context: VerificationContext,
): void => {
  verifyTemplateMetadata(template, templateName, context);
  if (template.steps.length !== expectedSteps.length) {
    throw new Error(scopedError(context, `${templateReference(context, template)} must contain ${expectedSteps.length} steps; found ${template.steps.length}`));
  }
  if (context.partial) {
    const expectedIndexes = new Set(expectedSteps.map((step) => step.stepIndex));
    const unexpected = template.steps.find((step) => !expectedIndexes.has(step.stepIndex));
    if (unexpected) {
      throw new Error(scopedError(
        context,
        `${templateLabel(template)}, ${stepLabel(template, unexpected)} has an unexpected stepIndex; canonical indexes are ${[...expectedIndexes].join(", ")}`,
      ));
    }
  }
  for (const expected of expectedSteps) {
    const step = template.steps.find((candidate) => candidate.stepIndex === expected.stepIndex);
    if (!step) {
      const message = `${templateName} is missing step ${expected.stepIndex}`;
      throw new Error(scopedError(
        context,
        context.partial ? `${templateLabel(template)} is missing step ${expected.stepIndex}` : message,
      ));
    }
    verifyTemplateStep(template, templateName, step, expected, context);
  }
};

const specialError = (context: VerificationContext, message: string): Error => new Error(scopedError(context, message));

const verifyCompoundSpecialChecks = (template: TemplateRow, context: VerificationContext): void => {
  const integrator = template.steps.find((step) => step.stepIndex === INTEGRATOR_STEP_INDEX);
  if (!integrator) throw specialError(context, `template must contain step ${INTEGRATOR_STEP_INDEX}`);
  if (integrator.assigneeAgent?.name !== INTEGRATOR_AGENT_NAME) {
    throw specialError(context, `${stepReference(context, template, integrator)} must bind ${INTEGRATOR_AGENT_NAME}; found ${integrator.assigneeAgent?.name ?? "HUMAN"}`);
  }
  const integratorAgent = integrator.assigneeAgent;
  if (!integratorAgent) throw specialError(context, `${stepLabel(template, integrator)} has no bound Agent`);
  if (integratorAgent.model !== INTEGRATOR_SENTINEL_MODEL) {
    throw specialError(context, `${agentReference(context, integratorAgent)} must carry the mechanical sentinel model ${INTEGRATOR_SENTINEL_MODEL}; found ${integratorAgent.model}`);
  }
  if (catalogRunnerForModel(integratorAgent.model) !== null) {
    throw specialError(context, `${agentReference(context, integratorAgent)} model ${integratorAgent.model} resolves to a model-CLI runner; it must not`);
  }
  if (integrator.outputKind !== INTEGRATOR_OUTPUT_KIND) {
    throw specialError(context, `${stepReference(context, template, integrator)} must persist ${INTEGRATOR_OUTPUT_KIND}; found ${integrator.outputKind}`);
  }
  if (integrator.approvalGate !== false) {
    throw specialError(context, `${stepReference(context, template, integrator)} must not carry an approval gate`);
  }
  if (integrator.opensPullRequest !== false) {
    throw specialError(context, `${stepReference(context, template, integrator)} must not open a pull request`);
  }
  if (integrator.requiresCommit !== false) {
    throw specialError(context, `${stepReference(context, template, integrator)} must not require a workspace commit`);
  }
  if (integrator.spawnPolicy !== null) {
    throw specialError(context, `${stepReference(context, template, integrator)} must not claim a spawn policy`);
  }

  const executor = template.steps.find((step) => step.assigneeAgent?.name === "implementation-plan-executioner");
  if (!executor) throw specialError(context, "template must contain an implementation-plan-executioner step");
  const priorPlan = template.steps.some((step) => (
    step.stepIndex < executor.stepIndex
      && IMPLEMENTATION_PLAN_OUTPUT_KINDS.includes(step.outputKind as typeof IMPLEMENTATION_PLAN_OUTPUT_KINDS[number])
  ));
  if (!priorPlan) throw specialError(context, "implementation-plan-executioner requires an earlier plan or revised-plan output");
};

const verifyDirectSpecialChecks = (template: TemplateRow, context: VerificationContext): void => {
  const directLast = template.steps.at(-1);
  if (!directLast) throw specialError(context, `${DIRECT_TEMPLATE_NAME} must contain a final step`);
  if (directLast.assigneeAgent?.name !== INTEGRATOR_AGENT_NAME || directLast.approvalGate !== false) {
    throw specialError(context, `${stepReference(context, template, directLast)} must end at mechanical merge execution`);
  }
  for (const step of template.steps) {
    if (!integratorBindingValid(step.assigneeAgent?.name ?? null, {
      stepIndex: step.stepIndex,
      outputKind: step.outputKind,
      taskTemplate: { name: DIRECT_TEMPLATE_NAME },
    })) {
      throw specialError(context, `${stepReference(context, template, step)} violates the integrator binding contract`);
    }
  }
};

const main = async (): Promise<void> => {
  const requestedProjectId = parseProjectArgument();
  const [templateSources, agentSources] = await Promise.all([loadAllTemplateStepSources(), loadAgentSources()]);
  const project = requestedProjectId === null
    ? await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" }, select: { id: true, slug: true } })
    : await prisma.project.findUnique({ where: { id: requestedProjectId }, select: { id: true, slug: true } });
  if (!project) throw new Error(`Project ${requestedProjectId} was not found`);

  const partial = requestedProjectId !== null;
  const context: VerificationContext = { project, partial };
  const expectedByName = new Map(agentSources.roles.map((agent) => [agent.name, agent]));
  const activeAgents = await prisma.agent.findMany({
    where: {
      projectId: project.id,
      archivedAt: null,
      ...(partial ? { name: { in: [...expectedByName.keys()] } } : {}),
    },
    select: {
      id: true,
      name: true,
      title: true,
      model: true,
      runtimeConfigCustomized: true,
      runnerPreference: true,
      inboxAccess: true,
      foundationalPrompt: true,
      rolePrompt: true,
      collaborators: { select: { allowedAgent: { select: { name: true } } } },
    },
    orderBy: { name: "asc" },
  });
  const actualNames = activeAgents.map((agent) => agent.name).sort();
  const expectedNames = [...expectedByName.keys()].sort();
  if (!partial && JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`active agents differ from canonical contract: expected ${expectedNames.join(", ")}; found ${actualNames.join(", ")}`);
  }
  for (const agent of activeAgents) {
    const expected = expectedByName.get(agent.name);
    if (!expected) continue;
    verifyAgent(agent, expected, agentSources.foundationalPrompt, context);
  }

  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: [...templateSources.keys()] } },
    select: {
      id: true,
      name: true,
      description: true,
      variables: true,
      steps: {
        select: {
          id: true,
          stepIndex: true,
          name: true,
          layer: true,
          assigneeType: true,
          prompt: true,
          approvalGate: true,
          attachmentsFromPrevious: true,
          priorOutputKinds: true,
          spawnPolicy: true,
          runner: true,
          outputKind: true,
          opensPullRequest: true,
          requiresCommit: true,
          provisionDependencies: true,
          baseFromStepIndex: true,
          assigneeAgent: { select: { id: true, name: true, model: true } },
        },
        orderBy: { stepIndex: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });
  if (!partial && templates.length !== templateSources.size) {
    throw new Error(`expected ${templateSources.size} canonical templates; found ${templates.length}`);
  }

  for (const template of templates) {
    const templateName = [...templateSources.keys()].find((name) => name === template.name);
    if (!templateName) continue;
    const expectedSteps = templateSources.get(templateName)!;
    verifyTemplate(template, templateName, expectedSteps, context);
  }

  const compound = templates.find((template) => template.name === INTEGRATOR_TEMPLATE_NAME);
  if (compound) verifyCompoundSpecialChecks(compound, context);
  const direct = templates.find((template) => template.name === DIRECT_TEMPLATE_NAME);
  if (direct) verifyDirectSpecialChecks(direct, context);

  const stepCount = templates.reduce((sum, template) => sum + template.steps.length, 0);
  process.stdout.write(`Agent/template contract verified for ${activeAgents.length} active agents and ${stepCount} steps across ${templates.length} templates.\n`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
