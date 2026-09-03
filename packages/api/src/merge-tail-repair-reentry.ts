import {
  ACTIVE_RUN_STATUSES,
  asJsonObject,
  isIntegratorStep,
  isMergeReadinessStep,
  isRegressionVerificationOutputKind,
  lockChainRows,
  MAX_MERGE_TAIL_REPAIR_ATTEMPTS,
  MERGE_TAIL_SCHEMA_VERSION,
  MergeRecoveryStatus,
  Prisma,
  readMarkerHistory,
  TaskStatus,
  transitionMergeRecovery,
} from "@anneal/db";

import {
  createMergeTailRepairTask,
  mergeTailRepairAgentName,
  regressionVerdictForRun,
} from "./merge-tail-actions.js";
import type { Refusal } from "./refusal.js";

type DbTx = Prisma.TransactionClient;
type RepairKind = "gate-fix" | "review-fix";

export const MERGE_TAIL_REPAIR_REQUEST_ACTION = "merge-tail-repair-request";

export type MergeTailRepairRequest = {
  taskId: string;
  requestId: string;
  reason?: string;
  now: Date;
};

export type MergeTailRepairRequestResult = {
  repairTaskId: string;
  repairKind: RepairKind;
  headSha: string;
  baseHeadSha: string;
};

export type MergeTailRepairReentryDependencies = {
  readHistory: typeof readMarkerHistory;
  qualifyVerdict: typeof regressionVerdictForRun;
  resolveAgentName: typeof mergeTailRepairAgentName;
  createRepairTask: typeof createMergeTailRepairTask;
};

const defaultDependencies: MergeTailRepairReentryDependencies = {
  readHistory: readMarkerHistory,
  qualifyVerdict: regressionVerdictForRun,
  resolveAgentName: mergeTailRepairAgentName,
  createRepairTask: createMergeTailRepairTask,
};

const refused = (code: string, message: string): Refusal => ({
  reason: "conflict",
  message,
  detail: { code },
});

const priorRequestResult = async (
  tx: DbTx,
  taskId: string,
  requestId: string,
): Promise<MergeTailRepairRequestResult | null> => {
  const row = await tx.taskActivity.findFirst({
    where: {
      taskId,
      actorType: "operator",
      AND: [
        { metadata: { path: ["action"], equals: MERGE_TAIL_REPAIR_REQUEST_ACTION } },
        { metadata: { path: ["requestId"], equals: requestId } },
      ],
    },
    select: { metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const metadata = asJsonObject(row?.metadata);
  if (metadata?.action !== MERGE_TAIL_REPAIR_REQUEST_ACTION
    || metadata.requestId !== requestId
    || (metadata.repairKind !== "gate-fix" && metadata.repairKind !== "review-fix")
    || typeof metadata.repairTaskId !== "string"
    || typeof metadata.headSha !== "string"
    || typeof metadata.baseHeadSha !== "string") return null;
  return {
    repairTaskId: metadata.repairTaskId,
    repairKind: metadata.repairKind,
    headSha: metadata.headSha,
    baseHeadSha: metadata.baseHeadSha,
  };
};

/**
 * Reopens one stopped recovery verdict into the ordinary merge-tail repair
 * machinery. The route owns the surrounding Serializable transaction; this
 * action owns the chain mutex and every state-dependent read and write.
 */
export const requestMergeTailRepair = async (
  tx: DbTx,
  input: MergeTailRepairRequest,
  dependencies: MergeTailRepairReentryDependencies = defaultDependencies,
): Promise<MergeTailRepairRequestResult | Refusal> => {
  const identity = await tx.task.findUnique({
    where: { id: input.taskId },
    select: { id: true, projectId: true, chainId: true },
  });
  if (!identity) return { reason: "not-found", message: "Task not found" };
  if (!identity.chainId) {
    return refused("merge_tail_repair_not_blocked", "Task is not a blocked merge-tail Regression task");
  }
  await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });

  const duplicate = await priorRequestResult(tx, input.taskId, input.requestId);
  if (duplicate) return duplicate;

  const regressionTask = await tx.task.findUnique({
    where: { id: input.taskId },
    select: {
      id: true,
      projectId: true,
      repoId: true,
      templateId: true,
      chainId: true,
      chainIndex: true,
      targetBranch: true,
      status: true,
      templateStep: {
        select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
      },
    },
  });
  if (!regressionTask || regressionTask.projectId !== identity.projectId
    || regressionTask.chainId !== identity.chainId
    || !isRegressionVerificationOutputKind(regressionTask.templateStep?.outputKind)) {
    return refused("merge_tail_repair_not_blocked", "Task is not a blocked merge-tail Regression task");
  }
  const aggregate = await tx.mergeRecoveryAttempt.findFirst({
    where: { regressionTaskId: input.taskId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  if (!aggregate || aggregate.regressionTaskId !== input.taskId) {
    return refused("merge_tail_repair_not_blocked", "No merge-tail recovery is blocked for this Regression task");
  }
  if (aggregate.refusalCode !== null) {
    return refused("merge_tail_repair_refusal_pending", "The blocked recovery has a pending head-adoption refusal");
  }

  const markers = await dependencies.readHistory(tx, input.taskId);
  if (aggregate.recoveryRunId && markers.some((marker) => (
    marker.kind === "repairAttempt" && marker.raw.sourceRunId === aggregate.recoveryRunId
  ))) {
    return refused("merge_tail_repair_already_open", "A repair is already open for this recovery Run");
  }
  if (aggregate.status !== MergeRecoveryStatus.BLOCKED_DOWNSTREAM
    || regressionTask.status !== TaskStatus.REVIEW
    || !aggregate.readinessTaskId
    || !aggregate.integratorTaskId) {
    return refused("merge_tail_repair_not_blocked", "The merge-tail recovery and its tasks are not parked for repair");
  }

  const relatedTasks = await tx.task.findMany({
    where: { id: { in: [input.taskId, aggregate.readinessTaskId, aggregate.integratorTaskId] } },
    select: {
      id: true,
      projectId: true,
      chainId: true,
      status: true,
      templateStep: {
        select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
      },
    },
  });
  const taskById = new Map(relatedTasks.map((task) => [task.id, task]));
  const readinessTask = taskById.get(aggregate.readinessTaskId);
  const integratorTask = taskById.get(aggregate.integratorTaskId);
  const relatedIdentityIsValid = relatedTasks.length === 3 && relatedTasks.every((task) => (
    task.projectId === identity.projectId && task.chainId === identity.chainId
  ));
  if (!relatedIdentityIsValid
    || taskById.get(input.taskId)?.status !== TaskStatus.REVIEW
    || readinessTask?.status !== TaskStatus.REVIEW
    || !isMergeReadinessStep(readinessTask?.templateStep)
    || integratorTask?.status !== TaskStatus.REVIEW
    || !isIntegratorStep(integratorTask?.templateStep)) {
    return refused("merge_tail_repair_not_blocked", "The recovery's Regression, readiness, and integrator tasks must all be in review");
  }
  const activeRuns = await tx.run.count({
    where: {
      taskId: { in: [input.taskId, aggregate.readinessTaskId, aggregate.integratorTaskId] },
      status: { in: ACTIVE_RUN_STATUSES },
    },
  });
  if (activeRuns > 0) {
    return refused("merge_tail_repair_active_run", "A merge-tail task still has an active Run");
  }
  if (!aggregate.recoveryRunId) {
    return refused("merge_tail_repair_verdict_missing", "The blocked recovery has no Regression Run verdict");
  }
  const sourceRun = await tx.run.findUnique({
    where: { id: aggregate.recoveryRunId },
    select: { id: true, taskId: true, branch: true, headSha: true },
  });
  if (!sourceRun || sourceRun.taskId !== input.taskId) {
    return refused("merge_tail_repair_verdict_missing", "The blocked recovery's Regression Run is missing");
  }
  const qualified = await dependencies.qualifyVerdict(tx, {
    task: regressionTask,
    runId: sourceRun.id,
    runHeadSha: sourceRun.headSha,
    allowPersistedHeadWhenUnreported: true,
  });
  if (qualified.status === "refused"
    || (qualified.verdict.outcome !== "review-fail" && qualified.verdict.outcome !== "gate-fail")) {
    return refused("merge_tail_repair_verdict_missing", "The recovery Run does not own a review-fail or gate-fail verdict");
  }
  const verdict = qualified.verdict;
  const repairKind: RepairKind = verdict.outcome === "review-fail" ? "review-fix" : "gate-fix";
  const priorAttempts = markers.filter((marker) => (
    marker.kind === "repairAttempt" && marker.repairKind === repairKind
  )).length;
  if (priorAttempts >= MAX_MERGE_TAIL_REPAIR_ATTEMPTS) {
    return refused("merge_tail_repair_budget_exhausted", `The ${repairKind} repair budget is exhausted`);
  }

  const agentName = await dependencies.resolveAgentName(tx, { ...regressionTask, repairKind });
  const repair = await dependencies.createRepairTask(tx, {
    regressionTask,
    sourceRun,
    agentName,
    repairKind,
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
    summary: verdict.summary,
    ...(verdict.outcome === "gate-fail"
      && "gateFailureExcerpt" in verdict
      && typeof verdict.gateFailureExcerpt === "string"
      ? { gateFailureExcerpt: verdict.gateFailureExcerpt }
      : {}),
    now: input.now,
  });
  if ("refusal" in repair) {
    return refused("merge_tail_repair_not_blocked", `The repair task could not be created: ${repair.refusal}`);
  }
  await transitionMergeRecovery(tx, aggregate.id, MergeRecoveryStatus.REPAIRING, {
    failureReason: null,
    endedAt: null,
  });
  const result: MergeTailRepairRequestResult = {
    repairTaskId: repair.taskId,
    repairKind,
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
  };
  await tx.taskActivity.create({ data: {
    taskId: input.taskId,
    actorType: "operator",
    body: `Operator requested ${repairKind} reentry for recovery Run ${sourceRun.id}`,
    metadata: {
      schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
      action: MERGE_TAIL_REPAIR_REQUEST_ACTION,
      requestId: input.requestId,
      reason: input.reason ?? null,
      repairKind,
      headSha: verdict.headSha,
      baseHeadSha: verdict.baseHeadSha,
      repairTaskId: repair.taskId,
    } as Prisma.InputJsonObject,
  } });
  return result;
};
