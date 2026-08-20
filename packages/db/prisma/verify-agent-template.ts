import { PrismaClient } from "@prisma/client";

import {
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
} from "../src/merge-integrator.js";

import {
  CANONICAL_AGENT_DEFAULTS,
  CANONICAL_TEMPLATE_STEPS,
  IMPLEMENTATION_PLAN_OUTPUT_KINDS,
  catalogRunnerForModel,
  isTemplateRunnerInherited,
} from "../src/agent-contract.js";

const prisma = new PrismaClient();

const main = async (): Promise<void> => {
  const project = await prisma.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const activeAgents = await prisma.agent.findMany({
    where: { projectId: project.id, archivedAt: null },
    orderBy: { name: "asc" },
  });
  const expectedByName = new Map(CANONICAL_AGENT_DEFAULTS.map((agent) => [agent.name, agent]));
  const actualNames = activeAgents.map((agent) => agent.name).sort();
  const expectedNames = [...expectedByName.keys()].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`active agents differ from canonical contract: expected ${expectedNames.join(", ")}; found ${actualNames.join(", ")}`);
  }
  for (const agent of activeAgents) {
    const expected = expectedByName.get(agent.name)!;
    if (agent.model !== expected.model || agent.runnerPreference !== expected.runner) {
      throw new Error(`${agent.name} differs from canonical default: expected ${expected.runner}/${expected.model}; found ${agent.runnerPreference}/${agent.model}`);
    }
    const catalogRunner = catalogRunnerForModel(agent.model);
    if (catalogRunner && catalogRunner !== agent.runnerPreference) {
      throw new Error(`${agent.name} runner/model mismatch: ${agent.runnerPreference}/${agent.model}`);
    }
  }

  const template = await prisma.taskTemplate.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "compound-engineer-workflow" } },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
  });
  if (template.steps.length !== CANONICAL_TEMPLATE_STEPS.length) {
    throw new Error(`template must contain ${CANONICAL_TEMPLATE_STEPS.length} steps; found ${template.steps.length}`);
  }
  for (const expected of CANONICAL_TEMPLATE_STEPS) {
    const step = template.steps.find((candidate) => candidate.stepIndex === expected.stepIndex);
    if (!step) throw new Error(`template is missing step ${expected.stepIndex}`);
    if ((step.assigneeAgent?.name ?? null) !== expected.agentName) {
      throw new Error(`template step ${step.stepIndex} must bind ${expected.agentName ?? "HUMAN"}; found ${step.assigneeAgent?.name ?? "HUMAN"}`);
    }
    if (step.outputKind !== expected.outputKind) {
      throw new Error(`template step ${step.stepIndex} must persist ${expected.outputKind}; found ${step.outputKind}`);
    }
    if (step.approvalGate !== expected.approvalGate) {
      throw new Error(`template step ${step.stepIndex} approval gate must be ${expected.approvalGate}; found ${step.approvalGate}`);
    }
    if (step.stepIndex <= 8 && !isTemplateRunnerInherited(step.runner)) {
      throw new Error(`template step ${step.stepIndex} must inherit its Agent runner; found ${step.runner}`);
    }
    if (step.spawnPolicy !== null) throw new Error(`template step ${step.stepIndex} must not claim an unimplemented spawn policy`);
    if (step.opensPullRequest !== expected.opensPullRequest) {
      throw new Error(`template step ${step.stepIndex} opensPullRequest must be ${expected.opensPullRequest}; found ${step.opensPullRequest}`);
    }
  }

  // The integrator step, asserted explicitly rather than only through the
  // generic loop. The `stepIndex <= 8` runner-inheritance bound above protects
  // steps 1-8 from a template-pinned runner that would override the Agent's own;
  // step 10 has no Agent runner to inherit at all, because nothing spawns for
  // it. These assertions are what stands in for that protection: an LLM model on
  // this row, or a `true` opensPullRequest, would mean a model CLI could be
  // handed the merge step or the merge step could publish.
  const integrator = template.steps.find((step) => step.stepIndex === INTEGRATOR_STEP_INDEX);
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
  const executor = template.steps.find((step) => step.assigneeAgent?.name === "implementation-plan-executioner");
  if (!executor) throw new Error("template must contain an implementation-plan-executioner step");
  const priorPlan = template.steps.some((step) => (
    step.stepIndex < executor.stepIndex
      && IMPLEMENTATION_PLAN_OUTPUT_KINDS.includes(step.outputKind as typeof IMPLEMENTATION_PLAN_OUTPUT_KINDS[number])
  ));
  if (!priorPlan) throw new Error("implementation-plan-executioner requires an earlier plan or revised-plan output");
  process.stdout.write(`Agent/template contract verified for ${activeAgents.length} active agents and ${template.steps.length} steps.\n`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
