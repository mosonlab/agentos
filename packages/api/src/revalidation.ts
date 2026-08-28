import {
  lockChainRows,
  Prisma,
  type PrismaClient,
} from "@anneal/db";

import {
  fenceRefusalResponse,
  fencedRunWhere,
  type FenceRefusalResponse,
  type RunFence,
  withFencedRun,
} from "./run-fence.js";
import { type Refusal } from "./refusal.js";
import { rewriteBrief } from "./task-brief.js";

/** The only Agent identity allowed to use the revalidation capability. */
export const SPEC_REVALIDATOR_AGENT_NAME = "spec-revalidator";

const revalidationTaskSelect = {
  id: true,
  projectId: true,
  chainId: true,
  chainIndex: true,
  chainLayer: true,
  dispatchAfterTaskId: true,
  description: true,
  name: true,
  status: true,
  assigneeAgentId: true,
  templateId: true,
  templateStepId: true,
  templateStep: {
    select: {
      outputKind: true,
      priorOutputKinds: true,
    },
  },
} as const satisfies Prisma.TaskSelect;

export type RevalidationTask = Prisma.TaskGetPayload<{ select: typeof revalidationTaskSelect }>;

type RevalidationCaller = RevalidationTask & { agentId: string; agentName: string };

export type BoundImplementationTask = Pick<
  RevalidationTask,
  "id" | "name" | "description" | "status" | "chainIndex" | "chainLayer"
>;

export type RevalidationResult = { task: RevalidationTask } | Refusal | FenceRefusalResponse;

export type RevalidationCancellation = {
  cancelRequested: true;
  requestId: string;
  reason: string;
} | Refusal | FenceRefusalResponse;

const executionLayer = (task: { chainLayer: number | null; chainIndex: number | null }): number | null => (
  task.chainLayer ?? task.chainIndex
);

const callerRefusal = (message: string): Refusal => ({ reason: "forbidden", message });

const boundTaskRefusal = (message: string): Refusal => ({ reason: "conflict", message });

/**
 * Derive the one implementation task a bound revalidation step may address.
 *
 * The caller's chain identity comes from the locked Run/Task rows. The client
 * supplies neither a target task id nor a chain id, so a session token cannot
 * turn this capability into an arbitrary task patch or cancellation endpoint.
 */
export const deriveBoundImplementationTask = (
  caller: RevalidationCaller,
  chainRows: readonly RevalidationTask[],
): BoundImplementationTask | Refusal => {
  if (caller.agentName !== SPEC_REVALIDATOR_AGENT_NAME) {
    return callerRefusal("Only the spec-revalidator Agent may use revalidation capability");
  }
  if (caller.assigneeAgentId !== caller.agentId) {
    return callerRefusal("Revalidation Run is not assigned to its spec-revalidator Agent");
  }
  if (caller.chainId === null || caller.chainIndex === null || caller.dispatchAfterTaskId === null) {
    return boundTaskRefusal("Revalidation is available only for a bound direct chain");
  }
  const candidates = chainRows.filter((task) => task.templateStep?.outputKind === "implementation");
  if (candidates.length !== 1) {
    return boundTaskRefusal(`Expected exactly one same-chain implementation task; found ${candidates.length}`);
  }
  const implementation = candidates[0]!;
  const callerLayer = executionLayer(caller);
  const implementationLayer = executionLayer(implementation);
  if (implementation.id === caller.id || callerLayer === null || implementationLayer === null
    || implementationLayer <= callerLayer) {
    return boundTaskRefusal("The same-chain implementation task is not downstream of revalidation");
  }
  return implementation;
};

const revalidationActivity = (input: {
  taskId: string;
  agentId: string;
  runId: string;
  body: string;
  metadata?: Record<string, string | number | boolean | null>;
}): Prisma.TaskActivityUncheckedCreateInput => ({
  taskId: input.taskId,
  actorType: "agent",
  actorId: input.agentId,
  body: input.body,
  ...(input.metadata ? { metadata: input.metadata } : {}),
});

const loadChainRows = async (
  tx: Prisma.TransactionClient,
  caller: RevalidationTask,
): Promise<RevalidationTask[]> => tx.task.findMany({
  where: { projectId: caller.projectId, chainId: caller.chainId! },
  orderBy: [{ chainLayer: "asc" }, { chainIndex: "asc" }, { id: "asc" }],
  select: revalidationTaskSelect,
});

const callerSelect = {
  id: true,
  agentId: true,
  leaseGeneration: true,
  agent: { select: { name: true } },
  task: { select: revalidationTaskSelect },
} as const satisfies Prisma.RunSelect;

type RevalidationRun = Prisma.RunGetPayload<{ select: typeof callerSelect }>;

const callerFromRun = (run: RevalidationRun): RevalidationCaller | Refusal => {
  if (!run.task) return { reason: "conflict", message: "Revalidation Run has no task" };
  return { ...run.task, agentId: run.agentId, agentName: run.agent.name };
};

const sessionGenerationRefusal = (
  run: RevalidationRun,
  expectedLeaseGeneration: number | undefined,
): FenceRefusalResponse | null => (
  expectedLeaseGeneration === undefined || run.leaseGeneration === expectedLeaseGeneration
    ? null
    : fenceRefusalResponse("stale-fence")
);

const failureActivity = async (
  tx: Prisma.TransactionClient,
  caller: RevalidationCaller,
  fence: RunFence,
  result: Refusal,
): Promise<Refusal> => {
  await tx.taskActivity.create({
    data: revalidationActivity({
      taskId: caller.id,
      agentId: caller.agentId,
      runId: fence.runId,
      body: `Revalidation failed: ${result.message}`,
      metadata: { kind: "revalidation-failure", runId: fence.runId, reason: result.reason },
    }),
  });
  return result;
};

/**
 * Patch the derived implementation brief under the complete Run fence.
 *
 * `rewriteBrief` preserves the platform-owned prompt and output suffix. The
 * description supplied by the revalidator is therefore a brief replacement,
 * not an escape hatch for changing intent or platform instructions.
 */
export const patchBoundImplementationDescription = async (
  db: PrismaClient,
  fence: RunFence,
  description: string,
  expectedLeaseGeneration?: number,
): Promise<RevalidationResult> => {
  try {
    return await db.$transaction((tx) => withFencedRun(tx, fence, callerSelect, async (run) => {
      const generationRefusal = sessionGenerationRefusal(run, expectedLeaseGeneration);
      if (generationRefusal) return generationRefusal;
      const caller = callerFromRun(run);
      if ("message" in caller) return caller;
      if (caller.chainId === null) return failureActivity(tx, caller, fence, boundTaskRefusal("Revalidation is not part of a chain"));

      // The chain lock is acquired after withFencedRun's Run -> source Task
      // order, matching completion and every other chained-task writer.
      await lockChainRows(tx, { projectId: caller.projectId, chainId: caller.chainId });
      const currentCaller = await tx.task.findUnique({ where: { id: caller.id }, select: revalidationTaskSelect });
      if (!currentCaller) return failureActivity(tx, caller, fence, { reason: "not-found", message: "Revalidation task not found" });
      const currentRows = await loadChainRows(tx, currentCaller);
      const target = deriveBoundImplementationTask(
        { ...currentCaller, agentId: run.agentId, agentName: run.agent.name },
        currentRows,
      );
      if ("message" in target) return failureActivity(tx, { ...currentCaller, agentId: run.agentId, agentName: run.agent.name }, fence, target);
      const targetRow = currentRows.find((row) => row.id === target.id)!;
      const rewritten = rewriteBrief(targetRow.description, description, {
        legacyAttachmentsFromPrevious: (targetRow.templateStep?.priorOutputKinds.length ?? 0) > 0,
      });
      if (typeof rewritten !== "string") {
        return failureActivity(tx, { ...currentCaller, agentId: run.agentId, agentName: run.agent.name }, fence, {
          reason: "invalid-request",
          message: `Cannot rewrite implementation task brief: ${rewritten.unparseable}`,
        });
      }
      const updated = await tx.task.update({
        where: { id: targetRow.id },
        data: { description: rewritten },
        select: revalidationTaskSelect,
      });
      await tx.taskActivity.create({
        data: revalidationActivity({
          taskId: currentCaller.id,
          agentId: run.agentId,
          runId: fence.runId,
          body: `Revalidated implementation task ${targetRow.id} description`,
          metadata: { kind: "revalidation", targetTaskId: targetRow.id, runId: fence.runId },
        }),
      });
      return { task: updated };
    }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error: unknown) {
    // Expected refusals are recorded in the fenced transaction above. A
    // database/PATCH failure is still surfaced to the provider, and this
    // best-effort audit keeps its reason visible when the database can accept
    // a separate activity write after the failed transaction rolled back.
    await recordRevalidationFailure(db, fence.runId, error);
    throw error;
  }
};

/** Read the current derived implementation task for task_status after resume. */
export const readBoundImplementationTask = async (
  db: PrismaClient,
  run: RevalidationRun,
): Promise<BoundImplementationTask | Refusal> => {
  const caller = callerFromRun(run);
  if ("message" in caller) return caller;
  if (caller.chainId === null) return boundTaskRefusal("Revalidation is not part of a chain");
  const chainRows = await db.task.findMany({
    where: { projectId: caller.projectId, chainId: caller.chainId },
    orderBy: [{ chainLayer: "asc" }, { chainIndex: "asc" }, { id: "asc" }],
    select: revalidationTaskSelect,
  });
  return deriveBoundImplementationTask(caller, chainRows);
};

const revalidationCancelRequestId = (runId: string): string => `revalidation:${runId}:cancel`;

/**
 * Record cancellation intent for a collapsed premise. Runner heartbeat and
 * cancellation acknowledgement perform provider cleanup and terminalization;
 * this route deliberately does not pretend to be the runner.
 */
export const cancelBoundRevalidationRun = async (
  db: PrismaClient,
  fence: RunFence,
  now = new Date(),
  expectedLeaseGeneration?: number,
): Promise<RevalidationCancellation> => {
  try {
    return await db.$transaction((tx) => withFencedRun(tx, fence, {
      ...callerSelect,
      status: true,
      cancelRequestId: true,
    }, async (run) => {
      const generationRefusal = sessionGenerationRefusal(run, expectedLeaseGeneration);
      if (generationRefusal) return generationRefusal;
      const caller = callerFromRun(run);
      if ("message" in caller) return caller;
      if (caller.chainId === null) return failureActivity(tx, caller, fence, boundTaskRefusal("Revalidation is not part of a chain"));
      await lockChainRows(tx, { projectId: caller.projectId, chainId: caller.chainId });
      const currentCaller = await tx.task.findUnique({ where: { id: caller.id }, select: revalidationTaskSelect });
      if (!currentCaller) return failureActivity(tx, caller, fence, { reason: "not-found", message: "Revalidation task not found" });
      const rows = await loadChainRows(tx, currentCaller);
      const target = deriveBoundImplementationTask(
        { ...currentCaller, agentId: run.agentId, agentName: run.agent.name },
        rows,
      );
      if ("message" in target) return failureActivity(tx, { ...currentCaller, agentId: run.agentId, agentName: run.agent.name }, fence, target);
      const requestId = revalidationCancelRequestId(fence.runId);
      const reason = "Revalidation premise collapsed; operator selected cancel this chain";
      const requested = await tx.run.updateMany({
        where: {
          ...fencedRunWhere(fence),
          cancelRequestId: null,
          cancelRequestedAt: null,
        },
        data: {
          cancelRequestId: requestId,
          cancelReason: reason,
          cancelRequestedAt: now,
          sessionTokenRevokedAt: now,
        },
      });
      if (requested.count !== 1) {
        return failureActivity(tx, { ...currentCaller, agentId: run.agentId, agentName: run.agent.name }, fence, {
          reason: "conflict",
          message: "Run changed while revalidation cancellation was being requested",
        });
      }
      await tx.taskActivity.create({
        data: revalidationActivity({
          taskId: currentCaller.id,
          agentId: run.agentId,
          runId: fence.runId,
          body: "Revalidation cancelled the bound chain after premise collapse",
          metadata: { kind: "revalidation-cancel", runId: fence.runId, requestId, targetTaskId: target.id },
        }),
      });
      return { cancelRequested: true, requestId, reason };
    }));
  } catch (error: unknown) {
    await recordRevalidationFailure(db, fence.runId, error);
    throw error;
  }
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Best-effort audit for errors thrown outside the fenced callback. */
export const recordRevalidationFailure = async (
  db: PrismaClient,
  runId: string,
  error: unknown,
): Promise<void> => {
  try {
    const run = await db.run.findUnique({ where: { id: runId }, select: { taskId: true, agentId: true } });
    if (!run?.taskId) return;
    await db.taskActivity.create({
      data: revalidationActivity({
        taskId: run.taskId,
        agentId: run.agentId,
        runId,
        body: `Revalidation failed: ${errorMessage(error)}`,
        metadata: { kind: "revalidation-failure", runId, reason: "tool-error" },
      }),
    });
  } catch (auditError: unknown) {
    console.error(`Unable to record revalidation failure for ${runId}`, auditError);
  }
};
