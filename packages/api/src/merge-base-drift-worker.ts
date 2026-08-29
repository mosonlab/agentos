import {
  ACTIVE_RUN_STATUSES,
  INTEGRATOR_OUTPUT_KIND,
  MAX_BASE_DRIFT_CLASSIFICATION_RETRIES,
  MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
  MergeRecoveryStatus,
  MERGE_INTEGRATOR_KIND,
  Prisma,
  TaskStatus,
  asJsonObject,
  isMergeReadinessStep,
  latestRecordedStop,
  lockChainRows,
  openStopQuestion,
  parseMergeResult,
  REGRESSION_VERIFICATION_OUTPUT_KINDS,
  resolveChainTarget,
  selectAuthorization,
  taskIsIntegratorStep,
  type CardRow,
  type CandidateActivity,
  type DecisionRow,
  type PrismaClient,
  type MergeRecoveryAttempt,
} from "@anneal/db";

import { createGitHubReader, type PullRequestReader, type PullRequestSnapshot } from "./github-read.js";
import {
  classifyCandidate,
  classifyDurable,
  classifyFresh,
  classifyRetryBudget,
  type CandidateLoad,
  type CandidateRefusalCode,
  type Ineligible,
  type RecoveryCandidate,
  type RecoveryIdentity,
  type Retry,
} from "./base-drift-recovery-decision.js";
import { stopMergeTail } from "./merge-tail-actions.js";
import {
  ensureRecoveryValidation,
  enterRepair,
  recordValidationRetry,
  recoveryIsReopenableLegacyRefusal,
  retireLegacyRefusal,
} from "./merge-tail-state.js";

type DbReader = PrismaClient | Prisma.TransactionClient;

const SHA = /^[0-9a-f]{40}$/u;
export const baseDriftRecoveryPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_BASE_DRIFT_RECOVERY_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

const recoveryAttemptFor = async (
  db: DbReader,
  integratorTaskId: string,
  sourceStopId: string,
): Promise<MergeRecoveryAttempt | null> => db.mergeRecoveryAttempt.findFirst({
  where: { integratorTaskId, sourceStopId },
  orderBy: [{ attempt: "desc" }, { id: "desc" }],
});

const parseBaseDriftEvidence = (evidence: string): { observed: string; authorized: string } | null => {
  let value: unknown;
  try { value = JSON.parse(evidence); } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "authorized,observed") return null;
  if (typeof record.observed !== "string" || !SHA.test(record.observed)) return null;
  if (typeof record.authorized !== "string" || !SHA.test(record.authorized)) return null;
  if (record.observed === record.authorized) return null;
  return { observed: record.observed, authorized: record.authorized };
};

/**
 * Base-drift recovery mutates the three merge-tail Steps together, so it uses
 * the same ordered, whole-Chain mutex as every other chained-task writer.
 * Chain identity is immutable after dispatch and can select that mutex before
 * any mutable state is read.
 */
const lockRecoveryChain = async (
  tx: Prisma.TransactionClient,
  integratorTaskId: string,
): Promise<boolean> => {
  const identity = await tx.task.findUnique({
    where: { id: integratorTaskId },
    select: { projectId: true, chainId: true },
  });
  const chainId = identity?.chainId;
  if (!identity || !chainId) return false;
  const taskIds = await lockChainRows(tx, { projectId: identity.projectId, chainId });
  return taskIds.includes(integratorTaskId);
};

const loadCandidate = async (db: DbReader, integratorTaskId: string): Promise<CandidateLoad> => {
  const task = await db.task.findUnique({
    where: { id: integratorTaskId },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: true },
  });
  if (!task || !taskIsIntegratorStep(task)) return { kind: "skip" };
  const stop = await latestRecordedStop(db as Prisma.TransactionClient, task.id);
  if (!stop || stop.condition !== "base-drift") return { kind: "skip" };
  const existingAttempt = await recoveryAttemptFor(db, task.id, stop.stopId);
  if (existingAttempt
    && existingAttempt.status !== MergeRecoveryStatus.VALIDATING
    && !recoveryIsReopenableLegacyRefusal(existingAttempt)) return { kind: "skip" };
  const refuse = (code: CandidateRefusalCode, detail?: string): CandidateLoad => ({
    kind: "refused", code, stopId: stop.stopId, ...(detail ? { detail } : {}),
  });
  if (!task.chainId || task.chainIndex === null || !task.repoId || !task.repo) return refuse("identity-incomplete");
  if (!stop.sourceRunId) return refuse("source-run-unbound");
  const evidence = parseBaseDriftEvidence(stop.evidence);
  if (!evidence) return refuse("evidence-invalid");

  const sourceRun = await db.run.findUnique({
    where: { id: stop.sourceRunId },
    include: { session: { select: { id: true } } },
  });
  if (!sourceRun || sourceRun.taskId !== task.id || sourceRun.status !== "SUCCEEDED" || !sourceRun.session) {
    return refuse("source-run-mismatch");
  }
  const active = await db.run.count({
    where: { task: { projectId: task.projectId, chainId: task.chainId }, status: { in: ACTIVE_RUN_STATUSES } },
  });
  if (active !== 0) return refuse("chain-active");

  const output = await db.taskStepOutput.findUnique({ where: { taskId: task.id } });
  const outputResult = parseMergeResult(output);
  if (output?.runId !== sourceRun.id || output?.kind !== INTEGRATOR_OUTPUT_KIND
    || outputResult.outcome !== "stopped" || outputResult.condition !== "base-drift"
    || outputResult.evidence !== stop.evidence) {
    return refuse("output-mismatch");
  }

  const [readiness, regression] = await Promise.all([
    db.task.findFirst({
      where: { projectId: task.projectId, chainId: task.chainId, chainIndex: task.chainIndex - 1 },
      include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, stepOutput: true },
    }),
    db.task.findFirst({
      where: {
        projectId: task.projectId,
        chainId: task.chainId,
        templateStep: { outputKind: { in: [...REGRESSION_VERIFICATION_OUTPUT_KINDS] } },
      },
    }),
  ]);
  if (!readiness || !isMergeReadinessStep(readiness.templateStep) || !regression) {
    return refuse("tail-unresolved");
  }
  if (task.status !== TaskStatus.REVIEW || readiness.status !== TaskStatus.DONE || regression.status !== TaskStatus.DONE) {
    return refuse("tail-state-mismatch");
  }

  const activities = await db.taskActivity.findMany({
    where: { taskId: readiness.id }, orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, actorType: true, metadata: true },
  });
  const cards = await db.inboxMessage.findMany({
    where: { gateTaskId: readiness.id },
    select: { id: true, gateTaskId: true, status: true, selectedChoiceId: true, body: true },
  });
  const decisions = await db.inboxDecision.findMany({
    where: { inboxMessageId: { in: cards.map((card) => card.id) } },
    select: { id: true, decision: true, createdAt: true, inboxMessageId: true },
  });
  const selection = selectAuthorization(
    activities as CandidateActivity[], decisions as DecisionRow[], cards as CardRow[], readiness.id,
  );
  if (!selection.authorization || selection.refusal) return refuse("authorization-invalid", selection.refusal ?? "missing");
  const authorization = selection.authorization;

  const intentRows = await db.taskActivity.findMany({
    where: { taskId: task.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.intent } },
    orderBy: { createdAt: "asc" }, select: { metadata: true },
  });
  const intents = intentRows.map((row) => asJsonObject(row.metadata)).filter((metadata) => metadata?.sourceRunId === sourceRun.id);
  // The executor's first pull-request read can observe base drift before the
  // irreversible path writes an intent. A successful, run-bound stop with no
  // intent is therefore the expected pre-intent shape and is safe to recover.
  // Once an intent exists it must still bind the selected authorization, and
  // multiple rows remain ambiguous rather than being guessed through.
  if (intents.length > 1) return refuse("intent-count");
  const intent = intents[0];
  if (intent && (intent.authorizationActivityId !== authorization.activityId
    || intent.prNumber !== authorization.prNumber || intent.headSha !== authorization.headSha)) {
    return refuse("intent-mismatch");
  }
  if (evidence.authorized !== authorization.baseSha) return refuse("authorized-base-mismatch");
  if (readiness.stepOutput?.commitSha !== authorization.headSha) return refuse("readiness-head-mismatch");

  const target = await resolveChainTarget(db as Prisma.TransactionClient, task);
  if (!target.resolved) return refuse("target-unresolved", target.unresolvable);
  if (target.repository !== authorization.repository || target.prNumber !== authorization.prNumber) {
    return refuse("target-mismatch");
  }
  const firstRun = await db.run.findFirst({
    where: { task: { projectId: task.projectId, chainId: task.chainId, chainIndex: { not: null } } },
    orderBy: [{ task: { chainIndex: "asc" } }, { runNumber: "asc" }], select: { targetBranch: true },
  });
  // The chain's first Run pins the authorized base. The integrator Task may
  // instead carry the delivered feature branch propagated through the chain.
  if (firstRun?.targetBranch !== authorization.baseRef) {
    return refuse("target-branch-mismatch");
  }
  return { kind: "candidate", candidate: {
    integratorTaskId: task.id,
    readinessTaskId: readiness.id,
    regressionTaskId: regression.id,
    sourceRunId: sourceRun.id,
    stopId: stop.stopId,
    authorizationActivityId: authorization.activityId,
    repository: target.repository,
    prNumber: target.prNumber,
    targetBranch: authorization.baseRef,
    authorizedHeadSha: authorization.headSha,
    authorizedBaseSha: authorization.baseSha,
    observedBaseSha: evidence.observed,
  } };
};

const openAbandonQuestion = async (
  tx: Prisma.TransactionClient,
  integratorTaskId: string,
  stopId: string,
): Promise<void> => {
  const [task, stop] = await Promise.all([
    tx.task.findUnique({ where: { id: integratorTaskId }, select: { assigneeAgentId: true } }),
    latestRecordedStop(tx, integratorTaskId),
  ]);
  if (!task?.assigneeAgentId || stop?.stopId !== stopId) {
    throw new Error(`Cannot open abandon-only base-drift question for unresolved stop ${stopId}`);
  }
  const session = stop.sourceRunId
    ? await tx.session.findUnique({ where: { runId: stop.sourceRunId }, select: { id: true } })
    : null;
  await openStopQuestion(tx, {
    integratorTaskId,
    stopId,
    condition: "base-drift",
    evidence: stop.evidence,
    agentId: task.assigneeAgentId,
    sessionId: session?.id ?? null,
  });
};

const settleIneligibleLocked = async (
  tx: Prisma.TransactionClient,
  integratorTaskId: string,
  stopId: string,
  reason: string,
  identity?: Partial<RecoveryIdentity>,
): Promise<void> => {
  const attempt = await ensureRecoveryValidation(tx, { integratorTaskId, sourceStopId: stopId });
  await stopMergeTail(tx, {
    phase: "recovery-validation",
    aggregateId: attempt.id,
    integratorTaskId,
    sourceStopId: stopId,
    reason,
    at: new Date(),
    attempt: attempt.attempt,
    recoveryData: {
      ...(identity?.repository ? { repository: identity.repository } : {}),
      ...(identity?.prNumber ? { prNumber: identity.prNumber } : {}),
      ...(identity?.targetBranch ? { targetBranch: identity.targetBranch } : {}),
      ...(identity?.authorizedHeadSha ? { authorizedHeadSha: identity.authorizedHeadSha } : {}),
      ...(identity?.authorizedBaseSha ? { authorizedBaseSha: identity.authorizedBaseSha } : {}),
      ...(identity?.observedBaseSha ? { observedBaseSha: identity.observedBaseSha } : {}),
    },
    markerMetadata: { ...identity },
  });
  await openAbandonQuestion(tx, integratorTaskId, stopId);
};

const settleIneligible = async (
  db: PrismaClient,
  integratorTaskId: string,
  stopId: string,
  reason: string,
  identity?: Partial<RecoveryIdentity>,
): Promise<boolean> => db.$transaction(async (tx) => {
  if (!await lockRecoveryChain(tx, integratorTaskId)) return false;
  const currentStop = await latestRecordedStop(tx, integratorTaskId);
  if (currentStop?.stopId !== stopId) return false;
  const existing = await recoveryAttemptFor(tx, integratorTaskId, stopId);
  if (existing && existing.status !== MergeRecoveryStatus.VALIDATING) {
    if (!recoveryIsReopenableLegacyRefusal(existing)) return false;
    await retireLegacyRefusal(tx, {
      aggregateId: existing.id,
      integratorTaskId,
      sourceStopId: stopId,
      priorReason: existing.failureReason,
      reason,
      at: new Date(),
    });
    await openAbandonQuestion(tx, integratorTaskId, stopId);
    return true;
  }
  await settleIneligibleLocked(tx, integratorTaskId, stopId, reason, identity);
  return true;
});

const recordClassificationRetry = async (
  db: PrismaClient,
  integratorTaskId: string,
  stopId: string,
  reason: string,
): Promise<"retryable" | "ineligible" | "skipped"> => db.$transaction(async (tx) => {
  if (!await lockRecoveryChain(tx, integratorTaskId)) return "skipped";
  const currentStop = await latestRecordedStop(tx, integratorTaskId);
  if (currentStop?.stopId !== stopId) return "skipped";
  const attempt = await ensureRecoveryValidation(tx, { integratorTaskId, sourceStopId: stopId });
  if (attempt.status !== MergeRecoveryStatus.VALIDATING) return "skipped";
  const decision = classifyRetryBudget({
    reason,
    validationAttempts: attempt.validationAttempts,
    maxAttempts: MAX_BASE_DRIFT_CLASSIFICATION_RETRIES,
  });
  switch (decision.kind) {
    case "ineligible":
      await settleIneligibleLocked(
        tx,
        integratorTaskId,
        stopId,
        decision.reason,
      );
      return "ineligible";
    case "retry":
      break;
  }
  const classificationAttempt = decision.classificationAttempt;
  await recordValidationRetry(tx, {
    aggregateId: attempt.id,
    integratorTaskId,
    sourceStopId: stopId,
    classificationAttempt,
    maxAttempts: MAX_BASE_DRIFT_CLASSIFICATION_RETRIES,
    reason,
  });
  return "retryable";
});

type QueueRecoveryResult =
  | { kind: "recovered" }
  | { kind: "exhausted" }
  | { kind: "skip" }
  | { kind: "ineligible"; reason: string }
  | { kind: "retry"; reason: string };

const queueRecovery = async (
  db: PrismaClient,
  expected: RecoveryCandidate,
  currentBaseSha: string,
  now: Date,
): Promise<QueueRecoveryResult> => db.$transaction(async (tx) => {
  if (!await lockRecoveryChain(tx, expected.integratorTaskId)) return { kind: "skip" };
  const aggregate = await ensureRecoveryValidation(tx, {
    integratorTaskId: expected.integratorTaskId,
    sourceStopId: expected.stopId,
    identity: expected,
  });
  const loaded = await loadCandidate(tx, expected.integratorTaskId);

  // A recovery spends an attempt only once it owns a fresh regression Run.
  // Validation refusals remain visible aggregate rows but do not consume the
  // two executor-drift attempts. Historical TaskActivity rows are deliberately
  // ignored: the migration has no backfill, so absence here means zero.
  const attempts = await tx.mergeRecoveryAttempt.count({ where: {
    id: { not: aggregate.id },
    integratorTaskId: expected.integratorTaskId,
    repository: expected.repository,
    prNumber: expected.prNumber,
    targetBranch: expected.targetBranch,
    recoveryRunId: { not: null },
  } });
  const decision = classifyDurable({
    expected,
    load: loaded,
    aggregateValidating: aggregate.status === MergeRecoveryStatus.VALIDATING,
    recoveryCount: attempts,
    maxRecoveries: MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
    currentBaseSha,
  });
  switch (decision.kind) {
    case "skip":
      return { kind: "skip" };
    case "retry":
      return { kind: "retry", reason: decision.reason };
    case "ineligible":
      return { kind: "ineligible", reason: decision.reason };
    case "exhausted":
      break;
    case "queue":
      break;
  }
  const attempt = aggregate.attempt;
  const common = {
    sourceStopId: expected.stopId,
    sourceRunId: expected.sourceRunId,
    integratorTaskId: expected.integratorTaskId,
    authorizationActivityId: expected.authorizationActivityId,
    repository: expected.repository,
    prNumber: expected.prNumber,
    targetBranch: expected.targetBranch,
    authorizedHeadSha: expected.authorizedHeadSha,
    authorizedBaseSha: expected.authorizedBaseSha,
    observedBaseSha: expected.observedBaseSha,
    currentBaseSha,
    attempt,
    readinessTaskId: expected.readinessTaskId,
    regressionTaskId: expected.regressionTaskId,
  };
  switch (decision.kind) {
    case "exhausted":
      await stopMergeTail(tx, {
        phase: "recovery-exhausted",
        aggregateId: aggregate.id,
        integratorTaskId: expected.integratorTaskId,
        sourceStopId: expected.stopId,
        reason: decision.reason,
        at: now,
        attempt,
        recoveryData: {
          boundSourceRunId: expected.sourceRunId,
          authorizationActivityId: expected.authorizationActivityId,
          readinessTaskId: expected.readinessTaskId,
          regressionTaskId: expected.regressionTaskId,
          repository: expected.repository,
          prNumber: expected.prNumber,
          targetBranch: expected.targetBranch,
          authorizedHeadSha: expected.authorizedHeadSha,
          authorizedBaseSha: expected.authorizedBaseSha,
          observedBaseSha: expected.observedBaseSha,
          currentBaseSha,
        },
        markerMetadata: common,
      });
      await openAbandonQuestion(tx, expected.integratorTaskId, expected.stopId);
      return { kind: "exhausted" };
    case "queue":
      break;
  }

  await enterRepair(tx, { aggregateId: aggregate.id, currentBaseSha, now });
  return { kind: "recovered" };
});

export type RecoveryTickDelta = { recovered: number; exhausted: number; ineligible: number };

type RecoverySettlementTask = {
  id: string;
  identity?: Partial<RecoveryIdentity>;
};

type RecoverySettlementDecision = Retry | Ineligible | QueueRecoveryResult;

type RecoverySettlementOperations = {
  recordRetry: typeof recordClassificationRetry;
  settleIneligible: typeof settleIneligible;
};

const recoverySettlementOperations: RecoverySettlementOperations = {
  recordRetry: recordClassificationRetry,
  settleIneligible,
};

export const settleRecovery = async (
  db: PrismaClient,
  task: RecoverySettlementTask,
  stopId: string,
  decision: RecoverySettlementDecision,
  operations: RecoverySettlementOperations = recoverySettlementOperations,
): Promise<RecoveryTickDelta> => {
  const tickDelta: RecoveryTickDelta = { recovered: 0, exhausted: 0, ineligible: 0 };
  switch (decision.kind) {
    case "skip":
      return tickDelta;
    case "recovered":
      return { ...tickDelta, recovered: 1 };
    case "exhausted":
      return { ...tickDelta, exhausted: 1 };
    case "retry": {
      const outcome = await operations.recordRetry(db, task.id, stopId, decision.reason);
      return outcome === "ineligible" ? { ...tickDelta, ineligible: 1 } : tickDelta;
    }
    case "ineligible": {
      const settled = await operations.settleIneligible(db, task.id, stopId, decision.reason, task.identity);
      return settled ? { ...tickDelta, ineligible: 1 } : tickDelta;
    }
  }
};

export type BaseDriftRecoveryTickResult = { examined: number; recovered: number; exhausted: number; ineligible: number };

const addTickDelta = (result: BaseDriftRecoveryTickResult, delta: RecoveryTickDelta): void => {
  result.recovered += delta.recovered;
  result.exhausted += delta.exhausted;
  result.ineligible += delta.ineligible;
};

export const baseDriftRecoveryTick = async (
  db: PrismaClient,
  reader: PullRequestReader | null = createGitHubReader(),
  now = new Date(),
  limit = 5,
): Promise<BaseDriftRecoveryTickResult> => {
  const result: BaseDriftRecoveryTickResult = { examined: 0, recovered: 0, exhausted: 0, ineligible: 0 };
  const where: Prisma.TaskWhereInput = {
    status: TaskStatus.REVIEW,
    templateStep: { outputKind: INTEGRATOR_OUTPUT_KIND },
  };
  const pageSize = Math.max(limit * 10, 50);
  let cursor: string | null = null;
  while (result.examined < limit) {
    const tasks: Array<{ id: string }> = await db.task.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true },
    });
    if (tasks.length === 0) break;
    for (const task of tasks) {
      cursor = task.id;
      if (result.examined >= limit) break;
      const loaded = await loadCandidate(db, task.id);
      const candidateDecision = classifyCandidate(loaded);
      switch (candidateDecision.kind) {
        case "skip":
          continue;
        case "retry":
        case "ineligible":
          result.examined += 1;
          addTickDelta(result, await settleRecovery(db, task, candidateDecision.stopId, candidateDecision));
          continue;
        case "inspect":
          result.examined += 1;
          break;
      }
      const candidate = candidateDecision.candidate;
      const settlementTask = { id: task.id, identity: candidate };
      const validation = await db.$transaction(async (tx) => {
        if (!await lockRecoveryChain(tx, candidate.integratorTaskId)) return false;
        const attempt = await ensureRecoveryValidation(tx, {
          integratorTaskId: candidate.integratorTaskId,
          sourceStopId: candidate.stopId,
          identity: candidate,
        });
        return attempt.status === MergeRecoveryStatus.VALIDATING;
      });
      if (!validation) continue;
      if (!reader) {
        const decision = classifyFresh({ kind: "reader-unavailable" });
        addTickDelta(result, await settleRecovery(db, settlementTask, candidate.stopId, decision));
        continue;
      }
      let snapshot: PullRequestSnapshot;
      let authorizedAdvance: { status: string; behindBy: number } | null = null;
      let observedAdvance: { status: string; behindBy: number } | null = null;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          snapshot = await reader.readPullRequest(candidate.repository, candidate.prNumber, candidate.targetBranch, controller.signal);
          if (reader.compareCommits && snapshot.baseSha) {
            authorizedAdvance = await reader.compareCommits(
              candidate.repository, candidate.authorizedBaseSha, snapshot.baseSha, controller.signal,
            );
            if (authorizedAdvance.status === "ahead" && authorizedAdvance.behindBy === 0
              && candidate.observedBaseSha !== snapshot.baseSha) {
              observedAdvance = await reader.compareCommits(
                candidate.repository, candidate.observedBaseSha, snapshot.baseSha, controller.signal,
              );
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (error: unknown) {
        const decision = classifyFresh({
          kind: "reader-failure",
          reason: `fresh server-side repository read failed (${error instanceof Error ? error.name : "unknown error"})`,
        });
        addTickDelta(result, await settleRecovery(db, settlementTask, candidate.stopId, decision));
        continue;
      }
      const fresh = classifyFresh({
        kind: "snapshot",
        candidate,
        snapshot,
        comparisonAvailable: reader.compareCommits !== undefined,
        authorizedAdvance,
        observedAdvance,
      });
      switch (fresh.kind) {
        case "retry":
        case "ineligible":
          addTickDelta(result, await settleRecovery(db, settlementTask, candidate.stopId, fresh));
          continue;
        case "queue":
          break;
      }
      const outcome = await queueRecovery(db, candidate, fresh.currentBaseSha, now);
      addTickDelta(result, await settleRecovery(db, settlementTask, candidate.stopId, outcome));
    }
    if (tasks.length < pageSize) break;
  }
  return result;
};

export const startBaseDriftRecoveryWorker = (
  db: PrismaClient,
  reader: PullRequestReader | null = createGitHubReader(),
): ReturnType<typeof setInterval> => {
  const run = (): void => {
    void baseDriftRecoveryTick(db, reader).catch((error: unknown) => console.error("Base-drift recovery tick failed", error));
  };
  run();
  const timer = setInterval(run, baseDriftRecoveryPollIntervalMs());
  timer.unref?.();
  return timer;
};
