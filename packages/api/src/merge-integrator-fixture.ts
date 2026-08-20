/**
 * Shared fixture for the Merge Integrator v1.1 database tests.
 *
 * Every integrator test needs the same shape — a chain whose step 9 is a human
 * gate and whose step 10 is the mechanical integrator step — and the shape is
 * load-bearing: `isIntegratorStep` is a conjunction over the template name, the
 * step index, and the output kind, so a fixture that gets any of them wrong
 * silently tests the ordinary nine-step path instead. Building it once here
 * keeps the dbtest files honest about what they are exercising.
 */

import {
  AssigneeType,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_OUTPUT_KIND,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  type PrismaClient,
  TaskStatus,
} from "@agentos/db";

let sequence = 0;
const unique = (label: string): string => {
  sequence += 1;
  return `${label}-${process.pid}-${Date.now()}-${sequence}`;
};

export type IntegratorChain = Awaited<ReturnType<typeof seedIntegratorChain>>;

export const seedIntegratorChain = async (
  db: PrismaClient,
  options: { label?: string; prNumbers?: number[]; tenStep?: boolean } = {},
) => {
  const label = options.label ?? "mi";
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
    projectId: project.id, name: INTEGRATOR_TEMPLATE_NAME, description: "Ten-step Full Assurance workflow", variables: [],
  } });
  const gateStep = await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id, stepIndex: INTEGRATOR_STEP_INDEX - 1, name: "Approval",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: agent.id, prompt: "deliver", approvalGate: true,
    outputKind: "delivery", opensPullRequest: true,
  } });
  const integratorStep = options.tenStep === false ? null : await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id, stepIndex: INTEGRATOR_STEP_INDEX, name: "Merge",
    assigneeType: AssigneeType.AGENT, assigneeAgentId: integratorAgent.id, prompt: "merge", approvalGate: false,
    outputKind: INTEGRATOR_OUTPUT_KIND, opensPullRequest: false,
  } });
  const chainId = unique("chain");
  const gateTask = await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: gateStep.id,
    name: "Approval", description: "approve", assigneeType: AssigneeType.AGENT, assigneeAgentId: agent.id,
    approvalGate: true, chainId, chainIndex: gateStep.stepIndex, status: TaskStatus.DOING, targetBranch: "master",
  } });
  const integratorTask = integratorStep ? await db.task.create({ data: {
    projectId: project.id, repoId: repo.id, templateId: template.id, templateStepId: integratorStep.id,
    name: "Merge", description: "merge", assigneeType: AssigneeType.AGENT, assigneeAgentId: integratorAgent.id,
    approvalGate: false, opensPullRequest: false, chainId, chainIndex: integratorStep.stepIndex,
    status: TaskStatus.TODO, targetBranch: "master",
  } }) : null;
  if (integratorTask) {
    await db.task.update({ where: { id: gateTask.id }, data: { followUpTaskId: integratorTask.id } });
  }
  const delivered = await seedDeliveredRun(db, {
    project: project.id, task: gateTask.id, agent: agent.id, repo: repo.id,
    prNumbers: options.prNumbers ?? [123],
  });
  return { project, environment, agent, integratorAgent, repo, template, gateStep, integratorStep, chainId, gateTask, integratorTask, ...delivered };
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
