import { randomUUID } from "node:crypto";

import {
  AUTHORIZED_MERGE_METHOD,
  MergeRecoveryStatus,
  Prisma,
  RunStatus,
  TaskStatus,
  activateChainSuccessor,
  activateRecoveryIntegratorSuccessor,
  authorizationMetadata,
  enqueueTaskRun,
  isMergeReadinessStep,
  latestRecordedStop,
  MERGE_TAIL_KIND,
  parseRegressionVerdict,
  REGRESSION_VERIFICATION_OUTPUT_KINDS,
  recoveryContext,
  resolveChainTarget,
  writeMarker,
  type PrismaClient,
  type RecoveryContext,
} from "@anneal/db";

import { lockTaskMutationRows } from "./task-write.js";
import { openDefenseAuditNotice, stopMergeTail } from "./merge-tail-actions.js";
import { createGitHubReader, type PullRequestReader } from "./github-read.js";
import {
  evaluateReadiness,
  READINESS_READ_BUDGET_MS,
  type ReadinessDecision,
  type ReadinessInput,
} from "./readiness-decision.js";
import {
  noteLeaseHandoff,
  releaseMergeLease,
  withMergeLease,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";

export const readinessPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_READINESS_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

const READINESS_CLAIM_PREFIX = "merge-readiness-claim:";
export { READINESS_READ_BUDGET_MS };
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

const LEGACY_RECOVERY_HEAD_ADOPTION_FAILURE =
  "readiness evaluation failed: Recovery activation authorization is not fresh for the recovered exact head and current base";

export const reopenRecoveryHeadAdoptionFailures = async (
  db: PrismaClient,
  limit = 5,
): Promise<number> => {
  const candidates = await db.mergeRecoveryAttempt.findMany({
    where: {
      status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
      failureReason: LEGACY_RECOVERY_HEAD_ADOPTION_FAILURE,
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  let reopened = 0;
  for (const candidate of candidates) {
    if (!candidate.readinessTaskId || !candidate.regressionTaskId || !candidate.recoveryRunId) continue;
    const applied = await db.$transaction(async (tx) => {
      if (!await lockTaskMutationRows(tx, candidate.readinessTaskId!)) return false;
      const [attempt, regression, readiness, integrator, run, output, stop] = await Promise.all([
        tx.mergeRecoveryAttempt.findUnique({ where: { id: candidate.id } }),
        tx.task.findUnique({ where: { id: candidate.regressionTaskId! }, select: { status: true } }),
        tx.task.findUnique({ where: { id: candidate.readinessTaskId! }, select: { status: true } }),
        tx.task.findUnique({ where: { id: candidate.integratorTaskId }, select: { status: true } }),
        tx.run.findUnique({ where: { id: candidate.recoveryRunId! }, select: { id: true, taskId: true, status: true, headSha: true } }),
        tx.taskStepOutput.findUnique({ where: { taskId: candidate.regressionTaskId! } }),
        latestRecordedStop(tx, candidate.integratorTaskId),
      ]);
      const verdict = parseRegressionVerdict(output?.body ?? "", output?.kind ?? "");
      if (!attempt
        || attempt.status !== MergeRecoveryStatus.BLOCKED_DOWNSTREAM
        || attempt.failureReason !== LEGACY_RECOVERY_HEAD_ADOPTION_FAILURE
        || attempt.recoveryRunId !== candidate.recoveryRunId
        || attempt.currentBaseSha === null
        || regression?.status !== TaskStatus.REVIEW
        || readiness?.status !== TaskStatus.REVIEW
        || integrator?.status !== TaskStatus.REVIEW
        || run?.taskId !== candidate.regressionTaskId
        || run.status !== RunStatus.SUCCEEDED
        || verdict.status !== "ok"
        || verdict.verdict.outcome !== "pass"
        || output?.runId !== run.id
        || output?.commitSha !== verdict.verdict.headSha
        || run.headSha !== verdict.verdict.headSha
        || verdict.verdict.baseHeadSha !== attempt.currentBaseSha
        || stop?.stopId !== attempt.sourceStopId) return false;

      const updated = await tx.mergeRecoveryAttempt.updateMany({
        where: {
          id: attempt.id,
          status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
          failureReason: LEGACY_RECOVERY_HEAD_ADOPTION_FAILURE,
        },
        data: { status: MergeRecoveryStatus.REPAIRING, failureReason: null, endedAt: null },
      });
      if (updated.count !== 1) return false;
      await tx.task.update({ where: { id: candidate.regressionTaskId! }, data: { status: TaskStatus.DONE, failureReason: null } });
      await tx.task.update({ where: { id: candidate.readinessTaskId! }, data: { status: TaskStatus.TODO, failureReason: null } });
      await tx.task.update({ where: { id: candidate.integratorTaskId }, data: {
        status: TaskStatus.REVIEW,
        failureReason: `Automatic base-drift recovery ${candidate.attempt} resumed after verified regression head adoption`,
      } });
      const body = `Automatic base-drift recovery ${candidate.attempt} reopened the verified Regression result for fresh readiness authorization`;
      const metadata = {
        aggregateId: candidate.id,
        sourceStopId: candidate.sourceStopId,
        recoveryRunId: candidate.recoveryRunId,
        state: "reopened-head-adoption",
      };
      await writeMarker(tx, candidate.integratorTaskId, "baseDriftRecovery", {
        actorType: "control-plane", body, metadata,
      });
      await writeMarker(tx, candidate.regressionTaskId!, "baseDriftRecovery", {
        actorType: "control-plane", body, metadata,
      });
      return true;
    });
    if (applied) reopened += 1;
  }
  return reopened;
};

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
  releaseChainLease: ReleaseMergeLease,
): Promise<boolean> => {
  const transition = await db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, input.readinessTaskId);
    const held = await tx.task.updateMany({
      where: { id: input.readinessTaskId, status: TaskStatus.DOING, failureReason: input.claimReason },
      data: { failureReason: input.claimReason },
    });
    if (held.count !== 1) return { applied: false as const, leaseToRelease: null };
    const stopped = await stopMergeTail(tx, {
      phase: "readiness",
      readinessTaskId: input.readinessTaskId,
      regressionTaskId: input.regressionTaskId,
      reason: input.reason,
      recovery: input.recovery,
      at: new Date(),
    });
    return { applied: true as const, leaseToRelease: stopped.leaseToRelease };
  });
  if (!transition.applied) return false;
  await releaseChainLease(transition.leaseToRelease);
  return true;
};

export type ReadinessTickResult = { claimed: number; authorized: number; requeued: number; stopped: number };

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
    const target = await db.$transaction((tx) => resolveChainTarget(tx, readiness));
    return claimedRead({
      ...context,
      stage: "ready",
      regression: {
        headSha: verdict.verdict.headSha,
        baseHeadSha: verdict.verdict.baseHeadSha,
      },
      target,
      defaultBranch: readiness.repo?.defaultBranch ?? "main",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      claimed: true,
      readiness,
      regression,
      recovery,
      claimReason,
      input: { ...context, stage: "read-failed", failure: { kind: "unexpected", message } },
    };
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

const recordLeaseDeferral = async (
  db: PrismaClient,
  input: {
    readinessTaskId: string;
    claimReason: string;
    chainId: string | null;
    detail: string;
    at: Date;
  },
): Promise<boolean> => db.$transaction(async (tx) => {
  await lockTaskMutationRows(tx, input.readinessTaskId);
  const held = await tx.task.updateMany({
    where: {
      id: input.readinessTaskId,
      status: TaskStatus.DOING,
      failureReason: input.claimReason,
    },
    data: { failureReason: input.claimReason },
  });
  if (held.count !== 1) return false;
  await tx.taskActivity.create({ data: {
    taskId: input.readinessTaskId,
    actorType: "control-plane",
    body: `Merge lease acquisition deferred: ${input.detail}`,
    metadata: {
      kind: MERGE_TAIL_KIND.readiness,
      state: "lease-acquire-deferred",
      chainId: input.chainId,
      detail: input.detail,
      retryAfter: new Date(input.at.getTime() + READINESS_CLAIM_LEASE_MS).toISOString(),
    },
  } });
  return true;
});

const applyReadinessDecision = async (
  db: PrismaClient,
  read: ClaimedReadiness,
  decision: ReadinessDecision,
  result: ReadinessTickResult,
  releaseChainLease: ReleaseMergeLease,
  runWithMergeLease: WithMergeLease,
  reader: PullRequestReader | null,
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
    if (requeued) {
      result.requeued += 1;
      await releaseChainLease(readiness.chainId);
    }
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
    case "authorize":
      break;
  }

  // From the base this authorization pins to the merge that consumes it,
  // `main` must not move. The callback makes the sole lawful handoff explicit:
  // only an authorized mechanical merge retains the Lease.
  const leased = await runWithMergeLease(readiness.chainId, async () => {
    // The acquire is the only network call outside the GitHub read budget. A
    // stale worker that lost its claim while taking the Lease must classify the
    // new owner before choosing release or retain.
    const renewedClaim = await renewReadinessClaim(db, readiness.id, claimReason);
    if (!renewedClaim) {
      const current = await db.task.findUnique({
        where: { id: readiness.id },
        select: { status: true, failureReason: true },
      });
      const activeSuccessor = current?.status === TaskStatus.DONE
        || (current?.status === TaskStatus.DOING
          && current.failureReason?.startsWith(READINESS_CLAIM_PREFIX));
      const handoff = activeSuccessor && readiness.chainId
        ? await db.run.findFirst({
          where: {
            task: { chainId: readiness.chainId, chainIndex: { gt: readiness.chainIndex ?? -1 } },
            status: { in: [RunStatus.QUEUED, RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] },
          },
          select: { id: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
        : null;
      return {
        disposition: handoff
          ? { kind: "retain" as const, handoffRunId: handoff.id }
          : { kind: "release" as const },
        value: activeSuccessor ? "claim-lost-active" as const : "claim-lost-inactive" as const,
      };
    }
    claimReason = renewedClaim;
    read.claimReason = renewedClaim;

    // Regression evidence is durable before this short Lease window. Repeat
    // the remote decision after acquisition so a base move between the first
    // read and the Lease cannot authorize stale evidence.
    const leasedDecision = await evaluateReadiness(reader, read.input);
    switch (leasedDecision.kind) {
      case "skip":
        return { disposition: { kind: "release" as const }, value: "lease-recheck-skipped" as const };
      case "defer":
        await deferReadiness(db, readiness.id, claimReason);
        return { disposition: { kind: "release" as const }, value: "lease-recheck-deferred" as const };
      case "stop": {
        const stopped = await stopReadiness(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          reason: leasedDecision.evidence,
          recovery,
          claimReason,
        }, async () => undefined);
        if (stopped) result.stopped += 1;
        return { disposition: { kind: "release" as const }, value: "lease-recheck-stopped" as const };
      }
      case "requeue-regression": {
        const requeued = await requeueRegression(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          ...leasedDecision,
          now: read.input.now,
          recovery,
          claimReason,
        });
        if (requeued) result.requeued += 1;
        return { disposition: { kind: "release" as const }, value: "lease-recheck-requeued" as const };
      }
      case "authorize":
        break;
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
        const handoff = activeSuccessor && readiness.chainId
          ? await tx.run.findFirst({
            where: {
              task: { chainId: readiness.chainId, chainIndex: { gt: readiness.chainIndex ?? -1 } },
              status: { in: [RunStatus.QUEUED, RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] },
            },
            select: { id: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          })
          : null;
        return {
          kind: activeSuccessor ? "claim-lost-active" as const : "claim-lost-inactive" as const,
          handoffRunId: handoff?.id ?? null,
        };
      }
      const binding = `mechanical:${readiness.id}:${randomUUID()}`;
      const payload = {
        ...leasedDecision.evidence,
        mergeMethod: AUTHORIZED_MERGE_METHOD,
        issuedAt: leasedDecision.issuedAt,
        decision: {
          channel: "mechanical" as const,
          inboxDecisionId: binding,
          inboxMessageId: binding,
        },
      };
      if (recovery) {
        // Recovery regression merges the current base before it proves the
        // candidate, so its gated head may legitimately replace the head that
        // first stopped on base drift. Adopt only the head re-read under the
        // merge lease, and bind the CAS to this recovery run and exact base.
        const adopted = await tx.mergeRecoveryAttempt.updateMany({
          where: {
            id: recovery.aggregateId,
            status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
            recoveryRunId: recovery.recoveryRunId,
            currentBaseSha: leasedDecision.evidence.baseSha,
          },
          data: { authorizedHeadSha: leasedDecision.evidence.headSha },
        });
        if (adopted.count !== 1) {
          throw new Error("Recovery authorization could not adopt the verified regression head");
        }
      }
      const activity = await tx.taskActivity.create({ data: {
        taskId: readiness.id,
        actorType: "control-plane",
        body: `Mechanical merge authorized for PR #${leasedDecision.prNumber} at ${leasedDecision.evidence.headSha}`,
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
            headSha: leasedDecision.evidence.headSha,
          }),
          commitSha: leasedDecision.evidence.headSha,
        },
        update: {
          kind: "merge-authorization",
          body: JSON.stringify({
            authorizationActivityId: activity.id,
            headSha: leasedDecision.evidence.headSha,
          }),
          commitSha: leasedDecision.evidence.headSha,
        },
      });
      await tx.task.update({ where: { id: regression.id }, data: { failureReason: null } });
      // The defence list no longer holds a merge. What it still does is say
      // which of these paths a human would want to have seen move, so the
      // merge leaves an audit message behind instead of a review obligation.
      if (leasedDecision.auditTriggers.length > 0) {
        await openDefenseAuditNotice(tx, {
          readinessTaskId: readiness.id,
          headSha: leasedDecision.headSha,
          baseSha: leasedDecision.baseSha,
          triggers: leasedDecision.auditTriggers,
        });
      }
      await writeMarker(tx, readiness.id, "readiness", {
        actorType: "control-plane",
        body: `Merge readiness authorized exact head ${leasedDecision.evidence.headSha}; merge execution queued`,
        metadata: {
          state: "authorized",
          headSha: leasedDecision.evidence.headSha,
          authorizationActivityId: activity.id,
          recoverySourceStopId: recovery?.sourceStopId ?? null,
        },
      });
      const activated = recovery
        ? await activateRecoveryIntegratorSuccessor(tx, {
          readinessTaskId: readiness.id,
          integratorTaskId: recovery.integratorTaskId,
          sourceStopId: recovery.sourceStopId,
          recoveryRunId: recovery.recoveryRunId,
          authorizationActivityId: activity.id,
        }, read.input.now)
        : await activateChainSuccessor(tx, readiness, {}, read.input.now);
      const handoff = activated.nextTaskId
        ? await tx.run.findFirst({
          where: { taskId: activated.nextTaskId, status: RunStatus.QUEUED },
          select: { id: true },
          orderBy: { runNumber: "desc" },
        })
        : null;
      if (handoff && readiness.chainId) {
        await noteLeaseHandoff(tx, { chainId: readiness.chainId, toRunId: handoff.id, at: read.input.now });
      }
      return { kind: "authorized" as const, handoffRunId: handoff?.id ?? null };
    });
    return {
      disposition: authorization.handoffRunId
        ? { kind: "retain" as const, handoffRunId: authorization.handoffRunId }
        : { kind: "release" as const },
      value: authorization.kind,
    };
  });
  if (leased.outcome === "contended") return;
  if (leased.outcome === "unreachable") {
    await recordLeaseDeferral(db, {
      readinessTaskId: readiness.id,
      claimReason,
      chainId: readiness.chainId,
      detail: leased.detail,
      at: read.input.now,
    });
    return;
  }
  if (leased.value === "authorized") {
    result.authorized += 1;
  }
};

export const readinessTick = async (
  db: PrismaClient,
  reader: PullRequestReader | null,
  now: Date,
  limit: number,
  releaseChainLease: ReleaseMergeLease,
  runWithMergeLease: WithMergeLease,
): Promise<ReadinessTickResult> => {
  const result: ReadinessTickResult = { claimed: 0, authorized: 0, requeued: 0, stopped: 0 };
  const pageSize = Math.max(limit * 20, 100);
  for await (const readiness of readinessCandidates(db, pageSize)) {
    if (result.claimed >= limit) break;
    if (!isMergeReadinessStep(readiness.templateStep)) continue;

    const read = await readReadiness(db, readiness, now);
    const decision = await evaluateReadiness(reader, read.input);
    if (!read.claimed) continue;
    result.claimed += 1;
    try {
      await applyReadinessDecision(
        db,
        read,
        decision,
        result,
        releaseChainLease,
        runWithMergeLease,
        reader,
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
  reader: PullRequestReader | null = createGitHubReader(),
): ReturnType<typeof setInterval> => {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void reopenRecoveryHeadAdoptionFailures(db)
      .then(() => readinessTick(db, reader, new Date(), 5, releaseMergeLease, withMergeLease))
      .catch((error: unknown) => console.error("Merge readiness tick failed", error))
      .finally(() => {
        inFlight = false;
      });
  }, readinessPollIntervalMs());
  timer.unref?.();
  return timer;
};
