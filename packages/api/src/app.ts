import { createHash } from "node:crypto";

import {
  ACTIVE_RUN_STATUSES,
  AssigneeType,
  activateChainSuccessor,
  ChainControlState,
  agentArchiveBlocker,
  applyInboxDecision,
  catalogRunnerForModel,
  CleanupStatus,
  CodexServiceTier,
  FailureClass,
  GoalStatus,
  enqueueTaskRun,
  openRun,
  InboxKind,
  InboxSender,
  InboxStatus,
  lockAgentRepoGrantForRevocation,
  lockAgentRow,
  lockChainRows,
  lockRunRow,
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
  runnerFor,
  sessionUsageCost,
  sumUsageCosts,
  SecretPurpose,
  SkillKind,
  SessionEventSource,
  SessionExecutionStatus,
  TaskSource,
  TaskStatus,
  TriggerFireSource,
  isMergeExecutorRunnerId,
  mechanicalPrincipalRefusal,
  executionModeFor,
  integratorBindingRefusalFor,
  projectMergeOutcome,
  runOwnsMergeOutcome,
  INTEGRATOR_AGENT_NAME,
  MERGE_INTEGRATOR_KIND,
  latestTargetCorrection,
  loadIntegratorTask,
  observedChainPullRequests,
  requestConfirmationCard,
  resolveChainTarget,
  selectAuthorization,
  stopStateFor,
  taskIsIntegratorStep,
  isRegressionVerificationOutputKind,
  type CandidateActivity,
  type CardRow,
  type ChainControlSnapshot,
  type DecisionRow,
  mergeRecoveryPhase,
  type MergeRecoveryAttempt,
  loadAgentSources,
} from "@anneal/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getMimeType } from "hono/utils/mime";
import { z } from "zod";

import { authenticate, principalMayAccess, type Principal } from "./auth.js";
import { etagFor, etagMatches, readBoard, readTaskList, serializeUsageCost, type TaskReadScope } from "./board.js";
import { isValidBranchName } from "./branch-name.js";
import { COSTS_DEFAULT_DAYS, COSTS_RANGE_DAYS, readProjectCosts } from "./costs.js";
import { chainExecutionOwner } from "./chain-execution-owner.js";
import { FAILURE_REASON_LIMIT, failureReasonText } from "./failure-reason.js";
import {
  isCanonicalBlindFindingsStep,
  isCanonicalSolFindingsStep,
  outputIsImmutableOncePersisted,
  persistSessionTaskOutput,
  requiredOutputKind,
} from "./canonical-task-output.js";
import { LOOPBACK_BROWSER_ORIGINS, originMayReachHandlers } from "./local-origin.js";
import {
  releaseMergeLease,
  type ReleaseMergeLease,
} from "./merge-lease.js";
import { createRunnerRegistry } from "./runners.js";
import {
  nextStoredCliAvailability,
  preserveCliAvailability,
  readStoredCliAvailability,
  storeCliAvailability,
} from "./runner-cli-availability.js";
import {
  chainKey,
  chainProgress,
  chainProgressByChain,
  positions,
  readStepAdmission,
  readStepAdmissions,
  stepName,
} from "./chain.js";
import {
  jsonValue,
  normalizeSessionEventValue,
} from "./execution.js";
import { createArchivedRunNoticeScheduler, noteArchivedQueuedRuns, reconcileDatabaseRuns } from "./reconcile.js";
import {
  type Refusal,
  type RefusalDetail,
  type RefusalReason,
  refusalFor,
  refusalResponse,
} from "./refusal.js";
import {
  acknowledgeReclaimSalvage, publishReclaimIntents, recordReclaimOutcomes, repairReplacementAfterSalvage,
} from "./workspace-reclaim.js";
import { encryptSecret } from "./secrets.js";
import {
  activeRunStatuses,
  explainFenceRefusal,
  fenceRefusalResponse,
  fencedRunWhere,
  isFenceRefusalResponse,
  type FenceRefusalResponse,
  type RunFence,
  withFencedRun,
} from "./run-fence.js";
import { terminalizeRun } from "./run-terminal.js";
import { InboxRunFenceRefusal, supersedeTaskInboxMessage, suspendForInbox } from "./inbox.js";
import { createStarterInstallation, onboardingInput, onboardingStatus } from "./onboarding.js";
import { preflightOnboardingRepository, RepositoryPreflightError } from "./onboarding-preflight.js";
import { instantiateTemplate, isUsableTemplateVariable } from "./templates.js";
import { isTemplateInstantiationRefusal } from "./template-errors.js";
import type { SpecificationReader } from "./specification-fidelity.js";
import {
  readCommitted,
  serializable,
  SerializableTransactionExhaustedError,
} from "./transaction.js";
import { computeNextOccurrence, validateSchedule } from "./scheduler.js";
import { authenticateWebhook, resolvePayloadVariables, usableDefault } from "./hooks.js";
import { filesRootGrantKey, getFileStore } from "./files/config.js";
import { grantAdmits, type FileOperation, type GrantLike } from "./files/grants.js";
import { isCanonicalRelPath, normalizeRelPath } from "./files/paths.js";
import { DirectoryNotEmptyError, InvalidPathError, IsADirectoryError, NotADirectoryError, NotFoundError, SymlinkError, type FileStore } from "./files/store.js";
import {
  hasActiveRun,
  isLiveStatus,
  lockTaskMutationRows,
  reactivationBlocked,
} from "./task-write.js";
import { patchTask } from "./task-patch.js";
import { claimRun, OPERATOR_NOTE_METADATA_FIELD } from "./run-claim.js";
import { completeRun } from "./run-completion.js";
import { withoutUndefined } from "./without-undefined.js";
import { versionPayload } from "./version.js";

type AppEnvironment = { Variables: { principal: Principal } };

const refusal = (reason: RefusalReason, message: string, detail?: RefusalDetail): Refusal => (
  detail === undefined ? { reason, message } : { reason, message, detail }
);

const refusalJson = (context: Context, refused: Refusal): Response => {
  const response = refusalResponse(refused);
  return context.json(response.body, response.status);
};

const runFenceRefusal = (refused: FenceRefusalResponse): Refusal => (
  refusal("conflict", refused.error, { reason: refused.reason })
);

class TaskCreateOpenRunRefusal extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = "TaskCreateOpenRunRefusal";
  }
}

export interface LiveAppOptions {
  ownership: { assertHeld(): void | Promise<void> };
  onboardingRepositoryPreflight?: typeof preflightOnboardingRepository;
  releaseMergeLease?: ReleaseMergeLease;
  /** Repository content capability used to verify materialized review specs. */
  specificationReader?: SpecificationReader | null;
}


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

/**
 * An approval gate's `taskId` is the gate step itself; the artifact the approver
 * is being asked about was produced by the *previous* step, whose run opened the
 * card. That producing task needs no stored column: the card carries the
 * producing run's `sessionId`, and `Session.taskId` is that run's task
 * (`app.ts` writes `candidate.taskId` when the session is created). Exposing it
 * as `artifactTaskId` is what lets the board render the full artifact next to
 * the decision instead of the truncated preview the card body carries for
 * Feishu — and it works for cards opened before this field existed.
 */
const withArtifactTask = <T extends { gateTaskId: string | null; session: { taskId: string | null } | null }>(
  message: T,
): Omit<T, "session"> & { artifactTaskId: string | null } => {
  const { session, ...rest } = message;
  return { ...rest, artifactTaskId: message.gateTaskId === null ? null : session?.taskId ?? null };
};

/**
 * A card nobody is blocked on, so archiving it strands nothing.
 *
 * The rule used to be "attached to no task, goal, or session", which was a
 * proxy for that and misfired on the common case: a merge-tail stop report is
 * attached to the task it happened on, yet its run ended long ago and no reply
 * would resume anything. What actually blocks is a suspended session pointing
 * at the card through `Session.waitingOnMessageId` (`inbox.ts`'s
 * `suspendForInbox`), or a decision the operator still owes — a choice list or
 * an approval gate.
 */
const withDismissible = <T extends {
  id: string; from: InboxSender; kind: InboxKind; gateTaskId: string | null; replyToMessageId: string | null;
}>(message: T, blocked: ReadonlySet<string>): T & { dismissible: boolean } => ({
  ...message,
  dismissible: message.from === "AGENT"
    && message.kind === InboxKind.TEXT
    && message.gateTaskId === null
    && message.replyToMessageId === null
    && !blocked.has(message.id),
});

/** The cards a suspended session will resume on. A session only ever waits on a
 *  message its own suspension created, so this set cannot grow for a card that
 *  already exists — which is why the close route may check it before its
 *  conditional update rather than inside one statement. */
const blockedMessageIds = async (db: PrismaClient, ids: string[]): Promise<ReadonlySet<string>> => {
  if (ids.length === 0) return new Set();
  const waiting = await db.session.findMany({
    where: { waitingOnMessageId: { in: ids } },
    select: { waitingOnMessageId: true },
  });
  return new Set(waiting.flatMap((session) => session.waitingOnMessageId === null ? [] : [session.waitingOnMessageId]));
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

const runtimeConfigRefusal = (agent: {
  name: string;
  model: string;
  runnerPreference: RunnerPreference;
  codexServiceTier: CodexServiceTier;
}): string | null => (
  runnerModelRefusal(agent)
  ?? executionerRuntimeRefusal(agent)
  ?? codexServiceTierRefusal(agent)
);

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
const taskCreateStatus = z.nativeEnum(TaskStatus).refine(
  (status) => status === TaskStatus.BACKLOG || status === TaskStatus.TODO,
  "Task creation status must be BACKLOG or TODO",
);
/** Exported for `smoke-fixture.test.ts`: the published release fixture and this
 *  schema have to agree about `opensPullRequest`, and the only way to assert
 *  that is to parse the fixture with the schema the route actually uses. */
export const taskInput = z.object({
  ...taskFields,
  status: taskCreateStatus.default(TaskStatus.TODO),
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
// `failureReason` is patchable but not creatable: a task is never born with a
// failure, and an operator whose task carries a stale one needs a way to clear
// it — an explicit null — without inventing a run.
const taskPatch = z.object(taskFields).partial().extend({
  status: z.nativeEnum(TaskStatus).optional(),
  failureReason: failureReasonText(FAILURE_REASON_LIMIT).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);
export type TaskPatchInput = z.infer<typeof taskPatch>;
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
export type ClaimInput = z.infer<typeof claimInput>;
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
    failureReason: failureReasonText(FAILURE_REASON_LIMIT).nullable().optional(),
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
  reason: z.string().trim().min(1).pipe(failureReasonText(FAILURE_REASON_LIMIT)),
  parkTask: z.boolean().default(false),
});
const worktreeContainmentViolationsInput = z.array(z.string().min(1).max(4096)).max(5000);
const cancelAcknowledgeInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  requestId: z.string().trim().min(1).max(160),
  workspacePath: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  worktreeContainmentViolations: worktreeContainmentViolationsInput.optional(),
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
const mechanicalStartInput = z.object({
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
const startInput = mechanicalStartInput.extend({
  // The runner computes this from the exact bytes handed to the provider.
  // Requiring it prevents a start write from leaving a queued or prior hash.
  promptHash: z.string().regex(/^[0-9a-f]{64}$/u),
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

const completionInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  terminalEventSeen: z.boolean(),
  terminalSuccess: z.boolean(),
  terminationReason: z.string().nullable().optional(),
  failureClass: z.nativeEnum(FailureClass).optional(),
  failureReason: failureReasonText(FAILURE_REASON_LIMIT).optional(),
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
  // Report-only completion evidence. An omitted or empty list means that the
  // runner observed no worktree outside its run workspace; it never changes
  // terminal outcome classification.
  worktreeContainmentViolations: worktreeContainmentViolationsInput.optional(),
  failureEnvelope: versionedEnvelopeInput.optional(),
});
export type CompletionInput = z.infer<typeof completionInput>;
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
  // Written straight onto every blocked task as its `failureReason` (and kept
  // as the circuit reason those rows are later matched by), so it is bounded
  // here, where both writes read the same already-truncated string.
  error: failureReasonText(FAILURE_REASON_LIMIT).nullable().optional(),
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
const templateSchemaRefusal = (error: unknown): Refusal | null => {
  if (!(error instanceof z.ZodError)) return null;
  const issue = error.issues.find((candidate) => {
    const params = (candidate as unknown as { params?: Record<string, unknown> }).params;
    return typeof params?.templateRefusalCode === "string";
  });
  if (!issue) return null;
  const params = (issue as unknown as { params?: Record<string, unknown> }).params;
  return typeof params?.templateRefusalCode === "string"
    ? refusal("invalid-request", issue.message, { code: params.templateRefusalCode })
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
const chainHoldInput = z.object({
  requestId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(4_000).nullable().optional(),
}).strict();
const chainResumeInput = z.object({
  requestId: z.string().trim().min(1).max(200),
}).strict();

type ChainControlProjectionInput = {
  projectId: string;
  chainId: string;
  state: ChainControlState;
  heldLayer: number | null;
  heldAt: Date | null;
  holdRequestId: string | null;
  holdReason: string | null;
  releasedAt: Date | null;
  releaseRequestId: string | null;
  holdGeneration: number;
};

/** The Chain read contract exposes operator facts, not internal CAS metadata. */
export const chainControlReadProjection = (control: ChainControlProjectionInput) => ({
  state: control.state === ChainControlState.HELD ? "held" as const : "released" as const,
  heldLayer: control.heldLayer,
  heldAt: control.heldAt,
  holdRequestId: control.holdRequestId,
  holdReason: control.holdReason,
  releasedAt: control.releasedAt,
});

/** Mutation responses retain transition metadata needed by idempotent clients. */
export const chainControlMutationProjection = (control: ChainControlProjectionInput) => ({
  projectId: control.projectId,
  chainId: control.chainId,
  state: control.state === ChainControlState.HELD ? "held" as const : "released" as const,
  heldLayer: control.heldLayer,
  heldAt: control.heldAt,
  holdRequestId: control.holdRequestId,
  holdReason: control.holdReason,
  releasedAt: control.releasedAt,
  releaseRequestId: control.releaseRequestId,
  holdGeneration: control.holdGeneration,
});

type ChainResumeRow = {
  id: string;
  projectId: string;
  name: string;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  status: TaskStatus;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
};

const executionLayer = (task: Pick<ChainResumeRow, "chainLayer" | "chainIndex">): number | null => (
  task.chainLayer ?? task.chainIndex
);

/**
 * Resume may reuse the normal successor activation routine, but it needs a
 * completed predecessor to anchor that routine. The hold layer is the first
 * non-DONE layer at the time of the hold, so it must be complete before a
 * release can activate anything. Once that is true, choose the highest fully
 * complete layer deterministically; the routine then selects the first higher
 * layer that still has work and applies all of its ordinary guards.
 */
const resumeActivationAnchor = (
  rows: readonly ChainResumeRow[],
  heldLayer: number | null,
): ChainResumeRow | null => {
  if (heldLayer === null) return null;
  const layers = [...new Set(rows.map(executionLayer).filter((layer): layer is number => layer !== null))];
  const heldRows = rows.filter((row) => executionLayer(row) === heldLayer);
  if (heldRows.length === 0 || !heldRows.every((row) => row.status === TaskStatus.DONE)) return null;
  const completeLayer = layers
    .filter((layer) => rows.some((row) => executionLayer(row) === layer)
      && rows.filter((row) => executionLayer(row) === layer).every((row) => row.status === TaskStatus.DONE))
    .sort((left, right) => right - left)[0];
  if (completeLayer === undefined) return null;
  return rows
    .filter((row) => executionLayer(row) === completeLayer)
    .sort((left, right) => (
      (left.chainIndex ?? Number.MAX_SAFE_INTEGER) - (right.chainIndex ?? Number.MAX_SAFE_INTEGER)
        || left.id.localeCompare(right.id)
    ))[0] ?? null;
};

const resumeActivationNeedsSourceRun = (
  rows: readonly ChainResumeRow[],
  anchor: ChainResumeRow,
): boolean => {
  const anchorLayer = executionLayer(anchor);
  if (anchorLayer === null) return false;
  const nextLayer = [...new Set(rows.map(executionLayer).filter((layer): layer is number => layer !== null))]
    .filter((layer) => layer > anchorLayer && rows.some((row) => executionLayer(row) === layer && row.status !== TaskStatus.DONE))
    .sort((left, right) => left - right)[0];
  if (nextLayer === undefined) return false;
  return rows
    .filter((row) => executionLayer(row) === nextLayer && row.status !== TaskStatus.DONE)
    .some((row) => row.assigneeType !== AssigneeType.AGENT || row.assigneeAgentId === null || row.repoId === null);
};

const readJson = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await request.json());

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

const isPublic = (path: string, method: string): boolean =>
  path === "/" || path === "/health" || path === "/version" || method === "OPTIONS"
  || method === "POST" && /^\/hooks\/templates\/[^/]+$/.test(path);

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
    if (!result.ok) {
      return refusalJson(context, refusal("conflict", "An installation already exists", { code: result.code }));
    }
    return context.json(result.installation, 201);
  });

  app.get("/projects", async (context) => validated(context, await db.project.findMany({ orderBy: { createdAt: "asc" } })));
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

  app.get("/projects/:projectId/costs", async (context) => {
    const raw = context.req.query("days");
    const days = raw === undefined
      ? COSTS_DEFAULT_DAYS
      : COSTS_RANGE_DAYS.find((candidate) => raw === String(candidate));
    // Refused rather than clamped: a window the caller did not ask for would be
    // read as the one they did, and the totals would be quietly wrong.
    if (days === undefined) {
      return context.json({ error: `days must be one of ${COSTS_RANGE_DAYS.join(", ")}` }, 400);
    }
    return context.json(await readProjectCosts(db, id.parse(context.req.param("projectId")), days));
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
  app.get("/projects/:projectId/agents", async (context) => validated(context, (await db.agent.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })).map((agent) => {
    const mechanical = agent.name === INTEGRATOR_AGENT_NAME;
    return { ...agent, mechanical, assignable: !mechanical };
  })));
  app.post("/projects/:projectId/agents", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, agentInput);
    const runtimeRefusal = runtimeConfigRefusal(body);
    if (runtimeRefusal) return context.json({ error: runtimeRefusal }, 400);
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
      if (!before) return refusal("not-found", "Agent not found");
      const patch = withoutUndefined(body);
      const merged = { ...before, ...patch };
      if (before.name === "implementation-plan-executioner" && merged.name !== before.name) {
        return refusal("invalid-request", "implementation-plan-executioner is a canonical Agent name and cannot be changed");
      }
      const runtimeRefusal = runtimeConfigRefusal(merged);
      if (runtimeRefusal) return refusal("invalid-request", runtimeRefusal);
      if (body.environmentId) {
        const environment = await tx.environment.findFirst({ where: { id: body.environmentId, projectId: before.projectId } });
        if (!environment) return refusal("invalid-request", "Environment does not belong to this project");
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
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.agent);
  });
  app.post("/agents/:agentId/reset-runtime-config", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    // Load the complete role contract before opening the write transaction. A
    // missing or malformed source is a release error and must not turn into a
    // best-effort reset that guesses at the canonical values.
    const sources = await loadAgentSources();
    const rolesByName = new Map(sources.roles.map((role) => [role.name, role]));
    const result = await db.$transaction(async (tx) => {
      const before = await lockAgentRow(tx, agentId);
      if (!before) return refusal("not-found", "Agent not found");
      if (before.archivedAt) return refusal("conflict", "Cannot reset runtime configuration for an archived Agent");
      const role = rolesByName.get(before.name);
      if (!role) return refusal("invalid-request", `Agent ${before.name} has no canonical role source`);
      const runtimeRefusal = runtimeConfigRefusal({
        name: before.name,
        model: role.model,
        runnerPreference: role.runnerPreference,
        codexServiceTier: before.codexServiceTier,
      });
      if (runtimeRefusal) return refusal("invalid-request", runtimeRefusal);
      return { agent: await tx.agent.update({
        where: { id: agentId },
        data: {
          model: role.model,
          runnerPreference: role.runnerPreference,
          runtimeConfigCustomized: false,
          runtimeConfigDriftNoticeFingerprint: null,
        },
      }) };
    });
    if ("message" in result) return refusalJson(context, result);
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
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockAgentRow(tx, agentId);
      if (!locked) return refusal("not-found", "Agent not found");
      const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId } });
      if (agent.archivedAt) return { agent };
      const blocker = await agentArchiveBlocker(tx, agentId);
      if (blocker) return refusal("conflict", blocker);
      return { agent: await tx.agent.update({ where: { id: agentId }, data: { archivedAt: now } }) };
    });
    if ("message" in result) return refusalJson(context, result);
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

  app.get("/projects/:projectId/repos", async (context) => validated(context, await db.repo.findMany({
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
        return refusal("not-found", "Repo access not found");
      }
      const active = await tx.run.count({ where: { agentId, repoId, status: { in: ACTIVE_RUN_STATUSES } } });
      if (active > 0) return refusal("conflict", "Cannot revoke repo access while the agent has an active run on this Repo");
      const dependentSteps = await tx.task.count({ where: {
        projectId: grant.projectId,
        repoId,
        assigneeAgentId: agentId,
        chainId: { not: null },
        archivedAt: null,
        status: { in: [TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.DOING, TaskStatus.REVIEW] },
      } });
      if (dependentSteps > 0) {
        return refusal("conflict", "Cannot revoke repo access while a nonterminal chain step depends on this grant");
      }
      await tx.agentRepoAccess.delete({ where: { agentId_repoId: { agentId, repoId } } });
      return { ok: true as const };
    });
    return "message" in result ? refusalJson(context, result) : context.body(null, 204);
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
    const result = await serializable(db, async (tx) => {
      const goal = await tx.goal.findUniqueOrThrow({ where: { id: goalId } });
      const last = await tx.goalDefinitionItem.findFirst({ where: { goalId }, orderBy: { itemIndex: "desc" } });
      const item = await tx.goalDefinitionItem.create({ data: { goalId, itemIndex: (last?.itemIndex ?? -1) + 1, text: body.text } });
      if (goal.dodApproved && goal.status === GoalStatus.COMPLETED) {
        await tx.goal.update({ where: { id: goalId }, data: { status: GoalStatus.ACTIVE, endedAt: null } });
      }
      return item;
    });
    return context.json(result, 201);
  });
  app.patch("/goals/:goalId/definition-of-done/:itemId", async (context) => {
    const goalId = id.parse(context.req.param("goalId"));
    const itemId = id.parse(context.req.param("itemId"));
    const body = await readJson(context.req.raw, definitionItemPatch);
    const result = await serializable(db, async (tx) => {
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
    });
    return result ? context.json(result) : context.json({ error: "Definition of Done item not found" }, 404);
  });
  app.delete("/goals/:goalId/definition-of-done/:itemId", async (context) => {
    const goalId = id.parse(context.req.param("goalId"));
    const itemId = id.parse(context.req.param("itemId"));
    const deleted = await serializable(db, async (tx) => {
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
    });
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
        return refusalJson(context, refusal("invalid-request", error.message, { code: error.code }));
      }
      const schemaRefusal = templateSchemaRefusal(error);
      if (schemaRefusal) return refusalJson(context, schemaRefusal);
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
    const view = context.req.query("view") ?? "full";
    if (view !== "full" && view !== "board") {
      return context.json({ error: "view must be full or board" }, 400);
    }
    const scope: TaskReadScope = { ...(projectId ? { projectId } : {}), archived };
    const payload = view === "board"
      ? await readBoard(db, scope)
      : await readTaskList(db, scope, { enrich: (context.req.query("enrich") ?? "true") !== "false" });
    return validated(context, payload);
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
    try {
      const task = await db.$transaction(async (tx) => {
        // The check above answered from an unlocked read. This one holds the
        // Agent-row mutex through the task and `openRun`, so a
        // concurrent archive either loses the race or is refused for this run.
        const currentAgent = agent ? await lockAgentRow(tx, agent.id) : null;
        if (agent && !currentAgent) return refusal("invalid-request", "Assignee does not belong to this project");
        if (currentAgent?.archivedAt) return refusal("invalid-request", `Assignee ${currentAgent.name} is archived`);
        // §D-P4, inside the transaction and before `tx.task.create`. This route
        // cannot set `templateStepId` at all, so in practice it refuses the
        // sentinel Agent outright — which is the point: an ordinary task
        // assigned to the sentinel would claim as `agent` and spawn a model CLI
        // with `mechanical/merge-executor-v1` as its model.
        const bindingRefusal = await integratorBindingRefusalFor(tx, {
          assigneeAgentName: currentAgent?.name ?? null,
          templateStep: null,
        });
        if (bindingRefusal) return refusal("invalid-request", bindingRefusal);
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
        if (created.status === TaskStatus.TODO && currentAgent && repo && body.assigneeType === AssigneeType.AGENT && schedule.scheduleKind === ScheduleKind.NOW && mayQueueInline) {
          // Bypassing `openRun` here once put step 1 on a per-Task branch while
          // every later Step shared the Chain branch, silently dropping step 1.
          const opened = await openRun(tx, created.id, { kind: "task-created", readyAt: new Date() });
          // A refusal must roll back the Task born earlier in this transaction;
          // returning it would commit a Task whose requested eager Run is absent.
          if (!opened.ok) throw new TaskCreateOpenRunRefusal(opened.refusal);
        }
        return { created };
      });
      if ("message" in task) return refusalJson(context, task);
      return context.json(task.created, 201);
    } catch (error: unknown) {
      if (error instanceof TaskCreateOpenRunRefusal) return refusalJson(context, error.refusal);
      throw error;
    }
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
    const admission = await db.$transaction((tx) => readStepAdmission(tx, taskId, { locked: false }));
    if (!admission.task) return refusalJson(context, admission.refusal);
    const task = admission.task;
    return context.json({
      ...admission.verdict,
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
    const chainId = subject.chainId;

    const chainInclude = {
      assigneeAgent: { select: {
        id: true,
        title: true,
        archivedAt: true,
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

    // Bindings are stored only on the first task. Keep the common unbound path
    // at zero predecessor lookups, and resolve the one pointer only when the
    // chain's first execution row carries it. This is deliberately separate
    // from the row include above: including the self-relation would make every
    // historical chain pay for a relation query it cannot use.
    const firstTask = [...rows].sort((left, right) => (
      (left.chainLayer ?? left.chainIndex ?? 0) - (right.chainLayer ?? right.chainIndex ?? 0)
        || (left.chainIndex ?? 0) - (right.chainIndex ?? 0)
        || left.id.localeCompare(right.id)
    ))[0];
    const dispatchAfterTaskId = firstTask?.dispatchAfterTaskId ?? null;
    const dispatchAfter = dispatchAfterTaskId === null
      ? null
      : await db.task.findFirst({
        where: { id: dispatchAfterTaskId, projectId: subject.projectId },
        select: { id: true, name: true, status: true },
      });
    const chainRows = rows.map((row) => ({
      ...row,
      dispatchAfter: row.id === firstTask?.id ? dispatchAfter : null,
    }));

    const [chainRead, recoveryRow] = await Promise.all([
      db.$transaction(async (tx) => {
        // Read the control authority once in the same transaction used for
        // admission. The route projects this exact row, while the shared
        // admission seam consumes the same snapshot for held-layer startability.
        const control = await tx.chainControl.findUnique({
          where: { projectId_chainId: { projectId: subject.projectId, chainId } },
          select: {
            projectId: true,
            chainId: true,
            state: true,
            heldLayer: true,
            heldAt: true,
            holdRequestId: true,
            holdReason: true,
            releasedAt: true,
            releaseRequestId: true,
            holdGeneration: true,
          },
        });
        const controls: ReadonlyMap<string, ChainControlSnapshot> = control === null
          ? new Map()
          : new Map([[chainKey({ projectId: control.projectId, chainId: control.chainId }), {
            ...control,
            held: control.state === ChainControlState.HELD,
          }]]);
        const admissions = await readStepAdmissions(tx, chainRows.map((row) => row.id), { locked: false, controls });
        return { admissions, control };
      }),
      db.mergeRecoveryAttempt.findFirst({
        where: { integratorTask: { projectId: subject.projectId, chainId } },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    const { admissions, control } = chainRead;
    const mergeRecovery = mergeRecoveryProjection(recoveryRow);
    const ordinals = positions(chainRows);
    const progress = chainProgress(chainRows);

    return context.json({
      chainId,
      total: progress?.total ?? chainRows.length,
      done: progress?.done ?? 0,
      control: control === null ? null : chainControlReadProjection(control),
      steps: chainRows.map((row) => ({
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
        startable: admissions.get(row.id)?.verdict.startable ?? false,
        startAction: admissions.get(row.id)?.verdict.startable
          ? row.status === TaskStatus.BACKLOG ? "recover" : "start"
          : null,
        holdRefusal: admissions.get(row.id)?.holdRefusal?.message ?? null,
        currentExecution: admissions.get(row.id)?.facts.active ?? false,
        blockedOn: row.id === firstTask?.id
          && row.dispatchAfterTaskId !== null
          && dispatchAfter !== null
          && dispatchAfter.status !== TaskStatus.DONE
          ? { taskId: dispatchAfter.id, name: dispatchAfter.name, status: dispatchAfter.status }
          : null,
        mergeRecovery,
      })),
    });
  });
  app.post("/tasks/:taskId/chain/hold", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, chainHoldInput);
    const result = await readCommitted(db, async (tx) => {
      // Chain identity is immutable after dispatch, so this unlocked read only
      // chooses the mutex. Every fact used for the write is re-read after the
      // full-chain lock, just as completion and task mutation do.
      const identity = await tx.task.findUnique({
        where: { id: taskId },
        select: { projectId: true, chainId: true },
      });
      if (!identity) return refusal("not-found", "Task not found");
      if (!identity.chainId) return refusal("conflict", "Task does not belong to a Chain");

      await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
      const chainRows = await tx.task.findMany({
        where: { projectId: identity.projectId, chainId: identity.chainId },
        select: { id: true, status: true, chainIndex: true, chainLayer: true },
      });
      // Keep the route's task addressing scoped to the same project/Chain pair
      // selected above. This is defensive against malformed legacy rows and
      // makes a missing row a normal 404 instead of creating an orphan control.
      if (!chainRows.some((row) => row.id === taskId)) return refusal("not-found", "Task not found");

      const existing = await tx.chainControl.findUnique({
        where: { projectId_chainId: { projectId: identity.projectId, chainId: identity.chainId } },
      });
      // Event history is the durable idempotency ledger. A delayed retry of an
      // accepted Hold must remain a no-op even after Resume has replaced the
      // mutable state with RELEASED.
      const priorRequest = existing === null ? null : await tx.chainControlEvent.findUnique({
        where: {
          chainControlId_kind_requestId: {
            chainControlId: existing.id,
            kind: ChainControlState.HELD,
            requestId: body.requestId,
          },
        },
      });
      if (priorRequest || existing?.state === ChainControlState.HELD) {
        if (!existing) throw new Error("Chain control event exists without its authority");
        return {
          control: chainControlMutationProjection(existing),
          duplicate: true,
        };
      }

      const heldLayer = chainRows
        .filter((row) => row.status !== TaskStatus.DONE)
        .map((row) => row.chainLayer ?? row.chainIndex)
        .filter((layer): layer is number => layer !== null)
        .sort((left, right) => left - right)[0];
      if (heldLayer === undefined) {
        return refusal("conflict", "Cannot hold a completed Chain; there is nothing left to hold");
      }

      const now = new Date();
      const holdGeneration = (existing?.holdGeneration ?? 0) + 1;
      const held = existing
        ? await tx.chainControl.update({
          where: { id: existing.id },
          data: {
            state: ChainControlState.HELD,
            heldLayer,
            heldAt: now,
            holdRequestId: body.requestId,
            holdReason: body.reason ?? null,
            releasedAt: null,
            releaseRequestId: null,
            holdGeneration,
          },
        })
        : await tx.chainControl.create({
          data: {
            projectId: identity.projectId,
            chainId: identity.chainId,
            state: ChainControlState.HELD,
            heldLayer,
            heldAt: now,
            holdRequestId: body.requestId,
            holdReason: body.reason ?? null,
            holdGeneration,
          },
        });
      await tx.chainControlEvent.create({
        data: {
          chainControlId: held.id,
          kind: ChainControlState.HELD,
          layer: heldLayer,
          actorType: "operator",
          actorId: null,
          requestId: body.requestId,
          reason: body.reason ?? null,
          createdAt: now,
          holdGeneration,
        },
      });
      return {
        control: chainControlMutationProjection(held),
        duplicate: false,
      };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });
  app.post("/tasks/:taskId/chain/resume", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, chainResumeInput);
    const result = await readCommitted(db, async (tx) => {
      // Identity chooses the mutex only. The chain rows and control authority
      // are re-read after the full-chain lock, so Resume serializes with both
      // completion and Hold before deciding whether it may activate work.
      const identity = await tx.task.findUnique({
        where: { id: taskId },
        select: { projectId: true, chainId: true },
      });
      if (!identity) return refusal("not-found", "Task not found");
      if (!identity.chainId) return refusal("conflict", "Task does not belong to a Chain");

      await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
      const chainRows = await tx.task.findMany({
        where: { projectId: identity.projectId, chainId: identity.chainId },
        select: {
          id: true,
          projectId: true,
          name: true,
          chainId: true,
          chainIndex: true,
          chainLayer: true,
          status: true,
          assigneeType: true,
          assigneeAgentId: true,
          repoId: true,
        },
      });
      if (!chainRows.some((row) => row.id === taskId)) return refusal("not-found", "Task not found");

      const existing = await tx.chainControl.findUnique({
        where: { projectId_chainId: { projectId: identity.projectId, chainId: identity.chainId } },
      });
      if (!existing) {
        return { control: null, duplicate: true, nextTaskId: null, gated: false };
      }
      // The append-only event ledger is the durable idempotency key. Looking
      // only at the mutable RELEASED row would let a delayed Resume replay
      // release a later Hold, which is precisely the transition this route
      // must never resurrect.
      const priorRequest = await tx.chainControlEvent.findUnique({
        where: {
          chainControlId_kind_requestId: {
            chainControlId: existing.id,
            kind: ChainControlState.RELEASED,
            requestId: body.requestId,
          },
        },
      });
      if (priorRequest || existing.state !== ChainControlState.HELD) {
        return {
          control: chainControlMutationProjection(existing),
          duplicate: true,
          nextTaskId: null,
          gated: false,
        };
      }
      if (existing.heldLayer === null) {
        throw new Error("Held Chain control is missing its held layer");
      }

      const anchor = resumeActivationAnchor(chainRows, existing.heldLayer);
      const anchorLayer = anchor === null ? null : executionLayer(anchor);
      const sourceRun = anchorLayer === null
        ? null
        : await tx.run.findFirst({
          where: {
            taskId: { in: chainRows.filter((row) => executionLayer(row) === anchorLayer).map((row) => row.id) },
            status: RunStatus.SUCCEEDED,
            session: { isNot: null },
          },
          orderBy: [{ endedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
        });
      if (anchor !== null && sourceRun === null && resumeActivationNeedsSourceRun(chainRows, anchor)) {
        return refusal("conflict", "Cannot resume an approval layer without a succeeded source Run session");
      }

      const now = new Date();
      // Keep the generation in the release row and event. The state and
      // generation predicate are a compare-and-set even though the Chain
      // mutex is the normal serializer; this closes a direct writer race and
      // makes a losing release side-effect free.
      const releasedCount = await tx.chainControl.updateMany({
        where: {
          id: existing.id,
          state: ChainControlState.HELD,
          holdGeneration: existing.holdGeneration,
        },
        data: {
          state: ChainControlState.RELEASED,
          releasedAt: now,
          releaseRequestId: body.requestId,
        },
      });
      if (releasedCount.count !== 1) {
        const current = await tx.chainControl.findUniqueOrThrow({ where: { id: existing.id } });
        return {
          control: chainControlMutationProjection(current),
          duplicate: true,
          nextTaskId: null,
          gated: false,
        };
      }
      const released = await tx.chainControl.findUniqueOrThrow({ where: { id: existing.id } });
      await tx.chainControlEvent.create({
        data: {
          chainControlId: released.id,
          kind: ChainControlState.RELEASED,
          layer: existing.heldLayer,
          actorType: "operator",
          actorId: null,
          requestId: body.requestId,
          reason: null,
          createdAt: now,
          holdGeneration: existing.holdGeneration,
        },
      });

      const activated = anchor
        ? await activateChainSuccessor(tx, anchor, { sourceRunId: sourceRun?.id ?? null }, now)
        : { nextTaskId: null, gated: false };
      return {
        control: chainControlMutationProjection(released),
        duplicate: false,
        nextTaskId: activated.nextTaskId,
        gated: activated.gated,
      };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });
  app.patch("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await patchTask(db, taskId, await readJson(context.req.raw, taskPatch));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.delete("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const deleted = await readCommitted(db, async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return false;
      await tx.task.delete({ where: { id: taskId } });
      return true;
    });
    if (!deleted) return context.json({ error: "Task not found" }, 404);
    return context.body(null, 204);
  });
  app.post("/tasks/:taskId/retry", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      const admission = await readStepAdmission(tx, taskId, { locked: true });
      if (!admission.task) return admission.refusal;
      const task = admission.task;
      // Retry has its own terminal-state rules and intentionally ignores the
      // Start-only refusal ladder. A Chain hold is the one admission control
      // refusal it must consume before opening a fresh Run.
      if (admission.holdRefusal) return admission.holdRefusal;
      if (admission.blocker) {
        return refusal("conflict", `Cannot retry ${task.name}; predecessor ${admission.blocker.name} is not done`);
      }
      if (admission.facts.total === 0) return refusal("conflict", "Task has no run to retry");
      if (admission.facts.active) {
        return refusal("conflict", "Task already has an active run");
      }
      const opened = await openRun(tx, taskId, { kind: "retry", readyAt: now });
      if (!opened.ok) return opened.refusal;
      const run = opened.run;
      await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO, failureReason: null } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: `Run ${run.runNumber} queued by operator retry` } });
      return { run };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.run, 201);
  });
  app.post("/tasks/:taskId/start", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    try {
      const result = await readCommitted(db, async (tx) => {
        if (!await lockTaskMutationRows(tx, taskId)) {
          return refusal("not-found", "Task not found");
        }
        const admission = await readStepAdmission(tx, taskId, { locked: true });
        if (!admission.task) return admission.refusal;
        if (admission.refusal) return admission.refusal;
        const task = admission.task;
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
      });
      if ("message" in result) return refusalJson(context, result);
      return context.json({ runId: result.run.id, runNumber: result.run.runNumber }, 201);
    } catch (error: unknown) {
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
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      if (await hasActiveRun(tx, taskId)) {
        return refusal("conflict", "Cannot archive a task with an active run");
      }
      if (locked.status === TaskStatus.REVIEW) {
        const open = await tx.inboxMessage.count({ where: { gateTaskId: taskId, status: InboxStatus.OPEN } });
        if (open > 0) return refusal("conflict", "Decide the approval gate in the Inbox first");
      }
      if (locked.archivedAt !== null) {
        return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
      }
      const task = await tx.task.update({ where: { id: taskId }, data: { archivedAt: new Date() } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Task archived" } });
      return { task };
    });
    if ("message" in result) return refusalJson(context, result);
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
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      if (locked.archivedAt === null) {
        return { task: await tx.task.findUniqueOrThrow({ where: { id: taskId } }) };
      }
      if (isLiveStatus(locked.status)) {
        const blocked = await reactivationBlocked(tx, locked);
        if (blocked) return refusal("conflict", blocked);
      }
      const task = await tx.task.update({ where: { id: taskId }, data: { archivedAt: null } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Task unarchived" } });
      return { task };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.post("/projects/:projectId/tasks/archive-done", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const result = await readCommitted(db, async (tx) => {
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
    });
    return context.json(result);
  });
  app.post("/tasks/:taskId/schedule/pause", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await db.$transaction(async (tx) => {
      if (!await lockTaskMutationRows(tx, taskId)) return refusal("not-found", "Task not found");
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { scheduleKind: true } });
      if (task.scheduleKind !== ScheduleKind.CRON) return refusal("invalid-request", "Only CRON tasks can be paused");
      // In-flight copies are left alone: pausing stops future occurrences, it does
      // not reach into work that already started.
      const paused = await tx.task.update({ where: { id: taskId }, data: { schedulePausedAt: new Date() } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Schedule paused" } });
      return { task: paused };
    });
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.post("/tasks/:taskId/schedule/resume", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await db.$transaction(async (tx) => {
      if (!await lockTaskMutationRows(tx, taskId)) return refusal("not-found", "Task not found");
      const task = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { scheduleKind: true, cron: true, timezone: true },
      });
      if (task.scheduleKind !== ScheduleKind.CRON) return refusal("invalid-request", "Only CRON tasks can be resumed");
      let runAt: Date;
      try {
        if (!task.cron) throw new Error("CRON tasks require cron");
        // Recomputed from *now*, so a long pause produces no catch-up burst.
        runAt = computeNextOccurrence(task.cron, task.timezone, new Date());
      } catch (error: unknown) {
        return refusal("invalid-request", error instanceof Error ? error.message : "Invalid schedule");
      }
      const resumed = await tx.task.update({ where: { id: taskId }, data: { schedulePausedAt: null, runAt } });
      await tx.taskActivity.create({ data: { taskId, actorType: "operator", body: "Schedule resumed" } });
      return { task: resumed };
    });
    if ("message" in result) return refusalJson(context, result);
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
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
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
        || isCanonicalBlindFindingsStep(task.templateStep);
      if (immutableReview && existing) {
        return refusal("conflict", `${task.templateStep?.outputKind ?? body.kind} task output is immutable once persisted`);
      }
      const output = await tx.taskStepOutput.upsert({
        where: { taskId },
        create: { taskId, kind: body.kind, body: body.body, commitSha: body.commitSha ?? null, ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
        update: { kind: body.kind, body: body.body, ...(body.commitSha ? { commitSha: body.commitSha } : {}), ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
      });
      return { output };
    });
    if ("message" in result) return refusalJson(context, result);
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
    const result = await readCommitted(db, async (tx) => {
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      const task = await loadIntegratorTask(tx, taskId);
      if (!task || !taskIsIntegratorStep(task)) {
        return refusal("conflict", "Task is not a mechanical merge step");
      }
      const stopped = await stopStateFor(tx, taskId);
      if (!stopped) return refusal("conflict", "Task is not in a merge stop state");
      if (stopped.stop.condition !== "target-unresolvable") {
        return refusal("conflict", `Merge target correction applies to target-unresolvable only, not ${stopped.stop.condition}`);
      }
      if (!task.chainId) return refusal("conflict", "Task is not part of a chain");
      const observed = await observedChainPullRequests(tx, task.projectId, task.chainId);
      if (observed.length === 0) {
        return refusal(
          "conflict",
          "This chain delivered no pull request; abandon it, or deliver the pull request by re-running the delivering step, after which resolution succeeds with no correction",
        );
      }
      if (!observed.includes(body.prNumber)) {
        return refusal(
          "conflict",
          `Pull request #${body.prNumber} is not among this chain's own delivered pull requests (${observed.join(", ")})`,
        );
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
        const rejected = refusalFor(error);
        if (rejected) return rejected;
        throw error;
      }
      return { correction: { id: activity.id, prNumber: body.prNumber, observed, confirmationCardId: cardId } };
    });
    if ("message" in result) return refusalJson(context, result);
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
        metadata: jsonValue({
          ...body.metadata,
          [OPERATOR_NOTE_METADATA_FIELD]: true,
        }),
      },
    }), 201);
  });

  app.get("/inbox/messages/summary", async (context) => {
    const messages = await db.inboxMessage.findMany({
      where: { status: InboxStatus.OPEN, replyToMessageId: null },
      select: { id: true, status: true, from: true, kind: true, gateTaskId: true, replyToMessageId: true },
    });
    const blocked = await blockedMessageIds(db, messages.map((message) => message.id));
    const needsReply = messages.filter((message) => (
      message.status === InboxStatus.OPEN && !withDismissible(message, blocked).dismissible
    )).length;
    return validated(context, { needsReply });
  });
  app.get("/inbox/messages", async (context) => {
    const projectId = context.req.query("projectId");
    const messages = await db.inboxMessage.findMany({
    where: {
      replyToMessageId: null,
      ...(projectId ? { OR: [
        { agent: { projectId } },
        { task: { projectId } },
        { goal: { projectId } },
        { session: { projectId } },
      ] } : {}),
    },
    include: { decisions: true, replies: { orderBy: { createdAt: "asc" } }, session: { select: { taskId: true } } },
    orderBy: { createdAt: "desc" },
    });
    const blocked = await blockedMessageIds(db, messages.map((message) => message.id));
    return validated(context, messages.map((message) => withDismissible(withArtifactTask(message), blocked)));
  });
  app.get("/inbox/messages/:messageId", async (context) => {
    const message = await db.inboxMessage.findUnique({
      where: { id: id.parse(context.req.param("messageId")) },
      include: {
        decisions: true,
        replies: { orderBy: { createdAt: "asc" } },
        replyTo: true,
        session: { select: { taskId: true } },
      },
    });
    if (!message) return context.json({ error: "Inbox message not found" }, 404);
    return context.json(withDismissible(withArtifactTask(message), await blockedMessageIds(db, [message.id])));
  });
  app.post("/inbox/messages/:messageId/decision", async (context) => {
    const body = await readJson(context.req.raw, inboxDecisionInput);
    try {
      const result = await applyInboxDecision(db, {
        inboxMessageId: id.parse(context.req.param("messageId")),
        externalEventId: `web:${body.requestId}`,
        decision: body.decision,
        actorOpenId: "web-operator",
      });
      return context.json(result, result.duplicate ? 200 : 201);
    } catch (error: unknown) {
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
      select: { id: true, status: true, from: true, kind: true, gateTaskId: true, replyToMessageId: true },
    });
    if (!message) return context.json({ error: "Inbox message not found" }, 404);
    if (!withDismissible(message, await blockedMessageIds(db, [messageId])).dismissible) {
      return context.json({ error: "Only a notification no run is waiting on can be closed without a decision" }, 409);
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
        gateTaskId: null, replyToMessageId: null,
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
  app.post("/inbox/messages/:messageId/supersede", async (context) => {
    // principalMayAccess already restricts this operator action, but keep the
    // check at the handler boundary so the lifecycle operation stays explicit
    // if route middleware is ever rearranged.
    if (context.get("principal").kind !== "operator") return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, inboxCloseInput);
    const result = await supersedeTaskInboxMessage(
      db,
      id.parse(context.req.param("messageId")),
      body.requestId,
    );
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });

  app.post("/runner/availability", async (context) => {
    const body = await readJson(context.req.raw, runnerAvailabilityInput);
    const now = new Date();
    // Runner availability is global backend state written by every daemon.
    // Keep its Serializable guarantee and absorb two short write conflicts.
    const state = await serializable(db, async (tx) => {
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
    }, { attempts: 3 });
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
    const claimed = await claimRun(db, {
      body,
      claimantClass,
      now,
      specificationReader: options.specificationReader ?? null,
      signal: context.req.raw.signal,
    });
    if (claimed && "error" in claimed) {
      if (typeof claimed.error !== "string") throw new TypeError("Run claim refusal has no message");
      if (typeof claimed.reason !== "string") throw new TypeError("Run claim refusal has no reason");
      return refusalJson(context, refusal("conflict", claimed.error, { reason: claimed.reason }));
    }
    return claimed ? context.json(claimed) : context.body(null, 204);
  });

  app.post("/runner/runs/:runId/start", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    // A mechanical run hands no bytes to a provider, so it has no dispatched
    // prompt to hash. The independently authenticated executor alone receives
    // that exemption; ordinary runner starts still require an exact hash.
    const body = principal.kind === "merge-executor"
      ? { ...await readJson(context.req.raw, mechanicalStartInput), promptHash: null }
      : await readJson(context.req.raw, startInput);
    const now = new Date();
    // A run that has already started is not startable again, so this fence is
    // narrower than the live-lease set every other route uses.
    const fence: RunFence = {
      runId,
      runnerId: body.runnerId,
      fencingToken: body.fencingToken,
      at: now,
      statuses: [RunStatus.CLAIMED, RunStatus.PROVISIONING],
    };
    const started = await db.$transaction(async (tx) => {
      const locked = await lockRunRow(tx, runId);
      // Inbox resume reuses the same Run and Session. Keep the original
      // lifecycle anchor when the resumed provider calls /start again; only a
      // run that has never started gets this request's timestamp.
      const existing = locked === null ? null : await tx.run.findUnique({
        where: { id: runId },
        select: { startedAt: true },
      });
      const startedAt = existing?.startedAt ?? now;
      const updated = await tx.run.updateMany({
        where: fencedRunWhere(fence),
        data: {
          status: RunStatus.RUNNING,
          startedAt,
          adapterVersion: body.adapterVersion,
          cliVersion: body.cliVersion,
          authMode: body.authMode ?? null,
          promptHash: body.promptHash,
          manifest: jsonValue(body.manifest),
          workspacePath: body.workspacePath,
          branch: body.branch ?? null,
          baseSha: body.baseSha ?? null,
        },
      });
      if (updated.count !== 1) return explainFenceRefusal(tx, fence);
      const session = await tx.session.updateMany({
        where: { runId, executionStatus: SessionExecutionStatus.PROVISIONING },
        data: {
          executionStatus: SessionExecutionStatus.RUNNING,
          runtimeHandle: body.runtimeHandle ?? null,
          resumeInput: null,
          provisionedAt: now,
          startedAt,
        },
      });
      if (session.count !== 1) throw new Error(`Run ${runId} has no startable Session`);
      return null;
    });
    return started === null
      ? context.json({ ok: true })
      : refusalJson(context, runFenceRefusal(fenceRefusalResponse(started)));
  });

  app.post("/runner/runs/:runId/heartbeat", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, heartbeatInput);
    const now = new Date();
    runners.note(body.runnerId, body, now);
    const fence: RunFence = { runId, runnerId: body.runnerId, fencingToken: body.fencingToken, at: now };
    const updated = await db.run.updateMany({
      where: fencedRunWhere(fence),
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
      ? refusalJson(context, refusal("conflict", "Run suspended for Inbox", { code: "WAITING_INBOX" }))
      : refusalJson(context, runFenceRefusal(fenceRefusalResponse(await explainFenceRefusal(db, fence))));
  });

  app.post("/runner/runs/:runId/cancel/acknowledge", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, cancelAcknowledgeInput);
    const result = await db.$transaction((tx) => terminalizeRun(tx, {
      runId,
      at: new Date(),
      outcome: {
        kind: "cancelled",
        requestId: body.requestId,
        runnerId: body.runnerId,
        fencingToken: body.fencingToken,
        actorId: body.runnerId,
        cleanupConfirmed: true,
        activity: "acknowledged",
        ...(body.workspacePath === undefined ? {} : { workspacePath: body.workspacePath }),
        ...(body.branch === undefined ? {} : { branch: body.branch }),
        ...(body.baseSha === undefined ? {} : { baseSha: body.baseSha }),
        ...(body.worktreeContainmentViolations === undefined
          ? {}
          : { worktreeContainmentViolations: body.worktreeContainmentViolations }),
      },
    }));
    if (result === null) return refusalJson(context, refusal("conflict", "Run changed while cancellation was being acknowledged"));
    if ("message" in result) return refusalJson(context, result);
    const { leaseToRelease, ...settlement } = result;
    // Cancellation is a terminal write. The lease target is deliberately
    // released only after that transaction commits, when the release adapter
    // can also record the confirmed deletion and its hold window.
    await releaseChainLease(leaseToRelease, db);
    return context.json(settlement);
  });

  // Publication is a separate durable fact from terminal completion. Persist
  // it immediately after git push, before GitHub work and cleanup, so a lost
  // runner does not make the reconciler forget a branch that already exists.
  app.post("/runner/runs/:runId/publication", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, publicationInput);
    const now = new Date();
    const fence: RunFence = { runId, runnerId: body.runnerId, fencingToken: body.fencingToken, at: now };
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
      && activeRunStatuses.includes(run.status);
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
    if (!live && !salvage) {
      return refusalJson(context, runFenceRefusal(fenceRefusalResponse(await explainFenceRefusal(db, fence))));
    }
    const updated = await db.$transaction(async (tx) => {
      const ack = await tx.run.updateMany({
        where: live
          ? fencedRunWhere(fence)
          : {
              id: runId,
              runnerId: body.runnerId,
              fencingToken: body.fencingToken,
              OR: [{ pushedBranch: null }, { pushedBranch: body.pushedBranch }],
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
        ? refusalJson(context, refusal("conflict", "Salvage is durable, but the replacement already started from its prior base"))
        : refusalJson(context, runFenceRefusal(fenceRefusalResponse(await explainFenceRefusal(db, fence))));
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
      || !activeRunStatuses.includes(run.status)
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
    const fence: RunFence = { runId, runnerId: body.runnerId, fencingToken: body.fencingToken, at: new Date() };
    const result = await db.$transaction((tx) => withFencedRun(tx, fence, {
      session: { select: { id: true, providerConversationId: true } },
    }, async (run) => {
      if (!run.session) return fenceRefusalResponse("stale-fence");
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
    }));
    if (isFenceRefusalResponse(result)) {
      const waiting = await db.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
      return waiting
        ? refusalJson(context, refusal("conflict", "Run suspended for Inbox", { code: "WAITING_INBOX" }))
        : refusalJson(context, runFenceRefusal(result));
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
    const fence: RunFence = { runId, fencingToken: body.fencingToken, at: new Date() };
    const result = await db.$transaction((tx) => withFencedRun(tx, fence, {
      taskId: true,
      leaseGeneration: true,
      task: { select: { templateStep: { select: {
        stepIndex: true,
        outputKind: true,
        taskTemplate: { select: { name: true } },
      } } } },
    }, async (run) => {
      // A session principal carries its own generation of the same fence.
      const leaseGeneration = principal.kind === "session" ? principal.leaseGeneration : null;
      if (!run.taskId || leaseGeneration !== null && run.leaseGeneration !== leaseGeneration) {
        return fenceRefusalResponse("stale-fence");
      }
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
    }));
    return isFenceRefusalResponse(result)
      ? refusalJson(context, runFenceRefusal(result))
      : context.json(result, 201);
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
      include: {
        task: {
          include: {
            stepOutput: true,
            templateStep: {
              select: {
                name: true,
                stepIndex: true,
                outputKind: true,
                taskTemplate: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!run) return context.json({ error: "Run not found" }, 404);
    const outputPersisted = run.task?.stepOutput?.runId === run.id;
    const outputSatisfiedByPriorRun = Boolean(
      run.task?.stepOutput
      && !outputPersisted
      && outputIsImmutableOncePersisted(run.task.templateStep),
    );
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
        outputRequired: requiredOutputKind(run.task.templateStep) !== null,
        outputRemediationAllowed:
          !isRegressionVerificationOutputKind(run.task.templateStep?.outputKind)
          && !(run.task.stepOutput && outputIsImmutableOncePersisted(run.task.templateStep)),
        outputSatisfiedByPriorRun,
        // A retry must not mistake an earlier Run's artifact for its own. This
        // is the same run-scoped fact completion validates before it advances.
        outputPersisted,
      } : null,
    });
  });

  app.put("/session/runs/:runId/output", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, taskOutputInput);
    if (!body.fencingToken) return context.json({ error: "fencingToken is required" }, 400);
    const fence: RunFence = { runId, fencingToken: body.fencingToken, at: new Date() };
    const result = await db.$transaction((tx) => withFencedRun(tx, fence, {
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
    }, async (run) => {
      if (!run.taskId || !run.task) return fenceRefusalResponse("stale-fence");
      const executionMode = executionModeFor(run.task.templateStep);
      if (executionMode !== "mechanical" && !body.commitSha) {
        return { requestError: "commitSha is required", status: 400 as const };
      }
      const outputRefusal = mechanicalPrincipalRefusal(
        executionMode,
        isMergeExecutorRunnerId(run.runnerId ?? "") ? "merge-executor" : "runner",
        run.runnerId ?? "",
      );
      if (outputRefusal) return { requestError: outputRefusal, status: 403 as const };
      return { persisted: await persistSessionTaskOutput(tx, {
        task: run.task,
        fence,
        kind: body.kind,
        body: body.body,
        commitSha: body.commitSha ?? null,
        ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}),
      }) };
    }));
    if (isFenceRefusalResponse(result)) return refusalJson(context, runFenceRefusal(result));
    if ("requestError" in result) return context.json({ error: result.requestError }, result.status);
    const { persisted } = result;
    if (isFenceRefusalResponse(persisted)) return refusalJson(context, runFenceRefusal(persisted));
    if (!persisted.ok) return refusalJson(context, refusal("conflict", persisted.reason));
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
      if (error instanceof InboxRunFenceRefusal) return context.json(error.refusal, 409);
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
    const result = await completeRun(db, {
      runId,
      body,
      claimantClass: principal.kind === "merge-executor" ? "merge-executor" : "runner",
    }, releaseChainLease);
    if ("message" in result) return refusalJson(context, result);
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
      await lockRunRow(tx, runId);
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
      if (!run) return refusal("not-found", "Run not found");
      if (body.parkTask && !run.taskId) return refusal("conflict", "Run has no Task to park");
      const parkTarget = body.parkTask && run.taskId ? await lockTaskMutationRows(tx, run.taskId) : null;
      if (body.parkTask && run.taskId && !parkTarget) return refusal("not-found", "Task not found");
      if (parkTarget && parkTarget.archivedAt !== null) {
        return refusal("conflict", "Cannot park an archived task");
      }
      if (parkTarget?.status === TaskStatus.DONE) return refusal("conflict", "Cannot park a completed task");
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
          return refusal("conflict", `Run already has cancellation request ${run.cancelRequestId}`);
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
        return refusal("conflict", "Mechanical merge Runs cannot be cancelled after authorization");
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
      if (requested.count !== 1) return refusal("conflict", "Run changed while cancellation was being requested");
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
        const terminal = await terminalizeRun(tx, {
          runId: run.id,
          at: now,
          outcome: {
            kind: "cancelled",
            requestId: body.requestId,
            cleanupConfirmed: true,
            activity: "acknowledged",
          },
        });
        if (terminal === null || "message" in terminal) return terminal;
        const { leaseToRelease, ...settlement } = terminal;
        return { ...settlement, releaseMergeLeaseTask: leaseToRelease };
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
    if (result === null) return refusalJson(context, refusal("conflict", "Run changed while cancellation was being settled"));
    if ("message" in result) return refusalJson(context, result);
    const { releaseMergeLeaseTask, ...cancellation } = result;
    // A queued cancellation is the final consumer when no runner ever claims
    // the Run. Keep the release post-commit so a rollback cannot free a lease
    // whose cancellation state was not durably written.
    await releaseChainLease(releaseMergeLeaseTask, db);
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
    if (error instanceof SerializableTransactionExhaustedError) {
      return context.json({ error: "Transaction is busy; retry later" }, 503);
    }
    const rejected = refusalFor(error);
    if (rejected) return refusalJson(context, rejected);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") return refusalJson(context, refusal("not-found", "Resource not found"));
      if (error.code === "P2002") return refusalJson(context, refusal("conflict", "Unique constraint violated"));
    }
    console.error(error);
    return context.json({ error: "Internal server error" }, 500);
  });
  app.notFound((context) => refusalJson(context, refusal("not-found", "Not found")));
  return app;
};
