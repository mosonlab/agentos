import {
  AssigneeType,
  CodexServiceTier,
  InboxDeliveryStatus,
  InboxKind,
  InboxSender,
  InboxStatus,
  MergeRecoveryStatus,
  Prisma,
  RunStatus,
  type Run,
  RunnerKind,
  RunnerPreference,
  SessionExecutionStatus,
  TaskStatus,
  type Agent,
  type PrismaClient,
} from "@prisma/client";

import { sharedChainBranch } from "./chain-branch.js";
import { canonicalTemplateIdentity } from "./canonical-template-transition.js";
import { requireGateAttestation } from "./gate-attestation.js";
import { catalogRunnerForModel, DIRECT_TEMPLATE_NAME } from "./agent-contract.js";
import {
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  INTEGRATOR_TEMPLATE_NAME,
  type AuthorizationPayload,
  type DecisionChannel,
  authorizationMetadata,
  parseAuthorizationMetadata,
  parseEvidence,
} from "./merge-integrator.js";
import {
  applyStopAnswer,
  findEvidenceRequestByNonce,
  gateFeedsIntegratorStep,
  IntegratorBindingError,
  integratorBindingRefusalFor,
  isIntegratorBindingError,
  parseStopQuestionKey,
  recoverRefreshRequestedConfirmationCard,
  requestMergeEvidence,
  resolveChainTarget,
  stopStateFor,
} from "./merge-integrator-db.js";
import { isMergeReadinessStep, MERGE_TAIL_KIND } from "./merge-tail.js";
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

// The runner rule moved to the pure `@agentos/db/model-routing` subpath, which
// the browser can import without pulling in Prisma. Imported here beside its
// re-export so this module's own callers and its importers read the same rule.
import { runnerFor } from "./model-routing.js";
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
        chainIndex: baseFromStepIndex,
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

/**
 * Takes the Task-row mutex the archive/start/retry/cron writers all take.
 *
 * `SELECT … FOR UPDATE` and not a plain read: under ReadCommitted a read of one
 * table is not re-evaluated when another transaction commits, so "no active run"
 * observed without the lock can be stale by the time the run is inserted.
 */
export const lockTaskRow = async (
  tx: Tx,
  taskId: string,
): Promise<{ id: string; archivedAt: Date | null } | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string; archivedAt: Date | null }>>`
    SELECT "id", "archivedAt" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  return rows[0] ?? null;
};

/**
 * Takes the Run-row mutex every fencing writer takes.
 *
 * Run owns fencing, cancellation and terminalization, so this lock is entered
 * before the Task lock by completion, cancellation and canonical output writes
 * -- entering the two rows in opposite orders is how they would deadlock.
 *
 * Its callers ignore the row: they take the mutex and then re-read through the
 * fenced predicate. It is returned anyway, for the same reason `lockTaskRow`
 * returns one -- a caller that needs to tell "locked" from "no such run" apart
 * should not have to issue a second statement.
 */
export const lockRunRow = async (
  tx: Tx,
  runId: string,
): Promise<{ id: string } | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Run" WHERE "id" = ${runId} FOR UPDATE
  `;
  return rows[0] ?? null;
};

/**
 * Takes the Agent-row mutex that archive and every assignment/run writer share.
 *
 * Archive used to write `archivedAt` unconditionally while task creation,
 * template instantiation and run enqueue checked it in a different transaction.
 * Under ReadCommitted both sides can be right at the same instant: the writer
 * reads an unarchived agent, archive commits, and the writer then inserts a run
 * the claim query — which filters `agent: { archivedAt: null }` — will never
 * hand to a runner. That run sits QUEUED forever and its task never completes.
 *
 * The Agent row is the serialization point for that whole class. Every writer
 * that assigns an agent or creates a run for one re-reads `archivedAt` under
 * this lock; archive takes the same lock and fails closed on live references.
 *
 * Lock order is Task rows first, then this one — chain writers already hold a
 * Task lock when they reach `enqueueTaskRun`. Archive takes only this lock and
 * no Task lock, so the two orders cannot form a cycle.
 */
export const lockAgentRow = async (
  tx: Tx,
  agentId: string,
): Promise<Agent | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE
  `;
  if (!rows[0]) return null;
  return tx.agent.findUnique({ where: { id: agentId } });
};

/** The same mutex for a whole step list, in one statement. `ORDER BY "id"` is
 *  not decoration: it is what stops two concurrent instantiations of templates
 *  that share agents from deadlocking against each other. */
export const lockAgentRows = async (
  tx: Tx,
  agentIds: string[],
): Promise<Map<string, { name: string; projectId: string; archivedAt: Date | null }>> => {
  const unique = [...new Set(agentIds)];
  if (unique.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ id: string; name: string; projectId: string; archivedAt: Date | null }>>`
    SELECT "id", "name", "projectId", "archivedAt" FROM "Agent"
    WHERE "id" = ANY(${unique})
    ORDER BY "id" FOR UPDATE
  `;
  return new Map(rows.map((row) => [row.id, {
    name: row.name,
    projectId: row.projectId,
    archivedAt: row.archivedAt,
  }]));
};

/**
 * Locks every existing row in one chain in the single order shared by every
 * chained-task mutation. A prefix lock is insufficient for a layered join:
 * two siblings can complete concurrently while each only locks its own
 * prefix, then both observe a stale incomplete layer and race the join.
 *
 * The nullable columns are deliberate while the expand migration is live. The
 * query still locks malformed rows, so a later contract migration cannot race
 * a writer that is already holding one of them.
 */
export const lockChainRows = async (
  tx: Tx,
  input: { projectId: string; chainId: string },
): Promise<string[]> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task"
    WHERE "projectId" = ${input.projectId}
      AND "chainId" = ${input.chainId}
    ORDER BY "chainLayer" NULLS LAST, "chainIndex" NULLS LAST, "id" FOR UPDATE
  `;
  return rows.map((row) => row.id);
};

/** Serializes Run creation with revocation of the exact agent/repository grant.
 * Task locks are always acquired first by chain writers; revocation takes only
 * this grant lock, so the order cannot form a cycle. */
export const lockAgentRepoGrant = async (
  tx: Tx,
  input: { projectId: string; agentId: string; repoId: string },
): Promise<boolean> => {
  const rows = await tx.$queryRaw<Array<{ agentId: string; repoId: string }>>`
    SELECT "agentId", "repoId" FROM "AgentRepoAccess"
    WHERE "projectId" = ${input.projectId}
      AND "agentId" = ${input.agentId}
      AND "repoId" = ${input.repoId}
    FOR KEY SHARE
  `;
  if (rows.length === 0) return false;
  return (await tx.agentRepoAccess.count({ where: input })) === 1;
};

/** Exclusive companion for grant revocation. It intentionally takes no Task
 * lock: start owns Task-prefix then grant, while revoke owns only grant. */
export const lockAgentRepoGrantForRevocation = async (
  tx: Tx,
  input: { projectId: string; agentId: string; repoId: string },
): Promise<boolean> => {
  const rows = await tx.$queryRaw<Array<{ agentId: string; repoId: string }>>`
    SELECT "agentId", "repoId" FROM "AgentRepoAccess"
    WHERE "projectId" = ${input.projectId}
      AND "agentId" = ${input.agentId}
      AND "repoId" = ${input.repoId}
    FOR UPDATE
  `;
  return rows.length === 1;
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

type IntegratorStopBypass = { integratorTaskId: string; sourceStopId: string };

export type OpenRunIntent =
  | { kind: "enqueue"; readyAt: Date; stopBypass?: IntegratorStopBypass | null }
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
    | "integrator-stopped";
  message: string;
  detail?: Readonly<Record<string, string | number | boolean | null>>;
  context?: Readonly<{
    taskId?: string;
    taskName?: string;
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
  if (!task.repo && (intent.kind === "enqueue" || intent.kind === "task-created" || intent.kind === "integrator-authorized")) {
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
  if ((intent.kind === "retry" || intent.kind === "integrator-authorized" || sourceRetryIntent(intent)) && !prior) {
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

const errorForOpenRunRefusal = (refusal: OpenRunRefusal): Error => {
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
  if (refusal.reason === "compound-implementation-assignee") {
    return new CompoundImplementationAssigneeError();
  }
  if (refusal.context?.code === "INTEGRATOR_BINDING_INVALID") {
    return new IntegratorBindingError(refusal.message);
  }
  return new Error(refusal.message);
};

const enqueueTaskRunInternal = async (
  tx: Tx,
  taskId: string,
  now: Date,
  stopBypass: IntegratorStopBypass | null,
): Promise<Run> => {
  const opened = await openRun(tx, taskId, { kind: "enqueue", readyAt: now, stopBypass });
  if (!opened.ok) throw errorForOpenRunRefusal(opened.refusal);
  return opened.run;
};

export const enqueueTaskRun = async (tx: Tx, taskId: string, now = new Date()) =>
  enqueueTaskRunInternal(tx, taskId, now, null);

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
  // separate @agentos/inbox process, which can reach neither the API's GitHub
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

type ChainTask = {
  id: string;
  projectId: string;
  name: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer?: number | null;
};

type ChainSuccessor = Prisma.TaskGetPayload<{ include: { runs: true; assigneeAgent: true } }>;
// ChainSuccessor.runs is always fetched filtered to ACTIVE_RUN_STATUSES: it exists
// only to answer "is any run still alive?" for the guards below.

/**
 * "This task already has a run that is alive." WAITING_INBOX belongs here: such
 * a run resumes the moment the operator answers, so a task holding one must not
 * gain a second run, be archived, or be parked in Backlog.
 *
 * This is the definition every guard added by batch 2.5 shares, and since the
 * 2026-08-18 repairs the operator retry route and the chain/follow-up successor
 * guards count against it across ALL of a task's runs — a latest-run-only read
 * misses an older WAITING_INBOX run hiding behind a newer terminal one.
 * `app.ts`'s `activeRunStatuses` remains a different concept (a lease).
 */
export const ACTIVE_RUN_STATUSES: RunStatus[] = [
  RunStatus.QUEUED,
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
];

/**
 * "This task is a live reference to its assignee." Every status here is one the
 * control plane can still turn into a run without an operator reassigning the
 * task: TODO covers a queued step, a scheduled definition and a parked future
 * chain step; DOING covers the step currently executing; REVIEW covers a step
 * whose approval gate can still be rejected, which queues the producing step
 * again. DONE is terminal history and BACKLOG is where an operator explicitly
 * parks work, so neither blocks.
 */
export const LIVE_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.DOING,
  TaskStatus.REVIEW,
];

/**
 * Why this agent may not be archived right now, or null.
 *
 * Read under `lockAgentRow`, so it is the fail-closed half of the protocol: a
 * writer that already created a live reference holds the lock until it commits,
 * and archive then sees that reference instead of stranding it. Runs come first
 * because a queued run for an archived agent is exactly the row nothing ever
 * claims; a live task is the same stall one step earlier — nothing has enqueued
 * its run yet, so no run exists to be found, and archiving now strands the task
 * the moment anything tries to.
 *
 * Archived history is untouched — DONE tasks, BACKLOG tasks and terminal runs
 * never block, so retiring an agent whose work is finished or explicitly parked
 * stays a one-click operation.
 */
export const agentArchiveBlocker = async (tx: Tx, agentId: string): Promise<string | null> => {
  const run = await tx.run.findFirst({
    where: { agentId, status: { in: ACTIVE_RUN_STATUSES } },
    orderBy: { runNumber: "asc" },
    select: { runNumber: true, status: true, task: { select: { name: true } } },
  });
  if (run) {
    const where = run.task ? ` on ${run.task.name}` : "";
    return `Cannot archive an agent with a ${run.status} run${where}; finish or cancel run ${run.runNumber} first`;
  }
  const task = await tx.task.findFirst({
    where: { assigneeAgentId: agentId, archivedAt: null, status: { in: LIVE_TASK_STATUSES } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { name: true, status: true },
  });
  // The status is named because the four exits differ by it, and the operator
  // has to pick one: an executing task is finished or cancelled, a queued one is
  // parked in Backlog or archived, a reviewed one is decided, and any of them
  // can instead be handed to another agent.
  if (task) {
    return `Cannot archive an agent assigned to ${task.status} task ${task.name}; finish, park, archive, or reassign that task first`;
  }
  return null;
};

const isUniqueConflict = (error: unknown): boolean => (
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
);

type BoundDispatchMetadata = {
  predecessorTaskId: string;
  predecessorChainId: string;
  successorTaskId: string;
  successorChainId: string;
};

const boundDispatchMetadata = (
  predecessor: ChainTask,
  successor: ChainTask,
): BoundDispatchMetadata => ({
  predecessorTaskId: predecessor.id,
  predecessorChainId: predecessor.chainId!,
  successorTaskId: successor.id,
  successorChainId: successor.chainId!,
});

/**
 * Records the two sides of a binding decision together. The pointer remains
 * on the successor task forever; these rows are the durable audit trail for
 * both a successful dispatch and a fail-closed refusal.
 */
const boundDispatchActivities = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainTask,
  input: {
    successorBody: string;
    predecessorBody: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> => {
  const metadata = {
    ...boundDispatchMetadata(predecessor, successor),
    ...input.metadata,
  };
  await tx.taskActivity.create({
    data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: input.successorBody,
      metadata,
    },
  });
  await tx.taskActivity.create({
    data: {
      taskId: predecessor.id,
      actorType: "control-plane",
      body: input.predecessorBody,
      metadata,
    },
  });
};

const parkBoundSuccessor = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainSuccessor,
  reason: string,
  metadata: Record<string, unknown> = {},
): Promise<void> => {
  await tx.task.update({
    where: { id: successor.id },
    data: { status: TaskStatus.REVIEW, failureReason: reason },
  });
  await boundDispatchActivities(tx, predecessor, successor, {
    successorBody: `Bound predecessor completed; successor parked in REVIEW: ${reason}`,
    predecessorBody: `Bound chain dispatch refused; successor parked in REVIEW: ${reason}`,
    metadata: { state: "parked", failureReason: reason, ...metadata },
  });
};

const boundSuccessorQueuedActivity = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainSuccessor,
  state: "queued" | "already-queued",
  runId: string | null,
): Promise<void> => {
  await boundDispatchActivities(tx, predecessor, successor, {
    successorBody: state === "queued"
      ? "Bound predecessor completed; first step queued"
      : "Bound predecessor completed; successor already queued",
    predecessorBody: state === "queued"
      ? "Bound chain dispatched"
      : "Bound chain dispatch observed an already queued successor",
    metadata: { state, runId },
  });
};

type BoundSuccessor = Prisma.TaskGetPayload<{
  include: { runs: true; assigneeAgent: true; repo: true };
}>;

/**
 * Resolves the one successor bound to a completed predecessor. The caller
 * already owns the predecessor chain mutex; this function acquires the
 * successor chain mutex second and never the other way around. That order is
 * total because a binding can only point at a chain that pre-dates its own.
 */
const dispatchBoundSuccessor = async (
  tx: Tx,
  predecessor: ChainSuccessor,
  successorId: string,
  now: Date,
  predecessorTerminal: boolean,
): Promise<void> => {
  const successorIdentity = await tx.task.findUnique({
    where: { id: successorId },
    select: { projectId: true, chainId: true },
  });
  if (!successorIdentity?.chainId) {
    // The binding shape check makes this unreachable for persisted rows. Keep
    // the refusal explicit if a legacy or hand-written fixture violates it.
    throw new Error(`Bound successor ${successorId} has no chain identity`);
  }
  await lockChainRows(tx, {
    projectId: successorIdentity.projectId,
    chainId: successorIdentity.chainId,
  });
  const successor = await tx.task.findUnique({
    where: { id: successorId },
    include: {
      runs: {
        where: { status: { in: ACTIVE_RUN_STATUSES } },
        orderBy: { runNumber: "desc" },
      },
      assigneeAgent: true,
      repo: true,
    },
  }) as BoundSuccessor | null;
  // The binding foreign key and the successor chain mutex make disappearance
  // an integrity violation rather than a caller-recoverable refusal.
  if (!successor) throw new Error(`Bound successor ${successorId} disappeared while dispatching`);

  if (!predecessorTerminal) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      "bound predecessor is no longer terminal; successor was not queued",
      { predecessorTerminal: false },
    );
    return;
  }

  // A second completion/replay can arrive after the first transaction has
  // committed its Run. Treat that as an idempotent observation, not as a
  // refusal that would overwrite the successfully queued task with REVIEW.
  if (successor.runs.length > 0) {
    await boundSuccessorQueuedActivity(tx, predecessor, successor, "already-queued", successor.runs[0]!.id);
    return;
  }
  if (successor.archivedAt) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `successor ${successor.name} is archived; unarchive the task and retry dispatch`,
    );
    return;
  }
  if (successor.status === TaskStatus.DONE) {
    await boundSuccessorQueuedActivity(tx, predecessor, successor, "already-queued", null);
    return;
  }
  if (successor.status !== TaskStatus.TODO) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `successor ${successor.name} is ${successor.status}; it was not queued`,
    );
    return;
  }
  if (successor.assigneeType !== AssigneeType.AGENT || !successor.assigneeAgentId || !successor.assigneeAgent || !successor.repoId || !successor.repo) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `successor ${successor.name} cannot be queued without an agent and repo`,
    );
    return;
  }
  if (successor.assigneeAgent.archivedAt) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `assignee ${successor.assigneeAgent.name} is archived; unarchive the agent and retry dispatch`,
    );
    return;
  }
  if (!await lockAgentRepoGrant(tx, {
    projectId: successor.projectId,
    agentId: successor.assigneeAgentId,
    repoId: successor.repoId,
  })) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `repository-grant-missing: assignee ${successor.assigneeAgent.name} has no grant for Repo ${successor.repo.name}; restore the grant and retry dispatch`,
    );
    return;
  }

  const stopped = await stopStateFor(tx, successor.id);
  if (stopped) {
    await parkBoundSuccessor(
      tx,
      predecessor,
      successor,
      `merge integrator stopped on ${stopped.stop.condition}; predecessor success preserved and successor not activated`,
      { condition: stopped.stop.condition, sourceStopId: stopped.stop.stopId },
    );
    return;
  }

  const rawTx = tx as Tx & { $executeRawUnsafe?: (query: string) => Promise<number> };
  const hasSavepoint = typeof rawTx.$executeRawUnsafe === "function";
  const savepoint = "chain_dispatch_enqueue";
  if (hasSavepoint) await rawTx.$executeRawUnsafe!(`SAVEPOINT ${savepoint}`);
  try {
    const run = await enqueueTaskRunInternal(tx, successor.id, now, null);
    if (hasSavepoint) await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
    await boundSuccessorQueuedActivity(tx, predecessor, successor, "queued", run.id);
  } catch (error: unknown) {
    if (isUniqueConflict(error)) {
      if (hasSavepoint) {
        await rawTx.$executeRawUnsafe!(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
      }
      await boundSuccessorQueuedActivity(tx, predecessor, successor, "already-queued", null);
      return;
    }
    if (hasSavepoint) {
      await rawTx.$executeRawUnsafe!(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
    }
    if (isArchivedTaskError(error)) {
      await parkBoundSuccessor(
        tx,
        predecessor,
        successor,
        `successor ${successor.name} is archived; unarchive the task and retry dispatch`,
      );
      return;
    }
    if (isArchivedAssigneeError(error)) {
      await parkBoundSuccessor(
        tx,
        predecessor,
        successor,
        `assignee ${successor.assigneeAgent.name} is archived; unarchive the agent and retry dispatch`,
      );
      return;
    }
    if (isIntegratorStoppedError(error)) {
      await parkBoundSuccessor(
        tx,
        predecessor,
        successor,
        `merge integrator stopped on ${error.condition}; predecessor success preserved and successor not activated`,
        { condition: error.condition },
      );
      return;
    }
    if (isIntegratorBindingError(error)) {
      await parkBoundSuccessor(
        tx,
        predecessor,
        successor,
        `successor ${successor.name} violates the merge-integrator binding invariant: ${error.refusal}; restore the canonical assignee binding and retry dispatch`,
        { refusal: "integrator-binding", detail: error.refusal },
      );
      return;
    }
    if (isCompoundImplementationAssigneeError(error)) {
      await parkBoundSuccessor(
        tx,
        predecessor,
        successor,
        `successor ${successor.name} violates the compound implementation assignee invariant: ${error.message}; restore the canonical assignee binding and retry dispatch`,
        { refusal: COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE },
      );
      return;
    }
    throw error;
  }
};

/**
 * Why this successor must not be claimed, or null if it may be.
 *
 * Both answers are an operator's explicit intent: an archived task is retired
 * and a Backlog task is parked, so a predecessor completing does not get to
 * drag either back into execution.
 *
 * A REVIEW successor is deliberately absent. It used to sit here as a
 * fall-through, which is how a chain could stop for hours with nothing but an
 * activity row to say so; `resumeParkedSuccessor` now owns that case.
 */
const parkedReason = (successor: { status: TaskStatus; archivedAt?: Date | null }): string | null => {
  if (successor.archivedAt) return "successor is archived and was not queued";
  if (successor.status === TaskStatus.BACKLOG) return "successor is parked in Backlog — use Start now";
  return null;
};

/** Activity kind recording one automatic recovery of a REVIEW successor. */
export const CHAIN_AUTO_RESUME_KIND = "chainDispatch.autoResume";

/**
 * How many times a chain may return the same successor to TODO by itself.
 *
 * The recovery exists because a REVIEW successor at dispatch time is a stalled
 * chain, not a decision anyone made. The ceiling exists because a step that
 * keeps landing back in REVIEW is failing for a reason no requeue fixes, and
 * spinning on it is worse than stopping and saying so.
 *
 * Five, not three: a merge-readiness step is legitimately parked and re-queued
 * once per automatic repair round, and the tail allows three of those, so a
 * lower ceiling would stop a converging chain rather than a thrashing one.
 */
export const MAX_AUTOMATIC_SUCCESSOR_RESUMES = 5;

/**
 * Returns a stalled REVIEW successor to the queue, or stops the chain when it
 * has already been returned too many times.
 *
 * `true` means the caller may go on to dispatch it; `false` means this
 * successor is parked for a human and the caller must skip it.
 */
const resumeParkedSuccessor = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainSuccessor,
): Promise<boolean> => {
  const priorResumes = await tx.taskActivity.count({
    where: {
      taskId: successor.id,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: CHAIN_AUTO_RESUME_KIND },
    },
  });
  const attempt = priorResumes + 1;
  if (attempt > MAX_AUTOMATIC_SUCCESSOR_RESUMES) {
    const reason = `successor returned to REVIEW after ${String(MAX_AUTOMATIC_SUCCESSOR_RESUMES)} automatic resumes; chain stopped for an operator`;
    await tx.task.update({
      where: { id: successor.id },
      data: { status: TaskStatus.REVIEW, failureReason: reason },
    });
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: `Predecessor layer completed; ${reason}`,
      metadata: {
        kind: CHAIN_AUTO_RESUME_KIND,
        schemaVersion: 1,
        state: "exhausted",
        attempt,
        predecessorTaskId: predecessor.id,
      },
    } });
    await tx.inboxMessage.upsert({
      where: { dedupeKey: `chain-successor-auto-resume-exhausted:${successor.id}` },
      create: {
        from: "AGENT",
        taskId: successor.id,
        kind: "TEXT",
        body: `Chain step ${successor.name} was automatically resumed ${String(MAX_AUTOMATIC_SUCCESSOR_RESUMES)} times and is back in REVIEW; the chain is stopped and needs an operator.`,
        dedupeKey: `chain-successor-auto-resume-exhausted:${successor.id}`,
      },
      update: {},
    });
    return false;
  }
  await tx.task.update({
    where: { id: successor.id },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await tx.taskActivity.create({ data: {
    taskId: successor.id,
    actorType: "control-plane",
    body: `Predecessor layer completed; successor was stalled in REVIEW and was automatically returned to the queue (resume ${String(attempt)} of ${String(MAX_AUTOMATIC_SUCCESSOR_RESUMES)})`,
    metadata: {
      kind: CHAIN_AUTO_RESUME_KIND,
      schemaVersion: 1,
      state: "resumed",
      attempt,
      predecessorTaskId: predecessor.id,
    },
  } });
  return true;
};

type ChainSuccessorOptions = {
  sourceRunId?: string | null;
  chatId?: string | null;
  archivedAssignee?: "park" | "throw";
};

const parkStoppedIntegratorSuccessor = async (
  tx: Tx,
  predecessor: ChainTask,
  successor: ChainSuccessor,
  stopped: NonNullable<Awaited<ReturnType<typeof stopStateFor>>>,
  sourceRunId: string | null,
): Promise<{ nextTaskId: string; gated: false }> => {
  await tx.task.update({
    where: { id: successor.id },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: `Merge integrator stopped on ${stopped.stop.condition}; predecessor success preserved and successor not activated`,
    },
  });
  await tx.taskActivity.create({
    data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: `Predecessor ${predecessor.name} completed successfully and was preserved; successor not activated because merge integrator stopped on ${stopped.stop.condition}`,
      metadata: {
        condition: stopped.stop.condition,
        sourceRunId,
        sourceStopId: stopped.stop.stopId,
      },
    },
  });
  return { nextTaskId: successor.id, gated: false };
};

const layerOf = (task: { chainLayer?: number | null; chainIndex: number | null }): number | null => (
  task.chainLayer ?? task.chainIndex
);

const layerOrder = (
  left: { chainLayer?: number | null; chainIndex: number | null; id: string },
  right: { chainLayer?: number | null; chainIndex: number | null; id: string },
): number => (
  (layerOf(left) ?? 0) - (layerOf(right) ?? 0)
    || (left.chainIndex ?? 0) - (right.chainIndex ?? 0)
    || left.id.localeCompare(right.id)
);

/**
 * Activates the next execution layer under a full-chain mutex. The rows are
 * re-read after the lock so a completion in one review sibling cannot observe
 * a stale incomplete layer or enqueue the join twice.
 */
const activateChainSuccessorInternal = async (
  tx: Tx,
  task: ChainTask,
  options: ChainSuccessorOptions,
  now: Date,
  stopBypass: IntegratorStopBypass | null,
  chainRowsLocked = false,
): Promise<{ nextTaskId: string | null; gated: boolean }> => {
  if (!task.chainId || task.chainIndex === null) {
    if (task.chainId) {
      await tx.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: "Chain row missing chain identity; auto-advance skipped",
      } });
    }
    return { nextTaskId: null, gated: false };
  }

  if (!chainRowsLocked) {
    await lockChainRows(tx, { projectId: task.projectId, chainId: task.chainId });
  }
  const chainRows: ChainSuccessor[] = await tx.task.findMany({
    where: { projectId: task.projectId, chainId: task.chainId },
    include: {
      runs: { where: { status: { in: ACTIVE_RUN_STATUSES } }, orderBy: { runNumber: "desc" }, take: 1 },
      assigneeAgent: true,
    },
  });
  chainRows.sort(layerOrder);
  const current = chainRows.find((row) => row.id === task.id);
  const currentLayer = current ? layerOf(current) : layerOf(task);
  if (!current || currentLayer === null) {
    await tx.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "control-plane",
      body: "Chain row missing execution layer; auto-advance skipped",
    } });
    return { nextTaskId: null, gated: false };
  }

  const currentRows = chainRows.filter((row) => layerOf(row) === currentLayer);
  const boundSuccessor = current.status === TaskStatus.DONE
    ? await tx.task.findUnique({
      where: { dispatchAfterTaskId: current.id },
      select: { id: true },
    })
    : null;
  if (!currentRows.every((row) => row.status === TaskStatus.DONE)) {
    // The first review completion exits here while its blind sibling is still
    // unfinished; the second completion owns the join.
    if (boundSuccessor) {
      await dispatchBoundSuccessor(tx, current, boundSuccessor.id, now, false);
    }
    return { nextTaskId: null, gated: false };
  }
  // A legacy chain can contain a historical DONE gap (for example an operator
  // completed a step before deleting its run). Treat fully completed layers as
  // history and select the first higher layer that still has work. This keeps
  // the one-node-per-layer migration linear without recursively re-entering the
  // activation routine.
  const nextLayer = [...new Set(chainRows.map(layerOf).filter((value): value is number => value !== null))]
    .filter((value) => value > currentLayer)
    .sort((left, right) => left - right)
    .find((value) => chainRows.some((row) => layerOf(row) === value && row.status !== TaskStatus.DONE));
  if (nextLayer === undefined) {
    const predecessorComplete = chainRows.every((row) => row.status === TaskStatus.DONE);
    if (!boundSuccessor || predecessorComplete) {
      await tx.taskActivity.create({ data: { taskId: current.id, actorType: "control-plane", body: "Chain complete" } });
    }
    // Archiving a predecessor does not resolve its binding. Production routes
    // cannot complete an archived task, but retaining this check also keeps
    // legacy/directly-seeded rows inert instead of dispatching from archived
    // history when an activation replay is attempted.
    if (boundSuccessor && current.archivedAt === null) {
      await dispatchBoundSuccessor(tx, current, boundSuccessor.id, now, predecessorComplete);
    }
    return { nextTaskId: null, gated: false };
  }

  // A binding to a non-terminal layer is rejected at instantiation time. If a
  // legacy row or a direct fixture nevertheless carries one, park it while the
  // predecessor chain still has work above this layer instead of silently
  // leaving the successor inert forever.
  if (boundSuccessor) {
    await dispatchBoundSuccessor(tx, current, boundSuccessor.id, now, false);
  }

  const nextRows = chainRows.filter((row) => layerOf(row) === nextLayer).sort(layerOrder);
  if (nextRows.some((row) => row.approvalGate) && nextRows.length > 1) {
    throw new WorkflowRefusalError("invalid-request", `Approval gate is not allowed in multi-node chain layer ${nextLayer}`);
  }
  if (nextRows.some((row) => row.approvalGate
      && (row.assigneeType !== AssigneeType.AGENT || !row.assigneeAgentId || !row.repoId))
    && (currentRows.length !== 1
      || currentRows[0]!.assigneeType !== AssigneeType.AGENT
      || !currentRows[0]!.assigneeAgentId
      || !currentRows[0]!.repoId)) {
    throw new WorkflowRefusalError("invalid-request", "Server-owned approval gate must follow one executable predecessor");
  }

  let firstNextTaskId: string | null = null;
  let gated = false;
  for (const successor of nextRows) {
    firstNextTaskId ??= successor.id;
    if (successor.status === TaskStatus.DONE) continue;
    if (successor.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
      await tx.taskActivity.create({ data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: "Predecessor layer completed; successor already active",
      } });
      continue;
    }
    const parked = parkedReason(successor);
    if (parked) {
      await tx.taskActivity.create({ data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: `Predecessor layer completed; ${parked}`,
      } });
      continue;
    }
    // A REVIEW successor at dispatch time is a stalled chain rather than a
    // decision anyone made, so it is returned to the queue under a bounded
    // ceiling instead of being resumed unconditionally.
    if (successor.status === TaskStatus.REVIEW && !await resumeParkedSuccessor(tx, current, successor)) continue;

    const successorStep = successor.templateStepId
      ? await tx.taskTemplateStep.findUnique({
        where: { id: successor.templateStepId },
        select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
      })
      : null;
    if (isCompoundImplementationStep(successorStep)) {
      const lockedAgent = successor.assigneeAgentId
        ? await lockAgentRow(tx, successor.assigneeAgentId)
        : null;
      if (lockedAgent?.archivedAt) {
        throw new ArchivedAssigneeError(successor.id, successor.name, lockedAgent.name);
      }
      if (!compoundImplementationAssigneeValid(
        successor.projectId,
        successor.assigneeType,
        lockedAgent,
        successorStep,
      )) {
        throw new CompoundImplementationAssigneeError();
      }
    }
    if (isMergeReadinessStep(successorStep)) {
      await tx.taskActivity.create({ data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: "Predecessor layer completed; server-side merge readiness queued",
        metadata: {
          kind: MERGE_TAIL_KIND.readiness,
          schemaVersion: 1,
          state: "queued",
          sourceRunId: options.sourceRunId ?? null,
        },
      } });
      continue;
    }

    if (successor.assigneeType !== AssigneeType.AGENT || !successor.assigneeAgentId || !successor.repoId) {
      if (options.sourceRunId) {
        await tx.task.update({ where: { id: successor.id }, data: { status: TaskStatus.REVIEW } });
        await gateQuestion(tx, successor.id, options.sourceRunId, options.chatId ?? null);
        gated = true;
      } else {
        await tx.taskActivity.create({ data: {
          taskId: successor.id,
          actorType: "control-plane",
          body: "Predecessor layer completed; successor awaits operator",
        } });
      }
      continue;
    }

    const stopped = await stopStateFor(tx, successor.id);
    if (stopped && (stopBypass?.integratorTaskId !== successor.id || stopBypass.sourceStopId !== stopped.stop.stopId)) {
      await parkStoppedIntegratorSuccessor(tx, current, successor, stopped, options.sourceRunId ?? null);
      continue;
    }
    if (successor.assigneeAgent?.archivedAt) {
      if (options.archivedAssignee === "throw") {
        throw new ArchivedAssigneeError(successor.id, successor.name, successor.assigneeAgent.name);
      }
      await tx.task.update({
        where: { id: successor.id },
        data: {
          status: TaskStatus.REVIEW,
          failureReason: `Assignee ${successor.assigneeAgent.name} is archived; unarchive the agent and retry to queue this step`,
        },
      });
      await tx.taskActivity.create({ data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: `Predecessor layer completed but assignee ${successor.assigneeAgent.name} is archived; step not queued`,
      } });
      continue;
    }

    const rawTx = tx as Tx & { $executeRawUnsafe?: (query: string) => Promise<number> };
    const hasSavepoint = typeof rawTx.$executeRawUnsafe === "function";
    // Each successor is handled serially and the savepoint is released before
    // the next one, so one bounded identifier avoids interpolating an external
    // task id into SQL (and stays below PostgreSQL's identifier limit).
    const savepoint = "chain_layer_enqueue";
    if (hasSavepoint) await rawTx.$executeRawUnsafe!(`SAVEPOINT ${savepoint}`);
    try {
      await enqueueTaskRunInternal(tx, successor.id, now, stopBypass);
      if (hasSavepoint) await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error: unknown) {
      if (!isUniqueConflict(error) && !isIntegratorStoppedError(error)) throw error;
      if (hasSavepoint) {
        await rawTx.$executeRawUnsafe!(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
      }
      if (isIntegratorStoppedError(error)) {
        const stoppedAfterRollback = await stopStateFor(tx, successor.id);
        if (!stoppedAfterRollback) throw error;
        await parkStoppedIntegratorSuccessor(tx, current, successor, stoppedAfterRollback, options.sourceRunId ?? null);
      }
      continue;
    }
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: "Predecessor layer completed; step queued",
    } });
  }
  return { nextTaskId: firstNextTaskId, gated };
};

export const activateChainSuccessor = async (
  tx: Tx,
  task: ChainTask,
  options: ChainSuccessorOptions = {},
  now = new Date(),
): Promise<{ nextTaskId: string | null; gated: boolean }> =>
  activateChainSuccessorInternal(tx, task, options, now, null);

/**
 * The only automatic exit through an unresolved integrator stop. The caller is
 * the server-owned readiness worker, but authority comes from durable rows: an
 * exact queued recovery bound to the latest stop and a fresh mechanical
 * authorization for that recovery's current base. Generic activation and
 * enqueue APIs never receive the resulting one-stop bypass.
 */
export const activateRecoveryIntegratorSuccessor = async (
  tx: Tx,
  input: {
    readinessTaskId: string;
    integratorTaskId: string;
    sourceStopId: string;
    recoveryRunId: string;
    authorizationActivityId: string;
  },
  now = new Date(),
): Promise<{ nextTaskId: string | null; gated: boolean }> => {
  // Every failure below checks authority written by control-plane workers after
  // their candidate was selected. A mismatch is an internal recovery invariant,
  // not an operator input error, and therefore deliberately remains a 500.
  const identity = await tx.task.findUnique({
    where: { id: input.readinessTaskId },
    select: { projectId: true, chainId: true },
  });
  if (!identity?.chainId) {
    throw new Error("Recovery activation requires a chained merge-readiness step");
  }
  // Recovery follows the same mutation protocol as every other chain writer:
  // resolve identity without a row lock, acquire the full chain mutex, then
  // re-read every authority fact before changing the integrator task.
  await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
  const [readiness, stopped, recovery, authorization, output] = await Promise.all([
    tx.task.findUnique({
      where: { id: input.readinessTaskId },
      include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } },
    }),
    stopStateFor(tx, input.integratorTaskId),
    tx.mergeRecoveryAttempt.findFirst({
      where: {
        integratorTaskId: input.integratorTaskId,
        sourceStopId: input.sourceStopId,
        recoveryRunId: input.recoveryRunId,
        status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      },
      orderBy: [{ attempt: "desc" }, { id: "desc" }],
    }),
    tx.taskActivity.findUnique({
      where: { id: input.authorizationActivityId },
      select: { id: true, taskId: true, actorType: true, metadata: true },
    }),
    tx.taskStepOutput.findUnique({
      where: { taskId: input.readinessTaskId },
      select: { kind: true, body: true, commitSha: true },
    }),
  ]);
  if (!readiness || readiness.status !== TaskStatus.DONE || !isMergeReadinessStep(readiness.templateStep)) {
    throw new Error("Recovery activation requires a completed server-owned merge-readiness step");
  }
  if (!stopped || stopped.stop.stopId !== input.sourceStopId) {
    throw new Error("Recovery activation is not bound to the current unresolved integrator stop");
  }
  if (!recovery || recovery.readinessTaskId !== input.readinessTaskId) {
    throw new Error("Recovery activation has no matching canonical recovery aggregate");
  }

  const parsedAuthorization = parseAuthorizationMetadata(authorization?.metadata);
  const authorizationMetadataValue = authorization?.metadata as Record<string, unknown> | null | undefined;
  if (!authorization
    || authorization.taskId !== input.readinessTaskId
    || authorization.actorType !== "control-plane"
    || parsedAuthorization.status !== "ok"
    || authorizationMetadataValue?.recoverySourceStopId !== input.sourceStopId) {
    throw new Error("Recovery activation requires a control-plane authorization bound to its source stop");
  }
  const payload = parsedAuthorization.payload;
  if (!recovery.repository || recovery.prNumber === null || !recovery.targetBranch
    || !recovery.authorizedHeadSha || !recovery.currentBaseSha
    || payload.repository !== recovery.repository
    || payload.prNumber !== recovery.prNumber
    || payload.baseRef !== recovery.targetBranch
    || payload.headSha !== recovery.authorizedHeadSha
    || payload.baseSha !== recovery.currentBaseSha
    || payload.decision.channel !== "mechanical") {
    throw new Error("Recovery activation authorization is not fresh for the recovered exact head and current base");
  }

  let outputBinding: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(output?.body ?? "null") as unknown;
    outputBinding = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    outputBinding = null;
  }
  if (output?.kind !== "merge-authorization"
    || output.commitSha !== payload.headSha
    || outputBinding?.authorizationActivityId !== authorization.id
    || outputBinding?.headSha !== payload.headSha) {
    throw new Error("Recovery activation readiness output does not select the fresh authorization");
  }

  // REVIEW normally parks a successor for an operator. This path is the one
  // validated automatic exit from an integrator stop, so make the task
  // runnable only after every recovery/authorization fence above succeeds.
  // The enclosing transaction rolls this change back if enqueueing fails.
  await tx.task.update({
    where: { id: input.integratorTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  const activated = await activateChainSuccessorInternal(
    tx,
    readiness,
    {},
    now,
    { integratorTaskId: input.integratorTaskId, sourceStopId: input.sourceStopId },
    true,
  );
  if (activated.nextTaskId !== input.integratorTaskId) {
    throw new Error("Recovery activation did not resolve the expected merge-integrator successor");
  }
  await tx.mergeRecoveryAttempt.update({ where: { id: recovery.id }, data: {
    status: MergeRecoveryStatus.SUCCEEDED,
    authorizationActivityId: authorization.id,
    failureReason: null,
    endedAt: now,
  } });
  return activated;
};

/** Marks a completed template task done and activates exactly one successor or gate. */
export const advanceTemplateTask = async (
  tx: Tx,
  taskId: string,
  sourceRunId: string,
  chatId: string | null,
  now = new Date(),
  expectedStatus?: TaskStatus,
): Promise<{ gated: boolean; nextTaskId: string | null }> => {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
  });
  if (!task.templateId) return { gated: false, nextTaskId: null };
  // The completion transaction may arrive here after locking the Run, but it
  // must acquire the complete chain before changing even the producing Task.
  // Otherwise this update would hold one Task row and activateChainSuccessor
  // would later expand the lock to siblings, inverting the full-chain mutex.
  if (task.chainId) {
    await lockChainRows(tx, { projectId: task.projectId, chainId: task.chainId });
  }
  if (task.approvalGate) {
    if (task.chainId) {
      const layer = layerOf(task);
      const siblingCount = layer === null ? 0 : await tx.task.count({
        where: {
          projectId: task.projectId,
          chainId: task.chainId,
          ...(task.chainLayer !== null && task.chainLayer !== undefined
            ? { chainLayer: task.chainLayer }
            : { chainIndex: task.chainIndex }),
        },
      });
      if (siblingCount > 1) {
        throw new WorkflowRefusalError("invalid-request", "Approval gate is not allowed in a multi-node chain layer");
      }
    }
    if (expectedStatus) {
      const claimed = await tx.task.updateMany({ where: { id: task.id, status: expectedStatus }, data: { status: TaskStatus.REVIEW } });
      if (claimed.count !== 1) return { gated: false, nextTaskId: null };
    } else {
      await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.REVIEW } });
    }
    await gateQuestion(tx, task.id, sourceRunId, chatId);
    return { gated: true, nextTaskId: null };
  }
  if (expectedStatus) {
    const claimed = await tx.task.updateMany({ where: { id: task.id, status: expectedStatus }, data: { status: TaskStatus.DONE, failureReason: null } });
    if (claimed.count !== 1) return { gated: false, nextTaskId: null };
  } else {
    await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE, failureReason: null } });
  }
  return activateChainSuccessor(tx, task, { sourceRunId, chatId }, now);
};

/**
 * Refusals this function raises. They roll the approval transaction back, which
 * leaves the card OPEN — the human tries again once the worker has filled it,
 * rather than the gate silently closing onto an authorization nobody judged.
 */
export class MergeEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeEvidenceError";
  }
}

export const isMergeEvidenceError = (error: unknown): error is MergeEvidenceError =>
  error instanceof Error && error.name === "MergeEvidenceError";

export type MergeAuthorizationResult = {
  activityId: string;
  purpose: "gate" | "confirmation";
  payload: AuthorizationPayload;
};

/**
 * §D-P3 Phase C, shared verbatim by the Inbox channel and the PATCH channel.
 *
 * The whole security argument sits in one line below: the payload is built from
 * `card.body`, which `gateQuestion` and the evidence worker are the only writers
 * of. "Presented equals recorded" is therefore true *by identity* rather than by
 * comparison — there is no second source for the head, base or checks that could
 * disagree with what the human read.
 *
 * It performs no network I/O and reads no field that was not already persisted,
 * so it runs unchanged in the @agentos/inbox process and inside the API's PATCH
 * transaction, and it holds no lock across a remote call.
 */
export const produceMergeAuthorization = async (
  tx: Tx,
  input: {
    card: { id: string; body: string; gateTaskId: string | null };
    inboxDecisionId: string;
    channel: DecisionChannel;
  },
  now = new Date(),
): Promise<MergeAuthorizationResult | null> => {
  const gateTaskId = input.card.gateTaskId;
  if (!gateTaskId) return null;
  const gateTask = await tx.task.findUnique({
    where: { id: gateTaskId },
    select: { id: true, projectId: true, chainId: true, chainIndex: true },
  });
  if (!gateTask) return null;
  const integrator = await gateFeedsIntegratorStep(tx, gateTask);
  // Not an integrator gate: an ordinary approval without a mechanical successor, untouched.
  if (!integrator) return null;

  const block = parseEvidence(input.card.body);
  if (block.status === "absent") {
    throw new MergeEvidenceError("Merge evidence has not been read yet; wait for the card to fill before approving");
  }
  if (block.status === "unavailable") {
    throw new MergeEvidenceError("Merge evidence could not be read; re-request evidence before approving");
  }
  if (block.status === "unparseable") {
    throw new MergeEvidenceError(`Merge evidence block is malformed (${block.reason}); approval refused`);
  }

  const request = await findEvidenceRequestByNonce(tx, gateTaskId, block.evidence.nonce);
  const purpose = request?.purpose ?? "gate";
  const payload: AuthorizationPayload = {
    ...block.evidence,
    issuedAt: now.toISOString(),
    decision: { channel: input.channel, inboxDecisionId: input.inboxDecisionId, inboxMessageId: input.card.id },
  };
  // The evidence block says what the head *is*; it says nothing about whether the
  // merge gate ever signed it. Without this the Inbox and PATCH channels could
  // authorize a merge at a commit no gate ran against — the mechanical channel
  // reads the Regression verdict, these two never did.
  const attested = await requireGateAttestation(tx, {
    chainId: gateTask.chainId,
    headSha: payload.headSha,
  });
  if (!attested.satisfied) {
    throw new MergeEvidenceError(`${attested.reason}; approval refused`);
  }

  const activity = await tx.taskActivity.create({ data: {
    taskId: gateTaskId,
    actorType: "operator",
    body: `Merge authorized for PR #${payload.prNumber} at ${payload.headSha} onto ${payload.baseRef} (${payload.baseSha})`,
    metadata: authorizationMetadata(payload) as Prisma.InputJsonObject,
  } });

  if (purpose === "confirmation") {
    // A renewal. The successor is already active, so activateChainSuccessor
    // would produce a run at the original ceiling that runner.ts then refuses
    // at claim. This is the only writer of a ceiling above the task's original.
    const opened = await openRun(tx, integrator.id, { kind: "integrator-authorized", readyAt: now });
    if (!opened.ok) throw errorForOpenRunRefusal(opened.refusal);
    await tx.task.updateMany({
      where: { id: integrator.id, status: { in: [TaskStatus.REVIEW, TaskStatus.TODO, TaskStatus.DOING] } },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    await tx.taskActivity.create({ data: {
      taskId: integrator.id,
      actorType: "control-plane",
      body: "Renewed authorization approved; mechanical merge run queued",
      metadata: {
        kind: MERGE_INTEGRATOR_KIND.evidenceRequest,
        schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
        resolved: true,
        authorizationActivityId: activity.id,
      },
    } });
  }
  return { activityId: activity.id, purpose, payload };
};

export type InboxDecisionInput = {
  inboxMessageId: string;
  externalEventId: string;
  decision: string;
  actorOpenId?: string | null;
  externalMessageId?: string | null;
  allowFreeText?: boolean;
};

export type InboxDecisionResult = {
  duplicate: boolean;
  resumed: boolean;
  gateAction?: "approved" | "rejected";
  messageId?: string;
};

/** Shared transaction body for Feishu and Web decisions. OPEN is the cross-channel compare-and-set. */
export const applyInboxDecisionTx = async (
  tx: Tx,
  input: InboxDecisionInput,
  now = new Date(),
): Promise<InboxDecisionResult> => {
  const question = await tx.inboxMessage.findUnique({
    where: { id: input.inboxMessageId },
    include: {
      session: { include: { run: true } },
      gateTask: {
        include: {
          templateStep: { select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } } },
        },
      },
      thread: true,
    },
  });
  if (!question?.session?.run) {
    throw new WorkflowRefusalError("inbox-question-not-found", "No matching Inbox question");
  }
  const gateDecision = Boolean(question.gateTaskId);
  if (gateDecision && input.decision !== "approve" && input.decision !== "reject") {
    throw new WorkflowRefusalError(
      "approval-gate-decision-invalid",
      "Approval gate decision must be approve or reject",
    );
  }
  if (!gateDecision && question.kind === InboxKind.MULTIPLE_CHOICE && !input.allowFreeText) {
    const choices = Array.isArray(question.choices) ? question.choices : [];
    const matchesChoice = choices.some((choice) => (
      typeof choice === "object" && choice !== null && "id" in choice && choice.id === input.decision
    ));
    if (!matchesChoice) {
      throw new WorkflowRefusalError("inbox-choice-mismatch", "Decision must match an Inbox choice id");
    }
  }
  // §D-P7. A stop question is answered long after its run ended, so it cannot
  // travel the WAITING_INBOX path — and it is not a gate card either, because a
  // gate card would trip the gate CAS at PATCH time. It is its own thing, bound
  // to the stop it answers by a server-written dedupeKey.
  const stopBinding = gateDecision ? null : parseStopQuestionKey(question.dedupeKey);
  if (!gateDecision && !stopBinding && question.session.run.status !== RunStatus.WAITING_INBOX) {
    throw new WorkflowRefusalError("inbox-run-not-waiting", "No matching waiting Inbox question");
  }
  if (stopBinding) {
    const claimedStop = await tx.inboxMessage.updateMany({
      where: { id: question.id, status: InboxStatus.OPEN },
      data: { status: InboxStatus.ANSWERED, selectedChoiceId: input.decision, answeredAt: now },
    });
    if (claimedStop.count !== 1) {
      // A replay is the supported repair for the legacy state where the first
      // transaction durably recorded refresh-requested but returned without a
      // confirmation card. Re-read the append-only disposition under the
      // integrator Task mutex; every other duplicate remains a no-op.
      if (question.status === InboxStatus.ANSWERED && question.selectedChoiceId === input.decision && question.taskId) {
        await recoverRefreshRequestedConfirmationCard(tx, question.taskId, now);
      }
      return { duplicate: true, resumed: false };
    }
    await tx.inboxMessage.create({ data: {
      from: InboxSender.HUMAN,
      agentId: question.agentId,
      sessionId: question.sessionId,
      taskId: question.taskId,
      threadId: question.threadId,
      replyToMessageId: question.id,
      kind: "TEXT",
      body: input.decision,
      selectedChoiceId: input.decision,
      status: InboxStatus.CLOSED,
      dedupeKey: `decision:${input.externalEventId}:reply`,
      externalMessageId: input.externalMessageId ?? null,
      deliveryStatus: InboxDeliveryStatus.DELIVERED,
      deliveredAt: now,
    } });
    await tx.inboxDecision.create({ data: {
      inboxMessageId: question.id,
      runId: question.session.run.id,
      externalEventId: input.externalEventId,
      decision: input.decision,
      actorOpenId: input.actorOpenId ?? null,
    } });
    await applyStopAnswer(tx, {
      question: {
        id: question.id, taskId: question.taskId, dedupeKey: question.dedupeKey,
        agentId: question.agentId, sessionId: question.sessionId,
      },
      choice: input.decision,
      now,
    });
    return { duplicate: false, resumed: false, messageId: question.id };
  }
  // A HUMAN gate or server-owned readiness rejection can queue the executable
  // predecessor. Ordinary AGENT gates remain executable themselves. A chained
  // decision takes the complete chain mutex before any Task-row mutation; this
  // is the same order used by completion and manual start/retry.
  let rejectionTarget: { id: string; name: string } | null = null;
  if (gateDecision && question.gateTask?.chainId) {
    await lockChainRows(tx, {
      projectId: question.gateTask.projectId,
      chainId: question.gateTask.chainId,
    });
  }
  if (gateDecision && question.gateTask && input.decision === "reject") {
    const readiness = isMergeReadinessStep(question.gateTask.templateStep);
    rejectionTarget = question.gateTask.assigneeType === AssigneeType.AGENT && !readiness
      ? question.gateTask
      : question.gateTask.chainId && question.gateTask.chainLayer !== null
        ? await tx.task.findFirst({
          where: {
            projectId: question.gateTask.projectId,
            chainId: question.gateTask.chainId,
            chainLayer: { lt: question.gateTask.chainLayer },
            assigneeType: AssigneeType.AGENT,
            assigneeAgentId: { not: null },
            repoId: { not: null },
          },
          orderBy: [{ chainLayer: "desc" }, { chainIndex: "desc" }, { id: "desc" }],
        })
        : null;
    if (!rejectionTarget && question.gateTask.chainId && question.gateTask.chainIndex !== null) {
      rejectionTarget = await tx.task.findFirst({
        where: {
          projectId: question.gateTask.projectId,
          chainId: question.gateTask.chainId,
          chainIndex: { lt: question.gateTask.chainIndex },
          assigneeType: AssigneeType.AGENT,
          assigneeAgentId: { not: null },
          repoId: { not: null },
        },
        orderBy: { chainIndex: "desc" },
      });
    }
    if (!rejectionTarget) {
      throw new WorkflowRefusalError(
        "approval-gate-rejection-target-missing",
        "Approval gate has no executable previous task to reject to",
      );
    }
  }
  const lockedRejectionTarget = rejectionTarget && rejectionTarget.id !== question.gateTaskId
    ? await lockTaskRow(tx, rejectionTarget.id)
    : null;
  // PATCH DONE takes the gate Task mutex before closing OPEN cards. Take the
  // same mutex before this path's OPEN claim so PATCH and Inbox decisions have
  // one winner instead of both advancing the chain.
  const lockedGateTask = gateDecision && question.gateTask
    ? await lockTaskRow(tx, question.gateTask.id)
    : null;
  const claimed = await tx.inboxMessage.updateMany({
    where: { id: question.id, status: InboxStatus.OPEN },
    data: { status: InboxStatus.ANSWERED, selectedChoiceId: input.decision, answeredAt: now },
  });
  if (claimed.count !== 1) return { duplicate: true, resumed: false };
  if (gateDecision) {
    // gateTaskId, not an individual card id, is the decision identity. Old or
    // duplicated cards are allowed by the schema, so the winning card consumes
    // every sibling OPEN state while the gate Task mutex is held. A later click
    // on any sibling then loses the selected-card OPEN claim above.
    await tx.inboxMessage.updateMany({
      where: { gateTaskId: question.gateTaskId, status: InboxStatus.OPEN, id: { not: question.id } },
      data: { status: InboxStatus.CLOSED },
    });
  }
  const reply = await tx.inboxMessage.create({ data: {
    from: InboxSender.HUMAN,
    agentId: question.agentId,
    sessionId: question.sessionId,
    taskId: question.taskId,
    goalId: question.goalId,
    threadId: question.threadId,
    replyToMessageId: question.id,
    kind: "TEXT",
    body: input.decision,
    selectedChoiceId: input.decision,
    status: InboxStatus.CLOSED,
    dedupeKey: `decision:${input.externalEventId}:reply`,
    externalMessageId: input.externalMessageId ?? null,
    deliveryStatus: InboxDeliveryStatus.DELIVERED,
    deliveredAt: now,
  } });
  const decisionRow = await tx.inboxDecision.create({ data: {
    inboxMessageId: question.id,
    runId: question.session.run.id,
    externalEventId: input.externalEventId,
    decision: input.decision,
    actorOpenId: input.actorOpenId ?? null,
  } });

  if (gateDecision && question.gateTask) {
    if (input.decision === "approve") {
      await tx.task.update({ where: { id: question.gateTask.id }, data: { status: TaskStatus.DONE, failureReason: null } });
      await tx.taskActivity.create({ data: { taskId: question.gateTask.id, actorType: "operator", body: "Approval gate approved" } });
      // §D-P3 Phase C, in the same transaction as the decision row it binds to.
      // A refusal here throws and rolls the whole approval back.
      const authorization = await produceMergeAuthorization(tx, {
        card: { id: question.id, body: question.body, gateTaskId: question.gateTaskId },
        inboxDecisionId: decisionRow.id,
        channel: "inbox",
      }, now);
      // A confirmation card's run is created by produceMergeAuthorization at the
      // raised ceiling; activating the successor again would enqueue a second
      // run at the original one.
      if (authorization?.purpose !== "confirmation") {
        await activateChainSuccessor(tx, question.gateTask, {
          sourceRunId: question.session.run.id,
          chatId: question.thread?.externalChatId ?? null,
          archivedAssignee: "throw",
        }, now);
      }
      return { duplicate: false, resumed: false, gateAction: "approved", messageId: reply.id };
    }
    // Refusing by throwing rolls the whole transaction back, which leaves the
    // decision OPEN — the human unarchives the step and decides again, instead
    // of the gate silently closing onto a run the runner will never claim.
    const redo = rejectionTarget!;
    const lockedRedo = redo.id === question.gateTask.id
      ? lockedGateTask
      : lockedRejectionTarget;
    if (lockedRedo?.archivedAt) {
      throw new ArchivedTaskError(redo.id, redo.name);
    }
    await tx.task.update({ where: { id: redo.id }, data: { status: TaskStatus.TODO, failureReason: null } });
    if (redo.id !== question.gateTask.id) {
      await tx.task.update({ where: { id: question.gateTask.id }, data: { status: TaskStatus.TODO } });
    }
    await tx.taskActivity.create({ data: { taskId: redo.id, actorType: "operator", body: "Approval gate rejected; step queued again" } });
    await enqueueTaskRun(tx, redo.id, now);
    return { duplicate: false, resumed: false, gateAction: "rejected", messageId: reply.id };
  }

  const queued = await tx.run.updateMany({
    where: { id: question.session.run.id, status: RunStatus.WAITING_INBOX },
    data: { status: RunStatus.QUEUED, readyAt: now, runnerId: null, fencingToken: null, leaseExpiresAt: null },
  });
  if (queued.count !== 1) {
    throw new WorkflowRefusalError("conflict", "Waiting Run changed while applying Inbox decision");
  }
  await tx.session.update({ where: { id: question.session.id }, data: {
    executionStatus: SessionExecutionStatus.REQUESTED,
    waitingOnMessageId: null,
    resumeInput: input.decision,
    resumeAttempt: { increment: 1 },
  } });
  return { duplicate: false, resumed: true, messageId: reply.id };
};

export const applyInboxDecision = async (
  db: PrismaClient,
  input: InboxDecisionInput,
  now = new Date(),
): Promise<InboxDecisionResult> => db.$transaction(
  (tx) => applyInboxDecisionTx(tx, input, now),
  // PostgreSQL re-checks the OPEN predicate after a concurrent row lock is
  // released, so the loser observes count=0 instead of a serialization error.
  { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
);
