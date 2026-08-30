import {
  AssigneeType,
  ChainControlState,
  CleanupStatus,
  type ClaimantClass,
  claimantMayTake,
  deployBarrierAllowsClaim,
  executionModeFor,
  FailureClass,
  integratorBindingRefusal,
  INTEGRATOR_OUTPUT_KIND,
  isMergeReadinessStep,
  isPinnedBaseCommitError,
  LEGACY_ALL_PRIOR_OUTPUTS,
  MERGE_TAIL_KIND,
  mergeExecutorRunnerIds,
  PinnedBaseCommitError,
  pinnedImplementationRange,
  Prisma,
  type PrismaClient,
  RunStatus,
  SessionExecutionStatus,
  taskIsIntegratorStep,
  TaskStatus,
} from "@anneal/db";
import { z } from "zod";

import { issueSessionToken } from "./auth.js";
import { isCanonicalBlindFindingsStep, previousRunHandoffForClaim } from "./canonical-task-output.js";
import { makeFencingToken } from "./execution.js";
import { openMergeTailStopNotice } from "./merge-tail-actions.js";
import { regressionRepairHandoffForClaim } from "./regression-repair-handoff.js";
import { activeRunStatuses } from "./run-fence.js";
import { readStoredCliAvailability } from "./runner-cli-availability.js";
import { decryptSecret } from "./secrets.js";
import {
  prepareSpecificationVerification,
  specificationReadBudgetExhaustedRefusal,
  specificationMaterializationForDirectImplementation,
  type SpecificationReader,
  type SpecificationRefusal,
  SPEC_TRANSCRIPTION_REFUSAL_REASON,
  SPEC_TRANSCRIPTION_UNREADABLE_REASON,
  verifyPreparedSpecification,
} from "./specification-fidelity.js";
import { lockTaskMutationRows, writeTask } from "./task-write.js";
import { isSerializationConflict, serializable } from "./transaction.js";

const telemetry = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(({ error, input }) => {
  console.warn("Discarded runner telemetry", { input, issues: error.issues });
  return undefined;
});

export const runnerTelemetryFields = {
  daemonVersion: telemetry(z.string().trim().max(40)),
  diskFreeBytes: telemetry(z.number().int().nonnegative()),
  pollIntervalMs: telemetry(z.number().int().positive().max(3_600_000)),
  workspaceRoot: telemetry(z.string().trim().max(500)),
};

export const claimInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
  ...runnerTelemetryFields,
});

export type ClaimInput = z.infer<typeof claimInput>;

class PinnedRunTargetError extends Error {
  constructor(readonly runId: string, targetBranch: string | null, implementationHeadSha: string) {
    super(`Pinned run ${runId} targets ${targetBranch ?? "no commit"}, but its source step now records ${implementationHeadSha}`);
    this.name = "PinnedRunTargetError";
  }
}

type CandidateActivationFailure = PinnedBaseCommitError | PinnedRunTargetError;

const isCandidateActivationFailure = (error: unknown): error is CandidateActivationFailure =>
  isPinnedBaseCommitError(error) || error instanceof PinnedRunTargetError;

const namedFailureReason = (error: CandidateActivationFailure): string => `${error.name}: ${error.message}`;

const SKIP = { outcome: "skip" } as const;
const HALT = { outcome: "halt" } as const;

export type ClaimRunInput = {
  body: ClaimInput;
  claimantClass: ClaimantClass;
  /** The instant the whole claim is decided at, including the caller's
   *  pre-claim reconciliation. */
  now: Date;
  /** Explicit capability: null refuses review claims rather than bypassing verification. */
  specificationReader: SpecificationReader | null;
  signal?: AbortSignal;
};

const MAX_OPERATOR_NOTES = 10;
const MAX_OPERATOR_NOTES_CHARS = 4_000;
const PRIOR_OUTPUT_MISSING_REASON = "prior-output-missing";
export const OPERATOR_NOTE_METADATA_FIELD = "operatorNote";
const SPECIFICATION_READ_DEFERRAL_CONDITION = "specification-read-claim-deferred";
const SPECIFICATION_READ_DEFERRAL_BUDGET_MS = 5 * 60_000;
const SPECIFICATION_READ_DEFERRAL_DELAYS_MS = [15_000, 30_000, 60_000] as const;

/**
 * The Prisma claim lane cannot express the comparison between a candidate
 * Task's layer and the held layer in a relation filter: ChainControl is keyed
 * by the project/Chain pair, while the two layer values live on different
 * rows. Resolve the held Task ids first, then add that set to the Prisma
 * candidate predicate. The layer expression deliberately mirrors the raw
 * runner query below and the shared Chain layer fallback used by the rest of
 * the Chain control paths.
 */
const heldChainTaskIdsForClaim = async (tx: Prisma.TransactionClient): Promise<string[]> => {
  const controls = await tx.chainControl.findMany({
    where: { state: ChainControlState.HELD },
    select: { projectId: true, chainId: true, heldLayer: true },
  });
  const heldChains = controls.flatMap(({ projectId, chainId, heldLayer }) => {
    if (heldLayer === null) return [{ projectId, chainId }];
    return [{
      projectId,
      chainId,
      OR: [
        { chainLayer: { gt: heldLayer } },
        { chainLayer: null, chainIndex: { gt: heldLayer } },
      ],
    }];
  });
  if (heldChains.length === 0) return [];
  const tasks = await tx.task.findMany({ where: { OR: heldChains }, select: { id: true } });
  return tasks.map(({ id }) => id);
};

/**
 * Operator notes are a claim-time handoff. Run 1 uses the task's creation
 * time as the lower bound; later attempts use the previous Run's creation
 * time. A note written after a claim cannot interrupt that live provider
 * session, but is still available if the task needs another attempt. Newest
 * rows are selected first, and a note that cannot fit the character budget is
 * omitted whole.
 */
const operatorNotesForClaim = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  runNumber: number,
  taskCreatedAt: Date,
): Promise<string[]> => {
  const lowerBound = runNumber <= 1
    ? taskCreatedAt
    : (await tx.run.findUnique({
      where: { taskId_runNumber: { taskId, runNumber: runNumber - 1 } },
      select: { createdAt: true },
    }))?.createdAt;
  if (!lowerBound) return [];
  const rows = await tx.taskActivity.findMany({
    where: {
      taskId,
      actorType: "operator",
      metadata: { path: [OPERATOR_NOTE_METADATA_FIELD], equals: true },
      createdAt: { gt: lowerBound },
    },
    select: { body: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_OPERATOR_NOTES,
  });
  let remaining = MAX_OPERATOR_NOTES_CHARS;
  const newestFirst = rows.flatMap(({ body }) => {
    if (body.length > remaining) return [];
    remaining -= body.length;
    return [body];
  });
  return newestFirst.reverse();
};

/**
 * Claim one queued run, or answer that nothing was claimable.
 *
 * The action owns the Serializable transaction and the six-attempt retry
 * around it. Both are invariants of claiming, not of HTTP: a caller that had
 * to restate the isolation level or re-implement the retry would be restating
 * the reason this transaction can lose a race it did not cause.
 */
export const claimRun = async (db: PrismaClient, input: ClaimRunInput) => {
  const { body, claimantClass, now } = input;
  const verificationResults = new Map<string, SpecificationRefusal | null>();
  const transactionalAttempt = () => serializable(db, async (tx) => {
    // This is the shared half of the production deploy barrier. It is the
    // first statement in the claim transaction: an in-flight claim finishes
    // before a deploy can acquire the exclusive half, and claims arriving
    // during a deploy return no work without observing candidates.
    if (!await deployBarrierAllowsClaim(tx)) return null;
    const candidateWhere = {
      where: {
        status: RunStatus.QUEUED,
        readyAt: { lte: now },
        agent: { archivedAt: null },
        // `archivedAt: null` is defense in depth: `enqueueTaskRun` already
        // refuses an archived task, and archive already refuses a task with an
        // active run, so a queued run on an archived task should be
        // unreachable. If one ever exists it must not be handed to a runner.
        task: {
          status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
          assigneeType: AssigneeType.AGENT,
          archivedAt: null,
        },
        OR: [{ blockedByRunId: null }, { blockedBy: { status: RunStatus.SUCCEEDED } }],
      },
    } satisfies Pick<Prisma.RunFindManyArgs, "where">;
    const candidateInclude = {
      include: {
        // templateStep travels with the claim so delivery can title the PR
        // after the chain rather than the step it happens to be running.
        // §D-P4 / §D-P1 rule 3 need all four identity facts of the step, not
        // only its display name: the claim transaction is where
        // `executionMode` is computed and where a mis-bound candidate is
        // skipped rather than handed out.
        task: { include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } } },
        repo: true,
        session: true,
        agent: {
          include: {
            secretGrants: { include: { secret: true } },
            environment: { include: { secrets: { include: { secret: true } } } },
            repoAccess: true,
          },
        },
      },
    } satisfies Pick<Prisma.RunFindManyArgs, "include">;
    const candidates = claimantClass === "merge-executor"
      ? await (async () => {
        const heldChainTaskIds = await heldChainTaskIdsForClaim(tx);
        const where = heldChainTaskIds.length === 0
          ? candidateWhere.where
          : {
            ...candidateWhere.where,
            task: {
              ...candidateWhere.where.task,
              id: { notIn: heldChainTaskIds },
            },
          };
        return tx.run.findMany({
          where,
          ...candidateInclude,
          orderBy: [{ readyAt: "asc" }, { createdAt: "asc" }],
          take: 20,
        });
      })()
      : await (async () => {
        // Rank in PostgreSQL before applying the window so the transaction
        // returns only the candidates it can inspect. Mechanical rows are not
        // in the ordinary runner's lane and therefore cannot consume that
        // window; claimantMayTake remains the final execution-mode authority.
        const selectedIds = (await tx.$queryRaw<Array<{ id: string }>>`
          SELECT candidate."id"
          FROM "Run" AS candidate
          JOIN "Task" AS task
            ON task."id" = candidate."taskId"
           AND task."projectId" = candidate."projectId"
          JOIN "Agent" AS agent
            ON agent."id" = candidate."agentId"
           AND agent."projectId" = candidate."projectId"
          LEFT JOIN "Run" AS blocker ON blocker."id" = candidate."blockedByRunId"
          LEFT JOIN "TaskTemplateStep" AS template_step ON template_step."id" = task."templateStepId"
          LEFT JOIN LATERAL (
            SELECT count(*)::integer AS "unfinished"
            FROM "Task" AS chain_task
            WHERE chain_task."projectId" = task."projectId"
              AND chain_task."chainId" = task."chainId"
              AND chain_task."status" <> lower(${TaskStatus.DONE})::"TaskStatus"
          ) AS chain_priority ON task."chainId" IS NOT NULL
          WHERE candidate."status" = lower(${RunStatus.QUEUED})::"RunStatus"
            AND candidate."readyAt" <= ${now}
            AND agent."archivedAt" IS NULL
            AND task."status" IN (lower(${TaskStatus.TODO})::"TaskStatus", lower(${TaskStatus.DOING})::"TaskStatus")
            AND task."assigneeType" = lower(${AssigneeType.AGENT})::"AssigneeType"
            AND task."archivedAt" IS NULL
            AND (candidate."blockedByRunId" IS NULL OR blocker."status" = lower(${RunStatus.SUCCEEDED})::"RunStatus")
            AND COALESCE(template_step."outputKind", '') <> ${INTEGRATOR_OUTPUT_KIND}
            AND NOT EXISTS (
              SELECT 1
              FROM "ChainControl" AS chain_control
              WHERE chain_control."projectId" = task."projectId"
                AND chain_control."chainId" = task."chainId"
                AND chain_control."state" = lower(${ChainControlState.HELD})::"ChainControlState"
                AND (
                  chain_control."heldLayer" IS NULL
                  OR COALESCE(task."chainLayer", task."chainIndex") IS NULL
                  OR COALESCE(task."chainLayer", task."chainIndex") > chain_control."heldLayer"
                )
            )
          ORDER BY COALESCE(chain_priority."unfinished", 1) ASC,
            candidate."readyAt" ASC,
            candidate."createdAt" ASC
          LIMIT 20
        `).map(({ id }) => id);
        if (selectedIds.length === 0) return [];
        const selected = await tx.run.findMany({
          where: { id: { in: selectedIds } },
          ...candidateInclude,
        });
        const selectedById = new Map(selected.map((candidate) => [candidate.id, candidate]));
        return selectedIds.map((id) => {
          const candidate = selectedById.get(id);
          if (!candidate) throw new Error(`Prioritized queued candidate ${id} could not be loaded`);
          return candidate;
        });
      })();
    const executorRunnerIds = mergeExecutorRunnerIds();
    const parkQueuedCandidate = async (
      candidate: (typeof candidates)[number],
      settlement: {
        reason: string;
        condition: string;
        activityBody: string;
        inboxBody: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<{ chainLocked: boolean }> => {
      if (!candidate.task) throw new Error(`Queued candidate ${candidate.id} has no task to park`);
      const stopped = await tx.run.updateMany({
        where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
        data: {
          status: RunStatus.FAILED,
          failureClass: FailureClass.TASK_FAILED,
          failureReason: settlement.reason,
          retryable: false,
          endedAt: now,
        },
      });
      if (stopped.count !== 1) return { chainLocked: false };
      const parked = await writeTask(tx, candidate.task.id, async () => ({
        update: { status: TaskStatus.BACKLOG, failureReason: settlement.reason },
        activity: {
          actorType: "control-plane",
          body: settlement.activityBody,
          metadata: {
            runId: candidate.id,
            condition: settlement.condition,
            ...settlement.metadata,
          },
        },
        value: null,
      }));
      const dedupeKey = `${settlement.condition}:${candidate.id}`;
      await tx.inboxMessage.upsert({
        where: { dedupeKey },
        create: {
          from: "AGENT",
          agentId: candidate.agentId,
          taskId: candidate.task.id,
          kind: "TEXT",
          body: settlement.inboxBody,
          dedupeKey,
        },
        update: {},
      });
      return { chainLocked: parked.ok && parked.chainLocked };
    };
    const priorSpecificationReadDeferrals = async (candidate: (typeof candidates)[number]) => {
      if (!candidate.task) throw new Error(`Queued candidate ${candidate.id} has no task to inspect`);
      return tx.taskActivity.findMany({
        where: {
          taskId: candidate.task.id,
          // A resumed Run keeps its id, but every successful claim rewrites
          // claimedAt. Rows before it belong to an earlier claim episode.
          ...(candidate.claimedAt ? { createdAt: { gt: candidate.claimedAt } } : {}),
          AND: [
            { metadata: { path: ["condition"], equals: SPECIFICATION_READ_DEFERRAL_CONDITION } },
            { metadata: { path: ["runId"], equals: candidate.id } },
          ],
        },
        select: { createdAt: true, metadata: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    };
    const specificationReadDeferralState = async (candidate: (typeof candidates)[number]) => {
      const priorDeferrals = await priorSpecificationReadDeferrals(candidate);
      const budgetStartedAt = priorDeferrals[0]?.createdAt;
      if (!budgetStartedAt) return null;
      const latestMetadata = priorDeferrals.at(-1)?.metadata;
      const latestEvidence = typeof latestMetadata === "object" && latestMetadata !== null && !Array.isArray(latestMetadata)
        ? latestMetadata as Record<string, unknown>
        : {};
      const persistedDetail = typeof latestEvidence.lastUnderlyingErrorDetail === "string"
        ? latestEvidence.lastUnderlyingErrorDetail
        : null;
      const persistedMessage = typeof latestEvidence.lastUnderlyingError === "string"
        ? latestEvidence.lastUnderlyingError
        : "repository content read failed";
      const messagePrefix = `Spec transcription claim refused: ${SPEC_TRANSCRIPTION_UNREADABLE_REASON}: `;
      return {
        attemptCount: priorDeferrals.length,
        budgetStartedAt,
        budgetDeadlineAt: new Date(budgetStartedAt.getTime() + SPECIFICATION_READ_DEFERRAL_BUDGET_MS),
        lastUnderlyingError: persistedDetail
          ?? (persistedMessage.startsWith(messagePrefix) ? persistedMessage.slice(messagePrefix.length) : persistedMessage),
      };
    };
    const exhaustTransientSpecificationRead = async (
      candidate: (typeof candidates)[number],
      state: NonNullable<Awaited<ReturnType<typeof specificationReadDeferralState>>>,
      implementationHeadSha: string,
    ) => {
      const refusal = specificationReadBudgetExhaustedRefusal(
        SPECIFICATION_READ_DEFERRAL_BUDGET_MS,
        state.lastUnderlyingError,
      );
      await parkQueuedCandidate(candidate, {
        reason: refusal.message,
        condition: refusal.reason,
        activityBody: `Review claim stopped after its transient specification-read budget was exhausted: ${refusal.message}`,
        inboxBody: `Review claim failed and the task was parked in Backlog after its transient specification-read budget was exhausted: ${refusal.message}`,
        metadata: {
          classification: refusal.classification,
          exhaustedCondition: SPECIFICATION_READ_DEFERRAL_CONDITION,
          budgetStartedAt: state.budgetStartedAt.toISOString(),
          budgetDeadlineAt: state.budgetDeadlineAt.toISOString(),
          implementationHeadSha,
          lastUnderlyingError: state.lastUnderlyingError,
        },
      });
      // Match the existing unreadable-refusal settlement: one parked review
      // does not keep an eligible sibling from settling in this same poll.
      return SKIP;
    };
    const deferTransientSpecificationRead = async (
      candidate: (typeof candidates)[number],
      refusal: SpecificationRefusal,
      implementationHeadSha: string,
      state: Awaited<ReturnType<typeof specificationReadDeferralState>>,
    ) => {
      if (!candidate.task) throw new Error(`Queued candidate ${candidate.id} has no task to defer`);
      const budgetStartedAt = state?.budgetStartedAt ?? now;
      const budgetDeadlineAt = new Date(budgetStartedAt.getTime() + SPECIFICATION_READ_DEFERRAL_BUDGET_MS);
      if (now.getTime() >= budgetDeadlineAt.getTime()) {
        return exhaustTransientSpecificationRead(candidate, {
          attemptCount: state?.attemptCount ?? 0,
          budgetStartedAt,
          budgetDeadlineAt,
          lastUnderlyingError: refusal.detail,
        }, implementationHeadSha);
      }

      const attempt = (state?.attemptCount ?? 0) + 1;
      const delayMs = SPECIFICATION_READ_DEFERRAL_DELAYS_MS[
        Math.min(attempt - 1, SPECIFICATION_READ_DEFERRAL_DELAYS_MS.length - 1)
      ]!;
      const nextAttemptAt = new Date(Math.min(now.getTime() + delayMs, budgetDeadlineAt.getTime()));
      const deferred = await tx.run.updateMany({
        where: {
          id: candidate.id,
          status: RunStatus.QUEUED,
          leaseGeneration: candidate.leaseGeneration,
          readyAt: candidate.readyAt,
        },
        data: { readyAt: nextAttemptAt },
      });
      if (deferred.count !== 1) return SKIP;
      await tx.taskActivity.create({
        data: {
          taskId: candidate.task.id,
          actorType: "control-plane",
          body: `Review claim deferred after transient specification read failure; attempt ${attempt} will be eligible at ${nextAttemptAt.toISOString()}`,
          metadata: {
            condition: SPECIFICATION_READ_DEFERRAL_CONDITION,
            classification: refusal.classification,
            runId: candidate.id,
            attempt,
            delayMs,
            budgetMs: SPECIFICATION_READ_DEFERRAL_BUDGET_MS,
            budgetStartedAt: budgetStartedAt.toISOString(),
            budgetDeadlineAt: budgetDeadlineAt.toISOString(),
            nextAttemptAt: nextAttemptAt.toISOString(),
            implementationHeadSha,
            lastUnderlyingError: refusal.message,
            lastUnderlyingErrorDetail: refusal.detail,
          },
        },
      });
      return candidate.task.chainId ? HALT : SKIP;
    };
    // One candidate's decision, taken as its own unit of work so the loop can
    // isolate it. `skip` moves to the next candidate, `halt` ends the whole
    // claim without one, `claimed` carries the run handed to the runner.
    const activateCandidate = async (candidate: (typeof candidates)[number]) => {
      if (!candidate.task || !candidate.repo) return SKIP;
      if (!candidate.agent.repoAccess.some((grant) => grant.repoId === candidate.repoId && grant.projectId === candidate.projectId)) {
        const reason = "repository-grant-missing: restore the agent Repo grant, then retry this run";
        const stranded = await tx.run.updateMany({
          where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
          data: {
            status: RunStatus.FAILED,
            failureClass: FailureClass.TASK_FAILED,
            failureReason: reason,
            retryable: false,
            endedAt: now,
          },
        });
        if (stranded.count === 1) {
          const parked = await writeTask(tx, candidate.task.id, async () => ({
            update: { status: TaskStatus.BACKLOG, failureReason: reason },
            activity: {
              actorType: "control-plane",
              body: "Queued run stopped because its repository grant is missing; restore the grant and retry",
              metadata: { runId: candidate.id, condition: "repository-grant-missing" },
            },
            value: null,
          }));
          // A chained park expands the lock order from this Run to every Task
          // in the chain. End the transaction here: scanning another
          // candidate could next wait on a sibling Run while its claimant
          // already holds that Run and waits for this chain mutex.
          if (parked.ok && parked.chainLocked) return HALT;
        }
        return SKIP;
      }
      // §D-P4. A candidate whose (agent, step) binding is invalid is *skipped*,
      // not claimed: a mis-bound step-12 row must never be handed to anything,
      // and the sentinel Agent on an ordinary step must never reach an adapter.
      if (integratorBindingRefusal(candidate.agent.name, candidate.task.templateStep)) return SKIP;
      // Readiness is server-owned. Even if an old/manual path materializes a
      // Run row for it, no model runner or merge executor may claim it; the
      // readiness worker consumes the TODO task row directly.
      if (isMergeReadinessStep(candidate.task.templateStep)) return SKIP;
      const executionMode = executionModeFor(candidate.task.templateStep);
      // §D-P1 rule 3, symmetric and fail-closed: only the independently
      // authenticated merge-executor principal is offered an integrator run,
      // and it is offered nothing else. With `MERGE_EXECUTOR_RUNNER_IDS`
      // empty — the shipped default — or with `MERGE_EXECUTOR_TOKEN` unset or
      // aliased onto the runner token, no integrator run is claimable at all.
      if (!claimantMayTake(executionMode, claimantClass, body.runnerId, executorRunnerIds)) return SKIP;
      // The backend circuit breaker tracks model-CLI health. A mechanical run
      // spawns no CLI, so an open CLI circuit is not evidence about it; the
      // `runner` on its row is an inert artifact of the sentinel Agent.
      if (executionMode === "agent") {
        const backend = await tx.runnerBackendState.findUnique({ where: { runner: candidate.runner } });
        if (readStoredCliAvailability(backend?.capabilities)?.available === false || backend?.circuitOpen) return SKIP;
      }
      if (executionMode === "mechanical") {
        const targetBranch = candidate.task.targetBranch ?? candidate.repo.defaultBranch;
        // Serialize only the claim transition for one repository target. The
        // lock is transaction-scoped: the committed active Run is the durable
        // exclusion fact, while later work remains QUEUED. Different targets
        // take different keys and do not participate in one another's lock.
        const lockKey = `merge-integrator:${candidate.repoId}:${targetBranch}`;
        const [targetLock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS "locked"
        `;
        if (targetLock?.locked !== true) return SKIP;
        const activePeers = await tx.run.findMany({
          where: {
            id: { not: candidate.id },
            repoId: candidate.repoId,
            status: { in: activeRunStatuses },
            task: { targetBranch },
          },
          select: {
            task: { include: {
              templateStep: { include: { taskTemplate: { select: { name: true } } } },
            } },
          },
        });
        if (activePeers.some((peer) => taskIsIntegratorStep(peer.task))) return SKIP;
      }
      const regressionRepairHandoff = await regressionRepairHandoffForClaim(tx, {
        taskId: candidate.task.id,
        projectId: candidate.projectId,
        repoId: candidate.repo.id,
        runId: candidate.id,
        runNumber: candidate.runNumber,
        branch: candidate.branch,
        targetBranch: candidate.targetBranch,
        outputKind: candidate.task.templateStep?.outputKind ?? null,
      });
      if (regressionRepairHandoff.status === "invalid") {
        const stopped = await tx.run.updateMany({
          where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
          data: {
            status: RunStatus.FAILED,
            failureClass: FailureClass.TASK_FAILED,
            failureReason: regressionRepairHandoff.reason,
            retryable: false,
            endedAt: now,
          },
        });
        if (stopped.count === 1) {
          const parked = await writeTask(tx, candidate.task.id, async () => ({
            update: { status: TaskStatus.REVIEW, failureReason: regressionRepairHandoff.reason },
            activity: {
              actorType: "control-plane",
              body: `Fresh Regression Run stopped: ${regressionRepairHandoff.reason}`,
              metadata: {
                kind: MERGE_TAIL_KIND.repairResult,
                schemaVersion: 1,
                state: "handoff-invalid",
                runId: candidate.id,
                previousRunId: regressionRepairHandoff.previousRunId,
                reason: regressionRepairHandoff.reason,
              },
            },
            value: null,
          }));
          const sourceSession = await tx.session.findUnique({
            where: { runId: regressionRepairHandoff.previousRunId },
            select: { id: true },
          });
          await openMergeTailStopNotice(tx, {
            taskId: candidate.task.id,
            agentId: candidate.agentId,
            ...(sourceSession ? { sessionId: sourceSession.id } : {}),
            reason: regressionRepairHandoff.reason,
          });
          if (parked.ok && parked.chainLocked) return HALT;
        }
        return SKIP;
      }
      const grants = [
        ...candidate.agent.environment.secrets,
        ...candidate.agent.secretGrants,
      ].filter(({ secret }) => !secret.disabledAt);
      const grantedEnvironmentVariables = new Set<string>();
      for (const { envVar } of grants) {
        if (["OPERATOR_TOKEN", "RUNNER_TOKEN", "AGENTOS_API_TOKEN", "AGENTOS_SESSION_TOKEN", "AGENTOS_FENCING_TOKEN"].includes(envVar)) {
          throw new Error(`Secret grant may not override reserved principal variable ${envVar}`);
        }
        if (grantedEnvironmentVariables.has(envVar)) throw new Error(`Duplicate effective secret envVar ${envVar}`);
        grantedEnvironmentVariables.add(envVar);
      }
      let implementationRange: Awaited<ReturnType<typeof pinnedImplementationRange>>;
      try {
        implementationRange = await pinnedImplementationRange(tx, candidate.task);
        if (implementationRange && implementationRange.implementationHeadSha !== candidate.targetBranch) {
          throw new PinnedRunTargetError(
            candidate.id,
            candidate.targetBranch,
            implementationRange.implementationHeadSha,
          );
        }
      } catch (error: unknown) {
        if (!isCandidateActivationFailure(error)) throw error;
        const reason = namedFailureReason(error);
        const parked = await parkQueuedCandidate(candidate, {
          reason,
          condition: "candidate-activation-failed",
          activityBody: `Queued run activation failed: ${reason}`,
          inboxBody: `Queued run activation failed and the task was parked in Backlog: ${reason}`,
          metadata: { failureType: error.name, reason },
        });
        if (parked.chainLocked) return HALT;
        return SKIP;
      }
      const blindReviewTask = isCanonicalBlindFindingsStep(candidate.task.templateStep);
      const declaredPriorOutputKinds = candidate.task.templateStep === null
        ? null
        : [...new Set(candidate.task.templateStep.priorOutputKinds)];
      const legacyAllPriorOutputs = declaredPriorOutputKinds?.includes(LEGACY_ALL_PRIOR_OUTPUTS) === true;
      const priorOutputs = !blindReviewTask
        && candidate.task.chainId && candidate.task.chainIndex !== null
        ? await tx.taskStepOutput.findMany({
          where: {
            task: {
              projectId: candidate.task.projectId,
              chainId: candidate.task.chainId,
              chainIndex: { lt: candidate.task.chainIndex },
            },
            ...(declaredPriorOutputKinds === null || legacyAllPriorOutputs
              ? {}
              : { kind: { in: declaredPriorOutputKinds } }),
          },
          select: { kind: true, body: true, task: { select: { name: true, chainIndex: true } } },
          orderBy: { task: { chainIndex: "asc" } },
        })
        : [];
      if (declaredPriorOutputKinds !== null) {
        const presentKinds = new Set(priorOutputs.map(({ kind }) => kind));
        const missingKinds = legacyAllPriorOutputs
          ? []
          : declaredPriorOutputKinds.filter((kind) => !presentKinds.has(kind));
        if (missingKinds.length > 0) {
          const reason = `Prior output claim refused: missing declared output kind${missingKinds.length === 1 ? "" : "s"}: ${missingKinds.join(", ")}`;
          await parkQueuedCandidate(candidate, {
            reason,
            condition: PRIOR_OUTPUT_MISSING_REASON,
            activityBody: `Prior output claim stopped: ${reason}`,
            inboxBody: `Prior output claim failed and the task was parked in Backlog: ${reason}`,
            metadata: { missingKinds },
          });
          return { error: reason, reason: PRIOR_OUTPUT_MISSING_REASON };
        }
      }
      const prepared = await prepareSpecificationVerification(
        tx,
        { task: candidate.task, repo: candidate.repo, branch: candidate.branch },
        implementationRange?.implementationHeadSha ?? null,
      );
      if (prepared.status === "refused") {
        await parkQueuedCandidate(candidate, {
          reason: prepared.refusal.message,
          condition: prepared.refusal.reason,
          activityBody: `Review claim stopped: ${prepared.refusal.message}`,
          inboxBody: `Review claim failed and the task was parked in Backlog: ${prepared.refusal.message}`,
          metadata: { classification: prepared.refusal.classification },
        });
        return SKIP;
      }
      if (prepared.status === "ready") {
        const deferralState = await specificationReadDeferralState(candidate);
        if (deferralState && now.getTime() >= deferralState.budgetDeadlineAt.getTime()) {
          return exhaustTransientSpecificationRead(
            candidate,
            deferralState,
            prepared.verification.implementationHeadSha,
          );
        }
        if (!verificationResults.has(prepared.verification.key)) {
          // Repository I/O must not happen while this serializable transaction
          // holds candidate/chain rows. The outer claim loop performs the read
          // and retries the transaction with the cached verdict.
          return { verification: prepared.verification };
        }
        const refusal = verificationResults.get(prepared.verification.key) ?? null;
        if (refusal) {
          if (refusal.classification === "transient") {
            return deferTransientSpecificationRead(
              candidate,
              refusal,
              prepared.verification.implementationHeadSha,
              deferralState,
            );
          }
          await parkQueuedCandidate(candidate, {
            reason: refusal.message,
            condition: refusal.reason,
            activityBody: `Review claim stopped: ${refusal.message}`,
            inboxBody: `Review claim failed and the task was parked in Backlog: ${refusal.message}`,
            metadata: {
              classification: refusal.classification,
              implementationHeadSha: prepared.verification.implementationHeadSha,
            },
          });
          return refusal.reason === SPEC_TRANSCRIPTION_REFUSAL_REASON
            ? { error: refusal.message, reason: refusal.reason }
            : SKIP;
        }
      }
      const generation = candidate.leaseGeneration + 1;
      const fencingToken = makeFencingToken(candidate.id, generation);
      const sessionCredential = issueSessionToken();
      const leaseExpiresAt = new Date(now.getTime() + body.leaseSeconds * 1000);
      const lockedTask = await lockTaskMutationRows(tx, candidate.task.id);
      if (!lockedTask) return SKIP;
      if (candidate.task.chainId !== null) {
        // `claimRun` is SERIALIZABLE, so its transaction snapshot predates a
        // Hold that committed while this claim waited for the Chain mutex.
        // Read through a fresh connection after taking that mutex. Hold and
        // Resume both need the same Task locks, so this live row cannot change
        // until the claim transaction decides and releases them.
        const control = await db.chainControl.findUnique({
          where: { projectId_chainId: {
            projectId: candidate.task.projectId,
            chainId: candidate.task.chainId,
          } },
          select: { state: true, heldLayer: true },
        });
        const taskLayer = candidate.task.chainLayer ?? candidate.task.chainIndex;
        if (control?.state === ChainControlState.HELD
          && (control.heldLayer === null || taskLayer === null || taskLayer > control.heldLayer)) {
          // The Chain mutex was acquired after the candidate scan. Hold may
          // have won that race, so the live authority under this lock decides.
          // End the scan while retaining lock order; the Run stays QUEUED.
          return HALT;
        }
      }
      const won = await tx.run.updateMany({
        where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
        data: {
          status: RunStatus.CLAIMED,
          runnerId: body.runnerId,
          leaseGeneration: generation,
          fencingToken,
          heartbeatAt: now,
          lastProcessAliveAt: now,
          leaseExpiresAt,
          claimedAt: now,
          sessionTokenHash: sessionCredential.hash,
          sessionTokenExpiresAt: new Date(now.getTime() + candidate.maxDurationMin * 60_000),
          sessionTokenRevokedAt: null,
        },
      });
      if (won.count !== 1) return SKIP;
      const priorResume = candidate.session?.resumeInput && candidate.session.providerConversationId ? {
        providerConversationId: candidate.session.providerConversationId,
        input: candidate.session.resumeInput,
      } : null;
      const session = candidate.session ? await tx.session.update({
        where: { id: candidate.session.id },
        data: {
          executionStatus: SessionExecutionStatus.PROVISIONING,
          cleanupStatus: CleanupStatus.PENDING,
          requestedAt: now,
          endedAt: null,
          failureReason: null,
        },
      }) : await tx.session.create({ data: {
          runId: candidate.id,
          projectId: candidate.projectId,
          agentId: candidate.agentId,
          taskId: candidate.taskId,
          goalId: candidate.goalId,
          runner: candidate.runner,
          executionStatus: SessionExecutionStatus.PROVISIONING,
          maxDurationMin: candidate.maxDurationMin,
          stallTimeoutMin: candidate.stallTimeoutMin,
        } });
      const latestEvent = await tx.sessionEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } });
      await tx.task.update({ where: { id: candidate.task.id }, data: { status: TaskStatus.DOING, failureReason: null } });
      await tx.taskActivity.create({
        data: {
          taskId: candidate.task.id,
          actorType: "runner",
          actorId: body.runnerId,
          body: `Run ${candidate.runNumber} claimed with fencing generation ${generation}`,
        },
      });
      const secrets: Record<string, string> = {};
      for (const { envVar, secret } of grants) {
        secrets[envVar] = decryptSecret(secret.encryptedValue, secret.ciphertextVersion);
      }
      const run = await tx.run.findUniqueOrThrow({ where: { id: candidate.id } });
      const previousRunHandoff = await previousRunHandoffForClaim(tx, {
        taskId: candidate.task.id,
        runId: candidate.id,
        runNumber: candidate.runNumber,
        templateStep: candidate.task.templateStep,
      });
      const chainFirstRun = candidate.task.chainId && candidate.task.chainIndex !== null
        ? await tx.run.findFirst({
          where: {
            repoId: candidate.repo.id,
            task: {
              projectId: candidate.task.projectId,
              chainId: candidate.task.chainId,
              chainIndex: { not: null },
            },
          },
          select: { targetBranch: true },
          orderBy: [{ task: { chainIndex: "asc" } }, { runNumber: "asc" }],
        })
        : null;
      const operatorNotes = blindReviewTask
        ? []
        : await operatorNotesForClaim(tx, candidate.task.id, candidate.runNumber, candidate.task.createdAt);
      const targetBranchPublished = run.targetBranch !== null && await tx.run.findFirst({
        where: {
          repoId: candidate.repo.id,
          pushedBranch: run.targetBranch,
          task: candidate.task.chainId && candidate.task.chainIndex !== null
            ? {
              projectId: candidate.task.projectId,
              chainId: candidate.task.chainId,
              chainIndex: { not: null },
            }
            : { id: candidate.task.id },
        },
        select: { id: true },
      }) !== null;
      const specificationMaterialization = specificationMaterializationForDirectImplementation(
        candidate.task,
        run.branch,
      );
      return {
        outcome: "claimed" as const,
        claim: {
          task: candidate.task,
          agent: candidate.agent,
          repo: candidate.repo,
          // Server-computed from the template step. Nothing a client sends
          // participates, and the ordinary runner refuses `mechanical` before it
          // constructs a workspace, a prompt, or a child environment.
          executionMode,
          // A later chain run targets the shared head, so its own targetBranch
          // cannot tell delivery which integration line the chain started
          // from. Carry the first run's durable base separately for PR create.
          run: {
            ...run,
            targetBranchPublished,
            pullRequestBase: chainFirstRun?.targetBranch ?? candidate.repo.defaultBranch,
            pinnedBaseSha: candidate.task.templateStep?.baseFromStepIndex == null ? null : run.targetBranch,
            implementationBaseSha: implementationRange?.implementationBaseSha ?? null,
            implementationHeadSha: implementationRange?.implementationHeadSha ?? null,
          },
          session,
          runner: candidate.runner,
          fencingToken,
          sessionToken: sessionCredential.token,
          secrets,
          priorOutputs,
          operatorNotes,
          previousRunHandoff,
          regressionRepairHandoff: regressionRepairHandoff.status === "ok"
            ? regressionRepairHandoff.handoff
            : null,
          specificationMaterialization,
          resume: priorResume,
          nextEventSeq: (latestEvent._max.seq ?? -1) + 1,
        },
      };
    };

    // Per-candidate isolation. A candidate that raises inside the shared claim
    // transaction used to abort it whole: the poisoned head of the queue rolled
    // back its own settlement *and* starved every other queued run, because the
    // transaction was already aborted by the time the loop reached them. Each
    // candidate now runs against its own savepoint, so its partial writes are
    // undone and the transaction stays usable for the rest of the queue.
    //
    // A serialization failure or deadlock is not isolatable: Postgres aborts the
    // whole transaction, `ROLLBACK TO SAVEPOINT` would fail too, and the outer
    // six-attempt retry is the correct response. It is re-raised untouched.
    let isolated: unknown = null;
    for (const [index, candidate] of candidates.entries()) {
      const savepoint = `claim_candidate_${index}`;
      await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
      let decided: Awaited<ReturnType<typeof activateCandidate>>;
      try {
        decided = await activateCandidate(candidate);
      } catch (error: unknown) {
        if (isSerializationConflict(error)) throw error;
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        console.error(`Claim candidate ${candidate.id} failed and was isolated from the claim`, error);
        isolated ??= error;
        continue;
      }
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      // A chained park that committed ends the claim here on purpose (lock
      // order), and it outranks an earlier candidate's isolated error.
      if ("verification" in decided || "error" in decided) return decided;
      if (decided.outcome === "halt") return null;
      if (decided.outcome === "claimed") return decided.claim;
    }
    // Isolation keeps one poisoned candidate from starving the others; it does
    // not make its failure disappear. With nothing claimed there is no work to
    // report and no reason to swallow it, so the first isolated error is the
    // answer this poll gives.
    if (isolated !== null) throw isolated;
    return null;
  }, { attempts: 6 });

  for (;;) {
    const attempted = await transactionalAttempt();
    if (!attempted || !("verification" in attempted)) return attempted;

    // The repository read is deliberately outside the serializable claim
    // transaction. A slow provider must not hold Run, Task, or chain locks.
    const verdict: SpecificationRefusal | null = await verifyPreparedSpecification(
      attempted.verification,
      input.specificationReader,
      input.signal ?? new AbortController().signal,
    );
    verificationResults.set(attempted.verification.key, verdict);
  }
};

export type ClaimedRun = NonNullable<Awaited<ReturnType<typeof claimRun>>>;
