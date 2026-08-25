import { createHash, randomUUID } from "node:crypto";

import {
  AssigneeType,
  AUTHORIZED_MERGE_METHOD,
  MERGE_TAIL_KIND,
  MergeRecoveryStatus,
  Prisma,
  RunnerPreference,
  TaskStatus,
  activateChainSuccessor,
  activateRecoveryIntegratorSuccessor,
  authorizationMetadata,
  defenseTriggers,
  enqueueTaskRun,
  isMergeReadinessStep,
  parseRegressionVerdict,
  resolveChainTarget,
  resolutionTestTriggers,
  runnerFor,
  type PrismaClient,
  type MergeRecoveryAttempt,
} from "@agentos/db";

import { evidenceFromSnapshot } from "./merge-evidence-worker.js";
import { createGitHubReader, type GitHubReader } from "./github-read.js";

export const readinessPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_READINESS_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

const READINESS_CLAIM_PREFIX = "merge-readiness-claim:";
export const READINESS_READ_BUDGET_MS = 20_000;
export const READINESS_CLAIM_LEASE_MS = 30_000;

type RecoveryContext = {
  aggregateId: string;
  attempt: number;
  sourceStopId: string;
  sourceRunId: string;
  authorizationActivityId: string;
  repository: string;
  prNumber: number;
  targetBranch: string;
  authorizedHeadSha: string;
  authorizedBaseSha: string;
  observedBaseSha: string;
  currentBaseSha: string;
  readinessTaskId: string;
  regressionTaskId: string;
  integratorTaskId: string;
  recoveryRunId: string;
};

const recoveryContext = (row: MergeRecoveryAttempt | null): RecoveryContext | null => {
  if (!row?.boundSourceRunId || !row.authorizationActivityId || !row.recoveryRunId
    || !row.readinessTaskId || !row.regressionTaskId || !row.repository
    || row.prNumber === null || !row.targetBranch || !row.authorizedHeadSha
    || !row.authorizedBaseSha || !row.observedBaseSha || !row.currentBaseSha) return null;
  return {
    aggregateId: row.id,
    attempt: row.attempt,
    sourceStopId: row.sourceStopId,
    sourceRunId: row.boundSourceRunId,
    authorizationActivityId: row.authorizationActivityId,
    repository: row.repository,
    prNumber: row.prNumber,
    targetBranch: row.targetBranch,
    authorizedHeadSha: row.authorizedHeadSha,
    authorizedBaseSha: row.authorizedBaseSha,
    observedBaseSha: row.observedBaseSha,
    currentBaseSha: row.currentBaseSha,
    readinessTaskId: row.readinessTaskId,
    regressionTaskId: row.regressionTaskId,
    integratorTaskId: row.integratorTaskId,
    recoveryRunId: row.recoveryRunId,
  };
};

const recoveryContextFor = async (
  db: PrismaClient,
  regressionTaskId: string,
  readinessTaskId: string,
  recoveryRunId: string | null,
): Promise<RecoveryContext | null> => {
  if (!recoveryRunId) return null;
  const row = await db.mergeRecoveryAttempt.findFirst({ where: {
    regressionTaskId,
    readinessTaskId,
    recoveryRunId,
    status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION] },
  }, orderBy: [{ attempt: "desc" }, { id: "desc" }] });
  return recoveryContext(row);
};

const readinessClaim = (now: Date): string => (
  `${READINESS_CLAIM_PREFIX}${randomUUID()}|${new Date(now.getTime() + READINESS_CLAIM_LEASE_MS).toISOString()}`
);

const expiredReadinessClaim = (reason: string | null, now: Date): boolean => {
  if (!reason?.startsWith(READINESS_CLAIM_PREFIX)) return false;
  const expiry = Date.parse(reason.slice(reason.lastIndexOf("|") + 1));
  return Number.isFinite(expiry) && expiry <= now.getTime();
};

const stopReadiness = async (
  db: PrismaClient,
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    reason: string;
    recovery: RecoveryContext | null;
  },
): Promise<void> => {
  const recoveryBody = input.recovery
    ? `Automatic base-drift recovery ${input.recovery.attempt} stopped at readiness: ${input.reason}`
    : null;
  const dedupeKey = input.recovery
    ? `merge-base-drift-recovery-tail-stop:${input.recovery.sourceStopId}:readiness`
    : `merge-readiness-stop:${input.readinessTaskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id: input.readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: input.reason } });
    await tx.task.update({ where: { id: input.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: input.reason } });
    if (input.recovery) {
      await tx.mergeRecoveryAttempt.update({ where: { id: input.recovery.aggregateId }, data: {
        status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
        failureReason: input.reason,
        endedAt: new Date(),
      } });
      await tx.task.update({
        where: { id: input.recovery.integratorTaskId },
        data: { status: TaskStatus.REVIEW, failureReason: recoveryBody },
      });
      const metadata = {
        ...input.recovery,
        state: "tail-stopped",
        phase: "readiness",
        reason: input.reason,
        dedupeKey,
      } as Prisma.InputJsonObject;
      await tx.taskActivity.createMany({ data: [
        { taskId: input.recovery.integratorTaskId, actorType: "control-plane", body: recoveryBody!, metadata },
        { taskId: input.regressionTaskId, actorType: "control-plane", body: recoveryBody!, metadata },
      ] });
    }
    await tx.taskActivity.create({ data: {
      taskId: input.regressionTaskId,
      actorType: "control-plane",
      body: `Merge readiness stopped at regression: ${input.reason}`,
      metadata: { kind: MERGE_TAIL_KIND.readiness, schemaVersion: 1, state: "stopped", reason: input.reason },
    } });
    await tx.inboxMessage.upsert({
      where: { dedupeKey },
      create: {
        from: "AGENT",
        taskId: input.regressionTaskId,
        kind: "TEXT",
        body: recoveryBody ?? `Autonomous merge readiness stopped: ${input.reason}`,
        dedupeKey,
      },
      update: {},
    });
  });
};

const latestReviewState = async (
  db: PrismaClient,
  readinessTaskId: string,
  headSha: string,
  recoveryBaseSha: string | null,
) => {
  const rows = await db.taskActivity.findMany({ where: { taskId: readinessTaskId }, orderBy: { createdAt: "desc" }, select: { metadata: true } });
  for (const row of rows) {
    const metadata = row.metadata as Record<string, unknown> | null;
    if (metadata?.kind === MERGE_TAIL_KIND.reviewObligation
      && metadata.headSha === headSha
      && (recoveryBaseSha === null || metadata.baseSha === recoveryBaseSha)) return metadata;
  }
  return null;
};

const createReviewObligation = async (
  db: PrismaClient,
  input: {
    readinessTask: { id: string; projectId: string; repoId: string | null };
    regressionTaskId: string;
    branch: string;
    baseSha: string;
    headSha: string;
    triggers: Array<{ path: string; reason: string }>;
    recovery: RecoveryContext | null;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> => db.$transaction(async (tx) => {
  if (!input.readinessTask.repoId) return { ok: false as const, reason: "readiness task has no repository" };
  const agent = await tx.agent.findFirst({ where: { projectId: input.readinessTask.projectId, name: "review-coordinator", archivedAt: null } });
  if (!agent) return { ok: false as const, reason: "review-coordinator is absent or archived" };
  const grant = await tx.agentRepoAccess.findFirst({ where: { projectId: input.readinessTask.projectId, repoId: input.readinessTask.repoId, agentId: agent.id } });
  if (!grant) return { ok: false as const, reason: "review-coordinator has no repository grant" };
  const task = await tx.task.create({ data: {
    projectId: input.readinessTask.projectId,
    repoId: input.readinessTask.repoId,
    name: "Autonomous merge tail: independent review",
    description: [
      `Blindly review the exact diff ${input.baseSha}..${input.headSha}.`,
      `The server-side trigger set is ${JSON.stringify(input.triggers)}.`,
      "Do not read prior review outputs. Find correctness or safety defects in the triggered merge-tail surface, run focused checks, then persist exactly one JSON object: {\"schemaVersion\":1,\"outcome\":\"approved\",\"headSha\":\"<40 hex>\"} or {\"schemaVersion\":1,\"outcome\":\"rejected\",\"headSha\":\"<40 hex>\",\"summary\":\"<must-fix>\"}.",
    ].join("\n\n"),
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agent.id,
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.TODO,
    targetBranch: input.branch,
    maxSessionsPerTask: 1,
  } });
  const run = await enqueueTaskRun(tx, task.id);
  await tx.run.update({ where: { id: run.id }, data: {
    branch: input.branch,
    targetBranch: input.branch,
    model: "gpt-5.6-sol:medium",
    runner: runnerFor(RunnerPreference.CODEX, "gpt-5.6-sol:medium"),
  } });
  await tx.taskActivity.createMany({ data: [
    {
      taskId: input.readinessTask.id,
      actorType: "control-plane",
      body: `Independent review obligation opened for ${input.headSha}`,
      metadata: {
        kind: MERGE_TAIL_KIND.reviewObligation,
        schemaVersion: 1,
        state: "open",
        headSha: input.headSha,
        baseSha: input.baseSha,
        reviewTaskId: task.id,
        triggers: input.triggers,
        recoverySourceStopId: input.recovery?.sourceStopId ?? null,
      },
    },
    {
      taskId: task.id,
      actorType: "control-plane",
      body: `Blind review obligation for readiness task ${input.readinessTask.id}`,
      metadata: {
        kind: MERGE_TAIL_KIND.reviewObligation,
        schemaVersion: 1,
        state: "open",
        readinessTaskId: input.readinessTask.id,
        regressionTaskId: input.regressionTaskId,
        headSha: input.headSha,
        baseSha: input.baseSha,
        recoverySourceStopId: input.recovery?.sourceStopId ?? null,
      },
    },
  ] });
  await tx.task.update({ where: { id: input.readinessTask.id }, data: {
    status: TaskStatus.REVIEW,
    failureReason: `independent-review-open:${task.id}:${input.headSha}`,
  } });
  return { ok: true as const };
});

export type ReadinessTickResult = { claimed: number; authorized: number; reviewing: number; requeued: number; stopped: number };

const requeueRegression = async (
  db: PrismaClient,
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    staleBaseSha: string;
    currentBaseSha: string;
    reason: string;
    now: Date;
    recovery: RecoveryContext | null;
  },
): Promise<void> => {
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id: input.readinessTaskId }, data: { status: TaskStatus.TODO, failureReason: null } });
    await tx.task.update({ where: { id: input.regressionTaskId }, data: { status: TaskStatus.TODO, failureReason: null } });
    const run = await enqueueTaskRun(tx, input.regressionTaskId, input.now);
    if (input.recovery) {
      await tx.mergeRecoveryAttempt.update({ where: { id: input.recovery.aggregateId }, data: {
        status: MergeRecoveryStatus.REPAIRING,
        recoveryRunId: run.id,
        currentBaseSha: input.currentBaseSha,
        failureReason: null,
        endedAt: null,
      } });
      const body = `Automatic base-drift recovery ${String(input.recovery.attempt)} context carried through readiness requeue`;
      const metadata = {
        ...input.recovery,
        currentBaseSha: input.currentBaseSha,
        recoveryRunId: run.id,
      } as Prisma.InputJsonObject;
      await tx.taskActivity.createMany({ data: [
        {
          taskId: input.recovery.integratorTaskId,
          actorType: "control-plane",
          body,
          metadata,
        },
        {
          taskId: input.regressionTaskId,
          actorType: "control-plane",
          body,
          metadata,
        },
      ] });
    }
    await tx.taskActivity.create({ data: {
      taskId: input.regressionTaskId,
      actorType: "control-plane",
      body: `Merge readiness returned to regression: ${input.reason}; ${input.staleBaseSha} -> ${input.currentBaseSha}`,
      metadata: {
        kind: MERGE_TAIL_KIND.readiness,
        schemaVersion: 1,
        state: "requeued-regression",
        reason: input.reason,
        staleBaseSha: input.staleBaseSha,
        currentBaseSha: input.currentBaseSha,
      },
    } });
  });
};

export const readinessTick = async (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
  now = new Date(),
  limit = 5,
): Promise<ReadinessTickResult> => {
  const result: ReadinessTickResult = { claimed: 0, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 };
  const candidates = await db.task.findMany({
    where: {
      status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
      OR: [
        { templateStep: { stepIndex: 6, outputKind: "merge-authorization", taskTemplate: { name: "direct-engineer-workflow" } } },
        { templateStep: { stepIndex: 11, outputKind: "merge-authorization", taskTemplate: { name: "compound-engineer-workflow" } } },
      ],
    },
    include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: true },
    orderBy: { createdAt: "asc" },
    take: Math.max(limit * 20, 100),
  });
  for (const readiness of candidates) {
    if (result.claimed >= limit) break;
    if (!isMergeReadinessStep(readiness.templateStep)) continue;
    const regression = await db.task.findFirst({
      where: {
        projectId: readiness.projectId,
        chainId: readiness.chainId,
        templateId: readiness.templateId,
        templateStep: { outputKind: "regression-verification" },
      },
      include: {
        stepOutput: true,
        runs: { orderBy: { runNumber: "desc" }, take: 1, select: { id: true } },
      },
    });
    if (!regression || regression.status !== TaskStatus.DONE) continue;
    const claimReason = readinessClaim(now);
    const claimWhere = readiness.status === TaskStatus.TODO
      ? { id: readiness.id, status: TaskStatus.TODO }
      : expiredReadinessClaim(readiness.failureReason, now)
        ? { id: readiness.id, status: TaskStatus.DOING, failureReason: readiness.failureReason }
        : null;
    if (!claimWhere) continue;
    const claimed = await db.task.updateMany({ where: claimWhere, data: { status: TaskStatus.DOING, failureReason: claimReason } });
    if (claimed.count !== 1) continue;
    result.claimed += 1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let recovery: RecoveryContext | null = null;
    try {
      recovery = await recoveryContextFor(db, regression.id, readiness.id, regression.runs[0]?.id ?? null);
      if (recovery) {
        await db.mergeRecoveryAttempt.update({ where: { id: recovery.aggregateId }, data: {
          status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
          failureReason: null,
        } });
      }
    if (!regression?.stepOutput) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression?.id ?? readiness.id, reason: "missing head-bound regression PASS evidence", recovery });
      result.stopped += 1;
      continue;
    }
    const verdict = parseRegressionVerdict(regression.stepOutput.body);
    if (verdict.status !== "ok" || verdict.verdict.outcome !== "pass" || regression.stepOutput.commitSha !== verdict.verdict.headSha) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "missing or stale head-bound regression PASS evidence", recovery });
      result.stopped += 1;
      continue;
    }
    if (!reader?.compareCommits) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "server-side GitHub comparison reader is unavailable", recovery });
      result.stopped += 1;
      continue;
    }
    const target = await db.$transaction((tx) => resolveChainTarget(tx, readiness));
    if (!target.resolved) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: `pull-request target is ${target.unresolvable}`, recovery });
      result.stopped += 1;
      continue;
    }
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), READINESS_READ_BUDGET_MS);
      const snapshot = await reader.readPullRequest(target.repository, target.prNumber, readiness.repo?.defaultBranch ?? "main", controller.signal);
      if (snapshot.headRefOid !== verdict.verdict.headSha) {
        await requeueRegression(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          staleBaseSha: verdict.verdict.baseHeadSha,
          currentBaseSha: snapshot.baseSha ?? "missing",
          reason: `stale PASS head ${verdict.verdict.headSha}; current PR head is ${snapshot.headRefOid ?? "missing"}`,
          now,
          recovery,
        });
        result.requeued += 1;
        continue;
      }
      if (!snapshot.baseSha || !snapshot.baseRefName) {
        await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "pull request base identity is unavailable", recovery });
        result.stopped += 1;
        continue;
      }
      if (snapshot.baseSha !== verdict.verdict.baseHeadSha) {
        await requeueRegression(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          staleBaseSha: verdict.verdict.baseHeadSha,
          currentBaseSha: snapshot.baseSha,
          reason: "target base advanced after regression PASS",
          now,
          recovery,
        });
        result.requeued += 1;
        continue;
      }
      const diff = await reader.compareCommits(target.repository, snapshot.baseSha, verdict.verdict.headSha, controller.signal);
      if (!diff.filesComplete) {
        await stopReadiness(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          reason: "GitHub comparison file list is truncated or completeness is unproven",
          recovery,
        });
        result.stopped += 1;
        continue;
      }
      if ((diff.status !== "ahead" && diff.status !== "identical") || diff.behindBy !== 0) {
        await requeueRegression(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          staleBaseSha: verdict.verdict.baseHeadSha,
          currentBaseSha: snapshot.baseSha,
          reason: `server-side ancestry check refused ${diff.status} comparison with behind_by=${diff.behindBy}`,
          now,
          recovery,
        });
        result.requeued += 1;
        continue;
      }
      const triggers = defenseTriggers(diff.files);
      const resolutionRows = await db.taskActivity.findMany({ where: { taskId: regression.id }, select: { metadata: true } });
      for (const row of resolutionRows) {
        const metadata = row.metadata as Record<string, unknown> | null;
        if (metadata?.kind !== MERGE_TAIL_KIND.repairResult || metadata.repairKind !== "refresh-conflict") continue;
        if (typeof metadata.startHeadSha !== "string" || typeof metadata.resolvedHeadSha !== "string") {
          triggers.push({ path: "<resolution-range>", reason: "existing-test-lines-unverifiable" });
          continue;
        }
        const resolution = await reader.compareCommits(target.repository, metadata.startHeadSha, metadata.resolvedHeadSha, controller.signal);
        if (!resolution.filesComplete) {
          triggers.push({ path: "<resolution-range>", reason: "existing-test-lines-unverifiable" });
          continue;
        }
        triggers.push(...resolutionTestTriggers(resolution.files));
      }
      const review = await latestReviewState(
        db,
        readiness.id,
        verdict.verdict.headSha,
        recovery ? snapshot.baseSha : null,
      );
      if (triggers.length > 0 && review?.state !== "approved") {
        if (review?.state === "open") {
          await db.task.update({ where: { id: readiness.id }, data: { status: TaskStatus.REVIEW, failureReason: `independent-review-open:${String(review.reviewTaskId)}` } });
          result.reviewing += 1;
          continue;
        }
        const branchRun = await db.run.findFirst({
          where: { task: { projectId: readiness.projectId, chainId: readiness.chainId }, branch: { not: null } },
          select: { branch: true },
          orderBy: { createdAt: "desc" },
        });
        if (!branchRun?.branch) {
          await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "chain branch is unavailable for independent review", recovery });
          result.stopped += 1;
          continue;
        }
        const opened = await createReviewObligation(db, {
          readinessTask: readiness,
          regressionTaskId: regression.id,
          branch: branchRun.branch,
          baseSha: snapshot.baseSha,
          headSha: verdict.verdict.headSha,
          triggers,
          recovery,
        });
        if (!opened.ok) {
          await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: opened.reason, recovery });
          result.stopped += 1;
        } else {
          result.reviewing += 1;
        }
        continue;
      }
      const evidence = evidenceFromSnapshot(snapshot, randomUUID());
      if ("error" in evidence) {
        await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: evidence.error, recovery });
        result.stopped += 1;
        continue;
      }
      await db.$transaction(async (tx) => {
        // Every exact-head/current-base cycle gets a distinct binding. The
        // obsolete authorization remains append-only evidence and cannot make a
        // refreshed authorization ambiguous or be reused by the executor.
        const binding = `mechanical:${readiness.id}:${randomUUID()}`;
        const payload = {
          ...evidence,
          mergeMethod: AUTHORIZED_MERGE_METHOD,
          issuedAt: now.toISOString(),
          decision: { channel: "mechanical" as const, inboxDecisionId: binding, inboxMessageId: binding },
        };
        const activity = await tx.taskActivity.create({ data: {
          taskId: readiness.id,
          actorType: "control-plane",
          body: `Mechanical merge authorized for PR #${target.prNumber} at ${evidence.headSha}`,
          metadata: { ...authorizationMetadata(payload), recoverySourceStopId: recovery?.sourceStopId ?? null } as Prisma.InputJsonObject,
        } });
        await tx.taskStepOutput.upsert({
          where: { taskId: readiness.id },
          create: { taskId: readiness.id, kind: "merge-authorization", body: JSON.stringify({ authorizationActivityId: activity.id, headSha: evidence.headSha }), commitSha: evidence.headSha },
          update: { kind: "merge-authorization", body: JSON.stringify({ authorizationActivityId: activity.id, headSha: evidence.headSha }), commitSha: evidence.headSha },
        });
        await tx.task.update({ where: { id: readiness.id }, data: { status: TaskStatus.DONE, failureReason: null } });
        await tx.task.update({ where: { id: regression.id }, data: { failureReason: null } });
        await tx.taskActivity.create({ data: {
          taskId: readiness.id,
          actorType: "control-plane",
          body: `Merge readiness authorized exact head ${evidence.headSha}; merge execution queued`,
          metadata: { kind: MERGE_TAIL_KIND.readiness, schemaVersion: 1, state: "authorized", headSha: evidence.headSha, authorizationActivityId: activity.id, recoverySourceStopId: recovery?.sourceStopId ?? null },
        } });
        if (recovery) {
          await activateRecoveryIntegratorSuccessor(tx, {
            readinessTaskId: readiness.id,
            integratorTaskId: recovery.integratorTaskId,
            sourceStopId: recovery.sourceStopId,
            recoveryRunId: recovery.recoveryRunId,
            authorizationActivityId: activity.id,
          }, now);
        } else {
          await activateChainSuccessor(tx, readiness, {}, now);
        }
      });
      result.authorized += 1;
    } catch (error: unknown) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: `readiness evaluation failed: ${error instanceof Error ? error.message : String(error)}`, recovery });
      result.stopped += 1;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return result;
};

export const startReadinessWorker = (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
): ReturnType<typeof setInterval> => {
  const timer = setInterval(() => {
    void readinessTick(db, reader).catch((error: unknown) => console.error("Merge readiness tick failed", error));
  }, readinessPollIntervalMs());
  timer.unref?.();
  return timer;
};
