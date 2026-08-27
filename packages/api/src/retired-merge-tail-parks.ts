import {
  enqueueTaskRun,
  InboxStatus,
  RunStatus,
  TaskStatus,
  type Prisma,
  type PrismaClient,
} from "@agentos/db";

import { lockTaskMutationRows } from "./task-write.js";

/**
 * Reconciliation for the two merge-tail parks that no longer have an owner.
 *
 * The independent blind review and the release-authority re-signature were both
 * retired. Each of them used to park a merge-tail step in REVIEW under a named
 * `failureReason`, and each owned the only path back out: the review completion
 * handler and the resign worker respectively. Both are deleted, and the
 * readiness worker only ever scans TODO and DOING, so a step parked under
 * either prefix at upgrade time is invisible to every remaining mechanism -- it
 * would sit there forever with nothing looking at it.
 *
 * This is a one-time upgrade reconciliation, expressed as an idempotent sweep
 * rather than a migration: it names the exact retired prefixes, and once a
 * database has no rows carrying them it does nothing on every later start.
 *
 * Every row it moves is locked and re-read first. The API runs on more than one
 * host against one database, so two instances can start at once, and a runner
 * can claim a run between this sweep's scan and its write. The scan is
 * discovery only; the transaction decides. A row that someone else already
 * moved is left exactly as they left it.
 *
 * It is also deliberately not a silent repair. Every row it moves gets a
 * control-plane activity saying which retired mechanism had parked it, so an
 * operator reading the task can tell an upgrade unpark from an ordinary
 * requeue.
 */

/** The failure reason a merge-readiness step carried while a retired independent review was open. */
export const RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX = "independent-review-open:";

/** The failure reason a regression step carried while it waited for a retired re-signature. */
export const RETIRED_AUTHORITY_RESIGN_OPEN_PREFIX = "authority-resign-open:";

/** The dedupe key prefix of the inbox message that carried a retired re-signature request. */
export const RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX = "authority-resign:";

/** The name every merge-tail independent review task was created under. */
export const RETIRED_INDEPENDENT_REVIEW_TASK_NAME = "Autonomous merge tail: independent review";

/**
 * The marker kind the retired `createReviewObligation` wrote on both the
 * readiness task and the review task it opened.
 *
 * It is a string literal rather than a `MERGE_TAIL_KIND` member because the
 * member was deleted with the mechanism. These rows survive as inert history,
 * and that history is the only control-plane evidence that a given task really
 * was opened by the merge tail rather than named to look like it.
 */
export const RETIRED_REVIEW_OBLIGATION_MARKER_KIND = "mergeTail.reviewObligation";

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
  /** Runs queued for the regression steps that were released. */
  queuedResignRuns: number;
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
  /** Rows another instance, or an operator, had already moved. */
  alreadyResolved: number;
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

type Tx = Prisma.TransactionClient;

/**
 * Write a control-plane note unless the same note is already on the task.
 *
 * The branches that report rather than change something are not convergent:
 * they see the same row on every start. Without this they would stack an
 * identical activity per restart until the underlying condition is cleared by
 * hand.
 */
const noteOnce = async (tx: Tx, taskId: string, body: string): Promise<void> => {
  const existing = await tx.taskActivity.count({ where: { taskId, actorType: "control-plane", body } });
  if (existing > 0) return;
  await tx.taskActivity.create({ data: { taskId, actorType: "control-plane", body } });
};

const REVIEW_UNPARK_NOTE = "The independent blind review was retired; this step was parked on it and is returned to the queue. The defense list is now audit-only and does not hold a merge.";
const RESIGN_UNPARK_NOTE = "The release-authority signature layer was retired; this step was parked waiting for a re-signature that is no longer required, so it is returned to the queue with a fresh run.";
const REVIEW_ARCHIVE_NOTE = "The independent blind review was retired; nothing reads this task's output any more, so it is archived and its queued run cancelled.";
const REVIEW_ACTIVE_RUN_NOTE = "The independent blind review was retired while a run was still active on this task. It is left unarchived on purpose; the run's own reconciliation settles it, and nothing consumes its output any more.";

export const reconcileRetiredMergeTailParks = async (
  db: PrismaClient,
  now = new Date(),
): Promise<RetiredParkReconciliation> => {
  const result: RetiredParkReconciliation = {
    unparkedReviews: 0,
    unparkedResigns: 0,
    queuedResignRuns: 0,
    archivedReviewTasks: 0,
    cancelledReviewRuns: 0,
    closedResignMessages: 0,
    reviewTasksWithActiveRuns: 0,
    alreadyResolved: 0,
  };

  // Discovery only. The park reasons are read here because unparking clears
  // them, and they name the review tasks this sweep is allowed to archive.
  const parkedReviews = await db.task.findMany({
    where: {
      status: TaskStatus.REVIEW,
      failureReason: { startsWith: RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX },
    },
    select: { id: true, failureReason: true },
    orderBy: { id: "asc" },
  });
  const reviewTaskIdsNamedByAPark = new Set(
    parkedReviews.flatMap((parked) => {
      const reviewTaskId = parked.failureReason ? retiredReviewTaskIdFromReason(parked.failureReason) : null;
      return reviewTaskId ? [reviewTaskId] : [];
    }),
  );

  for (const parked of parkedReviews) {
    const moved = await db.$transaction(async (tx) => {
      await lockTaskMutationRows(tx, parked.id);
      // The readiness worker claims TODO itself, so returning the row to the
      // queue is the whole resume. No run is opened here, exactly as the
      // retired completion path did it.
      const released = await tx.task.updateMany({
        where: {
          id: parked.id,
          status: TaskStatus.REVIEW,
          failureReason: { startsWith: RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX },
        },
        data: { status: TaskStatus.TODO, failureReason: null },
      });
      if (released.count !== 1) return false;
      await tx.taskActivity.create({ data: {
        taskId: parked.id,
        actorType: "control-plane",
        body: REVIEW_UNPARK_NOTE,
      } });
      return true;
    });
    if (moved) result.unparkedReviews += 1;
    else result.alreadyResolved += 1;
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
    const closedForThisPark = await db.$transaction(async (tx) => {
      await lockTaskMutationRows(tx, parked.id);
      const released = await tx.task.updateMany({
        where: {
          id: parked.id,
          status: TaskStatus.REVIEW,
          failureReason: { startsWith: RETIRED_AUTHORITY_RESIGN_OPEN_PREFIX },
        },
        data: { status: TaskStatus.TODO, failureReason: null },
      });
      if (released.count !== 1) return null;
      // A regression step is agent-executed: nothing claims it from TODO on its
      // own, so the retired resign worker opened the run itself after its own
      // CAS. Reproduced here, or the step swaps one invisible state for another.
      await enqueueTaskRun(tx, parked.id, now);
      await tx.taskActivity.create({ data: {
        taskId: parked.id,
        actorType: "control-plane",
        body: RESIGN_UNPARK_NOTE,
      } });
      const closed = await tx.inboxMessage.updateMany({
        where: {
          dedupeKey: { startsWith: `${RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX}${parked.id}:` },
          status: InboxStatus.OPEN,
        },
        data: { status: InboxStatus.CLOSED, answeredAt: now },
      });
      return closed.count;
    });
    if (closedForThisPark === null) {
      result.alreadyResolved += 1;
    } else {
      result.unparkedResigns += 1;
      result.queuedResignRuns += 1;
      result.closedResignMessages += closedForThisPark;
    }
  }

  // Any request left over from a park that is already gone. Filtering on OPEN
  // makes this convergent on its own.
  result.closedResignMessages += (await db.inboxMessage.updateMany({
    where: {
      dedupeKey: { startsWith: RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX },
      status: InboxStatus.OPEN,
    },
    data: { status: InboxStatus.CLOSED, answeredAt: now },
  })).count;

  // A task name is operator-writable, so it narrows the candidates and never
  // decides. What decides is control-plane evidence: the obligation marker the
  // retired opener wrote, or a retired park reason naming this task.
  const markedReviewTaskIds = (await db.taskActivity.findMany({
    where: {
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: RETIRED_REVIEW_OBLIGATION_MARKER_KIND },
    },
    select: { taskId: true },
  })).flatMap((activity) => activity.taskId ? [activity.taskId] : []);
  const evidenced = new Set([...markedReviewTaskIds, ...reviewTaskIdsNamedByAPark]);
  if (evidenced.size === 0) return result;

  const orphanedReviews = await db.task.findMany({
    where: {
      id: { in: [...evidenced] },
      name: RETIRED_INDEPENDENT_REVIEW_TASK_NAME,
      archivedAt: null,
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const review of orphanedReviews) {
    const outcome = await db.$transaction(async (tx) => {
      await lockTaskMutationRows(tx, review.id);
      const current = await tx.task.findUnique({
        where: { id: review.id },
        select: {
          archivedAt: true,
          _count: { select: { runs: { where: { status: { in: [...ACTIVE_RUN_STATUSES] } } } } },
        },
      });
      if (!current || current.archivedAt !== null) return { state: "already" as const, cancelled: 0 };
      // Re-read under the lock: a runner may have claimed the queued run
      // between the scan above and this write.
      if (current._count.runs > 0) {
        await noteOnce(tx, review.id, REVIEW_ACTIVE_RUN_NOTE);
        return { state: "active" as const, cancelled: 0 };
      }
      const cancelled = await tx.run.updateMany({
        where: { taskId: review.id, status: RunStatus.QUEUED },
        data: { status: RunStatus.CANCELLED },
      });
      await tx.task.update({ where: { id: review.id }, data: { archivedAt: now } });
      await tx.taskActivity.create({ data: {
        taskId: review.id,
        actorType: "control-plane",
        body: REVIEW_ARCHIVE_NOTE,
      } });
      return { state: "archived" as const, cancelled: cancelled.count };
    });
    if (outcome.state === "archived") {
      result.archivedReviewTasks += 1;
      result.cancelledReviewRuns += outcome.cancelled;
    } else if (outcome.state === "active") {
      result.reviewTasksWithActiveRuns += 1;
    } else {
      result.alreadyResolved += 1;
    }
  }

  return result;
};
