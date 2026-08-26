import {
  activateChainSuccessor,
  type ClaimantClass,
  AUTHORITY_RESIGN_OPEN_PREFIX,
  ACTIVE_RUN_STATUSES,
  advanceTemplateTask,
  enqueueTaskRun,
  executionModeFor,
  FAILURE_ENVELOPE_VERSION,
  FailureClass,
  failurePhases,
  gateQuestion,
  isArchivedAssigneeError,
  isArchivedTaskError,
  isIntegratorStoppedError,
  INDEPENDENT_REVIEW_OPEN_PREFIX,
  INTEGRATOR_TEMPLATE_NAME,
  isIntegratorStep,
  isMergeReadinessStep,
  isRegressionVerificationOutputKind,
  latestMarker,
  LEGACY_PRE_ADJUDICATION_TEMPLATE_PREFIX,
  LEGACY_PRE_ZERO_GATE_TEMPLATE_PREFIX,
  lockChainRows,
  lockRunRow,
  MAX_BLOCKING_REVIEW_ROUNDS,
  MERGE_TAIL_KIND,
  mechanicalPrincipalRefusal,
  openReviewObligation,
  parseIndependentReviewDecision,
  parseMergeResult,
  parseResolverResult,
  Prisma,
  type PrismaClient,
  readMarkerHistory,
  readMarkers,
  recordIntegratorStop,
  resolveRequeueBase,
  resolveRunBranches,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
  writeMarker,
} from "@agentos/db";
import { z } from "zod";

import type { CompletionInput } from "./app.js";
import {
  canonicalOutputRefusal,
  isCanonicalAgentStep,
  outputIsImmutableOncePersisted,
  requiredOutputKind,
} from "./canonical-task-output.js";
import {
  classifyEnvelope,
  completionSucceeded,
  externalFailure,
  failureIsRetryable,
  jsonValue,
  makeDedupeKey,
  retryDelayMs,
} from "./execution.js";
import { FAILURE_REASON_LIMIT, truncateFailureReason } from "./failure-reason.js";
import {
  baseDriftRecoveryContext,
  createMergeTailRepairTask,
  createReviewFollowUpCard,
  handleRegressionCompletion,
  mergeTailFixAgentName,
  openMergeTailStopNotice,
  stopBaseDriftRecoveryTail,
} from "./merge-tail-actions.js";
import { explainFenceRefusal, fencedRunWhere, type FenceRefusal, type RunFence } from "./run-fence.js";
import { lockTask, lockTaskMutationRows } from "./task-write.js";

/** Full Assurance regression and the documentation node a repair must reopen. */
const FULL_REPAIR_DOCUMENTATION_ORDINALS = { regression: 10, documentation: 9 } as const;
const LEGACY_PRE_ADJUDICATION_REPAIR_DOCUMENTATION_ORDINALS = { regression: 11, documentation: 10 } as const;

const failureEnvelopeV1Input = z.object({
  version: z.number().int().positive(),
  phase: z.enum(failurePhases),
  runnerClass: z.nativeEnum(FailureClass).nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  signal: z.string().max(64).nullable().default(null),
  terminationReason: z.string().max(4000).nullable().default(null),
  terminalEventSeen: z.boolean().default(false),
  terminalSuccess: z.boolean().default(false),
  agentExited: z.boolean().default(false),
  providerError: z.string().max(64_000).nullable().default(null),
  stderrSummary: z.string().max(64_000).nullable().default(null),
  stdoutSummary: z.string().max(64_000).nullable().default(null),
  timedOut: z.boolean().default(false),
  transient: z.boolean().default(false),
  timeoutMs: z.number().int().nonnegative().nullable().default(null),
});

/**
 * Merge-tail repair markers point at an existing canonical task rather than a
 * linked-list successor. Queue that explicit target under the same layer mutex
 * as ordinary chain activation; readiness remains server-owned and is only
 * marked queued for its worker.
 */
const activateMergeTailTarget = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  now: Date,
): Promise<void> => {
  if (!await lockTaskMutationRows(tx, taskId)) return;
  const target = await tx.task.findUnique({
    where: { id: taskId },
    include: {
      runs: { where: { status: { in: ACTIVE_RUN_STATUSES } }, take: 1 },
      assigneeAgent: { select: { name: true, archivedAt: true } },
      templateStep: { include: { taskTemplate: { select: { name: true } } } },
    },
  });
  if (!target || target.status === TaskStatus.DONE || target.runs.length > 0) return;
  if (target.archivedAt) {
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge-tail target is archived and was not queued",
    } });
    return;
  }
  if (isMergeReadinessStep(target.templateStep)) {
    // Readiness runs on the server worker, which only claims TODO/DOING. The
    // obligation parked this step in REVIEW while the review ran, so resolving
    // the review has to hand it back; anything else in REVIEW is a real stop
    // and stays stopped.
    const resumed = await tx.task.updateMany({
      where: { id: taskId, status: TaskStatus.REVIEW, failureReason: { startsWith: INDEPENDENT_REVIEW_OPEN_PREFIX } },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: resumed.count === 1
        ? "Independent review resolved; readiness target returned to the server worker"
        : "Merge-tail readiness target queued for server worker",
      metadata: { kind: MERGE_TAIL_KIND.readiness, schemaVersion: 1, state: "queued" },
    } });
    return;
  }
  if (target.status === TaskStatus.REVIEW && target.failureReason?.startsWith(AUTHORITY_RESIGN_OPEN_PREFIX)) {
    // A park the resign worker owns. Re-queueing this step now would spend a
    // gate on a tree the migration preflight still refuses, and would lose the
    // park the operator's inbox message points at.
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge-tail target is held by an open release authority re-signature",
      metadata: { kind: MERGE_TAIL_KIND.authorityResign, schemaVersion: 1, state: "held" },
    } });
    return;
  }
  if (target.assigneeAgent?.archivedAt) {
    const reason = `Assignee ${target.assigneeAgent.name} is archived; unarchive the agent and retry to queue this merge-tail target`;
    await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: `Merge-tail target not queued because assignee ${target.assigneeAgent.name} is archived`,
    } });
    return;
  }
  const claimed = await tx.task.updateMany({
    where: { id: taskId, status: { in: [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] } },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  if (claimed.count !== 1) return;
  const rawTx = tx as Prisma.TransactionClient & { $executeRawUnsafe?: (query: string) => Promise<number> };
  const savepoint = "merge_tail_enqueue";
  const hasSavepoint = typeof rawTx.$executeRawUnsafe === "function";
  if (hasSavepoint) await rawTx.$executeRawUnsafe!(`SAVEPOINT ${savepoint}`);
  try {
    await enqueueTaskRun(tx, taskId, now);
    if (hasSavepoint) await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error: unknown) {
    if (hasSavepoint) {
      await rawTx.$executeRawUnsafe!(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
    }
    const duplicateRun = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
    if (!isArchivedAssigneeError(error) && !isArchivedTaskError(error)
      && !isIntegratorStoppedError(error) && !duplicateRun) throw error;
    if (duplicateRun) {
      await tx.taskActivity.create({ data: {
        taskId,
        actorType: "control-plane",
        body: "Merge-tail target already has the run created by a concurrent activation",
      } });
      return;
    }
    await tx.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.REVIEW, failureReason: error instanceof Error ? error.message : "Merge-tail target could not be queued" },
    });
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: `Merge-tail target was not queued: ${error instanceof Error ? error.message : "enqueue refused"}`,
    } });
    return;
  }
  await tx.taskActivity.create({ data: {
    taskId,
    actorType: "control-plane",
    body: "Merge-tail target queued",
  } });
};

/** What one completion did, and the object the route hands back verbatim. */
export type RunCompletion = {
  taskId: string | null;
  succeeded: boolean;
  retryCreated: boolean;
  failureClass: FailureClass | null;
  releaseMergeLeaseTask: string | null;
};

/** Why a completion wrote nothing. Three distinct answers the route used to
 *  distinguish with an inline `null` plus a follow-up query of its own. */
export type CompleteRunRefusal =
  | { kind: "principal"; error: string }
  | { kind: "waiting-inbox" }
  | { kind: "fence"; reason: FenceRefusal };

export type CompleteRunInput = {
  runId: string;
  body: CompletionInput;
  claimantClass: ClaimantClass;
};

/**
 * Complete a run: one ReadCommitted transaction of 33 writes, and the
 * pre-transaction principal read that refuses a mechanical completion from the
 * wrong bearer before anything is written.
 *
 * The isolation level is the action's, not the route's — ReadCommitted lets
 * successor CAS losers observe count=0 instead of surfacing a serialization
 * failure to runners, which is a statement about run completion rather than
 * about HTTP.
 *
 * The merge-lease release and the ownership assertion stay with the caller:
 * they are control-plane facts about the process, not about the run.
 */
export const completeRun = async (
  db: PrismaClient,
  { runId, body, claimantClass }: CompleteRunInput,
): Promise<RunCompletion | CompleteRunRefusal> => {
  const now = new Date();
  const fence: RunFence = { runId, runnerId: body.runnerId, fencingToken: body.fencingToken, at: now };
  // §4.0. Completing a mechanical run is what makes the chain believe a merge
  // happened, so it is bound to the same independently authenticated
  // principal that was allowed to claim it — and, symmetrically, the executor
  // credential completes nothing else. Read before the transaction: the
  // step binding of a claimed run is immutable (§D-P4 refuses to move it), so
  // there is no state to lose by refusing here, and nothing has been written.
  const completing = await db.run.findUnique({
    where: { id: runId },
    select: { runnerId: true, task: { select: { templateStep: { select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } } } } } },
  });
  if (completing) {
    const refusal = mechanicalPrincipalRefusal(
      executionModeFor(completing.task?.templateStep ?? null),
      claimantClass,
      completing.runnerId ?? body.runnerId,
    );
    if (refusal) return { kind: "principal", error: refusal };
  }
  const result = await db.$transaction(async (tx) => {
    // Run owns fencing, cancellation, and terminalization. Take that mutex
    // before Task so completion, cancellation, and canonical output writes
    // cannot deadlock by entering the same two rows in opposite orders.
    await lockRunRow(tx, runId);
    const run = await tx.run.findFirst({
      where: fencedRunWhere(fence),
      include: {
        // §D-P5. The step's template name is part of the step-12 identity, so
        // the completion route has to read it rather than the step alone.
        task: { include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: { select: { defaultBranch: true } } } },
        session: true,
      },
    });
    if (!run?.session) return null;
    const reportedSuccess = completionSucceeded({
      exitCode: body.exitCode,
      signal: body.signal ?? null,
      terminalEventSeen: body.terminalEventSeen,
      terminalSuccess: body.terminalSuccess,
      terminationReason: body.terminationReason ?? null,
    });
    // A step whose deliverable only its own agent can author is not done
    // because its session ended. An adapter reads the end of a turn as the end
    // of the session, so a step that parked on a background wait — a merge
    // lease, a gate verdict — settled SUCCEEDED with nothing persisted, and the
    // chain stopped at a fail-loud only an operator could clear. Deciding it
    // here, before the terminal status, makes the miss an ordinary retryable
    // failure that the retry path below re-queues inside the task's existing
    // budget.
    //
    // Two bounds keep this narrow. Only this run's own absence counts: an
    // output bound to this run belongs to `canonicalOutputRefusal`, the
    // authority on whether a persisted artifact counts, and a findings artifact
    // an earlier run persisted can never be replaced — a retry there would
    // author nothing and spend the budget proving it. And the diversion applies
    // only while an attempt is left: the ceiling is the run's own, because a
    // missing deliverable is never an external failure and so never refunds
    // one. Once the budget is spent the completion settles exactly as it did
    // before this — the terminal park naming the absent output, with the
    // chain-lease release, the merge-tail stop notice and the refusal activity
    // that park has always written.
    const requiredKind = requiredOutputKind(run.task?.templateStep);
    const outputTaskId = reportedSuccess && requiredKind && run.runNumber < run.maxRunsPerTask
      ? run.taskId
      : null;
    const persistedOutput = outputTaskId
      ? await tx.taskStepOutput.findUnique({ where: { taskId: outputTaskId }, select: { runId: true } })
      : null;
    const missingOutputReason = outputTaskId && requiredKind
      && persistedOutput?.runId !== run.id
      && !(persistedOutput && outputIsImmutableOncePersisted(run.task?.templateStep))
      ? `missing ${requiredKind} task output for current Run ${run.id}`
      : null;
    const succeeded = reportedSuccess && !missingOutputReason;
    // The runner is on the untrusted side of this boundary. When it reports a
    // structured envelope, the API classifies from the facts in it and
    // ignores the runner's own `failureClass`/`retryable`/`externalFailure`
    // — before this, `body.retryable ?? …` meant the runner always won and
    // the retry whitelist in execution.ts was dead code, so a stdout-derived
    // misverdict of RATE_LIMITED spent the task's whole run budget on retries
    // that could not succeed.
    //
    // A runner too old to send an envelope, or one sending a version this API
    // does not know, keeps the previous behaviour verbatim. That is the point
    // of the version check: an unrecognised shape must not be half-read.
    const known = body.failureEnvelope?.version === FAILURE_ENVELOPE_VERSION
      ? failureEnvelopeV1Input.safeParse(body.failureEnvelope)
      : null;
    const envelope = !reportedSuccess && known?.success ? known.data : null;
    const verdict = envelope ? classifyEnvelope(envelope) : null;
    const failureClass = succeeded
      ? null
      : missingOutputReason
        ? FailureClass.PROTOCOL_ERROR
        : verdict?.failureClass ?? body.failureClass ?? (body.exitCode === 0 ? FailureClass.PROTOCOL_ERROR : FailureClass.TASK_FAILED);
    // The runner reported a success, so it reported no verdict about this
    // failure: the control plane owns both answers here rather than reading
    // fields a successful completion never filled in.
    const retryable = missingOutputReason
      ? true
      : failureClass
        ? verdict?.retryable ?? body.retryable ?? failureIsRetryable(failureClass)
        : false;
    const retryAt = failureClass && retryable ? new Date(now.getTime() + retryDelayMs(run.runNumber, failureClass)) : null;
    // An external failure buys the task one more attempt rather than spending
    // one. A missing deliverable is the agent's own attempt, not the
    // environment's, so it spends the attempt like any other failed one.
    const external = missingOutputReason
      ? false
      : verdict
        ? verdict.externalFailure
        : externalFailure({ succeeded, signal: body.signal ?? null, reported: body.externalFailure, failureClass });
    // One reason for the Run, the Session and — unless the budget replaces it
    // with its own — the parked Task.
    const failureReason = succeeded ? null : missingOutputReason ?? body.failureReason ?? "Execution failed";
    // §D-P5 / MF-5. For the integrator step that compensation is switched off
    // entirely, so the answer transaction is the *only* writer of a ceiling
    // above the task's original. Otherwise a run authorized once could buy
    // itself unbounded further attempts by failing externally, and "only a
    // human re-authorization may exceed the ceiling" would be false in a
    // reachable interleaving rather than merely hard to reach. The failure
    // envelope's verdict decides *whether* the failure was external; it does
    // not get to raise the ceiling on this step either.
    const mechanical = isIntegratorStep(run.task?.templateStep ?? null);
    const refunded = external && !mechanical ? 1 : 0;
    const budgetCeiling = run.maxRunsPerTask + refunded;
    // One marker read for both completion outcomes; this handler used to
    // declare `tailRows` twice and scan twice. The success path consults it
    // only for a standalone auxiliary task — an automatic repair or an
    // independent review, neither of which is a chain step — while the
    // failure path consults it only for a failure that is not about to be
    // retried, which is why the ceiling is computed above the read.
    const failureIsFinal = !succeeded && !(retryable && run.runNumber < budgetCeiling);
    const tailMarkers = run.task && (failureIsFinal || (succeeded && !run.task.templateId && !run.task.chainId))
      ? await readMarkers(tx, run.task.id)
      : [];
    const succeededMarkers = succeeded ? tailMarkers : [];
    const repairMarker = latestMarker(succeededMarkers, "repairAttempt");
    const reviewMarker = openReviewObligation(succeededMarkers);
    const repairRegression = repairMarker?.regressionTaskId
      ? await tx.task.findUnique({
          where: { id: repairMarker.regressionTaskId },
          select: {
            projectId: true,
            chainId: true,
            templateId: true,
            chainIndex: true,
            templateStep: { select: { stepIndex: true, taskTemplate: { select: { name: true } } } },
          },
        })
      : null;
    const reviewRegression = reviewMarker?.regressionTaskId
      ? await tx.task.findUnique({
          where: { id: reviewMarker.regressionTaskId },
          select: { projectId: true, repoId: true, templateId: true, chainId: true, targetBranch: true },
        })
      : null;
    // The ordinals are the Full Assurance graph's, and the renamed
    // adjudication-era rows keep the ones they were created under: a repair
    // that lands on a chain from either graph still has to put its
    // documentation node back.
    const repairDocumentationOrdinals = repairRegression?.templateStep?.taskTemplate.name === INTEGRATOR_TEMPLATE_NAME
        || repairRegression?.templateStep?.taskTemplate.name.startsWith(LEGACY_PRE_ZERO_GATE_TEMPLATE_PREFIX)
      ? FULL_REPAIR_DOCUMENTATION_ORDINALS
      : repairRegression?.templateStep?.taskTemplate.name.startsWith(LEGACY_PRE_ADJUDICATION_TEMPLATE_PREFIX)
        ? LEGACY_PRE_ADJUDICATION_REPAIR_DOCUMENTATION_ORDINALS
        : null;
    const repairDocumentationTask = repairRegression?.chainId && repairRegression.templateId
      && repairDocumentationOrdinals
      && repairRegression.chainIndex === repairDocumentationOrdinals.regression
      && repairRegression.templateStep?.stepIndex === repairDocumentationOrdinals.regression
      ? await tx.task.findFirst({
          where: {
            projectId: repairRegression.projectId,
            chainId: repairRegression.chainId,
            templateId: repairRegression.templateId,
            chainIndex: repairDocumentationOrdinals.documentation,
            archivedAt: null,
            templateStep: { stepIndex: repairDocumentationOrdinals.documentation, outputKind: "documentation" },
          },
          orderBy: { chainIndex: "desc" },
          select: { id: true },
        })
      : null;
    // An auxiliary task is one whose own marker names the Regression it serves.
    const mergeTailAuxiliary = Boolean(
      repairMarker?.regressionTaskId || (reviewMarker?.readinessTaskId && reviewMarker.regressionTaskId),
    );
    const auxiliaryTargetTaskId = repairMarker?.regressionTaskId
      ? repairDocumentationTask?.id ?? repairMarker.regressionTaskId
      : reviewMarker?.readinessTaskId ?? null;
    // The same refund, recorded apart from the ceiling it produced. The gates
    // an operator can reach read this rather than `maxRunsPerTask`, because
    // only this can still be told apart from the configured budget after that
    // budget changes. The in-flight ceiling stays derived from the run's own
    // row: a task's budget being edited mid-run must not retroactively refuse
    // an attempt already authorized.
    const budgetGrants = run.budgetGrants + refunded;
    const tailLeaseChainId = run.task?.chainId ?? repairRegression?.chainId ?? reviewRegression?.chainId ?? null;
    let releaseMergeLeaseTask: string | null = null;
    // Completion always mutates its Task, including terminal non-retryable
    // failures. Run is already locked above; acquire the Task/chain mutex now
    // for every outcome rather than only the branches that may retry or
    // advance.
    if (run.task) {
      if (run.task.chainId) {
        await lockChainRows(tx, { projectId: run.task.projectId, chainId: run.task.chainId });
      } else {
        await lockTask(tx, run.task.id);
      }
    }
    if (auxiliaryTargetTaskId && auxiliaryTargetTaskId !== run.task?.id) {
      await lockTaskMutationRows(tx, auxiliaryTargetTaskId);
    }
    if (run.task && typeof (tx.task as { findUnique?: unknown }).findUnique === "function") {
      await tx.task.findUnique({ where: { id: run.task.id }, select: { status: true } });
    }
    // Keep the status observed with the fenced Run as the compare-and-set
    // expectation. The locked re-read above supplies current chain state,
    // but adopting its newer status as the expectation would let completion
    // overwrite an operator decision that won while completion waited for
    // the mutex (for example DONE -> REVIEW on a successful standalone run).
    const completionTaskStatus = run.task?.status;
    const terminalStatus = succeeded
      ? RunStatus.SUCCEEDED
      : body.terminationReason?.includes("walltime") || body.terminationReason?.includes("stall")
        ? RunStatus.TIMED_OUT
        : RunStatus.FAILED;
    const closed = await tx.run.updateMany({
      // The terminal compare-and-set deliberately drops `runnerId`: settlement
      // races completion on this row and neither may win twice. Same instant
      // as the read above, which is what `at` on the fence is for.
      where: fencedRunWhere({ runId, fencingToken: body.fencingToken, at: now }),
      data: {
        status: terminalStatus,
        endedAt: now,
        leaseExpiresAt: null,
        sessionTokenRevokedAt: now,
        failureClass,
        failureReason,
        retryable,
        retryAt,
        // Stored whether or not this API understood it: an envelope from a
        // future runner is still the evidence of what happened, and the
        // reason a verdict can be re-decided later instead of re-run.
        failureEnvelope: succeeded || !body.failureEnvelope ? Prisma.DbNull : jsonValue(body.failureEnvelope),
        // Kept on the run that produced it, whatever became of that run. The
        // same tail used to reach this route on every completion and be read
        // only by the step-output synthesis below, which runs for successful
        // template/chain/follow-up runs and nothing else — so a failure's own
        // account of itself died in this handler and the incident could only
        // be guessed at afterwards. A runner too old to send one leaves NULL,
        // exactly as before.
        output: body.output ?? null,
        terminationReason: body.terminationReason ?? null,
        branch: body.branch ?? run.branch,
        // Completion is a second publication write, never an eraser of the
        // immediate post-push ACK recorded on this run.
        pushedBranch: body.pushedBranch ?? run.pushedBranch,
        baseSha: body.baseSha ?? run.baseSha,
        headSha: body.headSha ?? null,
        pushStatus: body.pushStatus,
        pushRemote: body.pushRemote ?? null,
        pushError: body.pushError ?? null,
        pullRequestUrl: body.pullRequestUrl ?? null,
        pullRequestNumber: body.pullRequestNumber ?? null,
        deliveryInstructions: body.deliveryInstructions ?? null,
        workspaceRetained: body.workspaceRetained,
        maxRunsPerTask: budgetCeiling,
        budgetGrants,
      },
    });
    if (closed.count !== 1) return null;
    await tx.session.update({
      where: { id: run.session.id },
      data: {
        executionStatus: succeeded ? SessionExecutionStatus.SUCCEEDED
          : terminalStatus === RunStatus.TIMED_OUT ? SessionExecutionStatus.TIMED_OUT : SessionExecutionStatus.FAILED,
        cleanupStatus: body.cleanupStatus,
        exitCode: body.exitCode,
        signal: body.signal ?? null,
        terminationReason: body.terminationReason ?? null,
        endedAt: now,
        cleanupEndedAt: now,
        failureReason,
        cleanupFailureReason: body.cleanupFailureReason ?? null,
      },
    });
    let retryCreated = false;
    if (!succeeded && retryable && run.task && run.runNumber < budgetCeiling) {
      const currentTask = await tx.task.findUniqueOrThrow({
        where: { id: run.task.id },
        include: { templateStep: true, repo: { select: { defaultBranch: true } } },
      });
      // The fifth run-creating path. Indexed chains already resolve their
      // branch here; template chains must do the same or a retry is created
      // with `branch: null` and workspace.ts silently moves it to a per-run
      // branch. Pass the failed template run as the prior so publication
      // evidence — including WIP salvage written by this completion — still
      // decides the retry's base; the resolved logical chain head wins over
      // that run's workspace branch. Non-template
      // chains retain their existing no-prior resolution, and non-chain
      // retries retain the historical `branch: null` behavior.
      //
      // All of this runs *after* the updateMany that writes the completing
      // run's `branch`/`pushedBranch`, so the run's own push — a chain step's
      // publication, or a failed run's salvage — is evidence in this
      // transaction. `body.branch ?? run.branch` is that same effective value,
      // because `run` was read before the update.
      const resolveChain = currentTask.repo && currentTask.chainId
        && (currentTask.templateId || currentTask.chainIndex !== null);
      const branches = resolveChain && currentTask.repo
        ? await resolveRunBranches(
          tx,
          { ...currentTask, repo: currentTask.repo },
          currentTask.templateId ? { branch: body.branch ?? run.branch } : null,
        )
        : {
          branch: null,
          targetBranch: currentTask.repo
            ? await resolveRequeueBase(tx, { ...currentTask, repo: currentTask.repo }, {
              branch: body.branch ?? run.branch,
              targetBranch: run.targetBranch,
            })
            : run.targetBranch,
        };
      await tx.run.create({
        data: {
          projectId: run.projectId,
          taskId: run.taskId,
          goalId: run.goalId,
          agentId: run.agentId,
          repoId: run.repoId,
          runNumber: run.runNumber + 1,
          dedupeKey: makeDedupeKey(run.task.id, run.runNumber + 1),
          runner: run.runner,
          model: run.model,
          codexServiceTier: run.codexServiceTier,
          subagentModel: run.subagentModel,
          subagentMaxConcurrent: run.subagentMaxConcurrent,
          targetBranch: branches.targetBranch,
          branch: branches.branch,
          opensPullRequest: currentTask.opensPullRequest,
          promptHash: run.promptHash,
          maxDurationMin: run.maxDurationMin,
          stallTimeoutMin: run.stallTimeoutMin,
          maxRunsPerTask: budgetCeiling,
          budgetGrants,
          readyAt: retryAt ?? now,
        },
      });
      retryCreated = true;
    }
    if (!succeeded && !retryCreated && (mechanical
      || isRegressionVerificationOutputKind(run.task?.templateStep?.outputKind)
      || mergeTailAuxiliary)) {
      releaseMergeLeaseTask = tailLeaseChainId;
    }
    if (run.taskId) {
      const budgetExhausted = !succeeded && retryable && !retryCreated;
      let canonicalOutputFailure: string | null = null;
      if (!succeeded && !retryCreated && run.task) {
        // The same markers the success path above read, from the same scan.
        // A failed auxiliary task closes the obligation it was carrying, so
        // its review obligation counts in any state, not only `open`.
        const failedRepair = latestMarker(tailMarkers, "repairAttempt");
        const failedReview = latestMarker(tailMarkers, "reviewObligation");
        if (failedRepair?.regressionTaskId) {
          const reason = `${failedRepair.repairKind} repair ${run.taskId} failed without closing the repair at ${failedRepair.headSha}`;
          await tx.task.update({ where: { id: failedRepair.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
          await writeMarker(tx, failedRepair.regressionTaskId, "repairResult", {
            actorType: "control-plane",
            body: `Automatic ${failedRepair.repairKind} attempt failed: ${failedRepair.headSha} -> ${body.headSha ?? "no-delivered-head"}`,
            metadata: {
              repairKind: failedRepair.repairKind,
              repairTaskId: run.taskId,
              startHeadSha: failedRepair.headSha,
              targetHeadSha: failedRepair.baseHeadSha,
              resolvedHeadSha: body.headSha ?? null,
              state: "failed",
            },
          });
          await openMergeTailStopNotice(tx, { taskId: failedRepair.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
        } else if (failedReview?.readinessTaskId && failedReview.regressionTaskId) {
          const reason = `independent review ${run.taskId} failed without an exact-head decision for ${failedReview.headSha}`;
          await tx.task.update({ where: { id: failedReview.readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
          await tx.task.update({ where: { id: failedReview.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
          await openMergeTailStopNotice(tx, { taskId: failedReview.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
        }
      }
      // §4.0 outcome branching. The executor's own fenced write is the only
      // writer of a step-12 output: neither synthesis nor the metadata update
      // may touch it, because a synthesized body would read as a merge that
      // never happened.
      if (succeeded && mechanical && run.task) {
        releaseMergeLeaseTask = tailLeaseChainId;
        const persisted = await tx.taskStepOutput.findUnique({
          where: { taskId: run.taskId }, select: { kind: true, body: true },
        });
        const outcome = parseMergeResult(persisted);
        if (outcome.outcome === "merged") {
          await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
        } else {
          await recordIntegratorStop(tx, {
            integratorTaskId: run.taskId,
            condition: outcome.outcome === "stopped" ? outcome.condition : "missing-or-malformed-result",
            evidence: outcome.outcome === "stopped" ? outcome.evidence : outcome.reason,
            agentId: run.agentId,
            sessionId: run.session.id,
            sourceRunId: run.id,
          });
        }
        await tx.taskActivity.create({ data: {
          taskId: run.taskId,
          actorType: "runner",
          actorId: body.runnerId,
          body: outcome.outcome === "merged"
            ? `Run ${run.runNumber} merged the chain's pull request`
            : `Run ${run.runNumber} stopped before merging`,
          metadata: jsonValue({ exitCode: body.exitCode, mergeOutcome: outcome.outcome }),
        } });
      } else if (succeeded && run.task && (run.task.templateId || run.task.chainId || mergeTailAuxiliary)) {
        // Body, runId, metadata, and commit binding describe one act of
        // authorship and only move together through task_output. Completion
        // validates that immutable binding; it never restamps an authored
        // body or synthesizes a canonical step's deliverable.
        let existingOutput = await tx.taskStepOutput.findUnique({ where: { taskId: run.taskId } });
        const canonicalAgentStep = isCanonicalAgentStep(run.task.templateStep);
        const requiresExplicitOutput = requiredOutputKind(run.task.templateStep) !== null;
        if (!existingOutput && !requiresExplicitOutput) {
          await tx.taskStepOutput.create({ data: {
            taskId: run.taskId,
            runId: run.id,
            kind: run.task.templateStep?.outputKind ?? "result",
            body: body.output?.trim() || `Run ${run.runNumber} completed successfully.`,
            metadata: jsonValue({ branch: body.branch ?? run.branch, headSha: body.headSha }),
            commitSha: body.headSha ?? null,
          } });
        } else if (!canonicalAgentStep && existingOutput?.runId === run.id && body.headSha) {
          // Legacy and noncanonical steps retain their prose-compatible
          // completion-time binding. Canonical artifacts are immutable and
          // must already name the delivered head when authored.
          existingOutput = await tx.taskStepOutput.update({
            where: { id: existingOutput.id }, data: { commitSha: body.headSha },
          });
        }
        const outputRefusal = canonicalOutputRefusal(
          run.task.templateStep,
          existingOutput,
          run.id,
          body.headSha ?? null,
        );
        if (outputRefusal) {
          await tx.task.update({
            where: { id: run.taskId },
            data: { status: TaskStatus.REVIEW, failureReason: outputRefusal },
          });
          await tx.taskActivity.create({ data: {
            taskId: run.taskId,
            actorType: "control-plane",
            body: `Canonical task output refused: ${outputRefusal}`,
            metadata: {
              kind: "canonicalTaskOutput.refusal",
              schemaVersion: 1,
              runId: run.id,
              reason: outputRefusal,
            },
          } });
          if (isRegressionVerificationOutputKind(run.task.templateStep?.outputKind)) {
            releaseMergeLeaseTask = tailLeaseChainId;
          }
        }
        canonicalOutputFailure = outputRefusal;
      }
      if (succeeded && mechanical) {
        // Already branched above; the mechanical path owns its own advance.
      } else if (succeeded && run.task?.templateId) {
        if (canonicalOutputFailure) {
          // The current Run succeeded as a process, but it did not publish a
          // canonical deliverable bound to that Run and head. The REVIEW
          // state written above is the terminal control-plane outcome.
        } else if (isRegressionVerificationOutputKind(run.task.templateStep?.outputKind)) {
          const result = await handleRegressionCompletion(tx, {
            task: run.task,
            run: {
              id: run.id,
              agentId: run.agentId,
              branch: body.branch ?? run.branch,
              headSha: body.headSha ?? null,
              sessionId: run.session.id,
            },
            now,
          });
          if (result === "advance") {
            await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
          } else {
            releaseMergeLeaseTask = tailLeaseChainId;
          }
        } else {
          await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
        }
      } else if (succeeded && run.task && (run.task.chainId || mergeTailAuxiliary)) {
        let repairUnable = false;
        let reviewRejected = false;
        if (reviewMarker?.readinessTaskId && reviewMarker.regressionTaskId && reviewMarker.headSha) {
          const readinessTaskId = reviewMarker.readinessTaskId;
          const regressionTaskId = reviewMarker.regressionTaskId;
          const reviewHeadSha = reviewMarker.headSha;
          const reviewBaseSha = reviewMarker.baseSha;
          // Review evidence is run-scoped even though TaskStepOutput is not.
          // An earlier attempt's decision is not this attempt's decision, and
          // a decision not bound to the reviewed head is not evidence about
          // it: either one would let an unreviewed head through.
          const persistedReview = await tx.taskStepOutput.findUnique({
            where: { taskId: run.taskId }, select: { body: true, runId: true, commitSha: true },
          });
          const reviewOutput = persistedReview?.runId === run.id && persistedReview.commitSha === reviewHeadSha
            ? persistedReview
            : null;
          const parsedReview = reviewOutput
            ? parseIndependentReviewDecision(reviewOutput.body, reviewHeadSha)
            : {
              status: "invalid" as const,
              reason: persistedReview
                ? `decision is bound to run ${persistedReview.runId ?? "none"} at ${persistedReview.commitSha ?? "no head"}, not this run at ${reviewHeadSha}`
                : "missing independent review output",
            };
          const reviewSessionId = run.session.id;
          // A finding's own text reaches these reasons, so every one of them
          // is bounded exactly where a client-supplied reason would be.
          const stopTail = async (unbounded: string): Promise<void> => {
            const reason = truncateFailureReason(unbounded, FAILURE_REASON_LIMIT);
            await tx.task.update({ where: { id: readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
            await tx.task.update({ where: { id: regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
            await openMergeTailStopNotice(tx, { taskId: regressionTaskId, agentId: run.agentId, sessionId: reviewSessionId, reason });
          };
          if (parsedReview.status === "invalid") {
            reviewRejected = true;
            const reason = `independent review returned an unusable decision for ${reviewHeadSha}: ${parsedReview.reason}`;
            await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DONE, failureReason: reason } });
            await tx.task.update({ where: { id: readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
            await openMergeTailStopNotice(tx, { taskId: regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
          } else if (parsedReview.decision.outcome !== "rejected") {
            // Follow-up findings never hold the merge. Each becomes a backlog
            // card, so the merge proceeds with the work recorded instead of
            // with the finding lost.
            const followUpCardIds: string[] = [];
            let followUpRefusal: string | null = null;
            const followUpAgentName = await mergeTailFixAgentName(tx, await tx.task.findUnique({
              where: { id: regressionTaskId },
              select: { projectId: true, chainId: true, templateId: true },
            }));
            for (const finding of parsedReview.decision.findings) {
              const card = await createReviewFollowUpCard(tx, {
                projectId: run.task.projectId,
                repoId: run.task.repoId,
                agentName: followUpAgentName,
                reviewTaskId: run.taskId,
                headSha: reviewHeadSha,
                finding,
              });
              if ("refusal" in card) { followUpRefusal = card.refusal; break; }
              followUpCardIds.push(card.taskId);
            }
            if (followUpRefusal) {
              reviewRejected = true;
              const reason = `independent review follow-up card could not be created: ${followUpRefusal}`;
              await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DONE, failureReason: reason } });
              await stopTail(reason);
            } else {
              await writeMarker(tx, readinessTaskId, "reviewObligation", {
                actorType: "control-plane",
                body: followUpCardIds.length === 0
                  ? `Independent review approved exact head ${reviewHeadSha}`
                  : `Independent review accepted exact head ${reviewHeadSha} with ${followUpCardIds.length} follow-up card(s)`,
                metadata: {
                  state: parsedReview.decision.outcome,
                  reviewTaskId: run.taskId,
                  headSha: reviewHeadSha,
                  baseSha: reviewBaseSha,
                  followUpCardIds,
                },
              });
            }
          } else {
            reviewRejected = true;
            const summary = parsedReview.decision.blockingSummary;
            // The whole history, not the recent-state window: the blocking-round
            // ceiling counts every rejection this readiness ever took, and one
            // pushed past the window by later activity would reset the count.
            const prior = await readMarkerHistory(tx, readinessTaskId);
            const round = prior.filter((marker) => (
              marker.kind === "reviewObligation" && marker.state === "rejected"
            )).length + 1;
            await writeMarker(tx, readinessTaskId, "reviewObligation", {
              actorType: "control-plane",
              body: `Independent review rejected exact head ${reviewHeadSha} on blocking round ${round}`,
              metadata: {
                state: "rejected",
                reviewTaskId: run.taskId,
                headSha: reviewHeadSha,
                baseSha: reviewBaseSha,
                summary,
                blockingRound: round,
              },
            });
            await tx.task.update({ where: { id: run.taskId }, data: {
              status: TaskStatus.DONE,
              failureReason: truncateFailureReason(`independent review rejected: ${summary}`, FAILURE_REASON_LIMIT),
            } });
            const driftRecovery = await baseDriftRecoveryContext(
              tx,
              regressionTaskId,
              undefined,
              reviewMarker.recoverySourceStopId ?? "no-recovery-context",
            );
            if (driftRecovery) {
              await stopBaseDriftRecoveryTail(tx, driftRecovery, "independent-review", `rejected ${reviewHeadSha}: ${summary}`);
            } else if (round >= MAX_BLOCKING_REVIEW_ROUNDS) {
              // The ceiling is an exception path, not an approval gate: three
              // blocking rounds mean the repair loop is not converging, so the
              // tail stops and says so instead of spending a fourth round.
              await stopTail(`independent review rejected ${reviewHeadSha} on blocking round ${round} of ${MAX_BLOCKING_REVIEW_ROUNDS}; automatic repair is exhausted: ${summary}`);
            } else if (!reviewBaseSha) {
              await stopTail(`independent review rejected ${reviewHeadSha} but its base head is unavailable for automatic repair`);
            } else {
              // The chain mutex is held now; the Regression row read before it
              // may already be stale, and a repair bound to a stale repository
              // or target branch cannot hand off to the fresh Regression run.
              const lockedRegression = await tx.task.findUnique({
                where: { id: regressionTaskId },
                select: { projectId: true, repoId: true, templateId: true, chainId: true, chainIndex: true, targetBranch: true },
              });
              // Claiming the park this review owns is what makes the repair
              // automatic without overruling anyone: an operator who moved
              // readiness out of it while the review ran keeps that decision,
              // and no repair run starts behind their back.
              const claimedPark = await tx.task.updateMany({
                where: { id: readinessTaskId, status: TaskStatus.REVIEW, failureReason: { startsWith: INDEPENDENT_REVIEW_OPEN_PREFIX } },
                data: { failureReason: `review-fix: automatic repair queued at ${reviewHeadSha}` },
              });
              if (!lockedRegression) {
                await stopTail(`independent review rejected ${reviewHeadSha} but its Regression task is gone`);
              } else if (claimedPark.count !== 1) {
                await writeMarker(tx, readinessTaskId, "reviewObligation", {
                  actorType: "control-plane",
                  body: `Independent review rejected ${reviewHeadSha}, but readiness is no longer parked on that review; automatic repair was not started`,
                  metadata: {
                    state: "repair-skipped",
                    reviewTaskId: run.taskId,
                    headSha: reviewHeadSha,
                  },
                });
              } else {
                const repair = await createMergeTailRepairTask(tx, {
                  regressionTask: { id: regressionTaskId, ...lockedRegression },
                  sourceRun: { id: run.id, branch: run.branch },
                  agentName: await mergeTailFixAgentName(tx, lockedRegression),
                  repairKind: "review-fix",
                  headSha: reviewHeadSha,
                  baseHeadSha: reviewBaseSha,
                  summary,
                  now,
                });
                if ("refusal" in repair) {
                  await stopTail(`independent review rejected ${reviewHeadSha} and automatic repair was refused: ${repair.refusal}`);
                } else {
                  await tx.task.update({
                    where: { id: readinessTaskId },
                    data: { status: TaskStatus.REVIEW, failureReason: `review-fix: automatic repair ${repair.taskId} queued at ${reviewHeadSha}` },
                  });
                }
              }
            }
          }
        }
        if (repairMarker?.regressionTaskId) {
          const repairOutput = await tx.taskStepOutput.findUnique({ where: { taskId: run.taskId }, select: { body: true } });
          let reportedUnable = false;
          let resolvedHeadSha = body.headSha ?? null;
          if (repairMarker.repairKind === "refresh-conflict") {
            const parsedResolver = parseResolverResult(repairOutput?.body);
            const expectedStart = repairMarker.headSha;
            const expectedTarget = repairMarker.baseHeadSha;
            const bindingError = parsedResolver.status === "invalid"
              ? parsedResolver.reason
              : parsedResolver.result.startHeadSha !== expectedStart || parsedResolver.result.targetHeadSha !== expectedTarget
                ? "merge-resolver output is bound to stale start or target heads"
                : parsedResolver.result.outcome === "resolved" && parsedResolver.result.resolvedHeadSha !== body.headSha
                  ? "merge-resolver output resolved head does not match the delivered run head"
                  : null;
            if (bindingError) {
              repairUnable = true;
              const reason = `refresh-conflict repair ${run.taskId} returned invalid output: ${bindingError}`;
              await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DONE, failureReason: reason } });
              await tx.task.update({ where: { id: repairMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
              await writeMarker(tx, repairMarker.regressionTaskId, "repairResult", {
                actorType: "control-plane",
                body: `Automatic refresh-conflict attempt stopped: ${reason}`,
                metadata: {
                  repairKind: "refresh-conflict",
                  repairTaskId: run.taskId,
                  startHeadSha: expectedStart,
                  targetHeadSha: expectedTarget,
                  resolvedHeadSha: body.headSha ?? null,
                  state: "invalid-output",
                  reason: bindingError,
                },
              });
              await openMergeTailStopNotice(tx, { taskId: repairMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
            } else if (parsedResolver.status === "ok") {
              reportedUnable = parsedResolver.result.outcome === "unable";
              resolvedHeadSha = parsedResolver.result.outcome === "resolved" ? parsedResolver.result.resolvedHeadSha : null;
            }
          }
          // gate-fix and review-fix agents have no JSON wire contract; their
          // successful delivered head is the completion evidence.
          if (reportedUnable) {
            repairUnable = true;
            const reason = `${String(repairMarker.repairKind)} repair ${run.taskId} reported unable at ${String(repairMarker.headSha)}`;
            await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DONE, failureReason: reason } });
            await tx.task.update({ where: { id: repairMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
            await openMergeTailStopNotice(tx, { taskId: repairMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
          } else if (!repairUnable) {
            await writeMarker(tx, repairMarker.regressionTaskId, "repairResult", {
              actorType: "control-plane",
              body: `Automatic ${String(repairMarker.repairKind)} attempt completed: ${String(repairMarker.headSha)} -> ${body.headSha ?? "missing-head"}`,
              metadata: {
                repairKind: repairMarker.repairKind,
                repairTaskId: run.taskId,
                startHeadSha: repairMarker.headSha,
                targetHeadSha: repairMarker.baseHeadSha,
                resolvedHeadSha,
              },
            });
            if (repairDocumentationTask) {
              await tx.task.update({
                where: { id: repairDocumentationTask.id },
                data: {
                  status: TaskStatus.TODO,
                  failureReason: `documentation invalidated by ${String(repairMarker.repairKind)} repair ${run.taskId}`,
                },
              });
            }
          }
        }
        if (repairUnable || reviewRejected) {
          // The failed repair owns the stop; never activate its follow-up.
          releaseMergeLeaseTask = tailLeaseChainId;
        } else if (run.task.approvalGate) {
          const claimed = await tx.task.updateMany({
            where: { id: run.taskId, status: completionTaskStatus! },
            data: { status: TaskStatus.REVIEW, failureReason: null },
          });
          if (claimed.count === 1) await gateQuestion(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null);
        } else {
          const completed = await tx.task.updateMany({
            where: { id: run.taskId, status: completionTaskStatus! }, data: { status: TaskStatus.DONE, failureReason: null },
          });
          if (completed.count === 1) {
            if (run.task.chainId) {
              await activateChainSuccessor(tx, run.task, {
                sourceRunId: run.id,
                chatId: process.env.FEISHU_DEFAULT_CHAT_ID ?? null,
              }, now);
            }
            if (auxiliaryTargetTaskId) await activateMergeTailTarget(tx, auxiliaryTargetTaskId, now);
          }
        }
      } else {
        await tx.task.updateMany({
          where: { id: run.taskId, ...(completionTaskStatus ? { status: completionTaskStatus } : {}) },
          data: {
            status: retryCreated ? TaskStatus.DOING : TaskStatus.REVIEW,
            // The fail-loud park keeps naming the absent deliverable once the
            // budget is spent; the budget itself is reported by the Inbox
            // message below.
            failureReason: succeeded ? null : missingOutputReason ?? (budgetExhausted
              ? `Maximum ${budgetCeiling} runs reached`
              : body.failureReason ?? "Execution failed"),
          },
        });
      }
      if (!(succeeded && mechanical)) await tx.taskActivity.create({
        data: {
          taskId: run.taskId,
          actorType: "runner",
          actorId: body.runnerId,
          body: canonicalOutputFailure ? `Run ${run.runNumber} succeeded but canonical task output was refused`
            : succeeded && (run.task?.templateId || run.task?.chainId || mergeTailAuxiliary) ? `Run ${run.runNumber} succeeded; chain advanced or awaiting approval`
            : succeeded ? `Run ${run.runNumber} succeeded; task moved to review`
            : retryCreated ? `Run ${run.runNumber} failed; retry queued`
              : `Run ${run.runNumber} failed; task moved to review`,
          metadata: jsonValue({ exitCode: body.exitCode, terminalEventSeen: body.terminalEventSeen, failureClass, pushStatus: body.pushStatus, pullRequestUrl: body.pullRequestUrl }),
        },
      });
      if (budgetExhausted) {
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            sessionId: run.session.id,
            taskId: run.taskId,
            kind: "TEXT",
            body: `Run budget exhausted after ${budgetCeiling} attempts; operator action required.`,
          },
        });
      }
    }
    if (failureClass === FailureClass.AUTH_REQUIRED) {
      const state = await tx.runnerBackendState.upsert({
        where: { runner: run.runner },
        create: { runner: run.runner, consecutiveAuthFailures: 1, lastPreflightOk: false },
        update: { consecutiveAuthFailures: { increment: 1 }, lastPreflightOk: false },
      });
      if (state.consecutiveAuthFailures >= 2) {
        await tx.runnerBackendState.update({
          where: { runner: run.runner },
          data: { circuitOpen: true, circuitReason: "Repeated authentication failures", circuitOpenedAt: now },
        });
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            sessionId: run.session.id,
            taskId: run.taskId,
            goalId: run.goalId,
            kind: "TEXT",
            body: `${run.runner.toLowerCase()} runner circuit opened after repeated authentication failures; login is required.`,
          },
        });
      }
    } else if (succeeded) {
      await tx.runnerBackendState.upsert({
        where: { runner: run.runner },
        create: { runner: run.runner, lastPreflightOk: true },
        update: { consecutiveAuthFailures: 0 },
      });
    }
    return { taskId: run.taskId, succeeded, retryCreated, failureClass, releaseMergeLeaseTask };
  // ReadCommitted lets successor CAS losers observe count=0 instead of
  // surfacing a serialization failure to runners. Every task status write
  // above has its own status CAS so concurrent operator decisions win.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  // Why the transaction refused, answered here rather than by the caller: a
  // caller that had to re-query the run to tell "suspended for Inbox" from
  // "stale fence" would be re-deriving a distinction this action already made.
  if (!result) {
    const waiting = await db.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
    return waiting
      ? { kind: "waiting-inbox" }
      : { kind: "fence", reason: await explainFenceRefusal(db, fence) };
  }
  return result;
};
