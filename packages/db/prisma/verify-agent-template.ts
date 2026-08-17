import { PrismaClient } from "@prisma/client";

import {
  CANONICAL_AGENT_DEFAULTS,
  CANONICAL_TEMPLATE_STEPS,
  IMPLEMENTATION_PLAN_OUTPUT_KINDS,
  catalogRunnerForModel,
  isTemplateRunnerInherited,
} from "./agent-contract.js";

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
    if (step.stepIndex <= 8 && !isTemplateRunnerInherited(step.runner)) {
      throw new Error(`template step ${step.stepIndex} must inherit its Agent runner; found ${step.runner}`);
    }
    if (step.spawnPolicy !== null) throw new Error(`template step ${step.stepIndex} must not claim an unimplemented spawn policy`);
  }
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
