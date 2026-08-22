import {
  ACTIVE_RUN_STATUSES,
  INTEGRATOR_OUTPUT_KIND,
  MAX_BASE_DRIFT_CLASSIFICATION_RETRIES,
  MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES,
  MERGE_INTEGRATOR_KIND,
  MERGE_TAIL_KIND,
  Prisma,
  TaskStatus,
  asJsonObject,
  enqueueTaskRun,
  isMergeReadinessStep,
  latestRecordedStop,
  openStopQuestion,
  parseBaseDriftRecoveryActivity,
  parseMergeResult,
  resolveChainTarget,
  selectAuthorization,
  taskIsIntegratorStep,
  type CardRow,
  type CandidateActivity,
  type DecisionRow,
  type PrismaClient,
} from "@agentos/db";

import { createGitHubReader, type GitHubReader, type PullRequestSnapshot } from "./github-read.js";

type DbReader = PrismaClient | Prisma.TransactionClient;

const SHA = /^[0-9a-f]{40}$/u;
const RECOVERY_NOTIFICATION_PREFIX = "merge-base-drift-recovery";

export const baseDriftRecoveryPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_BASE_DRIFT_RECOVERY_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

type RecoveryIdentity = {
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
};

type RecoveryCandidate = RecoveryIdentity & {
  integratorTaskId: string;
  readinessTaskId: string;
  regressionTaskId: string;
  sourceRunId: string;
  stopId: string;
  authorizationActivityId: string;
};

type CandidateLoad =
  | { ok: true; candidate: RecoveryCandidate }
  | { ok: false; reason: string; stopId: string; retryable: boolean };

const recoveryMarkerFor = async (db: DbReader, taskId: string, stopId: string) => {
  const rows = await db.taskActivity.findMany({
    where: { taskId, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.baseDriftRecovery } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { taskId: true, actorType: true, metadata: true },
  });
  return rows
    .map((row) => parseBaseDriftRecoveryActivity(row, {
      activityTaskId: taskId,
      integratorTaskId: taskId,
      sourceStopId: stopId,
    }))
    .find((metadata) => metadata !== null && metadata.state !== "classification-retry") ?? null;
};

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

const loadCandidate = async (db: DbReader, integratorTaskId: string): Promise<CandidateLoad | null> => {
  const task = await db.task.findUnique({
    where: { id: integratorTaskId },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: true },
  });
  if (!task || !taskIsIntegratorStep(task)) return null;
  const stop = await latestRecordedStop(db as Prisma.TransactionClient, task.id);
  if (!stop || stop.condition !== "base-drift") return null;
  if (await recoveryMarkerFor(db, task.id, stop.stopId)) return null;
  const fail = (reason: string, retryable = false): CandidateLoad => ({
    ok: false, reason, stopId: stop.stopId, retryable,
  });
  if (!task.chainId || task.chainIndex === null || !task.repoId || !task.repo) return fail("chain or repository identity is incomplete");
  if (!stop.sourceRunId) return fail("stop is not bound to an executor run");
  const evidence = parseBaseDriftEvidence(stop.evidence);
  if (!evidence) return fail("base-drift evidence is malformed or is not a SHA-only drift payload");

  const sourceRun = await db.run.findUnique({
    where: { id: stop.sourceRunId },
    include: { session: { select: { id: true } } },
  });
  if (!sourceRun || sourceRun.taskId !== task.id || sourceRun.status !== "SUCCEEDED" || !sourceRun.session) {
    return fail("source executor run identity or terminal state does not match the stop");
  }
  const active = await db.run.count({
    where: { task: { projectId: task.projectId, chainId: task.chainId }, status: { in: ACTIVE_RUN_STATUSES } },
  });
  if (active !== 0) return fail("the chain has an active foreign run while recovery is being classified", true);

  const output = await db.taskStepOutput.findUnique({ where: { taskId: task.id } });
  const outputResult = parseMergeResult(output);
  if (output?.runId !== sourceRun.id || output?.kind !== INTEGRATOR_OUTPUT_KIND
    || outputResult.outcome !== "stopped" || outputResult.condition !== "base-drift"
    || outputResult.evidence !== stop.evidence) {
    return fail("executor output does not exactly match the recorded source stop");
  }

  const [readiness, regression] = await Promise.all([
    db.task.findFirst({
      where: { projectId: task.projectId, chainId: task.chainId, chainIndex: task.chainIndex - 1 },
      include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, stepOutput: true },
    }),
    db.task.findFirst({
      where: { projectId: task.projectId, chainId: task.chainId, templateStep: { outputKind: "regression-verification" } },
    }),
  ]);
  if (!readiness || !isMergeReadinessStep(readiness.templateStep) || !regression) {
    return fail("current direct/compound regression and readiness tail cannot be resolved");
  }
  if (task.status !== TaskStatus.REVIEW || readiness.status !== TaskStatus.DONE || regression.status !== TaskStatus.DONE) {
    return fail("merge tail task state is not the completed-readiness/stopped-executor shape");
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
  if (!selection.authorization || selection.refusal) return fail(`authorized readiness evidence is ${selection.refusal ?? "missing"}`);
  const authorization = selection.authorization;

  const intentRows = await db.taskActivity.findMany({
    where: { taskId: task.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.intent } },
    orderBy: { createdAt: "asc" }, select: { metadata: true },
  });
  const intents = intentRows.map((row) => asJsonObject(row.metadata)).filter((metadata) => metadata?.sourceRunId === sourceRun.id);
  if (intents.length !== 1) return fail("source executor run does not have exactly one server-bound merge intent");
  const intent = intents[0]!;
  if (intent.authorizationActivityId !== authorization.activityId
    || intent.prNumber !== authorization.prNumber || intent.headSha !== authorization.headSha) {
    return fail("executor intent does not match the selected authorization");
  }
  if (evidence.authorized !== authorization.baseSha) return fail("stop evidence does not match the authorized base SHA");
  if (readiness.stepOutput?.commitSha !== authorization.headSha) return fail("readiness output does not match the authorized head SHA");

  const target = await resolveChainTarget(db as Prisma.TransactionClient, task);
  if (!target.resolved) return fail(`pull-request identity is ${target.unresolvable}`);
  if (target.repository !== authorization.repository || target.prNumber !== authorization.prNumber) {
    return fail("resolved repository or pull-request identity differs from the authorization");
  }
  const firstRun = await db.run.findFirst({
    where: { task: { projectId: task.projectId, chainId: task.chainId, chainIndex: { not: null } } },
    orderBy: [{ task: { chainIndex: "asc" } }, { runNumber: "asc" }], select: { targetBranch: true },
  });
  if (firstRun?.targetBranch !== authorization.baseRef || task.targetBranch !== authorization.baseRef) {
    return fail("authorized target ref differs from the chain target branch");
  }
  return { ok: true, candidate: {
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

const snapshotRefusal = (candidate: RecoveryCandidate, snapshot: PullRequestSnapshot): string | null => {
  if (snapshot.repository !== candidate.repository || snapshot.number !== candidate.prNumber) return "fresh repository or pull-request identity mismatches the authorization";
  if (snapshot.state !== "OPEN" || snapshot.merged !== false) return "pull request is no longer an unmerged OPEN pull request";
  if (snapshot.isDraft !== false) return "pull request draft state changed after authorization";
  if (snapshot.autoMergeRequest !== null || snapshot.mergeQueueEntry !== null) return "pull request entered foreign automatic merge machinery";
  if (snapshot.baseRefName !== candidate.targetBranch) return "target ref changed after authorization";
  if (snapshot.headRefOid !== candidate.authorizedHeadSha || snapshot.headCommitOid !== candidate.authorizedHeadSha) {
    return "pull-request head changed after authorization";
  }
  if (!snapshot.baseSha || !SHA.test(snapshot.baseSha) || snapshot.baseSha === candidate.authorizedBaseSha) {
    return "fresh target base does not prove an advanced SHA";
  }
  return null;
};

const notificationBody = (state: "ineligible" | "exhausted", stopId: string, reason: string): string => (
  `Automatic pre-merge base-drift recovery ${state} for stop ${stopId}: ${reason}. No regression run or re-authorization was created.`
);

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
  await tx.taskActivity.create({ data: {
    taskId: integratorTaskId, actorType: "control-plane",
    body: `Automatic pre-merge base-drift recovery refused: ${reason}`,
    metadata: {
      kind: MERGE_TAIL_KIND.baseDriftRecovery, schemaVersion: 1, state: "ineligible",
      ...identity, integratorTaskId, sourceStopId: stopId, reason,
    },
  } });
  const dedupeKey = `${RECOVERY_NOTIFICATION_PREFIX}:ineligible:${stopId}`;
  await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
    from: "AGENT", taskId: integratorTaskId, kind: "TEXT",
    body: notificationBody("ineligible", stopId, reason), dedupeKey,
  }, update: {} });
  await openAbandonQuestion(tx, integratorTaskId, stopId);
  await tx.task.update({ where: { id: integratorTaskId }, data: {
    status: TaskStatus.REVIEW, failureReason: `Automatic base-drift recovery refused: ${reason}`,
  } });
};

const settleIneligible = async (
  db: PrismaClient,
  integratorTaskId: string,
  stopId: string,
  reason: string,
  identity?: Partial<RecoveryIdentity>,
): Promise<boolean> => db.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${integratorTaskId} FOR UPDATE`;
  const currentStop = await latestRecordedStop(tx, integratorTaskId);
  if (currentStop?.stopId !== stopId) return false;
  if (await recoveryMarkerFor(tx, integratorTaskId, stopId)) return false;
  await settleIneligibleLocked(tx, integratorTaskId, stopId, reason, identity);
  return true;
});

const recordClassificationRetry = async (
  db: PrismaClient,
  integratorTaskId: string,
  stopId: string,
  reason: string,
): Promise<"retryable" | "ineligible" | "skipped"> => db.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${integratorTaskId} FOR UPDATE`;
  const currentStop = await latestRecordedStop(tx, integratorTaskId);
  if (currentStop?.stopId !== stopId || await recoveryMarkerFor(tx, integratorTaskId, stopId)) return "skipped";
  const rows = await tx.taskActivity.findMany({
    where: { taskId: integratorTaskId, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.baseDriftRecovery } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { taskId: true, actorType: true, metadata: true },
  });
  const prior = rows.map((row) => parseBaseDriftRecoveryActivity(row, {
    activityTaskId: integratorTaskId, integratorTaskId, sourceStopId: stopId,
  })).filter((metadata) => metadata?.state === "classification-retry").length;
  const classificationAttempt = prior + 1;
  if (classificationAttempt > MAX_BASE_DRIFT_CLASSIFICATION_RETRIES) {
    await settleIneligibleLocked(
      tx,
      integratorTaskId,
      stopId,
      `classification retry limit ${MAX_BASE_DRIFT_CLASSIFICATION_RETRIES} reached after transient failure: ${reason}`,
    );
    return "ineligible";
  }
  await tx.taskActivity.create({ data: {
    taskId: integratorTaskId,
    actorType: "control-plane",
    body: `Automatic pre-merge base-drift classification deferred (${classificationAttempt}/${MAX_BASE_DRIFT_CLASSIFICATION_RETRIES}): ${reason}`,
    metadata: {
      kind: MERGE_TAIL_KIND.baseDriftRecovery,
      schemaVersion: 1,
      state: "classification-retry",
      integratorTaskId,
      sourceStopId: stopId,
      classificationAttempt,
      reason,
    },
  } });
  return "retryable";
});

const queueRecovery = async (
  db: PrismaClient,
  expected: RecoveryCandidate,
  currentBaseSha: string,
  now: Date,
): Promise<"recovered" | "exhausted" | "skipped" | "ineligible" | "retryable"> => db.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${expected.integratorTaskId} FOR UPDATE`;
  if (await recoveryMarkerFor(tx, expected.integratorTaskId, expected.stopId)) return "skipped";
  const loaded = await loadCandidate(tx, expected.integratorTaskId);
  if (!loaded) return "ineligible";
  if (!loaded.ok) return loaded.retryable ? "retryable" : "ineligible";
  const fields: Array<keyof RecoveryCandidate> = [
    "integratorTaskId", "readinessTaskId", "regressionTaskId", "sourceRunId", "stopId",
    "authorizationActivityId", "repository", "prNumber", "targetBranch", "authorizedHeadSha",
    "authorizedBaseSha", "observedBaseSha",
  ];
  if (fields.some((field) => loaded.candidate[field] !== expected[field])) return "ineligible";

  const history = await tx.taskActivity.findMany({
    where: { taskId: expected.integratorTaskId, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.baseDriftRecovery } },
    select: { taskId: true, actorType: true, metadata: true },
  });
  const attempts = history.map((row) => parseBaseDriftRecoveryActivity(row, {
    activityTaskId: expected.integratorTaskId,
    integratorTaskId: expected.integratorTaskId,
  })).filter((metadata) => (
    metadata?.state === "queued"
    && metadata.repository === expected.repository
    && metadata.prNumber === expected.prNumber
    && metadata.targetBranch === expected.targetBranch
  )).length;
  const attempt = attempts + 1;
  const common = {
    kind: MERGE_TAIL_KIND.baseDriftRecovery,
    schemaVersion: 1,
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
  if (attempt > MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES) {
    const reason = `automatic recovery limit ${MAX_AUTOMATIC_BASE_DRIFT_RECOVERIES} reached for ${expected.repository}#${expected.prNumber} targeting ${expected.targetBranch}`;
    await tx.taskActivity.create({ data: {
      taskId: expected.integratorTaskId, actorType: "control-plane",
      body: `Automatic pre-merge base-drift recovery exhausted at attempt ${attempt}`,
      metadata: { ...common, state: "exhausted", reason },
    } });
    const dedupeKey = `${RECOVERY_NOTIFICATION_PREFIX}:exhausted:${expected.stopId}`;
    await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
      from: "AGENT", taskId: expected.integratorTaskId, kind: "TEXT",
      body: notificationBody("exhausted", expected.stopId, reason), dedupeKey,
    }, update: {} });
    await openAbandonQuestion(tx, expected.integratorTaskId, expected.stopId);
    await tx.task.update({ where: { id: expected.integratorTaskId }, data: {
      status: TaskStatus.REVIEW, failureReason: reason,
    } });
    return "exhausted";
  }

  await tx.task.update({ where: { id: expected.regressionTaskId }, data: { status: TaskStatus.TODO, failureReason: null } });
  await tx.task.update({ where: { id: expected.readinessTaskId }, data: { status: TaskStatus.TODO, failureReason: null } });
  await tx.task.update({ where: { id: expected.integratorTaskId }, data: {
    status: TaskStatus.REVIEW,
    failureReason: `Automatic base-drift recovery ${attempt} queued from stop ${expected.stopId}`,
  } });
  const run = await enqueueTaskRun(tx, expected.regressionTaskId, now);
  const metadata = { ...common, state: "queued", recoveryRunId: run.id,
  };
  await tx.taskActivity.createMany({ data: [
    {
      taskId: expected.integratorTaskId, actorType: "control-plane",
      body: `Automatic base-drift recovery ${attempt} parked stop ${expected.stopId} and queued fresh regression`,
      metadata,
    },
    {
      taskId: expected.regressionTaskId, actorType: "control-plane",
      body: `Automatic base-drift recovery ${attempt} verifies ${expected.authorizedHeadSha} against current base ${currentBaseSha}`,
      metadata,
    },
  ] });
  return "recovered";
});

export type BaseDriftRecoveryTickResult = { examined: number; recovered: number; exhausted: number; ineligible: number };

export const baseDriftRecoveryTick = async (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
  now = new Date(),
  limit = 5,
): Promise<BaseDriftRecoveryTickResult> => {
  const result: BaseDriftRecoveryTickResult = { examined: 0, recovered: 0, exhausted: 0, ineligible: 0 };
  const where: Prisma.TaskWhereInput = {
    status: TaskStatus.REVIEW,
    OR: [
      { templateStep: { stepIndex: 7, outputKind: INTEGRATOR_OUTPUT_KIND, taskTemplate: { name: "direct-engineer-workflow" } } },
      { templateStep: { stepIndex: 12, outputKind: INTEGRATOR_OUTPUT_KIND, taskTemplate: { name: "compound-engineer-workflow" } } },
    ],
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
      if (!loaded) continue;
      result.examined += 1;
      if (!loaded.ok) {
        if (loaded.retryable) {
          const outcome = await recordClassificationRetry(db, task.id, loaded.stopId, loaded.reason);
          if (outcome === "ineligible") result.ineligible += 1;
        } else if (await settleIneligible(db, task.id, loaded.stopId, loaded.reason)) {
          result.ineligible += 1;
        }
        continue;
      }
      const candidate = loaded.candidate;
      if (!reader) {
        const outcome = await recordClassificationRetry(
          db, task.id, candidate.stopId, "server-side GitHub reader is unavailable",
        );
        if (outcome === "ineligible") result.ineligible += 1;
        continue;
      }
    let snapshot: PullRequestSnapshot;
    let advancementRefusal: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        snapshot = await reader.readPullRequest(candidate.repository, candidate.prNumber, candidate.targetBranch, controller.signal);
        if (!reader.compareCommits) {
          advancementRefusal = "server-side ancestry comparison is unavailable";
        } else if (!snapshot.baseSha) {
          advancementRefusal = "fresh target base SHA is unavailable";
        } else {
          const advanced = await reader.compareCommits(
            candidate.repository, candidate.authorizedBaseSha, snapshot.baseSha, controller.signal,
          );
          if (advanced.status !== "ahead" || advanced.behindBy !== 0) {
            advancementRefusal = `target base change is not a forward advancement (${advanced.status}, behind_by=${advanced.behindBy})`;
          } else if (candidate.observedBaseSha !== snapshot.baseSha) {
            const sinceStop = await reader.compareCommits(
              candidate.repository, candidate.observedBaseSha, snapshot.baseSha, controller.signal,
            );
            if ((sinceStop.status !== "ahead" && sinceStop.status !== "identical") || sinceStop.behindBy !== 0) {
              advancementRefusal = `current target base does not descend from the executor-observed base (${sinceStop.status}, behind_by=${sinceStop.behindBy})`;
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error: unknown) {
      const reason = `fresh server-side repository read failed (${error instanceof Error ? error.name : "unknown error"})`;
      const outcome = await recordClassificationRetry(db, task.id, candidate.stopId, reason);
      if (outcome === "ineligible") result.ineligible += 1;
      continue;
    }
    const refusal = snapshotRefusal(candidate, snapshot) ?? advancementRefusal;
    if (refusal) {
      if (await settleIneligible(db, task.id, candidate.stopId, refusal, candidate)) result.ineligible += 1;
      continue;
    }
    const outcome = await queueRecovery(db, candidate, snapshot.baseSha!, now);
    if (outcome === "recovered") result.recovered += 1;
    else if (outcome === "exhausted") result.exhausted += 1;
    else if (outcome === "ineligible") {
      if (await settleIneligible(db, task.id, candidate.stopId, "durable chain state changed during fresh recovery verification", candidate)) result.ineligible += 1;
    } else if (outcome === "retryable") {
      const retry = await recordClassificationRetry(
        db, task.id, candidate.stopId, "the chain became temporarily active during durable recovery verification",
      );
      if (retry === "ineligible") result.ineligible += 1;
    }
    }
    if (tasks.length < pageSize) break;
  }
  return result;
};

export const startBaseDriftRecoveryWorker = (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
): ReturnType<typeof setInterval> => {
  const run = (): void => {
    void baseDriftRecoveryTick(db, reader).catch((error: unknown) => console.error("Base-drift recovery tick failed", error));
  };
  run();
  const timer = setInterval(run, baseDriftRecoveryPollIntervalMs());
  timer.unref?.();
  return timer;
};
