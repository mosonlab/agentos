import { randomUUID } from "node:crypto";

import {
  AssigneeType,
  canonicalIntegratorBindingRefusal,
  compoundImplementationAssigneeValid,
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
import { isSerializationConflict, serializationRetryDelay } from "./serialization-retry.js";
import { TemplateInstantiationRefusal } from "./template-errors.js";

export type InstantiateTemplateInput = {
  repoId: string;
  variables: Record<string, string>;
  /** Creating a chain is inert unless its caller explicitly requests a run. */
  autoStart?: boolean;
  name?: string | undefined;
  description?: string | undefined;
  /** Per-instantiation assignee changes, keyed by template stepIndex. */
  stepOverrides?: Record<string, { assigneeAgentId: string }> | undefined;
};

const stepOverrideKey = /^[1-9]\d*$/u;

type OverrideAgent = {
  id: string;
  name: string;
  projectId: string;
  archivedAt: Date | null;
};

type EffectiveTemplateStep = {
  step: {
    id: string;
    stepIndex: number;
    name: string;
    assigneeType: AssigneeType;
    assigneeAgentId: string | null;
    assigneeAgent: { id: string; name: string; projectId: string; archivedAt: Date | null } | null;
    prompt: string;
    attachmentsFromPrevious: boolean;
    approvalGate: boolean;
    opensPullRequest: boolean;
    layer: number;
    outputKind: string;
    taskTemplate?: { name: string } | null;
  };
  override: { assigneeAgentId: string } | undefined;
  assigneeAgentId: string | null;
  assigneeAgent: OverrideAgent | EffectiveTemplateStep["step"]["assigneeAgent"];
};

const overrideRefusal = (
  code: string,
  message: string,
): TemplateInstantiationRefusal => new TemplateInstantiationRefusal(code, message);

const retryableTransactionConflict = (error: unknown): boolean => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return true;
  return isSerializationConflict(error);
};

const interpolate = (source: string, variables: Record<string, string>): string => source.replace(
  /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
  (_match, name: string) => variables[name] ?? `{{${name}}}`,
);

export const isUsableTemplateVariable = (value: string | undefined): value is string => (
  value !== undefined && value.trim().length > 0
);

const assertValidBaseReferences = (
  steps: Array<{ name: string; stepIndex: number; baseFromStepIndex: number | null }>,
): void => {
  const indexes = new Set(steps.map((step) => step.stepIndex));
  for (const step of steps) {
    if (step.baseFromStepIndex == null) continue;
    if (!indexes.has(step.baseFromStepIndex)) {
      throw new Error(`Template step ${step.name} baseFromStepIndex ${step.baseFromStepIndex} does not reference the same template`);
    }
    if (step.baseFromStepIndex >= step.stepIndex) {
      throw new Error(`Template step ${step.name} baseFromStepIndex must reference a strictly earlier stepIndex`);
    }
  }
};

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
  const overrideEntries = Object.entries(input.stepOverrides ?? {});
  if (overrideEntries.length > 64) {
    throw overrideRefusal(
      "step_override_too_many",
      `stepOverrides contains ${overrideEntries.length} entries; at most 64 step overrides are allowed`,
    );
  }
  for (const [stepIndex] of overrideEntries) {
    if (!stepOverrideKey.test(stepIndex)) {
      throw overrideRefusal(
        "step_override_invalid_key",
        `Step override key ${stepIndex} must be a positive decimal step index without leading zeros`,
      );
    }
  }
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
  assertValidBaseReferences(template.steps);

  const templateStepsByIndex = new Map(template.steps.map((step) => [String(step.stepIndex), step]));
  for (const [stepIndex] of overrideEntries) {
    if (!templateStepsByIndex.has(stepIndex)) {
      throw overrideRefusal(
        "step_override_unknown_step",
        `Step override names unknown template step ${stepIndex}`,
      );
    }
  }
  const overrideAgentIds = [...new Set(overrideEntries.map(([, override]) => override.assigneeAgentId))].sort();
  const overrideAgents = new Map<string, OverrideAgent>();
  if (overrideAgentIds.length > 0) {
    const rows = await db.agent.findMany({
      where: { projectId, id: { in: overrideAgentIds } },
      select: { id: true, name: true, projectId: true, archivedAt: true },
    });
    for (const row of rows) overrideAgents.set(row.id, row);
  }
  const effectiveSteps = template.steps.map((step): EffectiveTemplateStep => {
    const override = input.stepOverrides?.[String(step.stepIndex)];
    const assigneeAgentId = override?.assigneeAgentId ?? step.assigneeAgentId;
    return {
      step,
      override,
      assigneeAgentId,
      assigneeAgent: override
        ? overrideAgents.get(override.assigneeAgentId) ?? null
        : step.assigneeAgent,
    };
  });

  for (const effective of effectiveSteps) {
    const { step, override, assigneeAgent } = effective;
    if (override && step.assigneeType !== AssigneeType.AGENT) {
      throw overrideRefusal(
        "step_override_step_not_agent",
        `Step override ${step.stepIndex} targets ${step.name}, whose assigneeType is ${step.assigneeType}; only AGENT steps may be overridden`,
      );
    }
    if (override && (!assigneeAgent || assigneeAgent.projectId !== projectId)) {
      throw overrideRefusal(
        "step_override_agent_not_found",
        `Override agent ${override.assigneeAgentId} for step ${step.stepIndex} was not found in this project`,
      );
    }
    // §D-P4, before any task row exists. A doctored template — the sentinel on
    // an ordinary step, or a model agent on the integrator step — fails
    // instantiation rather than materializing a chain that would later claim as
    // the wrong execution mode.
    const bindingRefusal = canonicalIntegratorBindingRefusal(assigneeAgent?.name ?? null, {
      stepIndex: step.stepIndex,
      outputKind: step.outputKind,
      taskTemplateName: template.name,
    });
    if (bindingRefusal) {
      if (override) throw overrideRefusal("step_override_integrator_binding", `Template step ${step.name}: ${bindingRefusal}`);
      throw new Error(`Template step ${step.name}: ${bindingRefusal}`);
    }
    if (step.assigneeType === AssigneeType.AGENT && !assigneeAgent) {
      if (override) {
        throw overrideRefusal(
          "step_override_agent_not_found",
          `Override agent ${override.assigneeAgentId} for step ${step.stepIndex} was not found in this project`,
        );
      }
      throw new Error(`Template step ${step.name} has no agent`);
    }
    if (assigneeAgent?.archivedAt) {
      if (override) {
        throw overrideRefusal(
          "step_override_agent_archived",
          `Override agent ${assigneeAgent.name} (${assigneeAgent.id}) for step ${step.stepIndex} is archived`,
        );
      }
      throw new Error(`Template step ${step.name} agent ${assigneeAgent.name} is archived`);
    }
    if (override && !compoundImplementationAssigneeValid(
      projectId,
      step.assigneeType,
      assigneeAgent,
      { stepIndex: step.stepIndex, outputKind: step.outputKind, taskTemplate: { name: template.name } },
    )) {
      throw overrideRefusal(
        "step_override_compound_implementation",
        `Compound implementation step must remain assigned to the active in-project Agent implementation-plan-executioner (step ${step.stepIndex})`,
      );
    }
    if (assigneeAgent) {
      const access = await db.agentRepoAccess.findFirst({
        where: { agentId: assigneeAgent.id, repoId: repo.id, projectId },
      });
      if (!access) {
        if (override) {
          throw overrideRefusal(
            "step_override_missing_repo_grant",
            `Override agent ${assigneeAgent.name} (${assigneeAgent.id}) for step ${step.stepIndex} has no grant for Repo ${repo.name}`,
          );
        }
        throw new Error(`Agent ${assigneeAgent.name} has no grant for Repo ${repo.name}`);
      }
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
        const canonicalAgentIds = template.steps.flatMap((step) => step.assigneeAgentId ? [step.assigneeAgentId] : []);
        const lockedAgents = await lockAgentRows(
          tx,
          [...new Set([...canonicalAgentIds, ...overrideAgentIds])].sort(),
        );
        for (const effective of effectiveSteps) {
          const { step, override, assigneeAgentId, assigneeAgent } = effective;
          if (!assigneeAgentId) continue;
          if (!lockedAgents.has(assigneeAgentId)) {
            if (override) {
              throw overrideRefusal(
                "step_override_agent_not_found",
                `Override agent ${assigneeAgentId} for step ${step.stepIndex} was not found in this project`,
              );
            }
            throw new Error(`Template step ${step.name} agent was not found`);
          }
          if (lockedAgents.get(assigneeAgentId)) {
            if (override) {
              throw overrideRefusal(
                "step_override_agent_archived",
                `Override agent ${assigneeAgent?.name ?? assigneeAgentId} (${assigneeAgentId}) for step ${step.stepIndex} is archived`,
              );
            }
            throw new Error(`Template step ${step.name} agent ${step.assigneeAgent?.name ?? assigneeAgentId} is archived`);
          }
        }
        const grantedAgentIds = [...new Set(effectiveSteps.flatMap((effective) => (
          effective.assigneeAgentId ? [effective.assigneeAgentId] : []
        )))].sort();
        for (const agentId of grantedAgentIds) {
          const granted = await lockAgentRepoGrant(tx, { projectId, agentId, repoId: repo.id });
          if (!granted) {
            const effective = effectiveSteps.find((candidate) => candidate.assigneeAgentId === agentId);
            const agentName = effective?.assigneeAgent?.name ?? agentId;
            if (effective?.override) {
              throw overrideRefusal(
                "step_override_missing_repo_grant",
                `Override agent ${agentName} (${agentId}) for step ${effective.step.stepIndex} has no grant for Repo ${repo.name}`,
              );
            }
            throw new Error(`Agent ${agentName} has no grant for Repo ${repo.name}`);
          }
        }
        const tasks = [];
        const promptVariables = { ...input.variables, chainId };
        for (const effective of effectiveSteps) {
          const { step } = effective;
          const context = [
            interpolate(step.prompt, promptVariables),
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
            assigneeAgentId: effective.assigneeAgentId,
            approvalGate: step.approvalGate,
            opensPullRequest: step.opensPullRequest,
            chainId,
            chainIndex: step.stepIndex,
            chainLayer: step.layer,
            status: TaskStatus.TODO,
            source: options.source ?? TaskSource.MANUAL,
            targetBranch: step.stepIndex === template.steps[0]!.stepIndex ? repo.defaultBranch : branchName,
          } }));
        }
        const first = tasks[0]!;
        if (first.assigneeType !== AssigneeType.AGENT) throw new Error("The first template step must be agent-executable");
        if (input.autoStart ?? false) {
          await enqueueTaskRun(tx, first.id);
        }
        await tx.taskActivity.createMany({ data: tasks.map((task, index) => ({
          taskId: task.id,
          actorType: options.actorType ?? "control-plane",
          body: index === 0
            ? (input.autoStart ?? false) ? "Template instantiated; first step queued" : "Template instantiated; ready to start"
            : "Template instantiated; waiting for predecessor",
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
      await serializationRetryDelay(attempt);
    }
  }
};
