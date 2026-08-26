import { createHash, randomUUID } from "node:crypto";

import {
  AssigneeType,
  AUTHORIZED_MERGE_METHOD,
  MergeRecoveryStatus,
  Prisma,
  RunnerPreference,
  TaskStatus,
  activateChainSuccessor,
  activateRecoveryIntegratorSuccessor,
  authorizationMetadata,
  enqueueTaskRun,
  INDEPENDENT_REVIEW_OPEN_PREFIX,
  isMergeReadinessStep,
  parseRegressionVerdict,
  REGRESSION_VERIFICATION_OUTPUT_KINDS,
  readMarkerHistory,
  recoveryContext,
  resolveChainTarget,
  runnerFor,
  writeMarker,
  type PrismaClient,
  type Marker,
  type RecoveryContext,
} from "@agentos/db";

import { lockTaskMutationRows } from "./task-write.js";
import { evidenceFromSnapshot } from "./merge-evidence-worker.js";
import { createGitHubReader, GitHubReadError, type GitHubReader } from "./github-read.js";
import {
  readinessDecision,
  type ReadinessDecision,
  type ReadinessInput,
} from "./readiness-decision.js";
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
export const READINESS_CLAIM_LEASE_MS = 60_000;
const READINESS_CANDIDATE_INCLUDE = {
  templateStep: { include: { taskTemplate: { select: { name: true } } } },
  repo: true,
} as const;
type ReadinessCandidate = Prisma.TaskGetPayload<{ include: typeof READINESS_CANDIDATE_INCLUDE }>;
const READINESS_REGRESSION_INCLUDE = {
  stepOutput: true,
  runs: { orderBy: { runNumber: "desc" as const }, take: 1, select: { id: true } },
} as const;
type ReadinessRegression = Prisma.TaskGetPayload<{ include: typeof READINESS_REGRESSION_INCLUDE }>;

const readinessCandidates = async function* (
  db: PrismaClient,
  pageSize: number,
): AsyncGenerator<ReadinessCandidate> {
  let cursor: string | null = null;
  while (true) {
    const page: ReadinessCandidate[] = await db.task.findMany({
      where: {
        status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
        templateStep: { outputKind: "merge-authorization" },
      },
      include: READINESS_CANDIDATE_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) return;
    for (const candidate of page) yield candidate;
    if (page.length < pageSize) return;
    cursor = page.at(-1)!.id;
  }
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

const renewReadinessClaim = async (
  db: PrismaClient,
  readinessTaskId: string,
  claimReason: string,
): Promise<string | null> => {
  const renewed = readinessClaim(new Date());
  const held = await db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, readinessTaskId);
    return tx.task.updateMany({
      where: { id: readinessTaskId, status: TaskStatus.DOING, failureReason: claimReason },
      data: { failureReason: renewed },
    });
  });
  return held.count === 1 ? renewed : null;
};

const stopReadiness = async (
  db: PrismaClient,
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    reason: string;
    recovery: RecoveryContext | null;
    claimReason: string;
  },
  releaseChainLease: MergeLeaseReleaser,
): Promise<boolean> => {
  const recoveryBody = input.recovery
    ? `Automatic base-drift recovery ${input.recovery.attempt} stopped at readiness: ${input.reason}`
    : null;
  const dedupeKey = input.recovery
    ? `merge-base-drift-recovery-tail-stop:${input.recovery.sourceStopId}:readiness`
    : `merge-readiness-stop:${input.readinessTaskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
  const transition = await db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, input.readinessTaskId);
    const readiness = await tx.task.findUnique({
      where: { id: input.readinessTaskId },
      select: { chainId: true },
    });
    const held = await tx.task.updateMany({
      where: { id: input.readinessTaskId, status: TaskStatus.DOING, failureReason: input.claimReason },
      data: { status: TaskStatus.REVIEW, failureReason: input.reason },
    });
    if (held.count !== 1) return { applied: false as const, chainId: readiness?.chainId ?? null };
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
    return { applied: true as const, chainId: readiness?.chainId ?? null };
  });
  if (!transition.applied) return false;
  reportMergeLeaseAnomaly(
    transition.chainId,
    await releaseMergeLeaseSafely(releaseChainLease, transition.chainId),
  );
  return true;
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
    claimReason: string;
  },
): Promise<boolean> => db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, input.readinessTaskId);
    const held = await tx.task.updateMany({
      where: { id: input.readinessTaskId, status: TaskStatus.DOING, failureReason: input.claimReason },
      data: { status: TaskStatus.TODO, failureReason: null },
    });
    if (held.count !== 1) return false;
    await tx.task.update({ where: { id: input.regressionTaskId }, data: { status: TaskStatus.TODO, failureReason: null } });
    const queued = await enqueueTaskRun(tx, input.regressionTaskId, input.now);
    // The prior Regression run succeeded; the control plane invalidated its
    // exact-base evidence after a remote read. This retry is therefore external
    // compensation, not another attempt charged to the agent. Without the
    // grant, a requeue at the configured ceiling creates run N+1 with ceiling N
    // and the runner rejects it before launch -- exactly the stuck state the
    // readiness transition was supposed to recover.
    const run = await tx.run.update({
      where: { id: queued.id },
      data: {
        maxRunsPerTask: { increment: 1 },
        budgetGrants: { increment: 1 },
      },
    });
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
    return true;
});

type ClaimedReadiness = {
  claimed: true;
  readiness: ReadinessCandidate;
  regression: ReadinessRegression;
  recovery: RecoveryContext | null;
  claimReason: string;
  input: ReadinessInput;
};

type ReadinessRead = ClaimedReadiness | { claimed: false; input: ReadinessInput };

const decisionContext = (readiness: ReadinessCandidate, now: Date) => ({
  readiness: {
    id: readiness.id,
    chainId: readiness.chainId,
    projectId: readiness.projectId,
    repoId: readiness.repoId,
  },
  now,
});

const readReadiness = async (
  db: PrismaClient,
  reader: GitHubReader | null,
  readiness: ReadinessCandidate,
  now: Date,
): Promise<ReadinessRead> => {
  const context = decisionContext(readiness, now);
  const regression = await db.task.findFirst({
    where: {
      projectId: readiness.projectId,
      chainId: readiness.chainId,
      templateId: readiness.templateId,
      templateStep: { outputKind: { in: [...REGRESSION_VERIFICATION_OUTPUT_KINDS] } },
    },
    include: READINESS_REGRESSION_INCLUDE,
  });
  if (!regression || regression.status !== TaskStatus.DONE) {
    return { claimed: false, input: { ...context, stage: "regression-pending" } };
  }

  const claimReason = readinessClaim(now);
  const claimWhere = readiness.status === TaskStatus.TODO
    ? { id: readiness.id, status: TaskStatus.TODO }
    : expiredReadinessClaim(readiness.failureReason, now)
      ? { id: readiness.id, status: TaskStatus.DOING, failureReason: readiness.failureReason }
      : null;
  if (!claimWhere) return { claimed: false, input: { ...context, stage: "claim-lost" } };
  const claimed = await db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, readiness.id);
    return tx.task.updateMany({
      where: claimWhere,
      data: { status: TaskStatus.DOING, failureReason: claimReason },
    });
  });
  if (claimed.count !== 1) return { claimed: false, input: { ...context, stage: "claim-lost" } };

  let recovery: RecoveryContext | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    recovery = await recoveryContextFor(db, regression.id, readiness.id, regression.runs[0]?.id ?? null);
    if (recovery) {
      await db.mergeRecoveryAttempt.update({ where: { id: recovery.aggregateId }, data: {
        status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
        failureReason: null,
      } });
    }
    const claimedRead = (input: ReadinessInput): ClaimedReadiness => ({
      claimed: true,
      readiness,
      regression,
      recovery,
      claimReason,
      input,
    });
    if (!regression.stepOutput) {
      return claimedRead({ ...context, stage: "missing-regression-evidence" });
    }
    const verdict = parseRegressionVerdict(regression.stepOutput.body, regression.stepOutput.kind);
    if (verdict.status !== "ok" || verdict.verdict.outcome !== "pass"
      || regression.stepOutput.commitSha !== verdict.verdict.headSha) {
      return claimedRead({ ...context, stage: "invalid-regression-evidence" });
    }
    if (!reader?.compareCommits) {
      return claimedRead({ ...context, stage: "reader-unavailable" });
    }
    const target = await db.$transaction((tx) => resolveChainTarget(tx, readiness));
    if (!target.resolved) {
      return claimedRead({ ...context, stage: "target-unresolved", unresolvable: target.unresolvable });
    }

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), READINESS_READ_BUDGET_MS);
    const snapshot = await reader.readPullRequest(
      target.repository,
      target.prNumber,
      readiness.repo?.defaultBranch ?? "main",
      controller.signal,
    );
    const readyInput = (
      values: Partial<Extract<ReadinessInput, { stage: "ready" }>> = {},
    ): ClaimedReadiness => claimedRead({
      ...context,
      stage: "ready",
      regression: {
        headSha: verdict.verdict.headSha,
        baseHeadSha: verdict.verdict.baseHeadSha,
      },
      target: { repository: target.repository, prNumber: target.prNumber },
      snapshot,
      comparison: null,
      resolutions: [],
      review: null,
      branch: null,
      evidence: null,
      ...values,
    });
    if (snapshot.headRefOid !== verdict.verdict.headSha
      || !snapshot.baseSha
      || !snapshot.baseRefName
      || snapshot.baseSha !== verdict.verdict.baseHeadSha) {
      return readyInput();
    }
    const comparison = await reader.compareCommits(
      target.repository,
      snapshot.baseSha,
      verdict.verdict.headSha,
      controller.signal,
    );
    if (!comparison.filesComplete
      || ((comparison.status !== "ahead" && comparison.status !== "identical")
        || comparison.behindBy !== 0)) {
      return readyInput({ comparison });
    }
    const markers = await readMarkerHistory(db, regression.id);
    const resolutions: Extract<ReadinessInput, { stage: "ready" }>["resolutions"] = [];
    for (const marker of markers) {
      if (marker.kind !== "repairResult" || marker.repairKind !== "refresh-conflict") continue;
      if (!marker.startHeadSha || !marker.resolvedHeadSha) {
        resolutions.push({ status: "unverifiable" });
        continue;
      }
      resolutions.push({
        status: "read",
        comparison: await reader.compareCommits(
          target.repository,
          marker.startHeadSha,
          marker.resolvedHeadSha,
          controller.signal,
        ),
      });
    }
    const review = await latestReviewState(
      db,
      readiness.id,
      verdict.verdict.headSha,
      recovery ? snapshot.baseSha : null,
    );
    const branchRun = await db.run.findFirst({
      where: {
        task: { projectId: readiness.projectId, chainId: readiness.chainId },
        branch: { not: null },
      },
      select: { branch: true },
      orderBy: { createdAt: "desc" },
    });
    return readyInput({
      comparison,
      resolutions,
      review: review ? { state: review.state, reviewTaskId: review.reviewTaskId } : null,
      branch: branchRun?.branch ?? null,
      evidence: evidenceFromSnapshot(snapshot, randomUUID()),
    });
  } catch (error: unknown) {
    const kind = error instanceof GitHubReadError ? error.kind : "unexpected";
    const message = error instanceof Error ? error.message : String(error);
    return {
      claimed: true,
      readiness,
      regression,
      recovery,
      claimReason,
      input: { ...context, stage: "read-failed", failure: { kind, message } },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const deferReadiness = async (
  db: PrismaClient,
  readinessTaskId: string,
  claimReason: string,
): Promise<boolean> => db.$transaction(async (tx) => {
  await lockTaskMutationRows(tx, readinessTaskId);
  const deferred = await tx.task.updateMany({
    where: { id: readinessTaskId, status: TaskStatus.DOING, failureReason: claimReason },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  return deferred.count === 1;
});

const applyReadinessDecision = async (
  db: PrismaClient,
  read: ClaimedReadiness,
  decision: ReadinessDecision,
  result: ReadinessTickResult,
  releaseChainLease: MergeLeaseReleaser,
  acquireChainLease: MergeLeaseAcquirer,
): Promise<void> => {
  const { readiness, regression, recovery } = read;
  let claimReason = read.claimReason;
  const stop = async (reason: string): Promise<boolean> => {
    const stopped = await stopReadiness(db, {
      readinessTaskId: readiness.id,
      regressionTaskId: regression.id,
      reason,
      recovery,
      claimReason,
    }, releaseChainLease);
    if (stopped) result.stopped += 1;
    return stopped;
  };
  const requeue = async (input: {
    staleBaseSha: string;
    currentBaseSha: string;
    reason: string;
  }): Promise<boolean> => {
    const requeued = await requeueRegression(db, {
      readinessTaskId: readiness.id,
      regressionTaskId: regression.id,
      ...input,
      now: read.input.now,
      recovery,
      claimReason,
    });
    if (requeued) result.requeued += 1;
    return requeued;
  };

  switch (decision.kind) {
    case "skip":
      return;
    case "defer":
      await deferReadiness(db, readiness.id, claimReason);
      return;
    case "stop":
      await stop(decision.evidence);
      return;
    case "requeue-regression":
      await requeue(decision);
      return;
    case "review": {
      if (decision.action === "park") {
        // The obligation is re-read inside the mutex before the park is
        // written. Between the read and here the review can have completed and
        // handed this Step back; parking on that stale read would strand it.
        const parked = await db.$transaction(async (tx) => {
          await lockTaskMutationRows(tx, readiness.id);
          const current = await latestReviewState(
            tx,
            readiness.id,
            decision.headSha,
            recovery ? decision.baseSha : null,
          );
          if (current?.state !== "open") return false;
          const reparked = await tx.task.updateMany({
            where: { id: readiness.id, status: TaskStatus.DOING, failureReason: claimReason },
            data: {
              status: TaskStatus.REVIEW,
              failureReason: `${INDEPENDENT_REVIEW_OPEN_PREFIX}${String(current.reviewTaskId)}`,
            },
          });
          return reparked.count === 1;
        });
        if (parked) await releaseForReview(releaseChainLease, readiness.chainId);
        result.reviewing += 1;
        return;
      }
      const opened = await createReviewObligation(db, {
        readinessTask: readiness,
        regressionTaskId: regression.id,
        branch: decision.branch,
        baseSha: decision.baseSha,
        headSha: decision.headSha,
        triggers: decision.triggers,
        recovery,
        claimReason,
      });
      if (opened.ok) {
        await releaseForReview(releaseChainLease, readiness.chainId);
        result.reviewing += 1;
      } else if ("lost" in opened) {
        // Another worker owns this readiness Step now. Leaving its state alone
        // is the whole point of noticing.
        result.reviewing += 1;
      } else {
        await stop(opened.reason);
      }
      return;
    }
    case "authorize":
      break;
  }

  // Renew immediately before the only network call outside the GitHub read
  // budget. The original claim covered the reads; this one covers the acquire
  // and authorization transaction.
  const renewedClaim = await renewReadinessClaim(db, readiness.id, claimReason);
  if (!renewedClaim) return;
  claimReason = renewedClaim;
  read.claimReason = renewedClaim;

  // From the base this authorization pins to the merge that consumes it,
  // `main` must not move. Earlier reads and Blind review can be repeated.
  if (readiness.chainId) {
    const acquisition = await acquireChainLease(readiness.chainId);
    if (acquisition.outcome === "contended") return;
    if (acquisition.outcome === "unreachable") {
      await stop(`merge lease acquire is unreachable: ${acquisition.detail}`);
      return;
    }
  }
  const authorization = await db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, readiness.id);
    const held = await tx.task.updateMany({
      where: { id: readiness.id, status: TaskStatus.DOING, failureReason: claimReason },
      data: { status: TaskStatus.DONE, failureReason: null },
    });
    if (held.count !== 1) {
      const current = await tx.task.findUnique({
        where: { id: readiness.id },
        select: { status: true, failureReason: true },
      });
      const activeSuccessor = current?.status === TaskStatus.DONE
        || (current?.status === TaskStatus.DOING
          && current.failureReason?.startsWith(READINESS_CLAIM_PREFIX));
      return activeSuccessor ? "claim-lost-active" as const : "claim-lost-inactive" as const;
    }
    const binding = `mechanical:${readiness.id}:${randomUUID()}`;
    const payload = {
      ...decision.evidence,
      mergeMethod: AUTHORIZED_MERGE_METHOD,
      issuedAt: decision.issuedAt,
      decision: {
        channel: "mechanical" as const,
        inboxDecisionId: binding,
        inboxMessageId: binding,
      },
    };
    const activity = await tx.taskActivity.create({ data: {
      taskId: readiness.id,
      actorType: "control-plane",
      body: `Mechanical merge authorized for PR #${decision.prNumber} at ${decision.evidence.headSha}`,
      metadata: {
        ...authorizationMetadata(payload),
        recoverySourceStopId: recovery?.sourceStopId ?? null,
      } as Prisma.InputJsonObject,
    } });
    await tx.taskStepOutput.upsert({
      where: { taskId: readiness.id },
      create: {
        taskId: readiness.id,
        kind: "merge-authorization",
        body: JSON.stringify({
          authorizationActivityId: activity.id,
          headSha: decision.evidence.headSha,
        }),
        commitSha: decision.evidence.headSha,
      },
      update: {
        kind: "merge-authorization",
        body: JSON.stringify({
          authorizationActivityId: activity.id,
          headSha: decision.evidence.headSha,
        }),
        commitSha: decision.evidence.headSha,
      },
    });
    await tx.task.update({ where: { id: regression.id }, data: { failureReason: null } });
    await writeMarker(tx, readiness.id, "readiness", {
      actorType: "control-plane",
      body: `Merge readiness authorized exact head ${decision.evidence.headSha}; merge execution queued`,
      metadata: {
        state: "authorized",
        headSha: decision.evidence.headSha,
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
      }, read.input.now);
    } else {
      await activateChainSuccessor(tx, readiness, {}, read.input.now);
    }
    return "authorized" as const;
  });
  if (authorization === "authorized") {
    result.authorized += 1;
  } else if (authorization === "claim-lost-inactive") {
    reportMergeLeaseAnomaly(
      readiness.chainId,
      await releaseMergeLeaseSafely(releaseChainLease, readiness.chainId),
    );
  }
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
  const pageSize = Math.max(limit * 20, 100);
  for await (const readiness of readinessCandidates(db, pageSize)) {
    if (result.claimed >= limit) break;
    if (!isMergeReadinessStep(readiness.templateStep)) continue;

    const read = await readReadiness(db, reader, readiness, now);
    const decision = readinessDecision(read.input);
    if (!read.claimed) continue;
    result.claimed += 1;
    try {
      await applyReadinessDecision(
        db,
        read,
        decision,
        result,
        releaseChainLease,
        acquireChainLease,
      );
    } catch (error: unknown) {
      const reason = `readiness evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
      const stopped = await stopReadiness(db, {
        readinessTaskId: readiness.id,
        regressionTaskId: read.regression.id,
        reason,
        recovery: read.recovery,
        claimReason: read.claimReason,
      }, releaseChainLease);
      if (stopped) result.stopped += 1;
    }
  }
  return result;
};

export const startReadinessWorker = (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
): ReturnType<typeof setInterval> => {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void readinessTick(db, reader, new Date(), 5, releaseMergeLease, acquireMergeLease)
      .catch((error: unknown) => console.error("Merge readiness tick failed", error))
      .finally(() => {
        inFlight = false;
      });
  }, readinessPollIntervalMs());
  timer.unref?.();
  return timer;
};
