import {
  isRegressionVerificationOutputKind,
  lockTaskRow,
  openRun,
  runBudgetCeiling,
  RunStatus,
  TaskStatus,
  type PrismaClient,
} from "@anneal/db";

import {
  leaseHandoffsWithoutConsumer,
  noteLeaseHandoffReleased,
  releaseMergeLease,
  settleLease,
  type ReleaseMergeLease,
} from "./merge-lease.js";
import type { MergeLeaseTarget } from "./merge-lease-hold.js";
import { handleRegressionCompletion, regressionVerdictForRun } from "./merge-tail-actions.js";
import { openReclaimIntentCount } from "./workspace-reclaim.js";
import { terminalizeRun } from "./run-terminal.js";

const activeStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] as const;
const archivedNoticePageSize = 100;
const mergeLeaseTargetKey = (target: MergeLeaseTarget): string => JSON.stringify([target.projectId, target.chainId]);
export const archivedNoticeSweepIntervalMs = 60_000;

export const noteArchivedQueuedRuns = async (
  db: PrismaClient,
  options: { agentId?: string } = {},
): Promise<number> => {
  let cursor: string | undefined;
  let inserted = 0;
  do {
    const stalled = await db.run.findMany({
      where: {
        status: RunStatus.QUEUED,
        taskId: { not: null },
        agent: { archivedAt: { not: null } },
        ...(options.agentId ? { agentId: options.agentId } : {}),
      },
      select: {
        id: true,
        taskId: true,
        runNumber: true,
        agent: { select: { name: true, archivedAt: true } },
      },
      orderBy: { id: "asc" },
      take: archivedNoticePageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const rows = stalled.flatMap((run) => run.taskId && run.agent.archivedAt ? [{
      id: `archived-skip:${run.id}:${run.agent.archivedAt.toISOString()}`,
      taskId: run.taskId,
      actorType: "control-plane",
      body: `Assignee ${run.agent.name} is archived; run ${run.runNumber} stays queued and is not claimed until the agent is unarchived`,
    }] : []);
    if (rows.length > 0) {
      inserted += (await db.taskActivity.createMany({ data: rows, skipDuplicates: true })).count;
    }
    if (stalled.length < archivedNoticePageSize) break;
    cursor = stalled.at(-1)?.id;
  } while (cursor);
  return inserted;
};

export const createArchivedRunNoticeScheduler = (
  db: PrismaClient,
  intervalMs = archivedNoticeSweepIntervalMs,
): ((now?: Date) => Promise<number>) => {
  let nextSweepAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<number> | null = null;
  return async (now = new Date()) => {
    if (inFlight) return inFlight;
    if (now.getTime() < nextSweepAt) return 0;
    nextSweepAt = now.getTime() + intervalMs;
    inFlight = noteArchivedQueuedRuns(db);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
};

export const reconcileDatabaseRuns = async (
  db: PrismaClient,
  now = new Date(),
  releaseChainLease: ReleaseMergeLease = releaseMergeLease,
): Promise<number> => {
  const [candidates, expiredInboxRuns] = await Promise.all([
    db.run.findMany({
      where: {
        status: { in: [...activeStatuses] },
        OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
      },
      select: {
        heartbeatAt: true,
        leaseExpiresAt: true,
        cancelRequestId: true,
        cancelReason: true,
        cancelRequestedAt: true,
        id: true,
        projectId: true,
        taskId: true,
        goalId: true,
        agentId: true,
        repoId: true,
        runNumber: true,
        runner: true,
        model: true,
        codexServiceTier: true,
        subagentModel: true,
        subagentMaxConcurrent: true,
        targetBranch: true,
        branch: true,
        promptHash: true,
        maxDurationMin: true,
        stallTimeoutMin: true,
        maxRunsPerTask: true,
        budgetGrants: true,
        headSha: true,
        session: { select: { id: true } },
        task: {
          select: {
            id: true,
            projectId: true,
            repoId: true,
            templateId: true,
            chainId: true,
            chainIndex: true,
            targetBranch: true,
            templateStep: {
              select: {
                stepIndex: true,
                outputKind: true,
                taskTemplate: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    db.run.findMany({
      where: {
        status: RunStatus.WAITING_INBOX,
        session: { is: { resumableUntil: { lt: now } } },
      },
      select: {
        id: true,
        taskId: true,
        session: { select: { id: true, waitingOnMessageId: true } },
      },
    }),
  ]);
  // An api restart outlives a lease (60s) but not a heartbeat cycle. A run whose
  // runner is still checking in is alive — it renews its own lease on the next
  // heartbeat — so only silence beyond the stall timeout counts as death.
  const orphans = candidates.filter((run) => run.cancelRequestedAt !== null || !(
    run.heartbeatAt && now.getTime() - run.heartbeatAt.getTime() < run.stallTimeoutMin * 60_000
  ));
  const reconciliation = await db.$transaction(async (tx) => {
    const strandedHandoffs = await leaseHandoffsWithoutConsumer(tx, now);
    if (orphans.length === 0 && expiredInboxRuns.length === 0 && strandedHandoffs.length === 0) {
      return { strandedChainLeases: [] as MergeLeaseTarget[], strandedHandoffs, count: 0 };
    }
    // Chains whose tail run this sweep terminalizes without a successor. Held
    // until the sweep commits, because a lease released against a transaction
    // that then rolls back would free a window the chain still owns.
    // A Chain id is only unique within a project. Keep the project in the
    // release target and dedupe by both fields, otherwise one project's
    // reconciliation can suppress the other project's confirmed release and
    // its hold evidence.
    const stranded = new Map<string, MergeLeaseTarget>();
    for (const run of orphans) {
      const leaseLossReason = !run.leaseExpiresAt
        ? "Platform lease missing during startup reconciliation; runner heartbeat authority was lost"
        : run.heartbeatAt === null
          ? `Platform lease expired at ${run.leaseExpiresAt.toISOString()} without a recorded runner heartbeat`
          : `Runner heartbeat starved after ${run.heartbeatAt.toISOString()}; platform lease expired at ${run.leaseExpiresAt.toISOString()}`;
      // Run is the authority for cancellation, fencing, and terminalization.
      // Re-read it under its mutex before Task: the candidate list is only a
      // hint and may predate a cancellation that committed while this sweep
      // was starting.
      await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${run.id} FOR UPDATE`;
      const current = await tx.run.findFirst({
        where: {
          id: run.id,
          status: { in: [...activeStatuses] },
          OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
        },
        select: {
          cancelRequestId: true,
          cancelReason: true,
          cancelRequestedAt: true,
          headSha: true,
        },
      });
      if (!current) continue;
      if (current.cancelRequestId && current.cancelRequestedAt) {
        const terminal = await terminalizeRun(tx, {
          runId: run.id,
          at: now,
          outcome: {
            kind: "cancelled",
            requestId: current.cancelRequestId,
            cleanupConfirmed: false,
            activity: "runner-lost",
          },
        });
        if (terminal === null || "message" in terminal) continue;
        if (terminal.leaseToRelease) {
          stranded.set(mergeLeaseTargetKey(terminal.leaseToRelease), terminal.leaseToRelease);
        }
        continue;
      }
      // Order PATCH and retry creation through the same Task-row mutex. The
      // task is re-read after this lock before opensPullRequest is snapshotted.
      if (run.taskId) await lockTaskRow(tx, run.taskId);
      const durableRegressionVerdict = run.task?.templateId
        && isRegressionVerificationOutputKind(run.task.templateStep?.outputKind)
        ? await regressionVerdictForRun(tx, {
            task: run.task,
            runId: run.id,
            runHeadSha: current.headSha,
            allowPersistedHeadWhenUnreported: true,
          })
        : null;
      const durableNegativeRegressionVerdict = durableRegressionVerdict?.status === "ok"
        && durableRegressionVerdict.verdict.outcome !== "pass"
        ? durableRegressionVerdict.verdict
        : null;
      // Losing a lease is an external failure: it buys an attempt, never spends one.
      // A lost lease refunds the already-authorized Run; it does not recompute
      // from a task budget that may have changed while the Run was in flight.
      const budgetCeiling = runBudgetCeiling(run.maxRunsPerTask, 1);
      // The same grant, recorded apart from the ceiling it produced, so the
      // gates an operator reaches can still tell it from the configured budget
      // after that budget changes. See `runBudgetCeiling`.
      const budgetGrants = run.budgetGrants + 1;
      const lost = await terminalizeRun(tx, {
        runId: run.id,
        at: now,
        outcome: {
          kind: "lost",
          where: {
            id: run.id,
            cancelRequestedAt: null,
            status: { in: [...activeStatuses] },
            OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
          },
          reason: leaseLossReason,
          maxRunsPerTask: budgetCeiling,
          budgetGrants,
        },
      });
      if (lost === null || "message" in lost) continue;
      if (!run.taskId) continue;
      if (durableNegativeRegressionVerdict && run.task && run.session) {
        await handleRegressionCompletion(tx, {
          task: run.task,
          run: {
            id: run.id,
            agentId: run.agentId,
            branch: run.branch,
            headSha: durableNegativeRegressionVerdict.headSha,
            sessionId: run.session.id,
          },
          qualifiedVerdict: durableNegativeRegressionVerdict,
          now,
        });
        const lease = await settleLease(tx, { taskId: run.taskId, outcome: "stop" });
        if (lease.leaseToRelease) {
          stranded.set(mergeLeaseTargetKey(lease.leaseToRelease), lease.leaseToRelease);
        }
        await tx.taskActivity.create({
          data: {
            taskId: run.taskId,
            actorType: "control-plane",
            body: `Run ${run.runNumber} lost after publishing a negative Regression verdict; repair queued`,
          },
        });
        continue;
      }
      if (run.runNumber < budgetCeiling) {
        const opened = await openRun(tx, run.taskId, {
          kind: "retry-after-lease-loss",
          sourceRunId: run.id,
          sourceMaxRunsPerTask: run.maxRunsPerTask,
          sourceBudgetGrants: run.budgetGrants,
          readyAt: now,
        });
        if (opened.ok) {
          await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DOING, failureReason: null } });
          await tx.taskActivity.create({
            data: { taskId: run.taskId, actorType: "control-plane", body: `Run ${run.runNumber} lost; retry ${opened.run.runNumber} queued` },
          });
        } else {
          const lease = await settleLease(tx, { taskId: run.taskId, outcome: "stop" });
          if (lease.leaseToRelease) {
            stranded.set(mergeLeaseTargetKey(lease.leaseToRelease), lease.leaseToRelease);
          }
          await tx.task.update({
            where: { id: run.taskId },
            data: { status: TaskStatus.REVIEW, failureReason: `Lease-loss retry refused: ${opened.refusal.message}` },
          });
          await tx.taskActivity.create({
            data: { taskId: run.taskId, actorType: "control-plane", body: `Run ${run.runNumber} lost; automatic retry refused: ${opened.refusal.message}` },
          });
          await tx.inboxMessage.create({
            data: {
              from: "AGENT",
              taskId: run.taskId,
              kind: "TEXT",
              body: `Automatic retry refused after lease loss: ${opened.refusal.message}`,
            },
          });
        }
      } else {
        // Budget exhausted: no retry follows, so this lost run is the chain's
        // last word and its lease has no successor to hand itself to.
        const lease = await settleLease(tx, { taskId: run.taskId, outcome: "stop" });
        if (lease.leaseToRelease) {
          stranded.set(mergeLeaseTargetKey(lease.leaseToRelease), lease.leaseToRelease);
        }
        await tx.task.update({
          where: { id: run.taskId },
          data: { status: TaskStatus.REVIEW, failureReason: `Maximum ${budgetCeiling} runs reached after lease loss` },
        });
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            taskId: run.taskId,
            kind: "TEXT",
            body: "Run budget exhausted after lease loss; operator action required.",
          },
        });
      }
    }
    for (const run of expiredInboxRuns) {
      const expired = await terminalizeRun(tx, {
        runId: run.id,
        at: now,
        outcome: {
          kind: "timed-out",
          sessionId: run.session?.id ?? null,
          waitingOnMessageId: run.session?.waitingOnMessageId ?? null,
          taskId: run.taskId,
          reason: "Inbox response window expired",
        },
      });
      if (expired === null || "message" in expired) continue;
    }
    for (const handoff of strandedHandoffs) {
      const target = { chainId: handoff.chainId, projectId: handoff.projectId };
      stranded.set(mergeLeaseTargetKey(target), target);
    }
    return {
      strandedChainLeases: [...stranded.values()],
      strandedHandoffs,
      count: orphans.length + expiredInboxRuns.length + strandedHandoffs.length,
    };
  });
  const releaseFailures: unknown[] = [];
  for (const target of reconciliation.strandedChainLeases) {
    try {
      await releaseChainLease(target, db);
    } catch (error: unknown) {
      releaseFailures.push(error);
    }
  }
  if (reconciliation.strandedHandoffs.length > 0) {
    try {
      await db.$transaction(async (tx) => {
        for (const handoff of reconciliation.strandedHandoffs) {
          await noteLeaseHandoffReleased(tx, { ...handoff, at: now });
        }
      });
    } catch (error: unknown) {
      releaseFailures.push(error);
    }
  }
  if (releaseFailures.length > 0) {
    throw new AggregateError(releaseFailures, "One or more stranded merge lease releases or settlements failed");
  }
  return reconciliation.count;
};

/**
 * Startup reconciliation is now database work only.
 *
 * The root-wide filesystem sweep that used to live here is gone: workspace
 * disposal belongs to the runner that provisioned the directory (issue #115),
 * and the API publishes reclaim intents through /runner/workspaces/reclaimable
 * instead. `openReclaimIntents` is reported so an operator can see at a glance
 * whether anything is waiting on a runner that is not answering — with no
 * runner asking, workspaces leak, and leaking is the direction this side of
 * the boundary is allowed to fail in.
 */
export const reconcileAtStartup = async (
  db: PrismaClient,
): Promise<{
  runs: number;
  openReclaimIntents: number;
  archivedNotices: number;
}> => ({
  runs: await reconcileDatabaseRuns(db),
  openReclaimIntents: await openReclaimIntentCount(db).catch((error: unknown) => {
    console.error("Open reclaim intent count failed", error);
    return 0;
  }),
  archivedNotices: await noteArchivedQueuedRuns(db).catch((error: unknown) => {
    console.error("Archived-run startup notice failed", error);
    return 0;
  }),
});
