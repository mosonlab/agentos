import { AssigneeType, PrismaClient, RunnerKind, RunnerPreference } from "@prisma/client";

import {
  DIRECT_TEMPLATE_NAME,
  IMPLEMENTATION_PLAN_OUTPUT_KINDS,
  catalogRunnerForModel,
  isTemplateRunnerInherited,
} from "../src/agent-contract.js";
import { loadAgentSources, roleSourceStructureDifferences, type RoleSource } from "../src/agent-sources.js";
import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  integratorBindingValid,
} from "../src/merge-integrator.js";
import {
  canonicalTemplateSourceSpec,
  loadAllTemplateStepSources,
  templateStepStructureDifferences,
  type CanonicalTemplateName,
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
  spawnPolicy: Parameters<typeof templateStepStructureDifferences>[0]["spawnPolicy"];
  runner: RunnerKind | null;
  outputKind: string;
  opensPullRequest: boolean;
  requiresCommit: boolean;
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
  if (agent.name !== expected.name) differences.unshift("name");
  const runtimeDifferences = differences.filter((difference) => difference === "model" || difference === "runnerPreference");
  const structuralDifferences = differences.filter((difference) => difference !== "model" && difference !== "runnerPreference");
  if (structuralDifferences.length > 0) {
    const message = `differs from canonical Markdown structure: ${structuralDifferences.join(", ")}`;
    throw new Error(scopedError(context, context.partial ? `Agent ${agentLabel(agent)} ${message}` : `${agent.name} ${message}`));
  }
  if (runtimeDifferences.length > 0 && !agent.runtimeConfigCustomized) {
    const message = "runtime model/runner differs from canonical defaults without an operator override";
    throw new Error(scopedError(context, context.partial ? `Agent ${agentLabel(agent)} ${message}` : `${agent.name} ${message}`));
  }
  if (agent.foundationalPrompt !== foundationalPrompt) {
    const message = "foundational prompt differs from its canonical Markdown source";
    throw new Error(scopedError(context, context.partial ? `Agent ${agentLabel(agent)} ${message}` : `${agent.name} ${message}`));
  }
  if (agent.rolePrompt !== expected.rolePrompt) {
    const message = "role prompt differs from its canonical Markdown source";
    throw new Error(scopedError(context, context.partial ? `Agent ${agentLabel(agent)} ${message}` : `${agent.name} ${message}`));
  }
  const catalogRunner = catalogRunnerForModel(agent.model);
  if (catalogRunner && catalogRunner !== agent.runnerPreference) {
    const message = `runner/model mismatch: ${agent.runnerPreference}/${agent.model}`;
    throw new Error(scopedError(context, context.partial ? `Agent ${agentLabel(agent)} ${message}` : `${agent.name} ${message}`));
  }
};

const verifyTemplateMetadata = (
  template: TemplateRow,
  templateName: CanonicalTemplateName,
  context: VerificationContext,
): void => {
  const differences: string[] = [];
  const expectedDescription = canonicalTemplateSourceSpec(templateName).description;
  if (template.name !== templateName) differences.push("name");
  if (template.description !== expectedDescription) differences.push("description");
  if (JSON.stringify(template.variables) !== JSON.stringify(["branchName"])) differences.push("variables");
  if (differences.length > 0) {
    const message = context.partial
      ? `${templateLabel(template)} differs from canonical template metadata: ${differences.join(", ")}`
      : `${templateName} differs from canonical template metadata: ${differences.join(", ")}`;
    throw new Error(scopedError(context, message));
  }
};

const verifyPartialTemplateStep = (
  template: TemplateRow,
  step: TemplateStepRow,
  expected: TemplateStepSource,
  context: VerificationContext,
): void => {
  const differences = templateStepStructureDifferences(step, expected);
  if (step.stepIndex !== expected.stepIndex) differences.unshift("stepIndex");
  if (!isTemplateRunnerInherited(step.runner)) differences.push("runner");
  if (step.prompt !== expected.prompt) differences.push("prompt");
  if (differences.length > 0) {
    throw new Error(scopedError(
      context,
      `${templateLabel(template)}, ${stepLabel(template, step)} differs from canonical Markdown structure: ${differences.join(", ")}`,
    ));
  }
};

const verifyCompleteTemplateStep = (
  templateName: string,
  step: TemplateStepRow,
  expected: TemplateStepSource,
): void => {
  if (step.stepIndex !== expected.stepIndex) {
    throw new Error(`${templateName} step ${step.stepIndex} must have stepIndex ${expected.stepIndex}; found ${step.stepIndex}`);
  }
  if ((step.assigneeAgent?.name ?? null) !== expected.agentName) {
    throw new Error(`${templateName} step ${step.stepIndex} must bind ${expected.agentName ?? "HUMAN"}; found ${step.assigneeAgent?.name ?? "HUMAN"}`);
  }
  const expectedAssigneeType = expected.agentName === null ? AssigneeType.HUMAN : AssigneeType.AGENT;
  if (step.assigneeType !== expectedAssigneeType) {
    throw new Error(`${templateName} step ${step.stepIndex} assignee type must be ${expectedAssigneeType}; found ${step.assigneeType}`);
  }
  if (step.layer !== expected.layer) {
    throw new Error(`${templateName} step ${step.stepIndex} layer must be ${expected.layer}; found ${step.layer}`);
  }
  if (step.outputKind !== expected.outputKind) {
    throw new Error(`${templateName} step ${step.stepIndex} must persist ${expected.outputKind}; found ${step.outputKind}`);
  }
  if (step.approvalGate !== expected.approvalGate) {
    throw new Error(`${templateName} step ${step.stepIndex} approval gate must be ${expected.approvalGate}; found ${step.approvalGate}`);
  }
  if (step.prompt !== expected.prompt) {
    throw new Error(`${templateName} step ${step.stepIndex} prompt differs from its canonical Markdown source`);
  }
  if (!isTemplateRunnerInherited(step.runner)) {
    throw new Error(`${templateName} step ${step.stepIndex} must inherit its Agent runner; found ${step.runner}`);
  }
  if (step.name !== expected.name) {
    throw new Error(`${templateName} step ${step.stepIndex} name differs from its canonical Markdown source`);
  }
  if (step.attachmentsFromPrevious !== expected.attachmentsFromPrevious) {
    throw new Error(`${templateName} step ${step.stepIndex} attachmentsFromPrevious must be ${expected.attachmentsFromPrevious}; found ${step.attachmentsFromPrevious}`);
  }
  if (JSON.stringify(step.priorOutputKinds) !== JSON.stringify(expected.priorOutputKinds)) {
    throw new Error(`${templateName} step ${step.stepIndex} priorOutputKinds differs from canonical Markdown source; expected ${JSON.stringify(expected.priorOutputKinds)}, found ${JSON.stringify(step.priorOutputKinds)}`);
  }
  if (step.opensPullRequest !== expected.opensPullRequest) {
    throw new Error(`${templateName} step ${step.stepIndex} opensPullRequest must be ${expected.opensPullRequest}; found ${step.opensPullRequest}`);
  }
  if (step.requiresCommit !== expected.requiresCommit) {
    throw new Error(`${templateName} step ${step.stepIndex} requiresCommit must be ${expected.requiresCommit}; found ${step.requiresCommit}`);
  }
  if (step.baseFromStepIndex !== expected.baseFromStepIndex) {
    throw new Error(`${templateName} step ${step.stepIndex} baseFromStepIndex must be ${expected.baseFromStepIndex}; found ${step.baseFromStepIndex}`);
  }
  if (JSON.stringify(step.spawnPolicy) !== JSON.stringify(expected.spawnPolicy)) {
    throw new Error(`${templateName} step ${step.stepIndex} spawnPolicy differs from its canonical Markdown source`);
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
    const message = `${templateName} must contain ${expectedSteps.length} steps; found ${template.steps.length}`;
    throw new Error(scopedError(
      context,
      context.partial ? `${templateLabel(template)} must contain ${expectedSteps.length} steps; found ${template.steps.length}` : message,
    ));
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
    if (context.partial) verifyPartialTemplateStep(template, step, expected, context);
    else verifyCompleteTemplateStep(templateName, step, expected);
  }
};

const specialError = (context: VerificationContext, message: string): Error => new Error(scopedError(context, message));

const verifyCompoundSpecialChecks = (template: TemplateRow, context: VerificationContext): void => {
  const integrator = template.steps.find((step) => step.stepIndex === INTEGRATOR_STEP_INDEX);
  if (!integrator) throw specialError(context, `template must contain step ${INTEGRATOR_STEP_INDEX}`);
  if (integrator.assigneeAgent?.name !== INTEGRATOR_AGENT_NAME) {
    const message = `${stepLabel(template, integrator)} must bind ${INTEGRATOR_AGENT_NAME}; found ${integrator.assigneeAgent?.name ?? "HUMAN"}`;
    throw specialError(context, context.partial ? message : `template step ${INTEGRATOR_STEP_INDEX} must bind ${INTEGRATOR_AGENT_NAME}; found ${integrator.assigneeAgent?.name ?? "HUMAN"}`);
  }
  const integratorAgent = integrator.assigneeAgent;
  if (!integratorAgent) throw specialError(context, `${stepLabel(template, integrator)} has no bound Agent`);
  if (integratorAgent.model !== INTEGRATOR_SENTINEL_MODEL) {
    const message = `Agent ${integratorAgent.name} (${integratorAgent.id}) must carry the mechanical sentinel model ${INTEGRATOR_SENTINEL_MODEL}; found ${integratorAgent.model}`;
    throw specialError(context, context.partial ? message : `${INTEGRATOR_AGENT_NAME} must carry the mechanical sentinel model ${INTEGRATOR_SENTINEL_MODEL}; found ${integratorAgent.model}`);
  }
  if (catalogRunnerForModel(integratorAgent.model) !== null) {
    const message = `Agent ${integratorAgent.name} (${integratorAgent.id}) model ${integratorAgent.model} resolves to a model-CLI runner; it must not`;
    throw specialError(context, context.partial ? message : `${INTEGRATOR_AGENT_NAME} model ${integratorAgent.model} resolves to a model-CLI runner; it must not`);
  }
  if (integrator.outputKind !== INTEGRATOR_OUTPUT_KIND) {
    const message = `${stepLabel(template, integrator)} must persist ${INTEGRATOR_OUTPUT_KIND}; found ${integrator.outputKind}`;
    throw specialError(context, context.partial ? message : `template step ${INTEGRATOR_STEP_INDEX} must persist ${INTEGRATOR_OUTPUT_KIND}; found ${integrator.outputKind}`);
  }
  if (integrator.approvalGate !== false) {
    throw specialError(context, context.partial ? `${stepLabel(template, integrator)} must not carry an approval gate` : `template step ${INTEGRATOR_STEP_INDEX} must not carry an approval gate`);
  }
  if (integrator.opensPullRequest !== false) {
    throw specialError(context, context.partial ? `${stepLabel(template, integrator)} must not open a pull request` : `template step ${INTEGRATOR_STEP_INDEX} must not open a pull request`);
  }
  if (integrator.requiresCommit !== false) {
    throw specialError(context, context.partial ? `${stepLabel(template, integrator)} must not require a workspace commit` : `template step ${INTEGRATOR_STEP_INDEX} must not require a workspace commit`);
  }
  if (integrator.spawnPolicy !== null) {
    throw specialError(context, context.partial ? `${stepLabel(template, integrator)} must not claim a spawn policy` : `template step ${INTEGRATOR_STEP_INDEX} must not claim a spawn policy`);
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
    const message = `${stepLabel(template, directLast)} must end at mechanical merge execution`;
    throw specialError(context, context.partial ? message : `${DIRECT_TEMPLATE_NAME} must end at mechanical merge execution`);
  }
  for (const step of template.steps) {
    if (!integratorBindingValid(step.assigneeAgent?.name ?? null, {
      stepIndex: step.stepIndex,
      outputKind: step.outputKind,
      taskTemplate: { name: DIRECT_TEMPLATE_NAME },
    })) {
      const message = `${stepLabel(template, step)} violates the integrator binding contract`;
      throw specialError(context, context.partial ? message : `${DIRECT_TEMPLATE_NAME} step ${step.stepIndex} violates the integrator binding contract`);
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
