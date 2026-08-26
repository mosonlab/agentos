import {
  AssigneeType,
  compoundImplementationAssigneeValid,
  CompoundImplementationAssigneeError,
  isCompoundImplementationStep,
  lockAgentRow,
  lockChainRows,
  Prisma,
  type Task,
  TaskStatus,
} from "@agentos/db";

export type LockedTask = {
  id: string;
  status: TaskStatus;
  archivedAt: Date | null;
  projectId: string;
  chainId: string | null;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  templateStep: {
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string };
  } | null;
};

export const lockedTaskSelect = {
  id: true,
  status: true,
  archivedAt: true,
  projectId: true,
  chainId: true,
  assigneeType: true,
  assigneeAgentId: true,
  templateStep: {
    select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
  },
} satisfies Prisma.TaskSelect;

/**
 * The exclusion protocol every writer that can give a task a run shares.
 *
 * Start, retry, archive, archive-done and the AT fire all answer "may this task
 * gain a run right now?" in different transactions. Reading `runs` and then
 * writing is not atomic under ReadCommitted: PostgreSQL re-checks a predicate on
 * the *locked row* after a blocking write commits, but a subquery over another
 * table is re-evaluated against the statement's original snapshot. So the Task
 * row is the mutex — every writer takes it before it reads anything else.
 *
 * `fireCronTask` is already compliant: its claim is a single-statement CAS on
 * the Task row, whose predicate does get re-checked.
 */
export const lockTask = async (tx: Prisma.TransactionClient, taskId: string): Promise<LockedTask | null> => {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  if (!locked) return null;
  // Read the typed row only after the lock is held. $queryRaw hands back raw
  // PostgreSQL enum labels ('backlog'), not Prisma's member names, so comparing
  // its status against TaskStatus.BACKLOG silently never matches — and the lock
  // is exactly what makes this second read consistent for the rest of the
  // transaction.
  return tx.task.findUniqueOrThrow({
    where: { id: taskId },
    select: lockedTaskSelect,
  });
};

/**
 * The mutation entry point for a task whose chain identity is not already
 * known under a lock. Chain identity itself is immutable after dispatch, so an
 * unlocked identity read can safely choose the mutex without first taking one
 * Task row and later expanding to its siblings.
 */
export const lockTaskMutationRows = async (
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<LockedTask | null> => {
  const identity = await tx.task.findUnique({
    where: { id: taskId },
    select: { projectId: true, chainId: true },
  });
  if (!identity) return null;
  if (!identity.chainId) return lockTask(tx, taskId);
  await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
  return tx.task.findUnique({ where: { id: taskId }, select: lockedTaskSelect });
};

/**
 * The assignment half of the Agent-row exclusion protocol: the 400 message if
 * this agent may not be written onto a task right now, or null.
 *
 * Callers check the assignee once before the transaction to answer fast; this
 * re-read under `lockAgentRow` is the one that decides. Without it the check
 * and the write straddle a concurrent archive, and the task — or the run
 * created with it — belongs to an agent the runner will never claim for.
 */
export const assignmentBlocked = async (
  tx: Prisma.TransactionClient,
  assignee: { id: string; name: string } | null,
): Promise<string | null> => {
  if (!assignee) return null;
  const locked = await lockAgentRow(tx, assignee.id);
  if (!locked) return "Assignee does not belong to this project";
  return locked.archivedAt ? `Assignee ${assignee.name} is archived` : null;
};

/** Rechecks the compound binding after the Task lock and under the Agent lock.
 * The unlocked route check gives a fast refusal; this one decides against
 * concurrent archive or persisted-state corruption before the write commits. */
const assertCompoundImplementationAssignment = async (
  tx: Prisma.TransactionClient,
  task: LockedTask,
  assigneeType: AssigneeType,
  assigneeAgentId: string | null,
): Promise<void> => {
  if (task.archivedAt !== null || !isCompoundImplementationStep(task.templateStep)) return;
  const agent = assigneeAgentId ? await lockAgentRow(tx, assigneeAgentId) : null;
  if (!compoundImplementationAssigneeValid(task.projectId, assigneeType, agent, task.templateStep)) {
    throw new CompoundImplementationAssigneeError();
  }
};

export type TaskWriteRefusal =
  | { kind: "absent" }
  | { kind: "assignment-blocked"; reason: string };

/** The activity the write is accountable for. `taskId` is the module's to fill:
 *  it is the row the lock was taken on, not something a caller restates. */
export type TaskActivityInput = Omit<Prisma.TaskActivityUncheckedCreateInput, "taskId">;

/**
 * What the caller wants the locked task to become. `update: null` is a caller
 * that decided, under the lock, not to write — the transaction still commits
 * whatever it did before, exactly as an early `return` from its callback did.
 */
export type TaskWritePlan<T> = {
  update: Prisma.TaskUncheckedUpdateInput | null;
  activity: TaskActivityInput | null;
  value: T;
};

export type TaskWriteResult<T> =
  | {
    ok: true;
    /** The row as it was under the lock, before the update. */
    task: LockedTask;
    /** The updated row, or null when the plan wrote nothing. */
    written: Task | null;
    /** The id of the activity the plan asked for, for callers that reference it. */
    activityId: string | null;
    /**
     * The lock this write took covers a whole chain, not one row. A candidate
     * scan must end its transaction here: taking another candidate's Run next
     * could wait on a sibling Run whose claimant already waits for this chain
     * mutex.
     */
    chainLocked: boolean;
    value: T;
  }
  | { ok: false; refusal: TaskWriteRefusal };

/** Prisma accepts both `field: value` and `field: { set: value }`; the guards
 *  below read the intent out of either shape. */
const plannedScalar = <V>(value: unknown): V | undefined => {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === "object" && "set" in (value as object)) {
    return (value as { set: V }).set;
  }
  return value as V;
};

/**
 * The one way to write a task under its own mutex.
 *
 * It owns the three rules a caller used to restate: the lock is taken here and
 * everything the caller does happens inside the same transaction; the Agent row
 * is locked after the Task rows, never before; and a chained write expands the
 * lock to the whole chain, which `chainLocked` reports rather than leaving each
 * caller to rediscover from `chainId`.
 *
 * `change` computes the write, it does not perform one. The assignment guards
 * decide from the update it returns, so a callback that wrote first would have
 * its writes committed by a refusal that is supposed to leave the row alone.
 */
export const writeTask = async <T>(
  tx: Prisma.TransactionClient,
  taskId: string,
  change: (locked: LockedTask) => Promise<TaskWritePlan<T>>,
): Promise<TaskWriteResult<T>> => {
  const locked = await lockTaskMutationRows(tx, taskId);
  if (!locked) return { ok: false, refusal: { kind: "absent" } };
  const plan = await change(locked);
  if (plan.update) {
    const assigneeType = plannedScalar<AssigneeType>(plan.update.assigneeType);
    const assigneeAgentId = plannedScalar<string | null>(plan.update.assigneeAgentId);
    // Task rows first, then the Agent row — the one global lock order.
    if (assigneeType !== undefined || assigneeAgentId !== undefined) {
      await assertCompoundImplementationAssignment(
        tx,
        locked,
        assigneeType ?? locked.assigneeType,
        assigneeAgentId === undefined ? locked.assigneeAgentId : assigneeAgentId,
      );
      // The named assignee is re-read against the locked task's project, so the
      // project check and the archive check decide on the same row the write
      // lands on rather than on a pre-transaction read.
      const assignee = assigneeAgentId
        ? await tx.agent.findFirst({
          where: { id: assigneeAgentId, projectId: locked.projectId },
          select: { id: true, name: true },
        })
        : null;
      if (assigneeAgentId && !assignee) {
        return { ok: false, refusal: { kind: "assignment-blocked", reason: "Assignee does not belong to this project" } };
      }
      const reason = await assignmentBlocked(tx, assignee);
      if (reason) return { ok: false, refusal: { kind: "assignment-blocked", reason } };
    }
  }
  const written = plan.update
    ? await tx.task.update({ where: { id: taskId }, data: plan.update })
    : null;
  const activity = plan.activity
    ? await tx.taskActivity.create({ data: { taskId, ...plan.activity } })
    : null;
  return {
    ok: true,
    task: locked,
    written,
    activityId: activity?.id ?? null,
    chainLocked: locked.chainId !== null,
    value: plan.value,
  };
};
