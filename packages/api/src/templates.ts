import { randomUUID } from "node:crypto";

import {
  AssigneeType,
  canonicalIntegratorBindingRefusal,
  compoundImplementationAssigneeValid,
  enqueueTaskRun,
  gateSlotOf,
  isDirectImplementationStep,
  lockAgentRepoGrant,
  lockAgentRows,
  lockChainRows,
  lockProjectGateDefaults,
  lockTemplateRow,
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
  /** Per-instantiation approval-gate changes for the two configurable slots. */
  gates?: { spec?: boolean | undefined; merge?: boolean | undefined } | undefined;
};

type GateDefaults = { specGateDefault: boolean; mergeGateDefault: boolean };

const DEFAULT_GATE_DEFAULTS: GateDefaults = { specGateDefault: false, mergeGateDefault: false };

const resolvedApprovalGate = (
  step: { outputKind: string; approvalGate: boolean },
  gates: InstantiateTemplateInput["gates"],
  defaults: GateDefaults,
): boolean => {
  const slot = gateSlotOf(step);
  if (slot === "spec") return gates?.spec ?? defaults.specGateDefault ?? step.approvalGate;
  if (slot === "merge") return gates?.merge ?? defaults.mergeGateDefault ?? step.approvalGate;
  return step.approvalGate;
};

const stepOverrideKey = /^[1-9]\d*$/u;

const implementationRouteLine = /^Route: implementation=(.+)$/mu;

/** Read the machine-readable implementation route from a brief description. */
export const parseImplementationRoute = (description: string | undefined): string | null => {
  const match = description?.match(implementationRouteLine);
  const value = match?.[1];
  if (!value) return null;
  const reasonSeparator = value.indexOf(" - ");
  const name = reasonSeparator === -1 ? value : value.slice(0, reasonSeparator);
  const reason = reasonSeparator === -1 ? null : value.slice(reasonSeparator + 3);
  return name.length > 0 && name.length <= 80 && name.trim() === name && reason !== "" ? name : null;
};

/**
 * Finds the first line that claims to be a machine-readable route but does not
 * match the full grammar. A near-miss must refuse loudly: silently ignoring it
 * dispatches the implementation step on the template default agent while the
 * brief author believes their route was applied.
 */
export const findMalformedRouteLine = (description: string | undefined): string | null => {
  for (const line of (description ?? "").split("\n")) {
    if (line.startsWith("Route:") && parseImplementationRoute(line) === null) return line;
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
  approvalGate: boolean;
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

/**
 * Read the project defaults while holding the same row mutex used by project
 * PATCH. The delegate guard keeps the small unit-test doubles that predate
 * project defaults useful; every real Prisma transaction has this delegate
 * and therefore takes the lock before any Task can be written.
 */
const readProjectGateDefaults = async (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<GateDefaults> => {
  const projectDelegate = (tx as unknown as { project?: unknown }).project;
  if (projectDelegate === undefined) return DEFAULT_GATE_DEFAULTS;
  const project = await lockProjectGateDefaults(tx, projectId);
  if (!project) throw templateRefusal("template_not_found", "Project not found");
  return project;
};

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
  const requestedStepOverrides: Record<string, { assigneeAgentId: string }> = {
    ...(input.stepOverrides ?? {}),
  };
  const overrideEntries = Object.entries(requestedStepOverrides);
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
  try {
    // Route identity is deliberately discovered once, outside the retrying
    // Serializable callback. If a concurrent rename aborts an Agent-row lock,
    // the retry must keep locking this id so it can report the requested name
    // changed instead of re-resolving the old name as missing.
    const requestedImplementationRoute = parseImplementationRoute(input.description);
    const initiallyResolvedRouteAgent = requestedImplementationRoute === null
      ? null
      : await db.agent.findFirst({
        where: { projectId, name: requestedImplementationRoute },
        select: { id: true, name: true, projectId: true, archivedAt: true },
      });
    return await serializable(db, async (tx) => {
      // The template row is the shared mutex with structure replacement. No
      // graph row or graph-dependent decision may be trusted until this lock
      // is held; a replace that wins the race is therefore read as a whole.
      const lockedTemplate = await lockTemplateRow(tx, templateId);
      if (!lockedTemplate || lockedTemplate.projectId !== projectId) {
        throw templateRefusal("template_not_found", "Template not found in project");
      }
      const template = await tx.taskTemplate.findFirst({
        where: { id: templateId, projectId },
        include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
      });
      if (!template) throw templateRefusal("template_not_found", "Template not found in project");
      if (template.steps.length === 0) throw templateRefusal("template_has_no_steps", "Template has no steps");
      const projectGateDefaults = await readProjectGateDefaults(tx, projectId);
      const slots = new Set(template.steps.map((step) => gateSlotOf(step)).filter((slot) => slot !== null));
      // Check the slots in a fixed order. In particular, a request that names
      // both absent slots must report the specification slot first and must
      // finish before any materialisation write can occur.
      if (input.gates && Object.prototype.hasOwnProperty.call(input.gates, "spec") && !slots.has("spec")) {
        throw templateRefusal(
          "gates_spec_step_absent",
          `Cannot supply gates.spec for template ${template.name}: specification slot is absent`,
        );
      }
      if (input.gates && Object.prototype.hasOwnProperty.call(input.gates, "merge") && !slots.has("merge")) {
        throw templateRefusal(
          "gates_merge_step_absent",
          `Cannot supply gates.merge for template ${template.name}: merge readiness slot is absent`,
        );
      }
      const repo = await tx.repo.findFirst({ where: { id: input.repoId, projectId } });
      if (!repo) throw templateRefusal("repo_not_found", "Repo not found in project");
      if (template.name === "direct-engineer-workflow") {
        const malformedRouteLine = findMalformedRouteLine(input.description);
        if (malformedRouteLine !== null) {
          throw templateRefusal(
            "implementation_route_malformed",
            `Malformed Route line ${JSON.stringify(malformedRouteLine)}; expected "Route: implementation=<agent> - <reason>"`,
          );
        }
      }
      const implementationRoute = template.name === "direct-engineer-workflow"
        ? requestedImplementationRoute
        : null;
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

      let effectiveStepOverrides: Record<string, { assigneeAgentId: string }> = {
        ...requestedStepOverrides,
      };
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
          const routeAgent = initiallyResolvedRouteAgent;
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
          if (Object.keys(effectiveStepOverrides).length > 64) {
            throw templateRefusal(
              "step_override_too_many",
              `stepOverrides contains ${Object.keys(effectiveStepOverrides).length} entries; at most 64 step overrides are allowed`,
            );
          }
        }
      }

      const overrideEntries = Object.entries(effectiveStepOverrides);
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
      const effectiveSteps = instantiatedTemplateSteps.map((step): EffectiveTemplateStep => {
        const override = effectiveStepOverrides[String(step.stepIndex)];
        return {
          step,
          override,
          assigneeAgentId: override?.assigneeAgentId ?? step.assigneeAgentId,
          // The relation on the graph read is intentionally not trusted for
          // assignment decisions. It is replaced with the Agent-row-locked
          // value below before any Task is written.
          assigneeAgent: null,
          approvalGate: resolvedApprovalGate(step, input.gates, projectGateDefaults),
        };
      });
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
        // Re-read every assignee under the shared Agent-row mutex before the
        // first task exists: instantiation writes a whole chain plus its first
        // run, and an archive committing between the check and the write would
        // leave every step of that chain pointed at an agent no runner will
        // ever claim for. The name is equally authoritative here: a rename can
        // change whether the assignee is a mechanical integrator or the pinned
        // compound implementation agent. One id-ordered statement, so two
        // instantiations sharing agents cannot deadlock.
        const canonicalAgentIds = effectiveSteps.flatMap((effective) => (
          effective.step.assigneeAgentId ? [effective.step.assigneeAgentId] : []
        ));
        const lockedAgents = await lockAgentRows(
          tx,
          [...new Set([...canonicalAgentIds, ...overrideAgentIds])].sort(),
        );
        for (const effective of effectiveSteps) {
          const { step, override, assigneeAgentId } = effective;
          const lockedAgent = assigneeAgentId ? lockedAgents.get(assigneeAgentId) : undefined;
          const assigneeAgent = lockedAgent && assigneeAgentId && lockedAgent.projectId === projectId
            ? { id: assigneeAgentId, ...lockedAgent }
            : null;
          effective.assigneeAgent = assigneeAgent;
          if (override && step.assigneeType !== AssigneeType.AGENT) {
            throw templateRefusal(
              "step_override_step_not_agent",
              `Step override ${step.stepIndex} targets ${step.name}, whose assigneeType is ${step.assigneeType}; only AGENT steps may be overridden`,
            );
          }
          if (override && !assigneeAgent) {
            throw templateRefusal(
              "step_override_agent_not_found",
              `Override agent ${override.assigneeAgentId} for step ${step.stepIndex} was not found in this project`,
            );
          }
          if (step.assigneeType === AssigneeType.AGENT && !assigneeAgent) {
            throw templateRefusal("template_step_agent_missing", `Template step ${step.name} has no agent`);
          }
          // §D-P4, before any task row exists. A doctored template — the
          // sentinel on an ordinary step, or a model agent on the integrator
          // step — fails rather than materializing a chain that would later
          // claim as the wrong execution mode.
          const bindingRefusal = canonicalIntegratorBindingRefusal(assigneeAgent?.name ?? null, {
            stepIndex: step.stepIndex,
            outputKind: step.outputKind,
            taskTemplateName: template.name,
          });
          if (bindingRefusal) {
            if (override) throw templateRefusal("step_override_integrator_binding", `Template step ${step.name}: ${bindingRefusal}`);
            throw templateRefusal(
              "template_integrator_binding_invalid",
              `Template step ${step.name}: ${bindingRefusal}`,
            );
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
          if (implementationRoute !== null
            && step.stepIndex === routedImplementationStepIndex
            && assigneeAgent?.name !== implementationRoute) {
            throw templateRefusal(
              "implementation_route_agent_renamed",
              `Implementation route agent ${implementationRoute} changed identity before the chain was created`,
            );
          }
          if (assigneeAgent && !compoundImplementationAssigneeValid(
            projectId,
            step.assigneeType,
            assigneeAgent,
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
        const firstEffectiveStep = effectiveSteps[0]!;
        if (firstEffectiveStep.step.assigneeType !== AssigneeType.AGENT) {
          throw templateRefusal("template_first_step_not_agent", "The first template step must be agent-executable");
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
            approvalGate: effective.approvalGate,
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
