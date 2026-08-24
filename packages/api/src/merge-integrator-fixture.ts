/**
 * Shared fixture for the Merge Integrator v1.1 database tests.
 *
 * The default shape models the canonical thirteen-step Full Assurance tail.
 * Tests that need legacy or production topology opt into the exact named
 * shape; the server-owned readiness row sits between the nearest
 * session-bearing source and the integrator. Both are load-bearing:
 * `isIntegratorStep` is a conjunction over template name, step index, and
 * output kind, so a bad fixture silently tests an ordinary task.
 */

import {
  AssigneeType,
  DIRECT_INTEGRATOR_STEP_INDEX,
  DIRECT_INTEGRATOR_TEMPLATE_NAME,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  LEGACY_DIRECT_INTEGRATOR_STEP_INDEX,
  LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME,
  LEGACY_INTEGRATOR_STEP_INDEX,
  LEGACY_INTEGRATOR_TEMPLATE_NAME,
  type PrismaClient,
  TaskStatus,
} from "@agentos/db";

let sequence = 0;
const unique = (label: string): string => {
  sequence += 1;
  return `${label}-${process.pid}-${Date.now()}-${sequence}`;
};

export type IntegratorChain = Awaited<ReturnType<typeof seedIntegratorChain>>;

type IntegratorFixtureShape =
  | "thirteen-step"
  | "thirteen-step-readiness"
  | "canonical-eight-step-direct"
  | "eight-step-direct"
  | "twelve-step"
  | "twelve-step-readiness"
  | "legacy-seven-step-direct";

export const seedIntegratorChain = async (
  db: PrismaClient,
  options: {
    label?: string;
    prNumbers?: number[];
    withIntegrator?: boolean;
    shape?: IntegratorFixtureShape;
  } = {},
) => {
  const label = options.label ?? "mi";
  // The fixture's default represents the current canonical graph. The
  // twelve-/seven-step variants intentionally model rows preserved under the
  // exact legacy-v1 names so old tail behavior can still be exercised.
  const shape = options.shape ?? "thirteen-step";
  const direct = shape === "canonical-eight-step-direct" || shape === "eight-step-direct" || shape === "legacy-seven-step-direct";
  const legacy = shape === "twelve-step" || shape === "twelve-step-readiness" || shape === "legacy-seven-step-direct";
  const realReadinessTail = direct || shape === "thirteen-step-readiness" || shape === "twelve-step-readiness";
  const integratorIndex = direct
    ? (legacy ? LEGACY_DIRECT_INTEGRATOR_STEP_INDEX : DIRECT_INTEGRATOR_STEP_INDEX)
    : (legacy ? LEGACY_INTEGRATOR_STEP_INDEX : INTEGRATOR_STEP_INDEX);
  const templateName = direct
    ? (legacy ? LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME : DIRECT_INTEGRATOR_TEMPLATE_NAME)
    : (legacy ? LEGACY_INTEGRATOR_TEMPLATE_NAME : INTEGRATOR_TEMPLATE_NAME);
  const project = await db.project.create({ data: { name: label, slug: unique(label) } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: unique("senior-dev"), title: "Senior dev",
    model: "claude-opus-5:high", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const integratorAgent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: INTEGRATOR_AGENT_NAME, title: "Merge integrator",
    model: INTEGRATOR_SENTINEL_MODEL, foundationalPrompt: "foundation", rolePrompt: "mechanical",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id, name: "repo", remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo", defaultBranch: "master",
  } });
  for (const holder of [agent, integratorAgent]) {
    await db.agentRepoAccess.create({ data: {
      projectId: project.id, agentId: holder.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE",
    } });
  }
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: templateName,
    description: direct
      ? (legacy ? "Legacy seven-step Direct workflow" : "Canonical eight-step Direct workflow")
      : (legacy ? "Legacy twelve-step Full Assurance workflow" : "Canonical thirteen-step Full Assurance workflow"),
    variables: [],
  } });
  const gateStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id, stepIndex: realReadinessTail ? integratorIndex - 2 : integratorIndex - 1,
    name: realReadinessTail ? "Regression" : "Approval",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: agent.id, prompt: "deliver", approvalGate: !realReadinessTail,
    outputKind: realReadinessTail ? "regression-verification" : "delivery", opensPullRequest: !direct,
  } });
  const readinessStep = realReadinessTail ? await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id, stepIndex: integratorIndex - 1, name: "Merge readiness",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: agent.id, prompt: "server-owned", approvalGate: false,
    outputKind: "merge-authorization", opensPullRequest: false,
  } }) : null;
  const integratorStep = options.withIntegrator === false ? null : await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id, stepIndex: integratorIndex, name: "Merge",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: integratorAgent.id, prompt: "merge", approvalGate: false,
    outputKind: INTEGRATOR_OUTPUT_KIND, opensPullRequest: false,
  } });
  const chainId = unique("chain");
  const gateTask = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: gateStep.id,
    name: realReadinessTail ? "Regression" : "Approval", description: "approve",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: agent.id,
    approvalGate: !realReadinessTail, chainId, chainIndex: gateStep.stepIndex,
    status: realReadinessTail ? TaskStatus.DONE : TaskStatus.DOING, targetBranch: "master",
  } });
  const readinessTask = readinessStep ? await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: readinessStep.id,
    name: "Merge readiness", description: "server-owned", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agent.id, approvalGate: false, opensPullRequest: false,
    chainId, chainIndex: readinessStep.stepIndex, status: TaskStatus.DONE, targetBranch: "master",
  } }) : null;
  const integratorTask = integratorStep ? await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: integratorStep.id,
    name: "Merge", description: "merge", assigneeType: AssigneeType.AGENT, assigneeAgentId: integratorAgent.id,
    approvalGate: false, opensPullRequest: false, chainId, chainIndex: integratorStep.stepIndex,
    status: TaskStatus.TODO, targetBranch: "master",
  } }) : null;
  if (integratorTask) {
    if (readinessTask) {
      await db.task.update({ where: { id: gateTask.id }, data: { followUpTaskId: readinessTask.id } });
      await db.task.update({ where: { id: readinessTask.id }, data: { followUpTaskId: integratorTask.id } });
    } else {
      await db.task.update({ where: { id: gateTask.id }, data: { followUpTaskId: integratorTask.id } });
    }
  }
  const delivered = await seedDeliveredRun(db, {
    project: project.id, task: gateTask.id, agent: agent.id, repo: repo.id,
    prNumbers: options.prNumbers ?? [123],
  });
  return {
    project, environment, agent, integratorAgent, repo, template, gateStep, readinessStep, integratorStep,
    chainId, gateTask, readinessTask, integratorTask, ...delivered,
  };
};

/**
 * The delivering run whose `pullRequestNumber` the chain target identity is
 * derived from. `prNumbers` takes more than one value so a test can force the
 * ambiguous branch of §D-P8 without reaching into the schema itself.
 */
const seedDeliveredRun = async (
  db: PrismaClient,
  input: { project: string; task: string; agent: string; repo: string; prNumbers: number[] },
) => {
  let session!: { id: string };
  let run!: { id: string };
  for (const [index, prNumber] of input.prNumbers.entries()) {
    const created = await db.run.create({ data: {
      projectId: input.project, taskId: input.task, agentId: input.agent, repoId: input.repo,
      runNumber: index + 1, dedupeKey: `task:${input.task}:run:${index + 1}`, runner: "CLAUDE",
      model: "claude-opus-5:high", promptHash: "hash", status: "SUCCEEDED",
      pullRequestNumber: prNumber, pullRequestUrl: `https://github.com/acme/widgets/pull/${prNumber}`,
      targetBranch: "master", branch: "agentos/chain/demo",
    } });
    const createdSession = await db.session.create({ data: {
      runId: created.id, projectId: input.project, agentId: input.agent, taskId: input.task,
      runner: "CLAUDE", executionStatus: "SUCCEEDED",
    } });
    run = created;
    session = createdSession;
  }
  return { gateRun: run, gateSession: session };
};
