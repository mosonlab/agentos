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
import {
  adoptRecoveryHead,
  awaitAuthorization,
  enterRepair,
  reopenAfterHeadAdoption,
} from "./merge-tail-state.js";
import { createGitHubReader, type PullRequestReader } from "./github-read.js";
import {
  evaluateReadiness,
  READINESS_READ_BUDGET_MS,
  type ReadinessDecision,
  type ReadinessInput,
} from "./readiness-decision.js";
import {
  releaseMergeLease,
  withMergeLease,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import type { MergeLeaseTarget } from "./merge-lease-hold.js";
import {
  claimReadinessStep,
  READINESS_CLAIM_LEASE_MS,
  type ReadinessClaimHandle,
  type ReadinessLeaseOwnership,
} from "./readiness-claim.js";

export const readinessPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_READINESS_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

export { READINESS_READ_BUDGET_MS };
export { READINESS_CLAIM_LEASE_MS };
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
const CURRENT_RECOVERY_HEAD_ADOPTION_FAILURE =
  "readiness evaluation failed: Recovery authorization could not adopt the verified regression head";

export const reopenRecoveryHeadAdoptionFailures = async (
  db: PrismaClient,
  limit = 5,
): Promise<number> => {
  const candidates = await db.mergeRecoveryAttempt.findMany({
    where: {
      status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
      failureReason: { in: [LEGACY_RECOVERY_HEAD_ADOPTION_FAILURE, CURRENT_RECOVERY_HEAD_ADOPTION_FAILURE] },
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
      const context = recoveryContext(attempt);
      const baseBindingMatchesFailure = attempt?.failureReason === LEGACY_RECOVERY_HEAD_ADOPTION_FAILURE
        ? verdict.status === "ok" && verdict.verdict.baseHeadSha === attempt.currentBaseSha
        : attempt?.failureReason === CURRENT_RECOVERY_HEAD_ADOPTION_FAILURE
          ? verdict.status === "ok" && verdict.verdict.baseHeadSha !== attempt.currentBaseSha
          : false;
      if (!attempt
        || !context
        || attempt.status !== MergeRecoveryStatus.BLOCKED_DOWNSTREAM
        || (attempt.failureReason !== LEGACY_RECOVERY_HEAD_ADOPTION_FAILURE
          && attempt.failureReason !== CURRENT_RECOVERY_HEAD_ADOPTION_FAILURE)
        || attempt.readinessTaskId !== candidate.readinessTaskId
        || attempt.regressionTaskId !== candidate.regressionTaskId
        || attempt.recoveryRunId !== candidate.recoveryRunId
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
        || !baseBindingMatchesFailure
        || stop?.stopId !== attempt.sourceStopId
        || stop.sourceRunId !== context.sourceRunId) return false;

      return reopenAfterHeadAdoption(tx, {
        recovery: context,
        expectedFailureReason: attempt.failureReason,
      });
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
): Promise<{ context: RecoveryContext; status: MergeRecoveryStatus } | null> => {
  if (!recoveryRunId) return null;
  const row = await db.mergeRecoveryAttempt.findFirst({ where: {
    regressionTaskId,
    readinessTaskId,
    recoveryRunId,
    status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION] },
  }, orderBy: [{ attempt: "desc" }, { id: "desc" }] });
  const context = recoveryContext(row);
  return row && context ? { context, status: row.status } : null;
};

const stopReadiness = async (
  db: PrismaClient,
  input: {
    readinessTaskId: string;
    regressionTaskId: string;
    reason: string;
    recovery: RecoveryContext | null;
  },
  claim: ReadinessClaimHandle,
): Promise<{
  applied: boolean;
  leaseToRelease: MergeLeaseTarget | null;
  ownership: ReadinessLeaseOwnership;
}> => db.$transaction(async (tx) => {
  const settlement = await claim.settle(tx, {
    kind: "finish",
    at: new Date(),
    apply: async (client) => {
      const stopped = await stopMergeTail(client, {
        phase: "readiness",
        readinessTaskId: input.readinessTaskId,
        regressionTaskId: input.regressionTaskId,
        reason: input.reason,
        recovery: input.recovery,
        at: new Date(),
      });
      return { value: stopped, ownership: "released" as const };
    },
  });
  if (!settlement.settled) {
    return { applied: false, leaseToRelease: null, ownership: settlement.ownership };
  }
  if (settlement.claim !== "released") throw new Error("Readiness stop retained a finished claim");
  return {
    applied: true,
    leaseToRelease: settlement.value.leaseToRelease,
    ownership: settlement.ownership,
  };
});

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
  },
  claim: ReadinessClaimHandle,
): Promise<{ applied: boolean; ownership: ReadinessLeaseOwnership }> => db.$transaction(async (tx) => {
  const settlement = await claim.settle(tx, {
    kind: "finish",
    at: input.now,
    apply: async (client) => {
      // The prior Regression run succeeded; the control plane invalidated its
      // exact-base evidence after a remote read. This retry is therefore external
      // compensation, not another attempt charged to the agent. Without the
      // grant, a requeue at the configured ceiling creates run N+1 with ceiling N
      // and the runner rejects it before launch -- exactly the stuck state the
      // readiness transition was supposed to recover.
      if (input.recovery) {
        await enterRepair(client, {
          aggregateId: input.recovery.aggregateId,
          currentBaseSha: input.currentBaseSha,
          now: input.now,
          readinessRequeue: { staleBaseSha: input.staleBaseSha, reason: input.reason },
        });
      } else {
        await client.task.update({
          where: { id: input.readinessTaskId },
          data: { status: TaskStatus.TODO, failureReason: null },
        });
        await client.task.update({
          where: { id: input.regressionTaskId },
          data: { status: TaskStatus.TODO, failureReason: null },
        });
        await enqueueTaskRun(client, input.regressionTaskId, input.now, { budgetGrant: 1 });
        await writeMarker(client, input.regressionTaskId, "readiness", {
          actorType: "control-plane",
          body: `Merge readiness returned to regression: ${input.reason}; ${input.staleBaseSha} -> ${input.currentBaseSha}`,
          metadata: {
            state: "requeued-regression",
            reason: input.reason,
            staleBaseSha: input.staleBaseSha,
            currentBaseSha: input.currentBaseSha,
          },
        });
      }
      return { value: undefined, ownership: "released" as const };
    },
  });
  if (!settlement.settled) return { applied: false, ownership: settlement.ownership };
  if (settlement.claim !== "released") throw new Error("Regression requeue retained a finished claim");
  return { applied: true, ownership: settlement.ownership };
});

type ClaimedReadiness = {
  claimed: true;
  readiness: ReadinessCandidate;
  regression: ReadinessRegression;
  recovery: RecoveryContext | null;
  claim: ReadinessClaimHandle;
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

  let recovery: RecoveryContext | null = null;
  let recoveryStatus: MergeRecoveryStatus | null = null;
  try {
    const recoveryRead = await recoveryContextFor(db, regression.id, readiness.id, regression.runs[0]?.id ?? null);
    recovery = recoveryRead?.context ?? null;
    recoveryStatus = recoveryRead?.status ?? null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      claimed: false,
      input: { ...context, stage: "read-failed", failure: { kind: "unexpected", message } },
    };
  }

  const claim = await claimReadinessStep(db, readiness.id, now);
  if (!claim) return { claimed: false, input: { ...context, stage: "claim-lost" } };

  try {
    const claimedRead = (input: ReadinessInput): ClaimedReadiness => ({
      claimed: true,
      readiness,
      regression,
      recovery,
      claim,
      input,
    });
    if (recovery && recoveryStatus === MergeRecoveryStatus.REPAIRING) {
      const transition = await db.$transaction((tx) => claim.settle(tx, {
        kind: "keep",
        apply: async (client) => awaitAuthorization(client, recovery!),
      }));
      if (!transition.settled) {
        return { claimed: false, input: { ...context, stage: "claim-lost" } };
      }
    }
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
      claim,
      input: { ...context, stage: "read-failed", failure: { kind: "unexpected", message } },
    };
  }
};

const deferReadiness = async (
  db: PrismaClient,
  readinessTaskId: string,
  claim: ReadinessClaimHandle,
): Promise<{ applied: boolean; ownership: ReadinessLeaseOwnership }> => db.$transaction(async (tx) => {
  const settlement = await claim.settle(tx, {
    kind: "finish",
    at: new Date(),
    apply: async (client) => {
      await client.task.update({
        where: { id: readinessTaskId },
        data: { status: TaskStatus.TODO, failureReason: null },
      });
      return { value: undefined, ownership: "released" as const };
    },
  });
  if (!settlement.settled) return { applied: false, ownership: settlement.ownership };
  if (settlement.claim !== "released") throw new Error("Readiness defer retained a finished claim");
  return { applied: true, ownership: settlement.ownership };
});

const recordLeaseDeferral = async (
  db: PrismaClient,
  input: {
    readinessTaskId: string;
    chainId: string | null;
    detail: string;
    at: Date;
  },
  claim: ReadinessClaimHandle,
): Promise<boolean> => db.$transaction(async (tx) => {
  const settlement = await claim.settle(tx, {
    kind: "keep",
    apply: async (client) => client.taskActivity.create({ data: {
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
    } }),
  });
  return settlement.settled;
});

const leaseDisposition = (ownership: ReadinessLeaseOwnership) => ownership === "released"
  ? { kind: "release" as const }
  : { kind: "retain" as const, handoffRunId: ownership.retainFor };

const applyReadinessDecision = async (
  db: PrismaClient,
  read: ClaimedReadiness,
  decision: ReadinessDecision,
  result: ReadinessTickResult,
  releaseChainLease: ReleaseMergeLease,
  runWithMergeLease: WithMergeLease,
  reader: PullRequestReader | null,
): Promise<void> => {
  const { readiness, regression, recovery, claim } = read;
  const target: MergeLeaseTarget | null = readiness.chainId
    ? { projectId: readiness.projectId, chainId: readiness.chainId }
    : null;
  const stop = async (reason: string): Promise<boolean> => {
    const stopped = await stopReadiness(db, {
      readinessTaskId: readiness.id,
      regressionTaskId: regression.id,
      reason,
      recovery,
    }, claim);
    if (!stopped.applied) return false;
    result.stopped += 1;
    await releaseChainLease(stopped.leaseToRelease, db);
    return true;
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
    }, claim);
    if (!requeued.applied) return false;
    result.requeued += 1;
    await releaseChainLease(target, db);
    return true;
  };

  switch (decision.kind) {
    case "skip":
      return;
    case "defer":
      await deferReadiness(db, readiness.id, claim);
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
  // `main` must not move. The Handle records the successor Run before its
  // transition can return retained Lease ownership.
  const leased = await runWithMergeLease(target, async () => {
    if (!await claim.renew()) {
      const ownership = await claim.ownershipAfterLoss(db);
      return { disposition: leaseDisposition(ownership), value: "claim-lost" as const };
    }

    // Regression evidence is durable before this short Lease window. Repeat
    // the remote decision after acquisition so a base move between the first
    // read and the Lease cannot authorize stale evidence.
    const leasedDecision = await evaluateReadiness(reader, read.input);
    switch (leasedDecision.kind) {
      case "skip":
        return { disposition: { kind: "release" as const }, value: "lease-recheck-skipped" as const };
      case "defer": {
        const deferred = await deferReadiness(db, readiness.id, claim);
        return { disposition: leaseDisposition(deferred.ownership), value: "lease-recheck-deferred" as const };
      }
      case "stop": {
        const stopped = await stopReadiness(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          reason: leasedDecision.evidence,
          recovery,
        }, claim);
        if (stopped.applied) result.stopped += 1;
        return { disposition: leaseDisposition(stopped.ownership), value: "lease-recheck-stopped" as const };
      }
      case "requeue-regression": {
        const requeued = await requeueRegression(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          ...leasedDecision,
          now: read.input.now,
          recovery,
        }, claim);
        if (requeued.applied) result.requeued += 1;
        return { disposition: leaseDisposition(requeued.ownership), value: "lease-recheck-requeued" as const };
      }
      case "authorize":
        break;
    }

    const authorization = await db.$transaction((tx) => claim.settle(tx, {
      kind: "finish",
      at: read.input.now,
      apply: async (client) => {
        await client.task.update({
          where: { id: readiness.id },
          data: { status: TaskStatus.DONE, failureReason: null },
        });
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
          // merge Lease and bind the CAS to the pre-Lease recovery snapshot.
          await adoptRecoveryHead(client, {
            recovery,
            currentBaseSha: leasedDecision.evidence.baseSha,
            authorizedHeadSha: leasedDecision.evidence.headSha,
          });
        }
        const activity = await client.taskActivity.create({ data: {
          taskId: readiness.id,
          actorType: "control-plane",
          body: `Mechanical merge authorized for PR #${leasedDecision.prNumber} at ${leasedDecision.evidence.headSha}`,
          metadata: {
            ...authorizationMetadata(payload),
            recoverySourceStopId: recovery?.sourceStopId ?? null,
          } as Prisma.InputJsonObject,
        } });
        await client.taskStepOutput.upsert({
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
        await client.task.update({ where: { id: regression.id }, data: { failureReason: null } });
        if (leasedDecision.auditTriggers.length > 0) {
          await openDefenseAuditNotice(client, {
            readinessTaskId: readiness.id,
            headSha: leasedDecision.headSha,
            baseSha: leasedDecision.baseSha,
            triggers: leasedDecision.auditTriggers,
          });
        }
        await writeMarker(client, readiness.id, "readiness", {
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
          ? await activateRecoveryIntegratorSuccessor(client, {
            readinessTaskId: readiness.id,
            integratorTaskId: recovery.integratorTaskId,
            sourceStopId: recovery.sourceStopId,
            recoveryRunId: recovery.recoveryRunId,
            authorizationActivityId: activity.id,
          }, read.input.now)
          : await activateChainSuccessor(client, readiness, {}, read.input.now);
        const handoff = activated.nextTaskId
          ? await client.run.findFirst({
            where: { taskId: activated.nextTaskId, status: RunStatus.QUEUED },
            select: { id: true },
            orderBy: { runNumber: "desc" },
          })
          : null;
        return {
          value: "authorized" as const,
          ownership: handoff ? { retainFor: handoff.id } : "released" as const,
        };
      },
    }));
    if (!authorization.settled) {
      return { disposition: leaseDisposition(authorization.ownership), value: "claim-lost" as const };
    }
    if (authorization.claim !== "released") throw new Error("Authorization retained a finished claim");
    return { disposition: leaseDisposition(authorization.ownership), value: authorization.value };
  }, db);
  if (leased.outcome === "contended") return;
  if (leased.outcome === "unreachable") {
    await recordLeaseDeferral(db, {
      readinessTaskId: readiness.id,
      chainId: readiness.chainId,
      detail: leased.detail,
      at: read.input.now,
    }, claim);
    return;
  }
  if (leased.value === "authorized") result.authorized += 1;
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
      }, read.claim);
      if (stopped.applied) {
        result.stopped += 1;
        await releaseChainLease(stopped.leaseToRelease, db);
      }
      // A failed release/hold recording can happen after stopMergeTail has
      // already committed its state transition. A second stop then returns
      // false and must not turn that failure into a successful-looking tick.
      // Surface it to the worker caller so the missing evidence is observable.
      if (!stopped.applied) throw error;
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
      .then(() => readinessTick(
        db,
        reader,
        new Date(),
        5,
        releaseMergeLease,
        withMergeLease,
      ))
      .catch((error: unknown) => console.error("Merge readiness tick failed", error))
      .finally(() => {
        inFlight = false;
      });
  }, readinessPollIntervalMs());
  timer.unref?.();
  return timer;
};
