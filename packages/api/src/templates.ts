import { randomUUID } from "node:crypto";

import {
  AssigneeType,
  canonicalIntegratorBindingRefusal,
  compoundImplementationAssigneeValid,
  enqueueTaskRun,
  lockAgentRepoGrant,
  lockAgentRows,
  lockChainRows,
  Prisma,
  type PrismaClient,
  TaskSource,
  TaskStatus,
  type TriggerFireSource,
} from "@agentos/db";

import { isValidBranchName } from "./branch-name.js";
import { composeBrief } from "./task-brief.js";
import { TemplateInstantiationRefusal } from "./template-errors.js";
import { serializable } from "./transaction.js";

export type InstantiateTemplateInput = {
  repoId: string;
  variables: Record<string, string>;
  /** Creating a chain is inert unless its caller explicitly requests a run. */
  autoStart?: boolean;
  name?: string | undefined;
  description?: string | undefined;
  /** Existing terminal task whose completion will dispatch this chain. */
  afterTaskId?: string | undefined;
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
    priorOutputKinds: string[];
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

type DispatchPredecessor = {
  id: string;
  projectId: string;
  chainId: string;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatus;
  archivedAt: Date | null;
  name: string;
};

type DispatchChainRow = {
  id: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatus;
  archivedAt: Date | null;
  name: string;
};

const overrideRefusal = (
  code: string,
  message: string,
): TemplateInstantiationRefusal => new TemplateInstantiationRefusal(code, message);

const bindingRefusal = (
  code: string,
  message: string,
): TemplateInstantiationRefusal => new TemplateInstantiationRefusal(code, message);

const executionLayer = (task: { chainLayer: number | null; chainIndex: number | null }): number | null => (
  task.chainLayer ?? task.chainIndex
);

const dispatchBindingUniqueConflict = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const meta = error.meta as { target?: unknown } | undefined;
  const targets = Array.isArray(meta?.target)
    ? meta.target.map((target) => String(target))
    : [String(meta?.target ?? "")];
  return targets.some((target) => target.includes("dispatchAfterTaskId"))
    || error.message.includes("dispatchAfterTaskId");
};

const retryableTemplateUniqueConflict = (error: unknown): boolean => {
  if (dispatchBindingUniqueConflict(error)) return false;
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
};

/** Substitute {{name}} placeholders, leaving an unknown name in place so it stays visible. */
export const interpolate = (source: string, variables: Record<string, string>): string => source.replace(
  /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
  (_match, name: string) => variables[name] ?? `{{${name}}}`,
);

export const composeTemplateTaskDescription = (input: {
  prompt: string;
  featureBrief?: string | undefined;
  priorOutputKinds: readonly string[];
  outputKind: string;
}): string => composeBrief({
  prompt: input.prompt,
  brief: input.featureBrief,
  attachmentsFromPrevious: input.priorOutputKinds.length > 0,
  outputKind: input.outputKind,
});

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
  if (input.afterTaskId && input.autoStart) {
    throw bindingRefusal(
      "dispatch_conflicts_with_auto_start",
      `afterTaskId ${input.afterTaskId} cannot be combined with autoStart=true; a bound chain waits for its predecessor`,
    );
  }
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
  try {
    return await serializable(db, async (tx) => {
      const chainId = randomUUID();
      const branchName = input.variables.branchName ?? `agentos/${chainId}`;
        let predecessor: DispatchPredecessor | null = null;
        if (input.afterTaskId) {
          // The first read only discovers the chain mutex to take. No
          // predecessor state is trusted until the full chain is locked and
          // re-read below. A missing or non-chain task has no chain mutex to
          // take and is refused directly.
          const predecessorIdentity = await tx.task.findFirst({
            where: { id: input.afterTaskId, projectId },
            select: { id: true, chainId: true },
          });
          if (!predecessorIdentity) {
            throw bindingRefusal(
              "after_task_not_found",
              `Predecessor task ${input.afterTaskId} was not found in this project`,
            );
          }
          if (!predecessorIdentity.chainId) {
            throw bindingRefusal(
              "after_task_not_chained",
              `Predecessor task ${input.afterTaskId} is not a chained task`,
            );
          }
          await lockChainRows(tx, { projectId, chainId: predecessorIdentity.chainId });
          const chainRows: DispatchChainRow[] = await tx.task.findMany({
            where: { projectId, chainId: predecessorIdentity.chainId },
            select: {
              id: true,
              chainId: true,
              chainIndex: true,
              chainLayer: true,
              status: true,
              archivedAt: true,
              name: true,
            },
          });
          const lockedPredecessor = chainRows.find((row) => row.id === input.afterTaskId);
          if (!lockedPredecessor || !lockedPredecessor.chainId) {
            throw bindingRefusal(
              "after_task_not_found",
              `Predecessor task ${input.afterTaskId} was not found in this project`,
            );
          }
          // The pointer is one-to-one. Check it while the predecessor chain
          // mutex is held so the create-binding and completion paths serialize
          // on the same rows; the unique index remains the final backstop.
          const occupied = await tx.task.findFirst({
            where: { projectId, dispatchAfterTaskId: input.afterTaskId },
            select: { id: true },
          });
          if (occupied) {
            throw bindingRefusal(
              "after_task_already_bound",
              `Predecessor task ${input.afterTaskId} is already bound to another chain`,
            );
          }
          if (lockedPredecessor.archivedAt) {
            throw bindingRefusal(
              "after_task_archived",
              `Predecessor task ${lockedPredecessor.name} (${lockedPredecessor.id}) is archived`,
            );
          }
          if (lockedPredecessor.status === TaskStatus.DONE) {
            throw bindingRefusal(
              "after_task_already_done",
              `Predecessor task ${lockedPredecessor.name} (${lockedPredecessor.id}) is already DONE`,
            );
          }
          const layers = chainRows
            .map(executionLayer)
            .filter((layer): layer is number => layer !== null);
          const terminalLayer = layers.length > 0 ? Math.max(...layers) : null;
          const predecessorLayer = executionLayer(lockedPredecessor);
          const terminalRows = terminalLayer === null
            ? []
            : chainRows.filter((row) => executionLayer(row) === terminalLayer);
          if (predecessorLayer === null || terminalRows.length !== 1 || terminalRows[0]!.id !== lockedPredecessor.id) {
            throw bindingRefusal(
              "after_task_not_terminal",
              `Predecessor task ${lockedPredecessor.name} (${lockedPredecessor.id}) is not the sole terminal task of its chain`,
            );
          }
          predecessor = {
            ...lockedPredecessor,
            projectId,
            chainId: lockedPredecessor.chainId,
          };
        }
        // The step validation above read every assignee outside this
        // transaction. Re-read them all under the shared Agent-row mutex before
        // the first task exists: instantiation writes a whole chain plus its
        // first run, and an archive committing between the check and the write
        // would leave every step of that chain pointed at an agent no runner
        // will ever claim for. The name is equally authoritative here: a rename
        // can change whether the assignee is a mechanical integrator or the
        // pinned compound implementation agent. One id-ordered statement, so
        // two instantiations sharing agents cannot deadlock.
        const canonicalAgentIds = template.steps.flatMap((step) => step.assigneeAgentId ? [step.assigneeAgentId] : []);
        const lockedAgents = await lockAgentRows(
          tx,
          [...new Set([...canonicalAgentIds, ...overrideAgentIds])].sort(),
        );
        for (const effective of effectiveSteps) {
          const { step, override, assigneeAgentId } = effective;
          if (!assigneeAgentId) continue;
          const lockedAgent = lockedAgents.get(assigneeAgentId);
          if (!lockedAgent || lockedAgent.projectId !== projectId) {
            if (override) {
              throw overrideRefusal(
                "step_override_agent_not_found",
                `Override agent ${assigneeAgentId} for step ${step.stepIndex} was not found in this project`,
              );
            }
            throw new Error(`Template step ${step.name} agent was not found`);
          }
          if (lockedAgent.archivedAt) {
            if (override) {
              throw overrideRefusal(
                "step_override_agent_archived",
                `Override agent ${lockedAgent.name} (${assigneeAgentId}) for step ${step.stepIndex} is archived`,
              );
            }
            throw new Error(`Template step ${step.name} agent ${lockedAgent.name} is archived`);
          }
          const lockedBindingRefusal = canonicalIntegratorBindingRefusal(lockedAgent.name, {
            stepIndex: step.stepIndex,
            outputKind: step.outputKind,
            taskTemplateName: template.name,
          });
          if (lockedBindingRefusal) {
            if (override) {
              throw overrideRefusal("step_override_integrator_binding", `Template step ${step.name}: ${lockedBindingRefusal}`);
            }
            throw new Error(`Template step ${step.name}: ${lockedBindingRefusal}`);
          }
          if (!compoundImplementationAssigneeValid(
            projectId,
            step.assigneeType,
            lockedAgent,
            { stepIndex: step.stepIndex, outputKind: step.outputKind, taskTemplate: { name: template.name } },
          )) {
            const message = `Compound implementation step must remain assigned to the active in-project Agent implementation-plan-executioner (step ${step.stepIndex})`;
            if (override) throw overrideRefusal("step_override_compound_implementation", message);
            throw new Error(message);
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
        for (const [index, effective] of effectiveSteps.entries()) {
          const { step } = effective;
          const context = composeTemplateTaskDescription({
            prompt: interpolate(step.prompt, promptVariables),
            featureBrief: input.description,
            priorOutputKinds: step.priorOutputKinds,
            outputKind: step.outputKind,
          });
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
            ...(index === 0 && input.afterTaskId ? { dispatchAfterTaskId: input.afterTaskId } : {}),
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
            ? predecessor
              ? `Template instantiated; waiting for predecessor ${predecessor.name}`
              : (input.autoStart ?? false) ? "Template instantiated; first step queued" : "Template instantiated; ready to start"
            : "Template instantiated; waiting for predecessor",
          metadata: {
            chainId,
            templateId: template.id,
            ...(predecessor ? {
              afterTaskId: predecessor.id,
              dispatchAfterTaskId: predecessor.id,
              predecessorTaskId: predecessor.id,
              predecessorChainId: predecessor.chainId,
            } : {}),
            ...options.activityMetadata,
          },
        })) });
        if (predecessor) {
          await tx.taskActivity.create({ data: {
            taskId: predecessor.id,
            actorType: options.actorType ?? "control-plane",
            body: `Chain ${chainId} bound to predecessor ${predecessor.name}`,
            metadata: {
              chainId,
              templateId: template.id,
              afterTaskId: predecessor.id,
              dispatchAfterTaskId: predecessor.id,
              predecessorTaskId: predecessor.id,
              predecessorChainId: predecessor.chainId,
              successorChainId: chainId,
              ...options.activityMetadata,
            },
          } });
        }
        const fire = options.fire
          ? await tx.triggerFire.create({ data: {
            templateId: template.id,
            chainId,
            source: options.fire.source,
            dedupeKey: options.fire.dedupeKey ?? null,
          } })
          : null;
      return { chainId, branchName, tasks, fireId: fire?.id ?? null };
    }, {
      // Six simultaneous webhook fires can form a longer serialization queue
      // than five attempts, even with per-attempt jitter. Twelve bounded tries
      // make the accepted burst deterministic while still surfacing persistent
      // conflicts instead of looping forever.
      attempts: 12,
      alsoRetry: retryableTemplateUniqueConflict,
    });
  } catch (error: unknown) {
    if (dispatchBindingUniqueConflict(error)) {
      throw bindingRefusal(
        "after_task_already_bound",
        `Predecessor task ${input.afterTaskId} is already bound to another chain`,
      );
    }
    throw error;
  }
};
