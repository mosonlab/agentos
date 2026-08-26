import { createHash, randomUUID } from "node:crypto";

import {
  AssigneeType,
  AUTHORIZED_MERGE_METHOD,
  DIRECT_INTEGRATOR_TEMPLATE_NAME,
  DIRECT_MERGE_READINESS_STEP_INDEX,
  INTEGRATOR_TEMPLATE_NAME,
  LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME,
  LEGACY_DIRECT_MERGE_READINESS_STEP_INDEX,
  LEGACY_INTEGRATOR_TEMPLATE_NAME,
  LEGACY_MERGE_READINESS_STEP_INDEX,
  LEGACY_PRE_ADJUDICATION_DIRECT_MERGE_READINESS_STEP_INDEX,
  LEGACY_PRE_ADJUDICATION_DIRECT_TEMPLATE_PREFIX,
  LEGACY_PRE_ADJUDICATION_MERGE_READINESS_STEP_INDEX,
  LEGACY_PRE_ADJUDICATION_TEMPLATE_PREFIX,
  LEGACY_PRE_ZERO_GATE_TEMPLATE_PREFIX,
  MERGE_READINESS_STEP_INDEX,
  MergeRecoveryStatus,
  Prisma,
  RunnerPreference,
  TaskStatus,
  activateChainSuccessor,
  activateRecoveryIntegratorSuccessor,
  authorizationMetadata,
  defenseTriggers,
  enqueueTaskRun,
  INDEPENDENT_REVIEW_OPEN_PREFIX,
  isMergeReadinessStep,
  parseRegressionVerdict,
  readMarkerHistory,
  recoveryContext,
  resolveChainTarget,
  resolutionTestTriggers,
  runnerFor,
  writeMarker,
  type PrismaClient,
  type Marker,
  type RecoveryContext,
} from "@agentos/db";

import { lockTaskMutationRows } from "./task-write.js";
import { evidenceFromSnapshot } from "./merge-evidence-worker.js";
import { createGitHubReader, type GitHubReader } from "./github-read.js";
import {
  acquireMergeLease,
  releaseMergeLease,
  releaseMergeLeaseSafely,
  reportMergeLeaseAnomaly,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
} from "./merge-lease.js";

export const readinessPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_READINESS_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

const READINESS_CLAIM_PREFIX = "merge-readiness-claim:";
export const READINESS_READ_BUDGET_MS = 20_000;
export const READINESS_CLAIM_LEASE_MS = 30_000;

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
  releaseChainLease: MergeLeaseReleaser,
): Promise<void> => {
  const recoveryBody = input.recovery
    ? `Automatic base-drift recovery ${input.recovery.attempt} stopped at readiness: ${input.reason}`
    : null;
  const dedupeKey = input.recovery
    ? `merge-base-drift-recovery-tail-stop:${input.recovery.sourceStopId}:readiness`
    : `merge-readiness-stop:${input.readinessTaskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
  const chainId = await db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, input.readinessTaskId);
    const readiness = await tx.task.findUnique({
      where: { id: input.readinessTaskId },
      select: { chainId: true },
    });
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
    await writeMarker(tx, input.regressionTaskId, "readiness", {
      actorType: "control-plane",
      body: `Merge readiness stopped at regression: ${input.reason}`,
      metadata: { state: "stopped", reason: input.reason },
    });
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
    return readiness?.chainId ?? null;
  });
  reportMergeLeaseAnomaly(chainId, await releaseMergeLeaseSafely(releaseChainLease, chainId));
};

// The whole history, newest first: a review obligation for this exact head can
// sit arbitrarily far back once the readiness task has accumulated activity,
// and missing it would reopen a review that is already answered.
const latestReviewState = async (
  db: PrismaClient | Prisma.TransactionClient,
  readinessTaskId: string,
  headSha: string,
  recoveryBaseSha: string | null,
): Promise<Marker | null> => (
  (await readMarkerHistory(db, readinessTaskId)).find((marker) => (
    marker.kind === "reviewObligation"
    && marker.headSha === headSha
    && (recoveryBaseSha === null || marker.baseSha === recoveryBaseSha)
  )) ?? null
);

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
    claimReason: string;
  },
): Promise<{ ok: true } | { ok: false; reason: string } | { ok: false; lost: true }> => db.$transaction(async (tx) => {
  await lockTaskMutationRows(tx, input.readinessTask.id);
  // The claim is only evidence until it is re-read under the chain mutex. A
  // worker whose lease expired while it read GitHub has already been replaced,
  // and opening a second obligation for the same head would double every
  // decision the tail makes from it: two repairs, two backlog cards, two
  // blocking rounds off the ceiling.
  const held = await tx.task.count({
    where: { id: input.readinessTask.id, status: TaskStatus.DOING, failureReason: input.claimReason },
  });
  if (held !== 1) return { ok: false as const, lost: true as const };
  const open = await latestReviewState(tx, input.readinessTask.id, input.headSha, input.recovery ? input.baseSha : null);
  if (open?.state === "open") return { ok: false as const, lost: true as const };
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
      "Do not read prior review outputs. Find defects in the triggered merge-tail surface, run focused checks, then persist exactly one JSON object:",
      `{"schemaVersion":1,"headSha":"${input.headSha}","findings":[{"severity":"blocking"|"follow-up","title":"<short>","detail":"<what is wrong and where>","reachability":"<required for blocking>"}]}`,
      [
        "Severity is the whole decision and the server derives the verdict from it; you do not state a verdict.",
        "Mark a finding `blocking` only when it is a reachable behavioural defect — correctness, data integrity, or security — and prove reachability in `reachability`: name the concrete inputs, state, or interleaving that reaches it. A blocking finding without that argument voids the whole decision.",
        "Everything else is `follow-up`: specification inconsistency no caller can reach, style, naming, defensive hardening, and any concern you cannot show a caller reaching. Each follow-up becomes a backlog card and the merge proceeds.",
        "An empty `findings` array is the approval.",
      ].join("\n"),
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
  // Two rows, deliberately not the same one. The readiness task's copy names
  // the review task it is waiting on; the review task's copy names the tail it
  // answers for, which is what the completion path reads back from it.
  await writeMarker(tx, input.readinessTask.id, "reviewObligation", {
    actorType: "control-plane",
    body: `Independent review obligation opened for ${input.headSha}`,
    metadata: {
      state: "open",
      headSha: input.headSha,
      baseSha: input.baseSha,
      reviewTaskId: task.id,
      triggers: input.triggers,
      recoverySourceStopId: input.recovery?.sourceStopId ?? null,
    },
  });
  await writeMarker(tx, task.id, "reviewObligation", {
    actorType: "control-plane",
    body: `Blind review obligation for readiness task ${input.readinessTask.id}`,
    metadata: {
      state: "open",
      readinessTaskId: input.readinessTask.id,
      regressionTaskId: input.regressionTaskId,
      headSha: input.headSha,
      baseSha: input.baseSha,
      recoverySourceStopId: input.recovery?.sourceStopId ?? null,
    },
  });
  await tx.task.update({ where: { id: input.readinessTask.id }, data: {
    status: TaskStatus.REVIEW,
    failureReason: `${INDEPENDENT_REVIEW_OPEN_PREFIX}${task.id}:${input.headSha}`,
  } });
  return { ok: true as const };
});

export type ReadinessTickResult = { claimed: number; authorized: number; reviewing: number; requeued: number; stopped: number };

/**
 * Hand the lease back for the length of an independent review. The review
 * neither produces nor consumes the exact-head gate proof -- it reads a diff on
 * GitHub -- so holding the lease across it charges an agent session, and
 * however many runner losses and retries that session takes, to every other
 * delivery line's queue. `not-held` and `skipped` are ordinary answers here:
 * this path has to leave the lock free, not prove it was the one holding it.
 * Only "nobody knows" is worth saying out loud.
 */
const releaseForReview = async (
  releaseChainLease: MergeLeaseReleaser,
  chainId: string | null,
): Promise<void> => {
  const release = await releaseMergeLeaseSafely(releaseChainLease, chainId);
  if (release?.outcome !== "unreachable") return;
  console.error(
    `Merge lease anomaly: the release for chain ${chainId ?? "unknown"} before its independent review could not be carried out: ${release.detail}. The merge window on main may stay locked for the length of that review.`,
  );
};

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
    await lockTaskMutationRows(tx, input.readinessTaskId);
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
    await writeMarker(tx, input.regressionTaskId, "readiness", {
      actorType: "control-plane",
      body: `Merge readiness returned to regression: ${input.reason}; ${input.staleBaseSha} -> ${input.currentBaseSha}`,
      metadata: {
        state: "requeued-regression",
        reason: input.reason,
        staleBaseSha: input.staleBaseSha,
        currentBaseSha: input.currentBaseSha,
      },
    });
  });
};

export const readinessTick = async (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
  now = new Date(),
  limit = 5,
  releaseChainLease: MergeLeaseReleaser = async () => ({ outcome: "not-held" }),
  acquireChainLease: MergeLeaseAcquirer = async () => ({ outcome: "acquired" }),
): Promise<ReadinessTickResult> => {
  const result: ReadinessTickResult = { claimed: 0, authorized: 0, reviewing: 0, requeued: 0, stopped: 0 };
  const candidates = await db.task.findMany({
    where: {
      status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
      OR: [
        { templateStep: { stepIndex: DIRECT_MERGE_READINESS_STEP_INDEX, outputKind: "merge-authorization", taskTemplate: { name: DIRECT_INTEGRATOR_TEMPLATE_NAME } } },
        { templateStep: { stepIndex: MERGE_READINESS_STEP_INDEX, outputKind: "merge-authorization", taskTemplate: { name: INTEGRATOR_TEMPLATE_NAME } } },
        { templateStep: { stepIndex: LEGACY_DIRECT_MERGE_READINESS_STEP_INDEX, outputKind: "merge-authorization", taskTemplate: { name: LEGACY_DIRECT_INTEGRATOR_TEMPLATE_NAME } } },
        { templateStep: { stepIndex: LEGACY_MERGE_READINESS_STEP_INDEX, outputKind: "merge-authorization", taskTemplate: { name: LEGACY_INTEGRATOR_TEMPLATE_NAME } } },
        { templateStep: { stepIndex: LEGACY_PRE_ADJUDICATION_DIRECT_MERGE_READINESS_STEP_INDEX, outputKind: "merge-authorization", taskTemplate: { name: { startsWith: LEGACY_PRE_ADJUDICATION_DIRECT_TEMPLATE_PREFIX } } } },
        { templateStep: { stepIndex: LEGACY_PRE_ADJUDICATION_MERGE_READINESS_STEP_INDEX, outputKind: "merge-authorization", taskTemplate: { name: { startsWith: LEGACY_PRE_ADJUDICATION_TEMPLATE_PREFIX } } } },
        { templateStep: { stepIndex: MERGE_READINESS_STEP_INDEX, outputKind: "merge-authorization", taskTemplate: { name: { startsWith: LEGACY_PRE_ZERO_GATE_TEMPLATE_PREFIX } } } },
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
    const claimed = await db.$transaction(async (tx) => {
      await lockTaskMutationRows(tx, readiness.id);
      return tx.task.updateMany({ where: claimWhere, data: { status: TaskStatus.DOING, failureReason: claimReason } });
    });
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
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression?.id ?? readiness.id, reason: "missing head-bound regression PASS evidence", recovery }, releaseChainLease);
      result.stopped += 1;
      continue;
    }
    const verdict = parseRegressionVerdict(regression.stepOutput.body);
    if (verdict.status !== "ok" || verdict.verdict.outcome !== "pass" || regression.stepOutput.commitSha !== verdict.verdict.headSha) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "missing or stale head-bound regression PASS evidence", recovery }, releaseChainLease);
      result.stopped += 1;
      continue;
    }
    if (!reader?.compareCommits) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "server-side GitHub comparison reader is unavailable", recovery }, releaseChainLease);
      result.stopped += 1;
      continue;
    }
    const target = await db.$transaction((tx) => resolveChainTarget(tx, readiness));
    if (!target.resolved) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: `pull-request target is ${target.unresolvable}`, recovery }, releaseChainLease);
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
        await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "pull request base identity is unavailable", recovery }, releaseChainLease);
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
        }, releaseChainLease);
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
      // Every refresh-conflict resolution this Regression ever recorded has to
      // be re-proved, however far back it sits.
      const resolutions = await readMarkerHistory(db, regression.id);
      for (const marker of resolutions) {
        if (marker.kind !== "repairResult" || marker.repairKind !== "refresh-conflict") continue;
        if (!marker.startHeadSha || !marker.resolvedHeadSha) {
          triggers.push({ path: "<resolution-range>", reason: "existing-test-lines-unverifiable" });
          continue;
        }
        const resolution = await reader.compareCommits(target.repository, marker.startHeadSha, marker.resolvedHeadSha, controller.signal);
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
      const reviewCleared = review?.state === "approved" || review?.state === "accepted-with-followups";
      if (triggers.length > 0 && !reviewCleared) {
        if (review?.state === "open") {
          // The obligation is re-read inside the mutex before the park is
          // written. Between the read above and here the review can have
          // completed and handed this step back; parking on that stale read
          // would strand a step no review is coming back for.
          const parked = await db.$transaction(async (tx) => {
            await lockTaskMutationRows(tx, readiness.id);
            const current = await latestReviewState(tx, readiness.id, verdict.verdict.headSha, recovery ? snapshot.baseSha : null);
            if (current?.state !== "open") return false;
            const reparked = await tx.task.updateMany({
              where: { id: readiness.id, status: TaskStatus.DOING, failureReason: claimReason },
              data: { status: TaskStatus.REVIEW, failureReason: `${INDEPENDENT_REVIEW_OPEN_PREFIX}${String(current.reviewTaskId)}` },
            });
            return reparked.count === 1;
          });
          if (parked) await releaseForReview(releaseChainLease, readiness.chainId);
          result.reviewing += 1;
          continue;
        }
        const branchRun = await db.run.findFirst({
          where: { task: { projectId: readiness.projectId, chainId: readiness.chainId }, branch: { not: null } },
          select: { branch: true },
          orderBy: { createdAt: "desc" },
        });
        if (!branchRun?.branch) {
          await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "chain branch is unavailable for independent review", recovery }, releaseChainLease);
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
          claimReason,
        });
        if (opened.ok) {
          await releaseForReview(releaseChainLease, readiness.chainId);
          result.reviewing += 1;
        } else if ("lost" in opened) {
          // Another worker owns this readiness step now. Leaving its state
          // alone is the whole point of noticing.
          result.reviewing += 1;
        } else {
          await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: opened.reason, recovery }, releaseChainLease);
          result.stopped += 1;
        }
        continue;
      }
      const evidence = evidenceFromSnapshot(snapshot, randomUUID());
      if ("error" in evidence) {
        await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: evidence.error, recovery }, releaseChainLease);
        result.stopped += 1;
        continue;
      }
      // The lock belongs here and only here. From the base this authorization
      // pins to the merge that consumes it, `main` must not move; everything
      // earlier in the tail -- the refresh, the semantic verification, the
      // review -- can be redone if it does. An acquire that loses leaves the
      // step claimed, so its claim expires and a later tick tries again, rather
      // than authorizing a merge whose window nobody is holding open.
      if (readiness.chainId) {
        const acquisition = await acquireChainLease(readiness.chainId);
        if (acquisition.outcome !== "acquired") continue;
      }
      const authorized = await db.$transaction(async (tx) => {
        await lockTaskMutationRows(tx, readiness.id);
        // The claim is evidence until it is re-read under the mutex, and the
        // acquire above is a network round trip spent inside the claim's lease.
        // A worker that lost the step while acquiring must write nothing here:
        // two authorizations would queue two merge executions.
        const held = await tx.task.updateMany({
          where: { id: readiness.id, status: TaskStatus.DOING, failureReason: claimReason },
          data: { status: TaskStatus.DONE, failureReason: null },
        });
        if (held.count !== 1) return false;
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
        await tx.task.update({ where: { id: regression.id }, data: { failureReason: null } });
        await writeMarker(tx, readiness.id, "readiness", {
          actorType: "control-plane",
          body: `Merge readiness authorized exact head ${evidence.headSha}; merge execution queued`,
          metadata: {
            state: "authorized",
            headSha: evidence.headSha,
            authorizationActivityId: activity.id,
            recoverySourceStopId: recovery?.sourceStopId ?? null,
          },
        });
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
        return true;
      });
      if (authorized) result.authorized += 1;
    } catch (error: unknown) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: `readiness evaluation failed: ${error instanceof Error ? error.message : String(error)}`, recovery }, releaseChainLease);
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
    void readinessTick(db, reader, new Date(), 5, releaseMergeLease, acquireMergeLease)
      .catch((error: unknown) => console.error("Merge readiness tick failed", error));
  }, readinessPollIntervalMs());
  timer.unref?.();
  return timer;
};
