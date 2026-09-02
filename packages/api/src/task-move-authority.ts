import { AssigneeType, TaskStatus, type TaskStatus as TaskStatusType } from "@anneal/db";

export type TaskMoveDeferred = "active-run" | "stop-state";

export type TaskMoveFacts = {
  name: string;
  status: TaskStatusType;
  assigneeType: AssigneeType;
  chainId: string | null;
  archivedAt: Date | null;
  dispatchAfterTaskId: string | null;
  dispatchAfter: { name: string; status: TaskStatusType } | null;
  reactivationRefusal: string | null;
  activeRun: boolean | undefined;
  stopStateRefusal: string | null | undefined;
  chainPredecessor: { name: string } | null;
  /** A merge-gate card approval is the one operator-owned DONE disposition
   *  allowed for a chained AGENT task. The route still supplies the active-run
   *  and predecessor facts under the Task/Chain mutex. */
  mergeGateApproval?: boolean;
  /** A merge-gate card rejection is the operator-owned REVIEW -> TODO command
   *  whose shared disposition terminates the merge tail instead of requeueing. */
  mergeGateRejection?: boolean;
};

export type TaskMoveAuthority = {
  targets: TaskStatusType[];
  refusals: Array<{ status: TaskStatusType; message: string }>;
  deferred: Array<{ status: TaskStatusType; residue: TaskMoveDeferred }>;
};

const TASK_STATUSES: TaskStatusType[] = [
  TaskStatus.BACKLOG,
  TaskStatus.TODO,
  TaskStatus.DOING,
  TaskStatus.REVIEW,
  TaskStatus.DONE,
];

const liveStatus = (status: TaskStatusType): boolean => (
  status === TaskStatus.TODO || status === TaskStatus.DOING || status === TaskStatus.REVIEW
);

const ownershipRefusal = (task: TaskMoveFacts, next: TaskStatusType): string | null => {
  if (next === task.status) return null;
  if (task.assigneeType === AssigneeType.HUMAN && next === TaskStatus.DONE) return null;
  if (task.mergeGateApproval === true && task.chainId !== null && next === TaskStatus.DONE) return null;
  if (task.mergeGateRejection === true && task.chainId !== null && next === TaskStatus.TODO) return null;
  if (task.chainId !== null) return "Chain task statuses are controlled by chain execution";
  const queueTransition = (
    (task.status === TaskStatus.BACKLOG && next === TaskStatus.TODO)
    || (task.status === TaskStatus.TODO && next === TaskStatus.BACKLOG)
  );
  if (queueTransition) return null;
  return task.assigneeType === AssigneeType.AGENT
    ? "Doing, Review, and Done for agent tasks are controlled by execution"
    : "Human tasks may move between Backlog and Todo or be marked Done";
};

type MoveDecision =
  | { kind: "accepted" }
  | { kind: "refused"; message: string }
  | { kind: "deferred"; residue: TaskMoveDeferred };

/**
 * Decide every operator PATCH destination from one set of already-read facts.
 *
 * `undefined` on `activeRun` or `stopStateRefusal` means that fact still needs
 * an authoritative read under the Task mutex. The named residue is part of the
 * result instead of an implicit rule that board projection could overlook.
 */
const decisionFor = (task: TaskMoveFacts, next: TaskStatusType): MoveDecision => {
  if (task.archivedAt !== null) {
    return { kind: "refused", message: "Cannot change the status of an archived task; unarchive it first" };
  }
  if (task.dispatchAfterTaskId !== null
    && task.dispatchAfter?.status !== TaskStatus.DONE
    && next !== task.status) {
    return {
      kind: "refused",
      message: `Cannot change bound task status before predecessor ${task.dispatchAfter?.name ?? task.dispatchAfterTaskId} is done`,
    };
  }
  if (!liveStatus(task.status) && liveStatus(next) && task.reactivationRefusal !== null) {
    return { kind: "refused", message: task.reactivationRefusal };
  }
  if (next === TaskStatus.BACKLOG && task.status !== TaskStatus.BACKLOG) {
    if (task.activeRun === undefined) return { kind: "deferred", residue: "active-run" };
    if (task.activeRun) {
      return { kind: "refused", message: "Cannot move a task with an active run to Backlog" };
    }
  }
  if (next !== task.status) {
    if (task.stopStateRefusal === undefined) return { kind: "deferred", residue: "stop-state" };
    if (task.stopStateRefusal !== null) {
      return { kind: "refused", message: task.stopStateRefusal };
    }
  }
  const operatorRefusal = ownershipRefusal(task, next);
  if (next !== TaskStatus.DONE && operatorRefusal !== null) {
    return { kind: "refused", message: operatorRefusal };
  }
  if (next === TaskStatus.DONE) {
    if (task.activeRun === undefined) return { kind: "deferred", residue: "active-run" };
    if (task.activeRun) {
      return { kind: "refused", message: "Cannot mark a task done while it has an active run" };
    }
    if (task.chainPredecessor !== null) {
      return {
        kind: "refused",
        message: `Cannot complete ${task.name}; predecessor ${task.chainPredecessor.name} is not done`,
      };
    }
    if (operatorRefusal !== null) return { kind: "refused", message: operatorRefusal };
  }
  return { kind: "accepted" };
};

export const taskMoveAuthority = (task: TaskMoveFacts): TaskMoveAuthority => {
  const authority: TaskMoveAuthority = { targets: [], refusals: [], deferred: [] };
  for (const status of TASK_STATUSES) {
    const decision = decisionFor(task, status);
    if (decision.kind === "accepted") {
      if (status !== task.status) authority.targets.push(status);
    } else if (decision.kind === "refused") {
      authority.refusals.push({ status, message: decision.message });
    } else {
      authority.deferred.push({ status, residue: decision.residue });
    }
  }
  return authority;
};
