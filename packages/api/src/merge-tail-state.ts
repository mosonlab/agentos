import {
  closeIntegratorQuestions,
  enqueueTaskRun,
  MergeRecoveryStatus,
  Prisma,
  TaskStatus,
  transitionMergeRecovery,
  writeMarker,
  type MergeRecoveryAttempt,
  type MergeRecoveryTransitionData,
  type RecoveryContext,
} from "@anneal/db";

type DbTx = Prisma.TransactionClient;

const LEGACY_PRE_INTENT_REFUSAL = "source executor run does not have exactly one server-bound merge intent";
const LEGACY_TARGET_BRANCH_REFUSAL = "authorized target ref differs from the chain target branch";

export type RecoveryValidationIdentity = {
  sourceRunId: string;
  authorizationActivityId: string;
  readinessTaskId: string;
  regressionTaskId: string;
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
};

type RecoveryValidationData = {
  boundSourceRunId: string;
  authorizationActivityId: string;
  readinessTaskId: string;
  regressionTaskId: string;
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
};

const validationData = (identity: RecoveryValidationIdentity): RecoveryValidationData => ({
  boundSourceRunId: identity.sourceRunId,
  authorizationActivityId: identity.authorizationActivityId,
  readinessTaskId: identity.readinessTaskId,
  regressionTaskId: identity.regressionTaskId,
  repository: identity.repository,
  prNumber: identity.prNumber,
  targetBranch: identity.targetBranch,
  authorizedHeadSha: identity.authorizedHeadSha,
  authorizedBaseSha: identity.authorizedBaseSha,
  observedBaseSha: identity.observedBaseSha,
});

export const recoveryIsReopenableLegacyRefusal = (attempt: MergeRecoveryAttempt): boolean => (
  (attempt.status === MergeRecoveryStatus.FAILED
    && attempt.failureReason === LEGACY_PRE_INTENT_REFUSAL
    && attempt.boundSourceRunId === null
    && attempt.authorizationActivityId === null
    && attempt.recoveryRunId === null)
  || (attempt.status === MergeRecoveryStatus.FAILED
    && attempt.failureReason === LEGACY_TARGET_BRANCH_REFUSAL
    && attempt.boundSourceRunId === null
    && attempt.authorizationActivityId === null
    && attempt.recoveryRunId === null
    && attempt.readinessTaskId === null
    && attempt.regressionTaskId === null
    && attempt.repository === null
    && attempt.prNumber === null
    && attempt.targetBranch === null
    && attempt.authorizedHeadSha === null
    && attempt.authorizedBaseSha === null
    && attempt.observedBaseSha === null
    && attempt.currentBaseSha === null)
);

/** Opens the initial VALIDATING state or the two explicitly supported legacy reopen shapes. */
export const ensureRecoveryValidation = async (
  tx: DbTx,
  input: {
    integratorTaskId: string;
    sourceStopId: string;
    identity?: RecoveryValidationIdentity;
  },
): Promise<MergeRecoveryAttempt> => {
  const existing = await tx.mergeRecoveryAttempt.findFirst({
    where: { integratorTaskId: input.integratorTaskId, sourceStopId: input.sourceStopId },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  if (existing) {
    if (!input.identity || !recoveryIsReopenableLegacyRefusal(existing)) return existing;
    const reopened = await transitionMergeRecovery(tx, existing.id, MergeRecoveryStatus.VALIDATING, {
      failureReason: null,
      endedAt: null,
      ...validationData(input.identity),
    });
    await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
      actorType: "control-plane",
      body: `Automatic pre-merge base-drift validation reopened legacy refusal for stop ${input.sourceStopId}`,
      metadata: {
        state: "legacy-validation-reopened",
        aggregateId: existing.id,
        sourceStopId: input.sourceStopId,
      },
    });
    return reopened;
  }
  const latest = await tx.mergeRecoveryAttempt.aggregate({
    where: { integratorTaskId: input.integratorTaskId },
    _max: { attempt: true },
  });
  return tx.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: input.integratorTaskId,
    sourceStopId: input.sourceStopId,
    attempt: (latest._max.attempt ?? 0) + 1,
    status: MergeRecoveryStatus.VALIDATING,
    ...(input.identity ? validationData(input.identity) : {}),
  } });
};

type RecoveryRepairIdentity = Omit<RecoveryContext, "currentBaseSha" | "recoveryRunId">;

const requireRecoveryRepairIdentity = async (
  tx: DbTx,
  aggregateId: string,
): Promise<RecoveryRepairIdentity> => {
  const aggregate = await tx.mergeRecoveryAttempt.findUnique({ where: { id: aggregateId } });
  if (!aggregate?.boundSourceRunId || !aggregate.authorizationActivityId
    || !aggregate.readinessTaskId || !aggregate.regressionTaskId || !aggregate.repository
    || aggregate.prNumber === null || !aggregate.targetBranch || !aggregate.authorizedHeadSha
    || !aggregate.authorizedBaseSha || !aggregate.observedBaseSha) {
    throw new Error(`Merge recovery aggregate ${aggregateId} has incomplete tail identity`);
  }
  return {
    aggregateId: aggregate.id,
    attempt: aggregate.attempt,
    sourceStopId: aggregate.sourceStopId,
    sourceRunId: aggregate.boundSourceRunId,
    authorizationActivityId: aggregate.authorizationActivityId,
    repository: aggregate.repository,
    prNumber: aggregate.prNumber,
    targetBranch: aggregate.targetBranch,
    authorizedHeadSha: aggregate.authorizedHeadSha,
    authorizedBaseSha: aggregate.authorizedBaseSha,
    observedBaseSha: aggregate.observedBaseSha,
    readinessTaskId: aggregate.readinessTaskId,
    regressionTaskId: aggregate.regressionTaskId,
    integratorTaskId: aggregate.integratorTaskId,
  };
};

const stopNotice = async (
  tx: DbTx,
  input: { taskId: string; body: string; dedupeKey: string },
): Promise<void> => {
  await tx.inboxMessage.upsert({ where: { dedupeKey: input.dedupeKey }, create: {
    from: "AGENT",
    taskId: input.taskId,
    kind: "TEXT",
    body: input.body,
    dedupeKey: input.dedupeKey,
  }, update: {} });
};

export const enterRepair = async (
  tx: DbTx,
  input: {
    aggregateId: string;
    currentBaseSha: string;
    now: Date;
    readinessRequeue?: { staleBaseSha: string; reason: string };
  },
): Promise<{ recoveryRunId: string }> => {
  const context = await requireRecoveryRepairIdentity(tx, input.aggregateId);
  const aggregate = await tx.mergeRecoveryAttempt.findUniqueOrThrow({
    where: { id: input.aggregateId },
    select: { status: true },
  });
  const requeue = input.readinessRequeue;
  if ((aggregate.status === MergeRecoveryStatus.AWAITING_AUTHORIZATION) !== Boolean(requeue)) {
    throw new Error(`Merge recovery ${input.aggregateId} repair intent does not match ${aggregate.status}`);
  }

  await closeIntegratorQuestions(tx, context.integratorTaskId);
  await tx.taskStepOutput.deleteMany({
    where: { taskId: { in: [context.regressionTaskId, context.readinessTaskId] } },
  });
  await tx.task.update({
    where: { id: context.regressionTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await tx.task.update({
    where: { id: context.readinessTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await tx.task.update({
    where: { id: context.integratorTaskId },
    data: requeue
      ? { status: TaskStatus.REVIEW }
      : {
          status: TaskStatus.REVIEW,
          failureReason: `Automatic base-drift recovery ${String(context.attempt)} queued from stop ${context.sourceStopId}`,
        },
  });
  const run = await enqueueTaskRun(
    tx,
    context.regressionTaskId,
    input.now,
    requeue ? { budgetGrant: 1 } : {},
  );
  await transitionMergeRecovery(tx, input.aggregateId, MergeRecoveryStatus.REPAIRING, {
    recoveryRunId: run.id,
    currentBaseSha: input.currentBaseSha,
    failureReason: null,
    endedAt: null,
  });

  const body = requeue
    ? `Automatic base-drift recovery ${String(context.attempt)} context carried through readiness requeue`
    : `Automatic base-drift recovery ${String(context.attempt)} parked stop ${context.sourceStopId} and queued fresh regression`;
  const metadata = {
    ...context,
    currentBaseSha: input.currentBaseSha,
    recoveryRunId: run.id,
    state: requeue ? "readiness-requeued" : "queued",
  };
  await writeMarker(tx, context.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body,
    metadata,
  });
  await writeMarker(tx, context.regressionTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body: requeue
      ? body
      : `Automatic base-drift recovery ${String(context.attempt)} verifies ${context.authorizedHeadSha} against current base ${input.currentBaseSha}`,
    metadata,
  });
  if (requeue) {
    await writeMarker(tx, context.regressionTaskId, "readiness", {
      actorType: "control-plane",
      body: `Merge readiness returned to regression: ${requeue.reason}; ${requeue.staleBaseSha} -> ${input.currentBaseSha}`,
      metadata: {
        state: "requeued-regression",
        reason: requeue.reason,
        staleBaseSha: requeue.staleBaseSha,
        currentBaseSha: input.currentBaseSha,
      },
    });
  }
  return { recoveryRunId: run.id };
};

export const awaitAuthorization = async (
  tx: DbTx,
  recovery: RecoveryContext,
): Promise<void> => {
  await transitionMergeRecovery(
    tx,
    recovery.aggregateId,
    MergeRecoveryStatus.AWAITING_AUTHORIZATION,
    { failureReason: null },
  );
  await tx.task.update({
    where: { id: recovery.regressionTaskId },
    data: { status: TaskStatus.DONE, failureReason: null },
  });
  await tx.task.update({
    where: { id: recovery.readinessTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await tx.task.update({
    where: { id: recovery.integratorTaskId },
    data: { status: TaskStatus.REVIEW },
  });
  const body = `Automatic base-drift recovery ${String(recovery.attempt)} awaits fresh readiness authorization`;
  const metadata = { ...recovery, state: "awaiting-authorization" };
  await writeMarker(tx, recovery.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane", body, metadata,
  });
  await writeMarker(tx, recovery.regressionTaskId, "baseDriftRecovery", {
    actorType: "control-plane", body, metadata,
  });
  await writeMarker(tx, recovery.readinessTaskId, "readiness", {
    actorType: "control-plane",
    body: "Predecessor layer completed; server-side merge readiness queued",
    metadata: { state: "queued", sourceRunId: recovery.recoveryRunId },
  });
};

export const blockDownstream = async (
  tx: DbTx,
  input: {
    recovery: RecoveryContext;
    phase: "regression" | "readiness";
    reason: string;
    at: Date;
  },
): Promise<void> => {
  const { recovery } = input;
  const body = `Automatic base-drift recovery ${String(recovery.attempt)} stopped at ${input.phase}: ${input.reason}`;
  await transitionMergeRecovery(tx, recovery.aggregateId, MergeRecoveryStatus.BLOCKED_DOWNSTREAM, {
    failureReason: input.reason,
    endedAt: input.at,
  });
  await tx.task.update({
    where: { id: recovery.regressionTaskId },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: input.phase === "regression" ? body : input.reason,
    },
  });
  await tx.task.update({
    where: { id: recovery.readinessTaskId },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: input.phase === "regression" ? body : input.reason,
    },
  });
  await tx.task.update({
    where: { id: recovery.integratorTaskId },
    data: { status: TaskStatus.REVIEW, failureReason: body },
  });
  const dedupeKey = `merge-base-drift-recovery-tail-stop:${recovery.sourceStopId}:${input.phase}`;
  const metadata = { ...recovery, state: "tail-stopped", phase: input.phase, reason: input.reason, dedupeKey };
  for (const taskId of [recovery.integratorTaskId, recovery.regressionTaskId]) {
    await writeMarker(tx, taskId, "baseDriftRecovery", { actorType: "control-plane", body, metadata });
  }
  await stopNotice(tx, { taskId: recovery.regressionTaskId, body, dedupeKey });
};

export const reopenAfterHeadAdoption = async (
  tx: DbTx,
  input: { recovery: RecoveryContext; expectedFailureReason: string },
): Promise<void> => {
  const aggregate = await tx.mergeRecoveryAttempt.findUnique({
    where: { id: input.recovery.aggregateId },
    select: { failureReason: true },
  });
  if (aggregate?.failureReason !== input.expectedFailureReason) {
    throw new Error(`Merge recovery ${input.recovery.aggregateId} head-adoption failure changed before reopen`);
  }
  await transitionMergeRecovery(tx, input.recovery.aggregateId, MergeRecoveryStatus.REPAIRING, {
    failureReason: null,
    endedAt: null,
  });
  await tx.taskStepOutput.deleteMany({ where: { taskId: input.recovery.readinessTaskId } });
  await tx.task.update({
    where: { id: input.recovery.regressionTaskId },
    data: { status: TaskStatus.DONE, failureReason: null },
  });
  await tx.task.update({
    where: { id: input.recovery.readinessTaskId },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  await tx.task.update({
    where: { id: input.recovery.integratorTaskId },
    data: {
      status: TaskStatus.REVIEW,
      failureReason: `Automatic base-drift recovery ${String(input.recovery.attempt)} resumed after verified regression head adoption`,
    },
  });
  const body = `Automatic base-drift recovery ${String(input.recovery.attempt)} reopened the verified Regression result for fresh readiness authorization`;
  const metadata = {
    aggregateId: input.recovery.aggregateId,
    sourceStopId: input.recovery.sourceStopId,
    recoveryRunId: input.recovery.recoveryRunId,
    state: "reopened-head-adoption",
  };
  for (const taskId of [input.recovery.integratorTaskId, input.recovery.regressionTaskId]) {
    await writeMarker(tx, taskId, "baseDriftRecovery", { actorType: "control-plane", body, metadata });
  }
};

export const exhaust = async (
  tx: DbTx,
  input: {
    aggregateId: string;
    integratorTaskId: string;
    sourceStopId: string;
    reason: string;
    at: Date;
    attempt: number;
    state: "ineligible" | "exhausted";
    recoveryData: MergeRecoveryTransitionData;
    markerMetadata: Record<string, unknown>;
  },
): Promise<void> => {
  await transitionMergeRecovery(tx, input.aggregateId, MergeRecoveryStatus.FAILED, {
    ...input.recoveryData,
    failureReason: input.reason,
    endedAt: input.at,
  });
  const body = input.state === "ineligible"
    ? `Automatic pre-merge base-drift recovery refused: ${input.reason}`
    : `Automatic pre-merge base-drift recovery exhausted at attempt ${String(input.attempt)}`;
  await tx.task.update({ where: { id: input.integratorTaskId }, data: {
    status: TaskStatus.REVIEW,
    failureReason: input.state === "ineligible"
      ? `Automatic base-drift recovery refused: ${input.reason}`
      : input.reason,
  } });
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body,
    metadata: {
      state: input.state,
      ...input.markerMetadata,
      integratorTaskId: input.integratorTaskId,
      sourceStopId: input.sourceStopId,
      reason: input.reason,
    },
  });
  const dedupeKey = `merge-base-drift-recovery:${input.state}:${input.sourceStopId}`;
  await stopNotice(tx, {
    taskId: input.integratorTaskId,
    body: `Automatic pre-merge base-drift recovery ${input.state} for stop ${input.sourceStopId}: ${input.reason}. No regression run or re-authorization was created.`,
    dedupeKey,
  });
};

export const recordValidationRetry = async (
  tx: DbTx,
  input: {
    aggregateId: string;
    integratorTaskId: string;
    sourceStopId: string;
    classificationAttempt: number;
    maxAttempts: number;
    reason: string;
  },
): Promise<void> => {
  await tx.mergeRecoveryAttempt.update({
    where: { id: input.aggregateId },
    data: { validationAttempts: input.classificationAttempt, failureReason: input.reason },
  });
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body: `Automatic pre-merge base-drift classification deferred (${String(input.classificationAttempt)}/${String(input.maxAttempts)}): ${input.reason}`,
    metadata: {
      state: "classification-retry",
      integratorTaskId: input.integratorTaskId,
      sourceStopId: input.sourceStopId,
      classificationAttempt: input.classificationAttempt,
      reason: input.reason,
    },
  });
};

export const retireLegacyRefusal = async (
  tx: DbTx,
  input: {
    aggregateId: string;
    integratorTaskId: string;
    sourceStopId: string;
    priorReason: string | null;
    reason: string;
    at: Date;
  },
): Promise<void> => {
  const retiredReason = `Historical base-drift recovery refusal retired after current validation: ${input.reason}`;
  await tx.mergeRecoveryAttempt.update({
    where: { id: input.aggregateId },
    data: { failureReason: retiredReason, endedAt: input.at },
  });
  await tx.task.update({ where: { id: input.integratorTaskId }, data: {
    status: TaskStatus.REVIEW,
    failureReason: `Automatic base-drift recovery refused: ${input.reason}`,
  } });
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body: retiredReason,
    metadata: {
      state: "legacy-refusal-retired",
      integratorTaskId: input.integratorTaskId,
      sourceStopId: input.sourceStopId,
      priorReason: input.priorReason,
      reason: input.reason,
    },
  });
};

export const adoptRecoveryHead = async (
  tx: DbTx,
  input: {
    recovery: RecoveryContext;
    currentBaseSha: string;
    authorizedHeadSha: string;
  },
): Promise<void> => {
  const adopted = await tx.mergeRecoveryAttempt.updateMany({
    where: {
      id: input.recovery.aggregateId,
      status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      recoveryRunId: input.recovery.recoveryRunId,
      currentBaseSha: input.recovery.currentBaseSha,
      authorizedHeadSha: input.recovery.authorizedHeadSha,
    },
    data: {
      currentBaseSha: input.currentBaseSha,
      authorizedHeadSha: input.authorizedHeadSha,
    },
  });
  if (adopted.count !== 1) {
    throw new Error("Recovery authorization could not adopt the verified regression head");
  }
};
