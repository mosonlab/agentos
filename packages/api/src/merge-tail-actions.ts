import { createHash } from "node:crypto";

import {
  enqueueTaskRun,
  MAX_MERGE_TAIL_REPAIR_ATTEMPTS,
  mergeRecoveryTransitionAllowed,
  MergeRecoveryStatus,
  parseRegressionVerdict,
  Prisma,
  readMarkerHistory,
  type RecoveryContext,
  recoveryContext,
  TaskStatus,
  writeMarker,
} from "@agentos/db";

import { FAILURE_REASON_LIMIT, truncateFailureReason } from "./failure-reason.js";
import { settleLease } from "./merge-lease.js";

/**
 * The autonomous merge tail's own actions: the base-drift recovery aggregate,
 * the repair and follow-up cards it opens, the notices it writes when it stops,
 * and the regression completion that decides between them.
 *
 * They live here rather than in `app.ts` because both `run-completion.ts` and
 * `app.ts` call them, and importing them back out of `app.ts` would be a cycle.
 */

type DbTx = Prisma.TransactionClient;

/**
 * The notice the tail writes when it stops, keyed by task and reason.
 *
 * Stopping twice for the same reason is a legitimate event: an operator retry
 * re-queues the run, the claim path judges the same handoff invalid again, and
 * the stop path runs again. Under `create` that repeat raised P2002 inside the
 * caller's transaction, which rolled the whole stop back -- and in the claim
 * path took every other queued run's claim down with it. The notice is a
 * digest, not a log: one row per (task, reason) is the intended state, so a
 * repeat leaves the existing row alone.
 */
export const openMergeTailStopNotice = async (
  tx: DbTx,
  input: { taskId: string; agentId: string; sessionId?: string; reason: string },
): Promise<void> => {
  const dedupeKey = `merge-tail-stop:${input.taskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
  await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
    from: "AGENT",
    agentId: input.agentId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    taskId: input.taskId,
    kind: "TEXT",
    body: `Autonomous merge tail stopped: ${input.reason}`,
    dedupeKey,
  }, update: {} });
};

/**
 * The audit trail a merge leaves when its diff moved defence-list paths.
 *
 * The merge is not held for it: the message records what moved and why the path
 * is on the list, so the change is reviewable after the fact rather than
 * blocking beforehand. Keyed by readiness task and exact head, and upserted for
 * the same reason the stop notice is — a readiness tick that re-evaluates the
 * same head must not raise P2002 inside its caller's transaction.
 */
export const openDefenseAuditNotice = async (
  tx: DbTx,
  input: {
    readinessTaskId: string;
    headSha: string;
    baseSha: string;
    triggers: Array<{ path: string; reason: string }>;
  },
): Promise<void> => {
  const dedupeKey = `defense-audit:${input.readinessTaskId}:${input.headSha}`;
  const body = [
    "Merge proceeded with defense-list changes",
    `Exact range ${input.baseSha}..${input.headSha}.`,
    input.triggers.map((trigger) => `- ${trigger.path} (${trigger.reason})`).join("\n"),
  ].join("\n\n");
  await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
    from: "AGENT",
    taskId: input.readinessTaskId,
    kind: "TEXT",
    body,
    dedupeKey,
  }, update: {} });
};

export const baseDriftRecoveryContext = async (
  tx: DbTx,
  regressionTaskId: string,
  recoveryRunId?: string,
  sourceStopId?: string,
): Promise<RecoveryContext | null> => {
  const row = await tx.mergeRecoveryAttempt.findFirst({
    where: {
      regressionTaskId,
      status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION] },
      ...(recoveryRunId ? { recoveryRunId } : {}),
      ...(sourceStopId ? { sourceStopId } : {}),
    },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  return recoveryContext(row);
};

type RecoveryStopData = Prisma.MergeRecoveryAttemptUpdateInput;

export type StopMergeTailInput =
  | {
    phase: "regression";
    regressionTaskId: string;
    reason: string;
    at: Date;
    recovery: RecoveryContext | null;
    agentId: string;
    sessionId?: string;
  }
  | {
    phase: "readiness";
    readinessTaskId: string;
    regressionTaskId: string;
    reason: string;
    at: Date;
    recovery: RecoveryContext | null;
  }
  | {
    phase: "recovery-validation" | "recovery-exhausted";
    aggregateId: string;
    integratorTaskId: string;
    sourceStopId: string;
    reason: string;
    at: Date;
    attempt: number;
    recoveryData: RecoveryStopData;
    markerMetadata: Record<string, unknown>;
  }
  | {
    phase: "repair";
    regressionTaskId: string;
    repairTaskId: string;
    repairKind: string | null;
    startHeadSha: string | null;
    targetHeadSha: string | null;
    resolvedHeadSha: string | null;
    reason: string;
    at: Date;
    agentId: string;
    sessionId?: string;
  };

export type StopMergeTailResult = { leaseToRelease: string | null };

const transitionRecovery = async (
  tx: DbTx,
  aggregateId: string,
  target: MergeRecoveryStatus,
  data: RecoveryStopData,
): Promise<void> => {
  const aggregate = await tx.mergeRecoveryAttempt.findUnique({
    where: { id: aggregateId },
    select: { status: true },
  });
  if (!aggregate) throw new Error(`Merge recovery aggregate ${aggregateId} is absent`);
  if (!mergeRecoveryTransitionAllowed(aggregate.status, target)) {
    throw new Error(`Illegal merge recovery transition ${aggregate.status} -> ${target} for ${aggregateId}`);
  }
  await tx.mergeRecoveryAttempt.update({
    where: { id: aggregateId },
    data: { ...data, status: target },
  });
};

const stopNotice = async (
  tx: DbTx,
  input: { taskId: string; body: string; dedupeKey: string; agentId?: string; sessionId?: string },
): Promise<void> => {
  await tx.inboxMessage.upsert({ where: { dedupeKey: input.dedupeKey }, create: {
    from: "AGENT",
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    taskId: input.taskId,
    kind: "TEXT",
    body: input.body,
    dedupeKey: input.dedupeKey,
  }, update: {} });
};

/** Persist one merge-tail stop and return the Chain Lease its caller may release after commit. */
export const stopMergeTail = async (
  tx: DbTx,
  input: StopMergeTailInput,
): Promise<StopMergeTailResult> => {
  if (input.phase === "regression" || input.phase === "readiness") {
    const recovery = input.recovery;
    const body = recovery
      ? `Automatic base-drift recovery ${recovery.attempt} stopped at ${input.phase}: ${input.reason}`
      : input.phase === "readiness"
        ? `Autonomous merge readiness stopped: ${input.reason}`
        : `Autonomous merge tail stopped: ${input.reason}`;
    if (recovery) {
      await transitionRecovery(tx, recovery.aggregateId, MergeRecoveryStatus.BLOCKED_DOWNSTREAM, {
        failureReason: input.reason,
        endedAt: input.at,
      });
      if (input.phase === "regression") {
        await tx.task.updateMany({
          where: { id: { in: [recovery.regressionTaskId, recovery.readinessTaskId, recovery.integratorTaskId] } },
          data: { status: TaskStatus.REVIEW, failureReason: body },
        });
      } else {
        await tx.task.updateMany({
          where: { id: { in: [input.readinessTaskId, input.regressionTaskId] } },
          data: { status: TaskStatus.REVIEW, failureReason: input.reason },
        });
        await tx.task.update({
          where: { id: recovery.integratorTaskId },
          data: { status: TaskStatus.REVIEW, failureReason: body },
        });
      }
      const dedupeKey = `merge-base-drift-recovery-tail-stop:${recovery.sourceStopId}:${input.phase}`;
      const metadata = { ...recovery, state: "tail-stopped", phase: input.phase, reason: input.reason, dedupeKey };
      for (const taskId of [recovery.integratorTaskId, recovery.regressionTaskId]) {
        await writeMarker(tx, taskId, "baseDriftRecovery", { actorType: "control-plane", body, metadata });
      }
      await stopNotice(tx, { taskId: input.regressionTaskId, body, dedupeKey });
    } else if (input.phase === "readiness") {
      await tx.task.updateMany({
        where: { id: { in: [input.readinessTaskId, input.regressionTaskId] } },
        data: { status: TaskStatus.REVIEW, failureReason: input.reason },
      });
    } else {
      await tx.task.update({
        where: { id: input.regressionTaskId },
        data: { status: TaskStatus.REVIEW, failureReason: input.reason },
      });
    }
    if (!recovery && input.phase === "regression") {
      await writeMarker(tx, input.regressionTaskId, "regression", {
        actorType: "control-plane",
        body: `Regression did not advance: ${input.reason}`,
        metadata: { state: "stopped", reason: input.reason },
      });
      await openMergeTailStopNotice(tx, {
        taskId: input.regressionTaskId,
        agentId: input.agentId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        reason: input.reason,
      });
    }
    if (input.phase === "readiness") {
      await writeMarker(tx, input.regressionTaskId, "readiness", {
        actorType: "control-plane",
        body: `Merge readiness stopped at regression: ${input.reason}`,
        metadata: { state: "stopped", reason: input.reason },
      });
      if (!recovery) {
        const dedupeKey = `merge-readiness-stop:${input.readinessTaskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
        await stopNotice(tx, { taskId: input.regressionTaskId, body, dedupeKey });
      }
    }
    const lease = await settleLease(tx, { taskId: input.regressionTaskId, outcome: "stop" });
    return { leaseToRelease: lease.leaseToRelease };
  }

  if (input.phase === "repair") {
    await tx.task.update({
      where: { id: input.regressionTaskId },
      data: { status: TaskStatus.REVIEW, failureReason: input.reason },
    });
    await writeMarker(tx, input.regressionTaskId, "repairResult", {
      actorType: "control-plane",
      body: `Automatic ${input.repairKind} attempt failed: ${input.startHeadSha} -> ${input.resolvedHeadSha ?? "no-delivered-head"}`,
      metadata: {
        repairKind: input.repairKind,
        repairTaskId: input.repairTaskId,
        startHeadSha: input.startHeadSha,
        targetHeadSha: input.targetHeadSha,
        resolvedHeadSha: input.resolvedHeadSha,
        state: "failed",
      },
    });
    await openMergeTailStopNotice(tx, {
      taskId: input.regressionTaskId,
      agentId: input.agentId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      reason: input.reason,
    });
    const lease = await settleLease(tx, { taskId: input.regressionTaskId, outcome: "stop" });
    return { leaseToRelease: lease.leaseToRelease };
  }

  await transitionRecovery(tx, input.aggregateId, MergeRecoveryStatus.FAILED, {
    ...input.recoveryData,
    failureReason: input.reason,
    endedAt: input.at,
  });
  const state = input.phase === "recovery-validation" ? "ineligible" : "exhausted";
  const body = input.phase === "recovery-validation"
    ? `Automatic pre-merge base-drift recovery refused: ${input.reason}`
    : `Automatic pre-merge base-drift recovery exhausted at attempt ${input.attempt}`;
  await writeMarker(tx, input.integratorTaskId, "baseDriftRecovery", {
    actorType: "control-plane",
    body,
    metadata: {
      state,
      ...input.markerMetadata,
      integratorTaskId: input.integratorTaskId,
      sourceStopId: input.sourceStopId,
      reason: input.reason,
    },
  });
  const dedupeKey = `merge-base-drift-recovery:${state}:${input.sourceStopId}`;
  await stopNotice(tx, {
    taskId: input.integratorTaskId,
    body: `Automatic pre-merge base-drift recovery ${state} for stop ${input.sourceStopId}: ${input.reason}. No regression run or re-authorization was created.`,
    dedupeKey,
  });
  await tx.task.update({ where: { id: input.integratorTaskId }, data: {
    status: TaskStatus.REVIEW,
    failureReason: input.phase === "recovery-validation"
      ? `Automatic base-drift recovery refused: ${input.reason}`
      : input.reason,
  } });
  return { leaseToRelease: null };
};

export const createMergeTailRepairTask = async (
  tx: DbTx,
  input: {
    regressionTask: { id: string; projectId: string; repoId: string | null; templateId: string | null; chainId: string | null; chainIndex: number | null; targetBranch: string | null };
    sourceRun: { id: string; branch: string | null };
    agentName: string;
    repairKind: "refresh-conflict" | "gate-fix" | "review-fix";
    headSha: string;
    baseHeadSha: string;
    summary: string;
    now: Date;
  },
): Promise<{ taskId: string } | { refusal: string }> => {
  const { regressionTask } = input;
  if (
    !regressionTask.repoId || !regressionTask.chainId || regressionTask.chainIndex === null
    || !regressionTask.templateId || !input.sourceRun.branch
  ) {
    return { refusal: "repair task cannot resolve its chain position, repository, and shared branch" };
  }
  const agent = await tx.agent.findFirst({
    where: { projectId: regressionTask.projectId, name: input.agentName, archivedAt: null },
  });
  if (!agent) return { refusal: `required repair agent ${input.agentName} is absent or archived` };
  const grant = await tx.agentRepoAccess.findFirst({
    where: { projectId: regressionTask.projectId, agentId: agent.id, repoId: regressionTask.repoId },
  });
  if (!grant) return { refusal: `required repair agent ${input.agentName} has no repository grant` };

  // A repair task is deliberately chain-detached, so the claim path's own
  // prior-output lookup (which keys off chainId and chainIndex) never fires for
  // it. Without this the repair agent sees only the verdict summary and no
  // Feature brief, acceptance criteria, or review reports, and the narrowest
  // reading of that summary is the whole job it can do. Same query, ordering,
  // and rendering as a chain step's: what the chain steps could see, the repair
  // for those steps sees too.
  const priorOutputs = await tx.taskStepOutput.findMany({
    where: { task: {
      projectId: regressionTask.projectId,
      chainId: regressionTask.chainId,
      chainIndex: { lt: regressionTask.chainIndex },
    } },
    select: { kind: true, body: true, task: { select: { name: true, chainIndex: true } } },
    orderBy: { task: { chainIndex: "asc" } },
  });
  const chainContext = priorOutputs.length > 0
    ? [
      "Persisted outputs from prior template steps:",
      ...priorOutputs.map((output) => `## ${output.task.name} (${output.kind})\n${output.body}`),
    ].join("\n\n")
    : null;
  const prompt = [
    ...(input.repairKind === "refresh-conflict"
      ? [
        `Resolve the refresh conflict between chain head ${input.headSha} and target head ${input.baseHeadSha}.`,
        input.summary,
        `Re-run the merge, preserve both intents under the merge-resolver role contract, commit the resolution, and persist the role's versioned JSON bound to start ${input.headSha} and target ${input.baseHeadSha}.`,
      ]
      : [
        `Repair the autonomous merge tail failure at ${input.headSha} against target ${input.baseHeadSha}.`,
        input.summary,
        "Make exactly the changes needed to close this failure, run affected suites, commit, and persist the result as task output. Before changing any shared type, schema, or route contract, enumerate its callers across every workspace, including apps/web, and update or test each one in the same change.",
      ]),
    ...(chainContext ? [chainContext] : []),
  ].join("\n\n");
  const task = await tx.task.create({ data: {
    projectId: regressionTask.projectId,
    repoId: regressionTask.repoId,
    name: `Autonomous merge tail: ${input.repairKind}`,
    description: prompt,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.TODO,
    targetBranch: input.sourceRun.branch,
    maxSessionsPerTask: 1,
  } });
  const repairRun = await enqueueTaskRun(tx, task.id, input.now);
  await tx.run.update({
    where: { id: repairRun.id },
    data: { branch: input.sourceRun.branch, targetBranch: input.sourceRun.branch },
  });
  await writeMarker(tx, regressionTask.id, "repairAttempt", {
    actorType: "control-plane",
    body: `Automatic ${input.repairKind} attempt queued at chain head ${input.headSha} against ${input.baseHeadSha}`,
    metadata: {
      repairKind: input.repairKind,
      repairTaskId: task.id,
      headSha: input.headSha,
      baseHeadSha: input.baseHeadSha,
    },
  });
  await writeMarker(tx, task.id, "repairAttempt", {
    actorType: "control-plane",
    body: `Automatic ${input.repairKind} attempt for regression task ${regressionTask.id}`,
    metadata: {
      repairKind: input.repairKind,
      regressionTaskId: regressionTask.id,
      headSha: input.headSha,
      baseHeadSha: input.baseHeadSha,
    },
  });
  await tx.task.update({
    where: { id: regressionTask.id },
    data: { status: TaskStatus.REVIEW, failureReason: `${input.repairKind}: automatic repair ${task.id} queued at ${input.headSha}` },
  });
  return { taskId: task.id };
};

export const handleRegressionCompletion = async (
  tx: DbTx,
  input: {
    task: { id: string; projectId: string; repoId: string | null; templateId: string | null; chainId: string | null; chainIndex: number | null; targetBranch: string | null };
    run: { id: string; agentId: string; branch: string | null; headSha: string | null; sessionId: string };
    now: Date;
  },
): Promise<"advance" | "handled"> => {
  const persistedOutput = await tx.taskStepOutput.findUnique({ where: { taskId: input.task.id } });
  // Regression evidence is run-scoped even though TaskStepOutput is not yet.
  // An earlier attempt's explicit verdict is not this attempt's output and must
  // not be reused when the current agent finishes without calling task_output.
  const output = persistedOutput?.runId === input.run.id ? persistedOutput : null;
  const recovery = await baseDriftRecoveryContext(tx, input.task.id, input.run.id);
  const parsed = parseRegressionVerdict(output?.body, output?.kind);
  const stop = async (reason: string): Promise<"handled"> => {
    await stopMergeTail(tx, {
      phase: "regression",
      regressionTaskId: input.task.id,
      reason,
      at: input.now,
      recovery,
      agentId: input.run.agentId,
      sessionId: input.run.sessionId,
    });
    return "handled";
  };
  if (parsed.status === "invalid") return stop(parsed.reason);
  const verdict = parsed.verdict;
  const effectiveHead = input.run.headSha ?? output?.commitSha ?? null;
  if (effectiveHead !== verdict.headSha || output?.commitSha !== verdict.headSha) {
    return stop(`stale regression evidence: verdict ${verdict.headSha}, output ${output?.commitSha ?? "missing"}, run ${effectiveHead ?? "missing"}`);
  }
  await writeMarker(tx, input.task.id, "regression", {
    actorType: "control-plane",
    body: `Regression ${verdict.outcome} recorded for chain head ${verdict.headSha} against target ${verdict.baseHeadSha}`,
    metadata: { ...verdict },
  });
  if (verdict.outcome === "pass") {
    if (recovery) {
      await tx.mergeRecoveryAttempt.update({ where: { id: recovery.aggregateId }, data: {
        status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
        failureReason: null,
      } });
    }
    return "advance";
  }

  if (recovery) {
    await stopMergeTail(tx, {
      phase: "regression",
      regressionTaskId: input.task.id,
      recovery,
      agentId: input.run.agentId,
      sessionId: input.run.sessionId,
      at: input.now,
      reason: truncateFailureReason(
        verdict.outcome === "refresh-conflict"
          ? `refresh conflict at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`
          : verdict.outcome === "review-fail"
            ? `semantic regression FAIL at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`
            : `merge gate FAIL at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`,
        FAILURE_REASON_LIMIT,
      ),
    });
    return "handled";
  }

  // The whole history, not the recent-state window: the automatic attempt
  // budget per repair kind is the rule, and an attempt pushed past the window
  // by later activity would license an extra one.
  const attempts = await readMarkerHistory(tx, input.task.id);
  const repairKind = verdict.outcome === "refresh-conflict"
    ? "refresh-conflict"
    : verdict.outcome === "review-fail" ? "review-fix" : "gate-fix";
  const priorAttempts = attempts.filter((marker) => (
    marker.kind === "repairAttempt"
    && marker.repairKind === repairKind
    && (repairKind !== "refresh-conflict" || marker.headSha === verdict.headSha)
  )).length;
  // A refresh conflict is a merge of two fixed trees: a second resolver run on
  // the same head has nothing new to work with. A semantic or gate FAIL does —
  // the first repair moved the tree, and the verdict it now fails on is a
  // different one — so those get a second attempt before the tail stops.
  const attemptLimit = repairKind === "refresh-conflict" ? 1 : MAX_MERGE_TAIL_REPAIR_ATTEMPTS;
  if (priorAttempts >= attemptLimit) {
    return stop(repairKind === "refresh-conflict"
      ? `second refresh conflict on chain head ${verdict.headSha}`
      : repairKind === "review-fix"
        ? `semantic regression FAIL on chain head ${verdict.headSha} after ${priorAttempts} automatic repair attempts`
        : `merge gate FAIL on chain head ${verdict.headSha} after ${priorAttempts} automatic repair attempts`);
  }
  let agentName = "merge-resolver";
  if (repairKind === "gate-fix" || repairKind === "review-fix") {
    const fixTask = await tx.task.findFirst({
      where: {
        projectId: input.task.projectId,
        chainId: input.task.chainId,
        templateId: input.task.templateId,
        templateStep: { outputKind: "fixed-implementation" },
      },
      select: { assigneeAgent: { select: { name: true } } },
    });
    agentName = fixTask?.assigneeAgent?.name ?? "senior-dev";
  }
  const repair = await createMergeTailRepairTask(tx, {
    regressionTask: input.task,
    sourceRun: input.run,
    agentName,
    repairKind,
    headSha: verdict.headSha,
    baseHeadSha: verdict.baseHeadSha,
    summary: verdict.summary,
    now: input.now,
  });
  if ("refusal" in repair) return stop(repair.refusal);
  return "handled";
};
