import { createHash } from "node:crypto";

import {
  ACTIVE_RUN_STATUSES,
  AssigneeType,
  activateChainSuccessor,
  advanceTemplateTask,
  agentArchiveBlocker,
  applyInboxDecision,
  catalogRunnerForModel,
  CleanupStatus,
  CodexServiceTier,
  COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
  CompoundImplementationAssigneeError,
  compoundImplementationAssigneeValid,
  deriveRunConfig,
  deployBarrierAllowsClaim,
  FAILURE_ENVELOPE_VERSION,
  FailureClass,
  failurePhases,
  GoalStatus,
  enqueueTaskRun,
  InboxStatus,
  isArchivedAssigneeError,
  isArchivedTaskError,
  isCompoundImplementationAssigneeError,
  isCompoundImplementationStep,
  isIntegratorStoppedError,
  isPinnedBaseCommitError,
  LIVE_TASK_STATUSES,
  lockAgentRepoGrant,
  lockAgentRepoGrantForRevocation,
  lockAgentRow,
  lockChainRows,
  nativeImplementationSubagentRunConfig,
  NetworkingMode,
  Prisma,
  type PrismaClient,
  RepoPermission,
  RunStatus,
  ScheduleKind,
  PushStatus,
  RunnerKind,
  RunnerPreference,
  recomputeSessionUsage,
  resolveRequeueBase,
  resolveRunBranches,
  runnerFor,
  sessionUsageCost,
  sumUsageCosts,
  pinnedImplementationRange,
  SecretPurpose,
  SkillKind,
  SessionEventSource,
  SessionExecutionStatus,
  TaskSource,
  TaskStatus,
  TriggerFireSource,
  gateQuestion,
  claimantMayTake,
  isMergeExecutorRunnerId,
  mechanicalPrincipalRefusal,
  executionModeFor,
  isMergeConfirmationError,
  integratorBindingRefusal,
  integratorBindingRefusalFor,
  mergeExecutorRunnerIds,
  projectMergeOutcome,
  runOwnsMergeOutcome,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_TEMPLATE_NAME,
  produceMergeAuthorization,
  MERGE_INTEGRATOR_KIND,
  isIntegratorStep,
  latestTargetCorrection,
  loadIntegratorTask,
  observedChainPullRequests,
  parseMergeResult,
  PinnedBaseCommitError,
  recordIntegratorStop,
  requestConfirmationCard,
  resolveChainTarget,
  selectAuthorization,
  stopStateFor,
  stopStateRefusal,
  taskIsIntegratorStep,
  type CandidateActivity,
  type CardRow,
  type DecisionRow,
  asJsonObject,
  isMergeReadinessStep,
  MERGE_TAIL_KIND,
  MergeRecoveryStatus,
  mergeRecoveryPhase,
  parseRegressionVerdict,
  parseResolverResult,
  type MergeRecoveryAttempt,
} from "@agentos/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getMimeType } from "hono/utils/mime";
import { z } from "zod";

import { authenticate, issueSessionToken, principalMayAccess, type Principal } from "./auth.js";
import { boardCard, chainDisplayByTask, etagFor, etagMatches, serializeUsageCost } from "./board.js";
import { isValidBranchName } from "./branch-name.js";
import { chainExecutionOwner } from "./chain-execution-owner.js";
import {
  canonicalOutputRefusal,
  isCanonicalAdjudicationStep,
  isCanonicalAgentStep,
  isCanonicalBlindFindingsStep,
  isCanonicalSolFindingsStep,
  persistSessionTaskOutput,
  previousRunHandoffForClaim,
  reviewAdjudicationClaimRefusal,
} from "./canonical-task-output.js";
import { LOOPBACK_BROWSER_ORIGINS, originMayReachHandlers } from "./local-origin.js";
import {
  mergeTailLeaseChainId,
  releaseMergeLease,
  releaseMergeLeaseSafely,
  type MergeLeaseReleaser,
} from "./merge-lease.js";
import { createRunnerRegistry } from "./runners.js";
import {
  nextStoredCliAvailability,
  preserveCliAvailability,
  readStoredCliAvailability,
  storeCliAvailability,
} from "./runner-cli-availability.js";
import { runRunnerAvailabilityTransaction } from "./runner-availability-transaction.js";
import {
  chainKey,
  chainProgress,
  chainStartDecisions,
  type ChainProgress,
  chainProgressByChain,
  positions,
  blockingPredecessor,
  runFactsByTask,
  taskStartability,
  stepName,
} from "./chain.js";
import {
  classifyEnvelope,
  completionSucceeded,
  externalFailure,
  failureIsRetryable,
  jsonValue,
  makeDedupeKey,
  makeFencingToken,
  normalizeSessionEventValue,
  retryDelayMs,
  runBudgetCeiling,
} from "./execution.js";
import { createArchivedRunNoticeScheduler, noteArchivedQueuedRuns, reconcileDatabaseRuns } from "./reconcile.js";
import { regressionRepairHandoffForClaim } from "./regression-repair-handoff.js";
import {
  acknowledgeReclaimSalvage, publishReclaimIntents, recordReclaimOutcomes, repairReplacementAfterSalvage,
} from "./workspace-reclaim.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { isSerializationConflict, serializationRetryDelay } from "./serialization-retry.js";
import { suspendForInbox } from "./inbox.js";
import { createStarterInstallation, onboardingInput, onboardingStatus } from "./onboarding.js";
import { preflightOnboardingRepository, RepositoryPreflightError } from "./onboarding-preflight.js";
import { instantiateTemplate, isUsableTemplateVariable } from "./templates.js";
import { isTemplateInstantiationRefusal } from "./template-errors.js";
import { computeNextOccurrence, validateSchedule } from "./scheduler.js";
import { authenticateWebhook, resolvePayloadVariables, usableDefault } from "./hooks.js";
import { filesRootGrantKey, getFileStore } from "./files/config.js";
import { grantAdmits, type FileOperation, type GrantLike } from "./files/grants.js";
import { isCanonicalRelPath, normalizeRelPath } from "./files/paths.js";
import { DirectoryNotEmptyError, InvalidPathError, IsADirectoryError, NotADirectoryError, NotFoundError, SymlinkError, type FileStore } from "./files/store.js";
import { versionPayload } from "./version.js";

type AppEnvironment = { Variables: { principal: Principal } };

export interface LiveAppOptions {
  ownership: { assertHeld(): void | Promise<void> };
  onboardingRepositoryPreflight?: typeof preflightOnboardingRepository;
  releaseMergeLease?: MergeLeaseReleaser;
}

type DbTx = Prisma.TransactionClient;

class PinnedRunTargetError extends Error {
  constructor(readonly runId: string, targetBranch: string | null, implementationHeadSha: string) {
    super(`Pinned run ${runId} targets ${targetBranch ?? "no commit"}, but its source step now records ${implementationHeadSha}`);
    this.name = "PinnedRunTargetError";
  }
}

type CandidateActivationFailure = PinnedBaseCommitError | PinnedRunTargetError;

const isCandidateActivationFailure = (error: unknown): error is CandidateActivationFailure =>
  isPinnedBaseCommitError(error) || error instanceof PinnedRunTargetError;

const namedFailureReason = (error: CandidateActivationFailure): string => `${error.name}: ${error.message}`;

type QueuedBaseDriftRecoveryContext = {
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

const queuedRecoveryContext = (row: MergeRecoveryAttempt | null): QueuedBaseDriftRecoveryContext | null => {
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

const mergeRecoveryProjection = (row: MergeRecoveryAttempt | null) => row ? ({
  id: row.id,
  attempt: row.attempt,
  status: row.status,
  phase: mergeRecoveryPhase(row.status),
  sourceStopId: row.sourceStopId,
  boundSourceRunId: row.boundSourceRunId,
  recoveryRunId: row.recoveryRunId,
  failureReason: row.failureReason,
  updatedAt: row.updatedAt,
}) : null;

const baseDriftRecoveryContext = async (
  tx: DbTx,
  regressionTaskId: string,
  recoveryRunId?: string,
  sourceStopId?: string,
): Promise<QueuedBaseDriftRecoveryContext | null> => {
  const row = await tx.mergeRecoveryAttempt.findFirst({
    where: {
      regressionTaskId,
      status: { in: [MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION] },
      ...(recoveryRunId ? { recoveryRunId } : {}),
      ...(sourceStopId ? { sourceStopId } : {}),
    },
    orderBy: [{ attempt: "desc" }, { id: "desc" }],
  });
  return queuedRecoveryContext(row);
};

const stopBaseDriftRecoveryTail = async (
  tx: DbTx,
  context: QueuedBaseDriftRecoveryContext,
  phase: "regression" | "independent-review",
  reason: string,
): Promise<void> => {
  const body = `Automatic base-drift recovery ${context.attempt} stopped at ${phase}: ${reason}`;
  await tx.mergeRecoveryAttempt.update({ where: { id: context.aggregateId }, data: {
    status: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
    failureReason: reason,
    endedAt: new Date(),
  } });
  await tx.task.updateMany({
    where: { id: { in: [context.regressionTaskId, context.readinessTaskId, context.integratorTaskId] } },
    data: { status: TaskStatus.REVIEW, failureReason: body },
  });
  const dedupeKey = `merge-base-drift-recovery-tail-stop:${context.sourceStopId}:${phase}`;
  await tx.inboxMessage.upsert({ where: { dedupeKey }, create: {
    from: "AGENT", taskId: context.regressionTaskId, kind: "TEXT", body, dedupeKey,
  }, update: {} });
  const metadata = { ...context, kind: MERGE_TAIL_KIND.baseDriftRecovery, schemaVersion: 1,
    state: "tail-stopped", phase, reason, dedupeKey } as Prisma.InputJsonObject;
  await tx.taskActivity.createMany({ data: [
    { taskId: context.integratorTaskId, actorType: "control-plane", body, metadata },
    { taskId: context.regressionTaskId, actorType: "control-plane", body, metadata },
  ] });
};

const openMergeTailReviewDecisionInbox = async (
  tx: DbTx,
  input: { taskId: string; agentId: string; sessionId?: string; reason: string },
): Promise<void> => {
  await tx.inboxMessage.create({ data: {
    from: "AGENT",
    agentId: input.agentId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    taskId: input.taskId,
    kind: "MULTIPLE_CHOICE",
    body: [
      `Autonomous merge tail stopped: ${input.reason}`,
      "Choose one explicit operator action. No repair or merge will start automatically.",
    ].join("\n\n"),
    choices: [
      { id: "create-repair", label: "Create one review-fix task" },
      { id: "adopt-head", label: "Adopt current exact head and rerun Regression" },
      { id: "operator-takeover", label: "Park autonomous tail for operator takeover" },
    ],
    dedupeKey: `merge-tail-review-rejection:${input.taskId}:${createHash("sha256").update(input.reason).digest("hex")}`,
  } });
};

const openMergeTailStopNotice = async (
  tx: DbTx,
  input: { taskId: string; agentId: string; sessionId?: string; reason: string },
): Promise<void> => {
  await tx.inboxMessage.create({ data: {
    from: "AGENT",
    agentId: input.agentId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    taskId: input.taskId,
    kind: "TEXT",
    body: `Autonomous merge tail stopped: ${input.reason}`,
    dedupeKey: `merge-tail-stop:${input.taskId}:${createHash("sha256").update(input.reason).digest("hex")}`,
  } });
};

const createMergeTailRepairTask = async (
  tx: DbTx,
  input: {
    regressionTask: { id: string; projectId: string; repoId: string | null; templateId: string | null; chainId: string | null; targetBranch: string | null };
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
  if (!regressionTask.repoId || !regressionTask.chainId || !regressionTask.templateId || !input.sourceRun.branch) {
    return { refusal: "repair task cannot resolve its chain repository and shared branch" };
  }
  const agent = await tx.agent.findFirst({
    where: { projectId: regressionTask.projectId, name: input.agentName, archivedAt: null },
  });
  if (!agent) return { refusal: `required repair agent ${input.agentName} is absent or archived` };
  const grant = await tx.agentRepoAccess.findFirst({
    where: { projectId: regressionTask.projectId, agentId: agent.id, repoId: regressionTask.repoId },
  });
  if (!grant) return { refusal: `required repair agent ${input.agentName} has no repository grant` };

  const prompt = input.repairKind === "refresh-conflict"
    ? [
      `Resolve the refresh conflict between chain head ${input.headSha} and target head ${input.baseHeadSha}.`,
      input.summary,
      `Re-run the merge, preserve both intents under the merge-resolver role contract, commit the resolution, and persist the role's versioned JSON bound to start ${input.headSha} and target ${input.baseHeadSha}.`,
    ].join("\n\n")
    : [
      `Repair the autonomous merge tail failure at ${input.headSha} against target ${input.baseHeadSha}.`,
      input.summary,
      "Make exactly the changes needed to close this failure, run affected suites, commit, and persist the result as task output.",
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
  await tx.taskActivity.createMany({ data: [
    {
      taskId: regressionTask.id,
      actorType: "control-plane",
      body: `Automatic ${input.repairKind} attempt queued at chain head ${input.headSha} against ${input.baseHeadSha}`,
      metadata: {
        kind: MERGE_TAIL_KIND.repairAttempt,
        schemaVersion: 1,
        repairKind: input.repairKind,
        repairTaskId: task.id,
        headSha: input.headSha,
        baseHeadSha: input.baseHeadSha,
      },
    },
    {
      taskId: task.id,
      actorType: "control-plane",
      body: `Automatic ${input.repairKind} attempt for regression task ${regressionTask.id}`,
      metadata: {
        kind: MERGE_TAIL_KIND.repairAttempt,
        schemaVersion: 1,
        repairKind: input.repairKind,
        regressionTaskId: regressionTask.id,
        headSha: input.headSha,
        baseHeadSha: input.baseHeadSha,
      },
    },
  ] });
  await tx.task.update({
    where: { id: regressionTask.id },
    data: { status: TaskStatus.REVIEW, failureReason: `${input.repairKind}: automatic repair ${task.id} queued at ${input.headSha}` },
  });
  return { taskId: task.id };
};

const applyMergeTailOperatorDecision = async (
  tx: DbTx,
  input: { messageId: string; requestId: string; decision: string; now: Date },
): Promise<null | { duplicate: boolean; resumed: false; messageId: string; action?: string; error?: string }> => {
  const card = await tx.inboxMessage.findUnique({
    where: { id: input.messageId },
    include: {
      session: { include: { run: true } },
      task: { include: { templateStep: true, runs: { orderBy: { runNumber: "desc" }, take: 5 } } },
    },
  });
  if (!card?.dedupeKey?.startsWith("merge-tail-review-rejection:")) return null;
  if (!card.task || !card.session?.run) return { duplicate: false, resumed: false, messageId: card.id, error: "Merge-tail decision is missing its Regression task or source Run" };
  if (!["create-repair", "adopt-head", "operator-takeover"].includes(input.decision)) {
    return { duplicate: false, resumed: false, messageId: card.id, error: "Unknown merge-tail operator decision" };
  }
  if (card.status !== InboxStatus.OPEN) {
    return {
      duplicate: true,
      resumed: false,
      messageId: card.id,
      ...(card.selectedChoiceId ? { action: card.selectedChoiceId } : {}),
    };
  }
  const regression = card.task;
  if (regression.templateStep?.outputKind !== "regression-verification" || !regression.chainId || !regression.templateId) {
    return { duplicate: false, resumed: false, messageId: card.id, error: "Merge-tail decision is not bound to a canonical Regression task" };
  }
  if (regression.chainId) {
    await lockChainRows(tx, { projectId: regression.projectId, chainId: regression.chainId });
  } else {
    await lockTask(tx, regression.id);
  }
  const readiness = await tx.task.findFirst({
    where: {
      projectId: regression.projectId,
      chainId: regression.chainId,
      templateId: regression.templateId,
      templateStep: { outputKind: "merge-authorization" },
    },
  });
  if (!readiness) return { duplicate: false, resumed: false, messageId: card.id, error: "Merge-tail readiness task is missing" };
  const rows = await tx.taskActivity.findMany({
    where: {
      taskId: readiness.id,
      actorType: "control-plane",
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.reviewObligation },
    },
    select: { createdAt: true, metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  const rejection = rows.map((row) => ({ row, metadata: asJsonObject(row.metadata) })).find(({ metadata }) => (
    metadata?.state === "rejected" && typeof metadata.headSha === "string"
  ));
  const headSha = typeof rejection?.metadata?.headSha === "string" ? rejection.metadata.headSha : null;
  const baseHeadSha = typeof rejection?.metadata?.baseSha === "string" ? rejection.metadata.baseSha : null;
  const summary = typeof rejection?.metadata?.summary === "string" ? rejection.metadata.summary : null;
  if (!headSha || !baseHeadSha || !summary || !/^[0-9a-f]{40}$/u.test(headSha) || !/^[0-9a-f]{40}$/u.test(baseHeadSha)) {
    return { duplicate: false, resumed: false, messageId: card.id, error: "Merge-tail rejection lacks exact head/base evidence" };
  }
  const claimed = await tx.inboxMessage.updateMany({
    where: { id: card.id, status: InboxStatus.OPEN },
    data: { status: InboxStatus.ANSWERED, selectedChoiceId: input.decision, answeredAt: input.now },
  });
  if (claimed.count !== 1) return { duplicate: true, resumed: false, messageId: card.id };
  const externalEventId = `web:${input.requestId}`;
  await tx.inboxDecision.create({ data: {
    inboxMessageId: card.id,
    runId: card.session.run.id,
    externalEventId,
    decision: input.decision,
    actorOpenId: "web-operator",
  } });
  await tx.inboxMessage.create({ data: {
    from: "HUMAN",
    agentId: card.agentId,
    sessionId: card.sessionId,
    taskId: card.taskId,
    replyToMessageId: card.id,
    kind: "TEXT",
    body: input.decision,
    selectedChoiceId: input.decision,
    status: InboxStatus.CLOSED,
    dedupeKey: `decision:${externalEventId}:reply`,
    deliveryStatus: "DELIVERED",
    deliveredAt: input.now,
  } });
  await tx.taskActivity.create({ data: {
    taskId: regression.id,
    actorType: "operator",
    body: `Merge-tail operator decision ${input.decision} for exact head ${headSha}`,
    metadata: {
      kind: MERGE_TAIL_KIND.operatorDecision,
      schemaVersion: 1,
      action: input.decision,
      headSha,
      baseHeadSha,
      reviewTaskId: typeof rejection?.metadata?.reviewTaskId === "string" ? rejection.metadata.reviewTaskId : null,
      requestId: input.requestId,
    },
  } });

  if (input.decision === "create-repair") {
    const fixTask = await tx.task.findFirst({
      where: {
        projectId: regression.projectId,
        chainId: regression.chainId,
        templateId: regression.templateId,
        templateStep: { outputKind: "fixed-implementation" },
      },
      select: { assigneeAgent: { select: { name: true } } },
    });
    const sourceRun = regression.runs.find((run) => run.branch !== null);
    const repair = await createMergeTailRepairTask(tx, {
      regressionTask: regression,
      sourceRun: { id: card.session.run.id, branch: sourceRun?.branch ?? null },
      agentName: fixTask?.assigneeAgent?.name ?? "senior-dev",
      repairKind: "review-fix",
      headSha,
      baseHeadSha,
      summary,
      now: input.now,
    });
    if ("refusal" in repair) throw new Error(repair.refusal);
  } else if (input.decision === "adopt-head") {
    await tx.task.update({ where: { id: regression.id }, data: { status: TaskStatus.TODO, failureReason: null } });
    await tx.task.update({ where: { id: readiness.id }, data: { status: TaskStatus.TODO, failureReason: null } });
    await enqueueTaskRun(tx, regression.id, input.now);
  } else {
    const integrator = await tx.task.findFirst({
      where: { projectId: regression.projectId, chainId: regression.chainId, templateId: regression.templateId, templateStep: { outputKind: "merge-result" } },
      select: { id: true },
    });
    await tx.task.updateMany({
      where: { id: { in: [regression.id, readiness.id, ...(integrator ? [integrator.id] : [])] } },
      data: { status: TaskStatus.REVIEW, failureReason: `Autonomous merge tail parked by operator at ${headSha}` },
    });
  }
  return { duplicate: false, resumed: false, messageId: card.id, action: input.decision };
};

export const handleRegressionCompletion = async (
  tx: DbTx,
  input: {
    task: { id: string; projectId: string; repoId: string | null; templateId: string | null; chainId: string | null; targetBranch: string | null };
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
  const parsed = parseRegressionVerdict(output?.body);
  const stop = async (reason: string): Promise<"handled"> => {
    if (recovery) {
      await stopBaseDriftRecoveryTail(tx, recovery, "regression", reason);
      return "handled";
    }
    await tx.task.update({ where: { id: input.task.id }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
    await tx.taskActivity.create({ data: {
      taskId: input.task.id,
      actorType: "control-plane",
      body: `Regression did not advance: ${reason}`,
      metadata: { kind: MERGE_TAIL_KIND.regression, schemaVersion: 1, state: "stopped", reason },
    } });
    await openMergeTailStopNotice(tx, { taskId: input.task.id, agentId: input.run.agentId, sessionId: input.run.sessionId, reason });
    return "handled";
  };
  if (parsed.status === "invalid") return stop(parsed.reason);
  const verdict = parsed.verdict;
  const effectiveHead = input.run.headSha ?? output?.commitSha ?? null;
  if (effectiveHead !== verdict.headSha || output?.commitSha !== verdict.headSha) {
    return stop(`stale regression evidence: verdict ${verdict.headSha}, output ${output?.commitSha ?? "missing"}, run ${effectiveHead ?? "missing"}`);
  }
  await tx.taskActivity.create({ data: {
    taskId: input.task.id,
    actorType: "control-plane",
    body: `Regression ${verdict.outcome} recorded for chain head ${verdict.headSha} against target ${verdict.baseHeadSha}`,
    metadata: { kind: MERGE_TAIL_KIND.regression, ...verdict },
  } });
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
    await stopBaseDriftRecoveryTail(
      tx,
      recovery,
      "regression",
      verdict.outcome === "refresh-conflict"
        ? `refresh conflict at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`
        : verdict.outcome === "review-fail"
          ? `semantic regression FAIL at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`
          : `merge gate FAIL at ${verdict.headSha} against ${verdict.baseHeadSha}: ${verdict.summary}`,
    );
    return "handled";
  }

  const attempts = await tx.taskActivity.findMany({
    where: { taskId: input.task.id }, select: { metadata: true }, orderBy: { createdAt: "asc" },
  });
  const repairKind = verdict.outcome === "refresh-conflict"
    ? "refresh-conflict"
    : verdict.outcome === "review-fail" ? "review-fix" : "gate-fix";
  const alreadyAttempted = attempts.some((row) => {
    const metadata = asJsonObject(row.metadata);
    if (metadata?.kind !== MERGE_TAIL_KIND.repairAttempt || metadata.repairKind !== repairKind) return false;
    return repairKind !== "refresh-conflict" || metadata.headSha === verdict.headSha;
  });
  if (alreadyAttempted) {
    return stop(repairKind === "refresh-conflict"
      ? `second refresh conflict on chain head ${verdict.headSha}`
      : repairKind === "review-fix"
        ? `second semantic regression FAIL on chain head ${verdict.headSha}`
        : `second merge gate FAIL on chain head ${verdict.headSha}`);
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

const id = z.string().min(1);
const fence = z.string().min(1);
const projectFields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  yamlDocument: z.string(),
};
const projectInput = z.object({ ...projectFields, yamlDocument: projectFields.yamlDocument.default("") });
const projectPatch = z.object(projectFields).partial().refine((value) => Object.keys(value).length > 0);
/**
 * The eight canonical tool keys. Mirrored by apps/web/src/lib/tools.ts (labels and
 * per-runner enforcement) and packages/runner/src/adapters.ts (CLI flag names).
 * The three lists cross workspaces and cannot import each other; each names the
 * other two so a change here is followed there.
 */
const TOOL_KEYS = ["BASH", "READ", "WRITE", "EDIT", "GLOB", "GREP", "WEB_FETCH", "WEB_SEARCH"] as const;
const agentFields = {
  environmentId: id,
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  codexServiceTier: z.nativeEnum(CodexServiceTier),
  foundationalPrompt: z.string().min(1),
  rolePrompt: z.string().min(1),
  runnerPreference: z.nativeEnum(RunnerPreference),
  inboxAccess: z.boolean(),
  // Denied set, not allowed set: omitting it keeps the column's empty default.
  disabledTools: z.array(z.enum(TOOL_KEYS)).max(TOOL_KEYS.length),
};
const agentInput = z.object({
  ...agentFields,
  foundationalPrompt: agentFields.foundationalPrompt.optional(),
  codexServiceTier: agentFields.codexServiceTier.default(CodexServiceTier.DEFAULT),
  runnerPreference: agentFields.runnerPreference.default(RunnerPreference.INHERIT),
  inboxAccess: agentFields.inboxAccess.default(false),
  // `.default([])` rather than `.optional()`: under exactOptionalPropertyTypes an
  // optional key would spread `undefined` into `agent.create`. The empty array is
  // byte-identical to the column default, so omission still means "no restriction".
  disabledTools: agentFields.disabledTools.default([]),
});
const agentPatch = z.object(agentFields).partial().refine((value) => Object.keys(value).length > 0);

const codexServiceTierRefusal = (agent: {
  model: string;
  runnerPreference: RunnerPreference;
  codexServiceTier: CodexServiceTier;
}): string | null => {
  if (agent.codexServiceTier === CodexServiceTier.DEFAULT) return null;
  const model = agent.model.slice(0, agent.model.lastIndexOf(":") > 0 ? agent.model.lastIndexOf(":") : agent.model.length);
  const runner = runnerFor(agent.runnerPreference, agent.model);
  if (runner === RunnerKind.CODEX && model.startsWith("gpt-")) return null;
  if (runner === RunnerKind.PI && model.startsWith("openai-codex/")) return null;
  return "Fast service tier requires a Codex gpt-* model or a PI openai-codex/* model";
};

const runnerModelRefusal = (agent: { model: string; runnerPreference: RunnerPreference }): string | null => {
  const expected = catalogRunnerForModel(agent.model);
  if (!expected || agent.runnerPreference === RunnerPreference.AUTO || agent.runnerPreference === RunnerPreference.INHERIT
    || expected === agent.runnerPreference) return null;
  return `Model ${agent.model} requires ${expected}, but this Agent stores ${agent.runnerPreference}`;
};

const executionerRuntimeRefusal = (agent: {
  name: string;
  model: string;
  runnerPreference: RunnerPreference;
}): string | null => {
  if (agent.name !== "implementation-plan-executioner") return null;
  if (runnerFor(agent.runnerPreference, agent.model) === RunnerKind.CODEX
    && catalogRunnerForModel(agent.model) === RunnerPreference.CODEX) return null;
  return "implementation-plan-executioner requires a Codex gpt-* model";
};

const repoInput = z.object({
  name: z.string().trim().min(1).max(120),
  remoteUrl: z.string().trim().min(1),
  mountPath: z.string().trim().min(1).default("repo"),
  defaultBranch: z.string().trim().min(1).default("main"),
  credentialSecretId: id.nullable().default(null),
});
const repoAccessInput = z.object({
  permissions: z.nativeEnum(RepoPermission).default(RepoPermission.GIT_WRITE),
  mountPath: z.string().trim().min(1).default("repo"),
});
const repoPatch = repoInput.partial().refine((value) => Object.keys(value).length > 0);
const environmentFields = {
  name: z.string().trim().min(1).max(120),
  networking: z.nativeEnum(NetworkingMode),
  allowedHosts: z.array(z.string().trim().min(1).max(253)).max(500),
};
const environmentInput = z.object({
  name: environmentFields.name,
  networking: environmentFields.networking.default(NetworkingMode.LIMITED),
  allowedHosts: environmentFields.allowedHosts.default([]),
});
const environmentPatch = z.object(environmentFields).partial().refine((value) => Object.keys(value).length > 0);
const secretFields = {
  name: z.string().trim().min(1).max(120),
  purpose: z.nativeEnum(SecretPurpose),
  description: z.string().trim().max(1000).nullable(),
};
const secretInput = z.object({ ...secretFields, description: secretFields.description.default(null), value: z.string().min(1).max(100_000) });
const secretPatch = z.object(secretFields).partial().extend({ value: z.string().min(1).max(100_000).optional() })
  .refine((value) => Object.keys(value).length > 0);
const secretGrantInput = z.object({ secretId: id, envVar: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) });
const skillBindingInput = z.object({ skillId: id });
const mcpBindingInput = z.object({ mcpConnectionId: id });
const skillInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  kind: z.nativeEnum(SkillKind),
  body: z.string().nullable().default(null),
  filePath: z.string().trim().min(1).nullable().default(null),
}).superRefine((value, context) => {
  if (value.kind === SkillKind.PROMPT && value.body === null) context.addIssue({ code: "custom", message: "Prompt skills require body" });
  if (value.kind === SkillKind.FILE && value.filePath === null) context.addIssue({ code: "custom", message: "File skills require filePath" });
});
const mcpConnectionInput = z.object({
  name: z.string().trim().min(1).max(120),
  transport: z.string().trim().min(1).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
  allowedOperations: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  credentialSecretId: id.nullable().default(null),
});
const filesystemGrantFields = z.object({
  // "" is the sentinel for "the whole Files Root" (schema.prisma), so validation has to run
  // on the pre-trim value: a trailing `.trim()` before `.refine()` turns " " into "" and
  // hands a typo the entire root. Trimming still happens, but only for a real path.
  folderPath: z.string().max(4096).refine(
    (value) => (value.trim() === "" ? value === "" : isCanonicalRelPath(value.trim())),
    'folderPath must be "" (the whole Files Root) or a normalized Files-Root-relative POSIX path',
  ).transform((value) => value.trim()),
  canRead: z.boolean().default(false),
  canWrite: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});
const filesystemGrantInput = filesystemGrantFields.refine(
  (value) => value.canRead || value.canWrite || value.canDelete,
  "At least one filesystem permission is required",
);
const filesystemGrantPatch = filesystemGrantFields.partial().refine((value) => Object.keys(value).length > 0);
const collaboratorInput = z.object({ allowedAgentId: id });
const goalFields = {
  title: z.string().trim().min(1).max(200),
  spec: z.string().max(500_000),
  spendCap: z.number().nonnegative().nullable(),
  maxDurationMin: z.number().int().positive().nullable(),
  stallTimeoutMin: z.number().int().positive().max(24 * 60),
  maxSessionsPerTask: z.number().int().positive().max(100),
  stuckThreshold: z.number().int().positive().max(10_000),
  runnerPreference: z.nativeEnum(RunnerPreference),
  sharedFolderPath: z.string().trim().min(1).max(4096).nullable(),
};
const definitionItemText = z.object({ text: z.string().trim().min(1).max(10_000) });
const goalInput = z.object({
  ...goalFields,
  spec: goalFields.spec.default(""),
  spendCap: goalFields.spendCap.default(null),
  maxDurationMin: goalFields.maxDurationMin.default(240),
  stallTimeoutMin: goalFields.stallTimeoutMin.default(10),
  maxSessionsPerTask: goalFields.maxSessionsPerTask.default(3),
  stuckThreshold: goalFields.stuckThreshold.default(19),
  runnerPreference: goalFields.runnerPreference.default(RunnerPreference.AUTO),
  sharedFolderPath: goalFields.sharedFolderPath.default(null),
  definitionOfDone: z.array(definitionItemText).max(500).default([]),
});
const goalPatch = z.object(goalFields).partial().refine((value) => Object.keys(value).length > 0);
const definitionItemPatch = z.object({ text: definitionItemText.shape.text.optional(), done: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0);
const progressInput = z.object({
  body: z.string().trim().min(1).max(100_000),
  sessionId: id.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const taskFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string(),
  workingDirectory: z.string().trim().min(1).nullable(),
  repoId: id.nullable(),
  targetBranch: z.string().trim().min(1).nullable(),
  assigneeType: z.nativeEnum(AssigneeType),
  assigneeAgentId: id.nullable(),
  approvalGate: z.boolean(),
  opensPullRequest: z.boolean(),
  maxDurationMin: z.number().int().min(1).max(24 * 60),
  stallTimeoutMin: z.number().int().min(1).max(24 * 60),
  maxSessionsPerTask: z.number().int().min(1).max(100),
  scheduleKind: z.nativeEnum(ScheduleKind),
  runAt: z.coerce.date().nullable(),
  cron: z.string().trim().min(9).max(100).nullable(),
  timezone: z.string().trim().min(1).max(64).nullable(),
};
/** Exported for `smoke-fixture.test.ts`: the published release fixture and this
 *  schema have to agree about `opensPullRequest`, and the only way to assert
 *  that is to parse the fixture with the schema the route actually uses. */
export const taskInput = z.object({
  ...taskFields,
  description: taskFields.description.default(""),
  workingDirectory: taskFields.workingDirectory.default(null),
  repoId: taskFields.repoId.default(null),
  targetBranch: taskFields.targetBranch.default(null),
  assigneeType: taskFields.assigneeType.default(AssigneeType.AGENT),
  assigneeAgentId: taskFields.assigneeAgentId.default(null),
  approvalGate: taskFields.approvalGate.default(false),
  opensPullRequest: taskFields.opensPullRequest.default(true),
  maxDurationMin: taskFields.maxDurationMin.default(240),
  stallTimeoutMin: taskFields.stallTimeoutMin.default(10),
  maxSessionsPerTask: taskFields.maxSessionsPerTask.default(5),
  scheduleKind: taskFields.scheduleKind.default(ScheduleKind.NOW),
  runAt: taskFields.runAt.default(null),
  cron: taskFields.cron.default(null),
  timezone: taskFields.timezone.default(null),
  chainId: z.string().trim().min(1).max(100).optional(),
  chainIndex: z.number().int().min(0).optional(),
}).strict().superRefine((value, context) => {
  if ((value.chainId === undefined) !== (value.chainIndex === undefined)) {
    context.addIssue({ code: "custom", message: "chainId and chainIndex must be provided together" });
  }
});
const taskPatch = z.object(taskFields).partial().extend({ status: z.nativeEnum(TaskStatus).optional() })
  .refine((value) => Object.keys(value).length > 0);
const activityInput = z.object({
  actorType: z.string().trim().min(1).max(40).default("operator"),
  actorId: z.string().trim().min(1).nullable().optional(),
  body: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const fencedActivityInput = activityInput.extend({ fencingToken: fence });
const mergeTargetInput = z.object({ prNumber: z.number().int().positive() });
const telemetry = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(({ error, input }) => {
  console.warn("Discarded runner telemetry", { input, issues: error.issues });
  return undefined;
});
const runnerTelemetryFields = {
  daemonVersion: telemetry(z.string().trim().max(40)),
  diskFreeBytes: telemetry(z.number().int().nonnegative()),
  pollIntervalMs: telemetry(z.number().int().positive().max(3_600_000)),
  workspaceRoot: telemetry(z.string().trim().max(500)),
};
const claimInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
  ...runnerTelemetryFields,
});
// The runner's inventory of its own root. `directories` are bare names, never
// paths: this API refuses to hold an opinion about a filesystem it does not
// own, and a name is all the ownership predicate needs.
const reclaimInventoryInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  workspaceRoot: z.string().trim().min(1).max(500),
  directories: z.array(z.string().trim().min(1).max(200).refine(
    (value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..",
    { message: "directory must be a bare name inside the runner's workspace root" },
  )).max(5000),
});
const reclaimReportInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  workspaceRoot: z.string().trim().min(1).max(500),
  results: z.array(z.object({
    runId: id,
    outcome: z.enum(["REMOVED", "REFUSED", "FAILED"]),
    failureReason: z.string().max(2000).nullable().optional(),
  })).max(5000),
});
const reclaimSalvageInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  runId: id,
  pushedBranch: z.string().trim().min(1).max(255),
});
const heartbeatInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
  processAlive: z.boolean(),
  lastProgressEventAt: z.coerce.date().nullable().optional(),
  inFlightTool: z.record(z.string(), z.unknown()).nullable().optional(),
  ...runnerTelemetryFields,
});
const cancelRunInput = z.object({
  requestId: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(2000),
  parkTask: z.boolean().default(false),
});
const cancelAcknowledgeInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  requestId: z.string().trim().min(1).max(160),
  workspacePath: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
});
const publicationInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  pushedBranch: z.string().trim().min(1).max(255),
});
const leaseIndependentCleanupInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  cleanupStatus: z.nativeEnum(CleanupStatus),
  cleanupFailureReason: z.string().max(4000).optional(),
  workspaceRetained: z.boolean(),
});
const startInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  adapterVersion: z.string().min(1),
  cliVersion: z.string().min(1),
  authMode: z.string().nullable().optional(),
  manifest: z.record(z.string(), z.unknown()),
  // Nullable for the mechanical executor only, which provisions no workspace at
  // all — the column is already `String?`. An ordinary runner still sends a
  // path; nothing downstream reads this field as a guarantee that one exists.
  workspacePath: z.string().min(1).nullable(),
  branch: z.string().nullable().optional(),
  baseSha: z.string().nullable().optional(),
  runtimeHandle: z.string().nullable().optional(),
});
// Envelopes are dispatched on `version` *before* any version's field schema is
// applied. Only `version` itself is required to parse, and everything else is
// carried through untouched.
//
// Validating v1's shape first would have made the fallback a lie: a v2 runner
// that adds a phase or a failure class would be rejected at the schema, and its
// completion — a terminal write that cannot simply be retried — would 400
// instead of degrading to the legacy fields. The version is the only thing this
// API can read from an envelope it does not know.
const versionedEnvelopeInput = z.object({
  version: z.number().int().positive(),
}).catchall(z.unknown());

// Mirrors packages/db/src/failure-envelope.ts, which is the canonical shape,
// and packages/runner/src/envelope.ts, which is the runner's hand-kept copy of
// it. This schema is the boundary that catches drift between the two, and it is
// applied only to envelopes that announce themselves as v1.
//
// Every field is defaulted rather than required wherever a default is
// unambiguous, and the free-text limits are 16x what the runner truncates to.
// That is deliberate: a rejected completion is not a rejected envelope, it is a
// run that never records a terminal state and is later reconciled as LOST. The
// envelope must never be the reason a completion fails — which is also why the
// route below treats a v1 envelope that fails this schema as no envelope at
// all rather than as a bad request.
const failureEnvelopeV1Input = z.object({
  version: z.number().int().positive(),
  phase: z.enum(failurePhases),
  runnerClass: z.nativeEnum(FailureClass).nullable().default(null),
  exitCode: z.number().int().nullable().default(null),
  signal: z.string().max(64).nullable().default(null),
  terminationReason: z.string().max(4000).nullable().default(null),
  terminalEventSeen: z.boolean().default(false),
  terminalSuccess: z.boolean().default(false),
  agentExited: z.boolean().default(false),
  providerError: z.string().max(64_000).nullable().default(null),
  stderrSummary: z.string().max(64_000).nullable().default(null),
  stdoutSummary: z.string().max(64_000).nullable().default(null),
  timedOut: z.boolean().default(false),
  transient: z.boolean().default(false),
  timeoutMs: z.number().int().nonnegative().nullable().default(null),
});

const completionInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  terminalEventSeen: z.boolean(),
  terminalSuccess: z.boolean(),
  terminationReason: z.string().nullable().optional(),
  failureClass: z.nativeEnum(FailureClass).optional(),
  failureReason: z.string().max(4000).optional(),
  retryable: z.boolean().optional(),
  externalFailure: z.boolean().default(false),
  branch: z.string().nullable().optional(),
  // The ref the runner actually handed to `git push`, which is not always
  // `branch`: a WIP salvage pushes a per-run branch while `branch` still reports
  // the workspace's. It is the only publication evidence resolveRunBranches
  // trusts, so it must survive the trip verbatim.
  pushedBranch: z.string().nullable().optional(),
  baseSha: z.string().nullable().optional(),
  headSha: z.string().nullable().optional(),
  output: z.string().max(500_000).nullable().optional(),
  pushStatus: z.nativeEnum(PushStatus).default(PushStatus.NOT_REQUESTED),
  pushRemote: z.string().nullable().optional(),
  pushError: z.string().max(4000).nullable().optional(),
  pullRequestUrl: z.string().nullable().optional(),
  pullRequestNumber: z.number().int().positive().nullable().optional(),
  deliveryInstructions: z.string().max(8000).nullable().optional(),
  cleanupStatus: z.nativeEnum(CleanupStatus),
  cleanupFailureReason: z.string().max(4000).nullable().optional(),
  workspaceRetained: z.boolean().default(false),
  failureEnvelope: versionedEnvelopeInput.optional(),
});
const eventInput = z.object({
  seq: z.number().int().nonnegative(),
  at: z.coerce.date().optional(),
  source: z.nativeEnum(SessionEventSource),
  type: z.string().min(1).max(100),
  providerEventId: z.string().nullable().optional(),
  toolCallId: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
});
const eventsInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  providerConversationId: z.string().nullable().optional(),
  events: z.array(eventInput).min(1).max(250),
});
const preflightInput = z.object({
  runner: z.nativeEnum(RunnerKind),
  ok: z.boolean(),
  cliVersion: z.string().nullable().optional(),
  authMode: z.string().nullable().optional(),
  capabilities: z.record(z.string(), z.unknown()),
  error: z.string().nullable().optional(),
});
const runnerAvailabilityInput = z.object({
  // Optional only for the API-first half of a rolling deployment. A runner
  // without an identity may still report binary health, but cannot receive a
  // coordinated full-preflight retry directive.
  runnerId: z.string().trim().min(1).max(120).optional(),
  runner: z.nativeEnum(RunnerKind),
  binary: z.string().trim().min(1).max(500),
  available: z.boolean(),
  resolvedPath: z.string().trim().min(1).max(2000).nullable(),
}).superRefine((body, context) => {
  if (body.available !== (body.resolvedPath !== null)) {
    context.addIssue({ code: "custom", message: "available and resolvedPath disagree" });
  }
});
const inboxQuestionInput = z.object({
  fencingToken: fence,
  requestId: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  choices: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(200) })).max(20).default([]),
  chatId: z.string().min(1).optional(),
  resumableUntil: z.coerce.date().nullable().optional(),
});
const stepOverrideInput = z.object({ assigneeAgentId: id }).strict();
const stepOverridesInput = z.record(z.string(), stepOverrideInput).superRefine((overrides, context) => {
  for (const stepIndex of Object.keys(overrides)) {
    if (!/^[1-9]\d*$/u.test(stepIndex)) {
      context.addIssue({
        code: "custom",
        path: [stepIndex],
        message: `Step override key ${stepIndex} must be a positive decimal step index without leading zeros`,
        params: { templateRefusalCode: "step_override_invalid_key" },
      });
    }
  }
});
const instantiateTemplateInput = z.object({
  repoId: id,
  variables: z.record(z.string(), z.string().refine(isUsableTemplateVariable, "Template variables must not be blank")),
  autoStart: z.boolean().default(false),
  afterTaskId: id.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(50_000).optional(),
  stepOverrides: stepOverridesInput.optional(),
}).superRefine((value, context) => {
  const branchName = value.variables.branchName;
  if (branchName !== undefined && !isValidBranchName(branchName)) {
    context.addIssue({ code: "custom", path: ["variables", "branchName"], message: "Template branchName is not a valid Git branch name" });
  }
  if (value.afterTaskId && value.autoStart) {
    context.addIssue({
      code: "custom",
      path: ["afterTaskId"],
      message: `afterTaskId ${value.afterTaskId} cannot be combined with autoStart=true; a bound chain waits for its predecessor`,
      params: { templateRefusalCode: "dispatch_conflicts_with_auto_start" },
    });
  }
});
const isTemplateInputError = (error: unknown): error is Error => (
  error instanceof Error
  && /(not found|has no|is archived|Missing template|Unknown template|must be agent|Invalid template branch)/iu.test(error.message)
);
const templateSchemaRefusal = (error: unknown): { error: string; code: string } | null => {
  if (!(error instanceof z.ZodError)) return null;
  const issue = error.issues.find((candidate) => {
    const params = (candidate as unknown as { params?: Record<string, unknown> }).params;
    return typeof params?.templateRefusalCode === "string";
  });
  if (!issue) return null;
  const params = (issue as unknown as { params?: Record<string, unknown> }).params;
  return typeof params?.templateRefusalCode === "string"
    ? { error: issue.message, code: params.templateRefusalCode }
    : null;
};
// `Fire now` merges over the template's own defaults, so an all-defaulted
// trigger fires from an empty body.
const manualFireInput = z.object({
  variables: z.record(z.string(), z.string()).optional(),
}).default({});
const webhookPayloadMapping = z.object({
  map: z.record(z.string(), z.string().trim().min(1)).optional(),
  defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
const webhookConfigPatch = z.object({
  webhookSecretId: id.nullable().optional(),
  webhookRepoId: id.nullable().optional(),
  webhookPayloadMapping: webhookPayloadMapping.nullable().optional(),
  // 0 and null both mean "no replay window"; the write side normalises 0 to
  // null so the read side has exactly one representation of disabled.
  webhookReplayWindowSec: z.number().int().min(0).max(86_400).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);
const templateStepPatch = z.object({
  opensPullRequest: z.boolean().optional(),
  baseFromStepIndex: z.number().int().min(0).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);
const templateStepInput = z.object({
  stepIndex: z.number().int().min(0),
  name: z.string().trim().min(1).max(200),
  assigneeType: z.nativeEnum(AssigneeType),
  assigneeAgentId: id.nullable().default(null),
  prompt: z.string().min(1).max(100_000),
  approvalGate: z.boolean().default(false),
  attachmentsFromPrevious: z.boolean().default(false),
  spawnPolicy: z.record(z.string(), z.unknown()).nullable().default(null),
  runner: z.nativeEnum(RunnerKind).nullable().default(null),
  outputKind: z.string().trim().min(1).max(80).default("result"),
  opensPullRequest: z.boolean().default(true),
  baseFromStepIndex: z.number().int().min(0).nullable().default(null),
}).strict();
const taskOutputInput = z.object({
  fencingToken: fence.optional(),
  kind: z.string().trim().min(1).max(80),
  body: z.string().min(1).max(500_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  commitSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u).optional(),
});
const inboxDecisionInput = z.object({
  decision: z.string().trim().min(1).max(8000),
  requestId: z.string().trim().min(1).max(200),
});
const inboxReplyInput = z.object({
  body: z.string().trim().min(1).max(8000),
  requestId: z.string().trim().min(1).max(200),
});
const inboxCloseInput = z.object({
  requestId: z.string().trim().min(1).max(200),
});

const readJson = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await request.json());

/** The `chainProgress` shape as `GET /tasks` serialises it — the chain module's
 *  progress plus the position spec §5.2 requires the list response to carry. */
type ChainProgressWire = ChainProgress & { position: number | null };
/** The columns `chainProgressLookup` reads, which both `GET /tasks` response
 *  shapes select. Structural, so neither Prisma payload type leaks into it. */
type ChainSubject = {
  id: string;
  projectId: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatus;
  name: string;
  templateStep: { name: string } | null;
};

/**
 * A JSON response carrying a validator, so a poll that changed nothing costs a
 * header exchange instead of a payload.
 *
 * `GET /tasks` is polled every 2.5s by an open board and answers with the same
 * bytes almost every time; at 1.58 MB that was ~38 MB/min of unchanged data.
 * The body is serialised here rather than by `context.json` because the ETag has
 * to be a hash of the exact bytes that would be sent.
 *
 * `Cache-Control: no-cache` — store it, but never reuse it without asking. A
 * bare ETag with no cache directive lets a shared cache serve a stale board.
 */
const validated = (context: Context, payload: unknown): Response => {
  const body = JSON.stringify(payload);
  const tag = etagFor(body);
  const headers = { ETag: tag, "Cache-Control": "no-cache" };
  if (etagMatches(context.req.header("if-none-match"), tag)) return context.body(null, 304, headers);
  return context.body(body, 200, { ...headers, "Content-Type": "application/json; charset=UTF-8" });
};

const FILE_WRITE_LIMIT = 25 * 1024 * 1024;
class PayloadTooLargeError extends Error {}

const readBoundedBody = async (request: Request, limit: number): Promise<Buffer> => {
  const length = request.headers.get("Content-Length");
  if (length !== null && Number(length) > limit) throw new PayloadTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("File upload exceeds limit");
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
};

const fileErrorResponse = (context: Context, error: unknown): Response | undefined => {
  if (error instanceof PayloadTooLargeError) return context.json({ error: "File exceeds 25 MB upload limit" }, 413);
  if (error instanceof SymlinkError || error instanceof NotADirectoryError || error instanceof InvalidPathError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof NotFoundError) return context.json({ error: error.message }, 404);
  // 409, not 400: the request is well formed and the conflict is in the state of the
  // target, so the client may retry it once that state changes.
  if (error instanceof DirectoryNotEmptyError || error instanceof IsADirectoryError) {
    return context.json({ error: error.message }, 409);
  }
  return undefined;
};

const deleteRecursively = async (store: FileStore, path: string): Promise<void> => {
  const stat = await store.stat(path);
  if (!stat) throw new NotFoundError(`Path not found: ${path}`);
  if (stat.kind === "dir") {
    // entries(), not list(): list() hides symlinks, so they survived the walk, the final
    // rmdir failed ENOTEMPTY, and the tree was left half-destroyed and undeletable.
    for (const child of await store.entries(path)) {
      if (child.kind === "dir") await deleteRecursively(store, child.path);
      else await store.delete(child.path);
    }
  }
  await store.delete(path);
};

const SESSION_READ_LIMIT = 5 * 1024 * 1024;
const SESSION_BASE64_BODY_LIMIT = 34 * 1024 * 1024;
const sessionWriteInput = z.object({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});

const withoutUndefined = (value: object): Record<string, unknown> => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined),
);

const isPublic = (path: string, method: string): boolean =>
  path === "/" || path === "/health" || path === "/version" || method === "OPTIONS"
  || method === "POST" && /^\/hooks\/templates\/[^/]+$/.test(path);

const activeRunStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX];

type CancellationSettlement =
  | { error: string; code: 404 | 409 }
  | {
      runId: string; taskId: string | null; status: RunStatus; cancellationState: "acknowledged";
      requestId: string; releaseMergeLeaseTask: string | null;
    };

/** Terminalize one already-recorded cancellation intent. The Run row is the
 * race authority: completion and settlement both update it with mutually
 * exclusive predicates, so whichever commits first is the only terminal
 * writer. No retry or successor is created on this path. */
const settleCancellation = async (
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    requestId: string;
    now: Date;
    runnerId?: string;
    fencingToken?: string;
    actorId?: string;
    workspacePath?: string;
    branch?: string;
    baseSha?: string;
  },
): Promise<CancellationSettlement> => {
  await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${input.runId} FOR UPDATE`;
  const run = await tx.run.findUnique({
    where: { id: input.runId },
    select: {
      id: true, taskId: true, runNumber: true, status: true, runnerId: true, fencingToken: true,
      cancelRequestId: true, cancelReason: true, cancelAcknowledgedAt: true,
      session: { select: { id: true, waitingOnMessageId: true } },
    },
  });
  if (!run) return { error: "Run not found", code: 404 };
  if (run.cancelRequestId !== input.requestId) return { error: "Cancellation request does not match this Run", code: 409 };
  if (input.runnerId !== undefined && (run.runnerId !== input.runnerId || run.fencingToken !== input.fencingToken)) {
    return { error: "Cancellation acknowledgement is not owned by this runner", code: 409 };
  }
  if (run.status === RunStatus.CANCELLED) {
    // Reconciliation can settle an expired cancellation before the runner's
    // final ACK arrives. That ACK is still the only durable account of a
    // workspace provisioned before /start, so idempotence must backfill its
    // evidence instead of discarding it.
    if (input.workspacePath !== undefined) await tx.run.updateMany({
      where: { id: run.id, workspacePath: null }, data: { workspacePath: input.workspacePath },
    });
    if (input.branch !== undefined) await tx.run.updateMany({
      where: { id: run.id, branch: null }, data: { branch: input.branch },
    });
    if (input.baseSha !== undefined) await tx.run.updateMany({
      where: { id: run.id, baseSha: null }, data: { baseSha: input.baseSha },
    });
    if (!run.cancelAcknowledgedAt && input.runnerId !== undefined) {
      await tx.run.update({
        where: { id: run.id },
        data: { cancelAcknowledgedAt: input.now },
      });
      if (run.taskId) await tx.taskActivity.create({ data: {
        taskId: run.taskId,
        actorType: "runner",
        actorId: input.actorId ?? null,
        body: `Run ${run.runNumber} cancellation cleanup confirmed after terminalization`,
        metadata: { runId: run.id, requestId: input.requestId, status: RunStatus.CANCELLED },
      } });
    } else if (!run.cancelAcknowledgedAt) {
      return { error: "Cancellation cleanup has not been acknowledged by the runner", code: 409 };
    }
    // The terminal writer that got here first already released the lease; a
    // later acknowledgement of the same cancellation has nothing left to free.
    return {
      runId: run.id, taskId: run.taskId, status: run.status, cancellationState: "acknowledged",
      requestId: input.requestId, releaseMergeLeaseTask: null,
    };
  }
  if (run.taskId) await lockTaskMutationRows(tx, run.taskId);
  const settled = await tx.run.updateMany({
    where: {
      id: run.id,
      cancelRequestId: input.requestId,
      status: { in: [RunStatus.QUEUED, ...activeRunStatuses] },
      ...(input.runnerId === undefined ? {} : { runnerId: input.runnerId, fencingToken: input.fencingToken }),
    },
    data: {
      status: RunStatus.CANCELLED,
      endedAt: input.now,
      leaseExpiresAt: null,
      sessionTokenRevokedAt: input.now,
      cancelAcknowledgedAt: input.now,
      failureClass: FailureClass.CANCELLED_OR_TIMED_OUT,
      failureReason: run.cancelReason ?? "Cancelled by operator",
      terminationReason: run.cancelReason ?? "Cancelled by operator",
      retryable: false,
      retryAt: null,
      workspaceRetained: true,
      ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
    },
  });
  if (settled.count !== 1) return { error: `Run is already ${run.status}`, code: 409 };
  await tx.session.updateMany({
    where: { runId: run.id },
    data: {
      executionStatus: SessionExecutionStatus.CANCELLED,
      cleanupStatus: CleanupStatus.RETAINED,
      endedAt: input.now,
      cleanupEndedAt: input.now,
      failureReason: run.cancelReason ?? "Cancelled by operator",
      terminationReason: run.cancelReason ?? "Cancelled by operator",
    },
  });
  if (run.session?.waitingOnMessageId) {
    await tx.inboxMessage.updateMany({
      where: { id: run.session.waitingOnMessageId, status: InboxStatus.OPEN },
      data: { status: InboxStatus.CLOSED },
    });
  }
  if (run.taskId) {
    const reason = run.cancelReason ?? "Cancelled by operator";
    await tx.task.updateMany({
      where: { id: run.taskId, status: { in: [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] } },
      data: { status: TaskStatus.REVIEW, failureReason: reason },
    });
    await tx.taskActivity.create({ data: {
      taskId: run.taskId,
      actorType: input.actorId ? "runner" : "control-plane",
      actorId: input.actorId ?? null,
      body: `Run ${run.runNumber} cancellation acknowledged; execution authority revoked and evidence retained`,
      metadata: { runId: run.id, requestId: input.requestId, status: RunStatus.CANCELLED },
    } });
  }
  // Cancellation never creates a retry or a successor, so a cancelled chain-tail
  // run is the chain's last word: whatever lease it was holding is now stranded
  // until a machine steals it 45 minutes later. Release it instead.
  return {
    runId: run.id, taskId: run.taskId, status: RunStatus.CANCELLED, cancellationState: "acknowledged",
    requestId: input.requestId, releaseMergeLeaseTask: await mergeTailLeaseChainId(tx, run.taskId),
  };
};

type LockedTask = {
  id: string;
  status: TaskStatus;
  archivedAt: Date | null;
  projectId: string;
  chainId: string | null;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  templateStep: {
    stepIndex: number;
    outputKind: string;
    taskTemplate: { name: string };
  } | null;
};

/** Live means exactly what blocks an agent's archival: the same
 *  `LIVE_TASK_STATUSES` `agentArchiveBlocker` reads, so the two halves of the
 *  protocol cannot drift into disagreeing about which tasks count. Everything
 *  else — DONE and BACKLOG — is history or a parking bay, which is why moving
 *  out of it is the moment the assignee has to be re-validated. */
const isLiveStatus = (status: TaskStatus): boolean => LIVE_TASK_STATUSES.includes(status);

const lockedTaskSelect = {
  id: true,
  status: true,
  archivedAt: true,
  projectId: true,
  chainId: true,
  assigneeType: true,
  assigneeAgentId: true,
  templateStep: {
    select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
  },
} satisfies Prisma.TaskSelect;

/**
 * The exclusion protocol every writer that can give a task a run shares.
 *
 * Start, retry, archive, archive-done and the AT fire all answer "may this task
 * gain a run right now?" in different transactions. Reading `runs` and then
 * writing is not atomic under ReadCommitted: PostgreSQL re-checks a predicate on
 * the *locked row* after a blocking write commits, but a subquery over another
 * table is re-evaluated against the statement's original snapshot. So the Task
 * row is the mutex — every writer takes it before it reads anything else.
 *
 * `fireCronTask` is already compliant: its claim is a single-statement CAS on
 * the Task row, whose predicate does get re-checked.
 */
const lockTask = async (tx: Prisma.TransactionClient, taskId: string): Promise<LockedTask | null> => {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  if (!locked) return null;
  // Read the typed row only after the lock is held. $queryRaw hands back raw
  // PostgreSQL enum labels ('backlog'), not Prisma's member names, so comparing
  // its status against TaskStatus.BACKLOG silently never matches — and the lock
  // is exactly what makes this second read consistent for the rest of the
  // transaction.
  return tx.task.findUniqueOrThrow({
    where: { id: taskId },
    select: lockedTaskSelect,
  });
};

/**
 * The mutation entry point for a task whose chain identity is not already
 * known under a lock. Chain identity itself is immutable after dispatch, so an
 * unlocked identity read can safely choose the mutex without first taking one
 * Task row and later expanding to its siblings.
 */
const lockTaskMutationRows = async (
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<LockedTask | null> => {
  const identity = await tx.task.findUnique({
    where: { id: taskId },
    select: { projectId: true, chainId: true },
  });
  if (!identity) return null;
  if (!identity.chainId) return lockTask(tx, taskId);
  await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
  return tx.task.findUnique({ where: { id: taskId }, select: lockedTaskSelect });
};

/**
 * Merge-tail repair markers point at an existing canonical task rather than a
 * linked-list successor. Queue that explicit target under the same layer mutex
 * as ordinary chain activation; readiness remains server-owned and is only
 * marked queued for its worker.
 */
const activateMergeTailTarget = async (
  tx: Prisma.TransactionClient,
  taskId: string,
  now: Date,
): Promise<void> => {
  const identity = await tx.task.findUnique({ where: { id: taskId }, select: { projectId: true, chainId: true } });
  if (!identity) return;
  if (identity.chainId) await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
  else if (!await lockTask(tx, taskId)) return;
  const target = await tx.task.findUnique({
    where: { id: taskId },
    include: {
      runs: { where: { status: { in: ACTIVE_RUN_STATUSES } }, take: 1 },
      assigneeAgent: { select: { name: true, archivedAt: true } },
      templateStep: { include: { taskTemplate: { select: { name: true } } } },
    },
  });
  if (!target || target.status === TaskStatus.DONE || target.runs.length > 0) return;
  if (target.archivedAt) {
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge-tail target is archived and was not queued",
    } });
    return;
  }
  if (isMergeReadinessStep(target.templateStep)) {
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: "Merge-tail readiness target queued for server worker",
      metadata: { kind: MERGE_TAIL_KIND.readiness, schemaVersion: 1, state: "queued" },
    } });
    return;
  }
  if (target.assigneeAgent?.archivedAt) {
    const reason = `Assignee ${target.assigneeAgent.name} is archived; unarchive the agent and retry to queue this merge-tail target`;
    await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: `Merge-tail target not queued because assignee ${target.assigneeAgent.name} is archived`,
    } });
    return;
  }
  const claimed = await tx.task.updateMany({
    where: { id: taskId, status: { in: [TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] } },
    data: { status: TaskStatus.TODO, failureReason: null },
  });
  if (claimed.count !== 1) return;
  const rawTx = tx as Prisma.TransactionClient & { $executeRawUnsafe?: (query: string) => Promise<number> };
  const savepoint = "merge_tail_enqueue";
  const hasSavepoint = typeof rawTx.$executeRawUnsafe === "function";
  if (hasSavepoint) await rawTx.$executeRawUnsafe!(`SAVEPOINT ${savepoint}`);
  try {
    await enqueueTaskRun(tx, taskId, now);
    if (hasSavepoint) await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error: unknown) {
    if (hasSavepoint) {
      await rawTx.$executeRawUnsafe!(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await rawTx.$executeRawUnsafe!(`RELEASE SAVEPOINT ${savepoint}`);
    }
    const duplicateRun = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
    if (!isArchivedAssigneeError(error) && !isArchivedTaskError(error)
      && !isIntegratorStoppedError(error) && !duplicateRun) throw error;
    if (duplicateRun) {
      await tx.taskActivity.create({ data: {
        taskId,
        actorType: "control-plane",
        body: "Merge-tail target already has the run created by a concurrent activation",
      } });
      return;
    }
    await tx.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.REVIEW, failureReason: error instanceof Error ? error.message : "Merge-tail target could not be queued" },
    });
    await tx.taskActivity.create({ data: {
      taskId,
      actorType: "control-plane",
      body: `Merge-tail target was not queued: ${error instanceof Error ? error.message : "enqueue refused"}`,
    } });
    return;
  }
  await tx.taskActivity.create({ data: {
    taskId,
    actorType: "control-plane",
    body: "Merge-tail target queued",
  } });
};

/** Locks a whole candidate set in one statement. `ORDER BY "id"` is not
 *  decoration: it is what stops two concurrent Archive All presses from
 *  deadlocking against each other.
 *
 *  The scope predicates are re-stated here rather than trusted from the
 *  unlocked selection above: `FOR UPDATE` re-evaluates its own `WHERE` against
 *  the row version it waited for, so a task dragged back out of `Done` between
 *  selection and lock drops out of the result instead of being archived out
 *  from under the operator who moved it. */
const lockDoneTasks = async (
  tx: Prisma.TransactionClient,
  projectId: string,
  taskIds: string[],
): Promise<string[]> => {
  if (taskIds.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task"
    WHERE "id" = ANY(${taskIds})
      AND "archivedAt" IS NULL
      AND "projectId" = ${projectId}
      AND "status" = 'done'::"TaskStatus"
    ORDER BY "id" FOR UPDATE
  `;
  return rows.map((row) => row.id);
};

const hasActiveRun = async (tx: Prisma.TransactionClient, taskId: string): Promise<boolean> => (
  await tx.run.count({ where: { taskId, status: { in: ACTIVE_RUN_STATUSES } } })
) > 0;

/**
 * The assignment half of the Agent-row exclusion protocol: the 400 message if
 * this agent may not be written onto a task right now, or null.
 *
 * Callers check the assignee once before the transaction to answer fast; this
 * re-read under `lockAgentRow` is the one that decides. Without it the check
 * and the write straddle a concurrent archive, and the task — or the run
 * created with it — belongs to an agent the runner will never claim for.
 */
const assignmentBlocked = async (
  tx: Prisma.TransactionClient,
  assignee: { id: string; name: string } | null,
): Promise<string | null> => {
  if (!assignee) return null;
  const locked = await lockAgentRow(tx, assignee.id);
  if (!locked) return "Assignee does not belong to this project";
  return locked.archivedAt ? `Assignee ${assignee.name} is archived` : null;
};

/** Rechecks the compound binding after the Task lock and under the Agent lock.
 * The unlocked route check gives a fast refusal; this one decides against
 * concurrent archive or persisted-state corruption before the write commits. */
const assertCompoundImplementationAssignment = async (
  tx: Prisma.TransactionClient,
  task: LockedTask,
  assigneeType: AssigneeType,
  assigneeAgentId: string | null,
): Promise<void> => {
  if (task.archivedAt !== null || !isCompoundImplementationStep(task.templateStep)) return;
  const agent = assigneeAgentId ? await lockAgentRow(tx, assigneeAgentId) : null;
  if (!compoundImplementationAssigneeValid(task.projectId, assigneeType, agent, task.templateStep)) {
    throw new CompoundImplementationAssigneeError();
  }
};

/**
 * The reactivation half of the same protocol: the message if this *stored*
 * assignee may not own a live task right now, or null.
 *
 * `assignmentBlocked` only ever sees an assignee the request named, so a
 * request that carries no `assigneeAgentId` — a status-only promotion out of
 * Backlog, an unarchive — used to skip the Agent row entirely and hand a live
 * task back to an archived agent. The runner claims only unarchived TODO|DOING
 * tasks whose agent is unarchived, so that task is not "assigned": it is stuck,
 * on a board that shows it as work in progress.
 *
 * Called with the Task row already locked, so the order stays the one global
 * order: Task row first, Agent row second. The name is read outside the Agent
 * lock because it only decorates the message; `lockAgentRow` is what decides.
 */
const reactivationBlocked = async (
  tx: Prisma.TransactionClient,
  task: { projectId: string; assigneeAgentId: string | null },
): Promise<string | null> => {
  // A human step or an unassigned one has no agent to be archived, so it
  // reactivates exactly as it did before this guard existed.
  if (task.assigneeAgentId === null) return null;
  const assignee = await tx.agent.findFirst({
    where: { id: task.assigneeAgentId, projectId: task.projectId },
    select: { id: true, name: true },
  });
  if (!assignee) return "Assignee does not belong to this project";
  const locked = await lockAgentRow(tx, assignee.id);
  if (!locked) return "Assignee does not belong to this project";
  // The sentence names the two ways out, because the operator who pressed this
  // did not name the assignee in the request and cannot see it in the error.
  return locked.archivedAt
    ? `Assignee ${assignee.name} is archived; unarchive the agent or reassign this task first`
    : null;
};

/** `{archived, skipped}` from a candidate set and the ids that turned out busy.
 *  Extracted so the partitioning is unit-testable without a database. */
export const partitionArchivable = (
  candidateIds: string[],
  busyIds: string[],
): { archive: string[]; skipped: number } => {
  const busy = new Set(busyIds);
  const archive = candidateIds.filter((taskId) => !busy.has(taskId));
  return { archive, skipped: candidateIds.length - archive.length };
};

const secretPublicSelect = {
  id: true,
  name: true,
  purpose: true,
  description: true,
  ciphertextVersion: true,
  keyId: true,
  rotatedAt: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SecretSelect;

const goalInclude = {
  definitionOfDone: { orderBy: { itemIndex: "asc" as const } },
  progressLog: { orderBy: { createdAt: "asc" as const } },
};

export const createApp = (db: PrismaClient, options: LiveAppOptions): Hono<AppEnvironment> => {
  const app = new Hono<AppEnvironment>();
  const releaseChainLease = options.releaseMergeLease ?? releaseMergeLease;
  const noteArchivedQueuedRunsOnClaim = createArchivedRunNoticeScheduler(db);
  const runners = createRunnerRegistry();
  // Authentication circuits are global backend state, so only one daemon must
  // perform a recovery check. This short in-process lease prevents every idle
  // daemon from invoking the same provider login command on each heartbeat.
  // `lastPreflightAt` remains the durable retry clock, so an API restart may
  // reassign an overdue check without changing what that timestamp means.
  const preflightRecoveryLeases = new Map<RunnerKind, number>();
  const preflightRecoveryIntervalMs = 5 * 60_000;

  // The supported browser path is same-origin through the Vite proxy, so this
  // allowlist is a boundary rather than a transport: it decides which *other*
  // origin may read a control-plane response out of a browser. It was `*`, which
  // is the one value that makes that boundary vacuous. Public `/` and `/health`
  // and every authenticated route are unaffected — CORS decides what a browser
  // may read, and the principal check below still decides what is served.
  app.use("*", cors({
    origin: [...LOOPBACK_BROWSER_ORIGINS],
    allowHeaders: ["Authorization", "Content-Type", "X-Fencing-Token", "X-AgentOS-Webhook-Secret", "X-AgentOS-Delivery-Id"],
  }));
  // The second, independent half of that boundary (review S-2). CORS decides
  // what a browser may *read*; it lets the request run and commit its side
  // effect regardless. So a foreign `Origin` is refused here, before auth and
  // before any handler, rather than leaving the dev server's proxy guard as the
  // only barrier — which is the arrangement S-1 broke. The predicate is in
  // `local-origin.ts`, with the reason it matches by shape rather than against
  // the two-entry allowlist above.
  //
  // Preflights never reach this: `cors` answers OPTIONS above and returns.
  app.use("*", async (context, next) => {
    if (!originMayReachHandlers(context.req.header("Origin"))) return context.json({ error: "Forbidden origin" }, 403);
    await next();
  });
  app.use("*", async (context, next) => {
    if (isPublic(context.req.path, context.req.method)) {
      context.set("principal", { kind: "public" });
      await next();
      return;
    }
    const principal = await authenticate(db, context.req.header("Authorization"));
    if (!principal) return context.json({ error: "Unauthorized" }, 401);
    if (!principalMayAccess(principal, context.req.path)) return context.json({ error: "Forbidden for principal" }, 403);
    context.set("principal", principal);
    await next();
  });

  app.get("/", (context) => context.json({ name: "AgentOS control plane", phase: "execution-kernel" }));
  app.get("/health", async (context) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return context.json({ status: "ok", database: "connected", checkedAt: new Date().toISOString() });
    } catch (error: unknown) {
      console.error("Health check failed", error);
      return context.json({ status: "error", database: "disconnected", checkedAt: new Date().toISOString() }, 503);
    }
  });
  // Provenance, not status: which commit this dist was built from (issue #140).
  // Unauthenticated and free of state so that whoever is checking whether a
  // restart took the new build can ask the running process directly instead of
  // hashing artefacts by hand, which is what the 2026-08-17 incident cost.
  app.get("/version", (context) => context.json(versionPayload()));
  app.get("/runners", async (context) => {
    const now = new Date();
    const daemons = runners.snapshot(now);
    const knownIds = daemons.map((daemon) => daemon.runnerId);
    const [storedBackends, activeGroups] = await Promise.all([
      db.runnerBackendState.findMany(),
      knownIds.length === 0 ? [] : db.run.groupBy({
        by: ["runnerId"],
        where: { status: { in: activeRunStatuses }, runnerId: { in: knownIds } },
        _count: { _all: true },
      }),
    ]);
    const activeByRunner = new Map(activeGroups.map((group) => [group.runnerId, group._count._all]));
    const backendsByRunner = new Map(storedBackends.map((backend) => [backend.runner, backend]));
    return context.json({
      checkedAt: now.toISOString(),
      online: daemons.filter((daemon) => daemon.online).length,
      total: daemons.length,
      daemons: daemons.map((daemon) => {
        const activeRuns = activeByRunner.get(daemon.runnerId) ?? 0;
        return { ...daemon, lastSeenAt: daemon.lastSeenAt.toISOString(), busy: activeRuns > 0, activeRuns };
      }),
      backends: Object.values(RunnerKind).map((runner) => {
        const backend = backendsByRunner.get(runner);
        const availability = readStoredCliAvailability(backend?.capabilities);
        return {
          runner,
          cliVersion: backend?.cliVersion ?? null,
          cliAvailable: availability?.available ?? null,
          cliResolvedPath: availability?.resolvedPath ?? null,
          cliAvailabilityReason: availability?.reason ?? null,
          cliUnavailableSince: availability?.unavailableSince ?? null,
          lastAvailabilityAt: availability?.lastCheckedAt ?? null,
          authMode: backend?.authMode ?? null,
          lastPreflightAt: backend?.lastPreflightAt?.toISOString() ?? null,
          lastPreflightOk: backend?.lastPreflightOk ?? null,
          circuitOpen: backend?.circuitOpen ?? null,
          circuitReason: backend?.circuitReason ?? null,
        };
      }),
    });
  });

  app.use("/hooks/templates/:templateId", bodyLimit({
    maxSize: 1024 * 1024,
    onError: (context) => context.json({ error: "Payload too large" }, 413),
  }));
  app.post("/hooks/templates/:templateId", async (context) => {
    const template = await authenticateWebhook(
      db,
      id.parse(context.req.param("templateId")),
      context.req.header("X-AgentOS-Webhook-Secret"),
    );
    if (!template) return context.json({ error: "Unauthorized" }, 401);
    // The body is read exactly once, as text: the replay key hashes the raw
    // bytes, and a Request body cannot be consumed twice.
    const raw = await context.req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return context.json({ error: "Invalid JSON payload" }, 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return context.json({ error: "Webhook payload must be an object" }, 400);
    }
    const window = template.webhookReplayWindowSec ?? 0;
    const dedupeKey = window > 0
      ? context.req.header("X-AgentOS-Delivery-Id") ?? createHash("sha256").update(raw).digest("hex")
      : null;
    if (dedupeKey) {
      const seen = await db.triggerFire.findFirst({
        where: { templateId: template.id, dedupeKey, createdAt: { gt: new Date(Date.now() - window * 1000) } },
        orderBy: { createdAt: "desc" },
        select: { chainId: true },
      });
      // A redelivery is not an error: the sender did what it was told to do.
      if (seen) return context.json({ duplicate: true, chainId: seen.chainId }, 200);
    }
    const resolved = resolvePayloadVariables(template, payload as Record<string, unknown>);
    if ("unresolved" in resolved) return context.json({ error: "Unresolved template variables", unresolved: resolved.unresolved }, 400);
    try {
      const result = await instantiateTemplate(db, template.projectId, template.id, {
        repoId: template.webhookRepoId!, variables: resolved.variables, autoStart: true,
      }, {
        actorType: "webhook",
        activityMetadata: { webhookTemplateId: template.id, firedAt: new Date().toISOString() },
        source: TaskSource.WEBHOOK,
        fire: { source: TriggerFireSource.WEBHOOK, dedupeKey },
      });
      return context.json({ chainId: result.chainId, taskIds: result.tasks.map((task) => task.id) }, 201);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        return context.json({ error: "Webhook instantiation is busy; retry later" }, 503);
      }
      if (isTemplateInputError(error)) return context.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.get("/files", async (context) => {
    try {
      return context.json(await (await getFileStore()).list(context.req.query("dir") ?? ""));
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });
  app.get("/files/content", async (context) => {
    const path = context.req.query("path") ?? "";
    try {
      const content = await (await getFileStore()).read(path);
      return context.body(new Uint8Array(content), 200, {
        "Content-Type": getMimeType(path) ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) ?? "file")}`,
      });
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });
  app.put("/files/content", async (context) => {
    try {
      const content = await readBoundedBody(context.req.raw, FILE_WRITE_LIMIT);
      return context.json(await (await getFileStore()).write(context.req.query("path") ?? "", content));
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });
  app.post("/files/mkdir", async (context) => {
    try {
      const { path } = await readJson(context.req.raw, z.object({ path: z.string() }));
      await (await getFileStore()).mkdir(path);
      return context.json({ ok: true });
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });
  app.post("/files/move", async (context) => {
    try {
      const { from, to } = await readJson(context.req.raw, z.object({ from: z.string(), to: z.string() }));
      await (await getFileStore()).move(from, to);
      return context.json({ ok: true });
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });
  app.delete("/files", async (context) => {
    try {
      const store = await getFileStore();
      const path = context.req.query("path") ?? "";
      if (context.req.query("recursive") === "true") await deleteRecursively(store, path);
      else await store.delete(path);
      return context.json({ ok: true });
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  // First-run onboarding (OSS-B0 Step 4). Two routes, both operator-only: the
  // principal middleware already denies runner and session principals every path
  // outside their own prefix, and the explicit check states the requirement at
  // the route that depends on it rather than leaving it implied by a table in
  // auth.ts. Everything these routes decide lives in onboarding.ts.
  app.get("/onboarding", async (context) => {
    if (context.get("principal").kind !== "operator") return context.json({ error: "Forbidden for principal" }, 403);
    return context.json(await onboardingStatus(db));
  });
  app.post("/onboarding", async (context) => {
    if (context.get("principal").kind !== "operator") return context.json({ error: "Forbidden for principal" }, 403);
    const input = await readJson(context.req.raw, onboardingInput);
    try {
      await (options.onboardingRepositoryPreflight ?? preflightOnboardingRepository)(input);
    } catch (error: unknown) {
      if (error instanceof RepositoryPreflightError) {
        return context.json({ error: "Repository preflight failed", code: "repository-preflight-failed", reason: error.reason }, 422);
      }
      throw error;
    }
    const result = await createStarterInstallation(db, input);
    // 409, not 400 or a silent success: the request was well formed, the state of
    // the target is what refuses it, and the caller recovers by reading GET
    // /onboarding rather than by editing anything. A committed-but-lost response
    // lands here too, which is why the code is stable and the rows are untouched.
    if (!result.ok) return context.json({ error: "An installation already exists", code: result.code }, 409);
    return context.json(result.installation, 201);
  });

  app.get("/projects", async (context) => context.json(await db.project.findMany({ orderBy: { createdAt: "asc" } })));
  app.post("/projects", async (context) => context.json(await db.project.create({ data: await readJson(context.req.raw, projectInput) }), 201));
  app.get("/projects/:projectId", async (context) => {
    const project = await db.project.findUnique({ where: { id: id.parse(context.req.param("projectId")) } });
    return project ? context.json(project) : context.json({ error: "Project not found" }, 404);
  });
  app.patch("/projects/:projectId", async (context) => context.json(await db.project.update({
    where: { id: id.parse(context.req.param("projectId")) },
    data: withoutUndefined(await readJson(context.req.raw, projectPatch)) as Prisma.ProjectUpdateInput,
  })));
  app.delete("/projects/:projectId", async (context) => {
    await db.project.delete({ where: { id: id.parse(context.req.param("projectId")) } });
    return context.body(null, 204);
  });

  app.get("/projects/:projectId/environments", async (context) => context.json(await db.environment.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })));
  app.post("/projects/:projectId/environments", async (context) => context.json(await db.environment.create({
    data: { projectId: id.parse(context.req.param("projectId")), ...await readJson(context.req.raw, environmentInput) },
  }), 201));
  app.get("/environments/:environmentId", async (context) => {
    const environment = await db.environment.findUnique({
      where: { id: id.parse(context.req.param("environmentId")) },
      include: { secrets: { include: { secret: { select: secretPublicSelect } } } },
    });
    return environment ? context.json(environment) : context.json({ error: "Environment not found" }, 404);
  });
  app.patch("/environments/:environmentId", async (context) => context.json(await db.environment.update({
    where: { id: id.parse(context.req.param("environmentId")) },
    data: withoutUndefined(await readJson(context.req.raw, environmentPatch)),
  })));
  app.delete("/environments/:environmentId", async (context) => {
    await db.environment.delete({ where: { id: id.parse(context.req.param("environmentId")) } });
    return context.body(null, 204);
  });

  app.get("/secrets", async (context) => context.json(await db.secret.findMany({
    select: {
      ...secretPublicSelect,
      agentGrants: { include: { agent: { select: { id: true, name: true, title: true, projectId: true } } } },
    },
    orderBy: { createdAt: "asc" },
  })));
  app.post("/secrets", async (context) => {
    const body = await readJson(context.req.raw, secretInput);
    const secret = await db.secret.create({
      data: {
        name: body.name,
        purpose: body.purpose,
        description: body.description,
        encryptedValue: encryptSecret(body.value),
      },
      select: secretPublicSelect,
    });
    return context.json(secret, 201);
  });
  app.get("/secrets/:secretId", async (context) => {
    const secret = await db.secret.findUnique({
      where: { id: id.parse(context.req.param("secretId")) },
      select: {
        ...secretPublicSelect,
        agentGrants: { include: { agent: { select: { id: true, name: true, title: true, projectId: true } } } },
      },
    });
    return secret ? context.json(secret) : context.json({ error: "Secret not found" }, 404);
  });
  app.patch("/secrets/:secretId", async (context) => {
    const body = await readJson(context.req.raw, secretPatch);
    const { value, ...fields } = body;
    return context.json(await db.secret.update({
      where: { id: id.parse(context.req.param("secretId")) },
      data: {
        ...withoutUndefined(fields),
        ...(value === undefined ? {} : { encryptedValue: encryptSecret(value), rotatedAt: new Date() }),
      },
      select: secretPublicSelect,
    }));
  });
  app.delete("/secrets/:secretId", async (context) => {
    await db.secret.delete({ where: { id: id.parse(context.req.param("secretId")) } });
    return context.body(null, 204);
  });

  // §D-P4. The sentinel Agent row exists so step 12 can carry a non-null
  // `Run.agentId`; it is not something an operator may assign. It is returned
  // rather than hidden so an operator can still see that it exists and read its
  // role prompt, but `assignable: false` is what the pickers filter on — and
  // `POST /projects/:projectId/tasks` refuses it regardless of any client.
  app.get("/projects/:projectId/agents", async (context) => context.json((await db.agent.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })).map((agent) => {
    const mechanical = agent.name === INTEGRATOR_AGENT_NAME;
    return { ...agent, mechanical, assignable: !mechanical };
  })));
  app.post("/projects/:projectId/agents", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, agentInput);
    const modelRefusal = runnerModelRefusal(body);
    if (modelRefusal) return context.json({ error: modelRefusal }, 400);
    const executionerRefusal = executionerRuntimeRefusal(body);
    if (executionerRefusal) return context.json({ error: executionerRefusal }, 400);
    const tierRefusal = codexServiceTierRefusal(body);
    if (tierRefusal) return context.json({ error: tierRefusal }, 400);
    const environment = await db.environment.findFirst({ where: { id: body.environmentId, projectId } });
    if (!environment) return context.json({ error: "Environment does not belong to this project" }, 400);
    const foundationalPrompt = body.foundationalPrompt ?? (await db.agent.findFirst({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: { foundationalPrompt: true },
    }))?.foundationalPrompt;
    if (foundationalPrompt === undefined) {
      return context.json({ error: "This project has no foundation yet. Run npm run db:seed." }, 400);
    }
    return context.json(await db.agent.create({ data: { ...body, foundationalPrompt, projectId } }), 201);
  });
  app.get("/agents/:agentId", async (context) => {
    const agent = await db.agent.findUnique({
      where: { id: id.parse(context.req.param("agentId")) },
      include: {
        environment: true,
        skills: { include: { skill: true } },
        mcpConnections: { include: { mcpConnection: true } },
        repoAccess: { include: { repo: true } },
        secretGrants: { include: { secret: { select: secretPublicSelect } } },
        filesystemGrants: true,
        collaborators: { include: { allowedAgent: true } },
      },
    });
    return agent ? context.json(agent) : context.json({ error: "Agent not found" }, 404);
  });
  app.patch("/agents/:agentId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, agentPatch);
    const result = await db.$transaction(async (tx) => {
      const before = await lockAgentRow(tx, agentId);
      if (!before) return { error: "Agent not found", code: 404 as const };
      const patch = withoutUndefined(body);
      const merged = { ...before, ...patch };
      if (before.name === "implementation-plan-executioner" && merged.name !== before.name) {
        return { error: "implementation-plan-executioner is a canonical Agent name and cannot be changed", code: 400 as const };
      }
      const modelRefusal = runnerModelRefusal(merged);
      if (modelRefusal) return { error: modelRefusal, code: 400 as const };
      const executionerRefusal = executionerRuntimeRefusal(merged);
      if (executionerRefusal) return { error: executionerRefusal, code: 400 as const };
      const tierRefusal = codexServiceTierRefusal(merged);
      if (tierRefusal) return { error: tierRefusal, code: 400 as const };
      if (body.environmentId) {
        const environment = await tx.environment.findFirst({ where: { id: body.environmentId, projectId: before.projectId } });
        if (!environment) return { error: "Environment does not belong to this project", code: 400 as const };
      }
      return { agent: await tx.agent.update({
        where: { id: agentId },
        data: {
          ...patch,
          ...((body.model !== undefined && body.model !== before.model)
            || (body.runnerPreference !== undefined && body.runnerPreference !== before.runnerPreference)
            ? { runtimeConfigCustomized: true }
            : {}),
        } as Prisma.AgentUncheckedUpdateInput,
      }) };
    });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.agent);
  });
  app.delete("/agents/:agentId", async (context) => {
    try {
      await db.agent.delete({ where: { id: id.parse(context.req.param("agentId")) } });
      return context.body(null, 204);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        return context.json({ error: "Agent has task history; archive it instead" }, 409);
      }
      throw error;
    }
  });
  // Archive is one side of the Agent-row exclusion protocol (see lockAgentRow).
  // It takes the same mutex every assignment and run writer takes, and inside it
  // it fails closed: an agent with a live task or run reference stays unarchived
  // rather than stranding work nothing will ever claim. Re-archiving an already
  // archived agent stays idempotent and keeps the original timestamp.
  app.post("/agents/:agentId/archive", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      const locked = await lockAgentRow(tx, agentId);
      if (!locked) return { error: "Agent not found", code: 404 as const };
      const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId } });
      if (agent.archivedAt) return { agent };
      const blocker = await agentArchiveBlocker(tx, agentId);
      if (blocker) return { error: blocker, code: 409 as const };
      return { agent: await tx.agent.update({ where: { id: agentId }, data: { archivedAt: now } }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    // Unchanged sweep: rows archived before this protocol existed — or queued by
    // a writer that committed first — still get their explanatory activity.
    await noteArchivedQueuedRuns(db, { agentId });
    return context.json(result.agent);
  });
  app.post("/agents/:agentId/unarchive", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent) return context.json({ error: "Agent not found" }, 404);
    if (!agent.archivedAt) return context.json(agent);
    return context.json(await db.agent.update({
      where: { id: agentId },
      data: { archivedAt: null },
    }));
  });

  app.get("/agents/:agentId/secret-grants", async (context) => context.json(await db.agentSecretGrant.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) },
    include: { secret: { select: secretPublicSelect } },
    orderBy: { envVar: "asc" },
  })));
  app.post("/agents/:agentId/secret-grants", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, secretGrantInput);
    if (["OPERATOR_TOKEN", "RUNNER_TOKEN", "AGENTOS_API_TOKEN", "AGENTOS_SESSION_TOKEN", "AGENTOS_FENCING_TOKEN"].includes(body.envVar)) {
      return context.json({ error: `Secret grant may not override reserved principal variable ${body.envVar}` }, 400);
    }
    const [agent, secret] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { id: true } }),
      db.secret.findFirst({ where: { id: body.secretId, disabledAt: null }, select: { id: true } }),
    ]);
    if (!agent || !secret) return context.json({ error: "Agent or available Secret not found" }, 404);
    return context.json(await db.agentSecretGrant.upsert({
      where: { agentId_envVar: { agentId, envVar: body.envVar } },
      create: { agentId, ...body },
      update: { secretId: body.secretId },
    }), 201);
  });
  app.delete("/agents/:agentId/secret-grants/:secretId/:envVar", async (context) => {
    await db.agentSecretGrant.delete({ where: { agentId_secretId_envVar: {
      agentId: id.parse(context.req.param("agentId")),
      secretId: id.parse(context.req.param("secretId")),
      envVar: z.string().min(1).parse(context.req.param("envVar")),
    } } });
    return context.body(null, 204);
  });

  app.get("/agents/:agentId/filesystem-grants", async (context) => context.json(await db.filesystemGrant.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) }, orderBy: { folderPath: "asc" },
  })));
  /**
   * Two spellings of one physical folder must not become two grants. On a case- and
   * normalization-insensitive volume `protected` and `Protected` are the same directory,
   * so a read-only grant on one plus a writable grant on the other is read-write on that
   * directory -- and the console renders the two rows identically, so nobody sees it.
   */
  const aliasingGrant = async (agentId: string, folderPath: string, exclude?: string): Promise<string | null> => {
    const key = await filesRootGrantKey(normalizeRelPath(folderPath));
    if (key === null) return null;
    const existing = await db.filesystemGrant.findMany({ where: { agentId } });
    for (const grant of existing) {
      if (grant.folderPath === folderPath || grant.id === exclude) continue;
      let other: string | null;
      try {
        other = await filesRootGrantKey(normalizeRelPath(grant.folderPath));
      } catch {
        continue;
      }
      if (other !== null && other === key) return grant.folderPath;
    }
    return null;
  };
  const aliasConflict = (context: Context, folderPath: string, existing: string): Response => context.json({
    error: `folderPath "${folderPath}" resolves to the same folder as the existing grant "${existing}"; edit that grant instead`,
  }, 409);

  app.post("/agents/:agentId/filesystem-grants", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, filesystemGrantInput);
    const aliased = await aliasingGrant(agentId, body.folderPath);
    if (aliased !== null) return aliasConflict(context, body.folderPath, aliased);
    return context.json(await db.filesystemGrant.upsert({
      where: { agentId_folderPath: { agentId, folderPath: body.folderPath } },
      create: { agentId, ...body },
      update: body,
    }), 201);
  });
  app.patch("/agents/:agentId/filesystem-grants/:grantId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const grantId = id.parse(context.req.param("grantId"));
    const existing = await db.filesystemGrant.findFirst({ where: { id: grantId, agentId } });
    if (!existing) return context.json({ error: "Filesystem grant not found" }, 404);
    const patch = await readJson(context.req.raw, filesystemGrantPatch);
    if (patch.folderPath !== undefined) {
      const aliased = await aliasingGrant(agentId, patch.folderPath, grantId);
      if (aliased !== null) return aliasConflict(context, patch.folderPath, aliased);
    }
    return context.json(await db.filesystemGrant.update({
      where: { id: grantId },
      data: withoutUndefined(patch) as Prisma.FilesystemGrantUncheckedUpdateInput,
    }));
  });
  app.delete("/agents/:agentId/filesystem-grants/:grantId", async (context) => {
    const deleted = await db.filesystemGrant.deleteMany({ where: {
      id: id.parse(context.req.param("grantId")), agentId: id.parse(context.req.param("agentId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Filesystem grant not found" }, 404);
  });

  app.post("/agents/:agentId/collaborators", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { allowedAgentId } = await readJson(context.req.raw, collaboratorInput);
    if (agentId === allowedAgentId) return context.json({ error: "An agent cannot collaborate with itself" }, 400);
    const agents = await db.agent.findMany({ where: { id: { in: [agentId, allowedAgentId] } }, select: { id: true, projectId: true } });
    if (agents.length !== 2) return context.json({ error: "Agent or collaborator not found" }, 404);
    if (agents[0]!.projectId !== agents[1]!.projectId) return context.json({ error: "Collaborators belong to different projects" }, 400);
    return context.json(await db.agentCollaboration.upsert({
      where: { agentId_allowedAgentId: { agentId, allowedAgentId } },
      create: { agentId, allowedAgentId, projectId: agents[0]!.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/collaborators/:allowedAgentId", async (context) => {
    const deleted = await db.agentCollaboration.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), allowedAgentId: id.parse(context.req.param("allowedAgentId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Collaboration binding not found" }, 404);
  });

  app.get("/projects/:projectId/skills", async (context) => context.json(await db.skill.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { agents: true },
    orderBy: { createdAt: "asc" },
  })));
  app.post("/projects/:projectId/skills", async (context) => {
    const body = await readJson(context.req.raw, skillInput);
    return context.json(await db.skill.create({
      data: { projectId: id.parse(context.req.param("projectId")), ...body },
    }), 201);
  });
  app.post("/agents/:agentId/skills", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { skillId } = await readJson(context.req.raw, skillBindingInput);
    const [agent, skill] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.skill.findUnique({ where: { id: skillId }, select: { projectId: true } }),
    ]);
    if (!agent || !skill) return context.json({ error: "Agent or Skill not found" }, 404);
    if (agent.projectId !== skill.projectId) return context.json({ error: "Agent and Skill belong to different projects" }, 400);
    return context.json(await db.agentSkill.upsert({
      where: { agentId_skillId: { agentId, skillId } },
      create: { agentId, skillId, projectId: agent.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/skills/:skillId", async (context) => {
    const deleted = await db.agentSkill.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), skillId: id.parse(context.req.param("skillId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Skill binding not found" }, 404);
  });

  app.get("/projects/:projectId/mcp-connections", async (context) => context.json(await db.mCPConnection.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { agents: true },
    orderBy: { createdAt: "asc" },
  })));
  app.post("/projects/:projectId/mcp-connections", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, mcpConnectionInput);
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "MCP credential secret is unavailable" }, 400);
    }
    return context.json(await db.mCPConnection.create({
      data: { ...body, config: jsonValue(body.config), projectId },
    }), 201);
  });
  app.post("/agents/:agentId/mcp-connections", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const { mcpConnectionId } = await readJson(context.req.raw, mcpBindingInput);
    const [agent, connection] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.mCPConnection.findUnique({ where: { id: mcpConnectionId }, select: { projectId: true } }),
    ]);
    if (!agent || !connection) return context.json({ error: "Agent or MCP connection not found" }, 404);
    if (agent.projectId !== connection.projectId) return context.json({ error: "Agent and MCP connection belong to different projects" }, 400);
    return context.json(await db.agentMCPConnection.upsert({
      where: { agentId_mcpConnectionId: { agentId, mcpConnectionId } },
      create: { agentId, mcpConnectionId, projectId: agent.projectId }, update: {},
    }), 201);
  });
  app.delete("/agents/:agentId/mcp-connections/:connectionId", async (context) => {
    const deleted = await db.agentMCPConnection.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), mcpConnectionId: id.parse(context.req.param("connectionId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "MCP binding not found" }, 404);
  });

  app.get("/projects/:projectId/repos", async (context) => context.json(await db.repo.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })));
  app.post("/projects/:projectId/repos", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, repoInput);
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "Repo credential secret is unavailable" }, 400);
    }
    return context.json(await db.repo.create({ data: { ...body, projectId } }), 201);
  });
  app.patch("/repos/:repoId", async (context) => {
    const body = await readJson(context.req.raw, repoPatch);
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "Repo credential secret is unavailable" }, 400);
    }
    return context.json(await db.repo.update({
      where: { id: id.parse(context.req.param("repoId")) }, data: withoutUndefined(body),
    }));
  });
  app.delete("/repos/:repoId", async (context) => {
    await db.repo.delete({ where: { id: id.parse(context.req.param("repoId")) } });
    return context.body(null, 204);
  });
  app.post("/agents/:agentId/repos/:repoId/access", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const repoId = id.parse(context.req.param("repoId"));
    const body = await readJson(context.req.raw, repoAccessInput);
    const [agent, repo] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.repo.findUnique({ where: { id: repoId }, select: { projectId: true } }),
    ]);
    if (!agent || !repo) return context.json({ error: "Agent or Repo not found" }, 404);
    if (agent.projectId !== repo.projectId) return context.json({ error: "Agent and Repo belong to different projects" }, 400);
    return context.json(await db.agentRepoAccess.upsert({
      where: { agentId_repoId: { agentId, repoId } },
      create: { agentId, repoId, projectId: agent.projectId, ...body },
      update: body,
    }), 201);
  });
  app.delete("/agents/:agentId/repos/:repoId/access", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const repoId = id.parse(context.req.param("repoId"));
    const grant = await db.agentRepoAccess.findUnique({
      where: { agentId_repoId: { agentId, repoId } }, select: { projectId: true },
    });
    if (!grant) return context.json({ error: "Repo access not found" }, 404);
    const result = await db.$transaction(async (tx) => {
      if (!await lockAgentRepoGrantForRevocation(tx, { projectId: grant.projectId, agentId, repoId })) {
        return { error: "Repo access not found", code: 404 as const };
      }
      const active = await tx.run.count({ where: { agentId, repoId, status: { in: ACTIVE_RUN_STATUSES } } });
      if (active > 0) return { error: "Cannot revoke repo access while the agent has an active run on this Repo", code: 409 as const };
      const dependentSteps = await tx.task.count({ where: {
        projectId: grant.projectId,
        repoId,
        assigneeAgentId: agentId,
        chainId: { not: null },
        archivedAt: null,
        status: { in: [TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] },
      } });
      if (dependentSteps > 0) {
        return {
          error: "Cannot revoke repo access while a nonterminal chain step depends on this grant",
          code: 409 as const,
        };
      }
      await tx.agentRepoAccess.delete({ where: { agentId_repoId: { agentId, repoId } } });
      return { ok: true as const };
    });
    return "error" in result ? context.json({ error: result.error }, result.code) : context.body(null, 204);
  });

  app.get("/projects/:projectId/goals", async (context) => context.json(await db.goal.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: goalInclude,
    orderBy: { createdAt: "asc" },
  })));
  app.post("/projects/:projectId/goals", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, goalInput);
    const { definitionOfDone, ...fields } = body;
    return context.json(await db.goal.create({
      data: {
        ...fields,
        projectId,
        definitionOfDone: {
          create: definitionOfDone.map((item, itemIndex) => ({ itemIndex, text: item.text })),
        },
      },
      include: goalInclude,
    }), 201);
  });
  app.get("/goals/:goalId", async (context) => {
    const goal = await db.goal.findUnique({
      where: { id: id.parse(context.req.param("goalId")) }, include: goalInclude,
    });
    return goal ? context.json(goal) : context.json({ error: "Goal not found" }, 404);
  });
  app.patch("/goals/:goalId", async (context) => context.json(await db.goal.update({
    where: { id: id.parse(context.req.param("goalId")) },
    data: withoutUndefined(await readJson(context.req.raw, goalPatch)) as Prisma.GoalUncheckedUpdateInput,
    include: goalInclude,
  })));
  app.delete("/goals/:goalId", async (context) => {
    await db.goal.delete({ where: { id: id.parse(context.req.param("goalId")) } });
    return context.body(null, 204);
  });

  const approveGoalDod = async (context: Context<AppEnvironment, string>) => {
    const goalId = id.parse(context.req.param("goalId"));
    const projectId = context.req.param("projectId");
    const goal = await db.goal.findFirst({
      where: { id: goalId, ...(projectId ? { projectId: id.parse(projectId) } : {}) },
      include: { definitionOfDone: true },
    });
    if (!goal) return context.json({ error: "Goal not found" }, 404);
    if (goal.definitionOfDone.length === 0) return context.json({ error: "Definition of Done must contain at least one item" }, 409);
    const completed = goal.definitionOfDone.every((item) => item.done);
    const now = new Date();
    return context.json(await db.goal.update({
      where: { id: goalId },
      data: {
        dodApproved: true,
        status: completed ? GoalStatus.COMPLETED : GoalStatus.ACTIVE,
        startedAt: goal.startedAt ?? now,
        endedAt: completed ? now : null,
      },
      include: goalInclude,
    }));
  };
  app.post("/goals/:goalId/approve-dod", approveGoalDod);
  app.post("/projects/:projectId/goals/:goalId/approve-dod", approveGoalDod);

  const pauseGoal = async (context: Context<AppEnvironment, string>) => {
    const goalId = id.parse(context.req.param("goalId"));
    const projectId = context.req.param("projectId");
    const updated = await db.goal.updateMany({
      where: { id: goalId, ...(projectId ? { projectId: id.parse(projectId) } : {}), status: GoalStatus.ACTIVE },
      data: { status: GoalStatus.PAUSED },
    });
    if (updated.count !== 1) return context.json({ error: "Only an active Goal can be paused" }, 409);
    return context.json(await db.goal.findUniqueOrThrow({ where: { id: goalId }, include: goalInclude }));
  };
  app.post("/goals/:goalId/pause", pauseGoal);
  app.post("/projects/:projectId/goals/:goalId/pause", pauseGoal);

  app.get("/goals/:goalId/definition-of-done", async (context) => context.json(await db.goalDefinitionItem.findMany({
    where: { goalId: id.parse(context.req.param("goalId")) }, orderBy: { itemIndex: "asc" },
  })));
  app.post("/goals/:goalId/definition-of-done", async (context) => {
    const goalId = id.parse(context.req.param("goalId"));
    const body = await readJson(context.req.raw, definitionItemText);
    const result = await db.$transaction(async (tx) => {
      const goal = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
      const last = await tx.goalDefinitionItem.findFirst({ where: { goalId }, orderBy: { itemIndex: "desc" } });
      const item = await tx.goalDefinitionItem.create({ data: { goalId, itemIndex: (last?.itemIndex ?? -1) + 1, text: body.text } });
      if (goal.dodApproved && goal.status === GoalStatus.COMPLETED) {
        await tx.goal.update({ where: { id: goalId }, data: { status: GoalStatus.ACTIVE, endedAt: null } });
      }
      return item;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return context.json(result, 201);
  });
  app.patch("/goals/:goalId/definition-of-done/:itemId", async (context) => {
    const goalId = id.parse(context.req.param("goalId"));
    const itemId = id.parse(context.req.param("itemId"));
    const body = await readJson(context.req.raw, definitionItemPatch);
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.goalDefinitionItem.findFirst({ where: { id: itemId, goalId } });
      if (!existing) return null;
      const item = await tx.goalDefinitionItem.update({ where: { id: itemId }, data: withoutUndefined(body) });
      const goal = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
      if (goal.dodApproved) {
        const items = await tx.goalDefinitionItem.findMany({ where: { goalId }, select: { done: true } });
        const met = items.length > 0 && items.every((candidate) => candidate.done);
        const wasMet = goal.status === GoalStatus.COMPLETED;
        if (met !== wasMet) {
          const now = new Date();
          await tx.goal.update({
            where: { id: goalId },
            data: met
              ? { status: GoalStatus.COMPLETED, endedAt: now, startedAt: goal.startedAt ?? now }
              : { status: GoalStatus.ACTIVE, endedAt: null, startedAt: goal.startedAt ?? now },
          });
        }
      }
      return item;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return result ? context.json(result) : context.json({ error: "Definition of Done item not found" }, 404);
  });
  app.delete("/goals/:goalId/definition-of-done/:itemId", async (context) => {
    const goalId = id.parse(context.req.param("goalId"));
    const itemId = id.parse(context.req.param("itemId"));
    const deleted = await db.$transaction(async (tx) => {
      const result = await tx.goalDefinitionItem.deleteMany({ where: { id: itemId, goalId } });
      if (result.count !== 1) return false;
      const goal = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
      if (goal.dodApproved) {
        const items = await tx.goalDefinitionItem.findMany({ where: { goalId }, select: { done: true } });
        const met = items.length > 0 && items.every((candidate) => candidate.done);
        await tx.goal.update({
          where: { id: goalId },
          data: met
            ? { status: GoalStatus.COMPLETED, endedAt: goal.endedAt ?? new Date() }
            : { status: GoalStatus.ACTIVE, endedAt: null },
        });
      }
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return deleted ? context.body(null, 204) : context.json({ error: "Definition of Done item not found" }, 404);
  });

  app.get("/goals/:goalId/progress-log", async (context) => context.json(await db.goalProgressEntry.findMany({
    where: { goalId: id.parse(context.req.param("goalId")) }, orderBy: { createdAt: "asc" },
  })));
  app.post("/goals/:goalId/progress-log", async (context) => {
    const goalId = id.parse(context.req.param("goalId"));
    const body = await readJson(context.req.raw, progressInput);
    if (body.sessionId) {
      const session = await db.session.findFirst({ where: { id: body.sessionId, goalId }, select: { id: true } });
      if (!session) return context.json({ error: "Session does not belong to this Goal" }, 400);
    }
    return context.json(await db.goalProgressEntry.create({ data: {
      goalId,
      sessionId: body.sessionId ?? null,
      body: body.body,
      ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}),
    } }), 201);
  });

  app.get("/projects/:projectId/task-templates", async (context) => context.json(await db.taskTemplate.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
    orderBy: { createdAt: "asc" },
  })));
  app.get("/task-templates/:templateId", async (context) => {
    const template = await db.taskTemplate.findUnique({
      where: { id: id.parse(context.req.param("templateId")) },
      include: { steps: { include: { assigneeAgent: true }, orderBy: { stepIndex: "asc" } } },
    });
    return template ? context.json(template) : context.json({ error: "Template not found" }, 404);
  });
  app.post("/task-templates/:templateId/steps", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const body = await readJson(context.req.raw, templateStepInput);
    const template = await db.taskTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, projectId: true, webhookRepoId: true },
    });
    if (!template) return context.json({ error: "Template not found" }, 404);
    if (body.assigneeType === AssigneeType.AGENT && !body.assigneeAgentId) {
      return context.json({ error: "Agent template steps require an assignee" }, 400);
    }
    if (body.assigneeType === AssigneeType.HUMAN && body.assigneeAgentId) {
      return context.json({ error: "Human template steps cannot have an agent assignee" }, 400);
    }
    const agent = body.assigneeAgentId
      ? await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId: template.projectId } })
      : null;
    if (body.assigneeAgentId && !agent) {
      return context.json({ error: "Assignee does not belong to this template's project" }, 400);
    }
    if (agent?.archivedAt) return context.json({ error: `Assignee ${agent.name} is archived` }, 400);
    if (agent && template.webhookRepoId) {
      const access = await db.agentRepoAccess.findFirst({
        where: { projectId: template.projectId, agentId: agent.id, repoId: template.webhookRepoId },
        select: { agentId: true },
      });
      if (!access) return context.json({ error: "Assignee has no grant for this template's Repo" }, 400);
    }
    // A template step is a standing assignment: every future instantiation and
    // every webhook fire turns this row into a task and a run for this agent. So
    // it joins the same Agent-row exclusion protocol as the task writers — the
    // checks above answered from unlocked reads, and only this re-read under
    // `lockAgentRow` decides. Duplicate detection and the create move inside the
    // same transaction, because a step written after the lock was released is
    // exactly the archived assignment this protocol exists to prevent.
    const result = await db.$transaction(async (tx) => {
      const blocked = await assignmentBlocked(tx, agent);
      if (blocked) return { error: blocked, code: 400 as const };
      const duplicate = await tx.taskTemplateStep.findFirst({
        where: { taskTemplateId: template.id, stepIndex: body.stepIndex },
        select: { id: true },
      });
      if (duplicate) return { error: "Template step index already exists", code: 409 as const };
      if (body.baseFromStepIndex !== null) {
        if (body.baseFromStepIndex >= body.stepIndex) {
          return { error: "baseFromStepIndex must reference a strictly earlier stepIndex", code: 400 as const };
        }
        const baseStep = await tx.taskTemplateStep.findFirst({
          where: { taskTemplateId: template.id, stepIndex: body.baseFromStepIndex },
          select: { id: true },
        });
        if (!baseStep) return { error: "baseFromStepIndex must reference an earlier step of the same template", code: 400 as const };
      }
      return { step: await tx.taskTemplateStep.create({ data: {
        taskTemplateId: template.id,
        stepIndex: body.stepIndex,
        name: body.name,
        assigneeType: body.assigneeType,
        assigneeAgentId: body.assigneeAgentId,
        prompt: body.prompt,
        approvalGate: body.approvalGate,
        attachmentsFromPrevious: body.attachmentsFromPrevious,
        spawnPolicy: body.spawnPolicy === null ? Prisma.JsonNull : jsonValue(body.spawnPolicy),
        runner: body.runner,
        outputKind: body.outputKind,
        opensPullRequest: body.opensPullRequest,
        baseFromStepIndex: body.baseFromStepIndex,
        layer: body.stepIndex,
      } }) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.step, 201);
  });
  // Bounded on purpose: only delivery and base-pinning fields. A general
  // template-step editor remains a separate authoring surface.
  app.patch("/task-templates/:templateId/steps/:stepId", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const stepId = id.parse(context.req.param("stepId"));
    const body = await readJson(context.req.raw, templateStepPatch);
    // Ownership is checked, not assumed: the step id alone would let a caller
    // patch another template's step through any templateId that happens to exist.
    const result = await db.$transaction(async (tx) => {
      const step = await tx.taskTemplateStep.findFirst({ where: { id: stepId, taskTemplateId: templateId } });
      if (!step) return { error: "Template step not found", code: 404 as const };
      if (body.baseFromStepIndex !== undefined && body.baseFromStepIndex !== null) {
        if (body.baseFromStepIndex >= step.stepIndex) {
          return { error: "baseFromStepIndex must reference a strictly earlier stepIndex", code: 400 as const };
        }
        const baseStep = await tx.taskTemplateStep.findFirst({
          where: { taskTemplateId: templateId, stepIndex: body.baseFromStepIndex }, select: { id: true },
        });
        if (!baseStep) return { error: "baseFromStepIndex must reference an earlier step of the same template", code: 400 as const };
      }
      return { step: await tx.taskTemplateStep.update({
        where: { id: stepId },
        data: withoutUndefined(body),
      }) };
    });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.step);
  });
  app.patch("/task-templates/:templateId", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const body = await readJson(context.req.raw, webhookConfigPatch);
    const template = await db.taskTemplate.findUnique({ where: { id: templateId } });
    if (!template) return context.json({ error: "Template not found" }, 404);
    const secretId = body.webhookSecretId === undefined ? template.webhookSecretId : body.webhookSecretId;
    const repoId = body.webhookRepoId === undefined ? template.webhookRepoId : body.webhookRepoId;
    if (secretId) {
      const secret = await db.secret.findFirst({ where: { id: secretId, purpose: SecretPurpose.WEBHOOK } });
      if (!secret) return context.json({ error: "Webhook secret must exist and have WEBHOOK purpose" }, 400);
      if (!repoId) return context.json({ error: "Webhook secret requires an in-project Repo" }, 400);
    }
    if (repoId) {
      const repo = await db.repo.findFirst({ where: { id: repoId, projectId: template.projectId } });
      if (!repo) return context.json({ error: "Webhook Repo does not belong to this project" }, 400);
    }
    return context.json(await db.taskTemplate.update({
      where: { id: templateId },
      data: {
        ...withoutUndefined(body),
        ...(body.webhookPayloadMapping !== undefined
          ? { webhookPayloadMapping: body.webhookPayloadMapping === null ? Prisma.JsonNull : body.webhookPayloadMapping }
          : {}),
        ...(body.webhookReplayWindowSec !== undefined
          ? { webhookReplayWindowSec: body.webhookReplayWindowSec ? body.webhookReplayWindowSec : null }
          : {}),
      },
    }));
  });
  app.post("/projects/:projectId/task-templates/:templateId/instantiate", async (context) => {
    try {
      return context.json(await instantiateTemplate(
        db,
        id.parse(context.req.param("projectId")),
        id.parse(context.req.param("templateId")),
        await readJson(context.req.raw, instantiateTemplateInput),
      ), 201);
    } catch (error: unknown) {
      if (isTemplateInstantiationRefusal(error)) {
        return context.json({ error: error.message, code: error.code }, 400);
      }
      const schemaRefusal = templateSchemaRefusal(error);
      if (schemaRefusal) return context.json(schemaRefusal, 400);
      if (isTemplateInputError(error)) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  // --- triggers: webhook-configured templates, their ledger, and manual fire --
  //
  // Every select below is explicit. `include: { webhookSecret: true }` would put
  // the ciphertext on the wire, so the secret relation is only ever read through
  // a field list that names `disabledAt` and `name` and nothing else.
  const triggerSelect = {
    id: true,
    name: true,
    description: true,
    projectId: true,
    webhookRepoId: true,
    webhookPausedAt: true,
    webhookReplayWindowSec: true,
    variables: true,
    webhookPayloadMapping: true,
    webhookRepo: { select: { id: true, name: true } },
    webhookSecret: { select: { name: true, disabledAt: true } },
    _count: { select: { steps: true } },
  } as const;

  /** One grouped query for every listed trigger — never one per row (E5). */
  const fireStats = async (templateIds: string[]): Promise<Map<string, { fireCount: number; lastFiredAt: Date | null }>> => {
    if (templateIds.length === 0) return new Map();
    const grouped = await db.triggerFire.groupBy({
      by: ["templateId"],
      where: { templateId: { in: templateIds } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return new Map(grouped.map((row) => [row.templateId, {
      fireCount: row._count._all,
      lastFiredAt: row._max.createdAt ?? null,
    }]));
  };

  const cannotFireReason = (trigger: { webhookRepoId: string | null; _count: { steps: number } }): string | null => {
    if (!trigger.webhookRepoId) return "This trigger has no repository configured";
    if (trigger._count.steps === 0) return "This trigger's template has no steps";
    return null;
  };

  const payloadMapping = (raw: unknown): { map: Record<string, string>; defaults: Record<string, unknown> } => {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { map?: unknown; defaults?: unknown } : {};
    return {
      map: value.map && typeof value.map === "object" && !Array.isArray(value.map) ? value.map as Record<string, string> : {},
      defaults: value.defaults && typeof value.defaults === "object" && !Array.isArray(value.defaults) ? value.defaults as Record<string, unknown> : {},
    };
  };

  app.get("/projects/:projectId/triggers", async (context) => {
    const triggers = await db.taskTemplate.findMany({
      // A trigger is defined by its secret, not its repo: a template with a
      // secret and no repo is un-fireable, and hiding it is exactly the wrong
      // answer — the operator needs to see the one that cannot fire.
      where: { projectId: id.parse(context.req.param("projectId")), webhookSecretId: { not: null } },
      select: triggerSelect,
      orderBy: { createdAt: "asc" },
    });
    const stats = await fireStats(triggers.map((trigger) => trigger.id));
    return context.json(triggers.map((trigger) => ({
      id: trigger.id,
      name: trigger.name,
      description: trigger.description,
      repo: trigger.webhookRepo,
      stepCount: trigger._count.steps,
      paused: trigger.webhookPausedAt !== null,
      secretDisabled: trigger.webhookSecret?.disabledAt != null,
      lastFiredAt: stats.get(trigger.id)?.lastFiredAt ?? null,
      fireCount: stats.get(trigger.id)?.fireCount ?? 0,
    })));
  });

  app.get("/triggers/:templateId", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const trigger = await db.taskTemplate.findFirst({ where: { id: templateId, webhookSecretId: { not: null } }, select: triggerSelect });
    if (!trigger) return context.json({ error: "Trigger not found" }, 404);
    const stats = (await fireStats([trigger.id])).get(trigger.id);
    const mapping = payloadMapping(trigger.webhookPayloadMapping);
    const reason = cannotFireReason(trigger);
    return context.json({
      id: trigger.id,
      name: trigger.name,
      description: trigger.description,
      projectId: trigger.projectId,
      endpointPath: `/hooks/templates/${trigger.id}`,
      secretName: trigger.webhookSecret?.name ?? null,
      secretDisabled: trigger.webhookSecret?.disabledAt != null,
      repo: trigger.webhookRepo,
      variables: trigger.variables,
      mapping: mapping.map,
      defaults: mapping.defaults,
      replayWindowSec: trigger.webhookReplayWindowSec,
      paused: trigger.webhookPausedAt !== null,
      stepCount: trigger._count.steps,
      fireCount: stats?.fireCount ?? 0,
      lastFiredAt: stats?.lastFiredAt ?? null,
      canFire: reason === null,
      cannotFireReason: reason,
    });
  });

  app.get("/triggers/:templateId/fires", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    const take = Math.min(Math.max(Number(context.req.query("take") ?? 20) || 20, 1), 100);
    const template = await db.taskTemplate.findUnique({ where: { id: templateId }, select: { projectId: true } });
    if (!template) return context.json({ error: "Template not found" }, 404);
    const fires = await db.triggerFire.findMany({
      where: { templateId },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, createdAt: true, source: true, chainId: true },
    });
    const chainIds = [...new Set(fires.map((fire) => fire.chainId).filter((chainId): chainId is string => chainId !== null))];
    // One query for every referenced chain, then the shared assembler — a fire
    // whose chain has since been deleted keeps its row and reports nothing.
    // Scoped to the trigger's own project because `chainId` is unique per
    // project only by convention: without this predicate a colliding chainId in
    // another project supplies this trigger's `firstTask` and progress.
    const rows = chainIds.length === 0 ? [] : await db.task.findMany({
      where: { chainId: { in: chainIds }, projectId: template.projectId },
      select: { id: true, projectId: true, chainId: true, chainIndex: true, chainLayer: true, name: true, status: true, archivedAt: true, templateStep: { select: { name: true } } },
    });
    const progress = chainProgressByChain(rows);
    // Keyed by `chainKey`, not `chainId`, for the same reason — the query above
    // makes the two equivalent today, and this keeps them equivalent if it changes.
    const firstByChain = new Map<string, { id: string; name: string }>();
    for (const row of [...rows].sort((left, right) => (left.chainIndex ?? 0) - (right.chainIndex ?? 0))) {
      if (!row.chainId) continue;
      const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
      if (!firstByChain.has(key)) firstByChain.set(key, { id: row.id, name: row.name });
    }
    const keyOf = (chainId: string) => chainKey({ projectId: template.projectId, chainId });
    return context.json(fires.map((fire) => ({
      id: fire.id,
      createdAt: fire.createdAt,
      source: fire.source,
      chainId: fire.chainId,
      firstTask: fire.chainId ? firstByChain.get(keyOf(fire.chainId)) ?? null : null,
      progress: fire.chainId ? progress.get(keyOf(fire.chainId)) ?? null : null,
    })));
  });

  const setTriggerPaused = async (context: Context, paused: boolean) => {
    const templateId = id.parse(context.req.param("templateId"));
    const trigger = await db.taskTemplate.findFirst({ where: { id: templateId, webhookSecretId: { not: null } }, select: { id: true } });
    if (!trigger) return context.json({ error: "Trigger not found" }, 404);
    await db.taskTemplate.update({ where: { id: templateId }, data: { webhookPausedAt: paused ? new Date() : null } });
    return context.json({ paused });
  };
  app.post("/triggers/:templateId/pause", async (context) => setTriggerPaused(context, true));
  app.post("/triggers/:templateId/enable", async (context) => setTriggerPaused(context, false));

  app.post("/task-templates/:templateId/fire", async (context) => {
    const templateId = id.parse(context.req.param("templateId"));
    // `Fire now` on a fully-defaulted trigger sends no body at all, and
    // `request.json()` throws on an empty one — hence the hand-rolled parse
    // instead of `readJson`. It still has to answer a malformed body the way
    // every other route does: a client error is a 400, not a 500.
    const raw = await context.req.text();
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return context.json({ error: "Invalid JSON payload" }, 400);
    }
    const body = manualFireInput.parse(parsed);
    const trigger = await db.taskTemplate.findUnique({ where: { id: templateId }, select: triggerSelect });
    if (!trigger) return context.json({ error: "Template not found" }, 404);
    // The repository is the template's own webhook repo — the same one the hook
    // passes — and it is nullable, so this check comes before variables. It is
    // also `canFire: false` in the detail route, so the button is already
    // disabled with the reason shown; this 400 is for direct API callers.
    const reason = cannotFireReason(trigger);
    if (reason && !trigger.webhookRepoId) return context.json({ error: reason }, 400);
    const mapping = payloadMapping(trigger.webhookPayloadMapping);
    const variables: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const name of trigger.variables) {
      const supplied = body.variables?.[name];
      const fallback = mapping.defaults[name];
      // Same `usableDefault` the webhook path uses, so an empty-string default
      // does not resolve here while the UI badges the variable `required`.
      const value = isUsableTemplateVariable(supplied) ? supplied
        : usableDefault(fallback) ? String(fallback)
        : undefined;
      if (value === undefined) unresolved.push(name); else variables[name] = value;
    }
    // The names go in the prose, not only in `unresolved`: the web client's
    // parseError keeps the `error` string and discards every sibling field, so
    // prose is the only form the operator ever sees.
    if (unresolved.length > 0) {
      return context.json({ error: `Unresolved template variables: ${unresolved.join(", ")}`, unresolved }, 400);
    }
    try {
      const result = await instantiateTemplate(db, trigger.projectId, trigger.id, {
        repoId: trigger.webhookRepoId!, variables, autoStart: true,
      }, {
        actorType: "operator",
        activityMetadata: { manualFireTemplateId: trigger.id, firedAt: new Date().toISOString() },
        source: TaskSource.MANUAL,
        fire: { source: TriggerFireSource.MANUAL },
      });
      return context.json({ chainId: result.chainId, taskIds: result.tasks.map((task) => task.id), fireId: result.fireId }, 201);
    } catch (error: unknown) {
      if (isTemplateInputError(error)) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.get("/tasks", async (context) => {
    const projectId = context.req.query("projectId");
    const archived = context.req.query("archived") ?? "false";
    if (archived !== "false" && archived !== "true" && archived !== "all") {
      return context.json({ error: "archived must be false, true, or all" }, 400);
    }
    // `view=board` is the Tasks board saying which fields it will actually
    // render (packages/api/src/board.ts). It is a projection of this same list,
    // not a second endpoint, so the two shapes cannot drift apart.
    const view = context.req.query("view") ?? "full";
    if (view !== "full" && view !== "board") {
      return context.json({ error: "view must be full or board" }, 400);
    }
    const board = view === "board";
    // Archived tasks are finished work; a board and a per-project count that
    // keep growing after Archive All are the bug, not the fix. `all` is the
    // escape hatch for anyone who needs the old, archived-inclusive numbers.
    const archivedFilter = archived === "false" ? { archivedAt: null }
      : archived === "true" ? { archivedAt: { not: null } }
      : {};
    const where = { ...(projectId ? { projectId } : {}), ...archivedFilter };
    const orderBy = [{ createdAt: "desc" as const }, { id: "asc" as const }];

    // `chainProgress` / `recurringLastFiredAt` / `position` cost two extra
    // queries over the whole task table, and `Projects.tsx` polls this endpoint
    // globally every 2.5 s purely to count tasks per project — it renders none
    // of them. `?enrich=false` lets that caller stop paying for it.
    //
    // Opt-out rather than "only when projectId is present": the global call is
    // still *correct* (grouping is keyed by `(projectId, chainId)`, so two
    // projects sharing a chainId never read each other's progress), and silently
    // dropping the fields from every global response would delete that
    // guarantee's only coverage along with the cost.
    //
    // `view=board` is not subject to it: the board card renders `chainProgress`,
    // so a board response without it would be a projection that dropped a field
    // its only caller reads.
    const enrich = board || (context.req.query("enrich") ?? "true") !== "false";

    /**
     * A `task -> chainProgress` lookup for one page of rows.
     *
     * Progress must count *all* the chain's rows, including archived ones, so it
     * cannot be computed from the rows handed in. One extra scoped query,
     * grouped in memory — two queries per request regardless of how many tasks
     * come back. Shared by both response shapes, so the board card and the full
     * row can never report different numbers for the same task.
     *
     * `chainIndex: { not: null }` matches `GET /tasks/:id/chain`, which treats a
     * null-index row as its own one-row chain. Without it a single broken row
     * inflates `total` and shifts `position` for every real sibling on the board
     * while its own detail page still reads `1/1` — the same rows, two answers.
     */
    const chainProgressLookup = async (rows: ChainSubject[]): Promise<(task: ChainSubject) => ChainProgressWire | null> => {
      const chainIds = !enrich ? [] : [...new Set(rows
        .filter((task) => task.chainIndex !== null)
        .map((task) => task.chainId)
        .filter((value): value is string => value !== null))];
      const chainRows = chainIds.length === 0 ? [] : await db.task.findMany({
        where: { chainId: { in: chainIds }, chainIndex: { not: null }, ...(projectId ? { projectId } : {}) },
        select: {
          id: true, projectId: true, chainId: true, chainIndex: true, status: true,
          chainLayer: true, name: true, archivedAt: true, templateStep: { select: { name: true } },
        },
        orderBy: { chainIndex: "asc" },
      });
      const progressByChain = chainProgressByChain(chainRows);
      const positionsByChain = new Map<string, Map<string, number>>();
      for (const row of chainRows) {
        if (!row.chainId) continue;
        const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
        if (positionsByChain.has(key)) continue;
        positionsByChain.set(key, positions(chainRows.filter((candidate) => (
          candidate.chainId !== null && chainKey({ projectId: candidate.projectId, chainId: candidate.chainId }) === key
        ))));
      }
      return (task) => {
        if (!enrich || !task.chainId) return null;
        // The same one-row-chain rule the detail route applies (E1), so a broken
        // row reports `n/1` in both places instead of `null` here and `1/1` there.
        if (task.chainIndex === null) {
          return {
            chainId: task.chainId,
            done: task.status === TaskStatus.DONE ? 1 : 0,
            total: 1,
            activeStepName: task.templateStep?.name ?? task.name,
            activeStatus: task.status.toLowerCase(),
            currentLayer: 1,
            layerCount: 1,
            position: 1,
          };
        }
        const key = chainKey({ projectId: task.projectId, chainId: task.chainId });
        const progress = progressByChain.get(key) ?? null;
        return progress ? { ...progress, position: positionsByChain.get(key)?.get(task.id) ?? null } : null;
      };
    };

    if (board) {
      // The projection narrows the *query* too, not only the response: the full
      // shape drags every Run and Session column out of the database only to
      // throw 95% of them away in the serializer.
      const rows = await db.task.findMany({
        where,
        orderBy,
        select: {
          id: true, projectId: true, name: true, status: true, failureReason: true,
          scheduleKind: true, runAt: true, cron: true, timezone: true, approvalGate: true,
          templateId: true, source: true, chainId: true, chainIndex: true, chainLayer: true, updatedAt: true,
          assigneeAgent: { select: { id: true, title: true, model: true } },
          templateStep: { select: { name: true } },
          runs: {
            orderBy: { runNumber: "desc" },
            select: {
              id: true, runNumber: true, status: true, model: true, subagentModel: true,
              session: { select: { costUsd: true, inputTokens: true, cachedInputTokens: true, outputTokens: true, startedAt: true, endedAt: true } },
            },
          },
          // §SF-1: the card's run line reads the merge outcome, not only the
          // protocol status, so a stopped mechanical merge is not shown as Done.
          stepOutput: { select: { kind: true, body: true, runId: true } },
        },
      });
      const progressFor = await chainProgressLookup(rows);
      const displayByTask = chainDisplayByTask(rows);
      return validated(context, rows.map((row) => boardCard(row, progressFor(row), displayByTask.get(row.id))));
    }

    const tasks = await db.task.findMany({
      where,
      orderBy,
      include: {
        assigneeAgent: true,
        repo: true,
        templateStep: {
          select: {
            name: true,
            stepIndex: true,
            outputKind: true,
            taskTemplate: { select: { name: true } },
          },
        },
        // `Run.output` is forensic bulk — up to 500k per run — and no client of
        // this list reads it. Omitted here and on the task detail below so that
        // recording a run's tail cannot inflate the responses the board polls.
        runs: {
          orderBy: { runNumber: "desc" }, take: 1, omit: { output: true },
          include: { session: true },
        },
      },
    });
    const progressFor = await chainProgressLookup(tasks);

    // The Automations page needs `Last run` on a *collapsed* row, and a poll
    // that only mounts while a row is expanded can never supply it. Skipped
    // entirely on a board with no automations.
    const cronIds = !enrich ? [] : tasks.filter((task) => task.scheduleKind === ScheduleKind.CRON).map((task) => task.id);
    const firedGroups = cronIds.length === 0 ? [] : await db.task.groupBy({
      by: ["recurringSourceTaskId"],
      where: { recurringSourceTaskId: { in: cronIds } },
      _max: { createdAt: true },
      _count: { _all: true },
    });
    const firedByDefinition = new Map(firedGroups.map((group) => [group.recurringSourceTaskId, group]));

    return validated(context, tasks.map((task) => ({
      ...task,
      executionOwner: chainExecutionOwner(task),
      chainProgress: progressFor(task),
      recurringLastFiredAt: firedByDefinition.get(task.id)?._max.createdAt ?? null,
      recurringFireCount: firedByDefinition.get(task.id)?._count._all ?? 0,
    })));
  });
  app.post("/projects/:projectId/tasks", async (context) => {
    const body = await readJson(context.req.raw, taskInput);
    const projectId = id.parse(context.req.param("projectId"));
    const agent = body.assigneeAgentId
      ? await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId } })
      : null;
    if (body.assigneeAgentId && !agent) return context.json({ error: "Assignee does not belong to this project" }, 400);
    if (agent?.archivedAt) return context.json({ error: `Assignee ${agent.name} is archived` }, 400);
    const repo = body.repoId ? await db.repo.findFirst({ where: { id: body.repoId, projectId } }) : null;
    if (body.repoId && !repo) return context.json({ error: "Repo does not belong to this project" }, 400);
    if (body.assigneeType === AssigneeType.AGENT && (!agent || !repo)) {
      return context.json({ error: "Agent tasks require an assignee and Repo configuration" }, 400);
    }
    if (agent && repo) {
      const access = await db.agentRepoAccess.findFirst({ where: { agentId: agent.id, repoId: repo.id, projectId } });
      if (!access) return context.json({ error: "Assignee has no grant for this Repo" }, 400);
    }
    let schedule;
    try {
      schedule = validateSchedule(body);
    } catch (error: unknown) {
      return context.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, 400);
    }
    const task = await db.$transaction(async (tx) => {
      // The check above answered from an unlocked read. This one holds the
      // Agent-row mutex through the task — and the inline run below — so a
      // concurrent archive either loses the race or is refused for this run.
      const currentAgent = agent ? await lockAgentRow(tx, agent.id) : null;
      if (agent && !currentAgent) return { error: "Assignee does not belong to this project", code: 400 as const };
      if (currentAgent?.archivedAt) return { error: `Assignee ${currentAgent.name} is archived`, code: 400 as const };
      // §D-P4, inside the transaction and before `tx.task.create` and the inline
      // `tx.run.create` below. This route cannot set `templateStepId` at all, so
      // in practice it refuses the sentinel Agent outright — which is the point:
      // an ordinary task assigned to the sentinel would claim as `agent` and
      // spawn a model CLI with `mechanical/merge-executor-v1` as its model.
      const bindingRefusal = await integratorBindingRefusalFor(tx, {
        assigneeAgentName: currentAgent?.name ?? null,
        templateStep: null,
      });
      if (bindingRefusal) return { error: bindingRefusal, code: 400 as const };
      const created = await tx.task.create({
        data: {
          ...withoutUndefined(body),
          ...schedule,
          projectId,
          chainLayer: body.chainId === undefined ? null : body.chainIndex,
        } as Prisma.TaskUncheckedCreateInput,
      });
      await tx.taskActivity.create({ data: { taskId: created.id, actorType: "operator", body: "Task created" } });
      // API-created chains arrive one task at a time. Only index 0 may receive
      // an eager run; later indexed steps stay parked until
      // activateChainSuccessor observes their predecessor's durable success.
      // Without this guard every POST snapshots the fallback base before step
      // 0 can publish, and all runners race the same new shared head.
      const mayQueueInline = created.chainIndex == null || created.chainIndex === 0;
      if (currentAgent && repo && body.assigneeType === AssigneeType.AGENT && schedule.scheduleKind === ScheduleKind.NOW && mayQueueInline) {
        const derived = deriveRunConfig(currentAgent, null, created);
        // This run is built inline rather than through enqueueTaskRun, so it is
        // one of the paths a chain fix can miss. Missing it puts step ① on a
        // per-task branch while ②–⑨ share the chain branch — i.e. step ①'s work
        // silently absent from the tree every later step reviews.
        const branches = await resolveRunBranches(tx, { ...created, repo }, null);
        await tx.run.create({
          data: {
            projectId,
            taskId: created.id,
            agentId: currentAgent.id,
            repoId: repo.id,
            runNumber: 1,
            dedupeKey: makeDedupeKey(created.id, 1),
            runner: derived.runner,
            model: derived.model,
            codexServiceTier: derived.codexServiceTier,
            targetBranch: branches.targetBranch,
            branch: branches.branch,
            opensPullRequest: created.opensPullRequest,
            promptHash: derived.promptHash,
            maxDurationMin: body.maxDurationMin,
            stallTimeoutMin: body.stallTimeoutMin,
            maxRunsPerTask: body.maxSessionsPerTask,
          },
        });
      }
      return { created };
    });
    if ("error" in task) return context.json({ error: task.error }, task.code);
    return context.json(task.created, 201);
  });
  app.get("/tasks/:taskId", async (context) => {
    const task = await db.task.findUnique({
      where: { id: id.parse(context.req.param("taskId")) },
      include: {
        assigneeAgent: true,
        repo: true,
        templateStep: {
          select: {
            name: true,
            stepIndex: true,
            outputKind: true,
            taskTemplate: { select: { name: true } },
          },
        },
        // Every run of the task, so the omitted `Run.output` matters most here:
        // five tails would dwarf everything else this route returns.
        runs: { orderBy: { runNumber: "desc" }, omit: { output: true }, include: { session: true } },
        stepOutput: { select: { kind: true, body: true, runId: true } },
      },
    });
    if (!task) return context.json({ error: "Task not found" }, 404);
    const recoveryRow = await db.mergeRecoveryAttempt.findFirst({
      where: task.chainId
        ? { integratorTask: { projectId: task.projectId, chainId: task.chainId } }
        : { integratorTaskId: task.id },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    });
    const mergeRecovery = mergeRecoveryProjection(recoveryRow);
    // §SF-1. Parsed server-side with the shared parser, so the web client never
    // interprets a `merge-result` body and the three renderers cannot disagree.
    // The run rows carry it too, bound to the run that recorded it — the table
    // is where an operator reads a run's fate, and the header pill is not.
    const latestRunId = task.runs[0]?.id ?? null;
    const mergeOutcome = projectMergeOutcome(task.stepOutput);
    const usageCosts = task.runs.map((run) => run.session === null
      ? null
      : sessionUsageCost(run.model, run.session, { mixedModels: run.subagentModel !== null }));
    return context.json({
      ...task,
      executionOwner: chainExecutionOwner(task),
      taskCost: serializeUsageCost(sumUsageCosts(usageCosts.filter((cost) => cost !== null))),
      mergeOutcome,
      mergeRecovery,
      runs: task.runs.map((run, index) => ({
        ...run,
        session: run.session === null ? null : {
          ...run.session,
          usageCost: serializeUsageCost(usageCosts[index] ?? null),
        },
        mergeOutcome: runOwnsMergeOutcome(task.stepOutput, run.id, latestRunId) ? mergeOutcome : null,
        mergeRecovery: recoveryRow
          && (run.id === recoveryRow.boundSourceRunId || run.id === recoveryRow.recoveryRunId)
          ? mergeRecovery
          : null,
      })),
    });
  });
  app.get("/tasks/:taskId/startability", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const task = await db.task.findUnique({
      where: { id: taskId },
      include: {
        assigneeAgent: { select: { id: true, title: true, archivedAt: true } },
        repo: { select: { id: true, name: true, defaultBranch: true } },
      },
    });
    if (!task) return context.json({ error: "Task not found" }, 404);
    const [grant, budget, activeRuns, prefix] = await Promise.all([
      task.assigneeAgentId && task.repoId
        ? db.agentRepoAccess.findFirst({
          where: { projectId: task.projectId, agentId: task.assigneeAgentId, repoId: task.repoId },
          select: { agentId: true },
        })
        : null,
      db.run.aggregate({
        where: { taskId },
        _count: { _all: true },
        _max: { budgetGrants: true },
      }),
      db.run.count({ where: { taskId, status: { in: ACTIVE_RUN_STATUSES } } }),
      task.chainId && task.chainIndex !== null
        ? db.task.findMany({
          where: {
            projectId: task.projectId,
            chainId: task.chainId,
          },
          select: { id: true, name: true, status: true, chainIndex: true, chainLayer: true },
        })
        : [],
    ]);
    const blocker = blockingPredecessor(prefix, taskId);
    const verdict = taskStartability({
      ...task,
      hasRepoGrant: grant !== null,
    }, {
      total: budget._count._all,
      active: activeRuns > 0,
      budgetGrants: budget._max.budgetGrants,
    }, task.maxSessionsPerTask, blocker === null);
    return context.json({
      ...verdict,
      task: {
        id: task.id,
        name: task.name,
        agent: task.assigneeAgent ? { id: task.assigneeAgent.id, title: task.assigneeAgent.title } : null,
        repo: task.repo ? { id: task.repo.id, name: task.repo.name } : null,
        targetBranch: task.targetBranch ?? task.repo?.defaultBranch ?? null,
      },
    });
  });
  app.get("/tasks/:taskId/chain", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const subject = await db.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, chainId: true, chainIndex: true, status: true },
    });
    if (!subject) return context.json({ error: "Task not found" }, 404);
    if (!subject.chainId) return context.json({ chainId: null, total: 0, done: 0, steps: [] });

    const chainInclude = {
      assigneeAgent: { select: {
        id: true,
        title: true,
        archivedAt: true,
        repoAccess: { where: { projectId: subject.projectId }, select: { repoId: true } },
      } },
      templateStep: {
        select: {
          name: true,
          stepIndex: true,
          outputKind: true,
          taskTemplate: { select: { name: true } },
        },
      },
      runs: { orderBy: { runNumber: "desc" as const }, take: 1 },
    };
    // A chainId with a null chainIndex is a broken row the advancer already
    // refuses to follow. PostgreSQL sorts NULL last, so leaving it in the query
    // would render it at the bottom of somebody else's chain instead of as its
    // own one-row chain — and would shift every real row's position by one.
    const rows = subject.chainIndex === null
      ? [await db.task.findUniqueOrThrow({ where: { id: taskId }, include: chainInclude })]
      : await db.task.findMany({
        where: { projectId: subject.projectId, chainId: subject.chainId, chainIndex: { not: null } },
        orderBy: { chainIndex: "asc" },
        include: chainInclude,
      });

    const [runGroups, recoveryRow] = await Promise.all([
      rows.length === 0 ? [] : db.run.groupBy({
        by: ["taskId", "status"],
        where: { taskId: { in: rows.map((row) => row.id) } },
        _count: { _all: true },
        // The grants travel with the count, in the same one query: a step whose
        // failures were all provisioning failures has been refunded them, and its
        // Start button must say so.
        _max: { budgetGrants: true },
      }),
      db.mergeRecoveryAttempt.findFirst({
        where: { integratorTask: { projectId: subject.projectId, chainId: subject.chainId } },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    const mergeRecovery = mergeRecoveryProjection(recoveryRow);
    const facts = runFactsByTask(runGroups, ACTIVE_RUN_STATUSES);
    const ordinals = positions(rows);
    const progress = chainProgress(rows);
    const decisions = chainStartDecisions(rows.map((row) => ({
      ...row,
      hasRepoGrant: Boolean(row.repoId && row.assigneeAgent?.repoAccess.some((grant) => grant.repoId === row.repoId)),
    })), facts);

    return context.json({
      chainId: subject.chainId,
      total: progress?.total ?? rows.length,
      done: progress?.done ?? 0,
      steps: rows.map((row) => ({
        taskId: row.id,
        position: ordinals.get(row.id) ?? 1,
        chainIndex: row.chainIndex,
        layer: row.chainLayer,
        name: row.name,
        stepName: stepName(row),
        status: row.status,
        approvalGate: row.approvalGate,
        assigneeType: row.assigneeType,
        executionOwner: chainExecutionOwner(row),
        agent: row.assigneeAgent ? { id: row.assigneeAgent.id, title: row.assigneeAgent.title } : null,
        archivedAt: row.archivedAt,
        failureReason: row.failureReason,
        latestRun: row.runs[0]
          ? { id: row.runs[0].id, status: row.runs[0].status, runNumber: row.runs[0].runNumber }
          : null,
        startable: decisions.get(row.id)?.startable ?? false,
        startAction: decisions.get(row.id)?.startAction ?? null,
        currentExecution: decisions.get(row.id)?.currentExecution ?? false,
        mergeRecovery,
      })),
    });
  });
  app.patch("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, taskPatch);
    const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    if (before.chainId !== null && body.approvalGate !== undefined && body.approvalGate !== before.approvalGate) {
      return context.json({ error: "Approval gates on dispatched chain tasks are controlled by the chain" }, 409);
    }
    // Held for the whole route: whichever of the three write paths below runs
    // re-reads this assignee under the Agent-row mutex before it commits.
    const assignee = body.assigneeAgentId
      ? await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId: before.projectId } })
      : null;
    const effectiveAgentId = body.assigneeAgentId === undefined ? before.assigneeAgentId : body.assigneeAgentId;
    const effectiveAssigneeType = body.assigneeType ?? before.assigneeType;
    if (before.archivedAt === null
      && (body.assigneeType !== undefined || body.assigneeAgentId !== undefined)) {
      const [effectiveAgent, templateStep] = await Promise.all([
        effectiveAgentId
          ? db.agent.findFirst({ where: { id: effectiveAgentId, projectId: before.projectId } })
          : null,
        before.templateStepId
          ? db.taskTemplateStep.findUnique({
            where: { id: before.templateStepId },
            select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } },
          })
          : null,
      ]);
      if (!compoundImplementationAssigneeValid(
        before.projectId,
        effectiveAssigneeType,
        effectiveAgent,
        templateStep,
      )) {
        const error = new CompoundImplementationAssigneeError();
        return context.json({ error: error.message, code: error.code }, 409);
      }
    }
    if (body.assigneeAgentId) {
      if (!assignee) return context.json({ error: "Assignee does not belong to this project" }, 400);
      if (assignee.archivedAt) return context.json({ error: `Assignee ${assignee.name} is archived` }, 400);
    }
    if (body.repoId) {
      const repo = await db.repo.findFirst({ where: { id: body.repoId, projectId: before.projectId } });
      if (!repo) return context.json({ error: "Repo does not belong to this project" }, 400);
    }
    const effectiveRepoId = body.repoId === undefined ? before.repoId : body.repoId;
    if (effectiveAgentId && effectiveRepoId) {
      const access = await db.agentRepoAccess.findFirst({
        where: { agentId: effectiveAgentId, repoId: effectiveRepoId, projectId: before.projectId },
      });
      if (!access) return context.json({ error: "Assignee has no grant for this Repo" }, 400);
    }
    // §D-P4 on reassignment. `templateStepId` is not a patchable field, so the
    // step half of the pair cannot move under this check; the assignee half is
    // exactly what this route can move, in either direction — an ordinary task
    // onto the sentinel, or the integrator step off it onto a model agent.
    const reassignmentRefusal = await integratorBindingRefusalFor(db, {
      assigneeAgentName: effectiveAgentId
        ? (await db.agent.findUnique({ where: { id: effectiveAgentId }, select: { name: true } }))?.name ?? null
        : null,
      templateStepId: before.templateStepId,
    });
    if (reassignmentRefusal) return context.json({ error: reassignmentRefusal }, 400);
    const scheduleTouched = body.scheduleKind !== undefined || body.runAt !== undefined || body.cron !== undefined || body.timezone !== undefined;
    const atExecutorTouched = before.scheduleKind === ScheduleKind.AT
      && (body.assigneeType !== undefined || body.assigneeAgentId !== undefined || body.repoId !== undefined);
    let schedule;
    if (scheduleTouched || atExecutorTouched) {
      try {
        schedule = validateSchedule({
          scheduleKind: body.scheduleKind ?? before.scheduleKind ?? ScheduleKind.NOW,
          runAt: body.runAt === undefined ? before.runAt ?? null : body.runAt,
          cron: body.cron === undefined ? before.cron ?? null : body.cron,
          timezone: body.timezone === undefined ? before.timezone ?? null : body.timezone,
          assigneeType: effectiveAssigneeType,
          assigneeAgentId: effectiveAgentId,
          repoId: effectiveRepoId,
        });
      } catch (error: unknown) {
        return context.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, 400);
      }
    }
    const updateData = {
      ...withoutUndefined(body),
      ...(scheduleTouched ? schedule : {}),
    } as Prisma.TaskUncheckedUpdateInput;
    // A status write joins the Task-row mutex, like start / retry / archive /
    // the scheduler's claims. Two reasons, both proven by regression tests:
    //
    //  - Parking in Backlog must be atomic with `Start now`. Counting active
    //    runs outside a transaction and writing later loses the race, and the
    //    loss does not "resolve on completion": the runner claims only
    //    `TODO|DOING`, so a QUEUED run left on a BACKLOG task is never claimed
    //    and never completes.
    //  - Without the lock a status write can land *after* `archive-done`
    //    committed and drag an archived task back onto a board that does not
    //    show it — a guard set in which one writer ignores `archivedAt`
    //    excludes nothing.
    //
    // One rule, no exceptions: an archived task's status is frozen until it is
    // unarchived, whether or not the transition also advances a chain. Splitting
    // that by `advances` would let an archived chained task be marked DONE while
    // an archived standalone one could not.
    //
    // Every request that names a status takes this path, not only the ones that
    // look like a change against the unlocked `before` read. `before` is stale
    // by definition, so "status: TODO on a task that is already TODO" can land
    // on a row another writer has since parked or archived — and outside the
    // transaction it wrote that TODO back with no lock and no guard at all.
    if (body.status !== undefined) {
      const written = await db.$transaction(async (tx) => {
        const locked = await lockTaskMutationRows(tx, taskId);
        if (!locked) return { error: "Task not found", code: 404 as const };
        if (locked.archivedAt !== null) {
          return { error: "Cannot change the status of an archived task; unarchive it first", code: 409 as const };
        }
        // Task rows first, then the Agent row — the one global lock order.
        if (body.assigneeType !== undefined || body.assigneeAgentId !== undefined) {
          await assertCompoundImplementationAssignment(
            tx,
            locked,
            body.assigneeType ?? locked.assigneeType,
            body.assigneeAgentId === undefined ? locked.assigneeAgentId : body.assigneeAgentId,
          );
        }
        const blockedAssignment = await assignmentBlocked(tx, assignee);
        if (blockedAssignment) return { error: blockedAssignment, code: 400 as const };
        // Promoting BACKLOG or DONE history into TODO|DOING|REVIEW gives the
        // task back to whoever it is *already* assigned to, and that assignee is
        // in no request field for `assignmentBlocked` to have checked. So the
        // stored one joins the same protocol here, read under the Agent-row
        // mutex the locked Task row above already ordered us into. `locked` is
        // the authority on it, not the pre-transaction `before` read.
        //
        // 409, not the 400 above: nothing in the request is malformed — the
        // conflict is in the state of the assignee, which the operator can fix
        // and retry, exactly like Retry's archived-assignee refusal.
        if (body.assigneeAgentId === undefined
          && !isLiveStatus(locked.status)
          && body.status !== undefined
          && isLiveStatus(body.status)) {
          const blockedReactivation = await reactivationBlocked(tx, locked);
          if (blockedReactivation) return { error: blockedReactivation, code: 409 as const };
        }
        // Against `locked`, not `before`: a park is a park whenever the row this
        // transaction holds is not already in Backlog.
        if (body.status === TaskStatus.BACKLOG
          && locked.status !== TaskStatus.BACKLOG
          && await hasActiveRun(tx, taskId)) {
          return { error: "Cannot move a task with an active run to Backlog", code: 409 as const };
        }
        // §D-P7 / Step 5. The exclusivity guard, composed rather than
        // duplicated: while a recorded stop has no terminal-disposition answer,
        // this task does not move. Keyed on the disposition, not on an answer
        // existing, because `flag-incident` writes an answer and must still
        // hold the chain.
        const stopped = await stopStateFor(tx, taskId);
        if (stopped && body.status !== undefined && body.status !== locked.status) {
          return { error: stopStateRefusal(stopped), code: 409 as const };
        }
        let winningGateCard: { id: string; body: string; gateTaskId: string | null; sessionId: string | null } | null = null;
        let winningGateRunId: string | null = null;
        if (body.status === TaskStatus.DONE) {
          if (await hasActiveRun(tx, taskId)) {
            return { error: "Cannot mark a task done while it has an active run", code: 409 as const };
          }
          if (locked.chainId) {
            const chainRows = await tx.task.findMany({
              where: {
                projectId: locked.projectId,
                chainId: locked.chainId,
              },
              orderBy: [{ chainLayer: "asc" }, { chainIndex: "asc" }, { id: "asc" }],
              select: { id: true, name: true, status: true, chainIndex: true, chainLayer: true },
            });
            const blocker = blockingPredecessor(chainRows.map((row) => ({
              ...row,
              projectId: locked.projectId,
              chainId: locked.chainId,
              archivedAt: null,
              templateStep: null,
            })), taskId);
            if (blocker) {
              return {
                error: `Cannot complete ${before.name}; predecessor ${blocker.name} is not done`,
                code: 409 as const,
              };
            }
          }
          // A Human approval has one durable decision identity on both API
          // channels. The earliest OPEN card is the deterministic winner; the
          // gate Task lock above makes this selection and the Inbox route's OPEN
          // claim one compare-and-set rather than two competing decisions.
          winningGateCard = await tx.inboxMessage.findFirst({
            where: { gateTaskId: taskId, status: InboxStatus.OPEN },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, body: true, gateTaskId: true, sessionId: true },
          });
          if (winningGateCard) {
            const session = winningGateCard.sessionId
              ? await tx.session.findUnique({ where: { id: winningGateCard.sessionId }, select: { runId: true } })
              : null;
            if (!session?.runId) {
              return { error: "Gate card has no session run to bind a decision to", code: 409 as const };
            }
            winningGateRunId = session.runId;
            await tx.inboxMessage.update({
              where: { id: winningGateCard.id },
              data: { status: InboxStatus.ANSWERED, selectedChoiceId: "approve", answeredAt: new Date() },
            });
          }
          // This OPEN row is the gate-decision CAS. It deliberately depends on
          // neither templateId nor approvalGate: gate creation records the
          // relationship in gateTaskId, and that is the only authority here.
          const closed = await tx.inboxMessage.updateMany({
            where: { gateTaskId: taskId, status: InboxStatus.OPEN },
            data: { status: InboxStatus.CLOSED },
          });
          if (closed.count === 0 && !winningGateCard) {
            // A gate exists but none is OPEN only after another channel won or
            // this request is a replay. Do not overwrite a concurrent reject
            // or activate the successor a second time. No decision row is
            // created on this branch, and no authorization: the SPEC's
            // fail-closed resolution (missing-authorization) is preserved.
            const decidedGate = await tx.inboxMessage.count({ where: { gateTaskId: taskId } });
            if (decidedGate > 0) {
              return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
            }
          }
        }
        const statusChanged = body.status !== undefined && body.status !== locked.status;
        const updated = await tx.task.update({ where: { id: taskId }, data: updateData });
        let statusActivityId: string | null = null;
        if (statusChanged) {
          const statusActivity = await tx.taskActivity.create({ data: {
            taskId, actorType: "operator", body: `Status changed: ${locked.status} → ${body.status}`,
          } });
          statusActivityId = statusActivity.id;
        }
        let authorization: Awaited<ReturnType<typeof produceMergeAuthorization>> = null;
        if (winningGateCard) {
          const decisionRow = await tx.inboxDecision.create({ data: {
            inboxMessageId: winningGateCard.id,
            runId: winningGateRunId!,
            externalEventId: `patch:${taskId}:${statusActivityId ?? winningGateCard.id}`,
            decision: "approve",
            actorOpenId: "patch-operator",
          } });
          authorization = await produceMergeAuthorization(tx, {
            card: winningGateCard,
            inboxDecisionId: decisionRow.id,
            channel: "patch",
          }, new Date());
        }
        if (locked.status !== TaskStatus.DONE
          && body.status === TaskStatus.DONE
          && Boolean(updated.chainId)
          && authorization?.purpose !== "confirmation") {
          await activateChainSuccessor(tx, updated, { sourceRunId: null }, new Date());
        }
        return { task: updated };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if ("error" in written) return context.json({ error: written.error }, written.code);
      return context.json(written.task);
    }
    if (body.opensPullRequest !== undefined) {
      // The flag defines the next Run snapshot. PATCH must therefore share the
      // same Task-row serialization point as completion retries and lost-lease
      // requeues; otherwise a request that commits first can still be missed by
      // a creator holding a stale task relation.
      const updated = await db.$transaction(async (tx) => {
        const locked = await lockTaskMutationRows(tx, taskId);
        if (!locked) return { error: "Task not found", code: 404 as const };
        if (body.assigneeType !== undefined || body.assigneeAgentId !== undefined) {
          await assertCompoundImplementationAssignment(
            tx,
            locked,
            body.assigneeType ?? locked.assigneeType,
            body.assigneeAgentId === undefined ? locked.assigneeAgentId : body.assigneeAgentId,
          );
        }
        const blockedAssignment = await assignmentBlocked(tx, assignee);
        if (blockedAssignment) return { error: blockedAssignment, code: 400 as const };
        return { task: await tx.task.update({ where: { id: taskId }, data: updateData }) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if ("error" in updated) return context.json({ error: updated.error }, updated.code);
      return context.json(updated.task);
    }
    // A plain field edit that hands the task to an agent is still an assignment
    // writer, so it joins the same protocol: Task row first, Agent row second.
    if (assignee) {
      const written = await db.$transaction(async (tx) => {
        const locked = await lockTaskMutationRows(tx, taskId);
        if (!locked) return { error: "Task not found", code: 404 as const };
        await assertCompoundImplementationAssignment(
          tx,
          locked,
          body.assigneeType ?? locked.assigneeType,
          body.assigneeAgentId === undefined ? locked.assigneeAgentId : body.assigneeAgentId,
        );
        const blockedAssignment = await assignmentBlocked(tx, assignee);
        if (blockedAssignment) return { error: blockedAssignment, code: 400 as const };
        return { task: await tx.task.update({ where: { id: taskId }, data: updateData }) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if ("error" in written) return context.json({ error: written.error }, written.code);
      return context.json(written.task);
    }
    const written = await db.$transaction(async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return null;
      return tx.task.update({ where: { id: taskId }, data: updateData });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return written ? context.json(written) : context.json({ error: "Task not found" }, 404);
  });
  app.delete("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const deleted = await db.$transaction(async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return false;
      await tx.task.delete({ where: { id: taskId } });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (!deleted) return context.json({ error: "Task not found" }, 404);
    return context.body(null, 204);
  });
  app.post("/tasks/:taskId/retry", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      // Obtain the chain identity before taking any Task lock, then acquire the
      // complete chain in layer order. Locking one row first and expanding to
      // siblings would invert the completion transaction's Run -> chain order.
      const identity = await tx.task.findUnique({ where: { id: taskId }, select: { projectId: true, chainId: true } });
      if (!identity) return { error: "Task not found", code: 404 as const };
      if (identity.chainId) await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
      const locked = identity.chainId
        ? await tx.task.findUnique({ where: { id: taskId }, select: lockedTaskSelect })
        : await lockTask(tx, taskId);
      if (!locked) return { error: "Task not found", code: 404 as const };
      // Retry joins the exclusion protocol: a guard set in which one writer
      // ignores archivedAt excludes nothing.
      if (locked.archivedAt !== null) return { error: "Cannot retry an archived task", code: 409 as const };
      const task = await tx.task.findUnique({
        where: { id: taskId },
        include: {
          assigneeAgent: true,
          // The template name travels with the step because §D-P4's predicate
          // needs all four facts; a stepIndex and an outputKind alone collide
          // with any other template that uses the same step index.
          templateStep: { include: { taskTemplate: { select: { name: true } } } },
          repo: true,
          runs: { orderBy: { runNumber: "desc" }, take: 1 },
        },
      });
      if (!task) return { error: "Task not found", code: 404 as const };
      if (task.chainId && task.chainIndex !== null) {
        const chainRows = await tx.task.findMany({
          where: { projectId: task.projectId, chainId: task.chainId },
          orderBy: [{ chainLayer: "asc" }, { chainIndex: "asc" }, { id: "asc" }],
          select: { id: true, name: true, status: true, chainIndex: true, chainLayer: true },
        });
        const blocker = blockingPredecessor(chainRows.map((row) => ({
          ...row,
          projectId: task.projectId,
          chainId: task.chainId,
          archivedAt: null,
          templateStep: null,
        })), taskId);
        if (blocker) {
          return {
            error: `Cannot retry ${task.name}; predecessor ${blocker.name} is not done`,
            code: 409 as const,
          };
        }
      }
      const integratorStepShape = task.templateStep;
      const last = task.runs[0];
      if (!last) return { error: "Task has no run to retry", code: 409 as const };
      // Checked across ALL of the task's runs with the shared active set, not
      // the latest run's status alone: the old latest-only enum check missed
      // PROVISIONING and WAITING_INBOX, so a retry during a clone or a
      // 7-day Inbox suspension created a second concurrent run writing the
      // same task and chain branch.
      const activeRuns = await tx.run.count({ where: { taskId, status: { in: ACTIVE_RUN_STATUSES } } });
      if (activeRuns > 0) {
        return { error: "Task already has an active run", code: 409 as const };
      }
      const stoppedForRetry = await stopStateFor(tx, taskId);
      if (stoppedForRetry) return { error: stopStateRefusal(stoppedForRetry), code: 409 as const };
      // The same ceiling the Start gate uses, for the same reason: the budget an
      // operator configured now, plus what has been granted on top of it. The
      // old `last.maxRunsPerTask` could not tell a refund from a budget that had
      // since been lowered.
      if (last.runNumber >= runBudgetCeiling(task.maxSessionsPerTask, last.budgetGrants)) {
        return { error: "Run budget exhausted", code: 409 as const };
      }
      if (!task.assigneeAgent) {
        return { error: "Task assignee no longer exists; assign an agent before retrying", code: 409 as const };
      }
      // Retry builds its Run inline rather than through enqueueTaskRun, so it
      // takes the Agent-row mutex itself — Task row first, Agent row second.
      const lockedAgent = await lockAgentRow(tx, task.assigneeAgent.id);
      if (!lockedAgent || lockedAgent.archivedAt) {
        return { error: `Assignee ${task.assigneeAgent.name} is archived; unarchive it to retry`, code: 409 as const };
      }
      const currentBinding = integratorBindingRefusal(lockedAgent.name, integratorStepShape);
      if (currentBinding) return { error: currentBinding, code: 400 as const };
      const derived = deriveRunConfig(lockedAgent, task.templateStep, task);
      const subagent = nativeImplementationSubagentRunConfig(derived.runner, task.templateStep);
      // A task with no repo cannot be a chain step with a branch, and this route
      // already tolerates a null repoId — so it keeps inheriting run-1's fields.
      const branches = task.repo
        ? await resolveRunBranches(tx, { ...task, repo: task.repo }, last)
        : null;
      const run = await tx.run.create({
        data: {
          projectId: last.projectId,
          taskId,
          goalId: last.goalId,
          agentId: lockedAgent.id,
          repoId: task.repoId,
          runNumber: last.runNumber + 1,
          dedupeKey: makeDedupeKey(taskId, last.runNumber + 1),
          runner: derived.runner,
          model: derived.model,
          codexServiceTier: derived.codexServiceTier,
          ...subagent,
          targetBranch: branches ? branches.targetBranch : last.targetBranch,
          branch: branches ? branches.branch : last.branch,
          opensPullRequest: task.opensPullRequest,
          promptHash: derived.promptHash,
          maxDurationMin: last.maxDurationMin,
          stallTimeoutMin: last.stallTimeoutMin,
          maxRunsPerTask: runBudgetCeiling(task.maxSessionsPerTask, last.budgetGrants),
          budgetGrants: last.budgetGrants,
          readyAt: now,
        },
      });
      await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO, failureReason: null } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: `Run ${run.runNumber} queued by operator retry` } });
      return { run };
    });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.run, 201);
  });
  app.post("/tasks/:taskId/start", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const identity = await db.task.findUnique({
      where: { id: taskId }, select: { projectId: true, chainId: true },
    });
    if (!identity) return context.json({ error: "Task not found" }, 404);
    try {
      const result = await db.$transaction(async (tx) => {
        if (identity.chainId) {
          await lockChainRows(tx, {
            projectId: identity.projectId,
            chainId: identity.chainId,
          });
        } else if (!await lockTask(tx, taskId)) {
          return { error: "Task not found", code: 404 as const };
        }
        const task = await tx.task.findUniqueOrThrow({
          where: { id: taskId },
          include: {
            assigneeAgent: { select: { archivedAt: true } },
            templateStep: { include: { taskTemplate: { select: { name: true } } } },
          },
        });
        if (identity.chainId) {
          const prefix = await tx.task.findMany({
            where: {
              projectId: identity.projectId,
              chainId: identity.chainId,
            },
            orderBy: [{ chainLayer: "asc" }, { chainIndex: "asc" }, { id: "asc" }],
            select: { id: true, name: true, status: true, chainIndex: true, chainLayer: true },
          });
          const blocker = blockingPredecessor(prefix.map((row) => ({
            ...row,
            projectId: identity.projectId,
            chainId: identity.chainId,
            archivedAt: null,
            templateStep: null,
          })), taskId);
          if (blocker) {
            return {
              error: `Cannot start ${task.name}; predecessor ${blocker.name} is not done`,
              code: 409 as const,
            };
          }
        }
        if (task.archivedAt !== null) return { error: "Cannot start an archived task", code: 409 as const };
        if (task.status === TaskStatus.DONE) return { error: "Task is already done", code: 409 as const };
        if (task.assigneeType !== AssigneeType.AGENT) {
          return { error: "Human steps cannot be started", code: 409 as const };
        }
        if (isMergeReadinessStep(task.templateStep)) {
          return { error: "Merge readiness is server-owned and cannot be started as a model run", code: 409 as const };
        }
        if (await hasActiveRun(tx, taskId)) {
          return { error: "Task already has an active run", code: 409 as const };
        }
        // A count, not the latest run number: Run is one-to-many and a task at
        // its ceiling whose last run failed must not look startable.
        //
        // Measured against the configured budget *plus the grants on top of it*
        // rather than the budget alone (issue #113). A run that died
        // provisioning was refunded onto its own row, and this gate could not
        // see the refund: a task whose two failures were sub-second clone errors
        // answered "Run budget exhausted" here while `POST /tasks/:id/retry`,
        // reading the very same refund one route away, would have queued the
        // run. Reading the grant rather than the historical `maxRunsPerTask` is
        // what keeps a budget an operator has just *lowered* in force.
        const budget = await tx.run.aggregate({
          where: { taskId },
          _count: { _all: true },
          _max: { budgetGrants: true },
        });
        const facts = { total: budget._count._all, active: false, budgetGrants: budget._max.budgetGrants };
        if (facts.total >= runBudgetCeiling(task.maxSessionsPerTask, facts.budgetGrants)) {
          return { error: "Run budget exhausted", code: 409 as const };
        }
        // The specific messages above and below are a reason ladder in front of
        // the shared predicate, so the operator gets the sentence that names
        // their problem. `startable` itself is the authority: spec §4.3 defines
        // the button's enabled state and this guard as one thing, and the route
        // re-deriving them by hand was how it came to accept gated REVIEW steps
        // and DOING steps and to answer 500 on a task with no repo.
        if (task.status !== TaskStatus.TODO && task.status !== TaskStatus.BACKLOG) {
          return { error: "Only Todo and Backlog steps can be started", code: 409 as const };
        }
        if (!task.repoId) {
          return { error: "This task has no repository", code: 400 as const };
        }
        if (!task.assigneeAgentId) {
          return { error: "This task has no assignee", code: 400 as const };
        }
        const hasRepoGrant = await lockAgentRepoGrant(tx, {
          projectId: task.projectId,
          agentId: task.assigneeAgentId,
          repoId: task.repoId,
        });
        if (!hasRepoGrant) {
          return { error: "Assignee has no grant for this Repo", code: 400 as const };
        }
        if (!taskStartability({ ...task, hasRepoGrant }, facts, task.maxSessionsPerTask).startable) {
          // The one remaining `startable` condition with no message of its own
          // is the archived assignee, and `enqueueTaskRun` already throws an
          // error that names the agent — a better sentence than anything this
          // branch could write. Fall through to it; the catch maps it to 409.
          if (!task.assigneeAgent?.archivedAt) {
            return { error: "This step cannot be started", code: 409 as const };
          }
        }
        const run = await enqueueTaskRun(tx, taskId);
        const recovering = task.status === TaskStatus.BACKLOG;
        if (recovering) {
          await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO } });
        }
        await tx.taskActivity.create({ data: {
          taskId,
          actorType: "operator",
          body: task.chainId
            ? recovering ? "Recovered parked chain step manually" : "Started next chain step manually"
            : "Started task manually",
        } });
        return { run };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if ("error" in result) return context.json({ error: result.error }, result.code);
      return context.json({ runId: result.run.id, runNumber: result.run.runNumber }, 201);
    } catch (error: unknown) {
      if (isArchivedAssigneeError(error) || isArchivedTaskError(error) || isIntegratorStoppedError(error)) return context.json({ error: error.message }, 409);
      // Unreachable under the lock, because the loser sees the winner's run and
      // returns the 409 above. Mapped anyway: a 500 on a double-click is exactly
      // the failure the guard exists to prevent.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return context.json({ error: "Task already has an active run" }, 409);
      }
      throw error;
    }
  });
  app.post("/tasks/:taskId/archive", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await db.$transaction(async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return { error: "Task not found", code: 404 as const };
      if (await hasActiveRun(tx, taskId)) {
        return { error: "Cannot archive a task with an active run", code: 409 as const };
      }
      if (locked.status === TaskStatus.REVIEW) {
        const open = await tx.inboxMessage.count({ where: { gateTaskId: taskId, status: InboxStatus.OPEN } });
        if (open > 0) return { error: "Decide the approval gate in the Inbox first", code: 409 as const };
      }
      if (locked.archivedAt !== null) {
        return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
      }
      const task = await tx.task.update({ where: { id: taskId }, data: { archivedAt: new Date() } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Task archived" } });
      return { task };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.task);
  });
  app.post("/tasks/:taskId/unarchive", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    // This used to run unlocked, on the theory that unarchiving cannot race a
    // run into existence. It cannot — but archivedAt is the other half of what
    // makes a task live, so unarchiving a TODO|DOING|REVIEW row *is* a
    // reactivation and has to join the same protocol: Task row first, Agent row
    // second, decided on the state this transaction holds.
    //
    // Restoring DONE or BACKLOG history stays unconditional. Neither is claimed
    // by a runner or shown as work in progress, so an archived assignee cannot
    // strand them — and refusing them would make an agent's archival delete the
    // operator's ability to read their own history back onto the board.
    const result = await db.$transaction(async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return { error: "Task not found", code: 404 as const };
      if (locked.archivedAt === null) {
        return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
      }
      if (isLiveStatus(locked.status)) {
        const blocked = await reactivationBlocked(tx, locked);
        if (blocked) return { error: blocked, code: 409 as const };
      }
      const task = await tx.task.update({ where: { id: taskId }, data: { archivedAt: null } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Task unarchived" } });
      return { task };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.task);
  });
  app.post("/projects/:projectId/tasks/archive-done", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const result = await db.$transaction(async (tx) => {
      const candidates = await tx.task.findMany({
        where: { projectId, status: TaskStatus.DONE, archivedAt: null },
        select: { id: true, chainId: true },
      });
      // Lock before reading runs, so a retry cannot slip a run in between the
      // selection and the write. Ids that vanished, moved out of `Done` or were
      // archived in between simply do not come back from the lock and count as
      // neither archived nor skipped.
      const chainIds = [...new Set(candidates.flatMap((task) => task.chainId ? [task.chainId] : []))].sort();
      for (const chainId of chainIds) await lockChainRows(tx, { projectId, chainId });
      const standaloneIds = candidates.filter((task) => !task.chainId).map((task) => task.id);
      const lockedStandaloneIds = await lockDoneTasks(tx, projectId, standaloneIds);
      const chainedIds = candidates.filter((task) => task.chainId).map((task) => task.id);
      const stillDoneChained = chainedIds.length === 0 ? [] : await tx.task.findMany({
        where: { id: { in: chainedIds }, projectId, status: TaskStatus.DONE, archivedAt: null },
        select: { id: true },
      });
      const lockedIds = [...lockedStandaloneIds, ...stillDoneChained.map(({ id: chainedTaskId }) => chainedTaskId)];
      const busy = lockedIds.length === 0 ? [] : await tx.run.findMany({
        where: { taskId: { in: lockedIds }, status: { in: ACTIVE_RUN_STATUSES } },
        select: { taskId: true },
        distinct: ["taskId"],
      });
      const { archive, skipped } = partitionArchivable(
        lockedIds,
        busy.map((run) => run.taskId).filter((taskId): taskId is string => taskId !== null),
      );
      if (archive.length > 0) {
        await tx.task.updateMany({ where: { id: { in: archive } }, data: { archivedAt: new Date() } });
        await tx.taskActivity.createMany({ data: archive.map((taskId) => ({
          taskId, actorType: "operator", body: "Task archived",
        })) });
      }
      return { archived: archive.length, skipped };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return context.json(result);
  });
  app.post("/tasks/:taskId/schedule/pause", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await db.$transaction(async (tx) => {
      if (!await lockTaskMutationRows(tx, taskId)) return { error: "Task not found", code: 404 as const };
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { scheduleKind: true } });
      if (task.scheduleKind !== ScheduleKind.CRON) return { error: "Only CRON tasks can be paused", code: 400 as const };
      // In-flight copies are left alone: pausing stops future occurrences, it does
      // not reach into work that already started.
      const paused = await tx.task.update({ where: { id: taskId }, data: { schedulePausedAt: new Date() } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Schedule paused" } });
      return { task: paused };
    });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.task);
  });
  app.post("/tasks/:taskId/schedule/resume", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await db.$transaction(async (tx) => {
      if (!await lockTaskMutationRows(tx, taskId)) return { error: "Task not found", code: 404 as const };
      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { scheduleKind: true, cron: true, timezone: true },
      });
      if (task.scheduleKind !== ScheduleKind.CRON) return { error: "Only CRON tasks can be resumed", code: 400 as const };
      let runAt: Date;
      try {
        if (!task.cron) throw new Error("CRON tasks require cron");
        // Recomputed from *now*, so a long pause produces no catch-up burst.
        runAt = computeNextOccurrence(task.cron, task.timezone, new Date());
      } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : "Invalid schedule", code: 400 as const };
      }
      const resumed = await tx.task.update({ where: { id: taskId }, data: { schedulePausedAt: null, runAt } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Schedule resumed" } });
      return { task: resumed };
    });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.task);
  });
  app.get("/tasks/:taskId/recurring-fires", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const requested = Number(context.req.query("take") ?? 5);
    const take = Number.isSafeInteger(requested) ? Math.min(50, Math.max(1, requested)) : 5;
    const copies = await db.task.findMany({
      where: { recurringSourceTaskId: taskId },
      orderBy: { createdAt: "desc" },
      take,
      include: {
        runs: {
          orderBy: { runNumber: "desc" },
          take: 1,
          include: { session: { select: { id: true, costUsd: true } } },
        },
      },
    });
    return context.json(copies.map((copy) => ({
      taskId: copy.id,
      name: copy.name,
      createdAt: copy.createdAt,
      status: copy.status,
      latestRun: copy.runs[0] ? {
        id: copy.runs[0].id,
        status: copy.runs[0].status,
        runNumber: copy.runs[0].runNumber,
        session: copy.runs[0].session ? { id: copy.runs[0].session.id, costUsd: copy.runs[0].session.costUsd } : null,
      } : null,
    })));
  });
  app.get("/tasks/:taskId/activity", async (context) => context.json(await db.taskActivity.findMany({
    where: { taskId: id.parse(context.req.param("taskId")) },
    orderBy: { createdAt: "asc" },
  })));
  app.get("/tasks/:taskId/output", async (context) => {
    const output = await db.taskStepOutput.findUnique({ where: { taskId: id.parse(context.req.param("taskId")) } });
    return output ? context.json(output) : context.json({ error: "Task output not found" }, 404);
  });
  app.put("/tasks/:taskId/output", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, taskOutputInput);
    const result = await db.$transaction(async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return { error: "Task not found", code: 404 as const };
      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { templateStep: { select: {
          stepIndex: true,
          outputKind: true,
          taskTemplate: { select: { name: true } },
        } } },
      });
      const existing = await tx.taskStepOutput.findUnique({ where: { taskId } });
      const immutableReview = isCanonicalSolFindingsStep(task.templateStep)
        || isCanonicalBlindFindingsStep(task.templateStep)
        || isCanonicalAdjudicationStep(task.templateStep);
      if (immutableReview && existing) {
        return { error: `${task.templateStep?.outputKind ?? body.kind} task output is immutable once persisted`, code: 409 as const };
      }
      const output = await tx.taskStepOutput.upsert({
        where: { taskId },
        create: { taskId, kind: body.kind, body: body.body, commitSha: body.commitSha ?? null, ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
        update: { kind: body.kind, body: body.body, ...(body.commitSha ? { commitSha: body.commitSha } : {}), ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
      });
      return { output };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.output);
  });
  /**
   * §D-P8 — the only mutation that can change a `target-unresolvable` outcome.
   *
   * MF-8's defect was that `re-authorize` could not change the immutable run
   * rows the target is derived from, so every renewed run returned the same
   * stop. This route writes a durable, authenticated correction — and it is
   * constrained to pull request numbers the chain's own runs actually recorded,
   * recomputed inside the transaction, so a correction can select among what
   * the chain delivered and can never introduce a foreign pull request.
   */
  app.post("/tasks/:taskId/merge-target", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, mergeTargetInput);
    const result = await db.$transaction(async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return { error: "Task not found", code: 404 as const };
      const task = await loadIntegratorTask(tx, taskId);
      if (!task || !taskIsIntegratorStep(task)) {
        return { error: "Task is not a mechanical merge step", code: 409 as const };
      }
      const stopped = await stopStateFor(tx, taskId);
      if (!stopped) return { error: "Task is not in a merge stop state", code: 409 as const };
      if (stopped.stop.condition !== "target-unresolvable") {
        return { error: `Merge target correction applies to target-unresolvable only, not ${stopped.stop.condition}`, code: 409 as const };
      }
      if (!task.chainId) return { error: "Task is not part of a chain", code: 409 as const };
      const observed = await observedChainPullRequests(tx, task.projectId, task.chainId);
      if (observed.length === 0) {
        return {
          error: "This chain delivered no pull request; abandon it, or deliver the pull request by re-running the delivering step, after which resolution succeeds with no correction",
          code: 409 as const,
        };
      }
      if (!observed.includes(body.prNumber)) {
        return {
          error: `Pull request #${body.prNumber} is not among this chain's own delivered pull requests (${observed.join(", ")})`,
          code: 409 as const,
        };
      }
      const priorCorrection = await latestTargetCorrection(tx, taskId);
      const activity = await tx.taskActivity.create({ data: {
        taskId,
        actorType: "operator",
        body: `Merge target corrected to PR #${body.prNumber}`,
        metadata: jsonValue({
          kind: MERGE_INTEGRATOR_KIND.targetCorrection,
          schemaVersion: 1,
          chainId: task.chainId,
          prNumber: body.prNumber,
          observedSet: observed,
          supersedesActivityId: priorCorrection?.activityId ?? null,
        }),
      } });
      // The operator's next action is the ordinary "see the evidence, approve"
      // path: the correction alone authorizes nothing.
      let cardId: string;
      try {
        cardId = await requestConfirmationCard(tx, task, stopped.stop.stopId, new Date());
      } catch (error: unknown) {
        if (isMergeConfirmationError(error)) {
          return { error: error.message, code: 409 as const };
        }
        throw error;
      }
      return { correction: { id: activity.id, prNumber: body.prNumber, observed, confirmationCardId: cardId } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    return context.json(result.correction, 201);
  });

  app.post("/tasks/:taskId/activity", async (context) => {
    const body = await readJson(context.req.raw, activityInput);
    return context.json(await db.taskActivity.create({
      data: {
        taskId: id.parse(context.req.param("taskId")),
        actorType: "operator",
        actorId: body.actorId ?? null,
        body: body.body,
        ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}),
      },
    }), 201);
  });

  app.get("/inbox/messages", async (context) => {
    const projectId = context.req.query("projectId");
    return context.json(await db.inboxMessage.findMany({
    where: {
      replyToMessageId: null,
      ...(projectId ? { OR: [
        { agent: { projectId } },
        { task: { projectId } },
        { goal: { projectId } },
        { session: { projectId } },
      ] } : {}),
    },
    include: { decisions: true, replies: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
    }));
  });
  app.get("/inbox/messages/:messageId", async (context) => {
    const message = await db.inboxMessage.findUnique({
      where: { id: id.parse(context.req.param("messageId")) },
      include: {
        decisions: true,
        replies: { orderBy: { createdAt: "asc" } },
        replyTo: true,
      },
    });
    return message ? context.json(message) : context.json({ error: "Inbox message not found" }, 404);
  });
  app.post("/inbox/messages/:messageId/decision", async (context) => {
    const body = await readJson(context.req.raw, inboxDecisionInput);
    try {
      const mergeTail = await db.$transaction((tx) => applyMergeTailOperatorDecision(tx, {
        messageId: id.parse(context.req.param("messageId")),
        requestId: body.requestId,
        decision: body.decision,
        now: new Date(),
      }));
      if (mergeTail) {
        return mergeTail.error
          ? context.json({ error: mergeTail.error }, 409)
          : context.json(mergeTail, mergeTail.duplicate ? 200 : 201);
      }
      const result = await applyInboxDecision(db, {
        inboxMessageId: id.parse(context.req.param("messageId")),
        externalEventId: `web:${body.requestId}`,
        decision: body.decision,
        actorOpenId: "web-operator",
      });
      return context.json(result, result.duplicate ? 200 : 201);
    } catch (error: unknown) {
      if (isArchivedAssigneeError(error) || isArchivedTaskError(error) || isIntegratorStoppedError(error)
        || isMergeConfirmationError(error)) return context.json({ error: error.message }, 409);
      if (error instanceof Error && /(No matching|must be approve|must match|no executable)/i.test(error.message)) {
        return context.json({ error: error.message }, 409);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return context.json({ duplicate: true, resumed: false });
      }
      throw error;
    }
  });
  app.post("/inbox/messages/:messageId/reply", async (context) => {
    const body = await readJson(context.req.raw, inboxReplyInput);
    try {
      const result = await applyInboxDecision(db, {
        inboxMessageId: id.parse(context.req.param("messageId")),
        externalEventId: `web:${body.requestId}`,
        decision: body.body,
        actorOpenId: "web-operator",
        allowFreeText: true,
      });
      return context.json(result, result.duplicate ? 200 : 201);
    } catch (error: unknown) {
      if (isArchivedAssigneeError(error) || isArchivedTaskError(error) || isIntegratorStoppedError(error)
        || isMergeConfirmationError(error)) return context.json({ error: error.message }, 409);
      if (error instanceof Error && /(No matching|must be approve|no executable)/i.test(error.message)) {
        return context.json({ error: error.message }, 409);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return context.json({ duplicate: true, resumed: false });
      }
      throw error;
    }
  });
  app.post("/inbox/messages/:messageId/close", async (context) => {
    const body = await readJson(context.req.raw, inboxCloseInput);
    const messageId = id.parse(context.req.param("messageId"));
    const message = await db.inboxMessage.findUnique({
      where: { id: messageId },
      select: {
        status: true, from: true, kind: true, taskId: true, goalId: true,
        sessionId: true, gateTaskId: true, replyToMessageId: true,
      },
    });
    if (!message) return context.json({ error: "Inbox message not found" }, 404);
    const detachedNotification = message.from === "AGENT"
      && message.kind === "TEXT"
      && message.taskId === null
      && message.goalId === null
      && message.sessionId === null
      && message.gateTaskId === null
      && message.replyToMessageId === null;
    if (!detachedNotification) {
      return context.json({ error: "Only a detached agent notification can be closed without a decision" }, 409);
    }
    if (message.status === InboxStatus.CLOSED) {
      return context.json({ closed: false, duplicate: true, requestId: body.requestId });
    }
    if (message.status !== InboxStatus.OPEN) {
      return context.json({ error: "Only an open notification can be closed" }, 409);
    }
    const closed = await db.inboxMessage.updateMany({
      where: {
        id: messageId, status: InboxStatus.OPEN, from: "AGENT", kind: "TEXT",
        taskId: null, goalId: null, sessionId: null, gateTaskId: null, replyToMessageId: null,
      },
      data: { status: InboxStatus.CLOSED, answeredAt: new Date() },
    });
    if (closed.count !== 1) {
      const current = await db.inboxMessage.findUnique({ where: { id: messageId }, select: { status: true } });
      if (current?.status === InboxStatus.CLOSED) {
        return context.json({ closed: false, duplicate: true, requestId: body.requestId });
      }
      return context.json({ error: "Inbox message changed before it could be closed" }, 409);
    }
    return context.json({ closed: true, duplicate: false, requestId: body.requestId });
  });

  app.post("/runner/availability", async (context) => {
    const body = await readJson(context.req.raw, runnerAvailabilityInput);
    const now = new Date();
    const state = await runRunnerAvailabilityTransaction(db, async (tx) => {
      const previous = await tx.runnerBackendState.findUnique({ where: { runner: body.runner } });
      const previousAvailability = readStoredCliAvailability(previous?.capabilities);
      const availability = nextStoredCliAvailability(body, previousAvailability, now);
      if (!body.available) {
        const outageStarted = previousAvailability?.available !== false;
        const unavailable = await tx.runnerBackendState.upsert({
          where: { runner: body.runner },
          create: {
            runner: body.runner,
            capabilities: storeCliAvailability(null, availability),
          },
          update: {
            capabilities: storeCliAvailability(previous?.capabilities, availability),
          },
        });
        await tx.task.updateMany({
          where: {
            status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
            runs: { some: { runner: body.runner, status: RunStatus.QUEUED } },
          },
          data: { failureReason: availability.reason },
        });
        if (outageStarted) {
          const chatId = process.env.FEISHU_DEFAULT_CHAT_ID;
          const thread = chatId ? (
            await tx.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
            ?? await tx.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } }).catch(() => null)
          ) : null;
          await tx.inboxMessage.create({ data: {
            from: "AGENT",
            kind: "TEXT",
            body: `${body.runner.toLowerCase()} runner CLI is unavailable: ${body.binary} was not found in configured runner PATH.`,
            dedupeKey: availability.outageKey,
            ...(thread ? { threadId: thread.id } : {}),
          } });
        }
        return unavailable;
      }

      const available = await tx.runnerBackendState.upsert({
        where: { runner: body.runner },
        create: {
          runner: body.runner,
          capabilities: storeCliAvailability(null, availability),
        },
        update: {
          capabilities: storeCliAvailability(previous?.capabilities, availability),
        },
      });
      if (previousAvailability?.reason) {
        await tx.task.updateMany({
          where: { failureReason: previousAvailability.reason },
          data: { failureReason: null },
        });
      }
      if (previousAvailability?.outageKey) {
        await tx.inboxMessage.updateMany({
          where: { dedupeKey: previousAvailability.outageKey, status: InboxStatus.OPEN },
          data: { status: InboxStatus.CLOSED, answeredAt: now },
        });
      }
      return available;
    });
    const lastPreflightAt = state.lastPreflightAt?.getTime() ?? 0;
    const currentLease = preflightRecoveryLeases.get(body.runner) ?? 0;
    const revalidatePreflight = body.available
      && body.runnerId !== undefined
      && state.circuitOpen
      && now.getTime() - lastPreflightAt >= preflightRecoveryIntervalMs
      && currentLease <= now.getTime();
    if (revalidatePreflight) {
      preflightRecoveryLeases.set(body.runner, now.getTime() + preflightRecoveryIntervalMs);
    }
    return context.json({ ...state, revalidatePreflight });
  });

  app.post("/runner/preflight", async (context) => {
    const body = await readJson(context.req.raw, preflightInput);
    const now = new Date();
    const previous = await db.runnerBackendState.findUnique({ where: { runner: body.runner } });
    const state = await db.runnerBackendState.upsert({
      where: { runner: body.runner },
      create: {
        runner: body.runner,
        cliVersion: body.cliVersion ?? null,
        authMode: body.authMode ?? null,
        capabilities: preserveCliAvailability(body.capabilities, previous?.capabilities),
        lastPreflightAt: now,
        lastPreflightOk: body.ok,
        circuitOpen: !body.ok,
        circuitReason: body.ok ? null : body.error ?? "Preflight failed",
        circuitOpenedAt: body.ok ? null : now,
      },
      update: {
        cliVersion: body.cliVersion ?? null,
        authMode: body.authMode ?? null,
        capabilities: preserveCliAvailability(body.capabilities, previous?.capabilities),
        lastPreflightAt: now,
        lastPreflightOk: body.ok,
        ...(body.ok
          ? { circuitOpen: false, circuitReason: null, circuitOpenedAt: null, consecutiveAuthFailures: 0 }
          : { circuitOpen: true, circuitReason: body.error ?? "Preflight failed", circuitOpenedAt: now }),
      },
    });
    preflightRecoveryLeases.delete(body.runner);
    const blockedReason = body.error ?? "Preflight failed";
    if (body.ok) {
      if (previous?.circuitReason) {
        await db.task.updateMany({
          where: { failureReason: previous.circuitReason },
          data: { failureReason: null },
        });
      }
    } else {
      await db.task.updateMany({
        where: {
          status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
          runs: { some: { runner: body.runner, status: RunStatus.QUEUED } },
        },
        data: { failureReason: blockedReason },
      });
    }
    if (!body.ok && !previous?.circuitOpen) {
      // Attach the operator chat so the alert can actually leave the web Inbox;
      // threadless messages are skipped by the Feishu outbox forever.
      const chatId = process.env.FEISHU_DEFAULT_CHAT_ID;
      const thread = chatId ? (
        await db.inboxThread.findFirst({ where: { channel: "FEISHU", externalChatId: chatId, sessionId: null } })
        ?? await db.inboxThread.create({ data: { channel: "FEISHU", externalChatId: chatId } }).catch(() => null)
      ) : null;
      await db.inboxMessage.create({
        data: {
          from: "AGENT",
          kind: "TEXT",
          body: `${body.runner.toLowerCase()} runner preflight failed and its circuit is open: ${body.error ?? "unknown error"}`,
          ...(thread ? { threadId: thread.id } : {}),
        },
      });
    }
    return context.json(state);
  });

  /**
   * Workspace GC, runner-owned (issue #115).
   *
   * The runner reports what is in its root; the API answers with the subset it
   * has published a reclaim intent for. The control plane never reads or writes
   * that filesystem — this route only marks rows and returns names — so a
   * database pointed at the wrong root can no longer delete anything. An old
   * runner that never calls this simply leaves its directories in place, which
   * is the failure direction this design chooses on purpose.
   */
  app.post("/runner/workspaces/reclaimable", async (context) => {
    const body = await readJson(context.req.raw, reclaimInventoryInput);
    const retention = Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10);
    const plan = await publishReclaimIntents(db, body, Number.isFinite(retention) ? retention : 2);
    return context.json(plan);
  });

  app.post("/runner/workspaces/reclaimed", async (context) => {
    const body = await readJson(context.req.raw, reclaimReportInput);
    return context.json(await recordReclaimOutcomes(db, body));
  });

  app.post("/runner/workspaces/salvaged", async (context) => {
    const body = await readJson(context.req.raw, reclaimSalvageInput);
    const repair = await acknowledgeReclaimSalvage(db, body);
    return repair === false
      ? context.json({ error: "Salvage publication is not authorized by an open reclaim intent" }, 409)
      : repair === "already-started"
        ? context.json({ error: "Salvage is durable, but the replacement already started from its prior base" }, 409)
        : context.json({ ok: true, replacementRepair: repair });
  });

  app.post("/runner/tasks/claim", async (context) => {
    const body = await readJson(context.req.raw, claimInput);
    const principal = context.get("principal");
    // §D-P1 rule 3. `runnerId` is a label the caller writes about itself; the
    // bearer it presented is the only thing that can carry mechanical authority.
    const claimantClass = principal.kind === "merge-executor" ? "merge-executor" : "runner";
    const now = new Date();
    runners.note(body.runnerId, body, now);
    await options.ownership.assertHeld();
    await reconcileDatabaseRuns(db, now, releaseChainLease);
    await noteArchivedQueuedRunsOnClaim(now).catch((error: unknown) => console.error("Archived-run notice failed", error));
    const claimOnce = () => db.$transaction(async (tx) => {
      // This is the shared half of the production deploy barrier. It is the
      // first statement in the claim transaction: an in-flight claim finishes
      // before a deploy can acquire the exclusive half, and claims arriving
      // during a deploy return no work without observing candidates.
      if (!await deployBarrierAllowsClaim(tx)) return null;
      const candidates = await tx.run.findMany({
        where: {
          status: RunStatus.QUEUED,
          readyAt: { lte: now },
          agent: { archivedAt: null },
          // `archivedAt: null` is defense in depth: `enqueueTaskRun` already
          // refuses an archived task, and archive already refuses a task with an
          // active run, so a queued run on an archived task should be
          // unreachable. If one ever exists it must not be handed to a runner.
          task: {
            status: { in: [TaskStatus.TODO, TaskStatus.DOING] },
            assigneeType: AssigneeType.AGENT,
            archivedAt: null,
          },
          OR: [{ blockedByRunId: null }, { blockedBy: { status: RunStatus.SUCCEEDED } }],
        },
        include: {
          // templateStep travels with the claim so delivery can title the PR
          // after the chain rather than the step it happens to be running.
          // §D-P4 / §D-P1 rule 3 need all four identity facts of the step, not
          // only its display name: the claim transaction is where
          // `executionMode` is computed and where a mis-bound candidate is
          // skipped rather than handed out.
          task: { include: { templateStep: { include: { taskTemplate: { select: { name: true } } } } } },
          repo: true,
          session: true,
          agent: {
            include: {
              secretGrants: { include: { secret: true } },
              environment: { include: { secrets: { include: { secret: true } } } },
              repoAccess: true,
            },
          },
        },
        orderBy: [{ readyAt: "asc" }, { createdAt: "asc" }],
        take: 20,
      });
      const executorRunnerIds = mergeExecutorRunnerIds();
      let adjudicationRefusal: string | null = null;
      for (const candidate of candidates) {
        if (!candidate.task || !candidate.repo) continue;
        if (!candidate.agent.repoAccess.some((grant) => grant.repoId === candidate.repoId && grant.projectId === candidate.projectId)) {
          const reason = "repository-grant-missing: restore the agent Repo grant, then retry this run";
          const stranded = await tx.run.updateMany({
            where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
            data: {
              status: RunStatus.FAILED,
              failureClass: FailureClass.TASK_FAILED,
              failureReason: reason,
              retryable: false,
              endedAt: now,
            },
          });
          if (stranded.count === 1) {
            await lockTaskMutationRows(tx, candidate.task.id);
            await tx.task.update({
              where: { id: candidate.task.id },
              data: { status: TaskStatus.BACKLOG, failureReason: reason },
            });
            await tx.taskActivity.create({
              data: {
                taskId: candidate.task.id,
                actorType: "control-plane",
                body: "Queued run stopped because its repository grant is missing; restore the grant and retry",
                metadata: { runId: candidate.id, condition: "repository-grant-missing" },
              },
            });
            // A chained park expands the lock order from this Run to every Task
            // in the chain. End the transaction here: scanning another
            // candidate could next wait on a sibling Run while its claimant
            // already holds that Run and waits for this chain mutex.
            if (candidate.task.chainId) return null;
          }
          continue;
        }
        // §D-P4. A candidate whose (agent, step) binding is invalid is *skipped*,
        // not claimed: a mis-bound step-12 row must never be handed to anything,
        // and the sentinel Agent on an ordinary step must never reach an adapter.
        if (integratorBindingRefusal(candidate.agent.name, candidate.task.templateStep)) continue;
        // Readiness is server-owned. Even if an old/manual path materializes a
        // Run row for it, no model runner or merge executor may claim it; the
        // readiness worker consumes the TODO task row directly.
        if (isMergeReadinessStep(candidate.task.templateStep)) continue;
        const executionMode = executionModeFor(candidate.task.templateStep);
        // §D-P1 rule 3, symmetric and fail-closed: only the independently
        // authenticated merge-executor principal is offered an integrator run,
        // and it is offered nothing else. With `MERGE_EXECUTOR_RUNNER_IDS`
        // empty — the shipped default — or with `MERGE_EXECUTOR_TOKEN` unset or
        // aliased onto the runner token, no integrator run is claimable at all.
        if (!claimantMayTake(executionMode, claimantClass, body.runnerId, executorRunnerIds)) continue;
        // The backend circuit breaker tracks model-CLI health. A mechanical run
        // spawns no CLI, so an open CLI circuit is not evidence about it; the
        // `runner` on its row is an inert artifact of the sentinel Agent.
        if (executionMode === "agent") {
          const backend = await tx.runnerBackendState.findUnique({ where: { runner: candidate.runner } });
          if (readStoredCliAvailability(backend?.capabilities)?.available === false || backend?.circuitOpen) continue;
        }
        if (executionMode === "mechanical") {
          const targetBranch = candidate.task.targetBranch ?? candidate.repo.defaultBranch;
          // Serialize only the claim transition for one repository target. The
          // lock is transaction-scoped: the committed active Run is the durable
          // exclusion fact, while later work remains QUEUED. Different targets
          // take different keys and do not participate in one another's lock.
          const lockKey = `merge-integrator:${candidate.repoId}:${targetBranch}`;
          const [targetLock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS "locked"
          `;
          if (targetLock?.locked !== true) continue;
          const activePeers = await tx.run.findMany({
            where: {
              id: { not: candidate.id },
              repoId: candidate.repoId,
              status: { in: activeRunStatuses },
              task: { targetBranch },
            },
            select: {
              task: { include: {
                templateStep: { include: { taskTemplate: { select: { name: true } } } },
              } },
            },
          });
          if (activePeers.some((peer) => taskIsIntegratorStep(peer.task))) continue;
        }
        const regressionRepairHandoff = await regressionRepairHandoffForClaim(tx, {
          taskId: candidate.task.id,
          projectId: candidate.projectId,
          repoId: candidate.repo.id,
          runId: candidate.id,
          runNumber: candidate.runNumber,
          branch: candidate.branch,
          outputKind: candidate.task.templateStep?.outputKind ?? null,
        });
        if (regressionRepairHandoff.status === "invalid") {
          const stopped = await tx.run.updateMany({
            where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
            data: {
              status: RunStatus.FAILED,
              failureClass: FailureClass.TASK_FAILED,
              failureReason: regressionRepairHandoff.reason,
              retryable: false,
              endedAt: now,
            },
          });
          if (stopped.count === 1) {
            await lockTaskMutationRows(tx, candidate.task.id);
            await tx.task.update({
              where: { id: candidate.task.id },
              data: { status: TaskStatus.REVIEW, failureReason: regressionRepairHandoff.reason },
            });
            await tx.taskActivity.create({ data: {
              taskId: candidate.task.id,
              actorType: "control-plane",
              body: `Fresh Regression Run stopped: ${regressionRepairHandoff.reason}`,
              metadata: {
                kind: MERGE_TAIL_KIND.repairResult,
                schemaVersion: 1,
                state: "handoff-invalid",
                runId: candidate.id,
                previousRunId: regressionRepairHandoff.previousRunId,
                reason: regressionRepairHandoff.reason,
              },
            } });
            const sourceSession = await tx.session.findUnique({
              where: { runId: regressionRepairHandoff.previousRunId },
              select: { id: true },
            });
            await openMergeTailStopNotice(tx, {
              taskId: candidate.task.id,
              agentId: candidate.agentId,
              ...(sourceSession ? { sessionId: sourceSession.id } : {}),
              reason: regressionRepairHandoff.reason,
            });
            if (candidate.task.chainId) return null;
          }
          continue;
        }
        const grants = [
          ...candidate.agent.environment.secrets,
          ...candidate.agent.secretGrants,
        ].filter(({ secret }) => !secret.disabledAt);
        const grantedEnvironmentVariables = new Set<string>();
        for (const { envVar } of grants) {
          if (["OPERATOR_TOKEN", "RUNNER_TOKEN", "AGENTOS_API_TOKEN", "AGENTOS_SESSION_TOKEN", "AGENTOS_FENCING_TOKEN"].includes(envVar)) {
            throw new Error(`Secret grant may not override reserved principal variable ${envVar}`);
          }
          if (grantedEnvironmentVariables.has(envVar)) throw new Error(`Duplicate effective secret envVar ${envVar}`);
          grantedEnvironmentVariables.add(envVar);
        }
        const adjudicationTask = isCanonicalAdjudicationStep(candidate.task.templateStep);
        if (adjudicationTask) {
          // Adjudication consumes evidence owned by sibling Tasks. Hold the
          // candidate Run first, then the sole complete-chain mutex, and only
          // validate the pinned range and reports after both locks are held.
          // Every sibling status/output writer takes that same chain mutex, so
          // the evidence cannot change between validation and the claim CAS.
          await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${candidate.id} FOR UPDATE`;
          const lockedRun = await tx.run.findUnique({
            where: { id: candidate.id },
            select: { status: true, leaseGeneration: true, taskId: true },
          });
          if (lockedRun?.status !== RunStatus.QUEUED
            || lockedRun.leaseGeneration !== candidate.leaseGeneration
            || lockedRun.taskId !== candidate.task.id) continue;
          if (!await lockTaskMutationRows(tx, candidate.task.id)) continue;
        }
        let implementationRange: Awaited<ReturnType<typeof pinnedImplementationRange>>;
        try {
          implementationRange = await pinnedImplementationRange(tx, candidate.task);
          if (implementationRange && implementationRange.implementationHeadSha !== candidate.targetBranch) {
            throw new PinnedRunTargetError(
              candidate.id,
              candidate.targetBranch,
              implementationRange.implementationHeadSha,
            );
          }
        } catch (error: unknown) {
          if (!isCandidateActivationFailure(error)) throw error;
          const reason = namedFailureReason(error);
          const stopped = await tx.run.updateMany({
            where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
            data: {
              status: RunStatus.FAILED,
              failureClass: FailureClass.TASK_FAILED,
              failureReason: reason,
              retryable: false,
              endedAt: now,
            },
          });
          if (stopped.count === 1) {
            await lockTaskMutationRows(tx, candidate.task.id);
            await tx.task.update({
              where: { id: candidate.task.id },
              data: { status: TaskStatus.BACKLOG, failureReason: reason },
            });
            await tx.taskActivity.create({
              data: {
                taskId: candidate.task.id,
                actorType: "control-plane",
                body: `Queued run activation failed: ${reason}`,
                metadata: {
                  runId: candidate.id,
                  condition: "candidate-activation-failed",
                  failureType: error.name,
                  reason,
                },
              },
            });
            const dedupeKey = `candidate-activation-failed:${candidate.id}`;
            await tx.inboxMessage.upsert({
              where: { dedupeKey },
              create: {
                from: "AGENT",
                agentId: candidate.agentId,
                taskId: candidate.task.id,
                kind: "TEXT",
                body: `Queued run activation failed and the task was parked in Backlog: ${reason}`,
                dedupeKey,
              },
              update: {},
            });
            if (candidate.task.chainId) return null;
          }
          continue;
        }
        const reviewClaimRefusal = await reviewAdjudicationClaimRefusal(tx, {
          task: candidate.task,
          implementationBaseSha: implementationRange?.implementationBaseSha ?? null,
          implementationHeadSha: implementationRange?.implementationHeadSha ?? null,
        });
        if (reviewClaimRefusal) {
          adjudicationRefusal = reviewClaimRefusal;
          continue;
        }
        const generation = candidate.leaseGeneration + 1;
        const fencingToken = makeFencingToken(candidate.id, generation);
        const sessionCredential = issueSessionToken();
        const leaseExpiresAt = new Date(now.getTime() + body.leaseSeconds * 1000);
        const won = await tx.run.updateMany({
          where: { id: candidate.id, status: RunStatus.QUEUED, leaseGeneration: candidate.leaseGeneration },
          data: {
            status: RunStatus.CLAIMED,
            runnerId: body.runnerId,
            leaseGeneration: generation,
            fencingToken,
            heartbeatAt: now,
            lastProcessAliveAt: now,
            leaseExpiresAt,
            claimedAt: now,
            sessionTokenHash: sessionCredential.hash,
            sessionTokenExpiresAt: new Date(now.getTime() + candidate.maxDurationMin * 60_000),
            sessionTokenRevokedAt: null,
          },
        });
        if (won.count !== 1) continue;
        if (!adjudicationTask) await lockTaskMutationRows(tx, candidate.task.id);
        const priorResume = !adjudicationTask && candidate.session?.resumeInput && candidate.session.providerConversationId ? {
          providerConversationId: candidate.session.providerConversationId,
          input: candidate.session.resumeInput,
        } : null;
        const session = candidate.session ? await tx.session.update({
          where: { id: candidate.session.id },
          data: {
            executionStatus: SessionExecutionStatus.PROVISIONING,
            cleanupStatus: CleanupStatus.PENDING,
            requestedAt: now,
            endedAt: null,
            failureReason: null,
            ...(adjudicationTask ? {
              providerConversationId: null,
              resumeInput: null,
              resumableUntil: null,
              waitingOnMessageId: null,
              resumeAttempt: 0,
            } : {}),
          },
        }) : await tx.session.create({ data: {
            runId: candidate.id,
            projectId: candidate.projectId,
            agentId: candidate.agentId,
            taskId: candidate.taskId,
            goalId: candidate.goalId,
            runner: candidate.runner,
            executionStatus: SessionExecutionStatus.PROVISIONING,
            maxDurationMin: candidate.maxDurationMin,
            stallTimeoutMin: candidate.stallTimeoutMin,
          } });
        const latestEvent = await tx.sessionEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } });
        await tx.task.update({ where: { id: candidate.task.id }, data: { status: TaskStatus.DOING, failureReason: null } });
        await tx.taskActivity.create({
          data: {
            taskId: candidate.task.id,
            actorType: "runner",
            actorId: body.runnerId,
            body: `Run ${candidate.runNumber} claimed with fencing generation ${generation}`,
          },
        });
        const secrets: Record<string, string> = {};
        for (const { envVar, secret } of grants) {
          secrets[envVar] = decryptSecret(secret.encryptedValue, secret.ciphertextVersion);
        }
        const run = await tx.run.findUniqueOrThrow({ where: { id: candidate.id } });
        const previousRunHandoff = await previousRunHandoffForClaim(tx, {
          taskId: candidate.task.id,
          runId: candidate.id,
          runNumber: candidate.runNumber,
          templateStep: candidate.task.templateStep,
        });
        const chainFirstRun = candidate.task.chainId && candidate.task.chainIndex !== null
          ? await tx.run.findFirst({
            where: {
              repoId: candidate.repo.id,
              task: {
                projectId: candidate.task.projectId,
                chainId: candidate.task.chainId,
                chainIndex: { not: null },
              },
            },
            select: { targetBranch: true },
            orderBy: [{ task: { chainIndex: "asc" } }, { runNumber: "asc" }],
          })
          : null;
        const blindReviewTask = isCanonicalBlindFindingsStep(candidate.task.templateStep);
        const priorOutputsRaw = !blindReviewTask
          && candidate.task.chainId && candidate.task.chainIndex !== null
          && (candidate.task.templateStepId === null || candidate.task.templateStep?.attachmentsFromPrevious !== false)
          ? await tx.taskStepOutput.findMany({
            where: { task: {
              projectId: candidate.task.projectId,
              chainId: candidate.task.chainId,
              chainIndex: { lt: candidate.task.chainIndex },
            } },
            select: { kind: true, body: true, task: { select: { name: true, chainIndex: true } } },
            orderBy: { task: { chainIndex: "asc" } },
          })
          : [];
        // Persisted outputs are chain authority, not activity previews. A
        // silent tail slice can remove schemas, state machines, and approval
        // assumptions while still presenting the remainder as complete. The
        // write endpoint already caps each artifact at 500k; pass the durable
        // body verbatim until artifact references replace prompt embedding.
        const priorOutputs = priorOutputsRaw;
        const targetBranchPublished = run.targetBranch !== null && await tx.run.findFirst({
          where: {
            repoId: candidate.repo.id,
            pushedBranch: run.targetBranch,
            task: candidate.task.chainId && candidate.task.chainIndex !== null
              ? {
                projectId: candidate.task.projectId,
                chainId: candidate.task.chainId,
                chainIndex: { not: null },
              }
              : { id: candidate.task.id },
          },
          select: { id: true },
        }) !== null;
        return {
          task: candidate.task,
          agent: candidate.agent,
          repo: candidate.repo,
          // Server-computed from the template step. Nothing a client sends
          // participates, and the ordinary runner refuses `mechanical` before it
          // constructs a workspace, a prompt, or a child environment.
          executionMode,
          // A later chain run targets the shared head, so its own targetBranch
          // cannot tell delivery which integration line the chain started
          // from. Carry the first run's durable base separately for PR create.
          run: {
            ...run,
            targetBranchPublished,
            pullRequestBase: chainFirstRun?.targetBranch ?? candidate.repo.defaultBranch,
            pinnedBaseSha: candidate.task.templateStep?.baseFromStepIndex == null ? null : run.targetBranch,
            implementationBaseSha: implementationRange?.implementationBaseSha ?? null,
            implementationHeadSha: implementationRange?.implementationHeadSha ?? null,
          },
          session,
          runner: candidate.runner,
          fencingToken,
          sessionToken: sessionCredential.token,
          secrets,
          priorOutputs,
          previousRunHandoff,
          regressionRepairHandoff: regressionRepairHandoff.status === "ok"
            ? regressionRepairHandoff.handoff
            : null,
          resume: priorResume,
          nextEventSeq: (latestEvent._max.seq ?? -1) + 1,
        };
      }
      return adjudicationRefusal ? { error: adjudicationRefusal } : null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    let claimed: Awaited<ReturnType<typeof claimOnce>> = null;
    // Two runners claiming independent chains still touch the same Task pages
    // through the `FOR UPDATE` chain mutex, and Serializable can abort either
    // one on a read/write dependency it cannot order. Losing that race is not a
    // claim failure -- the work is still queued -- so retry the whole
    // transaction. Matching only P2034 missed the raw-statement half, which
    // arrives as P2010 carrying SQLSTATE 40001, and that escaped as a 500.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        claimed = await claimOnce();
        break;
      } catch (error: unknown) {
        if (!isSerializationConflict(error) || attempt === 6) throw error;
        await serializationRetryDelay(attempt);
      }
    }
    if (claimed && "error" in claimed) return context.json({ error: claimed.error }, 409);
    return claimed ? context.json(claimed) : context.body(null, 204);
  });

  app.post("/runner/runs/:runId/start", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, startInput);
    const now = new Date();
    const started = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${runId} FOR UPDATE`;
      const updated = await tx.run.updateMany({
        where: {
          id: runId,
          runnerId: body.runnerId,
          fencingToken: body.fencingToken,
          cancelRequestedAt: null,
          leaseExpiresAt: { gt: now },
          status: { in: [RunStatus.CLAIMED, RunStatus.PROVISIONING] },
        },
        data: {
          status: RunStatus.RUNNING,
          startedAt: now,
          adapterVersion: body.adapterVersion,
          cliVersion: body.cliVersion,
          authMode: body.authMode ?? null,
          manifest: jsonValue(body.manifest),
          workspacePath: body.workspacePath,
          branch: body.branch ?? null,
          baseSha: body.baseSha ?? null,
        },
      });
      if (updated.count !== 1) return false;
      const session = await tx.session.updateMany({
        where: { runId, executionStatus: SessionExecutionStatus.PROVISIONING },
        data: {
          executionStatus: SessionExecutionStatus.RUNNING,
          runtimeHandle: body.runtimeHandle ?? null,
          resumeInput: null,
          provisionedAt: now,
          startedAt: now,
        },
      });
      if (session.count !== 1) throw new Error(`Run ${runId} has no startable Session`);
      return true;
    });
    return started ? context.json({ ok: true }) : context.json({ error: "Stale fencing token" }, 409);
  });

  app.post("/runner/runs/:runId/heartbeat", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, heartbeatInput);
    const now = new Date();
    runners.note(body.runnerId, body, now);
    const updated = await db.run.updateMany({
      where: {
        id: runId,
        runnerId: body.runnerId,
        fencingToken: body.fencingToken,
        cancelRequestedAt: null,
        leaseExpiresAt: { gt: now },
        status: { in: activeRunStatuses },
      },
      data: {
        heartbeatAt: now,
        ...(body.processAlive ? {
          lastProcessAliveAt: now,
          leaseExpiresAt: new Date(now.getTime() + body.leaseSeconds * 1000),
        } : {}),
        ...(body.lastProgressEventAt !== undefined ? { lastProgressEventAt: body.lastProgressEventAt } : {}),
        ...(body.inFlightTool !== undefined ? { inFlightTool: body.inFlightTool ? jsonValue(body.inFlightTool) : Prisma.JsonNull } : {}),
      },
    });
    if (updated.count === 1) return context.json({
      ok: true,
      cancellation: null,
      mechanicalCancellationPolicy: "refused",
    });
    const cancelling = await db.run.findFirst({
      where: {
        id: runId,
        runnerId: body.runnerId,
        fencingToken: body.fencingToken,
        status: { in: activeRunStatuses },
        cancelRequestedAt: { not: null },
      },
      select: { cancelRequestId: true, cancelReason: true, cancelRequestedAt: true },
    });
    if (cancelling?.cancelRequestId && cancelling.cancelReason && cancelling.cancelRequestedAt) {
      return context.json({
        ok: false,
        mechanicalCancellationPolicy: "refused",
        cancellation: {
          requestId: cancelling.cancelRequestId,
          reason: cancelling.cancelReason,
          requestedAt: cancelling.cancelRequestedAt,
        },
      });
    }
    const waiting = await db.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
    return waiting
      ? context.json({ error: "Run suspended for Inbox", code: "WAITING_INBOX" }, 409)
      : context.json({ error: "Stale fencing token" }, 409);
  });

  app.post("/runner/runs/:runId/cancel/acknowledge", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, cancelAcknowledgeInput);
    const result = await db.$transaction((tx) => settleCancellation(tx, {
      runId,
      requestId: body.requestId,
      runnerId: body.runnerId,
      fencingToken: body.fencingToken,
      actorId: body.runnerId,
      now: new Date(),
      ...(body.workspacePath === undefined ? {} : { workspacePath: body.workspacePath }),
      ...(body.branch === undefined ? {} : { branch: body.branch }),
      ...(body.baseSha === undefined ? {} : { baseSha: body.baseSha }),
    }));
    if ("error" in result) return context.json({ error: result.error }, result.code);
    const { releaseMergeLeaseTask, ...settlement } = result;
    await releaseMergeLeaseSafely(releaseChainLease, releaseMergeLeaseTask);
    return context.json(settlement);
  });

  // Publication is a separate durable fact from terminal completion. Persist
  // it immediately after git push, before GitHub work and cleanup, so a lost
  // runner does not make the reconciler forget a branch that already exists.
  app.post("/runner/runs/:runId/publication", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, publicationInput);
    const now = new Date();
    const run = await db.run.findUnique({
      where: { id: runId },
      select: {
        runnerId: true, fencingToken: true, leaseExpiresAt: true, status: true,
        taskId: true, repoId: true, runNumber: true, pushedBranch: true, branch: true,
        cancelRequestedAt: true,
      },
    });
    const owned = run?.runnerId === body.runnerId && run.fencingToken === body.fencingToken;
    const live = owned && run.cancelRequestedAt === null && run.leaseExpiresAt !== null && run.leaseExpiresAt > now
      && activeRunStatuses.includes(run.status as typeof activeRunStatuses[number]);
    // Salvage is the one publication allowed after lease loss. It is confined
    // to this run's deterministic per-run ref, requires the same runner and
    // fencing token that owned the workspace, and cannot replace a different
    // publication already acknowledged for the run. Git durability does not
    // depend on a live platform lease; making its ACK depend on one used to
    // leave a pushed recovery ref invisible to the resolver.
    const salvageBranch = run?.taskId
      ? `agentos/${run.taskId}/run-${run.runNumber}`
      : null;
    const salvage = owned && run?.repoId !== null
      && body.pushedBranch === salvageBranch
      && (run?.pushedBranch === null || run?.pushedBranch === body.pushedBranch);
    if (!live && !salvage) return context.json({ error: "Stale fencing token" }, 409);
    const updated = await db.$transaction(async (tx) => {
      const ack = await tx.run.updateMany({
        where: {
          id: runId,
          runnerId: body.runnerId,
          fencingToken: body.fencingToken,
          ...(live
            ? { cancelRequestedAt: null, leaseExpiresAt: { gt: now }, status: { in: activeRunStatuses } }
            : { OR: [{ pushedBranch: null }, { pushedBranch: body.pushedBranch }] }),
        },
        data: { pushedBranch: body.pushedBranch },
      });
      if (ack.count !== 1 || !salvage || !run?.taskId) return { count: ack.count, repair: "none" as const };
      const repair = await repairReplacementAfterSalvage(tx, {
        taskId: run.taskId,
        runNumber: run.runNumber,
        branch: run.branch,
      });
      return { count: ack.count, repair };
    });
    return updated.count === 1 && updated.repair !== "already-started"
      ? context.json({ ok: true, replacementRepair: updated.repair })
      : updated.count === 1
        ? context.json({ error: "Salvage is durable, but the replacement already started from its prior base" }, 409)
      : context.json({ error: "Stale fencing token" }, 409);
  });

  // Cleanup is still runner-owned after the live lease is gone. This endpoint
  // can update only cleanup bookkeeping for the exact runner/fence that owned
  // an expired or terminal run; it cannot change the run outcome or publish a
  // branch.
  app.post("/runner/runs/:runId/cleanup", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, leaseIndependentCleanupInput);
    const now = new Date();
    const run = await db.run.findUnique({
      where: { id: runId },
      select: { runnerId: true, fencingToken: true, leaseExpiresAt: true, status: true },
    });
    const expiredOrTerminal = run && (
      run.leaseExpiresAt === null || run.leaseExpiresAt <= now
      || !activeRunStatuses.includes(run.status as typeof activeRunStatuses[number])
    );
    if (!run || run.runnerId !== body.runnerId || run.fencingToken !== body.fencingToken || !expiredOrTerminal) {
      return context.json({ error: "Cleanup outcome is not authorized for a live or foreign run" }, 409);
    }
    await db.$transaction(async (tx) => {
      await tx.run.update({
        where: { id: runId },
        data: { workspaceRetained: body.workspaceRetained },
      });
      await tx.session.updateMany({
        where: { runId },
        data: {
          cleanupStatus: body.cleanupStatus,
          cleanupEndedAt: now,
          cleanupFailureReason: body.cleanupFailureReason ?? null,
        },
      });
    });
    return context.json({ ok: true });
  });

  app.post("/runner/runs/:runId/events", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, eventsInput);
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${runId} FOR UPDATE`;
      const run = await tx.run.findFirst({
        where: { id: runId, runnerId: body.runnerId, fencingToken: body.fencingToken, cancelRequestedAt: null, leaseExpiresAt: { gt: new Date() }, status: { in: activeRunStatuses } },
        include: { session: true },
      });
      if (!run?.session) {
        const waiting = await tx.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
        return waiting
          ? { error: "Run suspended for Inbox", code: "WAITING_INBOX" as const }
          : { error: "Stale fencing token", code: "STALE" as const };
      }
      await tx.sessionEvent.createMany({
        data: body.events.map((event) => ({
          sessionId: run.session!.id,
          runId,
          seq: event.seq,
          at: event.at ?? new Date(),
          source: event.source,
          type: normalizeSessionEventValue(event.type) as string,
          providerEventId: event.providerEventId === undefined || event.providerEventId === null
            ? null
            : normalizeSessionEventValue(event.providerEventId) as string,
          toolCallId: event.toolCallId === undefined || event.toolCallId === null
            ? null
            : normalizeSessionEventValue(event.toolCallId) as string,
          payload: jsonValue(normalizeSessionEventValue(event.payload)),
        })),
        skipDuplicates: true,
      });
      if (body.providerConversationId && !run.session.providerConversationId) {
        await tx.session.update({ where: { id: run.session.id }, data: { providerConversationId: body.providerConversationId } });
      }
      return { sessionId: run.session.id };
    });
    if ("error" in result) {
      return result.code === "WAITING_INBOX"
        ? context.json({ error: result.error, code: result.code }, 409)
        : context.json({ error: result.error }, 409);
    }
    // Recompute on "a FINAL_OUTPUT arrived", not "this payload had usage": a batch
    // whose event was already stored still recomputes, which is what self-heals a
    // write lost between createMany and here. The guard reads the request body
    // already in memory, so a batch without one costs zero extra queries.
    // Never fatal to the ingest. A throw here would 500 the route, and
    // `appendEvents` has no retry (runner/src/api.ts:79), so the terminal flush
    // would reject, `deliverWorkspace`/`completeRun` would be skipped, and the
    // runner's outer catch would record a successful run as failed and delete
    // its workspace unpushed. These columns are a derived cache that the next
    // FINAL_OUTPUT or `db:backfill-session-usage` repairs (db/src/usage.ts).
    // `recomputeSessionUsage` now waits on a per-session advisory lock, so a
    // lock-wait timeout is one more throw this catch absorbs — same repair path.
    if (body.events.some((event) => event.type === "FINAL_OUTPUT")) {
      try {
        await recomputeSessionUsage(db, result.sessionId);
      } catch (error) {
        console.error(`Session usage recompute failed for ${result.sessionId}`, error);
      }
    }
    return context.json({ accepted: body.events.length });
  });

  const appendFencedActivity = async (context: Context<AppEnvironment, string>) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, fencedActivityInput);
    const principal = context.get("principal");
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${runId} FOR UPDATE`;
      const run = await tx.run.findFirst({
        where: {
          id: runId,
          fencingToken: body.fencingToken,
          cancelRequestedAt: null,
          leaseExpiresAt: { gt: new Date() },
          status: { in: activeRunStatuses },
          ...(principal.kind === "runner" ? {} : { leaseGeneration: principal.kind === "session" ? principal.leaseGeneration : -1 }),
        },
        select: {
          taskId: true,
          task: { select: { templateStep: { select: {
            stepIndex: true,
            outputKind: true,
            taskTemplate: { select: { name: true } },
          } } } },
        },
      });
      if (!run?.taskId) return null;
      const metadata = body.metadata
        ? {
            ...body.metadata,
            ...(((body.metadata.kind === MERGE_INTEGRATOR_KIND.intent
              || body.metadata.kind === MERGE_INTEGRATOR_KIND.result)
              && executionModeFor(run.task?.templateStep ?? null) === "mechanical")
              ? { sourceRunId: runId }
              : {}),
          }
        : undefined;
      return tx.taskActivity.create({
        data: {
          taskId: run.taskId,
          actorType: principal.kind,
          actorId: body.actorId ?? null,
          body: body.body,
          ...(metadata ? { metadata: jsonValue(metadata) } : {}),
        },
      });
    });
    return result ? context.json(result, 201) : context.json({ error: "Stale fencing token" }, 409);
  };
  app.post("/runner/runs/:runId/activity", appendFencedActivity);
  app.post("/session/runs/:runId/activity", appendFencedActivity);

  // The agent's own view of its run: what it is working on, what budget is left,
  // and what the prior chain steps produced. Read-only, session-scoped.
  /**
   * SPEC §8.4 — the merge executor's only read path.
   *
   * Three narrowing axes, all server-side, plus §D-P2's validation. The route
   * returns *validated authorizations*, never raw activity metadata: the
   * executor cannot be handed a forged record to reason about, because the
   * reasoning happens here against rows no client can write.
   */
  app.get("/session/runs/:runId/chain/steps/:chainIndex/activity", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const requestedIndex = Number(context.req.param("chainIndex"));
    if (!Number.isInteger(requestedIndex)) return context.json({ error: "chainIndex must be an integer" }, 400);
    const run = await db.run.findUnique({ where: { id: runId }, select: { taskId: true } });
    if (!run?.taskId) return context.json({ error: "Run not found" }, 404);
    const caller = await loadIntegratorTask(db, run.taskId);
    if (!caller) return context.json({ error: "Run not found" }, 404);
    if (isCanonicalBlindFindingsStep(caller.templateStep)) {
      return context.json({ error: "Forbidden: blind review sessions cannot read predecessor or sibling review activity" }, 403);
    }
    // Eligibility: only the mechanical step may read across the chain at all.
    if (!taskIsIntegratorStep(caller)) return context.json({ error: "Forbidden for this step" }, 403);
    if (caller.chainId === null || caller.chainIndex === null) return context.json({ error: "Run is not part of a chain" }, 404);
    const ownIndex = caller.chainIndex;
    if (requestedIndex !== ownIndex && requestedIndex !== ownIndex - 1) {
      return context.json({ error: "Only this step and its predecessor are addressable" }, 403);
    }
    const subject = requestedIndex === ownIndex
      ? caller
      : await db.task.findFirst({
        where: { projectId: caller.projectId, chainId: caller.chainId, chainIndex: requestedIndex },
      });
    if (!subject) return context.json({ error: "No task at that chain index" }, 404);

    const target = await resolveChainTarget(db, caller);
    const activities = await db.taskActivity.findMany({
      where: { taskId: subject.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true, actorType: true, metadata: true },
    });

    if (requestedIndex === ownIndex) {
      // The caller's own history: intent and result rows only. Operator notes
      // and every non-contractual row stay on the server.
      const own = activities.filter((row) => {
        const kind = (row.metadata as Record<string, unknown> | null)?.kind;
        return kind === MERGE_INTEGRATOR_KIND.intent || kind === MERGE_INTEGRATOR_KIND.result;
      });
      return context.json({
        chainIndex: requestedIndex,
        target,
        records: own.map((row) => ({
          id: row.id, createdAt: row.createdAt, actorType: row.actorType, payload: row.metadata,
        })),
      });
    }

    // The predecessor: authorizations, and only after validation.
    const candidates: CandidateActivity[] = activities;
    const cards = await db.inboxMessage.findMany({
      where: { gateTaskId: subject.id },
      select: { id: true, gateTaskId: true, status: true, selectedChoiceId: true, body: true },
    });
    const decisions = await db.inboxDecision.findMany({
      where: { inboxMessageId: { in: cards.map((card) => card.id) } },
      select: { id: true, decision: true, createdAt: true, inboxMessageId: true },
    });
    const selection = selectAuthorization(candidates, decisions as DecisionRow[], cards as CardRow[], subject.id);
    return context.json({
      chainIndex: requestedIndex,
      target,
      authorization: selection.authorization,
      nearMatchCount: selection.nearMatchCount,
      ignoredCount: selection.ignoredCount,
      refusal: selection.refusal,
    });
  });

  app.get("/session/runs/:runId/status", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const run = await db.run.findUnique({
      where: { id: runId },
      include: { task: { include: { stepOutput: true, templateStep: { select: { name: true, outputKind: true } } } } },
    });
    if (!run) return context.json({ error: "Run not found" }, 404);
    return context.json({
      run: {
        id: run.id,
        runNumber: run.runNumber,
        maxRunsPerTask: run.maxRunsPerTask,
        status: run.status,
        startedAt: run.startedAt,
        maxDurationMin: run.maxDurationMin,
        stallTimeoutMin: run.stallTimeoutMin,
        branch: run.branch,
        targetBranch: run.targetBranch,
      },
      task: run.task ? {
        id: run.task.id,
        name: run.task.name,
        status: run.task.status,
        approvalGate: run.task.approvalGate,
        chainIndex: run.task.chainIndex,
        stepName: run.task.templateStep?.name ?? null,
        outputKind: run.task.templateStep?.outputKind ?? null,
        outputPersisted: run.task.stepOutput !== null,
      } : null,
    });
  });

  app.put("/session/runs/:runId/output", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, taskOutputInput);
    if (!body.fencingToken) return context.json({ error: "fencingToken is required" }, 400);
    const run = await db.run.findFirst({
      where: { id: runId, fencingToken: body.fencingToken, cancelRequestedAt: null, leaseExpiresAt: { gt: new Date() }, status: { in: activeRunStatuses } },
      select: {
        taskId: true,
        runnerId: true,
        // §4.0. The step-12 output is the only evidence the chain has that a
        // merge happened, so writing one is bound to the executor identity as
        // well as to the session token: a session issued to anything but an
        // allowlisted merge executor cannot author a `merge-result`, and the
        // executor's session cannot author an ordinary step's output.
        task: { select: {
          id: true,
          projectId: true,
          chainId: true,
          chainIndex: true,
          templateStep: { select: {
            stepIndex: true,
            outputKind: true,
            baseFromStepIndex: true,
            taskTemplate: { select: { name: true } },
          } },
        } },
      },
    });
    if (!run?.taskId) return context.json({ error: "Stale fencing token" }, 409);
    const executionMode = executionModeFor(run.task?.templateStep ?? null);
    if (executionMode !== "mechanical" && !body.commitSha) {
      return context.json({ error: "commitSha is required" }, 400);
    }
    const outputRefusal = mechanicalPrincipalRefusal(
      executionMode,
      isMergeExecutorRunnerId(run.runnerId ?? "") ? "merge-executor" : "runner",
      run.runnerId ?? "",
    );
    if (outputRefusal) return context.json({ error: outputRefusal }, 403);
    const persisted = await db.$transaction((tx) => persistSessionTaskOutput(tx, {
      task: run.task!,
      runId,
      fencingToken: body.fencingToken!,
      kind: body.kind,
      body: body.body,
      commitSha: body.commitSha ?? null,
      ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}),
    }));
    if (!persisted.ok) return context.json({ error: persisted.reason }, 409);
    return context.json({ ...persisted.output, predecessorOutputs: persisted.predecessorOutputs });
  });

  app.post("/session/runs/:runId/inbox/questions", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, inboxQuestionInput);
    const chatId = body.chatId ?? process.env.FEISHU_DEFAULT_CHAT_ID;
    if (!chatId) return context.json({ error: "chatId or FEISHU_DEFAULT_CHAT_ID is required" }, 400);
    try {
      const question = await suspendForInbox(db, {
        runId,
        chatId,
        fencingToken: body.fencingToken,
        requestId: body.requestId,
        body: body.body,
        choices: body.choices,
        ...(body.resumableUntil !== undefined ? { resumableUntil: body.resumableUntil } : {}),
      });
      return context.json(question, 201);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith("Run is not resumable")) return context.json({ error: error.message }, 409);
      throw error;
    }
  });

  const sessionFileAccess = async (runId: string, operation: FileOperation, path: string): Promise<Response | null> => {
    const run = await db.run.findUnique({ where: { id: runId }, select: { agentId: true } });
    if (!run) return new Response(JSON.stringify({ error: "Run not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const grants = await db.filesystemGrant.findMany({ where: { agentId: run.agentId } }) as GrantLike[];
    const store = await getFileStore();
    const admission = await grantAdmits(grants, operation, path, (value) => store.grantKey(value));
    return admission.admitted
      ? null
      : new Response(JSON.stringify({ error: `Filesystem grant missing ${admission.missing}` }), { status: 403, headers: { "Content-Type": "application/json" } });
  };

  app.get("/session/runs/:runId/files", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const path = context.req.query("dir") ?? "";
    try {
      const denied = await sessionFileAccess(runId, "list", path);
      if (denied) return denied;
      return context.json(await (await getFileStore()).list(path));
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.get("/session/runs/:runId/files/content", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const path = context.req.query("path") ?? "";
    try {
      const denied = await sessionFileAccess(runId, "read", path);
      if (denied) return denied;
      const store = await getFileStore();
      const file = await store.stat(path);
      if (!file) throw new NotFoundError(`Path not found: ${path}`);
      if (file.size > SESSION_READ_LIMIT) return context.json({ error: "File is too large for a tool result (5 MB limit)" }, 413);
      const bytes = await store.read(path);
      try {
        return context.json({ content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8", stat: file });
      } catch {
        return context.json({ content: bytes.toString("base64"), encoding: "base64", stat: file });
      }
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.put("/session/runs/:runId/files/content", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    try {
      // Bounded read, not a Content-Length pre-check: a chunked body declares no length,
      // so trusting the header let an agent materialize an unbounded body before the
      // decoded-size check below ever ran. Same treatment as the operator upload route.
      const body = sessionWriteInput.parse(JSON.parse(
        (await readBoundedBody(context.req.raw, SESSION_BASE64_BODY_LIMIT)).toString(),
      ));
      const denied = await sessionFileAccess(runId, "write", body.path);
      if (denied) return denied;
      const bytes = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
      if (bytes.byteLength > FILE_WRITE_LIMIT) return context.json({ error: "File exceeds 25 MB decoded write limit" }, 413);
      return context.json(await (await getFileStore()).write(body.path, bytes));
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.delete("/session/runs/:runId/files", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const path = context.req.query("path") ?? "";
    try {
      const denied = await sessionFileAccess(runId, "delete", path);
      if (denied) return denied;
      await (await getFileStore()).delete(path);
      return context.json({ ok: true });
    } catch (error: unknown) {
      const response = fileErrorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post("/runner/runs/:runId/complete", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, completionInput);
    const principal = context.get("principal");
    const now = new Date();
    // §4.0. Completing a mechanical run is what makes the chain believe a merge
    // happened, so it is bound to the same independently authenticated
    // principal that was allowed to claim it — and, symmetrically, the executor
    // credential completes nothing else. Read before the transaction: the
    // step binding of a claimed run is immutable (§D-P4 refuses to move it), so
    // there is no state to lose by refusing here, and nothing has been written.
    const completing = await db.run.findUnique({
      where: { id: runId },
      select: { runnerId: true, task: { select: { templateStep: { select: { stepIndex: true, outputKind: true, taskTemplate: { select: { name: true } } } } } } },
    });
    if (completing) {
      const refusal = mechanicalPrincipalRefusal(
        executionModeFor(completing.task?.templateStep ?? null),
        principal.kind === "merge-executor" ? "merge-executor" : "runner",
        completing.runnerId ?? body.runnerId,
      );
      if (refusal) return context.json({ error: refusal }, 403);
    }
    const result = await db.$transaction(async (tx) => {
      // Run owns fencing, cancellation, and terminalization. Take that mutex
      // before Task so completion, cancellation, and canonical output writes
      // cannot deadlock by entering the same two rows in opposite orders.
      await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${runId} FOR UPDATE`;
      const run = await tx.run.findFirst({
        where: { id: runId, runnerId: body.runnerId, fencingToken: body.fencingToken, cancelRequestedAt: null, leaseExpiresAt: { gt: now }, status: { in: activeRunStatuses } },
        include: {
          // §D-P5. The step's template name is part of the step-12 identity, so
          // the completion route has to read it rather than the step alone.
          task: { include: { templateStep: { include: { taskTemplate: { select: { name: true } } } }, repo: { select: { defaultBranch: true } } } },
          session: true,
        },
      });
      if (!run?.session) return null;
      const succeeded = completionSucceeded({
        exitCode: body.exitCode,
        signal: body.signal ?? null,
        terminalEventSeen: body.terminalEventSeen,
        terminalSuccess: body.terminalSuccess,
        terminationReason: body.terminationReason ?? null,
      });
      // The runner is on the untrusted side of this boundary. When it reports a
      // structured envelope, the API classifies from the facts in it and
      // ignores the runner's own `failureClass`/`retryable`/`externalFailure`
      // — before this, `body.retryable ?? …` meant the runner always won and
      // the retry whitelist in execution.ts was dead code, so a stdout-derived
      // misverdict of RATE_LIMITED spent the task's whole run budget on retries
      // that could not succeed.
      //
      // A runner too old to send an envelope, or one sending a version this API
      // does not know, keeps the previous behaviour verbatim. That is the point
      // of the version check: an unrecognised shape must not be half-read.
      const known = body.failureEnvelope?.version === FAILURE_ENVELOPE_VERSION
        ? failureEnvelopeV1Input.safeParse(body.failureEnvelope)
        : null;
      const envelope = !succeeded && known?.success ? known.data : null;
      const verdict = envelope ? classifyEnvelope(envelope) : null;
      const failureClass = succeeded
        ? null
        : verdict?.failureClass ?? body.failureClass ?? (body.exitCode === 0 ? FailureClass.PROTOCOL_ERROR : FailureClass.TASK_FAILED);
      const retryable = failureClass
        ? verdict?.retryable ?? body.retryable ?? failureIsRetryable(failureClass)
        : false;
      const retryAt = failureClass && retryable ? new Date(now.getTime() + retryDelayMs(run.runNumber, failureClass)) : null;
      // An external failure buys the task one more attempt rather than spending one.
      const external = verdict
        ? verdict.externalFailure
        : externalFailure({ succeeded, signal: body.signal ?? null, reported: body.externalFailure, failureClass });
      // §D-P5 / MF-5. For the integrator step that compensation is switched off
      // entirely, so the answer transaction is the *only* writer of a ceiling
      // above the task's original. Otherwise a run authorized once could buy
      // itself unbounded further attempts by failing externally, and "only a
      // human re-authorization may exceed the ceiling" would be false in a
      // reachable interleaving rather than merely hard to reach. The failure
      // envelope's verdict decides *whether* the failure was external; it does
      // not get to raise the ceiling on this step either.
      const mechanical = isIntegratorStep(run.task?.templateStep ?? null);
      const tailRows = succeeded && run.task
        && !run.task.templateId && !run.task.chainId
        ? await tx.taskActivity.findMany({
            where: { taskId: run.task.id },
            select: { metadata: true },
            orderBy: { createdAt: "desc" },
            take: 20,
          })
        : [];
      const repairMarker = tailRows.map((row) => asJsonObject(row.metadata)).find((metadata) => (
        metadata?.kind === MERGE_TAIL_KIND.repairAttempt && typeof metadata.regressionTaskId === "string"
      ));
      const reviewMarker = tailRows.map((row) => asJsonObject(row.metadata)).find((metadata) => (
        metadata?.kind === MERGE_TAIL_KIND.reviewObligation
        && metadata.state === "open"
        && typeof metadata.readinessTaskId === "string"
        && typeof metadata.regressionTaskId === "string"
      ));
      const repairRegression = typeof repairMarker?.regressionTaskId === "string"
        ? await tx.task.findUnique({
            where: { id: repairMarker.regressionTaskId },
            select: {
              projectId: true,
              chainId: true,
              templateId: true,
              chainIndex: true,
              templateStep: { select: { stepIndex: true, taskTemplate: { select: { name: true } } } },
            },
          })
        : null;
      const reviewRegression = typeof reviewMarker?.regressionTaskId === "string"
        ? await tx.task.findUnique({
            where: { id: reviewMarker.regressionTaskId },
            select: { chainId: true },
          })
        : null;
      const repairDocumentationTask = repairRegression?.chainId && repairRegression.templateId
        && repairRegression.chainIndex === 11
        && repairRegression.templateStep?.stepIndex === 11
        && repairRegression.templateStep.taskTemplate.name === INTEGRATOR_TEMPLATE_NAME
        ? await tx.task.findFirst({
            where: {
              projectId: repairRegression.projectId,
              chainId: repairRegression.chainId,
              templateId: repairRegression.templateId,
              chainIndex: 10,
              archivedAt: null,
              templateStep: { stepIndex: 10, outputKind: "documentation" },
            },
            orderBy: { chainIndex: "desc" },
            select: { id: true },
          })
        : null;
      const mergeTailAuxiliary = Boolean(repairMarker || reviewMarker);
      const auxiliaryTargetTaskId = typeof repairMarker?.regressionTaskId === "string"
        ? repairDocumentationTask?.id ?? repairMarker.regressionTaskId
        : typeof reviewMarker?.readinessTaskId === "string"
          ? reviewMarker.readinessTaskId
          : null;
      const refunded = external && !mechanical ? 1 : 0;
      const budgetCeiling = run.maxRunsPerTask + refunded;
      // The same refund, recorded apart from the ceiling it produced. The gates
      // an operator can reach read this rather than `maxRunsPerTask`, because
      // only this can still be told apart from the configured budget after that
      // budget changes. The in-flight ceiling stays derived from the run's own
      // row: a task's budget being edited mid-run must not retroactively refuse
      // an attempt already authorized.
      const budgetGrants = run.budgetGrants + refunded;
      const tailLeaseChainId = run.task?.chainId ?? repairRegression?.chainId ?? reviewRegression?.chainId ?? null;
      let releaseMergeLeaseTask: string | null = null;
      // Completion always mutates its Task, including terminal non-retryable
      // failures. Run is already locked above; acquire the Task/chain mutex now
      // for every outcome rather than only the branches that may retry or
      // advance.
      if (run.task) {
        if (run.task.chainId) {
          await lockChainRows(tx, { projectId: run.task.projectId, chainId: run.task.chainId });
        } else {
          await lockTask(tx, run.task.id);
        }
      }
      if (auxiliaryTargetTaskId && auxiliaryTargetTaskId !== run.task?.id) {
        await lockTaskMutationRows(tx, auxiliaryTargetTaskId);
      }
      if (run.task && typeof (tx.task as { findUnique?: unknown }).findUnique === "function") {
        await tx.task.findUnique({ where: { id: run.task.id }, select: { status: true } });
      }
      // Keep the status observed with the fenced Run as the compare-and-set
      // expectation. The locked re-read above supplies current chain state,
      // but adopting its newer status as the expectation would let completion
      // overwrite an operator decision that won while completion waited for
      // the mutex (for example DONE -> REVIEW on a successful standalone run).
      const completionTaskStatus = run.task?.status;
      const terminalStatus = succeeded
        ? RunStatus.SUCCEEDED
        : body.terminationReason?.includes("walltime") || body.terminationReason?.includes("stall")
          ? RunStatus.TIMED_OUT
          : RunStatus.FAILED;
      const closed = await tx.run.updateMany({
        where: { id: runId, fencingToken: body.fencingToken, cancelRequestedAt: null, leaseExpiresAt: { gt: now }, status: { in: activeRunStatuses } },
        data: {
          status: terminalStatus,
          endedAt: now,
          leaseExpiresAt: null,
          sessionTokenRevokedAt: now,
          failureClass,
          failureReason: succeeded ? null : body.failureReason ?? "Execution failed",
          retryable,
          retryAt,
          // Stored whether or not this API understood it: an envelope from a
          // future runner is still the evidence of what happened, and the
          // reason a verdict can be re-decided later instead of re-run.
          failureEnvelope: succeeded || !body.failureEnvelope ? Prisma.DbNull : jsonValue(body.failureEnvelope),
          // Kept on the run that produced it, whatever became of that run. The
          // same tail used to reach this route on every completion and be read
          // only by the step-output synthesis below, which runs for successful
          // template/chain/follow-up runs and nothing else — so a failure's own
          // account of itself died in this handler and the incident could only
          // be guessed at afterwards. A runner too old to send one leaves NULL,
          // exactly as before.
          output: body.output ?? null,
          terminationReason: body.terminationReason ?? null,
          branch: body.branch ?? run.branch,
          // Completion is a second publication write, never an eraser of the
          // immediate post-push ACK recorded on this run.
          pushedBranch: body.pushedBranch ?? run.pushedBranch,
          baseSha: body.baseSha ?? run.baseSha,
          headSha: body.headSha ?? null,
          pushStatus: body.pushStatus,
          pushRemote: body.pushRemote ?? null,
          pushError: body.pushError ?? null,
          pullRequestUrl: body.pullRequestUrl ?? null,
          pullRequestNumber: body.pullRequestNumber ?? null,
          deliveryInstructions: body.deliveryInstructions ?? null,
          workspaceRetained: body.workspaceRetained,
          maxRunsPerTask: budgetCeiling,
          budgetGrants,
        },
      });
      if (closed.count !== 1) return null;
      await tx.session.update({
        where: { id: run.session.id },
        data: {
          executionStatus: succeeded ? SessionExecutionStatus.SUCCEEDED
            : terminalStatus === RunStatus.TIMED_OUT ? SessionExecutionStatus.TIMED_OUT : SessionExecutionStatus.FAILED,
          cleanupStatus: body.cleanupStatus,
          exitCode: body.exitCode,
          signal: body.signal ?? null,
          terminationReason: body.terminationReason ?? null,
          endedAt: now,
          cleanupEndedAt: now,
          failureReason: succeeded ? null : body.failureReason ?? "Execution failed",
          cleanupFailureReason: body.cleanupFailureReason ?? null,
        },
      });
      let retryCreated = false;
      if (!succeeded && retryable && run.task && run.runNumber < budgetCeiling) {
        const currentTask = await tx.task.findUniqueOrThrow({
          where: { id: run.task.id },
          include: { templateStep: true, repo: { select: { defaultBranch: true } } },
        });
        // The fifth run-creating path. Indexed chains already resolve their
        // branch here; template chains must do the same or a retry is created
        // with `branch: null` and workspace.ts silently moves it to a per-run
        // branch. Pass the failed template run as the prior so publication
        // evidence — including WIP salvage written by this completion — still
        // decides the retry's base; the resolved logical chain head wins over
        // that run's workspace branch. Non-template
        // chains retain their existing no-prior resolution, and non-chain
        // retries retain the historical `branch: null` behavior.
        //
        // All of this runs *after* the updateMany that writes the completing
        // run's `branch`/`pushedBranch`, so the run's own push — a chain step's
        // publication, or a failed run's salvage — is evidence in this
        // transaction. `body.branch ?? run.branch` is that same effective value,
        // because `run` was read before the update.
        const resolveChain = currentTask.repo && currentTask.chainId
          && (currentTask.templateId || currentTask.chainIndex !== null);
        const branches = resolveChain && currentTask.repo
          ? await resolveRunBranches(
            tx,
            { ...currentTask, repo: currentTask.repo },
            currentTask.templateId ? { branch: body.branch ?? run.branch } : null,
          )
          : {
            branch: null,
            targetBranch: currentTask.repo
              ? await resolveRequeueBase(tx, { ...currentTask, repo: currentTask.repo }, {
                branch: body.branch ?? run.branch,
                targetBranch: run.targetBranch,
              })
              : run.targetBranch,
          };
        await tx.run.create({
          data: {
            projectId: run.projectId,
            taskId: run.taskId,
            goalId: run.goalId,
            agentId: run.agentId,
            repoId: run.repoId,
            runNumber: run.runNumber + 1,
            dedupeKey: makeDedupeKey(run.task.id, run.runNumber + 1),
            runner: run.runner,
            model: run.model,
            codexServiceTier: run.codexServiceTier,
            subagentModel: run.subagentModel,
            subagentMaxConcurrent: run.subagentMaxConcurrent,
            targetBranch: branches.targetBranch,
            branch: branches.branch,
            opensPullRequest: currentTask.opensPullRequest,
            promptHash: run.promptHash,
            maxDurationMin: run.maxDurationMin,
            stallTimeoutMin: run.stallTimeoutMin,
            maxRunsPerTask: budgetCeiling,
            budgetGrants,
            readyAt: retryAt ?? now,
          },
        });
        retryCreated = true;
      }
      if (!succeeded && !retryCreated && (mechanical
        || run.task?.templateStep?.outputKind === "regression-verification"
        || mergeTailAuxiliary)) {
        releaseMergeLeaseTask = tailLeaseChainId;
      }
      if (run.taskId) {
        const budgetExhausted = !succeeded && retryable && !retryCreated;
        let canonicalOutputFailure: string | null = null;
        if (!succeeded && !retryCreated && run.task) {
          const tailRows = await tx.taskActivity.findMany({
            where: { taskId: run.taskId },
            select: { metadata: true },
            orderBy: { createdAt: "desc" },
            take: 20,
          });
          const metadataRows = tailRows.map((row) => asJsonObject(row.metadata));
          const repairMarker = metadataRows.find((metadata) => (
            metadata?.kind === MERGE_TAIL_KIND.repairAttempt && typeof metadata.regressionTaskId === "string"
          ));
          const reviewMarker = metadataRows.find((metadata) => (
            metadata?.kind === MERGE_TAIL_KIND.reviewObligation
            && typeof metadata.readinessTaskId === "string"
            && typeof metadata.regressionTaskId === "string"
          ));
          if (repairMarker && typeof repairMarker.regressionTaskId === "string") {
            const reason = `${String(repairMarker.repairKind)} repair ${run.taskId} failed without closing the repair at ${String(repairMarker.headSha)}`;
            await tx.task.update({ where: { id: repairMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
            await tx.taskActivity.create({ data: {
              taskId: repairMarker.regressionTaskId,
              actorType: "control-plane",
              body: `Automatic ${String(repairMarker.repairKind)} attempt failed: ${String(repairMarker.headSha)} -> ${body.headSha ?? "no-delivered-head"}`,
              metadata: jsonValue({
                kind: MERGE_TAIL_KIND.repairResult,
                schemaVersion: 1,
                repairKind: typeof repairMarker.repairKind === "string" ? repairMarker.repairKind : null,
                repairTaskId: run.taskId,
                startHeadSha: typeof repairMarker.headSha === "string" ? repairMarker.headSha : null,
                targetHeadSha: typeof repairMarker.baseHeadSha === "string" ? repairMarker.baseHeadSha : null,
                resolvedHeadSha: body.headSha ?? null,
                state: "failed",
              }),
            } });
            await openMergeTailStopNotice(tx, { taskId: repairMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
          } else if (reviewMarker
            && typeof reviewMarker.readinessTaskId === "string"
            && typeof reviewMarker.regressionTaskId === "string") {
            const reason = `independent review ${run.taskId} failed without an exact-head decision for ${String(reviewMarker.headSha)}`;
            await tx.task.update({ where: { id: reviewMarker.readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
            await tx.task.update({ where: { id: reviewMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
            await openMergeTailStopNotice(tx, { taskId: reviewMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
          }
        }
        // §4.0 outcome branching. The executor's own fenced write is the only
        // writer of a step-12 output: neither synthesis nor the metadata update
        // may touch it, because a synthesized body would read as a merge that
        // never happened.
        if (succeeded && mechanical && run.task) {
          releaseMergeLeaseTask = tailLeaseChainId;
          const persisted = await tx.taskStepOutput.findUnique({
            where: { taskId: run.taskId }, select: { kind: true, body: true },
          });
          const outcome = parseMergeResult(persisted);
          if (outcome.outcome === "merged") {
            await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
          } else {
            await recordIntegratorStop(tx, {
              integratorTaskId: run.taskId,
              condition: outcome.outcome === "stopped" ? outcome.condition : "missing-or-malformed-result",
              evidence: outcome.outcome === "stopped" ? outcome.evidence : outcome.reason,
              agentId: run.agentId,
              sessionId: run.session.id,
              sourceRunId: run.id,
            });
          }
          await tx.taskActivity.create({ data: {
            taskId: run.taskId,
            actorType: "runner",
            actorId: body.runnerId,
            body: outcome.outcome === "merged"
              ? `Run ${run.runNumber} merged the chain's pull request`
              : `Run ${run.runNumber} stopped before merging`,
            metadata: jsonValue({ exitCode: body.exitCode, mergeOutcome: outcome.outcome }),
          } });
        } else if (succeeded && run.task && (run.task.templateId || run.task.chainId || mergeTailAuxiliary)) {
          // Body, runId, metadata, and commit binding describe one act of
          // authorship and only move together through task_output. Completion
          // validates that immutable binding; it never restamps an authored
          // body or synthesizes a canonical step's deliverable.
          let existingOutput = await tx.taskStepOutput.findUnique({ where: { taskId: run.taskId } });
          const canonicalAgentStep = isCanonicalAgentStep(run.task.templateStep);
          const requiresExplicitOutput = canonicalAgentStep
            || run.task.templateStep?.outputKind === "regression-verification";
          if (!existingOutput && !requiresExplicitOutput) {
            await tx.taskStepOutput.create({ data: {
              taskId: run.taskId,
              runId: run.id,
              kind: run.task.templateStep?.outputKind ?? "result",
              body: body.output?.trim() || `Run ${run.runNumber} completed successfully.`,
              metadata: jsonValue({ branch: body.branch ?? run.branch, headSha: body.headSha }),
              commitSha: body.headSha ?? null,
            } });
          } else if (!canonicalAgentStep && existingOutput?.runId === run.id && body.headSha) {
            // Legacy and noncanonical steps retain their prose-compatible
            // completion-time binding. Canonical artifacts are immutable and
            // must already name the delivered head when authored.
            existingOutput = await tx.taskStepOutput.update({
              where: { id: existingOutput.id }, data: { commitSha: body.headSha },
            });
          }
          const outputRefusal = canonicalOutputRefusal(
            run.task.templateStep,
            existingOutput,
            run.id,
            body.headSha ?? null,
          );
          if (outputRefusal) {
            await tx.task.update({
              where: { id: run.taskId },
              data: { status: TaskStatus.REVIEW, failureReason: outputRefusal },
            });
            await tx.taskActivity.create({ data: {
              taskId: run.taskId,
              actorType: "control-plane",
              body: `Canonical task output refused: ${outputRefusal}`,
              metadata: {
                kind: "canonicalTaskOutput.refusal",
                schemaVersion: 1,
                runId: run.id,
                reason: outputRefusal,
              },
            } });
            if (run.task.templateStep?.outputKind === "regression-verification") {
              releaseMergeLeaseTask = tailLeaseChainId;
            }
          }
          canonicalOutputFailure = outputRefusal;
        }
        if (succeeded && mechanical) {
          // Already branched above; the mechanical path owns its own advance.
        } else if (succeeded && run.task?.templateId) {
          if (canonicalOutputFailure) {
            // The current Run succeeded as a process, but it did not publish a
            // canonical deliverable bound to that Run and head. The REVIEW
            // state written above is the terminal control-plane outcome.
          } else if (run.task.templateStep?.outputKind === "regression-verification") {
            const result = await handleRegressionCompletion(tx, {
              task: run.task,
              run: {
                id: run.id,
                agentId: run.agentId,
                branch: body.branch ?? run.branch,
                headSha: body.headSha ?? null,
                sessionId: run.session.id,
              },
              now,
            });
            if (result === "advance") {
              await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
            } else {
              releaseMergeLeaseTask = tailLeaseChainId;
            }
          } else {
            await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, completionTaskStatus);
          }
        } else if (succeeded && run.task && (run.task.chainId || mergeTailAuxiliary)) {
          let repairUnable = false;
          let reviewRejected = false;
          if (reviewMarker
            && typeof reviewMarker.readinessTaskId === "string"
            && typeof reviewMarker.regressionTaskId === "string"
            && typeof reviewMarker.headSha === "string") {
            const reviewOutput = await tx.taskStepOutput.findUnique({ where: { taskId: run.taskId }, select: { body: true } });
            let decision: Record<string, unknown> | null = null;
            try { decision = JSON.parse(reviewOutput?.body ?? "null") as Record<string, unknown> | null; } catch { decision = null; }
            const validHead = decision?.schemaVersion === 1 && decision.headSha === reviewMarker.headSha;
            if (!validHead || (decision?.outcome !== "approved" && decision?.outcome !== "rejected")) {
              reviewRejected = true;
              const reason = `independent review returned missing, malformed, or stale decision for ${reviewMarker.headSha}`;
              await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DONE, failureReason: reason } });
              await tx.task.update({ where: { id: reviewMarker.readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
              await openMergeTailStopNotice(tx, { taskId: reviewMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
            } else if (decision.outcome === "approved") {
              await tx.taskActivity.create({ data: {
                taskId: reviewMarker.readinessTaskId,
                actorType: "control-plane",
                body: `Independent review approved exact head ${reviewMarker.headSha}`,
                metadata: jsonValue({
                  kind: MERGE_TAIL_KIND.reviewObligation,
                  schemaVersion: 1,
                  state: "approved",
                  reviewTaskId: run.taskId,
                  headSha: reviewMarker.headSha,
                  baseSha: typeof reviewMarker.baseSha === "string" ? reviewMarker.baseSha : null,
                }),
              } });
            } else {
              reviewRejected = true;
              const prior = await tx.taskActivity.findMany({
                where: { taskId: reviewMarker.readinessTaskId }, select: { metadata: true },
              });
              const alreadyRejected = prior.some((row) => {
                const metadata = asJsonObject(row.metadata);
                return metadata?.kind === MERGE_TAIL_KIND.reviewObligation && metadata.state === "rejected";
              });
              const summary = typeof decision.summary === "string" ? decision.summary : "independent review rejected without a summary";
              await tx.taskActivity.create({ data: {
                taskId: reviewMarker.readinessTaskId,
                actorType: "control-plane",
                body: `Independent review rejected exact head ${reviewMarker.headSha}`,
                metadata: {
                  kind: MERGE_TAIL_KIND.reviewObligation,
                  schemaVersion: 1,
                  state: "rejected",
                  reviewTaskId: run.taskId,
                  headSha: reviewMarker.headSha,
                  baseSha: typeof reviewMarker.baseSha === "string" ? reviewMarker.baseSha : null,
                  summary,
                },
              } });
              await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DONE, failureReason: `independent review rejected: ${summary}` } });
              const driftRecovery = await baseDriftRecoveryContext(
                tx,
                reviewMarker.regressionTaskId,
                undefined,
                typeof reviewMarker.recoverySourceStopId === "string" ? reviewMarker.recoverySourceStopId : "no-recovery-context",
              );
              if (driftRecovery) {
                await stopBaseDriftRecoveryTail(tx, driftRecovery, "independent-review", `rejected ${reviewMarker.headSha}: ${summary}`);
              } else if (alreadyRejected) {
                const reason = `second independent review rejection at ${reviewMarker.headSha}: ${summary}`;
                await tx.task.update({ where: { id: reviewMarker.readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
                await openMergeTailReviewDecisionInbox(tx, { taskId: reviewMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
              } else {
                const reason = `independent review rejected exact head ${reviewMarker.headSha}: ${summary}`;
                await tx.task.update({ where: { id: reviewMarker.readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
                await tx.task.update({ where: { id: reviewMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
                await openMergeTailReviewDecisionInbox(tx, { taskId: reviewMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
              }
            }
          }
          if (repairMarker && typeof repairMarker.regressionTaskId === "string") {
            const repairOutput = await tx.taskStepOutput.findUnique({ where: { taskId: run.taskId }, select: { body: true } });
            let reportedUnable = false;
            let resolvedHeadSha = body.headSha ?? null;
            if (repairMarker.repairKind === "refresh-conflict") {
              const parsedResolver = parseResolverResult(repairOutput?.body);
              const expectedStart = typeof repairMarker.headSha === "string" ? repairMarker.headSha : null;
              const expectedTarget = typeof repairMarker.baseHeadSha === "string" ? repairMarker.baseHeadSha : null;
              const bindingError = parsedResolver.status === "invalid"
                ? parsedResolver.reason
                : parsedResolver.result.startHeadSha !== expectedStart || parsedResolver.result.targetHeadSha !== expectedTarget
                  ? "merge-resolver output is bound to stale start or target heads"
                  : parsedResolver.result.outcome === "resolved" && parsedResolver.result.resolvedHeadSha !== body.headSha
                    ? "merge-resolver output resolved head does not match the delivered run head"
                    : null;
              if (bindingError) {
                repairUnable = true;
                const reason = `refresh-conflict repair ${run.taskId} returned invalid output: ${bindingError}`;
                await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DONE, failureReason: reason } });
                await tx.task.update({ where: { id: repairMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
                await tx.taskActivity.create({ data: {
                  taskId: repairMarker.regressionTaskId,
                  actorType: "control-plane",
                  body: `Automatic refresh-conflict attempt stopped: ${reason}`,
                  metadata: jsonValue({
                    kind: MERGE_TAIL_KIND.repairResult,
                    schemaVersion: 1,
                    repairKind: "refresh-conflict",
                    repairTaskId: run.taskId,
                    startHeadSha: expectedStart,
                    targetHeadSha: expectedTarget,
                    resolvedHeadSha: body.headSha ?? null,
                    state: "invalid-output",
                    reason: bindingError,
                  }),
                } });
                await openMergeTailStopNotice(tx, { taskId: repairMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
              } else if (parsedResolver.status === "ok") {
                reportedUnable = parsedResolver.result.outcome === "unable";
                resolvedHeadSha = parsedResolver.result.outcome === "resolved" ? parsedResolver.result.resolvedHeadSha : null;
              }
            }
            // gate-fix and review-fix agents have no JSON wire contract; their
            // successful delivered head is the completion evidence.
            if (reportedUnable) {
              repairUnable = true;
              const reason = `${String(repairMarker.repairKind)} repair ${run.taskId} reported unable at ${String(repairMarker.headSha)}`;
              await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DONE, failureReason: reason } });
              await tx.task.update({ where: { id: repairMarker.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: reason } });
              await openMergeTailStopNotice(tx, { taskId: repairMarker.regressionTaskId, agentId: run.agentId, sessionId: run.session.id, reason });
            } else if (!repairUnable) {
              await tx.taskActivity.create({ data: {
                taskId: repairMarker.regressionTaskId,
                actorType: "control-plane",
                body: `Automatic ${String(repairMarker.repairKind)} attempt completed: ${String(repairMarker.headSha)} -> ${body.headSha ?? "missing-head"}`,
                metadata: jsonValue({
                  kind: MERGE_TAIL_KIND.repairResult,
                  schemaVersion: 1,
                  repairKind: typeof repairMarker.repairKind === "string" ? repairMarker.repairKind : null,
                  repairTaskId: run.taskId,
                  startHeadSha: typeof repairMarker.headSha === "string" ? repairMarker.headSha : null,
                  targetHeadSha: typeof repairMarker.baseHeadSha === "string" ? repairMarker.baseHeadSha : null,
                  resolvedHeadSha,
                }),
              } });
              if (repairDocumentationTask) {
                await tx.task.update({
                  where: { id: repairDocumentationTask.id },
                  data: {
                    status: TaskStatus.TODO,
                    failureReason: `documentation invalidated by ${String(repairMarker.repairKind)} repair ${run.taskId}`,
                  },
                });
              }
            }
          }
          if (repairUnable || reviewRejected) {
            // The failed repair owns the stop; never activate its follow-up.
            releaseMergeLeaseTask = tailLeaseChainId;
          } else if (run.task.approvalGate) {
            const claimed = await tx.task.updateMany({
              where: { id: run.taskId, status: completionTaskStatus! },
              data: { status: TaskStatus.REVIEW, failureReason: null },
            });
            if (claimed.count === 1) await gateQuestion(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null);
          } else {
            const completed = await tx.task.updateMany({
              where: { id: run.taskId, status: completionTaskStatus! }, data: { status: TaskStatus.DONE, failureReason: null },
            });
            if (completed.count === 1) {
              if (run.task.chainId) {
                await activateChainSuccessor(tx, run.task, {
                  sourceRunId: run.id,
                  chatId: process.env.FEISHU_DEFAULT_CHAT_ID ?? null,
                }, now);
              }
              if (auxiliaryTargetTaskId) await activateMergeTailTarget(tx, auxiliaryTargetTaskId, now);
            }
          }
        } else {
          await tx.task.updateMany({
            where: { id: run.taskId, ...(completionTaskStatus ? { status: completionTaskStatus } : {}) },
            data: {
              status: retryCreated ? TaskStatus.DOING : TaskStatus.REVIEW,
              failureReason: succeeded ? null : budgetExhausted
                ? `Maximum ${budgetCeiling} runs reached`
                : body.failureReason ?? "Execution failed",
            },
          });
        }
        if (!(succeeded && mechanical)) await tx.taskActivity.create({
          data: {
            taskId: run.taskId,
            actorType: "runner",
            actorId: body.runnerId,
            body: canonicalOutputFailure ? `Run ${run.runNumber} succeeded but canonical task output was refused`
              : succeeded && (run.task?.templateId || run.task?.chainId || mergeTailAuxiliary) ? `Run ${run.runNumber} succeeded; chain advanced or awaiting approval`
              : succeeded ? `Run ${run.runNumber} succeeded; task moved to review`
              : retryCreated ? `Run ${run.runNumber} failed; retry queued`
                : `Run ${run.runNumber} failed; task moved to review`,
            metadata: jsonValue({ exitCode: body.exitCode, terminalEventSeen: body.terminalEventSeen, failureClass, pushStatus: body.pushStatus, pullRequestUrl: body.pullRequestUrl }),
          },
        });
        if (budgetExhausted) {
          await tx.inboxMessage.create({
            data: {
              from: "AGENT",
              sessionId: run.session.id,
              taskId: run.taskId,
              kind: "TEXT",
              body: `Run budget exhausted after ${budgetCeiling} attempts; operator action required.`,
            },
          });
        }
      }
      if (failureClass === FailureClass.AUTH_REQUIRED) {
        const state = await tx.runnerBackendState.upsert({
          where: { runner: run.runner },
          create: { runner: run.runner, consecutiveAuthFailures: 1, lastPreflightOk: false },
          update: { consecutiveAuthFailures: { increment: 1 }, lastPreflightOk: false },
        });
        if (state.consecutiveAuthFailures >= 2) {
          await tx.runnerBackendState.update({
            where: { runner: run.runner },
            data: { circuitOpen: true, circuitReason: "Repeated authentication failures", circuitOpenedAt: now },
          });
          await tx.inboxMessage.create({
            data: {
              from: "AGENT",
              sessionId: run.session.id,
              taskId: run.taskId,
              goalId: run.goalId,
              kind: "TEXT",
              body: `${run.runner.toLowerCase()} runner circuit opened after repeated authentication failures; login is required.`,
            },
          });
        }
      } else if (succeeded) {
        await tx.runnerBackendState.upsert({
          where: { runner: run.runner },
          create: { runner: run.runner, lastPreflightOk: true },
          update: { consecutiveAuthFailures: 0 },
        });
      }
      return { taskId: run.taskId, succeeded, retryCreated, failureClass, releaseMergeLeaseTask };
    // ReadCommitted lets successor CAS losers observe count=0 instead of
    // surfacing a serialization failure to runners. Every task status write
    // above has its own status CAS so concurrent operator decisions win.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (!result) {
      const waiting = await db.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
      return waiting
        ? context.json({ error: "Run suspended for Inbox", code: "WAITING_INBOX" }, 409)
        : context.json({ error: "Stale fencing token" }, 409);
    }
    await releaseMergeLeaseSafely(releaseChainLease, result.releaseMergeLeaseTask);
    await options.ownership.assertHeld();
    // Nothing is deleted here, or anywhere else in this process. The runner
    // removed its own workspace before it called /complete and reported the
    // result in `cleanupStatus`; if that failed, the directory is offered back
    // to its owner through /runner/workspaces/reclaimable. This route used to
    // delete on the API's behalf — first the whole root, then one run's
    // directory — and API-side deletion is exactly what issue #115 removes.
    return context.json(result);
  });

  // Plural, and it must stay plural: principalMayAccess denies the operator any
  // path starting with "/session/" (auth.ts), which "/sessions" misses by one
  // character. A singular route here 403s with no useful message.
  const sessionInclude = {
    agent: { select: { id: true, title: true } },
    // §SF-1: the session's own task carries the `merge-result` output the
    // sessions pill and the lifecycle stat are projected from.
    task: {
      select: {
        id: true, name: true,
        stepOutput: { select: { kind: true, body: true, runId: true } },
        // §SF-1: an unauthored output row can only mean the task's newest run.
        runs: { orderBy: { runNumber: "desc" }, take: 1, select: { id: true } },
      },
    },
    goal: { select: { id: true, title: true } },
    run: {
      select: {
        id: true, runNumber: true, model: true, branch: true,
        pullRequestUrl: true, workspacePath: true,
        // remoteUrl is what turns the detail page's Branch field into a link.
        repo: { select: { id: true, name: true, remoteUrl: true } },
      },
    },
  } as const;

  type MergeOutcomeSubject = {
    runId: string;
    task: {
      stepOutput?: { kind: string; body: string; runId: string | null } | null;
      runs?: Array<{ id: string }>;
    } | null;
  };
  const withMergeOutcome = <T extends MergeOutcomeSubject>(session: T) => {
    const output = session.task?.stepOutput;
    const owns = runOwnsMergeOutcome(output, session.runId, session.task?.runs?.[0]?.id ?? null);
    return { ...session, mergeOutcome: owns ? projectMergeOutcome(output) : null };
  };

  app.get("/sessions", async (context) => {
    const projectId = context.req.query("projectId");
    const limit = Math.min(Math.max(Number.parseInt(context.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const before = context.req.query("before");
    const beforeDate = before ? new Date(before) : null;
    return context.json((await db.session.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        // An unparseable cursor drops the filter rather than reaching Prisma as
        // an Invalid Date and surfacing as a 500.
        ...(beforeDate && !Number.isNaN(beforeDate.getTime()) ? { requestedAt: { lt: beforeDate } } : {}),
      },
      include: sessionInclude,
      orderBy: { requestedAt: "desc" },
      take: limit,
    })).map(withMergeOutcome));
  });

  app.get("/sessions/:sessionId", async (context) => {
    const session = await db.session.findUnique({
      where: { id: id.parse(context.req.param("sessionId")) },
      include: sessionInclude,
    });
    return session ? context.json(withMergeOutcome(session)) : context.json({ error: "Session not found" }, 404);
  });

  app.post("/runs/:runId/cancel", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, cancelRunInput);
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${runId} FOR UPDATE`;
      const run = await tx.run.findUnique({
        where: { id: runId },
        select: {
          id: true,
          status: true,
          taskId: true,
          runNumber: true,
          runnerId: true,
          fencingToken: true,
          leaseExpiresAt: true,
          claimedAt: true,
          cancelRequestId: true,
          cancelReason: true,
          cancelRequestedAt: true,
          cancelAcknowledgedAt: true,
          session: { select: { id: true } },
          task: { select: { templateStep: { select: {
            stepIndex: true,
            outputKind: true,
            taskTemplate: { select: { name: true } },
          } } } },
        },
      });
      if (!run) return { error: "Run not found", code: 404 as const };
      if (body.parkTask && !run.taskId) return { error: "Run has no Task to park", code: 409 as const };
      const parkTarget = body.parkTask && run.taskId ? await lockTaskMutationRows(tx, run.taskId) : null;
      if (body.parkTask && run.taskId && !parkTarget) return { error: "Task not found", code: 404 as const };
      if (parkTarget && parkTarget.archivedAt !== null) {
        return { error: "Cannot park an archived task", code: 409 as const };
      }
      if (parkTarget?.status === TaskStatus.DONE) return { error: "Cannot park a completed task", code: 409 as const };
      const parkTask = async () => {
        const task = parkTarget;
        if (!task) return;
        if (task.status === TaskStatus.BACKLOG) return null;
        const reason = run.cancelRequestId ? run.cancelReason ?? body.reason : body.reason;
        await tx.task.update({
          where: { id: task.id },
          data: { status: TaskStatus.BACKLOG, failureReason: reason },
        });
        await tx.taskActivity.create({ data: {
          taskId: task.id,
          actorType: "operator",
          body: `Status changed: ${task.status} → ${TaskStatus.BACKLOG}`,
          metadata: { runId: run.id, requestId: body.requestId, reason: "stop-and-park" },
        } });
      };
      if (run.cancelRequestId) {
        if (run.cancelRequestId !== body.requestId) {
          return { error: `Run already has cancellation request ${run.cancelRequestId}`, code: 409 as const };
        }
        await parkTask();
        return {
          runId: run.id,
          taskId: run.taskId,
          status: run.status,
          cancellationState: run.cancelAcknowledgedAt
            ? "acknowledged" as const
            : run.status === RunStatus.CANCELLED ? "unconfirmed" as const : "requested" as const,
          requestId: run.cancelRequestId,
          reason: run.cancelReason,
          releaseMergeLeaseTask: null,
        };
      }
      if (executionModeFor(run.task?.templateStep ?? null) === "mechanical") {
        return { error: "Mechanical merge Runs cannot be cancelled after authorization", code: 409 as const };
      }
      if (!([RunStatus.QUEUED, ...activeRunStatuses] as RunStatus[]).includes(run.status)) {
        return {
          runId: run.id,
          taskId: run.taskId,
          status: run.status,
          cancellationState: "terminal" as const,
          requestId: body.requestId,
          reason: null,
          releaseMergeLeaseTask: null,
        };
      }
      const now = new Date();
      const requested = await tx.run.updateMany({
        where: { id: run.id, cancelRequestId: null, status: run.status },
        data: {
          cancelRequestId: body.requestId,
          cancelReason: body.reason,
          cancelRequestedAt: now,
          sessionTokenRevokedAt: now,
        },
      });
      if (requested.count !== 1) return { error: "Run changed while cancellation was being requested", code: 409 as const };
      await parkTask();
      if (run.taskId) await tx.taskActivity.create({ data: {
        taskId: run.taskId,
        actorType: "operator",
        body: `Cancellation requested for Run ${run.runNumber}: ${body.reason}`,
        metadata: { runId: run.id, requestId: body.requestId, priorStatus: run.status, state: "requested" },
      } });
      // An unclaimed Run has never had a provider process. Every claimed state,
      // including WAITING_INBOX, requires runner-owned process cleanup or an
      // explicitly unconfirmed terminalization after runner loss.
      if (run.status === RunStatus.QUEUED) {
        return settleCancellation(tx, { runId: run.id, requestId: body.requestId, now });
      }
      return {
        runId: run.id,
        taskId: run.taskId,
        status: run.status,
        cancellationState: "requested" as const,
        requestId: body.requestId,
        reason: body.reason,
        // Terminalization is still owed by the runner acknowledgement or by
        // reconciliation, and only a terminal writer may free the lease.
        releaseMergeLeaseTask: null,
      };
    });
    if ("error" in result) return context.json({ error: result.error }, result.code);
    const { releaseMergeLeaseTask, ...cancellation } = result;
    await releaseMergeLeaseSafely(releaseChainLease, releaseMergeLeaseTask);
    return context.json(cancellation);
  });

  app.get("/runs/:runId/events", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const afterSeq = Number.parseInt(context.req.query("afterSeq") ?? "", 10);
    const limit = Math.min(Math.max(Number.parseInt(context.req.query("limit") ?? "500", 10) || 500, 1), 2_000);
    const where = { runId, ...(Number.isFinite(afterSeq) ? { seq: { gt: afterSeq } } : {}) };
    const [events, total] = await Promise.all([
      // One extra row decides hasMore without a second count on the filtered set.
      db.sessionEvent.findMany({ where, orderBy: { seq: "asc" }, take: limit + 1 }),
      db.sessionEvent.count({ where: { runId } }),
    ]);
    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;
    return context.json({ events: page, nextAfterSeq: page.at(-1)?.seq ?? null, hasMore, total });
  });

  app.onError((error, context) => {
    if (error instanceof z.ZodError) return context.json({ error: "Validation failed", issues: error.issues }, 400);
    if (isCompoundImplementationAssigneeError(error)) {
      return context.json({ error: error.message, code: COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE }, 409);
    }
    if (isArchivedAssigneeError(error)) return context.json({ error: error.message }, 409);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") return context.json({ error: "Resource not found" }, 404);
      if (error.code === "P2002") return context.json({ error: "Unique constraint violated" }, 409);
    }
    console.error(error);
    return context.json({ error: "Internal server error" }, 500);
  });
  app.notFound((context) => context.json({ error: "Not found" }, 404));
  return app;
};
