import {
  InboxStatus,
  RunStatus,
  TaskStatus,
  type PrismaClient,
} from "@agentos/db";

/**
 * Reconciliation for the two merge-tail parks that no longer have an owner.
 *
 * The independent blind review and the release-authority re-signature were both
 * retired. Each of them used to park a merge-tail step in REVIEW under a named
 * `failureReason` prefix, and each owned the only path back out: the review
 * completion handler and the resign worker respectively. Both are deleted, and
 * the readiness worker only ever scans TODO and DOING, so a step parked under
 * either prefix at upgrade time is invisible to every remaining mechanism -- it
 * would sit there forever with nothing looking at it.
 *
 * This is a one-time upgrade reconciliation, expressed as an idempotent sweep
 * rather than a migration: it names the exact retired prefixes, and once a
 * database has no rows carrying them it does nothing on every later start. It
 * is deliberately not a silent repair. Every row it moves gets a control-plane
 * activity saying which retired mechanism had parked it, so an operator reading
 * the task can tell an upgrade unpark from an ordinary requeue.
 */

/** The failure reason a merge-readiness step carried while a retired independent review was open. */
export const RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX = "independent-review-open:";

/** The failure reason a regression step carried while it waited for a retired re-signature. */
export const RETIRED_AUTHORITY_RESIGN_OPEN_PREFIX = "authority-resign-open:";

/** The dedupe key prefix of the inbox message that carried a retired re-signature request. */
export const RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX = "authority-resign:";

/** The name every merge-tail independent review task was created under. */
export const RETIRED_INDEPENDENT_REVIEW_TASK_NAME = "Autonomous merge tail: independent review";

const ACTIVE_RUN_STATUSES = [
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
] as const;

export type RetiredParkReconciliation = {
  /** Readiness steps released from the retired independent-review park. */
  unparkedReviews: number;
  /** Regression steps released from the retired authority-resign park. */
  unparkedResigns: number;
  /** Orphaned independent-review tasks archived. */
  archivedReviewTasks: number;
  /** Queued runs of those orphaned review tasks cancelled. */
  cancelledReviewRuns: number;
  /** Open re-signature inbox messages closed. */
  closedResignMessages: number;
  /**
   * Orphaned review tasks left alone because a run was still active on them.
   * The run's own lease reconciliation owns that case; this sweep refuses to
   * archive a task out from under a runner rather than racing it.
   */
  reviewTasksWithActiveRuns: number;
};

/**
 * The review task id embedded in a retired park reason.
 *
 * The reason is `independent-review-open:<reviewTaskId>` and, when the park was
 * written at obligation time rather than at re-park time, `:<headSha>` follows.
 * Ids never contain a colon, so the first segment is the id in both shapes.
 */
export const retiredReviewTaskIdFromReason = (failureReason: string): string | null => {
  if (!failureReason.startsWith(RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX)) return null;
  const taskId = failureReason.slice(RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX.length).split(":")[0] ?? "";
  return taskId.length > 0 ? taskId : null;
};

export const reconcileRetiredMergeTailParks = async (
  db: PrismaClient,
  now = new Date(),
): Promise<RetiredParkReconciliation> => {
  const result: RetiredParkReconciliation = {
    unparkedReviews: 0,
    unparkedResigns: 0,
    archivedReviewTasks: 0,
    cancelledReviewRuns: 0,
    closedResignMessages: 0,
    reviewTasksWithActiveRuns: 0,
  };

  const parkedReviews = await db.task.findMany({
    where: {
      status: TaskStatus.REVIEW,
      failureReason: { startsWith: RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX },
    },
    select: { id: true, failureReason: true },
    orderBy: { id: "asc" },
  });
  for (const parked of parkedReviews) {
    await db.task.update({
      where: { id: parked.id },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    await db.taskActivity.create({ data: {
      taskId: parked.id,
      actorType: "control-plane",
      body: "The independent blind review was retired; this step was parked on it and is returned to the queue. The defense list is now audit-only and does not hold a merge.",
    } });
    result.unparkedReviews += 1;
  }

  const parkedResigns = await db.task.findMany({
    where: {
      status: TaskStatus.REVIEW,
      failureReason: { startsWith: RETIRED_AUTHORITY_RESIGN_OPEN_PREFIX },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const parked of parkedResigns) {
    await db.task.update({
      where: { id: parked.id },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    await db.taskActivity.create({ data: {
      taskId: parked.id,
      actorType: "control-plane",
      body: "The release-authority signature layer was retired; this step was parked waiting for a re-signature that is no longer required, and is returned to the queue.",
    } });
    result.unparkedResigns += 1;
  }

  const openResignMessages = await db.inboxMessage.findMany({
    where: {
      status: InboxStatus.OPEN,
      dedupeKey: { startsWith: RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  if (openResignMessages.length > 0) {
    result.closedResignMessages = (await db.inboxMessage.updateMany({
      where: { id: { in: openResignMessages.map((message) => message.id) } },
      data: { status: InboxStatus.CLOSED },
    })).count;
  }

  const orphanedReviews = await db.task.findMany({
    where: { name: RETIRED_INDEPENDENT_REVIEW_TASK_NAME, archivedAt: null },
    select: {
      id: true,
      _count: { select: { runs: { where: { status: { in: [...ACTIVE_RUN_STATUSES] } } } } },
    },
    orderBy: { id: "asc" },
  });
  for (const review of orphanedReviews) {
    if (review._count.runs > 0) {
      result.reviewTasksWithActiveRuns += 1;
      await db.taskActivity.create({ data: {
        taskId: review.id,
        actorType: "control-plane",
        body: "The independent blind review was retired while a run was still active on this task. It is left unarchived on purpose; the run's own reconciliation settles it, and nothing consumes its output any more.",
      } });
      continue;
    }
    result.cancelledReviewRuns += (await db.run.updateMany({
      where: { taskId: review.id, status: RunStatus.QUEUED },
      data: { status: RunStatus.CANCELLED },
    })).count;
    await db.task.update({ where: { id: review.id }, data: { archivedAt: now } });
    await db.taskActivity.create({ data: {
      taskId: review.id,
      actorType: "control-plane",
      body: "The independent blind review was retired; nothing reads this task's output any more, so it is archived and its queued run cancelled.",
    } });
    result.archivedReviewTasks += 1;
  }

  return result;
};
