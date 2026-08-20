import {
  CleanupStatus,
  FailureClass,
  InboxStatus,
  lockTaskRow,
  resolveRequeueBase,
  resolveRunBranches,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
  type PrismaClient,
} from "@agentos/db";

import { makeDedupeKey } from "./execution.js";
import { openReclaimIntentCount } from "./workspace-reclaim.js";

const activeStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] as const;
const archivedNoticePageSize = 100;
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

export const reconcileDatabaseRuns = async (db: PrismaClient, now = new Date()): Promise<number> => {
  const [candidates, expiredInboxRuns] = await Promise.all([
    db.run.findMany({
      where: {
        status: { in: [...activeStatuses] },
        OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
      },
      select: {
        heartbeatAt: true,
        id: true,
        projectId: true,
        taskId: true,
        goalId: true,
        agentId: true,
        repoId: true,
        runNumber: true,
        runner: true,
        model: true,
        targetBranch: true,
        branch: true,
        promptHash: true,
        maxDurationMin: true,
        stallTimeoutMin: true,
        maxRunsPerTask: true,
        budgetGrants: true,
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
  const orphans = candidates.filter((run) => !(
    run.heartbeatAt && now.getTime() - run.heartbeatAt.getTime() < run.stallTimeoutMin * 60_000
  ));
  if (orphans.length === 0 && expiredInboxRuns.length === 0) return 0;
  await db.$transaction(async (tx) => {
    for (const run of orphans) {
      // Order PATCH and retry creation through the same Task-row mutex. The
      // task is re-read after this lock before opensPullRequest is snapshotted.
      if (run.taskId) await lockTaskRow(tx, run.taskId);
      // Losing a lease is an external failure: it buys an attempt, never spends one.
      const budgetCeiling = run.maxRunsPerTask + 1;
      // The same grant, recorded apart from the ceiling it produced, so the
      // gates an operator reaches can still tell it from the configured budget
      // after that budget changes. See `runBudgetCeiling`.
      const budgetGrants = run.budgetGrants + 1;
      const lost = await tx.run.updateMany({
        where: { id: run.id, status: { in: [...activeStatuses] } },
        data: {
          status: RunStatus.LOST,
          endedAt: now,
          leaseExpiresAt: null,
          sessionTokenRevokedAt: now,
          failureClass: FailureClass.TRANSIENT_PROVIDER,
          retryable: true,
          maxRunsPerTask: budgetCeiling,
          budgetGrants,
          failureReason: "Run orphaned or lease expired during startup reconciliation",
        },
      });
      if (lost.count !== 1) continue;
      await tx.session.updateMany({
        where: { runId: run.id },
        data: {
          executionStatus: SessionExecutionStatus.LOST,
          cleanupStatus: CleanupStatus.PENDING,
          endedAt: now,
          failureReason: "Run orphaned or lease expired during startup reconciliation",
        },
      });
      if (!run.taskId) continue;
      if (run.runNumber < budgetCeiling) {
        // Chain steps recompute; everything else keeps the lost run's own base,
        // because the resolver's non-chain answer reads the *task's* current
        // targetBranch and the lost run's may predate an operator edit. That
        // snapshot still has to answer to publication evidence, though:
        // copying it verbatim requeued a pre-fix run onto the very ref no
        // remote had (issue #118), and dropped a salvage the lost run pushed.
        const task = await tx.task.findUnique({
          where: { id: run.taskId },
          select: {
            id: true, projectId: true, repoId: true, chainId: true, chainIndex: true, templateId: true,
            targetBranch: true, opensPullRequest: true,
            repo: { select: { defaultBranch: true } },
          },
        });
        // `prior` is null deliberately: for chain steps the resolver ignores it,
        // and passing the lost run would be misleading.
        const branches = task?.chainId && task.chainIndex !== null && !task.templateId && task.repo
          ? await resolveRunBranches(tx, { ...task, repo: task.repo }, null)
          : {
            branch: run.branch,
            targetBranch: task?.repo
              ? await resolveRequeueBase(tx, { ...task, repo: task.repo }, run)
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
            dedupeKey: makeDedupeKey(run.taskId, run.runNumber + 1),
            runner: run.runner,
            model: run.model,
            targetBranch: branches.targetBranch,
            branch: branches.branch,
            opensPullRequest: task?.opensPullRequest ?? true,
            promptHash: run.promptHash,
            maxDurationMin: run.maxDurationMin,
            stallTimeoutMin: run.stallTimeoutMin,
            maxRunsPerTask: budgetCeiling,
            budgetGrants,
          },
        });
        await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DOING, failureReason: null } });
        await tx.taskActivity.create({
          data: { taskId: run.taskId, actorType: "control-plane", body: `Run ${run.runNumber} lost; retry ${run.runNumber + 1} queued` },
        });
      } else {
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
      const expired = await tx.run.updateMany({
        where: { id: run.id, status: RunStatus.WAITING_INBOX },
        data: {
          status: RunStatus.TIMED_OUT,
          endedAt: now,
          retryable: false,
          failureClass: FailureClass.CANCELLED_OR_TIMED_OUT,
          failureReason: "Inbox response window expired",
        },
      });
      if (expired.count !== 1) continue;
      if (run.session) {
        await tx.session.updateMany({
          where: { id: run.session.id, executionStatus: SessionExecutionStatus.WAITING_INBOX },
          data: {
            executionStatus: SessionExecutionStatus.TIMED_OUT,
            cleanupStatus: CleanupStatus.RETAINED,
            endedAt: now,
            cleanupEndedAt: now,
            failureReason: "Inbox response window expired",
          },
        });
      }
      if (run.session?.waitingOnMessageId) {
        await tx.inboxMessage.updateMany({
          where: { id: run.session.waitingOnMessageId, status: InboxStatus.OPEN },
          data: { status: InboxStatus.CLOSED },
        });
      }
      if (run.taskId) {
        await tx.task.update({
          where: { id: run.taskId },
          data: { status: TaskStatus.REVIEW, failureReason: "Inbox response window expired" },
        });
        await tx.taskActivity.create({
          data: { taskId: run.taskId, actorType: "control-plane", body: "Inbox response window expired; run moved to review" },
        });
      }
    }
  });
  return orphans.length + expiredInboxRuns.length;
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
): Promise<{ runs: number; openReclaimIntents: number; archivedNotices: number }> => ({
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
