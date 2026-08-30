import { createHash } from "node:crypto";

import {
  ACTIVE_RUN_STATUSES,
  AssigneeType,
  agentArchiveBlocker,
  applyInboxDecision,
  catalogRunnerForModel,
  CleanupStatus,
  CodexServiceTier,
  GoalStatus,
  enqueueTaskRun,
  openRun,
  InboxKind,
  InboxSender,
  InboxStatus,
  lockAgentRepoGrantForRevocation,
  lockAgentRow,
  lockChainRows,
  lockChainStructure,
  lockRunRow,
  NetworkingMode,
  Prisma,
  type PrismaClient,
  RepoPermission,
  RunStatus,
  ScheduleKind,
  RunnerKind,
  RunnerPreference,
  recomputeSessionUsage,
  runnerFor,
  runSessionUsageCost,
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
  type ChainControlAddress,
  type DecisionRow,
  mergeRecoveryPhase,
  type MergeRecoveryAttempt,
  loadAgentSources,
  chainControlReadProjection,
  chainRunHistoryRefusal,
  deleteChain,
  holdChain,
  resumeChain,
} from "@anneal/db";
import type { ChainStep as ChainStepContract } from "@anneal/db/board-contract";
import type {
  Agent as AgentContract,
  AgentRepoAccess as AgentRepoAccessContract,
  Environment as EnvironmentContract,
  FilesystemGrant as FilesystemGrantContract,
  MCPConnection as MCPConnectionContract,
  Project as ProjectContract,
  Repo as RepoContract,
  Secret as SecretContract,
  Skill as SkillContract,
} from "@anneal/db/wire-contract";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getMimeType } from "hono/utils/mime";
import { z } from "zod";

import {
  authenticate,
  authenticateRevalidationCancellationReplay,
  principalMayAccess,
  type Principal,
} from "./auth.js";
import {
  etagFor,
  etagMatches,
  operatorMoveTargets,
  readBoard,
  readRepairChainByTask,
  readTaskList,
  serializeUsageCost,
  type TaskReadScope,
} from "./board.js";
import { isValidBranchName } from "./branch-name.js";
import { lockDoneTasks, partitionArchivable } from "./task-archive.js";
import { COSTS_DEFAULT_DAYS, COSTS_RANGE_DAYS, isValidTimeZone, readProjectCosts } from "./costs.js";
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
  projectRunnerBackend,
  recordRunnerBackendReport,
} from "./runner-backend-health.js";
import {
  chainKey,
  readChainDetail,
  chainProgress,
  chainProgressByChain,
  positions,
  readStepAdmission,
  stepName,
} from "./chain.js";
import {
  jsonValue,
  normalizeSessionEventValue,
} from "./execution.js";
import {
  createArchivedRunNoticeScheduler,
  noteArchivedQueuedRuns,
  reconcileDatabaseRuns,
  ReconciliationMaintenanceError,
} from "./reconcile.js";
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
import { InboxRunFenceRefusal, supersedeTaskInboxMessage, suspendForInbox } from "./inbox.js";
import { createStarterInstallation, onboardingInput, onboardingStatus } from "./onboarding.js";
import { preflightOnboardingRepository, RepositoryPreflightError } from "./onboarding-preflight.js";
import { instantiateTemplate, isUsableTemplateVariable } from "./templates.js";
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
import { patchTask, taskInput, taskPatch } from "./task-patch.js";
import {
  cancelBoundRevalidationRun,
  patchBoundImplementationDescription,
  readBoundImplementationTask,
  revalidationCancelRequestId,
  SPEC_REVALIDATOR_AGENT_NAME,
} from "./revalidation.js";
import { claimInput, claimRun, OPERATOR_NOTE_METADATA_FIELD, runnerTelemetryFields } from "./run-claim.js";
import { completeRun, completionInput, worktreeContainmentViolationsInput } from "./run-completion.js";
import { acknowledgeCancellation, cancelRun } from "./run-cancel.js";
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

type TaskChainResolution = {
  task: { id: string; projectId: string };
  chain: { projectId: string; chainId: string } | null;
};

/**
 * Resolves both ordinary Chain membership and the detached repair-task binding
 * used by the merge tail. The project predicate is essential: Chain IDs are
 * only unique within a project, and a malformed marker must not cross that
 * boundary.
 */
const resolveTaskChain = async (
  tx: PrismaClient | Prisma.TransactionClient,
  taskId: string,
): Promise<TaskChainResolution | null> => {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, chainId: true },
  });
  if (!task) return null;
  if (task.chainId) {
    return { task, chain: { projectId: task.projectId, chainId: task.chainId } };
  }

  const repairChainId = (await readRepairChainByTask(tx, [task])).get(task.id)?.chainId;
  return {
    task,
    chain: repairChainId
      ? { projectId: task.projectId, chainId: repairChainId }
      : null,
  };
};

const resolveDirectChainAddress = async (
  db: PrismaClient | Prisma.TransactionClient,
  taskId: string,
): Promise<ChainControlAddress | Refusal> => {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { projectId: true, chainId: true },
  });
  if (!task) return refusal("not-found", "Task not found");
  if (!task.chainId) return refusal("conflict", "Task does not belong to a Chain");
  return { projectId: task.projectId, chainId: task.chainId, taskId };
};

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
const activityInput = z.object({
  actorType: z.string().trim().min(1).max(40).default("operator"),
  actorId: z.string().trim().min(1).nullable().optional(),
  body: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const fencedActivityInput = activityInput.extend({ fencingToken: fence });
/** Revalidation is intentionally narrower than the operator task PATCH: the
 * session names only the replacement brief and the server derives the one
 * same-chain implementation task from the fenced Run. */
const revalidationPatchInput = z.object({
  fencingToken: fence,
  description: z.string(),
}).strict();
const revalidationCancelInput = z.object({ fencingToken: fence }).strict();
const mergeTargetInput = z.object({ prNumber: z.number().int().positive() });
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
const stepOverridesInput = z.record(z.string(), stepOverrideInput);
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
});
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

type ProjectResponse = ProjectContract<Date, Prisma.Decimal>;
type AgentResponse = AgentContract<Date>;
type SecretResponse = SecretContract<Date>;
type SkillResponse = SkillContract<Date>;
type MCPConnectionResponse = MCPConnectionContract<Date>;
type RepoResponse = RepoContract<Date>;

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
    allowHeaders: ["Authorization", "Content-Type", "X-Fencing-Token", "X-Anneal-Webhook-Secret", "X-Anneal-Delivery-Id"],
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
    const authorization = context.req.header("Authorization");
    let principal = await authenticate(db, authorization);
    const cancellationReplay = context.req.method === "POST"
      ? /^\/session\/runs\/([^/]+)\/revalidation\/cancel$/u.exec(context.req.path)
      : null;
    if (!principal && cancellationReplay?.[1]) {
      principal = await authenticateRevalidationCancellationReplay(db, authorization, {
        runId: cancellationReplay[1],
        requestId: revalidationCancelRequestId(cancellationReplay[1]),
      });
    }
    if (!principal) return context.json({ error: "Unauthorized" }, 401);
    if (!principalMayAccess(principal, context.req.path)) return context.json({ error: "Forbidden for principal" }, 403);
    context.set("principal", principal);
    await next();
  });

  app.get("/", (context) => context.json({ name: "Anneal control plane", phase: "execution-kernel" }));
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
      backends: Object.values(RunnerKind).map((runner) =>
        projectRunnerBackend(runner, backendsByRunner.get(runner) ?? null)),
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
      context.req.header("X-Anneal-Webhook-Secret"),
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
      ? context.req.header("X-Anneal-Delivery-Id") ?? createHash("sha256").update(raw).digest("hex")
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
    const result = await instantiateTemplate(db, template.projectId, template.id, {
      repoId: template.webhookRepoId!, variables: resolved.variables, autoStart: true,
    }, {
      actorType: "webhook",
      activityMetadata: { webhookTemplateId: template.id, firedAt: new Date().toISOString() },
      source: TaskSource.WEBHOOK,
      fire: { source: TriggerFireSource.WEBHOOK, dedupeKey },
    });
    return context.json({ chainId: result.chainId, taskIds: result.tasks.map((task) => task.id) }, 201);
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

  app.get("/projects", async (context) => validated(context,
    (await db.project.findMany({ orderBy: { createdAt: "asc" } })) satisfies ProjectResponse[]));
  app.post("/projects", async (context) => context.json(
    (await db.project.create({ data: await readJson(context.req.raw, projectInput) })) satisfies ProjectResponse, 201));
  app.get("/projects/:projectId", async (context) => {
    const project = await db.project.findUnique({ where: { id: id.parse(context.req.param("projectId")) } });
    return project ? context.json(project satisfies ProjectResponse) : context.json({ error: "Project not found" }, 404);
  });
  app.patch("/projects/:projectId", async (context) => context.json((await db.project.update({
    where: { id: id.parse(context.req.param("projectId")) },
    data: withoutUndefined(await readJson(context.req.raw, projectPatch)) as Prisma.ProjectUpdateInput,
  })) satisfies ProjectResponse));
  app.delete("/projects/:projectId", async (context) => {
    await db.project.delete({ where: { id: id.parse(context.req.param("projectId")) } });
    return context.body(null, 204);
  });

  app.get("/projects/:projectId/costs", async (context) => {
    const timeZone = context.req.query("tz");
    if (timeZone === undefined || !isValidTimeZone(timeZone)) {
      return context.json({ error: "tz must be a recognized IANA timezone" }, 400);
    }
    const raw = context.req.query("days");
    const days = raw === undefined
      ? COSTS_DEFAULT_DAYS
      : COSTS_RANGE_DAYS.find((candidate) => raw === String(candidate));
    // Refused rather than clamped: a window the caller did not ask for would be
    // read as the one they did, and the totals would be quietly wrong.
    if (days === undefined) {
      return context.json({ error: `days must be one of ${COSTS_RANGE_DAYS.join(", ")}` }, 400);
    }
    return context.json(await readProjectCosts(db, id.parse(context.req.param("projectId")), days, timeZone));
  });

  app.get("/projects/:projectId/environments", async (context) => context.json((await db.environment.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })) satisfies EnvironmentContract[]));
  app.post("/projects/:projectId/environments", async (context) => context.json((await db.environment.create({
    data: { projectId: id.parse(context.req.param("projectId")), ...await readJson(context.req.raw, environmentInput) },
  })) satisfies EnvironmentContract, 201));
  app.get("/environments/:environmentId", async (context) => {
    const environment = await db.environment.findUnique({
      where: { id: id.parse(context.req.param("environmentId")) },
      include: { secrets: { include: { secret: { select: secretPublicSelect } } } },
    });
    return environment ? context.json(environment satisfies EnvironmentContract) : context.json({ error: "Environment not found" }, 404);
  });
  app.patch("/environments/:environmentId", async (context) => context.json((await db.environment.update({
    where: { id: id.parse(context.req.param("environmentId")) },
    data: withoutUndefined(await readJson(context.req.raw, environmentPatch)),
  })) satisfies EnvironmentContract));
  app.delete("/environments/:environmentId", async (context) => {
    await db.environment.delete({ where: { id: id.parse(context.req.param("environmentId")) } });
    return context.body(null, 204);
  });

  app.get("/secrets", async (context) => context.json((await db.secret.findMany({
    select: {
      ...secretPublicSelect,
      agentGrants: { include: { agent: { select: { id: true, name: true, title: true, projectId: true } } } },
    },
    orderBy: { createdAt: "asc" },
  })) satisfies SecretResponse[]));
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
    return context.json(secret satisfies SecretResponse, 201);
  });
  app.get("/secrets/:secretId", async (context) => {
    const secret = await db.secret.findUnique({
      where: { id: id.parse(context.req.param("secretId")) },
      select: {
        ...secretPublicSelect,
        agentGrants: { include: { agent: { select: { id: true, name: true, title: true, projectId: true } } } },
      },
    });
    return secret ? context.json(secret satisfies SecretResponse) : context.json({ error: "Secret not found" }, 404);
  });
  app.patch("/secrets/:secretId", async (context) => {
    const body = await readJson(context.req.raw, secretPatch);
    const { value, ...fields } = body;
    return context.json((await db.secret.update({
      where: { id: id.parse(context.req.param("secretId")) },
      data: {
        ...withoutUndefined(fields),
        ...(value === undefined ? {} : { encryptedValue: encryptSecret(value), rotatedAt: new Date() }),
      },
      select: secretPublicSelect,
    })) satisfies SecretResponse);
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
  }) satisfies AgentResponse[]));
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
    return context.json((await db.agent.create({
      data: { ...body, foundationalPrompt, projectId },
    })) satisfies AgentResponse, 201);
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
    return agent ? context.json(agent satisfies AgentResponse) : context.json({ error: "Agent not found" }, 404);
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
    return context.json(result.agent satisfies AgentResponse);
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
    return context.json(result.agent satisfies AgentResponse);
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
    return context.json(result.agent satisfies AgentResponse);
  });
  app.post("/agents/:agentId/unarchive", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent) return context.json({ error: "Agent not found" }, 404);
    if (!agent.archivedAt) return context.json(agent satisfies AgentResponse);
    return context.json((await db.agent.update({
      where: { id: agentId },
      data: { archivedAt: null },
    })) satisfies AgentResponse);
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

  app.get("/agents/:agentId/filesystem-grants", async (context) => context.json((await db.filesystemGrant.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) }, orderBy: { folderPath: "asc" },
  })) satisfies FilesystemGrantContract[]));
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
    return context.json((await db.filesystemGrant.upsert({
      where: { agentId_folderPath: { agentId, folderPath: body.folderPath } },
      create: { agentId, ...body },
      update: body,
    })) satisfies FilesystemGrantContract, 201);
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
    return context.json((await db.filesystemGrant.update({
      where: { id: grantId },
      data: withoutUndefined(patch) as Prisma.FilesystemGrantUncheckedUpdateInput,
    })) satisfies FilesystemGrantContract);
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

  app.get("/projects/:projectId/skills", async (context) => context.json((await db.skill.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { agents: true },
    orderBy: { createdAt: "asc" },
  })) satisfies SkillResponse[]));
  app.post("/projects/:projectId/skills", async (context) => {
    const body = await readJson(context.req.raw, skillInput);
    return context.json((await db.skill.create({
      data: { projectId: id.parse(context.req.param("projectId")), ...body },
    })) satisfies SkillResponse, 201);
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

  app.get("/projects/:projectId/mcp-connections", async (context) => context.json((await db.mCPConnection.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: { agents: true },
    orderBy: { createdAt: "asc" },
  })) satisfies MCPConnectionResponse[]));
  app.post("/projects/:projectId/mcp-connections", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, mcpConnectionInput);
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "MCP credential secret is unavailable" }, 400);
    }
    return context.json((await db.mCPConnection.create({
      data: { ...body, config: jsonValue(body.config), projectId },
    })) satisfies MCPConnectionResponse, 201);
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

  app.get("/projects/:projectId/repos", async (context) => validated(context, (await db.repo.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })) satisfies RepoResponse[]));
  app.post("/projects/:projectId/repos", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, repoInput);
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "Repo credential secret is unavailable" }, 400);
    }
    return context.json((await db.repo.create({ data: { ...body, projectId } })) satisfies RepoResponse, 201);
  });
  app.patch("/repos/:repoId", async (context) => {
    const body = await readJson(context.req.raw, repoPatch);
    if (body.credentialSecretId) {
      const secret = await db.secret.findFirst({ where: { id: body.credentialSecretId, disabledAt: null } });
      if (!secret) return context.json({ error: "Repo credential secret is unavailable" }, 400);
    }
    return context.json((await db.repo.update({
      where: { id: id.parse(context.req.param("repoId")) }, data: withoutUndefined(body),
    })) satisfies RepoResponse);
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
    return context.json((await db.agentRepoAccess.upsert({
      where: { agentId_repoId: { agentId, repoId } },
      create: { agentId, repoId, projectId: agent.projectId, ...body },
      update: body,
    })) satisfies AgentRepoAccessContract, 201);
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
    return context.json(await instantiateTemplate(
      db,
      id.parse(context.req.param("projectId")),
      id.parse(context.req.param("templateId")),
      await readJson(context.req.raw, instantiateTemplateInput),
    ), 201);
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
    const result = await instantiateTemplate(db, trigger.projectId, trigger.id, {
      repoId: trigger.webhookRepoId!, variables, autoStart: true,
    }, {
      actorType: "operator",
      activityMetadata: { manualFireTemplateId: trigger.id, firedAt: new Date().toISOString() },
      source: TaskSource.MANUAL,
      fire: { source: TriggerFireSource.MANUAL },
    });
    return context.json({ chainId: result.chainId, taskIds: result.tasks.map((task) => task.id), fireId: result.fireId }, 201);
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
        const chainExistedBeforeLock = body.chainId === undefined ? false : await tx.task.count({
          where: { projectId, chainId: body.chainId },
        }) > 0;
        if (body.chainId !== undefined) {
          await lockChainStructure(tx, { projectId, chainId: body.chainId });
          const chainExistsUnderLock = await tx.task.count({
            where: { projectId, chainId: body.chainId },
          }) > 0;
          if (chainExistedBeforeLock && !chainExistsUnderLock) {
            return refusal(
              "conflict",
              `Cannot add Task to Chain ${body.chainId}; the Chain no longer exists`,
              { code: "chain_create_missing", chainId: body.chainId },
            );
          }
        }
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
    const admission = await readStepAdmission(db, task.id, { locked: false });
    if (!admission.task || !admission.verdict) {
      throw new Error(`Task ${task.id} disappeared while projecting operator move targets`);
    }
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
    const usageCosts = task.runs.map(runSessionUsageCost);
    return context.json({
      ...task,
      executionOwner: chainExecutionOwner(task),
      moveTargets: operatorMoveTargets(task, admission.verdict),
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
    const detail = await readChainDetail(db, taskId);
    if (detail.kind === "not-found") return context.json({ error: "Task not found" }, 404);
    if (detail.kind === "chainless") return context.json({ chainId: null, total: 0, done: 0, steps: [] });
    const { admissions, chainId, control, dispatchAfter, firstTaskId, rows: chainRows } = detail;
    const mergeRecovery = mergeRecoveryProjection(detail.recoveryRow);
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
        blockedOn: row.id === firstTaskId
          && row.dispatchAfterTaskId !== null
          && dispatchAfter !== null
          && dispatchAfter.status !== TaskStatus.DONE
          ? { taskId: dispatchAfter.id, name: dispatchAfter.name, status: dispatchAfter.status }
          : null,
        mergeRecovery,
      } satisfies ChainStepContract<Date>)),
    });
  });
  app.post("/tasks/:taskId/chain/hold", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, chainHoldInput);
    const address = await resolveDirectChainAddress(db, taskId);
    if ("message" in address) return refusalJson(context, address);
    const result = await readCommitted(db, (tx) => holdChain(tx, { ...address, ...body }));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });
  app.post("/tasks/:taskId/chain/resume", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, chainResumeInput);
    const address = await resolveDirectChainAddress(db, taskId);
    if ("message" in address) return refusalJson(context, address);
    const result = await readCommitted(db, (tx) => resumeChain(tx, { ...address, ...body }, new Date()));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });
  app.patch("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await patchTask(db, taskId, await readJson(context.req.raw, taskPatch));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });
  app.delete("/tasks/:taskId/chain", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const resolved = await resolveTaskChain(db, taskId);
    if (!resolved) return refusalJson(context, refusal("not-found", "Task not found"));
    if (!resolved.chain) return refusalJson(context, refusal("conflict", "Task does not belong to a Chain"));
    const address = { ...resolved.chain, taskId };
    try {
      const result = await readCommitted(db, (tx) => deleteChain(tx, address));
      if ("message" in result) return refusalJson(context, result);
      return context.body(null, 204);
    } catch (error: unknown) {
      // Defensive mapping for another restrictive history relation introduced
      // after the explicit Run check: callers still receive a guided refusal,
      // never the generic Prisma P2003 response.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        return refusalJson(context, chainRunHistoryRefusal(address.chainId));
      }
      throw error;
    }
  });
  app.delete("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const result = await readCommitted(db, async (tx) => {
      const resolved = await resolveTaskChain(tx, taskId);
      if (!resolved) return refusal("not-found", "Task not found");
      if (resolved.chain) {
        // Direct members are in this lock already; detached repairs take the
        // same Chain-first order as whole-Chain deletion before refusing.
        await lockChainRows(tx, resolved.chain);
        const current = await resolveTaskChain(tx, taskId);
        if (!current) return refusal("not-found", "Task not found");
        if (current.chain) {
          return refusal(
            "invalid-request",
            `Task belongs to Chain ${current.chain.chainId}; delete the whole Chain instead`,
            { code: "chain_task_delete_required", chainId: current.chain.chainId },
          );
        }
      }
      const locked = await lockTaskMutationRows(tx, taskId);
      if (!locked) return refusal("not-found", "Task not found");
      await tx.task.delete({ where: { id: taskId } });
      return { deleted: 1 };
    });
    if ("message" in result) return refusalJson(context, result);
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
    const state = await recordRunnerBackendReport(db, { kind: "availability", ...body }, now);
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
    const state = await recordRunnerBackendReport(db, { kind: "preflight", ...body });
    preflightRecoveryLeases.delete(body.runner);
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
    try {
      await reconcileDatabaseRuns(db, now, releaseChainLease);
    } catch (error: unknown) {
      if (!(error instanceof ReconciliationMaintenanceError)) throw error;
      console.error("Runner claim reconciliation maintenance failed after commit", {
        reconciledAt: error.reconciledAt.toISOString(),
        failures: error.failures.map((failure) => ({
          target: failure.target,
          phase: failure.phase,
          error: failure.error instanceof Error ? failure.error.message : String(failure.error),
        })),
      });
    }
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
    const result = await acknowledgeCancellation(db, runId, body, releaseChainLease);
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
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
      if (body.events.some((event) => event.type === "NATIVE_CHILD_STARTED")) {
        await tx.session.update({ where: { id: run.session.id }, data: { nativeChildUsed: true } });
      }
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
        agent: { select: { name: true } },
        task: {
          include: {
            stepOutput: true,
            templateStep: {
              select: {
                name: true,
                stepIndex: true,
                outputKind: true,
                priorOutputKinds: true,
                taskTemplate: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!run) return context.json({ error: "Run not found" }, 404);
    const boundImplementationTask = run.agent.name === SPEC_REVALIDATOR_AGENT_NAME && run.task
      ? await readBoundImplementationTask(db, run)
      : null;
    if (boundImplementationTask && "message" in boundImplementationTask) {
      return refusalJson(context, boundImplementationTask);
    }
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
        ...(boundImplementationTask ? { boundImplementationTask } : {}),
      } : null,
    });
  });

  /**
   * The revalidator's only task mutation. The target is derived from the
   * fenced Run, so a session can never name an arbitrary task or chain.
   */
  app.patch("/session/runs/:runId/task", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, revalidationPatchInput);
    const fence: RunFence = { runId, fencingToken: body.fencingToken, at: new Date() };
    const result = await patchBoundImplementationDescription(db, fence, body.description, principal.leaseGeneration);
    if (isFenceRefusalResponse(result)) return refusalJson(context, runFenceRefusal(result));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result.task);
  });

  /** Ask the owning runner to cancel a premise-collapsed revalidation Run. */
  app.post("/session/runs/:runId/revalidation/cancel", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const principal = context.get("principal");
    if (principal.kind !== "session" || principal.runId !== runId) return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, revalidationCancelInput);
    const fence: RunFence = { runId, fencingToken: body.fencingToken, at: new Date() };
    const result = await cancelBoundRevalidationRun(db, fence, new Date(), principal.leaseGeneration);
    if (isFenceRefusalResponse(result)) return refusalJson(context, runFenceRefusal(result));
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
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
    const result = await cancelRun(db, runId, body, releaseChainLease);
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
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
