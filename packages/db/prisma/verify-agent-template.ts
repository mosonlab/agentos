import { AssigneeType, PrismaClient } from "@prisma/client";

import {
  DIRECT_TEMPLATE_NAME,
  IMPLEMENTATION_PLAN_OUTPUT_KINDS,
  catalogRunnerForModel,
  isTemplateRunnerInherited,
} from "../src/agent-contract.js";
import { loadAgentSources, roleSourceStructureDifferences } from "../src/agent-sources.js";
import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  integratorBindingValid,
} from "../src/merge-integrator.js";
import { loadAllTemplateStepSources } from "../src/template-sources.js";

const prisma = new PrismaClient();

const main = async (): Promise<void> => {
  const [templateSources, agentSources] = await Promise.all([loadAllTemplateStepSources(), loadAgentSources()]);
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const activeAgents = await prisma.agent.findMany({
    where: { projectId: project.id, archivedAt: null },
    include: { collaborators: { select: { allowedAgent: { select: { name: true } } } } },
    orderBy: { name: "asc" },
  });
  const expectedByName = new Map(agentSources.roles.map((agent) => [agent.name, agent]));
  const actualNames = activeAgents.map((agent) => agent.name).sort();
  const expectedNames = [...expectedByName.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`active agents differ from canonical contract: expected ${expectedNames.join(", ")}; found ${actualNames.join(", ")}`);
  }
  for (const agent of activeAgents) {
    const expected = expectedByName.get(agent.name)!;
    const differences = roleSourceStructureDifferences(agent, expected);
    if (differences.length > 0) {
      throw new Error(`${agent.name} differs from canonical Markdown structure: ${differences.join(", ")}`);
    }
    if (agent.foundationalPrompt !== agentSources.foundationalPrompt) {
      throw new Error(`${agent.name} foundational prompt differs from its canonical Markdown source`);
    }
    if (agent.rolePrompt !== expected.rolePrompt) {
      throw new Error(`${agent.name} role prompt differs from its canonical Markdown source`);
    }
    const catalogRunner = catalogRunnerForModel(agent.model);
    if (catalogRunner && catalogRunner !== agent.runnerPreference) {
      throw new Error(`${agent.name} runner/model mismatch: ${agent.runnerPreference}/${agent.model}`);
    }
  }

  const templates = await prisma.taskTemplate.findMany({
    where: { projectId: project.id, name: { in: [...templateSources.keys()] } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
    orderBy: { name: "asc" },
  });
  if (templates.length !== templateSources.size) {
    throw new Error(`expected ${templateSources.size} canonical templates; found ${templates.length}`);
  }

  for (const [templateName, expectedSteps] of templateSources) {
    const template = templates.find((candidate) => candidate.name === templateName);
    if (!template) throw new Error(`template ${templateName} was not found`);
    if (template.steps.length !== expectedSteps.length) {
      throw new Error(`${templateName} must contain ${expectedSteps.length} steps; found ${template.steps.length}`);
    }
    for (const expected of expectedSteps) {
      const step = template.steps.find((candidate) => candidate.stepIndex === expected.stepIndex);
      if (!step) throw new Error(`${templateName} is missing step ${expected.stepIndex}`);
      if ((step.assigneeAgent?.name ?? null) !== expected.agentName) {
        throw new Error(`${templateName} step ${step.stepIndex} must bind ${expected.agentName ?? "HUMAN"}; found ${step.assigneeAgent?.name ?? "HUMAN"}`);
      }
      const expectedAssigneeType = expected.agentName === null ? AssigneeType.HUMAN : AssigneeType.AGENT;
      if (step.assigneeType !== expectedAssigneeType) {
        throw new Error(`${templateName} step ${step.stepIndex} assignee type must be ${expectedAssigneeType}; found ${step.assigneeType}`);
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
      if (JSON.stringify(step.spawnPolicy) !== JSON.stringify(expected.spawnPolicy)) {
        throw new Error(`${templateName} step ${step.stepIndex} spawnPolicy differs from its canonical Markdown source`);
      }
      if (step.opensPullRequest !== expected.opensPullRequest) {
        throw new Error(`${templateName} step ${step.stepIndex} opensPullRequest must be ${expected.opensPullRequest}; found ${step.opensPullRequest}`);
      }
      if (step.attachmentsFromPrevious !== expected.attachmentsFromPrevious) {
        throw new Error(`${templateName} step ${step.stepIndex} attachmentsFromPrevious must be ${expected.attachmentsFromPrevious}; found ${step.attachmentsFromPrevious}`);
      }
    }
  }

  const compound = templates.find((template) => template.name === INTEGRATOR_TEMPLATE_NAME)!;
  const integrator = compound.steps.find((step) => step.stepIndex === INTEGRATOR_STEP_INDEX);
  if (!integrator) throw new Error(`template must contain step ${INTEGRATOR_STEP_INDEX}`);
  if (integrator.assigneeAgent?.name !== INTEGRATOR_AGENT_NAME) {
    throw new Error(`template step ${INTEGRATOR_STEP_INDEX} must bind ${INTEGRATOR_AGENT_NAME}; found ${integrator.assigneeAgent?.name ?? "HUMAN"}`);
  }
  if (integrator.assigneeAgent.model !== INTEGRATOR_SENTINEL_MODEL) {
    throw new Error(`${INTEGRATOR_AGENT_NAME} must carry the mechanical sentinel model ${INTEGRATOR_SENTINEL_MODEL}; found ${integrator.assigneeAgent.model}`);
  }
  if (catalogRunnerForModel(integrator.assigneeAgent.model) !== null) {
    throw new Error(`${INTEGRATOR_AGENT_NAME} model ${integrator.assigneeAgent.model} resolves to a model-CLI runner; it must not`);
  }
  if (integrator.outputKind !== INTEGRATOR_OUTPUT_KIND) {
    throw new Error(`template step ${INTEGRATOR_STEP_INDEX} must persist ${INTEGRATOR_OUTPUT_KIND}; found ${integrator.outputKind}`);
  }
  if (integrator.approvalGate !== false) throw new Error(`template step ${INTEGRATOR_STEP_INDEX} must not carry an approval gate`);
  if (integrator.opensPullRequest !== false) throw new Error(`template step ${INTEGRATOR_STEP_INDEX} must not open a pull request`);
  if (integrator.spawnPolicy !== null) throw new Error(`template step ${INTEGRATOR_STEP_INDEX} must not claim a spawn policy`);

  const executor = compound.steps.find((step) => step.assigneeAgent?.name === "implementation-plan-executioner");
  if (!executor) throw new Error("template must contain an implementation-plan-executioner step");
  const priorPlan = compound.steps.some((step) => (
    step.stepIndex < executor.stepIndex
      && IMPLEMENTATION_PLAN_OUTPUT_KINDS.includes(step.outputKind as typeof IMPLEMENTATION_PLAN_OUTPUT_KINDS[number])
  ));
  if (!priorPlan) throw new Error("implementation-plan-executioner requires an earlier plan or revised-plan output");

  const direct = templates.find((template) => template.name === DIRECT_TEMPLATE_NAME)!;
  const directLast = direct.steps.at(-1)!;
  if (directLast.assigneeAgent?.name !== INTEGRATOR_AGENT_NAME || directLast.approvalGate !== false) {
    throw new Error(`${DIRECT_TEMPLATE_NAME} must end at mechanical merge execution`);
  }
  for (const step of direct.steps) {
    if (!integratorBindingValid(step.assigneeAgent?.name ?? null, {
      stepIndex: step.stepIndex,
      outputKind: step.outputKind,
      taskTemplate: { name: DIRECT_TEMPLATE_NAME },
    })) {
      throw new Error(`${DIRECT_TEMPLATE_NAME} step ${step.stepIndex} violates the integrator binding contract`);
    }
  }

  const stepCount = templates.reduce((sum, template) => sum + template.steps.length, 0);
  process.stdout.write(`Agent/template contract verified for ${activeAgents.length} active agents and ${stepCount} steps across ${templates.length} templates.\n`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
