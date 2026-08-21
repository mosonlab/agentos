import { createHash } from "node:crypto";

import {
  AssigneeType,
  InboxDeliveryStatus,
  InboxKind,
  InboxSender,
  InboxStatus,
  Prisma,
  RunStatus,
  RunnerKind,
  RunnerPreference,
  SessionExecutionStatus,
  TaskStatus,
  type PrismaClient,
} from "@prisma/client";

import { sharedChainBranch } from "./chain-branch.js";
import {
  MERGE_INTEGRATOR_KIND,
  MERGE_INTEGRATOR_SCHEMA_VERSION,
  type AuthorizationPayload,
  type DecisionChannel,
  authorizationMetadata,
  parseEvidence,
} from "./merge-integrator.js";
import {
  applyStopAnswer,
  createAuthorizedIntegratorRun,
  assertIntegratorBinding,
  findEvidenceRequestByNonce,
  gateFeedsIntegratorStep,
  parseStopQuestionKey,
  requestMergeEvidence,
  resolveChainTarget,
  stopStateFor,
} from "./merge-integrator-db.js";

type Tx = Prisma.TransactionClient;

const promptHash = (parts: string[]): string => createHash("sha256").update(parts.join("\n")).digest("hex");

export const runnerFor = (preference: RunnerPreference, model: string): RunnerKind => {
  if (preference === RunnerPreference.CLAUDE) return RunnerKind.CLAUDE;
  if (preference === RunnerPreference.CODEX) return RunnerKind.CODEX;
  if (preference === RunnerPreference.PI) return RunnerKind.PI;
  const normalized = model.toLowerCase();
  if (normalized.includes("codex")) return RunnerKind.CODEX;
  if (normalized.includes("deepseek") || normalized.split(/[\/:_-]+/u).includes("pi")) return RunnerKind.PI;
  return RunnerKind.CLAUDE;
};

export const deriveRunConfig = (
  agent: {
    runnerPreference: RunnerPreference;
    model: string;
    foundationalPrompt: string;
    rolePrompt: string;
  },
  templateStep: { runner: RunnerKind | null } | null,
  task: { name: string; description: string },
): { runner: RunnerKind; model: string; promptHash: string } => ({
  runner: templateStep?.runner ?? runnerFor(agent.runnerPreference, agent.model),
  model: agent.model,
  promptHash: promptHash([
    agent.foundationalPrompt,
    agent.rolePrompt,
    task.name,
    task.description,
  ]),
});

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
    select: { commitSha: true, run: { select: { baseSha: true } } },
  });
  if (!source?.commitSha) {
    throw new PinnedBaseCommitError(task.id, baseFromStepIndex, "referenced step has no recorded commitSha");
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(source.commitSha)) {
    throw new PinnedBaseCommitError(task.id, baseFromStepIndex, `referenced step has invalid commitSha ${source.commitSha}`);
  }
  if (!source.run?.baseSha) {
    throw new PinnedBaseCommitError(task.id, baseFromStepIndex, "referenced step has no recorded implementation baseSha");
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(source.run.baseSha)) {
    throw new PinnedBaseCommitError(task.id, baseFromStepIndex, `referenced step has invalid implementation baseSha ${source.run.baseSha}`);
  }
  return { implementationBaseSha: source.run.baseSha, implementationHeadSha: source.commitSha };
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
): Promise<{ id: string; archivedAt: Date | null } | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string; archivedAt: Date | null }>>`
    SELECT "id", "archivedAt" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE
  `;
  return rows[0] ?? null;
};

/** The same mutex for a whole step list, in one statement. `ORDER BY "id"` is
 *  not decoration: it is what stops two concurrent instantiations of templates
 *  that share agents from deadlocking against each other. */
export const lockAgentRows = async (
  tx: Tx,
  agentIds: string[],
): Promise<Map<string, Date | null>> => {
  const unique = [...new Set(agentIds)];
  if (unique.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ id: string; archivedAt: Date | null }>>`
    SELECT "id", "archivedAt" FROM "Agent"
    WHERE "id" = ANY(${unique})
    ORDER BY "id" FOR UPDATE
  `;
  return new Map(rows.map((row) => [row.id, row.archivedAt]));
};

/** Locks an indexed chain prefix in the one global order used by manual start,
 * manual completion, and automatic advancement. Raw SQL returns ids only;
 * callers perform typed Prisma reads after this serialization point. */
export const lockChainPrefixRows = async (
  tx: Tx,
  input: { projectId: string; chainId: string; targetChainIndex: number },
): Promise<string[]> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task"
    WHERE "projectId" = ${input.projectId}
      AND "chainId" = ${input.chainId}
      AND "chainIndex" IS NOT NULL
      AND "chainIndex" <= ${input.targetChainIndex}
    ORDER BY "chainIndex", "id" FOR UPDATE
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
 *  type, so the five call sites can pass rows from five differently-shaped
 *  queries — the same reason `packages/api/src/chain.ts` keeps `ChainRow` plain. */
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
  // No prior run at all: this is the pre-existing `prior?.branch ?? ...` answer
  // for a first run, and skipping both queries keeps that path untouched.
  if (!prior || !task.repoId) return null;
  // Template steps of one chain share a branch, so the ref this retry wants may
  // have been published by a *sibling* step. Everything else owns its branch —
  // and a chainIndex-null row must stay isolated from indexed siblings carrying
  // the same chainId (see resolveRunBranches) — so it asks about itself only.
  const scope = task.templateId && task.chainId
    ? { projectId: task.projectId, chainId: task.chainId }
    : { id: task.id };
  // Scoped by repo: the same branch name on two remotes is two unrelated refs.
  const published = prior.branch
    ? await tx.run.findFirst({
      where: { pushedBranch: prior.branch, repoId: task.repoId, task: scope },
      select: { id: true },
    })
    : null;
  if (published && prior.branch) return prior.branch;
  // The workspace branch was never published, but a failed run's WIP salvage
  // push (`agentos/<taskId>/run-<n>`, delivery.ts) may still hold this task's
  // work. Basing on the newest one is how the retry keeps the progress that did
  // reach the remote instead of silently restarting from the default branch.
  const salvaged = await tx.run.findFirst({
    where: { taskId: task.id, repoId: task.repoId, pushedBranch: { not: null } },
    orderBy: { runNumber: "desc" },
    select: { pushedBranch: true },
  });
  return salvaged?.pushedBranch ?? null;
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
 * Decides a new Run's head (`branch`) and base (`targetBranch`). The only place
 * that decision is made; `enqueueTaskRun`, `POST /tasks`, the operator retry
 * route, the automatic retry in the completion transaction and the lost-lease
 * requeue all call this, because five copies of the expression is how step ①
 * ended up on a different branch from steps ②–⑨.
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
      branch: prior?.branch ?? chainBranch,
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
      branch: prior?.branch ?? chainBranch,
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
  // "Has any step of this chain actually published the shared branch *on this
  // repo*?"
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
  const published = task.repoId
    ? await tx.run.findFirst({
      where: {
        pushedBranch: shared,
        repoId: task.repoId,
        task: { projectId: task.projectId, chainId: task.chainId, chainIndex: { not: null } },
      },
      select: { id: true },
    })
    : null;
  // `prior?.branch` is deliberately not consulted here. Post-change it is always
  // `shared`, so it would give the same answer; pre-change (a chain that spans
  // the restart) it is a per-task branch, and honouring it would quietly keep a
  // mixed chain mixed instead of falling through to the operator's targetBranch,
  // which the rollback runbook names as the manual repair lever.
  const targetBranch = published
    ? shared
    : task.targetBranch ?? task.repo.defaultBranch;

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

export const enqueueTaskRun = async (tx: Tx, taskId: string, now = new Date()) => {
  const task = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
    include: {
      assigneeAgent: true,
      repo: true,
      templateStep: true,
      runs: { orderBy: { runNumber: "desc" }, take: 1 },
    },
  });
  if (task.assigneeType !== AssigneeType.AGENT || !task.assigneeAgent || !task.repo) {
    throw new Error(`Task ${task.id} cannot be queued without an agent and repo`);
  }
  // Checked before the assignee, because an archived task is archived whoever
  // it is assigned to. The runner claims only `TODO|DOING` and unarchived tasks,
  // so a run queued here would never be claimed and never complete.
  if (task.archivedAt) {
    throw new ArchivedTaskError(task.id, task.name);
  }
  // §D-P7, the last line of the exclusivity guard. This function is the single
  // place a Run comes into existence outside the two inline creates and the
  // answer transaction, so a route added later inherits the refusal by
  // construction rather than by remembering to ask.
  const stopped = await stopStateFor(tx, task.id);
  if (stopped) throw new IntegratorStoppedError(task.id, stopped.stop.condition);
  // §D-P4, the last line of the binding invariant, for the same reason: this is
  // the shared enqueue path, so a route added later inherits the refusal.
  await assertIntegratorBinding(tx, {
    assigneeAgentName: task.assigneeAgent.name,
    templateStepId: task.templateStepId,
  });
  // The assignee is re-read under the shared Agent-row mutex, not trusted from
  // the relation above: this function is the single place a Run comes into
  // existence, so an archive committing in parallel has to lose here or be
  // refused for the run this call is about to create. A row that vanished
  // falls back to the relation; the foreign key decides that case.
  const lockedAgent = await lockAgentRow(tx, task.assigneeAgent.id);
  if (lockedAgent?.archivedAt ?? task.assigneeAgent.archivedAt) {
    throw new ArchivedAssigneeError(task.id, task.name, task.assigneeAgent.name);
  }
  const prior = task.runs[0];
  const runNumber = (prior?.runNumber ?? 0) + 1;
  const derived = deriveRunConfig(task.assigneeAgent, task.templateStep, task);
  const branches = await resolveRunBranches(tx, { ...task, repo: task.repo }, prior ?? null);
  return tx.run.create({ data: {
    projectId: task.projectId,
    taskId: task.id,
    agentId: task.assigneeAgent.id,
    repoId: task.repo.id,
    runNumber,
    dedupeKey: `task:${task.id}:run:${runNumber}`,
    runner: derived.runner,
    model: derived.model,
    targetBranch: branches.targetBranch,
    branch: branches.branch,
    opensPullRequest: task.opensPullRequest,
    promptHash: derived.promptHash,
    maxDurationMin: task.maxDurationMin,
    stallTimeoutMin: task.stallTimeoutMin,
    // The configured budget plus the grants already earned, not the budget
    // alone. This is the fifth run-creating path (chain successors, template
    // steps, schedules, approval rejections) and it used to reset
    // `maxRunsPerTask` to the task's raw budget, throwing away every refund an
    // external failure had bought — issue #113. A task whose provisioning
    // failures had lifted the ceiling to 7 and reached run 6 would be handed
    // `runNumber: 7, maxRunsPerTask: 5` and the runner's own boot gate
    // (`runNumber > maxRunsPerTask`) would refuse it: a run nothing could ever
    // claim. Recomputing from `maxSessionsPerTask` each time, rather than
    // carrying the prior absolute ceiling forward, is what lets an operator
    // lower a task's budget and have it take effect.
    maxRunsPerTask: task.maxSessionsPerTask + (prior?.budgetGrants ?? 0),
    budgetGrants: prior?.budgetGrants ?? 0,
    readyAt: now,
  } });
};

const GATE_OUTPUT_PREVIEW = 1_000;

const outputPreview = async (tx: Tx, taskId: string | null): Promise<string> => {
  if (!taskId) return "";
  const output = await tx.taskStepOutput.findUnique({ where: { taskId }, select: { kind: true, body: true } });
  if (!output) return "";
  const body = output.body.trim();
  const shown = body.length > GATE_OUTPUT_PREVIEW ? `${body.slice(0, GATE_OUTPUT_PREVIEW)}\n…（已截断，完整产物见 Tasks 页）` : body;
  return `\n\n产物（${output.kind}）：\n${shown}`;
};

export const gateQuestion = async (tx: Tx, gateTaskId: string, sourceRunId: string, chatId: string | null) => {
  const [task, run] = await Promise.all([
    tx.task.findUniqueOrThrow({ where: { id: gateTaskId } }),
    tx.run.findUniqueOrThrow({ where: { id: sourceRunId }, include: { session: true } }),
  ]);
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
  followUpTaskId: string | null;
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

/**
 * Why this successor must not be claimed, or null if it may be.
 *
 * The CAS below only matches TODO/DOING/REVIEW. A successor outside that set
 * and not DONE — archived, or parked in BACKLOG — makes `updateMany` match zero
 * rows forever while the re-read keeps returning the same row, so the loop spins
 * inside the caller's transaction and run completion never returns. Returning
 * early is what makes Backlog a place a chain step can sit.
 */
const parkedReason = (successor: { status: TaskStatus; archivedAt?: Date | null }): string | null => {
  if (successor.archivedAt) return "successor is archived and was not queued";
  if (successor.status === TaskStatus.BACKLOG) return "successor is parked in Backlog — use Start now";
  return null;
};

/** Activates at most one chain/follow-up successor using the observed updatedAt as a CAS token. */
export const activateChainSuccessor = async (
  tx: Tx,
  task: ChainTask,
  options: { sourceRunId?: string | null; chatId?: string | null; archivedAssignee?: "park" | "throw" } = {},
  now = new Date(),
): Promise<{ nextTaskId: string | null; gated: boolean }> => {
  let successor: ChainSuccessor | null = null;
  if (task.chainId && task.chainIndex !== null) {
    // Resolve, lock, and re-read until the first surviving non-DONE row is
    // stable. A concurrent DELETE can win before the lock, and historical
    // out-of-order execution can leave DONE gaps; neither may stall the chain.
    for (;;) {
      const candidate = await tx.task.findFirst({
        where: {
          projectId: task.projectId,
          chainId: task.chainId,
          chainIndex: { gt: task.chainIndex },
          status: { not: TaskStatus.DONE },
        },
        orderBy: [{ chainIndex: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (!candidate) break;
      if (!await lockTaskRow(tx, candidate.id)) continue;
      const current: ChainSuccessor | null = await tx.task.findUnique({
        where: { id: candidate.id },
        include: { runs: { where: { status: { in: ACTIVE_RUN_STATUSES } }, orderBy: { runNumber: "desc" }, take: 1 }, assigneeAgent: true },
      });
      if (!current || current.status === TaskStatus.DONE) continue;
      successor = current;
      break;
    }
  } else {
    if (task.chainId) {
      await tx.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: "Chain row missing chainIndex; auto-advance skipped",
      } });
    }
    if (task.followUpTaskId) {
      if (await lockTaskRow(tx, task.followUpTaskId)) {
        successor = await tx.task.findUnique({
          where: { id: task.followUpTaskId },
          include: { runs: { where: { status: { in: ACTIVE_RUN_STATUSES } }, orderBy: { runNumber: "desc" }, take: 1 }, assigneeAgent: true },
        });
      }
    }
  }

  if (!successor) {
    if (task.chainId && task.chainIndex !== null) {
      await tx.taskActivity.create({ data: {
        taskId: task.id,
        actorType: "control-plane",
        body: "Chain complete",
      } });
    }
    return { nextTaskId: null, gated: false };
  }

  if (successor.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: "Predecessor completed; successor already active",
    } });
    return { nextTaskId: successor.id, gated: false };
  }

  const parked = parkedReason(successor);
  if (parked) {
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: `Predecessor ${task.name} completed; ${parked}`,
    } });
    return { nextTaskId: successor.id, gated: false };
  }

  // A lost updatedAt CAS can mean either another advancer won or an unrelated
  // operator edit landed between the read and claim. Re-read and retry the
  // latter instead of silently stalling the chain. The status predicate is a
  // second idempotency boundary: a completed successor is never resurrected.
  for (;;) {
    const claimed = await tx.task.updateMany({
      where: {
        id: successor.id,
        updatedAt: successor.updatedAt,
        status: { in: [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] },
      },
      data: { status: TaskStatus.TODO },
    });
    if (claimed.count === 1) break;
    const current: ChainSuccessor | null = await tx.task.findUnique({
      where: { id: successor.id },
      include: { runs: { where: { status: { in: ACTIVE_RUN_STATUSES } }, orderBy: { runNumber: "desc" }, take: 1 }, assigneeAgent: true },
    });
    if (!current || current.status === TaskStatus.DONE) {
      // A chain row that disappeared or became DONE is no longer the candidate.
      // Re-entering the function resolves the next surviving non-DONE row.
      if (task.chainId && task.chainIndex !== null) {
        return activateChainSuccessor(tx, task, options, now);
      }
      return { nextTaskId: current?.id ?? null, gated: false };
    }
    if (current.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
      await tx.taskActivity.create({ data: {
        taskId: current.id,
        actorType: "control-plane",
        body: "Predecessor completed; successor already active",
      } });
      return { nextTaskId: current.id, gated: false };
    }
    // The same guard as above, because the operator can park the successor
    // *between* the read and the claim. Without this branch the loop re-enters
    // with a parked row, the CAS keeps matching zero rows, and it spins forever
    // inside the caller's transaction.
    const parkedNow = parkedReason(current);
    if (parkedNow) {
      await tx.taskActivity.create({ data: {
        taskId: current.id,
        actorType: "control-plane",
        body: `Predecessor ${task.name} completed; ${parkedNow}`,
      } });
      return { nextTaskId: current.id, gated: false };
    }
    successor = current;
  }

  if (successor.assigneeType !== AssigneeType.AGENT || !successor.assigneeAgentId || !successor.repoId) {
    if (options.sourceRunId) {
      await tx.task.update({ where: { id: successor.id }, data: { status: TaskStatus.REVIEW } });
      await gateQuestion(tx, successor.id, options.sourceRunId, options.chatId ?? null);
      return { nextTaskId: successor.id, gated: true };
    }
    await tx.taskActivity.create({ data: {
      taskId: successor.id,
      actorType: "control-plane",
      body: "Predecessor completed; successor awaits operator",
    } });
    return { nextTaskId: successor.id, gated: false };
  }

  // An archived assignee parks the successor instead of throwing. enqueueTaskRun
  // raises ArchivedAssigneeError, which is not a P2002 and would escape the
  // savepoint catch below and roll back the caller's whole transaction — for
  // completeRun that means discarding a run that actually succeeded.
  //
  // Interactive callers pass archivedAssignee: "throw" instead: a human is
  // waiting on the response, so they get a named 409 rather than a silent park
  // they would have to go hunting for.
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
    await tx.taskActivity.create({
      data: {
        taskId: successor.id,
        actorType: "control-plane",
        body: `Predecessor ${task.name} completed but assignee ${successor.assigneeAgent.name} is archived; step not queued`,
      },
    });
    return { nextTaskId: successor.id, gated: false };
  }

  const rawTx = tx as Tx & { $executeRawUnsafe?: (query: string) => Promise<number> };
  const hasSavepoint = typeof rawTx.$executeRawUnsafe === "function";
  if (hasSavepoint) await rawTx.$executeRawUnsafe!("SAVEPOINT chain_successor_enqueue");
  try {
    await enqueueTaskRun(tx, successor.id, now);
    if (hasSavepoint) await rawTx.$executeRawUnsafe!("RELEASE SAVEPOINT chain_successor_enqueue");
  } catch (error: unknown) {
    if (!isUniqueConflict(error)) throw error;
    if (hasSavepoint) {
      await rawTx.$executeRawUnsafe!("ROLLBACK TO SAVEPOINT chain_successor_enqueue");
      await rawTx.$executeRawUnsafe!("RELEASE SAVEPOINT chain_successor_enqueue");
    }
    return { nextTaskId: successor.id, gated: false };
  }
  await tx.taskActivity.create({ data: {
    taskId: successor.id,
    actorType: "control-plane",
    body: `Predecessor ${task.name} completed; step queued`,
  } });
  return { nextTaskId: successor.id, gated: false };
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
  if (task.approvalGate) {
    if (expectedStatus) {
      const claimed = await tx.task.updateMany({ where: { id: task.id, status: expectedStatus }, data: { status: TaskStatus.REVIEW } });
      if (claimed.count !== 1) return { gated: false, nextTaskId: null };
    } else {
      await tx.task.update({ where: { id: task.id }, data: { status: TaskStatus.REVIEW } });
    }
    await gateQuestion(tx, task.id, sourceRunId, chatId);
    return { gated: true, nextTaskId: task.followUpTaskId };
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
    await createAuthorizedIntegratorRun(tx, integrator.id, now);
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
      gateTask: { include: { previousTask: true } },
      thread: true,
    },
  });
  if (!question?.session?.run) throw new Error("No matching Inbox question");
  const gateDecision = Boolean(question.gateTaskId);
  if (gateDecision && input.decision !== "approve" && input.decision !== "reject") {
    throw new Error("Approval gate decision must be approve or reject");
  }
  if (!gateDecision && question.kind === InboxKind.MULTIPLE_CHOICE && !input.allowFreeText) {
    const choices = Array.isArray(question.choices) ? question.choices : [];
    const matchesChoice = choices.some((choice) => (
      typeof choice === "object" && choice !== null && "id" in choice && choice.id === input.decision
    ));
    if (!matchesChoice) throw new Error("Decision must match an Inbox choice id");
  }
  // §D-P7. A stop question is answered long after its run ended, so it cannot
  // travel the WAITING_INBOX path — and it is not a gate card either, because a
  // gate card would trip the gate CAS at PATCH time. It is its own thing, bound
  // to the stop it answers by a server-written dedupeKey.
  const stopBinding = gateDecision ? null : parseStopQuestionKey(question.dedupeKey);
  if (!gateDecision && !stopBinding && question.session.run.status !== RunStatus.WAITING_INBOX) {
    throw new Error("No matching waiting Inbox question");
  }
  if (stopBinding) {
    const claimedStop = await tx.inboxMessage.updateMany({
      where: { id: question.id, status: InboxStatus.OPEN },
      data: { status: InboxStatus.ANSWERED, selectedChoiceId: input.decision, answeredAt: now },
    });
    if (claimedStop.count !== 1) return { duplicate: true, resumed: false };
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
  // A HUMAN-gate rejection can queue the executable predecessor. Resolve that
  // target before taking either mutex, then lock predecessor -> gate: PATCH on
  // the predecessor takes that same order when it activates the HUMAN
  // successor. Taking gate -> predecessor here would make the two legitimate
  // operations deadlock.
  let rejectionTarget: { id: string; name: string } | null = null;
  if (gateDecision && question.gateTask && input.decision === "reject") {
    rejectionTarget = question.gateTask.assigneeType === AssigneeType.AGENT
      ? question.gateTask
      : question.gateTask.previousTask;
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
    if (!rejectionTarget) throw new Error("Approval gate has no executable previous task to reject to");
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
  if (queued.count !== 1) throw new Error("Waiting Run changed while applying Inbox decision");
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
