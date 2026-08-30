import {
  executionModeFor,
  lockRunRow,
  type PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { commitWithLeaseOutcome, type ReleaseMergeLease } from "./merge-lease.js";
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
  reason?: string | null;
};

export type CancellationAcknowledgement = {
  runId: string;
  taskId: string | null;
  status: RunStatus;
  cancellationState: CancellationState;
  requestId: string;
};

const refused = (reason: "not-found" | "conflict", message: string): Refusal => ({ reason, message });

export const cancelRun = async (
  db: PrismaClient,
  runId: string,
  body: CancelRunInput,
  releaseMergeLease: ReleaseMergeLease,
): Promise<RunCancellation | Refusal> => {
  const result = await commitWithLeaseOutcome<RunCancellation | Refusal>(db, async (tx) => {
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
    if (!run) return { value: refused("not-found", "Run not found"), leaseOutcome: { kind: "continue" } };
    if (body.parkTask && !run.taskId) {
      return { value: refused("conflict", "Run has no Task to park"), leaseOutcome: { kind: "continue" } };
    }
    const parkTarget = body.parkTask && run.taskId ? await lockTaskMutationRows(tx, run.taskId) : null;
    if (body.parkTask && run.taskId && !parkTarget) {
      return { value: refused("not-found", "Task not found"), leaseOutcome: { kind: "continue" } };
    }
    if (parkTarget?.archivedAt !== null && parkTarget !== null) {
      return { value: refused("conflict", "Cannot park an archived task"), leaseOutcome: { kind: "continue" } };
    }
    if (parkTarget?.status === TaskStatus.DONE) {
      return { value: refused("conflict", "Cannot park a completed task"), leaseOutcome: { kind: "continue" } };
    }

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
        return {
          value: refused("conflict", `Run already has cancellation request ${run.cancelRequestId}`),
          leaseOutcome: { kind: "continue" },
        };
      }
      await parkRequestedTask();
      return {
        value: {
          runId: run.id,
          taskId: run.taskId,
          status: run.status,
          cancellationState: run.cancelAcknowledgedAt
            ? "acknowledged" as const
            : run.status === RunStatus.CANCELLED ? "unconfirmed" as const : "requested" as const,
          requestId: run.cancelRequestId,
          reason: run.cancelReason,
        },
        leaseOutcome: { kind: "continue" },
      };
    }
    if (executionModeFor(run.task?.templateStep ?? null) === "mechanical") {
      return {
        value: refused("conflict", "Mechanical merge Runs cannot be cancelled after authorization"),
        leaseOutcome: { kind: "continue" },
      };
    }
    if (!([RunStatus.QUEUED, ...activeRunStatuses] as RunStatus[]).includes(run.status)) {
      return {
        value: {
          runId: run.id,
          taskId: run.taskId,
          status: run.status,
          cancellationState: "terminal" as const,
          requestId: body.requestId,
          reason: null,
        },
        leaseOutcome: { kind: "continue" },
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
    if (requested.count !== 1) {
      return {
        value: refused("conflict", "Run changed while cancellation was being requested"),
        leaseOutcome: { kind: "continue" },
      };
    }
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
      if (terminal === null) return null;
      if ("message" in terminal) return { value: terminal, leaseOutcome: { kind: "continue" } };
      return {
        value: {
          runId: terminal.runId,
          taskId: terminal.taskId,
          status: terminal.status,
          cancellationState: "acknowledged" as const,
          requestId: body.requestId,
        },
        leaseOutcome: terminal.leaseOutcome,
      };
    }
    return {
      value: {
        runId: run.id,
        taskId: run.taskId,
        status: run.status,
        cancellationState: "requested" as const,
        requestId: body.requestId,
        reason: body.reason,
      },
      // Terminalization is still owed by the runner acknowledgement or by
      // reconciliation, and only a terminal writer may free the lease.
      leaseOutcome: { kind: "continue" },
    };
  }, { release: releaseMergeLease });

  return result ?? refused("conflict", "Run changed while cancellation was being settled");
};

export const acknowledgeCancellation = async (
  db: PrismaClient,
  runId: string,
  body: CancellationAcknowledgementInput,
  releaseMergeLease: ReleaseMergeLease,
): Promise<CancellationAcknowledgement | Refusal> => {
  const result = await commitWithLeaseOutcome<CancellationAcknowledgement | Refusal>(db, async (tx) => {
    const terminal = await terminalizeRun(tx, {
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
    });
    if (terminal === null) return null;
    if ("message" in terminal) return { value: terminal, leaseOutcome: { kind: "continue" } };
    return {
      value: {
        runId: terminal.runId,
        taskId: terminal.taskId,
        status: terminal.status,
        cancellationState: "acknowledged" as const,
        requestId: body.requestId,
      },
      leaseOutcome: terminal.leaseOutcome,
    };
  }, { release: releaseMergeLease });
  if (result === null) return refused("conflict", "Run changed while cancellation was being acknowledged");
  if ("message" in result) return result;
  return result;
};
