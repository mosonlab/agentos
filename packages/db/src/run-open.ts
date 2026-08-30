import {
  AssigneeType,
  CodexServiceTier,
  InboxDeliveryStatus,
  InboxSender,
  Prisma,
  type Run,
  RunnerKind,
  RunnerPreference,
} from "@prisma/client";

import { catalogRunnerForModel, DIRECT_TEMPLATE_NAME } from "./agent-contract.js";
import { canonicalTemplateIdentity } from "./canonical-template-transition.js";
import { sharedChainBranch } from "./chain-branch.js";
import { readChainControl } from "./chain-control.js";
import { layerOf } from "./chain-order.js";
import { lockAgentRow } from "./locks.js";
import { INTEGRATOR_TEMPLATE_NAME } from "./merge-integrator.js";
import {
  gateFeedsIntegratorStep,
  IntegratorBindingError,
  integratorBindingRefusalFor,
  requestMergeEvidence,
  resolveChainTarget,
  stopStateFor,
} from "./merge-integrator-db.js";
import { runnerFor } from "./model-routing.js";
import { stepRole } from "./step-role.js";

type Tx = Prisma.TransactionClient;


export const runBudgetCeiling = (
  maxSessionsPerTask: number,
  budgetGrants: number | null | undefined,
): number => maxSessionsPerTask + Math.max(0, budgetGrants ?? 0);

export type WorkflowRefusalReason =
  | "invalid-request"
  | "conflict"
  | "inbox-question-not-found"
  | "approval-gate-decision-invalid"
  | "inbox-choice-mismatch"
  | "inbox-run-not-waiting"
  | "approval-gate-rejection-target-missing";

/** A caller-reachable workflow refusal whose classification must not depend on its prose. */
export class WorkflowRefusalError extends Error {
  constructor(readonly reason: WorkflowRefusalReason, message: string) {
    super(message);
    this.name = "WorkflowRefusalError";
  }
}

export const isWorkflowRefusalError = (error: unknown): error is WorkflowRefusalError =>
  error instanceof Error && error.name === "WorkflowRefusalError";
export { runnerFor };

export const deriveRunConfig = (
  agent: {
    runnerPreference: RunnerPreference;
    model: string;
    codexServiceTier: CodexServiceTier;
  },
  templateStep: {
    runner: RunnerKind | null;
    stepIndex?: number;
    outputKind?: string;
    taskTemplate?: { name: string } | null;
  } | null,
): { runner: RunnerKind; model: string; codexServiceTier: CodexServiceTier } => {
  const compoundExecutioner = isCompoundImplementationStep(templateStep);
  const runner = templateStep?.runner ?? runnerFor(agent.runnerPreference, agent.model);
  if (compoundExecutioner
    && (runner !== RunnerKind.CODEX || catalogRunnerForModel(agent.model) !== RunnerPreference.CODEX)) {
    throw new WorkflowRefusalError("invalid-request", "Compound implementation root requires a Codex gpt-* model");
  }
  return {
    runner,
    model: agent.model,
    codexServiceTier: agent.codexServiceTier,
  };
};

export const COMPOUND_IMPLEMENTATION_AGENT_NAME = "implementation-plan-executioner";
export const COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE = "COMPOUND_IMPLEMENTATION_ASSIGNEE_INVALID";

export type CompoundImplementationStepShape = {
  stepIndex?: number;
  outputKind?: string;
  taskTemplate?: { name: string } | null;
} | null;

export const isCompoundImplementationStep = (templateStep: CompoundImplementationStepShape): boolean =>
  templateStep?.taskTemplate?.name !== undefined
  && canonicalTemplateIdentity(templateStep.taskTemplate.name)?.canonicalName === INTEGRATOR_TEMPLATE_NAME
  && templateStep.outputKind !== undefined
  && stepRole({ outputKind: templateStep.outputKind }) === "implementation";

type CompoundImplementationAgent = {
  name: string;
  projectId: string;
  archivedAt: Date | null;
} | null;

export const compoundImplementationAssigneeValid = (
  taskProjectId: string,
  assigneeType: AssigneeType,
  agent: CompoundImplementationAgent,
  templateStep: CompoundImplementationStepShape,
): boolean => !isCompoundImplementationStep(templateStep)
  || (assigneeType === AssigneeType.AGENT
    && agent?.name === COMPOUND_IMPLEMENTATION_AGENT_NAME
    && agent.projectId === taskProjectId
    && agent.archivedAt === null);

export class CompoundImplementationAssigneeError extends Error {
  readonly code = COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE;

  constructor() {
    super(`Compound implementation step must remain assigned to the active in-project Agent ${COMPOUND_IMPLEMENTATION_AGENT_NAME}`);
    this.name = "CompoundImplementationAssigneeError";
  }
}

export const isCompoundImplementationAssigneeError = (
  error: unknown,
): error is CompoundImplementationAssigneeError =>
  error instanceof Error && error.name === "CompoundImplementationAssigneeError";

export const NATIVE_IMPLEMENTATION_SUBAGENT_MODEL = "gpt-5.6-luna:max";
export const NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT = 8;

export const isDirectImplementationStep = (templateStep: CompoundImplementationStepShape): boolean =>
  templateStep?.taskTemplate?.name !== undefined
  && canonicalTemplateIdentity(templateStep.taskTemplate.name)?.canonicalName === DIRECT_TEMPLATE_NAME
  && templateStep.outputKind !== undefined
  && stepRole({ outputKind: templateStep.outputKind }) === "implementation";

export const nativeImplementationSubagentRunConfig = (
  runner: RunnerKind,
  templateStep: CompoundImplementationStepShape,
): { subagentModel: string; subagentMaxConcurrent: number } | null => {
  if (runner !== RunnerKind.CODEX) return null;
  if (!isCompoundImplementationStep(templateStep) && !isDirectImplementationStep(templateStep)) return null;
  return {
    subagentModel: NATIVE_IMPLEMENTATION_SUBAGENT_MODEL,
    subagentMaxConcurrent: NATIVE_IMPLEMENTATION_SUBAGENT_MAX_CONCURRENT,
  };
};

export class ArchivedAssigneeError extends Error {
  constructor(readonly taskId: string, readonly taskName: string, readonly agentName: string) {
    super(`Task ${taskName} assignee ${agentName} is archived; unarchive the agent to queue this step`);
    this.name = "ArchivedAssigneeError";
  }
}

export const isArchivedAssigneeError = (error: unknown): error is ArchivedAssigneeError =>
  error instanceof Error && error.name === "ArchivedAssigneeError";

/** An archived Task must not gain a run. Thrown from `enqueueTaskRun` itself
 *  rather than from each caller: this function is the single place a Run comes
 *  into existence, so guarding here closes the class instead of one path. */
export class ArchivedTaskError extends Error {
  constructor(readonly taskId: string, readonly taskName: string) {
    super(`Task ${taskName} is archived; unarchive it before queueing a run`);
    this.name = "ArchivedTaskError";
  }
}

/** A run may not be created for an integrator step whose stop nobody has answered terminally. */
export class IntegratorStoppedError extends Error {
  constructor(readonly taskId: string, readonly condition: string) {
    super(`Merge integrator stopped on ${condition}; answer the stop question before starting another run`);
    this.name = "IntegratorStoppedError";
  }
}

/** A Run producer reached the single Run-birth seam while its Chain barrier
 * was still held above the Task's execution layer. The transaction caller may
 * safely roll this refusal back and retry after the operator releases it. */
export class ChainHeldError extends Error {
  constructor(
    readonly taskId: string,
    readonly chainId: string,
    readonly taskLayer: number | null,
    readonly heldLayer: number | null,
  ) {
    super(taskLayer === null || heldLayer === null
      ? `Chain ${chainId} is held; Task ${taskId} cannot queue a Run`
      : `Chain ${chainId} is held after layer ${heldLayer}; Task ${taskId} at layer ${taskLayer} cannot queue a Run`);
    this.name = "ChainHeldError";
  }
}

export const isChainHeldError = (error: unknown): error is ChainHeldError =>
  error instanceof Error && error.name === "ChainHeldError";

export const isIntegratorStoppedError = (error: unknown): error is IntegratorStoppedError =>
  error instanceof Error && error.name === "IntegratorStoppedError";

export const isArchivedTaskError = (error: unknown): error is ArchivedTaskError =>
  error instanceof Error && error.name === "ArchivedTaskError";

export class PinnedBaseCommitError extends Error {
  constructor(readonly taskId: string, readonly baseFromStepIndex: number, detail: string) {
    super(`Pinned task ${taskId} cannot activate from step ${baseFromStepIndex}: ${detail}`);
    this.name = "PinnedBaseCommitError";
  }
}

export const isPinnedBaseCommitError = (error: unknown): error is PinnedBaseCommitError =>
  error instanceof Error && error.name === "PinnedBaseCommitError";

const IMPLEMENTATION_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const implementationRangeFromOutput = (
  taskId: string,
  baseFromStepIndex: number,
  source: { kind: string; body: string; commitSha: string | null },
): { implementationBaseSha: string; implementationHeadSha: string } => {
  if (!source.commitSha) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced step has no recorded commitSha");
  }
  if (!IMPLEMENTATION_SHA.test(source.commitSha)) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced step has invalid commitSha");
  }
  if (source.kind !== "implementation") {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced step has no canonical implementation output");
  }
  let value: unknown;
  try {
    value = JSON.parse(source.body);
  } catch {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output is not a JSON object");
  }
  const output = value as Record<string, unknown>;
  if (output.schemaVersion !== 1) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output has unsupported schemaVersion");
  }
  if (typeof output.baseSha !== "string" || !IMPLEMENTATION_SHA.test(output.baseSha)) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output has invalid baseSha");
  }
  if (typeof output.headSha !== "string" || !IMPLEMENTATION_SHA.test(output.headSha)) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output has invalid headSha");
  }
  if (output.headSha !== source.commitSha) {
    throw new PinnedBaseCommitError(taskId, baseFromStepIndex, "referenced implementation output headSha does not match commitSha");
  }
  return { implementationBaseSha: output.baseSha, implementationHeadSha: output.headSha };
};

export const pinnedImplementationRange = async (
  tx: Tx,
  task: {
    id: string;
    projectId: string;
    templateId: string | null;
    chainId: string | null;
    templateStep?: { baseFromStepIndex: number | null } | null;
  },
): Promise<{ implementationBaseSha: string; implementationHeadSha: string } | null> => {
  const baseFromStepIndex = task.templateStep?.baseFromStepIndex;
  if (baseFromStepIndex === null || baseFromStepIndex === undefined) return null;
  if (!task.templateId || !task.chainId) {
    throw new PinnedBaseCommitError(task.id, baseFromStepIndex, "task is not an instantiated template chain step");
  }
  const source = await tx.taskStepOutput.findFirst({
    where: {
      task: {
        projectId: task.projectId,
        templateId: task.templateId,
        chainId: task.chainId,
        // baseFromStepIndex names the template Step. Conditional instantiation
        // may omit an earlier Step and densely number the materialized Tasks,
        // so Task.chainIndex is not an authority for this reference.
        templateStep: { stepIndex: baseFromStepIndex },
      },
    },
    select: { kind: true, body: true, commitSha: true },
  });
  if (!source) {
    throw new PinnedBaseCommitError(task.id, baseFromStepIndex, "referenced step has no canonical implementation output");
  }
  // A recovery Run republishes an already-complete head, so its workspace
  // base legitimately equals that head. The canonical implementation output
  // preserves the original reviewed range and is the authority for every
  // later blind-review claim.
  return implementationRangeFromOutput(task.id, baseFromStepIndex, source);
};

/** The shape `resolveRunBranches` needs. Structural rather than a Prisma payload
 *  type so `openRun` can pass each intent's branch facts without coupling the
 *  resolver to its full Task query. */
export type RunBranchTask = {
  id: string;
  projectId: string;
  repoId: string | null;
  chainId: string | null;
  chainIndex: number | null;
  templateId: string | null;
  templateStep?: { baseFromStepIndex: number | null } | null;
  targetBranch: string | null;
  repo: { defaultBranch: string };
};

/**
 * Template step ① keeps the repository default in `targetBranch`, because that
 * is the base it must clone. The shared head is persisted on every later step,
 * so a deferred first start can recover the same branch an immediate start
 * uses without needing a placeholder Run at instantiation time.
 */
const templateChainBranch = async (tx: Tx, task: RunBranchTask): Promise<string | null> => {
  if (task.targetBranch && task.targetBranch !== task.repo.defaultBranch) return task.targetBranch;
  if (!task.chainId || !task.templateId) return null;
  const sibling = await tx.task.findFirst({
    where: {
      projectId: task.projectId,
      repoId: task.repoId,
      chainId: task.chainId,
      templateId: task.templateId,
      targetBranch: { not: task.repo.defaultBranch },
    },
    orderBy: { chainIndex: "asc" },
    select: { targetBranch: true },
  });
  return sibling?.targetBranch ?? null;
};

/**
 * The base a retry may inherit from its prior run, or null when nothing that run
 * left behind is known to exist on the remote.
 *
 * `prior.branch` is the *workspace* branch: the runner writes it back before any
 * push happens (workspace.ts, runner.ts), so a run whose push failed leaves a
 * `branch` that exists in no remote. Non-chain and template retries used to
 * inherit it as their base unconditionally, and `provisionWorkspace` clones the
 * base by name — so those retries died in `git clone` about two minutes in,
 * burning the whole run budget without ever starting the agent (issue #118: runs
 * cmsy9kg5j0001mp76wb95xiyu, cmsya108b00eqmp767igidbmb, cmsyaa0nk00oqmp760jc7693a).
 *
 * Only `pushedBranch` is evidence, for exactly the reasons spelled out on the
 * chain branch in `resolveRunBranches`: it is written from the ref actually
 * handed to `git push`, and `branch`/`pushStatus`/`status` each lie about it in
 * one direction or the other.
 */
const inheritedBase = async (
  tx: Tx,
  task: RunBranchTask,
  prior: { branch: string | null } | null,
): Promise<string | null> => {
  if (!task.repoId) return null;
  // Template steps of one chain share a branch, so the ref this retry wants may
  // have been published by a *sibling* step. This also applies to a successor's
  // first run: `prior` is null there, but the predecessor's salvage ref is the
  // newest durable tree the chain owns. Everything else asks about itself only.
  // A chainIndex-null row stays isolated from indexed siblings carrying the
  // same chainId (see resolveRunBranches).
  const chainScope = task.chainId && task.chainIndex !== null
    ? { projectId: task.projectId, chainId: task.chainId, chainIndex: { not: null } }
    : null;
  if (!prior && !chainScope) return null;
  const scope = chainScope
    ? chainScope
    : { id: task.id };
  // A non-chain retry first asks the narrow historical question: did this task
  // publish the workspace branch it is trying to continue? Chain retries skip
  // this shortcut because a newer sibling salvage must outrank an older head.
  if (!chainScope && prior?.branch) {
    const exact = await tx.run.findFirst({
      where: { repoId: task.repoId, pushedBranch: prior.branch, task: scope },
      select: { pushedBranch: true },
    });
    if (exact?.pushedBranch) return exact.pushedBranch;
  }
  // `createdAt`, not a per-task runNumber, orders publications across sibling
  // steps. Run rows are created serially along a chain; their updatedAt can move
  // later for cleanup bookkeeping and is therefore not publication ordering.
  // Scoped by repo: the same branch name on two remotes is two unrelated refs.
  const published = await tx.run.findFirst({
    where: { repoId: task.repoId, pushedBranch: { not: null }, task: scope },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { pushedBranch: true },
  });
  return published?.pushedBranch ?? null;
};

/**
 * The base for a requeue that must otherwise keep the failed run's *own* base
 * rather than the task's current one: the automatic retry inside the completion
 * transaction and the lost-lease requeue. Both deliberately snapshot the run
 * they are replacing, so an operator edit to `task.targetBranch` afterwards does
 * not silently retarget them — but neither may keep a base the remote does not
 * have, which is what made issue #118 self-sustaining.
 *
 * Publication evidence first (`inheritedBase`, including the WIP salvage the
 * completing run may have written moments ago in this same transaction), then
 * the snapshot — except when the snapshot *is* this run's own unpublished head.
 * That is the poisoned shape a pre-fix retry was created with: `branch` and
 * `targetBranch` both naming a ref no remote has. Copying it forward is how the
 * clone loop survived every retry, so that one case falls through to the task's
 * base, which only an operator ever writes.
 */
export const resolveRequeueBase = async (
  tx: Tx,
  task: RunBranchTask,
  run: { branch: string | null; targetBranch: string | null },
): Promise<string | null> => {
  const published = await inheritedBase(tx, task, { branch: run.branch });
  if (published) return published;
  if (run.branch !== null && run.targetBranch === run.branch) {
    return task.targetBranch ?? task.repo.defaultBranch;
  }
  return run.targetBranch;
};

/**
 * Decides a new Run's head (`branch`) and base (`targetBranch`). `openRun` is
 * its only Run-birth caller; keeping the branch rule behind that seam prevents
 * one intent from putting a Step on a different branch from the rest of its
 * Chain.
 *
 * Writes at most one TaskActivity row (see the chain branch below), so it takes
 * the caller's transaction.
 */
export const resolveRunBranches = async (
  tx: Tx,
  task: RunBranchTask,
  prior: { branch: string | null } | null,
): Promise<{ branch: string | null; targetBranch: string }> => {
  const pinnedRange = await pinnedImplementationRange(tx, task);
  if (pinnedRange) {
    const chainBranch = task.targetBranch && task.targetBranch !== task.repo.defaultBranch
      ? task.targetBranch
      : null;
    return {
      branch: chainBranch ?? prior?.branch ?? null,
      targetBranch: pinnedRange.implementationHeadSha,
    };
  }
  // Template chains are frozen: nothing after this point runs for a template
  // task. Step ① keeps the repository default as its base while recovering the
  // shared head from a sibling task; later steps carry that head directly.
  // This is deliberately independent of a prior Run, because autoStart:false
  // materializes an inert chain whose first Run is created only by POST /start.
  if (task.templateId) {
    const chainBranch = await templateChainBranch(tx, task);
    return {
      // A prior Run carries the workspace branch the runner actually used. An
      // upgrade-state retry may therefore carry a per-run fallback here; when
      // the logical template head is recoverable, it must win so successors
      // clone the ref this retry publishes.
      branch: chainBranch ?? prior?.branch ?? null,
      targetBranch: (await inheritedBase(tx, task, prior)) ?? task.targetBranch ?? task.repo.defaultBranch,
    };
  }
  // A chainId with no index is a malformed one-row "chain" in the public API
  // and UI. It must remain isolated from indexed siblings that happen to carry
  // the same chainId (chain.dbtest.ts E1); treating it as an indexed chain here
  // would let it clone and publish those siblings' shared tree.
  if (!task.chainId || task.chainIndex === null) {
    return {
      // The head keeps the prior run's name even when the base falls back: the
      // name is this task's, and provisionWorkspace already handles a head that
      // does not exist on the remote (it clones the base and branches off it).
      branch: prior?.branch ?? null,
      targetBranch: (await inheritedBase(tx, task, prior)) ?? task.targetBranch ?? task.repo.defaultBranch,
    };
  }

  const shared = sharedChainBranch({ projectId: task.projectId, chainId: task.chainId });
  // "What is the newest ref any indexed step of this chain actually published
  // on this repo?" It may be the declared head or a per-run salvage ref.
  //
  // Read `pushedBranch` and nothing else. It is written only after `git push`
  // returns, with the ref that was actually given to it, on both delivery paths
  // (delivery.ts). Do not "simplify" this into `branch` + `pushStatus` +
  // `status`: those three lie in both directions, and each direction breaks a
  // chain in a way no retry clears.
  //   - `branch` + `pushStatus`: a *failed* run whose WIP salvage push succeeded
  //     records pushStatus SUCCEEDED with `branch` still set to the workspace
  //     branch — the shared branch — while deliverFailedWorkspace actually
  //     pushed `agentos/<taskId>/run-<n>` (delivery.ts; runner.ts spreads the
  //     workspace result first). The next step would clone a ref nobody created.
  //   - adding `status`/`pushStatus = SUCCEEDED` to compensate: a run that
  //     pushed the branch and then hit any `gh` error is recorded FAILED and
  //     non-retryable (delivery.ts's catch; runner.ts's `succeeded`) even though
  //     the ref exists. The next step would base on the default branch, recreate
  //     the shared name locally, and be rejected non-fast-forward. Wedged for
  //     good — no retry clears it.
  //
  // Scoped by repo (spec R2: the same name on two remotes is two unrelated
  // refs) and restricted to indexed tasks. A chainIndex-null row is the API's
  // isolated 1/1 malformed-chain case and must neither contribute nor consume
  // publication evidence for an indexed chain with the same chainId.
  const published = await inheritedBase(tx, task, prior);
  // `prior?.branch` is deliberately not consulted as publication evidence.
  // Only pushedBranch proves that a cloneable remote ref exists.
  const targetBranch = published ?? task.targetBranch ?? task.repo.defaultBranch;

  // targetBranch stays writable for chain steps but no longer routes them.
  // Silently ignoring an operator's value is a footgun, so say so once per run —
  // this is how the operator learns hand-repointing is unnecessary.
  if (task.targetBranch && task.targetBranch !== targetBranch) {
    await tx.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "control-plane",
      body: `targetBranch '${task.targetBranch}' is not used for chain steps; this run is based on '${targetBranch}' and pushes to '${shared}'`,
    } });
  }
  return { branch: shared, targetBranch };
};

export type IntegratorStopBypass = { integratorTaskId: string; sourceStopId: string };

export type OpenRunIntent =
  | { kind: "enqueue"; readyAt: Date; stopBypass?: IntegratorStopBypass | null }
  | { kind: "merge-tail-requeue"; readyAt: Date; budgetGrant: 1 }
  | { kind: "task-created"; readyAt: Date }
  | { kind: "retry"; readyAt: Date }
  | { kind: "integrator-authorized"; readyAt: Date }
  | {
    kind: "retry-after-completion";
    readyAt: Date;
    sourceRunId: string;
    sourceMaxRunsPerTask: number;
    sourceBudgetGrants: number;
    budgetGrant: 0 | 1;
  }
  | {
    kind: "retry-after-lease-loss";
    readyAt: Date;
    sourceRunId: string;
    sourceMaxRunsPerTask: number;
    sourceBudgetGrants: number;
  };

export type OpenRunRefusal = {
  reason:
    | "invalid-request"
    | "not-found"
    | "conflict"
    | "compound-implementation-assignee"
    | "archived-assignee"
    | "archived-task"
    | "integrator-stopped"
    | "chain-held";
  message: string;
  detail?: Readonly<Record<string, string | number | boolean | null>>;
  context?: Readonly<{
    taskId?: string;
    taskName?: string;
    chainId?: string;
    taskLayer?: number | null;
    heldLayer?: number | null;
    agentName?: string;
    condition?: string;
    code?: string;
  }>;
};

export type OpenRunResult =
  | { ok: true; run: Run }
  | { ok: false; refusal: OpenRunRefusal };

const openRunRefusal = (
  reason: OpenRunRefusal["reason"],
  message: string,
  detail?: OpenRunRefusal["detail"],
  context?: OpenRunRefusal["context"],
): OpenRunResult => ({
  ok: false,
  refusal: {
    reason,
    message,
    ...(detail ? { detail } : {}),
    ...(context ? { context } : {}),
  },
});

const sourceRetryIntent = (
  intent: OpenRunIntent,
): intent is Extract<OpenRunIntent, { kind: "retry-after-completion" | "retry-after-lease-loss" }> =>
  intent.kind === "retry-after-completion" || intent.kind === "retry-after-lease-loss";

/**
 * The only place a Run comes into existence.
 *
 * Every birth intent crosses the same task, stop-state, Agent-row, compound
 * assignee and integrator-binding guards. The discriminated intent owns the
 * few differences that are real domain rules: which prior configuration and
 * branch snapshot a retry preserves, and whether a human authorization may
 * grant enough budget for the next mechanical run.
 */
export const openRun = async (
  tx: Tx,
  taskId: string,
  intent: OpenRunIntent,
): Promise<OpenRunResult> => {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    include: {
      assigneeAgent: true,
      repo: true,
      templateStep: { include: { taskTemplate: { select: { name: true } } } },
      runs: { orderBy: { runNumber: "desc" }, take: 1 },
    },
  });
  if (!task) return openRunRefusal("not-found", "Task not found");
  if (task.assigneeType !== AssigneeType.AGENT) {
    return openRunRefusal("invalid-request", `Task ${task.id} cannot open a Run without an Agent assignee`);
  }
  if (!task.assigneeAgent) {
    return openRunRefusal("conflict", "Task assignee no longer exists; assign an agent before retrying");
  }
  if (!task.repo && (intent.kind === "enqueue"
    || intent.kind === "merge-tail-requeue"
    || intent.kind === "task-created"
    || intent.kind === "integrator-authorized")) {
    return openRunRefusal("invalid-request", `Task ${task.id} cannot open a ${intent.kind} Run without a Repo`);
  }
  // Checked before the assignee, because an archived task is archived whoever
  // it is assigned to. The runner claims only `TODO|DOING` and unarchived tasks,
  // so a run queued here would never be claimed and never complete.
  if (task.archivedAt) {
    const message = intent.kind === "retry"
      ? "Cannot retry an archived task"
      : `Task ${task.name} is archived; unarchive it before queueing a run`;
    return openRunRefusal("archived-task", message, undefined, {
      taskId: task.id,
      taskName: task.name,
    });
  }
  // §D-P7, the last line of the exclusivity guard. `openRun` is the single
  // place a Run comes into existence, so a new birth intent inherits the
  // refusal by construction rather than by remembering to ask.
  const stopped = await stopStateFor(tx, task.id);
  const stopBypass = intent.kind === "enqueue" ? intent.stopBypass ?? null : null;
  // A recovered confirmation approval is itself the human-authorized exit
  // from this unresolved stop. Its named intent is the only path that may open
  // the renewed mechanical Run while the original stop remains in history.
  const humanReauthorization = intent.kind === "integrator-authorized";
  if (stopped && !humanReauthorization
    && (stopBypass?.integratorTaskId !== task.id || stopBypass.sourceStopId !== stopped.stop.stopId)) {
    return openRunRefusal(
      "integrator-stopped",
      `Merge integrator stopped on ${stopped.stop.condition}; answer the stop question before starting another run`,
      undefined,
      { taskId: task.id, condition: stopped.stop.condition },
    );
  }
  // The assignee is re-read under the shared Agent-row mutex, not trusted from
  // the relation above: `openRun` is the single place a Run comes into
  // existence, so an archive committing in parallel has to lose here or be
  // refused for the Run this call is about to create.
  const lockedAgent = await lockAgentRow(tx, task.assigneeAgent.id);
  if (!lockedAgent || lockedAgent.archivedAt) {
    const message = intent.kind === "retry"
      ? `Assignee ${task.assigneeAgent.name} is archived; unarchive it to retry`
      : `Task ${task.name} assignee ${task.assigneeAgent.name} is archived; unarchive the agent to queue this step`;
    return openRunRefusal(
      "archived-assignee",
      message,
      undefined,
      { taskId: task.id, taskName: task.name, agentName: task.assigneeAgent.name },
    );
  }
  if (!compoundImplementationAssigneeValid(
    task.projectId,
    task.assigneeType,
    lockedAgent,
    task.templateStep,
  )) {
    const error = new CompoundImplementationAssigneeError();
    return openRunRefusal("compound-implementation-assignee", error.message, { code: error.code });
  }
  // §D-P4, the last line of the binding invariant, for the same reason. The
  // Agent name comes from the locked re-read, never the stale task relation.
  const bindingRefusal = await integratorBindingRefusalFor(tx, {
    assigneeAgentName: lockedAgent.name,
    templateStep: task.templateStep,
  });
  if (bindingRefusal) {
    return openRunRefusal("invalid-request", bindingRefusal, undefined, { code: "INTEGRATOR_BINDING_INVALID" });
  }

  const prior = task.runs[0];
  if (intent.kind === "task-created" && prior) {
    return openRunRefusal("conflict", `Task ${task.name} already has a Run`);
  }
  if ((intent.kind === "retry"
    || intent.kind === "integrator-authorized"
    || sourceRetryIntent(intent)) && !prior) {
    return openRunRefusal("conflict", `Task ${task.name} has no Run to continue`);
  }
  if (sourceRetryIntent(intent) && prior?.id !== intent.sourceRunId) {
    return openRunRefusal("conflict", `Run ${intent.sourceRunId} is no longer the latest Run for task ${task.name}`);
  }
  if (intent.kind === "integrator-authorized" && (!task.templateStep || stepRole(task.templateStep) !== "integrator")) {
    return openRunRefusal("invalid-request", `Task ${task.name} is not an integrator Step`);
  }

  const runNumber = (prior?.runNumber ?? 0) + 1;
  let budgetGrants = prior?.budgetGrants ?? 0;
  let maxRunsPerTask: number;
  if (intent.kind === "integrator-authorized") {
    budgetGrants = Math.max(budgetGrants, runNumber - task.maxSessionsPerTask);
    maxRunsPerTask = runBudgetCeiling(task.maxSessionsPerTask, budgetGrants);
  } else if (intent.kind === "merge-tail-requeue") {
    // A control-plane merge-tail refresh is not an agent failure. Carry the
    // grants already earned by the task and refund exactly this one requeue;
    // the running ceiling therefore follows the same derivation as every
    // other budget grant without introducing a merge-tail-specific cap.
    budgetGrants += intent.budgetGrant;
    maxRunsPerTask = runBudgetCeiling(task.maxSessionsPerTask, budgetGrants);
  } else if (intent.kind === "retry-after-completion") {
    budgetGrants = intent.sourceBudgetGrants + intent.budgetGrant;
    maxRunsPerTask = runBudgetCeiling(intent.sourceMaxRunsPerTask, intent.budgetGrant);
  } else if (intent.kind === "retry-after-lease-loss") {
    budgetGrants = intent.sourceBudgetGrants + 1;
    maxRunsPerTask = runBudgetCeiling(intent.sourceMaxRunsPerTask, 1);
  } else {
    maxRunsPerTask = runBudgetCeiling(task.maxSessionsPerTask, budgetGrants);
  }
  if (intent.kind === "retry" && prior && prior.runNumber >= maxRunsPerTask) {
    return openRunRefusal("conflict", "Run budget exhausted");
  }

  // `chainLayer` is the post-expand authority, with `chainIndex` as the
  // compatibility fallback for legacy chain rows. Keep the read inside this
  // transaction and before any Run-birth work so a held successor produces no
  // Run or queue activity. The database prevents a HELD control without a
  // layer; malformed legacy Task rows still fail closed at this seam.
  const taskLayer = layerOf({ layer: task.chainLayer, index: task.chainIndex });
  if (task.chainId) {
    const control = await readChainControl(tx, { projectId: task.projectId, chainId: task.chainId });
    if (control.held && (control.heldLayer === null || taskLayer === null || taskLayer > control.heldLayer)) {
      const error = new ChainHeldError(task.id, task.chainId, taskLayer, control.heldLayer);
      return openRunRefusal(
        "chain-held",
        error.message,
        { chainId: task.chainId, taskLayer, heldLayer: control.heldLayer },
        { taskId: task.id, chainId: task.chainId, taskLayer, heldLayer: control.heldLayer },
      );
    }
  }

  const branches = intent.kind === "integrator-authorized"
    ? { branch: prior?.branch ?? null, targetBranch: prior?.targetBranch ?? task.targetBranch }
    : !task.repo
      ? { branch: prior?.branch ?? null, targetBranch: prior?.targetBranch ?? task.targetBranch }
      : intent.kind === "retry-after-completion"
        ? task.chainId && (task.templateId || task.chainIndex !== null)
          ? await resolveRunBranches(
            tx,
            { ...task, repo: task.repo },
            task.templateId ? { branch: prior?.branch ?? null } : null,
          )
          : {
            branch: null,
            targetBranch: prior
              ? await resolveRequeueBase(tx, { ...task, repo: task.repo }, prior)
              : task.targetBranch ?? task.repo.defaultBranch,
          }
        : intent.kind === "retry-after-lease-loss"
          ? task.templateStep?.baseFromStepIndex != null
            ? await resolveRunBranches(tx, { ...task, repo: task.repo }, { branch: prior?.branch ?? null })
            : task.chainId && task.chainIndex !== null && !task.templateId
              ? await resolveRunBranches(tx, { ...task, repo: task.repo }, null)
              : {
                branch: prior?.branch ?? null,
                targetBranch: prior
                  ? await resolveRequeueBase(tx, { ...task, repo: task.repo }, prior)
                  : task.targetBranch ?? task.repo.defaultBranch,
              }
          : await resolveRunBranches(tx, { ...task, repo: task.repo }, prior ?? null);

  const preservedConfiguration = sourceRetryIntent(intent) && prior
    ? {
      runner: prior.runner,
      model: prior.model,
      codexServiceTier: prior.codexServiceTier,
      subagentModel: prior.subagentModel,
      subagentMaxConcurrent: prior.subagentMaxConcurrent,
    }
    : null;
  const configuration = intent.kind === "integrator-authorized"
    ? {
      runner: prior?.runner ?? RunnerKind.CLAUDE,
      model: lockedAgent.model,
    }
    : preservedConfiguration ?? (() => {
      const derived = deriveRunConfig(lockedAgent, task.templateStep);
      return {
        ...derived,
        ...nativeImplementationSubagentRunConfig(derived.runner, task.templateStep),
      };
    })();
  const preservesPriorTiming = intent.kind === "retry" || sourceRetryIntent(intent);

  const run = await tx.run.create({ data: {
    projectId: task.projectId,
    taskId: task.id,
    ...((intent.kind === "retry" || sourceRetryIntent(intent)) && prior?.goalId ? { goalId: prior.goalId } : {}),
    agentId: lockedAgent.id,
    repoId: task.repoId,
    runNumber,
    dedupeKey: `task:${task.id}:run:${runNumber}`,
    ...configuration,
    // An exact prompt does not exist until a runner dispatches one. The start
    // route fills this with the hash of those exact bytes, including resume
    // continuation input; a queued or failed-to-start Run stays null.
    promptHash: null,
    targetBranch: branches.targetBranch,
    branch: branches.branch,
    opensPullRequest: intent.kind === "integrator-authorized" ? false : task.opensPullRequest,
    maxDurationMin: preservesPriorTiming ? prior?.maxDurationMin ?? task.maxDurationMin : task.maxDurationMin,
    stallTimeoutMin: preservesPriorTiming ? prior?.stallTimeoutMin ?? task.stallTimeoutMin : task.stallTimeoutMin,
    // The configured budget plus the grants already earned, not the budget
    // alone. Automatic retries deliberately use the already-authorized source
    // ceiling as their base: a mid-Run task edit cannot retroactively revoke a
    // Run, while later operator actions recompute from the current task budget.
    maxRunsPerTask,
    budgetGrants,
    readyAt: intent.readyAt,
  } });
  return { ok: true, run };
};

export const errorForOpenRunRefusal = (refusal: OpenRunRefusal): Error => {
  if (refusal.reason === "archived-task") {
    return new ArchivedTaskError(
      String(refusal.context?.taskId ?? "unknown"),
      String(refusal.context?.taskName ?? "unknown"),
    );
  }
  if (refusal.reason === "archived-assignee") {
    return new ArchivedAssigneeError(
      String(refusal.context?.taskId ?? "unknown"),
      String(refusal.context?.taskName ?? "unknown"),
      String(refusal.context?.agentName ?? "unknown"),
    );
  }
  if (refusal.reason === "integrator-stopped") {
    return new IntegratorStoppedError(
      String(refusal.context?.taskId ?? "unknown"),
      String(refusal.context?.condition ?? "unknown"),
    );
  }
  if (refusal.reason === "chain-held") {
    return new ChainHeldError(
      String(refusal.context?.taskId ?? "unknown"),
      String(refusal.context?.chainId ?? "unknown"),
      Number(refusal.context?.taskLayer ?? 0),
      Number(refusal.context?.heldLayer ?? 0),
    );
  }
  if (refusal.reason === "compound-implementation-assignee") {
    return new CompoundImplementationAssigneeError();
  }
  if (refusal.context?.code === "INTEGRATOR_BINDING_INVALID") {
    return new IntegratorBindingError(refusal.message);
  }
  return new Error(refusal.message);
};

export const enqueueTaskRunInternal = async (
  tx: Tx,
  taskId: string,
  now: Date,
  stopBypass: IntegratorStopBypass | null,
  options: EnqueueTaskRunOptions = {},
): Promise<Run> => {
  const opened = await openRun(tx, taskId, options.budgetGrant === 1
    ? { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1 }
    : { kind: "enqueue", readyAt: now, stopBypass });
  if (!opened.ok) throw errorForOpenRunRefusal(opened.refusal);
  return opened.run;
};

/**
 * The only enqueue option that may alter a task's budget. It is deliberately
 * a literal one-shot grant rather than a caller-supplied number: merge-tail
 * retries are platform compensation for a successful run, not agent failure,
 * and every other enqueue/retry path must retain its existing budget rule.
 */
export type EnqueueTaskRunOptions = { budgetGrant?: never } | { budgetGrant: 1 };

export const enqueueTaskRun = async (
  tx: Tx,
  taskId: string,
  now = new Date(),
  options: EnqueueTaskRunOptions = {},
) => enqueueTaskRunInternal(tx, taskId, now, null, options);

// The card body is one string serving two readers. Feishu is the binding one:
// `cards.ts` caps the rendered body at 3 000 characters because Feishu rejects
// oversized cards, so the preview must leave room for the gate's own prose. The
// board no longer depends on this preview at all — it renders the producing
// step's full output beside the decision (`artifactTaskId`).
const GATE_OUTPUT_PREVIEW = 2_000;

const outputPreview = async (tx: Tx, taskId: string | null): Promise<string> => {
  if (!taskId) return "";
  const output = await tx.taskStepOutput.findUnique({ where: { taskId }, select: { kind: true, body: true } });
  if (!output) return "";
  const body = output.body.trim();
  const shown = body.length > GATE_OUTPUT_PREVIEW ? `${body.slice(0, GATE_OUTPUT_PREVIEW)}\n…（预览已截断，完整产物见 Inbox 页的产物卡片）` : body;
  return `\n\n产物（${output.kind}）：\n${shown}`;
};

export const gateQuestion = async (tx: Tx, gateTaskId: string, sourceRunId: string, chatId: string | null) => {
  const [task, run] = await Promise.all([
    tx.task.findUniqueOrThrow({ where: { id: gateTaskId } }),
    tx.run.findUniqueOrThrow({ where: { id: sourceRunId }, include: { session: true } }),
  ]);
  // A gate can only follow a completed Run, and every dispatched Run owns a
  // Session. Missing one means persisted control-plane state is corrupt.
  if (!run.session) throw new Error(`Run ${sourceRunId} has no session for approval gate`);
  const thread = chatId ? await tx.inboxThread.upsert({
    where: { channel_externalChatId_sessionId: { channel: "FEISHU", externalChatId: chatId, sessionId: run.session.id } },
    create: { channel: "FEISHU", externalChatId: chatId, sessionId: run.session.id, taskId: task.id },
    update: { taskId: task.id },
  }) : null;
  const delivery = run.pullRequestUrl
    ? `\n\nPull request: ${run.pullRequestUrl}`
    : run.deliveryInstructions ? `\n\n${run.deliveryInstructions}` : "";
  // §D-P3 Phase A. A gate whose successor executes mechanically opens a
  // placeholder card and asks the evidence worker to fill it, rather than
  // reading GitHub here: this function runs inside applyInboxDecisionTx in the
  // separate @anneal/inbox process, which can reach neither the API's GitHub
  // client nor its configuration (MF-3). The read also must not happen inside
  // this lock-holding transaction (SF-2). Chains without a mechanical successor never enter
  // this branch and are byte-for-byte unchanged.
  const integrator = await gateFeedsIntegratorStep(tx, task);
  if (integrator) {
    const target = await resolveChainTarget(tx, task);
    if (target.resolved) {
      const requested = await requestMergeEvidence(tx, {
        gateTaskId: task.id,
        integratorTaskId: integrator.id,
        sourceRunId,
        agentId: run.agentId,
        sessionId: run.session.id,
        threadId: thread?.id ?? null,
        purpose: "gate",
        repository: target.repository,
        prNumber: target.prNumber,
        dedupeKey: `gate:task:${task.id}:run:${sourceRunId}`,
      });
      return tx.inboxMessage.findUniqueOrThrow({ where: { id: requested.cardId } });
    }
    // An unresolvable target cannot produce an evidence card. The gate still
    // opens through the ordinary path so a human is not left with silence; the
    // approval simply produces no authorization, and step 12 later stops
    // target-unresolvable — fail closed, and the §D-P8 repair is the exit.
  }
  // The approver decides from the card; the produced artifact rides along so
  // they do not have to open the Tasks page for the common case.
  const preview = await outputPreview(tx, run.taskId);
  return tx.inboxMessage.create({ data: {
    from: InboxSender.AGENT,
    agentId: run.agentId,
    sessionId: run.session.id,
    taskId: task.id,
    gateTaskId: task.id,
    threadId: thread?.id ?? null,
    kind: "MULTIPLE_CHOICE",
    body: `审批闸门：${task.name}\n\n请确认本步骤产出。批准后继续；打回后重新执行产出步骤。${delivery}${preview}`,
    choices: [{ id: "approve", label: "批准并继续" }, { id: "reject", label: "打回上一步" }],
    dedupeKey: `gate:task:${task.id}:run:${sourceRunId}`,
    deliveryStatus: InboxDeliveryStatus.PENDING,
  } });
};
