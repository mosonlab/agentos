import { AssigneeType, Prisma, PrismaClient, RunnerKind, RunnerPreference } from "@prisma/client";

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
import { codexGptCapability } from "../src/run-open.js";
import { stepRole } from "../src/step-role.js";
import { persistedStepAgentIdentity } from "../src/template-step-fields.js";
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
  canonicalRole: string | null;
  title: string;
  model: string;
  customizedFields: string[];
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
  assigneeAgent: {
    id: string;
    name: string;
    canonicalRole?: string | null;
    model: string;
    runnerPreference: RunnerPreference;
  } | null;
};

type TemplateRow = {
  id: string;
  name: string;
  description: string;
  variables: string[];
  steps: TemplateStepRow[];
};

/**
 * The Agent columns canonical sync adopts until the operator marks them, and
 * therefore the columns whose difference from canonical Markdown is an
 * operator decision rather than drift (R9). `name` is among them: an Agent may
 * be renamed, which is why the verifier finds it by role.
 */
const CUSTOMIZABLE_AGENT_FIELDS: readonly string[] = ["name", "title", "model", "runnerPreference"];

const isCustomizableAgentField = (field: string): boolean => CUSTOMIZABLE_AGENT_FIELDS.includes(field);

/**
 * The compound implementation root is a capability, not a name: the step that
 * drives implementation from a plan must bind an Agent that runs on the Codex
 * runner with a `gpt-*` model. This is the same predicate Run open enforces, so
 * the verifier can never pass a binding a Run would refuse.
 */
const compoundImplementationRootCapable = (
  agent: { model: string; runnerPreference: RunnerPreference } | null,
): boolean => agent !== null && codexGptCapability(agent);

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
  // `canonicalRole` is how this row was found, so comparing it here would only
  // restate the lookup; a row that predates the column carries null and is
  // still the role it was installed as. Everything else the Markdown owns is
  // compared, and the four fields an operator may customize (R9) are drift
  // only when `customizedFields` does not claim them.
  const differences = roleSourceStructureDifferences({
    name: agent.name,
    title: agent.title,
    model: agent.model,
    runnerPreference: agent.runnerPreference,
    inboxAccess: agent.inboxAccess,
    collaborators: agent.collaborators,
  }, expected);
  const customizableDifferences = differences.filter((difference) => isCustomizableAgentField(difference));
  const structuralDifferences = differences.filter((difference) => !isCustomizableAgentField(difference));
  if (structuralDifferences.length > 0) {
    throw new Error(scopedError(context, `${agentReference(context, agent)} differs from canonical Markdown structure: ${structuralDifferences.join(", ")}`));
  }
  const unmarkedDifferences = customizableDifferences.filter(
    (difference) => !agent.customizedFields.includes(difference),
  );
  if (unmarkedDifferences.length > 0) {
    const message = `${unmarkedDifferences.join("/")} differs from canonical defaults without an operator override`;
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
  if (persistedStepAgentIdentity(integrator.assigneeAgent) !== INTEGRATOR_AGENT_NAME) {
    throw specialError(context, `${stepReference(context, template, integrator)} must bind ${INTEGRATOR_AGENT_NAME}; found ${persistedStepAgentIdentity(integrator.assigneeAgent) ?? "HUMAN"}`);
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

  const executor = template.steps.find((step) => stepRole({ outputKind: step.outputKind }) === "implementation");
  if (!executor) throw specialError(context, "template must contain a compound implementation root step");
  if (!compoundImplementationRootCapable(executor.assigneeAgent)) {
    throw specialError(
      context,
      `${stepReference(context, template, executor)} must bind a Codex gpt-* Agent; found ${executor.assigneeAgent === null ? "HUMAN" : `${executor.assigneeAgent.runnerPreference}/${executor.assigneeAgent.model}`}`,
    );
  }
  const priorPlan = template.steps.some((step) => (
    step.stepIndex < executor.stepIndex
      && IMPLEMENTATION_PLAN_OUTPUT_KINDS.includes(step.outputKind as typeof IMPLEMENTATION_PLAN_OUTPUT_KINDS[number])
  ));
  if (!priorPlan) throw specialError(context, "the compound implementation root requires an earlier plan or revised-plan output");
};

const verifyDirectSpecialChecks = (template: TemplateRow, context: VerificationContext): void => {
  const directLast = template.steps.at(-1);
  if (!directLast) throw specialError(context, `${DIRECT_TEMPLATE_NAME} must contain a final step`);
  if (persistedStepAgentIdentity(directLast.assigneeAgent) !== INTEGRATOR_AGENT_NAME || directLast.approvalGate !== false) {
    throw specialError(context, `${stepReference(context, template, directLast)} must end at mechanical merge execution`);
  }
  for (const step of template.steps) {
    if (!integratorBindingValid(persistedStepAgentIdentity(step.assigneeAgent), {
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
  // Identity is the role, not the name: an operator may rename an Agent, and
  // the row this verifier means is still the one installed from that role file.
  // A row that predates the column carries its role in its name, and only while
  // no row claims that role — otherwise the same-named row is somebody else's
  // Agent that happens to collide with a freed canonical slug.
  const expectedByRole = new Map(agentSources.roles.map((agent) => [agent.canonicalRole, agent]));
  const canonicalRoles = [...expectedByRole.keys()];
  const activeAgents = await prisma.agent.findMany({
    where: {
      projectId: project.id,
      archivedAt: null,
      ...(partial
        ? { OR: [{ canonicalRole: { in: canonicalRoles } }, { canonicalRole: null, name: { in: canonicalRoles } }] }
        : {}),
    },
    select: {
      id: true,
      name: true,
      canonicalRole: true,
      title: true,
      model: true,
      customizedFields: true,
      runnerPreference: true,
      inboxAccess: true,
      foundationalPrompt: true,
      rolePrompt: true,
      collaborators: { select: { allowedAgent: { select: { name: true } } } },
    },
    orderBy: { name: "asc" },
  });
  const claimedRoles = new Set(activeAgents.flatMap((agent) => (
    agent.canonicalRole === null ? [] : [agent.canonicalRole]
  )));
  const roleOf = (agent: AgentRow): string | null => (
    agent.canonicalRole ?? (claimedRoles.has(agent.name) ? null : agent.name)
  );
  // The inventory comparison uses the row's own identity rather than the
  // matched role, so a custom row squatting on a freed canonical name is a
  // duplicate here instead of disappearing from the count.
  const actualRoles = activeAgents.map((agent) => agent.canonicalRole ?? agent.name).sort();
  const expectedRoles = [...canonicalRoles].sort();
  if (!partial && JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
    throw new Error(`active agents differ from canonical contract: expected ${expectedRoles.join(", ")}; found ${actualRoles.join(", ")}`);
  }
  const canonicalAgents = activeAgents.flatMap((agent) => {
    const role = roleOf(agent);
    const expected = role === null ? undefined : expectedByRole.get(role);
    return expected === undefined ? [] : [{ agent, expected }];
  });
  for (const { agent, expected } of canonicalAgents) {
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
          optional: true,
          attachmentsFromPrevious: true,
          priorOutputKinds: true,
          spawnPolicy: true,
          runner: true,
          outputKind: true,
          opensPullRequest: true,
          requiresCommit: true,
          provisionDependencies: true,
          baseFromStepIndex: true,
          assigneeAgent: {
            select: { id: true, name: true, model: true, runnerPreference: true, canonicalRole: true },
          },
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
  process.stdout.write(`Agent/template contract verified for ${canonicalAgents.length} active agents and ${stepCount} steps across ${templates.length} templates.\n`);
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
