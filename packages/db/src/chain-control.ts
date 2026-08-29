import {
  AssigneeType,
  ChainControlState,
  Prisma,
  RunStatus,
  TaskStatus,
} from "@prisma/client";

import { markerFromMetadata } from "./merge-tail-markers.js";
import {
  ACTIVE_RUN_STATUSES,
  activateChainSuccessor,
  lockChainRows,
  lockChainStructure,
} from "./workflow.js";

type ChainControlDb = Pick<Prisma.TransactionClient, "chainControl">;

export type ChainControlRefusal = {
  reason: "not-found" | "conflict";
  message: string;
  detail?: Readonly<Record<string, string>>;
};

type ChainControlProjectionInput = {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  heldLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
};

export type ChainControlAddress = {
  projectId: string;
  chainId: string;
  taskId: string;
};

export type ChainResumeRow = {
  id: string;
  projectId: string;
  name: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatus;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
};

export const executionLayer = (
  task: { chainLayer?: number | null; chainIndex: number | null },
): number | null => task.chainLayer ?? task.chainIndex;

/**
 * Resume anchors ordinary successor activation at the highest complete layer,
 * but only after the layer pinned by Hold is complete.
 */
export const resumeActivationAnchor = (
  rows: readonly ChainResumeRow[],
  heldLayer: number | null,
): ChainResumeRow | null => {
  if (heldLayer === null) return null;
  const layers = [...new Set(rows.map(executionLayer).filter((layer): layer is number => layer !== null))];
  const heldRows = rows.filter((row) => executionLayer(row) === heldLayer);
  if (heldRows.length === 0 || !heldRows.every((row) => row.status === TaskStatus.DONE)) return null;
  const completeLayer = layers
    .filter((layer) => rows.some((row) => executionLayer(row) === layer)
      && rows.filter((row) => executionLayer(row) === layer).every((row) => row.status === TaskStatus.DONE))
    .sort((left, right) => right - left)[0];
  if (completeLayer === undefined) return null;
  return rows
    .filter((row) => executionLayer(row) === completeLayer)
    .sort((left, right) => (
      (left.chainIndex ?? Number.MAX_SAFE_INTEGER) - (right.chainIndex ?? Number.MAX_SAFE_INTEGER)
        || left.id.localeCompare(right.id)
    ))[0] ?? null;
};

export const resumeActivationNeedsSourceRun = (
  rows: readonly ChainResumeRow[],
  anchor: ChainResumeRow,
): boolean => {
  const anchorLayer = executionLayer(anchor);
  if (anchorLayer === null) return false;
  const nextLayer = [...new Set(rows.map(executionLayer).filter((layer): layer is number => layer !== null))]
    .filter((layer) => layer > anchorLayer
      && rows.some((row) => executionLayer(row) === layer && row.status !== TaskStatus.DONE))
    .sort((left, right) => left - right)[0];
  if (nextLayer === undefined) return false;
  return rows
    // Activation handles an operator-parked successor before assignee shape.
    .filter((row) => executionLayer(row) === nextLayer
      && row.status !== TaskStatus.DONE
      && row.status !== TaskStatus.BACKLOG)
    .some((row) => row.assigneeType !== AssigneeType.AGENT
      || row.assigneeAgentId === null
      || row.repoId === null);
};

/** The Chain read contract exposes operator facts, not internal CAS metadata. */
export const chainControlReadProjection = (control: ChainControlProjectionInput) => ({
  state: control.state === ChainControlState.HELD ? "held" as const : "released" as const,
  heldLayer: control.heldLayer,
  heldAt: control.heldAt,
  holdRequestId: control.holdRequestId,
  holdReason: control.holdReason,
  releasedAt: control.releasedAt,
});

/** Mutation responses retain transition metadata needed by idempotent clients. */
export const chainControlMutationProjection = (control: ChainControlProjectionInput) => ({
  projectId: control.projectId,
  chainId: control.chainId,
  state: control.state === ChainControlState.HELD ? "held" as const : "released" as const,
  heldLayer: control.heldLayer,
  heldAt: control.heldAt,
  holdRequestId: control.holdRequestId,
  holdReason: control.holdReason,
  releasedAt: control.releasedAt,
  releaseRequestId: control.releaseRequestId,
  holdGeneration: control.holdGeneration,
});

const refusal = (
  reason: ChainControlRefusal["reason"],
  message: string,
  detail?: ChainControlRefusal["detail"],
): ChainControlRefusal => detail === undefined ? { reason, message } : { reason, message, detail };

export type ChainControlKey = {
  projectId: string;
  chainId: string;
};

/**
 * The one shared read of the persisted Chain hold authority. Every requested
 * key receives a value: an absent row and a RELEASED row both become the same
 * not-held snapshot, while a HELD row retains the layer and audit facts needed
 * by admission, activation and claim callers. The map is keyed by the same
 * project/Chain pair used by Chain progress readers because chainId alone is
 * only project-local identity.
 */
export type ChainControlSnapshot = {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  held: boolean;
  heldLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
};

export const chainControlKey = ({ projectId, chainId }: ChainControlKey): string => `${projectId}:${chainId}`;

const notHeld = ({ projectId, chainId }: ChainControlKey): ChainControlSnapshot => ({
  projectId,
  chainId,
  state: ChainControlState.RELEASED,
  held: false,
  heldLayer: null,
  heldAt: null,
  holdRequestId: null,
  holdReason: null,
  releasedAt: null,
  releaseRequestId: null,
  holdGeneration: 0,
});

const snapshot = (row: {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  heldLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
}): ChainControlSnapshot => ({
  projectId: row.projectId,
  chainId: row.chainId,
  state: row.state,
  held: row.state === ChainControlState.HELD,
  heldLayer: row.heldLayer,
  heldAt: row.heldAt,
  holdRequestId: row.holdRequestId,
  holdReason: row.holdReason,
  releasedAt: row.releasedAt,
  releaseRequestId: row.releaseRequestId,
  holdGeneration: row.holdGeneration,
});

export const readChainControls = async (
  tx: ChainControlDb,
  keys: readonly ChainControlKey[],
): Promise<Map<string, ChainControlSnapshot>> => {
  const unique = [...new Map(keys.map((key) => [chainControlKey(key), key])).values()];
  if (unique.length === 0) return new Map();
  const rows = await tx.chainControl.findMany({
    where: { OR: unique },
    select: {
      projectId: true,
      chainId: true,
      state: true,
      heldLayer: true,
      heldAt: true,
      holdRequestId: true,
      holdReason: true,
      releasedAt: true,
      releaseRequestId: true,
      holdGeneration: true,
    },
  });
  const byKey = new Map(rows.map((row) => [chainControlKey(row), snapshot(row)]));
  return new Map(unique.map((key) => [chainControlKey(key), byKey.get(chainControlKey(key)) ?? notHeld(key)]));
};

export const readChainControl = async (
  tx: ChainControlDb,
  key: ChainControlKey,
): Promise<ChainControlSnapshot> => (
  (await readChainControls(tx, [key])).get(chainControlKey(key)) ?? notHeld(key)
);

export const readChainControlRecord = async (
  tx: ChainControlDb,
  key: ChainControlKey,
): Promise<ChainControlProjectionInput | null> => tx.chainControl.findUnique({
  where: { projectId_chainId: key },
  select: {
    projectId: true,
    chainId: true,
    state: true,
    heldLayer: true,
    heldAt: true,
    holdRequestId: true,
    holdReason: true,
    releasedAt: true,
    releaseRequestId: true,
    holdGeneration: true,
  },
});

export type HoldChainResult = {
  control: ReturnType<typeof chainControlMutationProjection>;
  duplicate: boolean;
};

export const holdChain = async (
  tx: Prisma.TransactionClient,
  input: ChainControlAddress & { requestId: string; reason?: string | null | undefined },
): Promise<HoldChainResult | ChainControlRefusal> => {
  await lockChainStructure(tx, input);
  await lockChainRows(tx, input);
  const chainRows = await tx.task.findMany({
    where: { projectId: input.projectId, chainId: input.chainId },
    select: { id: true, status: true, chainIndex: true, chainLayer: true },
  });
  if (!chainRows.some((row) => row.id === input.taskId)) return refusal("not-found", "Task not found");

  const existing = await tx.chainControl.findUnique({
    where: { projectId_chainId: { projectId: input.projectId, chainId: input.chainId } },
  });
  // Event history is the durable idempotency ledger. A delayed accepted Hold
  // remains a no-op after Resume has replaced the mutable state.
  const priorRequest = existing === null ? null : await tx.chainControlEvent.findUnique({
    where: {
      chainControlId_kind_requestId: {
        chainControlId: existing.id,
        kind: ChainControlState.HELD,
        requestId: input.requestId,
      },
    },
  });
  if (priorRequest || existing?.state === ChainControlState.HELD) {
    if (!existing) throw new Error("Chain control event exists without its authority");
    return { control: chainControlMutationProjection(existing), duplicate: true };
  }

  const heldLayer = chainRows
    .filter((row) => row.status !== TaskStatus.DONE)
    .map(executionLayer)
    .filter((layer): layer is number => layer !== null)
    .sort((left, right) => left - right)[0];
  if (heldLayer === undefined) {
    return refusal("conflict", "Cannot hold a completed Chain; there is nothing left to hold");
  }

  const now = new Date();
  const holdGeneration = (existing?.holdGeneration ?? 0) + 1;
  const held = existing
    ? await tx.chainControl.update({
      where: { id: existing.id },
      data: {
        state: ChainControlState.HELD,
        heldLayer,
        heldAt: now,
        holdRequestId: input.requestId,
        holdReason: input.reason ?? null,
        releasedAt: null,
        releaseRequestId: null,
        holdGeneration,
      },
    })
    : await tx.chainControl.create({
      data: {
        projectId: input.projectId,
        chainId: input.chainId,
        state: ChainControlState.HELD,
        heldLayer,
        heldAt: now,
        holdRequestId: input.requestId,
        holdReason: input.reason ?? null,
        holdGeneration,
      },
    });
  await tx.chainControlEvent.create({
    data: {
      chainControlId: held.id,
      kind: ChainControlState.HELD,
      layer: heldLayer,
      actorType: "operator",
      actorId: null,
      requestId: input.requestId,
      reason: input.reason ?? null,
      createdAt: now,
      holdGeneration,
    },
  });
  return { control: chainControlMutationProjection(held), duplicate: false };
};

export type ResumeChainResult = {
  control: ReturnType<typeof chainControlMutationProjection> | null;
  duplicate: boolean;
  nextTaskId: string | null;
  gated: boolean;
};

export const resumeChain = async (
  tx: Prisma.TransactionClient,
  input: ChainControlAddress & { requestId: string },
  now: Date,
): Promise<ResumeChainResult | ChainControlRefusal> => {
  await lockChainStructure(tx, input);
  await lockChainRows(tx, input);
  const chainRows = await tx.task.findMany({
    where: { projectId: input.projectId, chainId: input.chainId },
    select: {
      id: true,
      projectId: true,
      name: true,
      chainId: true,
      chainIndex: true,
      chainLayer: true,
      status: true,
      assigneeType: true,
      assigneeAgentId: true,
      repoId: true,
    },
  });
  if (!chainRows.some((row) => row.id === input.taskId)) return refusal("not-found", "Task not found");

  const existing = await tx.chainControl.findUnique({
    where: { projectId_chainId: { projectId: input.projectId, chainId: input.chainId } },
  });
  if (!existing) return { control: null, duplicate: true, nextTaskId: null, gated: false };

  const priorRequest = await tx.chainControlEvent.findUnique({
    where: {
      chainControlId_kind_requestId: {
        chainControlId: existing.id,
        kind: ChainControlState.RELEASED,
        requestId: input.requestId,
      },
    },
  });
  if (priorRequest || existing.state !== ChainControlState.HELD) {
    return {
      control: chainControlMutationProjection(existing),
      duplicate: true,
      nextTaskId: null,
      gated: false,
    };
  }
  if (existing.heldLayer === null) throw new Error("Held Chain control is missing its held layer");

  const anchor = resumeActivationAnchor(chainRows, existing.heldLayer);
  const anchorLayer = anchor === null ? null : executionLayer(anchor);
  const sourceRun = anchorLayer === null
    ? null
    : await tx.run.findFirst({
      where: {
        taskId: { in: chainRows.filter((row) => executionLayer(row) === anchorLayer).map((row) => row.id) },
        status: RunStatus.SUCCEEDED,
        session: { isNot: null },
      },
      orderBy: [{ endedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
  if (anchor !== null && sourceRun === null && resumeActivationNeedsSourceRun(chainRows, anchor)) {
    return refusal("conflict", "Cannot resume an approval layer without a succeeded source Run session");
  }

  // The state and generation predicate is the compare-and-set authority even
  // though the Chain mutex is the ordinary serializer.
  const releasedCount = await tx.chainControl.updateMany({
    where: {
      id: existing.id,
      state: ChainControlState.HELD,
      holdGeneration: existing.holdGeneration,
    },
    data: {
      state: ChainControlState.RELEASED,
      releasedAt: now,
      releaseRequestId: input.requestId,
    },
  });
  if (releasedCount.count !== 1) {
    const current = await tx.chainControl.findUniqueOrThrow({ where: { id: existing.id } });
    return {
      control: chainControlMutationProjection(current),
      duplicate: true,
      nextTaskId: null,
      gated: false,
    };
  }
  const released = await tx.chainControl.findUniqueOrThrow({ where: { id: existing.id } });
  await tx.chainControlEvent.create({
    data: {
      chainControlId: released.id,
      kind: ChainControlState.RELEASED,
      layer: existing.heldLayer,
      actorType: "operator",
      actorId: null,
      requestId: input.requestId,
      reason: null,
      createdAt: now,
      holdGeneration: existing.holdGeneration,
    },
  });

  const activated = anchor
    ? await activateChainSuccessor(tx, anchor, { sourceRunId: sourceRun?.id ?? null }, now)
    : { nextTaskId: null, gated: false };
  return {
    control: chainControlMutationProjection(released),
    duplicate: false,
    nextTaskId: activated.nextTaskId,
    gated: activated.gated,
  };
};

const addressedTaskBelongsToChain = async (
  tx: Prisma.TransactionClient,
  input: ChainControlAddress,
): Promise<boolean | null> => {
  const task = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { id: true, projectId: true, chainId: true },
  });
  if (!task) return null;
  if (task.projectId !== input.projectId) return false;
  if (task.chainId !== null) return task.chainId === input.chainId;

  const markerRows = await tx.taskActivity.findMany({
    where: {
      taskId: task.id,
      actorType: "control-plane",
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const row of markerRows) {
    const marker = markerFromMetadata(row.metadata);
    if (marker?.kind !== "repairAttempt" || !marker.regressionTaskId || !marker.repairKind) continue;
    const regression = await tx.task.findFirst({
      where: {
        id: marker.regressionTaskId,
        projectId: input.projectId,
        chainId: input.chainId,
      },
      select: { id: true },
    });
    if (regression) return true;
  }
  return false;
};

const readRepairTaskIds = async (
  tx: Prisma.TransactionClient,
  input: { projectId: string; chainTaskIds: string[] },
): Promise<string[]> => {
  if (input.chainTaskIds.length === 0) return [];
  const markerRows = await tx.taskActivity.findMany({
    where: {
      taskId: { in: input.chainTaskIds },
      actorType: "control-plane",
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const candidateIds = [...new Set(markerRows.flatMap((row) => {
    const marker = markerFromMetadata(row.metadata);
    return marker?.kind === "repairAttempt" && marker.repairKind && marker.repairTaskId
      ? [marker.repairTaskId]
      : [];
  }))];
  if (candidateIds.length === 0) return [];
  const repairs = await tx.task.findMany({
    where: { id: { in: candidateIds }, projectId: input.projectId, chainId: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return repairs.map((task) => task.id);
};

const lockTaskRowsById = async (
  tx: Prisma.TransactionClient,
  taskIds: string[],
): Promise<string[]> => {
  if (taskIds.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task"
    WHERE "id" = ANY(${taskIds})
    ORDER BY "id" FOR UPDATE
  `;
  return rows.map((row) => row.id);
};

const activeRunRefusal = (chainId: string): ChainControlRefusal => refusal(
  "conflict",
  `Cannot delete Chain ${chainId}; a member has an active run`,
  { code: "chain_delete_active_run", chainId },
);

export const chainRunHistoryRefusal = (chainId: string): ChainControlRefusal => refusal(
  "conflict",
  `Cannot delete Chain ${chainId}; a member has run history`,
  { code: "chain_delete_run_history", chainId },
);

export type DeleteChainResult = { deleted: number };

export const deleteChain = async (
  tx: Prisma.TransactionClient,
  input: ChainControlAddress,
): Promise<DeleteChainResult | ChainControlRefusal> => {
  await lockChainStructure(tx, input);
  const belongs = await addressedTaskBelongsToChain(tx, input);
  if (belongs === null) return refusal("not-found", "Task not found");
  if (!belongs) return refusal("conflict", "Task does not belong to a Chain");

  const chainTaskIds = await lockChainRows(tx, input);
  const repairTaskIds = await readRepairTaskIds(tx, {
    projectId: input.projectId,
    chainTaskIds,
  });
  const taskIds = [...new Set([...chainTaskIds, ...repairTaskIds])];
  // Refuse before taking a detached repair lock behind completion, which owns
  // the task and may be waiting for this Chain lock.
  const active = await tx.run.count({
    where: { taskId: { in: taskIds }, status: { in: ACTIVE_RUN_STATUSES } },
  });
  if (active > 0) return activeRunRefusal(input.chainId);

  const lockedRepairIds = await lockTaskRowsById(tx, repairTaskIds);
  const survivingTaskIds = [...new Set([...chainTaskIds, ...lockedRepairIds])];
  const activeAfterLock = await tx.run.count({
    where: { taskId: { in: survivingTaskIds }, status: { in: ACTIVE_RUN_STATUSES } },
  });
  if (activeAfterLock > 0) return activeRunRefusal(input.chainId);

  const runHistory = await tx.run.count({ where: { taskId: { in: survivingTaskIds } } });
  if (runHistory > 0) return chainRunHistoryRefusal(input.chainId);

  await tx.task.deleteMany({ where: { id: { in: survivingTaskIds } } });
  return { deleted: survivingTaskIds.length };
};
