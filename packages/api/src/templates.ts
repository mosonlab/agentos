import { randomUUID } from "node:crypto";

import { AssigneeType, enqueueTaskRun, Prisma, TaskStatus, type PrismaClient } from "@agentos/db";

export type InstantiateTemplateInput = {
  repoId: string;
  variables: Record<string, string>;
  name?: string | undefined;
  description?: string | undefined;
};

const interpolate = (source: string, variables: Record<string, string>): string => source.replace(
  /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
  (_match, name: string) => variables[name] ?? `{{${name}}}`,
);

export const instantiateTemplate = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
  input: InstantiateTemplateInput,
) => {
  const [template, repo] = await Promise.all([
    db.taskTemplate.findFirst({
      where: { id: templateId, projectId },
      include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
    }),
    db.repo.findFirst({ where: { id: input.repoId, projectId } }),
  ]);
  if (!template) throw new Error("Template not found in project");
  if (!repo) throw new Error("Repo not found in project");
  if (template.steps.length === 0) throw new Error("Template has no steps");
  const missing = template.variables.filter((variable) => !input.variables[variable]);
  const unknown = Object.keys(input.variables).filter((variable) => !template.variables.includes(variable));
  if (missing.length > 0) throw new Error(`Missing template variables: ${missing.join(", ")}`);
  if (unknown.length > 0) throw new Error(`Unknown template variables: ${unknown.join(", ")}`);
  for (const step of template.steps) {
    if (step.assigneeType === AssigneeType.AGENT && !step.assigneeAgent) throw new Error(`Template step ${step.name} has no agent`);
    if (step.assigneeAgent) {
      const access = await db.agentRepoAccess.findFirst({
        where: { agentId: step.assigneeAgent.id, repoId: repo.id, projectId },
      });
      if (!access) throw new Error(`Agent ${step.assigneeAgent.name} has no grant for Repo ${repo.name}`);
    }
  }
  const chainId = randomUUID();
  const branchName = input.variables.branchName ?? `agentos/${chainId}`;
  return db.$transaction(async (tx) => {
    const tasks = [];
    for (const step of template.steps) {
      const context = [
        interpolate(step.prompt, input.variables),
        input.description ? `\nFeature brief:\n${input.description}` : "",
        step.attachmentsFromPrevious ? "\nRead the prior template steps' persisted outputs before working." : "",
        `\nPersist the final ${step.outputKind} output for this step through the AgentOS task output endpoint.`,
      ].join("");
      tasks.push(await tx.task.create({ data: {
        projectId,
        repoId: repo.id,
        templateId: template.id,
        templateStepId: step.id,
        name: `${input.name ?? template.name}: ${step.name}`,
        description: context,
        assigneeType: step.assigneeType,
        assigneeAgentId: step.assigneeAgentId,
        approvalGate: step.approvalGate,
        chainId,
        chainIndex: step.stepIndex,
        status: TaskStatus.TODO,
        targetBranch: step.stepIndex === template.steps[0]!.stepIndex ? repo.defaultBranch : branchName,
      } }));
    }
    for (let index = 0; index < tasks.length - 1; index += 1) {
      await tx.task.update({ where: { id: tasks[index]!.id }, data: { followUpTaskId: tasks[index + 1]!.id } });
    }
    const first = tasks[0]!;
    if (first.assigneeType !== AssigneeType.AGENT) throw new Error("The first template step must be agent-executable");
    const run = await enqueueTaskRun(tx, first.id);
    await tx.run.update({ where: { id: run.id }, data: { branch: branchName } });
    await tx.taskActivity.createMany({ data: tasks.map((task, index) => ({
      taskId: task.id,
      actorType: "control-plane",
      body: index === 0 ? "Template instantiated; first step queued" : "Template instantiated; waiting for predecessor",
      metadata: { chainId, templateId: template.id },
    })) });
    return { chainId, branchName, tasks };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};
