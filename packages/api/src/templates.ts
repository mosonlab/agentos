import { randomUUID } from "node:crypto";

import {
  AssigneeType,
  canonicalIntegratorBindingRefusal,
  compoundImplementationAssigneeValid,
  enqueueTaskRun,
  isDirectImplementationStep,
  lockAgentRepoGrant,
  lockAgentRows,
  lockChainRows,
  Prisma,
  type PrismaClient,
  TaskSource,
  TaskStatus,
  type TriggerFireSource,
} from "@anneal/db";
import { layerOf } from "@anneal/db/chain-order";

import { isValidBranchName } from "./branch-name.js";
import { composeBrief } from "./task-brief.js";
import {
  TemplateInstantiationRefusal,
  type TemplateInstantiationRefusalCode,
} from "./template-errors.js";
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

const implementationRouteLine = /^Route: implementation=([A-Za-z0-9-]+)(?: - .+)?$/mu;
const implementationRouteAgents = new Set([
  "senior-dev-luna",
  "senior-dev",
  "frontend-dev",
]);

/** Read the machine-readable implementation route from a brief description. */
export const parseImplementationRoute = (description: string | undefined): string | null => {
  const match = description?.match(implementationRouteLine);
  return match?.[1] ?? null;
};

const implementationRouteLineExact = new RegExp(implementationRouteLine.source, "u");

/**
 * Finds the first line that claims to be a machine-readable route but does not
 * match the full grammar. A near-miss must refuse loudly: silently ignoring it
 * dispatches the implementation step on the template default agent while the
 * brief author believes their route was applied.
 */
export const findMalformedRouteLine = (description: string | undefined): string | null => {
  for (const line of (description ?? "").split("\n")) {
    if (line.startsWith("Route:") && !implementationRouteLineExact.test(line)) return line;
  }
  return null;
};

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

const templateRefusal = (
  code: TemplateInstantiationRefusalCode,
  message: string,
): TemplateInstantiationRefusal => new TemplateInstantiationRefusal(code, message);

const executionLayer = (task: { chainLayer: number | null; chainIndex: number | null }): number | null => layerOf({
  layer: task.chainLayer,
  index: task.chainIndex,
});

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
      throw templateRefusal(
        "template_base_reference_missing",
        `Template step ${step.name} baseFromStepIndex ${step.baseFromStepIndex} does not reference the same template`,
      );
    }
    if (step.baseFromStepIndex >= step.stepIndex) {
      throw templateRefusal(
        "template_base_reference_not_earlier",
        `Template step ${step.name} baseFromStepIndex must reference a strictly earlier stepIndex`,
      );
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
    throw templateRefusal(
      "dispatch_conflicts_with_auto_start",
      `afterTaskId ${input.afterTaskId} cannot be combined with autoStart=true; a bound chain waits for its predecessor`,
    );
  }
  let effectiveStepOverrides: Record<string, { assigneeAgentId: string }> = {
    ...(input.stepOverrides ?? {}),
  };
  let overrideEntries = Object.entries(effectiveStepOverrides);
  if (overrideEntries.length > 64) {
    throw templateRefusal(
      "step_override_too_many",
      `stepOverrides contains ${overrideEntries.length} entries; at most 64 step overrides are allowed`,
    );
  }
  for (const [stepIndex] of overrideEntries) {
    if (!stepOverrideKey.test(stepIndex)) {
      throw templateRefusal(
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
  if (!template) throw templateRefusal("template_not_found", "Template not found in project");
  if (!repo) throw templateRefusal("repo_not_found", "Repo not found in project");
  if (template.steps.length === 0) throw templateRefusal("template_has_no_steps", "Template has no steps");
  const implementationRoute = template.name === "direct-engineer-workflow"
    ? parseImplementationRoute(input.description)
    : null;
  if (template.name === "direct-engineer-workflow") {
    const malformedRouteLine = findMalformedRouteLine(input.description);
    if (malformedRouteLine !== null) {
      throw templateRefusal(
        "implementation_route_malformed",
        `Malformed Route line ${JSON.stringify(malformedRouteLine)}; expected "Route: implementation=<agent> - <reason>" with agent one of senior-dev-luna, senior-dev, frontend-dev`,
      );
    }
  }
  if (implementationRoute !== null && !implementationRouteAgents.has(implementationRoute)) {
    throw templateRefusal(
      "implementation_route_unknown_agent",
      `Unknown implementation route agent ${implementationRoute}; expected one of senior-dev-luna, senior-dev, frontend-dev`,
    );
  }
  const missing = template.variables.filter((variable) => !isUsableTemplateVariable(input.variables[variable]));
  const unknown = Object.keys(input.variables).filter((variable) => !template.variables.includes(variable));
  if (missing.length > 0) {
    throw templateRefusal("template_variables_missing", `Missing template variables: ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    throw templateRefusal("template_variables_unknown", `Unknown template variables: ${unknown.join(", ")}`);
  }
  if (input.variables.branchName !== undefined && !isValidBranchName(input.variables.branchName)) {
    throw templateRefusal("template_branch_invalid", "Invalid template branch name");
  }
  assertValidBaseReferences(template.steps);

  const conditionalRevalidation = template.name === "direct-engineer-workflow"
    ? template.steps.find((step) => step.outputKind === "revalidation") ?? null
    : null;
  const omitRevalidation = conditionalRevalidation !== null && !input.afterTaskId;
  const instantiatedTemplateSteps = omitRevalidation
    ? template.steps.filter((step) => step.id !== conditionalRevalidation.id)
    : template.steps;
  if (instantiatedTemplateSteps.length === 0) {
    throw templateRefusal("template_has_no_instantiable_steps", "Template has no instantiable steps");
  }

  let routedImplementationStepIndex: number | null = null;
  if (implementationRoute !== null) {
    const implementationStep = template.steps.find((step) => isDirectImplementationStep({
      outputKind: step.outputKind,
      taskTemplate: { name: template.name },
    }));
    if (implementationStep) {
      const stepKey = String(implementationStep.stepIndex);
      if (effectiveStepOverrides[stepKey]) {
        throw templateRefusal(
          "implementation_route_conflicts_with_step_override",
          `Implementation Route conflicts with explicit stepOverrides entry ${stepKey}`,
        );
      }
      const routeAgent = await db.agent.findFirst({
        where: { projectId, name: implementationRoute },
        select: { id: true, name: true, projectId: true, archivedAt: true },
      });
      if (!routeAgent) {
        throw templateRefusal(
          "step_override_agent_not_found",
          `Implementation route agent ${implementationRoute} was not found in this project`,
        );
      }
      effectiveStepOverrides = {
        ...effectiveStepOverrides,
        [stepKey]: { assigneeAgentId: routeAgent.id },
      };
      routedImplementationStepIndex = implementationStep.stepIndex;
      overrideEntries = Object.entries(effectiveStepOverrides);
      if (overrideEntries.length > 64) {
        throw templateRefusal(
          "step_override_too_many",
          `stepOverrides contains ${overrideEntries.length} entries; at most 64 step overrides are allowed`,
        );
      }
    }
  }

  const templateStepsByIndex = new Map(template.steps.map((step) => [String(step.stepIndex), step]));
  for (const [stepIndex] of overrideEntries) {
    if (!templateStepsByIndex.has(stepIndex)) {
      throw templateRefusal(
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
  const effectiveSteps = instantiatedTemplateSteps.map((step): EffectiveTemplateStep => {
    const override = effectiveStepOverrides[String(step.stepIndex)];
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
      throw templateRefusal(
        "step_override_step_not_agent",
        `Step override ${step.stepIndex} targets ${step.name}, whose assigneeType is ${step.assigneeType}; only AGENT steps may be overridden`,
      );
    }
    if (override && (!assigneeAgent || assigneeAgent.projectId !== projectId)) {
      throw templateRefusal(
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
      if (override) throw templateRefusal("step_override_integrator_binding", `Template step ${step.name}: ${bindingRefusal}`);
      throw templateRefusal("template_integrator_binding_invalid", `Template step ${step.name}: ${bindingRefusal}`);
    }
    if (step.assigneeType === AssigneeType.AGENT && !assigneeAgent) {
      if (override) {
        throw templateRefusal(
          "step_override_agent_not_found",
          `Override agent ${override.assigneeAgentId} for step ${step.stepIndex} was not found in this project`,
        );
      }
      throw templateRefusal("template_step_agent_missing", `Template step ${step.name} has no agent`);
    }
    if (assigneeAgent?.archivedAt) {
      if (override) {
        throw templateRefusal(
          "step_override_agent_archived",
          `Override agent ${assigneeAgent.name} (${assigneeAgent.id}) for step ${step.stepIndex} is archived`,
        );
      }
      throw templateRefusal(
        "template_step_agent_archived",
        `Template step ${step.name} agent ${assigneeAgent.name} is archived`,
      );
    }
    if (override && !compoundImplementationAssigneeValid(
      projectId,
      step.assigneeType,
      assigneeAgent,
      { stepIndex: step.stepIndex, outputKind: step.outputKind, taskTemplate: { name: template.name } },
    )) {
      throw templateRefusal(
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
          throw templateRefusal(
            "step_override_missing_repo_grant",
            `Override agent ${assigneeAgent.name} (${assigneeAgent.id}) for step ${step.stepIndex} has no grant for Repo ${repo.name}`,
          );
        }
        throw templateRefusal(
          "template_agent_repo_grant_missing",
          `Agent ${assigneeAgent.name} has no grant for Repo ${repo.name}`,
        );
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
            throw templateRefusal(
              "after_task_not_found",
              `Predecessor task ${input.afterTaskId} was not found in this project`,
            );
          }
          if (!predecessorIdentity.chainId) {
            throw templateRefusal(
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
            throw templateRefusal(
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
            throw templateRefusal(
              "after_task_already_bound",
              `Predecessor task ${input.afterTaskId} is already bound to another chain`,
            );
          }
          if (lockedPredecessor.archivedAt) {
            throw templateRefusal(
              "after_task_archived",
              `Predecessor task ${lockedPredecessor.name} (${lockedPredecessor.id}) is archived`,
            );
          }
          if (lockedPredecessor.status === TaskStatus.DONE) {
            throw templateRefusal(
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
            throw templateRefusal(
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
        const canonicalAgentIds = effectiveSteps.flatMap((effective) => (
          effective.step.assigneeAgentId ? [effective.step.assigneeAgentId] : []
        ));
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
              throw templateRefusal(
                "step_override_agent_not_found",
                `Override agent ${assigneeAgentId} for step ${step.stepIndex} was not found in this project`,
              );
            }
            throw templateRefusal("template_step_agent_missing", `Template step ${step.name} agent was not found`);
          }
          if (lockedAgent.archivedAt) {
            if (override) {
              throw templateRefusal(
                "step_override_agent_archived",
                `Override agent ${lockedAgent.name} (${assigneeAgentId}) for step ${step.stepIndex} is archived`,
              );
            }
            throw templateRefusal(
              "template_step_agent_archived",
              `Template step ${step.name} agent ${lockedAgent.name} is archived`,
            );
          }
          if (implementationRoute !== null
            && step.stepIndex === routedImplementationStepIndex
            && lockedAgent.name !== implementationRoute) {
            throw templateRefusal(
              "implementation_route_agent_renamed",
              `Implementation route agent ${implementationRoute} changed identity before the chain was created`,
            );
          }
          const lockedBindingRefusal = canonicalIntegratorBindingRefusal(lockedAgent.name, {
            stepIndex: step.stepIndex,
            outputKind: step.outputKind,
            taskTemplateName: template.name,
          });
          if (lockedBindingRefusal) {
            if (override) {
              throw templateRefusal("step_override_integrator_binding", `Template step ${step.name}: ${lockedBindingRefusal}`);
            }
            throw templateRefusal(
              "template_integrator_binding_invalid",
              `Template step ${step.name}: ${lockedBindingRefusal}`,
            );
          }
          if (!compoundImplementationAssigneeValid(
            projectId,
            step.assigneeType,
            lockedAgent,
            { stepIndex: step.stepIndex, outputKind: step.outputKind, taskTemplate: { name: template.name } },
          )) {
            const message = `Compound implementation step must remain assigned to the active in-project Agent implementation-plan-executioner (step ${step.stepIndex})`;
            if (override) throw templateRefusal("step_override_compound_implementation", message);
            throw templateRefusal("template_compound_implementation_assignee_invalid", message);
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
              throw templateRefusal(
                "step_override_missing_repo_grant",
                `Override agent ${agentName} (${agentId}) for step ${effective.step.stepIndex} has no grant for Repo ${repo.name}`,
              );
            }
            throw templateRefusal(
              "template_agent_repo_grant_missing",
              `Agent ${agentName} has no grant for Repo ${repo.name}`,
            );
          }
        }
        const tasks = [];
        const promptVariables = { ...input.variables, chainId };
        for (const [index, effective] of effectiveSteps.entries()) {
          const { step } = effective;
          const conditionalOrdinalOffset = omitRevalidation ? 1 : 0;
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
            chainIndex: step.stepIndex - conditionalOrdinalOffset,
            chainLayer: step.layer - conditionalOrdinalOffset,
            status: TaskStatus.TODO,
            source: options.source ?? TaskSource.MANUAL,
            targetBranch: index === 0 ? repo.defaultBranch : branchName,
            ...(index === 0 && input.afterTaskId ? { dispatchAfterTaskId: input.afterTaskId } : {}),
          } }));
        }
        const first = tasks[0]!;
        if (first.assigneeType !== AssigneeType.AGENT) {
          throw templateRefusal("template_first_step_not_agent", "The first template step must be agent-executable");
        }
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
      throw templateRefusal(
        "after_task_already_bound",
        `Predecessor task ${input.afterTaskId} is already bound to another chain`,
      );
    }
    throw error;
  }
};
