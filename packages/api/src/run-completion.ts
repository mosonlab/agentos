import {
  activateChainSuccessor,
  type ClaimantClass,
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
  INTEGRATOR_TEMPLATE_NAME,
  isIntegratorStep,
  isMergeReadinessStep,
  isRegressionVerificationOutputKind,
  latestMarker,
  LEGACY_PRE_ADJUDICATION_TEMPLATE_PREFIX,
  LEGACY_PRE_ZERO_GATE_TEMPLATE_PREFIX,
  lockChainRows,
  lockRunRow,
  MERGE_TAIL_KIND,
  mechanicalPrincipalRefusal,
  openRun,
  parseMergeResult,
  parseResolverResult,
  Prisma,
  type PrismaClient,
  readMarkers,
  recordIntegratorStop,
  runBudgetCeiling,
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
  retryDelayMs,
} from "./execution.js";
import {
  handleRegressionCompletion,
  openMergeTailStopNotice,
} from "./merge-tail-actions.js";
import { explainFenceRefusal, fenceRefusalResponse, fencedRunWhere, type RunFence } from "./run-fence.js";
import {
  commitWithLeaseDisposition,
  settleLease,
  type LeaseSettlementOutcome,
  type ReleaseMergeLease,
} from "./merge-lease.js";
import type { Refusal } from "./refusal.js";
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
    // Readiness runs on the server worker, which only claims TODO/DOING.
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge-tail readiness target queued for server worker",
      metadata: { kind: MERGE_TAIL_KIND.readiness, schemaVersion: 1, state: "queued" },
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
};

/** Why a completion wrote nothing. Three distinct answers the route used to
 *  distinguish with an inline `null` plus a follow-up query of its own. */
export type CompleteRunRefusal = Refusal;

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
  releaseMergeLease?: ReleaseMergeLease,
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
    if (refusal) return { reason: "forbidden", message: refusal };
  }
  const result = await commitWithLeaseDisposition(db, async (tx) => {
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
    const budgetCeiling = runBudgetCeiling(run.maxRunsPerTask, refunded);
    // One marker read for both completion outcomes; this handler used to
    // declare `tailRows` twice and scan twice. The success path consults it
    // only for a standalone auxiliary task — an automatic repair, which is not
    // a chain step — while the failure path consults it only for a failure
    // that is not about to be retried, which is why the ceiling is computed
    // above the read.
    const failureIsFinal = !succeeded && !(retryable && run.runNumber < budgetCeiling);
    const tailMarkers = run.task && (failureIsFinal || (succeeded && !run.task.templateId && !run.task.chainId))
      ? await readMarkers(tx, run.task.id)
      : [];
    const succeededMarkers = succeeded ? tailMarkers : [];
    const repairMarker = latestMarker(succeededMarkers, "repairAttempt");
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
    const mergeTailAuxiliary = Boolean(repairMarker?.regressionTaskId);
    const auxiliaryTargetTaskId = repairMarker?.regressionTaskId
      ? repairDocumentationTask?.id ?? repairMarker.regressionTaskId
      : null;
    // The same refund, recorded apart from the ceiling it produced. The gates
    // an operator can reach read this rather than `maxRunsPerTask`, because
    // only this can still be told apart from the configured budget after that
    // budget changes. The in-flight ceiling stays derived from the run's own
    // row: a task's budget being edited mid-run must not retroactively refuse
    // an attempt already authorized.
    const budgetGrants = run.budgetGrants + refunded;
    let leaseOutcome: LeaseSettlementOutcome = "continue";
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
        // Report-only runner observation. Keep compliant and legacy
        // completions NULL so absence of an entry means no observation rather
        // than manufacturing a fact for a runner that did not send one.
        worktreeContainmentViolations: body.worktreeContainmentViolations?.length
          ? jsonValue(body.worktreeContainmentViolations)
          : Prisma.DbNull,
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
    let retryRefusal: Refusal | null = null;
    if (!succeeded && retryable && run.task && run.runNumber < budgetCeiling) {
      const opened = await openRun(tx, run.task.id, {
        kind: "retry-after-completion",
        sourceRunId: run.id,
        sourceMaxRunsPerTask: run.maxRunsPerTask,
        sourceBudgetGrants: run.budgetGrants,
        budgetGrant: refunded,
        readyAt: retryAt ?? now,
      });
      if (opened.ok) retryCreated = true;
      else retryRefusal = opened.refusal;
    }
    if (!succeeded && !retryCreated && (mechanical
      || isRegressionVerificationOutputKind(run.task?.templateStep?.outputKind)
      || mergeTailAuxiliary)) {
      leaseOutcome = "stop";
    }
    if (run.taskId) {
      const budgetExhausted = !succeeded && retryable && !retryCreated && !retryRefusal;
      let canonicalOutputFailure: string | null = null;
      if (!succeeded && !retryCreated && run.task) {
        // The same markers the success path above read, from the same scan.
        const failedRepair = latestMarker(tailMarkers, "repairAttempt");
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
        }
      }
      // §4.0 outcome branching. The executor's own fenced write is the only
      // writer of a step-12 output: neither synthesis nor the metadata update
      // may touch it, because a synthesized body would read as a merge that
      // never happened.
      if (succeeded && mechanical && run.task) {
        leaseOutcome = "stop";
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
            leaseOutcome = "stop";
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
            leaseOutcome = "stop";
          }
        } else {
          await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
        }
      } else if (succeeded && run.task && (run.task.chainId || mergeTailAuxiliary)) {
        let repairUnable = false;
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
        if (repairUnable) {
          // The failed repair owns the stop; never activate its follow-up.
          leaseOutcome = "stop";
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
              : retryRefusal
                ? `Automatic retry refused: ${retryRefusal.message}`
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
              : retryRefusal ? `Run ${run.runNumber} failed; automatic retry refused: ${retryRefusal.message}`
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
      if (retryRefusal) {
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            sessionId: run.session.id,
            taskId: run.taskId,
            kind: "TEXT",
            body: `Automatic retry refused: ${retryRefusal.message}`,
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
    const lease = await settleLease(tx, { taskId: run.taskId, outcome: leaseOutcome });
    return {
      value: { taskId: run.taskId, succeeded, retryCreated, failureClass },
      lease,
    };
  // ReadCommitted lets successor CAS losers observe count=0 instead of
  // surfacing a serialization failure to runners. Every task status write
  // above has its own status CAS so concurrent operator decisions win.
  }, releaseMergeLease, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  // Why the transaction refused, answered here rather than by the caller: a
  // caller that had to re-query the run to tell "suspended for Inbox" from
  // "stale fence" would be re-deriving a distinction this action already made.
  if (!result) {
    const waiting = await db.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
    if (waiting) {
      return {
        reason: "conflict",
        message: "Run suspended for Inbox",
        detail: { code: "WAITING_INBOX" },
      };
    }
    const fenceRefusal = fenceRefusalResponse(await explainFenceRefusal(db, fence));
    return {
      reason: "conflict",
      message: fenceRefusal.error,
      detail: { reason: fenceRefusal.reason },
    };
  }
  return result;
};
