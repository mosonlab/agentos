import { randomUUID } from "node:crypto";

import {
  AssigneeType,
  canonicalIntegratorBindingRefusal,
  enqueueTaskRun,
  lockAgentRepoGrant,
  lockAgentRows,
  Prisma,
  type PrismaClient,
  TaskSource,
  TaskStatus,
  type TriggerFireSource,
} from "@agentos/db";

import { isValidBranchName } from "./branch-name.js";

export type InstantiateTemplateInput = {
  repoId: string;
  variables: Record<string, string>;
  name?: string | undefined;
  description?: string | undefined;
};

/** serialization_failure and deadlock_detected: both mean "retry the whole transaction". */
const SERIALIZATION_SQLSTATE = new Set(["40001", "40P01"]);

const retryableTransactionConflict = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034" || error.code === "P2002") return true;
  // The Agent-row mutex below is a raw statement, and a raw statement that loses
  // a serializable conflict comes back as P2010 with the SQLSTATE in meta rather
  // than as the P2034 Prisma raises for its own query builder. Without this the
  // conflict escapes as a 500 instead of retrying into the named archive error.
  const sqlstate = (error.meta as { code?: unknown } | undefined)?.code;
  return error.code === "P2010" && typeof sqlstate === "string" && SERIALIZATION_SQLSTATE.has(sqlstate);
};

const retryDelay = async (attempt: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, attempt * 10 + Math.floor(Math.random() * 25)));
};

const interpolate = (source: string, variables: Record<string, string>): string => source.replace(
  /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
  (_match, name: string) => variables[name] ?? `{{${name}}}`,
);

export const isUsableTemplateVariable = (value: string | undefined): value is string => (
  value !== undefined && value.trim().length > 0
);

export const instantiateTemplate = async (
  db: PrismaClient,
  projectId: string,
  templateId: string,
  input: InstantiateTemplateInput,
  options: {
    actorType?: string;
    activityMetadata?: Record<string, unknown>;
    /** Provenance stamped on every task of the chain. */
    source?: TaskSource;
    /** When set, one ledger row is written inside the same transaction, so a
     *  fire that never produced a chain never produced a fire either. */
    fire?: { source: TriggerFireSource; dedupeKey?: string | null };
  } = {},
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
  const missing = template.variables.filter((variable) => !isUsableTemplateVariable(input.variables[variable]));
  const unknown = Object.keys(input.variables).filter((variable) => !template.variables.includes(variable));
  if (missing.length > 0) throw new Error(`Missing template variables: ${missing.join(", ")}`);
  if (unknown.length > 0) throw new Error(`Unknown template variables: ${unknown.join(", ")}`);
  if (input.variables.branchName !== undefined && !isValidBranchName(input.variables.branchName)) {
    throw new Error("Invalid template branch name");
  }
  for (const step of template.steps) {
    // §D-P4, before any task row exists. A doctored template — the sentinel on
    // an ordinary step, or a model agent on the integrator step — fails
    // instantiation rather than materializing a chain that would later claim as
    // the wrong execution mode.
    const bindingRefusal = canonicalIntegratorBindingRefusal(step.assigneeAgent?.name ?? null, {
      stepIndex: step.stepIndex,
      outputKind: step.outputKind,
      taskTemplateName: template.name,
    });
    if (bindingRefusal) throw new Error(`Template step ${step.name}: ${bindingRefusal}`);
    if (step.assigneeType === AssigneeType.AGENT && !step.assigneeAgent) throw new Error(`Template step ${step.name} has no agent`);
    if (step.assigneeAgent?.archivedAt) throw new Error(`Template step ${step.name} agent ${step.assigneeAgent.name} is archived`);
    if (step.assigneeAgent) {
      const access = await db.agentRepoAccess.findFirst({
        where: { agentId: step.assigneeAgent.id, repoId: repo.id, projectId },
      });
      if (!access) throw new Error(`Agent ${step.assigneeAgent.name} has no grant for Repo ${repo.name}`);
    }
  }
  for (let attempt = 1; ; attempt += 1) {
    const chainId = randomUUID();
    const branchName = input.variables.branchName ?? `agentos/${chainId}`;
    try {
      return await db.$transaction(async (tx) => {
        // The step validation above read every assignee outside this
        // transaction. Re-read them all under the shared Agent-row mutex before
        // the first task exists: instantiation writes a whole chain plus its
        // first run, and an archive committing between the check and the write
        // would leave every step of that chain pointed at an agent no runner
        // will ever claim for. One id-ordered statement, so two instantiations
        // sharing agents cannot deadlock.
        const lockedAgents = await lockAgentRows(
          tx,
          template.steps.flatMap((step) => step.assigneeAgentId ? [step.assigneeAgentId] : []),
        );
        for (const step of template.steps) {
          if (!step.assigneeAgentId) continue;
          if (!lockedAgents.has(step.assigneeAgentId)) {
            throw new Error(`Template step ${step.name} agent was not found`);
          }
          if (lockedAgents.get(step.assigneeAgentId)) {
            throw new Error(`Template step ${step.name} agent ${step.assigneeAgent?.name ?? step.assigneeAgentId} is archived`);
          }
        }
        const grantedAgentIds = [...new Set(template.steps.flatMap((step) => (
          step.assigneeAgentId ? [step.assigneeAgentId] : []
        )))].sort();
        for (const agentId of grantedAgentIds) {
          const granted = await lockAgentRepoGrant(tx, { projectId, agentId, repoId: repo.id });
          if (!granted) {
            const agentName = template.steps.find((step) => step.assigneeAgentId === agentId)?.assigneeAgent?.name ?? agentId;
            throw new Error(`Agent ${agentName} has no grant for Repo ${repo.name}`);
          }
        }
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
            opensPullRequest: step.opensPullRequest,
            chainId,
            chainIndex: step.stepIndex,
            status: TaskStatus.TODO,
            source: options.source ?? TaskSource.MANUAL,
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
          actorType: options.actorType ?? "control-plane",
          body: index === 0 ? "Template instantiated; first step queued" : "Template instantiated; waiting for predecessor",
          metadata: { chainId, templateId: template.id, ...options.activityMetadata },
        })) });
        const fire = options.fire
          ? await tx.triggerFire.create({ data: {
            templateId: template.id,
            chainId,
            source: options.fire.source,
            dedupeKey: options.fire.dedupeKey ?? null,
          } })
          : null;
        return { chainId, branchName, tasks, fireId: fire?.id ?? null };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error: unknown) {
      // Six simultaneous webhook fires can form a longer serialization queue
      // than five attempts, even with per-attempt jitter. Twelve bounded tries
      // make the accepted burst deterministic while still surfacing persistent
      // conflicts instead of looping forever.
      if (!retryableTransactionConflict(error) || attempt >= 12) throw error;
      await retryDelay(attempt);
    }
  }
};
