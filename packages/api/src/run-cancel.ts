import {
  executionModeFor,
  lockRunRow,
  type PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import type { MergeLeaseTarget } from "./merge-lease-hold.js";
import type { Refusal } from "./refusal.js";
import { activeRunStatuses } from "./run-fence.js";
import { terminalizeRun } from "./run-terminal.js";
import { taskStatusChangedActivity } from "./task-patch.js";
import { lockTaskMutationRows } from "./task-write.js";

export type CancellationState = "requested" | "acknowledged" | "unconfirmed" | "terminal";

export type CancelRunInput = {
  requestId: string;
  reason: string;
  parkTask: boolean;
};

export type CancellationAcknowledgementInput = {
  runnerId: string;
  fencingToken: string;
  requestId: string;
  workspacePath?: string | undefined;
  branch?: string | undefined;
  baseSha?: string | undefined;
  worktreeContainmentViolations?: string[] | undefined;
};

export type RunCancellation = {
  runId: string;
  taskId: string | null;
  status: RunStatus;
  cancellationState: CancellationState;
  requestId: string;
  reason: string | null;
  releaseMergeLeaseTask: MergeLeaseTarget | null;
};

export type CancellationAcknowledgement = {
  runId: string;
  taskId: string | null;
  status: RunStatus;
  cancellationState: CancellationState;
  requestId: string;
  releaseMergeLeaseTask: MergeLeaseTarget | null;
};

const refused = (reason: "not-found" | "conflict", message: string): Refusal => ({ reason, message });

export const cancelRun = async (
  db: PrismaClient,
  runId: string,
  body: CancelRunInput,
): Promise<RunCancellation | Refusal> => {
  const result = await db.$transaction(async (tx) => {
    // Run owns cancellation and terminalization. Take that mutex before Task,
    // matching completion so the two actions cannot enter the rows backwards.
    await lockRunRow(tx, runId);
    const run = await tx.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        status: true,
        taskId: true,
        runNumber: true,
        runnerId: true,
        fencingToken: true,
        leaseExpiresAt: true,
        claimedAt: true,
        cancelRequestId: true,
        cancelReason: true,
        cancelRequestedAt: true,
        cancelAcknowledgedAt: true,
        session: { select: { id: true } },
        task: { select: { templateStep: { select: {
          stepIndex: true,
          outputKind: true,
          taskTemplate: { select: { name: true } },
        } } } },
      },
    });
    if (!run) return refused("not-found", "Run not found");
    if (body.parkTask && !run.taskId) return refused("conflict", "Run has no Task to park");
    const parkTarget = body.parkTask && run.taskId ? await lockTaskMutationRows(tx, run.taskId) : null;
    if (body.parkTask && run.taskId && !parkTarget) return refused("not-found", "Task not found");
    if (parkTarget?.archivedAt !== null && parkTarget !== null) {
      return refused("conflict", "Cannot park an archived task");
    }
    if (parkTarget?.status === TaskStatus.DONE) return refused("conflict", "Cannot park a completed task");

    const parkRequestedTask = async () => {
      if (!parkTarget || parkTarget.status === TaskStatus.BACKLOG) return;
      const reason = run.cancelRequestId ? run.cancelReason ?? body.reason : body.reason;
      await tx.task.update({
        where: { id: parkTarget.id },
        data: { status: TaskStatus.BACKLOG, failureReason: reason },
      });
      await tx.taskActivity.create({ data: {
        taskId: parkTarget.id,
        ...taskStatusChangedActivity(parkTarget.status, TaskStatus.BACKLOG),
      } });
    };

    if (run.cancelRequestId) {
      if (run.cancelRequestId !== body.requestId) {
        return refused("conflict", `Run already has cancellation request ${run.cancelRequestId}`);
      }
      await parkRequestedTask();
      return {
        runId: run.id,
        taskId: run.taskId,
        status: run.status,
        cancellationState: run.cancelAcknowledgedAt
          ? "acknowledged" as const
          : run.status === RunStatus.CANCELLED ? "unconfirmed" as const : "requested" as const,
        requestId: run.cancelRequestId,
        reason: run.cancelReason,
        releaseMergeLeaseTask: null,
      };
    }
    if (executionModeFor(run.task?.templateStep ?? null) === "mechanical") {
      return refused("conflict", "Mechanical merge Runs cannot be cancelled after authorization");
    }
    if (!([RunStatus.QUEUED, ...activeRunStatuses] as RunStatus[]).includes(run.status)) {
      return {
        runId: run.id,
        taskId: run.taskId,
        status: run.status,
        cancellationState: "terminal" as const,
        requestId: body.requestId,
        reason: null,
        releaseMergeLeaseTask: null,
      };
    }

    const now = new Date();
    const requested = await tx.run.updateMany({
      where: { id: run.id, cancelRequestId: null, status: run.status },
      data: {
        cancelRequestId: body.requestId,
        cancelReason: body.reason,
        cancelRequestedAt: now,
        sessionTokenRevokedAt: now,
      },
    });
    if (requested.count !== 1) return refused("conflict", "Run changed while cancellation was being requested");
    await parkRequestedTask();
    if (run.taskId) await tx.taskActivity.create({ data: {
      taskId: run.taskId,
      actorType: "operator",
      body: `Cancellation requested for Run ${run.runNumber}: ${body.reason}`,
      metadata: { runId: run.id, requestId: body.requestId, priorStatus: run.status, state: "requested" },
    } });

    // An unclaimed Run has never had a provider process. Every claimed state,
    // including WAITING_INBOX, requires runner-owned process cleanup or an
    // explicitly unconfirmed terminalization after runner loss.
    if (run.status === RunStatus.QUEUED) {
      const terminal = await terminalizeRun(tx, {
        runId: run.id,
        at: now,
        outcome: {
          kind: "cancelled",
          requestId: body.requestId,
          cleanupConfirmed: true,
          activity: "acknowledged",
        },
      });
      if (terminal === null || "message" in terminal) return terminal;
      return {
        runId: terminal.runId,
        taskId: terminal.taskId,
        status: terminal.status,
        cancellationState: "acknowledged" as const,
        requestId: body.requestId,
        reason: body.reason,
        releaseMergeLeaseTask: terminal.leaseToRelease,
      };
    }
    return {
      runId: run.id,
      taskId: run.taskId,
      status: run.status,
      cancellationState: "requested" as const,
      requestId: body.requestId,
      reason: body.reason,
      // Terminalization is still owed by the runner acknowledgement or by
      // reconciliation, and only a terminal writer may free the lease.
      releaseMergeLeaseTask: null,
    };
  });

  return result ?? refused("conflict", "Run changed while cancellation was being settled");
};

export const acknowledgeCancellation = async (
  db: PrismaClient,
  runId: string,
  body: CancellationAcknowledgementInput,
): Promise<CancellationAcknowledgement | Refusal> => {
  const result = await db.$transaction((tx) => terminalizeRun(tx, {
    runId,
    at: new Date(),
    outcome: {
      kind: "cancelled",
      requestId: body.requestId,
      runnerId: body.runnerId,
      fencingToken: body.fencingToken,
      actorId: body.runnerId,
      cleanupConfirmed: true,
      activity: "acknowledged",
      ...(body.workspacePath === undefined ? {} : { workspacePath: body.workspacePath }),
      ...(body.branch === undefined ? {} : { branch: body.branch }),
      ...(body.baseSha === undefined ? {} : { baseSha: body.baseSha }),
      ...(body.worktreeContainmentViolations === undefined
        ? {}
        : { worktreeContainmentViolations: body.worktreeContainmentViolations }),
    },
  }));
  if (result === null) return refused("conflict", "Run changed while cancellation was being acknowledged");
  if ("message" in result) return result;
  return {
    runId: result.runId,
    taskId: result.taskId,
    status: result.status,
    cancellationState: "acknowledged",
    requestId: body.requestId,
    releaseMergeLeaseTask: result.leaseToRelease,
  };
};
