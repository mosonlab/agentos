import { createHash } from "node:crypto";

import {
  ACTIVE_RUN_STATUSES,
  AssigneeType,
  activateChainSuccessor,
  advanceTemplateTask,
  applyInboxDecision,
  CleanupStatus,
  deriveRunConfig,
  FailureClass,
  GoalStatus,
  enqueueTaskRun,
  InboxStatus,
  isArchivedAssigneeError,
  isArchivedTaskError,
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
  resolveRunBranches,
  SecretPurpose,
  SkillKind,
  SessionEventSource,
  SessionExecutionStatus,
  TaskSource,
  TaskStatus,
  TriggerFireSource,
  gateQuestion,
  prisma,
} from "@agentos/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { getMimeType } from "hono/utils/mime";
import { z } from "zod";

import { authenticate, issueSessionToken, principalMayAccess, type Principal } from "./auth.js";
import {
  chainKey,
  chainProgress,
  chainProgressByChain,
  positions,
  runFactsByTask,
  startable,
  stepName,
} from "./chain.js";
import {
  completionSucceeded,
  externalFailure,
  failureIsRetryable,
  hashPrompt,
  jsonValue,
  makeDedupeKey,
  makeFencingToken,
  retryDelayMs,
  runnerFor,
} from "./execution.js";
import { createArchivedRunNoticeScheduler, defaultWorkspaceRoot, noteArchivedQueuedRuns, reconcileDatabaseRuns, reconcileWorkspaces } from "./reconcile.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { suspendForInbox } from "./inbox.js";
import { instantiateTemplate } from "./templates.js";
import { computeNextOccurrence, validateSchedule } from "./scheduler.js";
import { authenticateWebhook, resolvePayloadVariables, usableDefault } from "./hooks.js";
import { filesRootGrantKey, getFileStore } from "./files/config.js";
import { grantAdmits, type FileOperation, type GrantLike } from "./files/grants.js";
import { isCanonicalRelPath, normalizeRelPath } from "./files/paths.js";
import { DirectoryNotEmptyError, InvalidPathError, IsADirectoryError, NotADirectoryError, NotFoundError, SymlinkError, type FileStore } from "./files/store.js";

type AppEnvironment = { Variables: { principal: Principal } };

const id = z.string().min(1);
const fence = z.string().min(1);
const projectFields = {
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  yamlDocument: z.string(),
};
const projectInput = z.object({ ...projectFields, yamlDocument: projectFields.yamlDocument.default("") });
const projectPatch = z.object(projectFields).partial().refine((value) => Object.keys(value).length > 0);
const agentFields = {
  environmentId: id,
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  foundationalPrompt: z.string().min(1),
  rolePrompt: z.string().min(1),
  runnerPreference: z.nativeEnum(RunnerPreference),
  inboxAccess: z.boolean(),
};
const agentInput = z.object({
  ...agentFields,
  runnerPreference: agentFields.runnerPreference.default(RunnerPreference.INHERIT),
  inboxAccess: agentFields.inboxAccess.default(false),
});
const agentPatch = z.object(agentFields).partial().refine((value) => Object.keys(value).length > 0);
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
  maxDurationMin: goalFields.maxDurationMin.default(120),
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
  maxDurationMin: z.number().int().min(1).max(24 * 60),
  stallTimeoutMin: z.number().int().min(1).max(24 * 60),
  maxSessionsPerTask: z.number().int().min(1).max(100),
  scheduleKind: z.nativeEnum(ScheduleKind),
  runAt: z.coerce.date().nullable(),
  cron: z.string().trim().min(9).max(100).nullable(),
  timezone: z.string().trim().min(1).max(64).nullable(),
};
const taskInput = z.object({
  ...taskFields,
  description: taskFields.description.default(""),
  workingDirectory: taskFields.workingDirectory.default(null),
  repoId: taskFields.repoId.default(null),
  targetBranch: taskFields.targetBranch.default(null),
  assigneeType: taskFields.assigneeType.default(AssigneeType.AGENT),
  assigneeAgentId: taskFields.assigneeAgentId.default(null),
  approvalGate: taskFields.approvalGate.default(false),
  maxDurationMin: taskFields.maxDurationMin.default(120),
  stallTimeoutMin: taskFields.stallTimeoutMin.default(10),
  maxSessionsPerTask: taskFields.maxSessionsPerTask.default(5),
  scheduleKind: taskFields.scheduleKind.default(ScheduleKind.NOW),
  runAt: taskFields.runAt.default(null),
  cron: taskFields.cron.default(null),
  timezone: taskFields.timezone.default(null),
  chainId: z.string().trim().min(1).max(100).optional(),
  chainIndex: z.number().int().min(0).optional(),
}).superRefine((value, context) => {
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
const claimInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
});
const heartbeatInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
  processAlive: z.boolean(),
  lastProgressEventAt: z.coerce.date().nullable().optional(),
  inFlightTool: z.record(z.string(), z.unknown()).nullable().optional(),
});
const startInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  fencingToken: fence,
  adapterVersion: z.string().min(1),
  cliVersion: z.string().min(1),
  authMode: z.string().nullable().optional(),
  manifest: z.record(z.string(), z.unknown()),
  workspacePath: z.string().min(1),
  branch: z.string().nullable().optional(),
  baseSha: z.string().nullable().optional(),
  runtimeHandle: z.string().nullable().optional(),
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
const inboxQuestionInput = z.object({
  fencingToken: fence,
  requestId: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  choices: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(200) })).max(20).default([]),
  chatId: z.string().min(1).optional(),
  resumableUntil: z.coerce.date().nullable().optional(),
});
const instantiateTemplateInput = z.object({
  repoId: id,
  variables: z.record(z.string(), z.string().min(1)),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(50_000).optional(),
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
});
const inboxDecisionInput = z.object({
  decision: z.string().trim().min(1).max(8000),
  requestId: z.string().trim().min(1).max(200),
});
const inboxReplyInput = z.object({
  body: z.string().trim().min(1).max(8000),
  requestId: z.string().trim().min(1).max(200),
});

const readJson = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await request.json());

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
  path === "/" || path === "/health" || method === "OPTIONS"
  || method === "POST" && /^\/hooks\/templates\/[^/]+$/.test(path);

const activeRunStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX];

type LockedTask = { id: string; status: TaskStatus; archivedAt: Date | null };

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
    select: { id: true, status: true, archivedAt: true },
  });
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

export const createApp = (db: PrismaClient = prisma): Hono<AppEnvironment> => {
  const app = new Hono<AppEnvironment>();
  const noteArchivedQueuedRunsOnClaim = createArchivedRunNoticeScheduler(db);

  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "X-Fencing-Token", "X-AgentOS-Webhook-Secret", "X-AgentOS-Delivery-Id"] }));
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
        repoId: template.webhookRepoId!, variables: resolved.variables,
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

  app.get("/projects/:projectId/agents", async (context) => context.json(await db.agent.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    orderBy: { createdAt: "asc" },
  })));
  app.post("/projects/:projectId/agents", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, agentInput);
    const environment = await db.environment.findFirst({ where: { id: body.environmentId, projectId } });
    if (!environment) return context.json({ error: "Environment does not belong to this project" }, 400);
    return context.json(await db.agent.create({ data: { ...body, projectId } }), 201);
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
    const before = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const body = await readJson(context.req.raw, agentPatch);
    if (body.environmentId) {
      const environment = await db.environment.findFirst({ where: { id: body.environmentId, projectId: before.projectId } });
      if (!environment) return context.json({ error: "Environment does not belong to this project" }, 400);
    }
    return context.json(await db.agent.update({ where: { id: agentId }, data: withoutUndefined(body) as Prisma.AgentUncheckedUpdateInput }));
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
  app.post("/agents/:agentId/archive", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent) return context.json({ error: "Agent not found" }, 404);
    const archived = agent.archivedAt ? agent : await db.agent.update({
      where: { id: agentId },
      data: { archivedAt: new Date() },
    });
    await noteArchivedQueuedRuns(db, { agentId });
    return context.json(archived);
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

  app.get("/agents/:agentId/collaborators", async (context) => context.json(await db.agentCollaboration.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) }, include: { allowedAgent: true },
  })));
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
  app.get("/agents/:agentId/skills", async (context) => context.json(await db.agentSkill.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) }, include: { skill: true },
  })));
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
  app.post("/agents/:agentId/skills/:skillId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const skillId = id.parse(context.req.param("skillId"));
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
  app.get("/agents/:agentId/mcp-connections", async (context) => context.json(await db.agentMCPConnection.findMany({
    where: { agentId: id.parse(context.req.param("agentId")) }, include: { mcpConnection: true },
  })));
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
  app.post("/agents/:agentId/mcp-connections/:connectionId", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const connectionId = id.parse(context.req.param("connectionId"));
    const [agent, connection] = await Promise.all([
      db.agent.findUnique({ where: { id: agentId }, select: { projectId: true } }),
      db.mCPConnection.findUnique({ where: { id: connectionId }, select: { projectId: true } }),
    ]);
    if (!agent || !connection) return context.json({ error: "Agent or MCP connection not found" }, 404);
    if (agent.projectId !== connection.projectId) return context.json({ error: "Agent and MCP connection belong to different projects" }, 400);
    return context.json(await db.agentMCPConnection.upsert({
      where: { agentId_mcpConnectionId: { agentId, mcpConnectionId: connectionId } },
      create: { agentId, mcpConnectionId: connectionId, projectId: agent.projectId }, update: {},
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
    const deleted = await db.agentRepoAccess.deleteMany({ where: {
      agentId: id.parse(context.req.param("agentId")), repoId: id.parse(context.req.param("repoId")),
    } });
    return deleted.count === 1 ? context.body(null, 204) : context.json({ error: "Repo access not found" }, 404);
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
      if (error instanceof Error && /(not found|has no|is archived|Missing template|Unknown template|must be agent)/i.test(error.message)) {
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
      select: { id: true, projectId: true, chainId: true, chainIndex: true, name: true, status: true, archivedAt: true, templateStep: { select: { name: true } } },
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
      const value = supplied !== undefined ? supplied
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
        repoId: trigger.webhookRepoId!, variables,
      }, {
        actorType: "operator",
        activityMetadata: { manualFireTemplateId: trigger.id, firedAt: new Date().toISOString() },
        source: TaskSource.MANUAL,
        fire: { source: TriggerFireSource.MANUAL },
      });
      return context.json({ chainId: result.chainId, taskIds: result.tasks.map((task) => task.id), fireId: result.fireId }, 201);
    } catch (error: unknown) {
      if (error instanceof Error && /(not found|has no|is archived|Missing template|Unknown template|must be agent)/i.test(error.message)) {
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
    // Archived tasks are finished work; a board and a per-project count that
    // keep growing after Archive All are the bug, not the fix. `all` is the
    // escape hatch for anyone who needs the old, archived-inclusive numbers.
    const archivedFilter = archived === "false" ? { archivedAt: null }
      : archived === "true" ? { archivedAt: { not: null } }
      : {};
    const tasks = await db.task.findMany({
      where: { ...(projectId ? { projectId } : {}), ...archivedFilter },
      include: {
        assigneeAgent: true,
        repo: true,
        templateStep: { select: { name: true } },
        runs: { orderBy: { runNumber: "desc" }, take: 1, include: { session: true } },
      },
      orderBy: { createdAt: "asc" },
    });

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
    const enrich = (context.req.query("enrich") ?? "true") !== "false";

    // Progress must count *all* the chain's rows, including archived ones, so it
    // cannot be computed from the rows above. One extra scoped query, grouped in
    // memory — two queries per request regardless of how many tasks come back.
    //
    // `chainIndex: { not: null }` matches `GET /tasks/:id/chain`, which treats a
    // null-index row as its own one-row chain. Without it a single broken row
    // inflates `total` and shifts `position` for every real sibling on the board
    // while its own detail page still reads `1/1` — the same rows, two answers.
    const chainIds = !enrich ? [] : [...new Set(tasks
      .filter((task) => task.chainIndex !== null)
      .map((task) => task.chainId)
      .filter((value): value is string => value !== null))];
    const chainRows = chainIds.length === 0 ? [] : await db.task.findMany({
      where: { chainId: { in: chainIds }, chainIndex: { not: null }, ...(projectId ? { projectId } : {}) },
      select: {
        id: true, projectId: true, chainId: true, chainIndex: true, status: true,
        name: true, archivedAt: true, templateStep: { select: { name: true } },
      },
      orderBy: { chainIndex: "asc" },
    });
    const progressByChain = chainProgressByChain(chainRows);
    const positionsByChain = new Map<string, Map<string, number>>();
    for (const row of chainRows) {
      if (!row.chainId) continue;
      const key = chainKey({ projectId: row.projectId, chainId: row.chainId });
      const group = positionsByChain.get(key);
      if (group) continue;
      positionsByChain.set(key, positions(chainRows.filter((candidate) => (
        candidate.chainId !== null && chainKey({ projectId: candidate.projectId, chainId: candidate.chainId }) === key
      ))));
    }

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

    return context.json(tasks.map((task) => {
      const fired = firedByDefinition.get(task.id);
      const recurring = {
        recurringLastFiredAt: fired?._max.createdAt ?? null,
        recurringFireCount: fired?._count._all ?? 0,
      };
      if (!enrich || !task.chainId) return { ...task, chainProgress: null, ...recurring };
      // The same one-row-chain rule the detail route applies (E1), so a broken
      // row reports `n/1` in both places instead of `null` here and `1/1` there.
      if (task.chainIndex === null) {
        return {
          ...task,
          chainProgress: {
            chainId: task.chainId,
            done: task.status === TaskStatus.DONE ? 1 : 0,
            total: 1,
            activeStepName: task.templateStep?.name ?? task.name,
            activeStatus: task.status.toLowerCase(),
            position: 1,
          },
          ...recurring,
        };
      }
      const key = chainKey({ projectId: task.projectId, chainId: task.chainId });
      const progress = progressByChain.get(key) ?? null;
      return {
        ...task,
        chainProgress: progress
          ? { ...progress, position: positionsByChain.get(key)?.get(task.id) ?? null }
          : null,
        ...recurring,
      };
    }));
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
      const created = await tx.task.create({
        data: { ...withoutUndefined(body), ...schedule, projectId } as Prisma.TaskUncheckedCreateInput,
      });
      await tx.taskActivity.create({ data: { taskId: created.id, actorType: "operator", body: "Task created" } });
      if (agent && repo && body.assigneeType === AssigneeType.AGENT && schedule.scheduleKind === ScheduleKind.NOW) {
        const runner = runnerFor(agent.runnerPreference, agent.model);
        // This run is built inline rather than through enqueueTaskRun, so it is
        // one of the paths a chain fix can miss. Missing it puts step ① on a
        // per-task branch while ②–⑨ share the chain branch — i.e. step ①'s work
        // silently absent from the tree every later step reviews.
        const branches = await resolveRunBranches(tx, { ...created, repo }, null);
        await tx.run.create({
          data: {
            projectId,
            taskId: created.id,
            agentId: agent.id,
            repoId: repo.id,
            runNumber: 1,
            dedupeKey: makeDedupeKey(created.id, 1),
            runner,
            model: agent.model,
            targetBranch: branches.targetBranch,
            branch: branches.branch,
            opensPullRequest: created.opensPullRequest,
            promptHash: hashPrompt([agent.foundationalPrompt, agent.rolePrompt, created.name, created.description]),
            maxDurationMin: body.maxDurationMin,
            stallTimeoutMin: body.stallTimeoutMin,
            maxRunsPerTask: body.maxSessionsPerTask,
          },
        });
      }
      return created;
    });
    return context.json(task, 201);
  });
  app.get("/tasks/:taskId", async (context) => {
    const task = await db.task.findUnique({
      where: { id: id.parse(context.req.param("taskId")) },
      include: { assigneeAgent: true, repo: true, runs: { orderBy: { runNumber: "desc" }, include: { session: true } } },
    });
    return task ? context.json(task) : context.json({ error: "Task not found" }, 404);
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
      assigneeAgent: { select: { id: true, title: true, archivedAt: true } },
      templateStep: { select: { name: true } },
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

    const runGroups = rows.length === 0 ? [] : await db.run.groupBy({
      by: ["taskId", "status"],
      where: { taskId: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    });
    const facts = runFactsByTask(runGroups, ACTIVE_RUN_STATUSES);
    const ordinals = positions(rows);
    const progress = chainProgress(rows);

    return context.json({
      chainId: subject.chainId,
      total: progress?.total ?? rows.length,
      done: progress?.done ?? 0,
      steps: rows.map((row) => ({
        taskId: row.id,
        position: ordinals.get(row.id) ?? 1,
        chainIndex: row.chainIndex,
        name: row.name,
        stepName: stepName(row),
        status: row.status,
        approvalGate: row.approvalGate,
        assigneeType: row.assigneeType,
        agent: row.assigneeAgent ? { id: row.assigneeAgent.id, title: row.assigneeAgent.title } : null,
        archivedAt: row.archivedAt,
        failureReason: row.failureReason,
        latestRun: row.runs[0]
          ? { id: row.runs[0].id, status: row.runs[0].status, runNumber: row.runs[0].runNumber }
          : null,
        startable: startable(row, facts.get(row.id) ?? { total: 0, active: false }, row.maxSessionsPerTask),
      })),
    });
  });
  app.patch("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, taskPatch);
    const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    if (body.status === TaskStatus.DONE && before.templateId && before.approvalGate) {
      return context.json({ error: "Template approval gates must be decided through Inbox" }, 409);
    }
    const changesStatus = body.status !== undefined && body.status !== before.status;
    const movingToBacklog = body.status === TaskStatus.BACKLOG && before.status !== TaskStatus.BACKLOG;
    if (body.assigneeAgentId) {
      const agent = await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId: before.projectId } });
      if (!agent) return context.json({ error: "Assignee does not belong to this project" }, 400);
      if (agent.archivedAt) return context.json({ error: `Assignee ${agent.name} is archived` }, 400);
    }
    if (body.repoId) {
      const repo = await db.repo.findFirst({ where: { id: body.repoId, projectId: before.projectId } });
      if (!repo) return context.json({ error: "Repo does not belong to this project" }, 400);
    }
    const effectiveAgentId = body.assigneeAgentId === undefined ? before.assigneeAgentId : body.assigneeAgentId;
    const effectiveRepoId = body.repoId === undefined ? before.repoId : body.repoId;
    if (effectiveAgentId && effectiveRepoId) {
      const access = await db.agentRepoAccess.findFirst({
        where: { agentId: effectiveAgentId, repoId: effectiveRepoId, projectId: before.projectId },
      });
      if (!access) return context.json({ error: "Assignee has no grant for this Repo" }, 400);
    }
    const effectiveAssigneeType = body.assigneeType ?? before.assigneeType;
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
    const advances = before.status !== TaskStatus.DONE
      && body.status === TaskStatus.DONE
      && Boolean(before.chainId || before.followUpTaskId);
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
    if (changesStatus) {
      const written = await db.$transaction(async (tx) => {
        const locked = await lockTask(tx, taskId);
        if (!locked) return { error: "Task not found", code: 404 as const };
        if (locked.archivedAt !== null) {
          return { error: "Cannot change the status of an archived task; unarchive it first", code: 409 as const };
        }
        if (movingToBacklog && await hasActiveRun(tx, taskId)) {
          return { error: "Cannot move a task with an active run to Backlog", code: 409 as const };
        }
        const updated = await tx.task.update({ where: { id: taskId }, data: updateData });
        await tx.taskActivity.create({ data: {
          taskId, actorType: "operator", body: `Status changed: ${before.status} → ${body.status}`,
        } });
        if (advances) {
          if (!before.templateId && before.approvalGate) {
            await tx.inboxMessage.updateMany({
              where: { gateTaskId: before.id, status: "OPEN" },
              data: { status: "CLOSED" },
            });
          }
          await activateChainSuccessor(tx, updated, { sourceRunId: null }, new Date());
        }
        return { task: updated };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if ("error" in written) return context.json({ error: written.error }, written.code);
      return context.json(written.task);
    }
    return context.json(await db.task.update({ where: { id: taskId }, data: updateData }));
  });
  app.delete("/tasks/:taskId", async (context) => {
    await db.task.delete({ where: { id: id.parse(context.req.param("taskId")) } });
    return context.body(null, 204);
  });
  app.post("/tasks/:taskId/retry", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      const locked = await lockTask(tx, taskId);
      if (!locked) return { error: "Task not found", code: 404 as const };
      // Retry joins the exclusion protocol: a guard set in which one writer
      // ignores archivedAt excludes nothing.
      if (locked.archivedAt !== null) return { error: "Cannot retry an archived task", code: 409 as const };
      const task = await tx.task.findUnique({
        where: { id: taskId },
        include: {
          assigneeAgent: true,
          templateStep: true,
          runs: { orderBy: { runNumber: "desc" }, take: 1 },
        },
      });
      if (!task) return { error: "Task not found", code: 404 as const };
      const last = task.runs[0];
      if (!last) return { error: "Task has no run to retry", code: 409 as const };
      if (last.status === RunStatus.QUEUED || last.status === RunStatus.CLAIMED || last.status === RunStatus.RUNNING) {
        return { error: "Task already has an active run", code: 409 as const };
      }
      if (last.runNumber >= last.maxRunsPerTask) return { error: "Run budget exhausted", code: 409 as const };
      if (!task.assigneeAgent) {
        return { error: "Task assignee no longer exists; assign an agent before retrying", code: 409 as const };
      }
      if (task.assigneeAgent.archivedAt) {
        return { error: `Assignee ${task.assigneeAgent.name} is archived; unarchive it to retry`, code: 409 as const };
      }
      const derived = deriveRunConfig(task.assigneeAgent, task.templateStep, task);
      const run = await tx.run.create({
        data: {
          projectId: last.projectId,
          taskId,
          goalId: last.goalId,
          agentId: task.assigneeAgent.id,
          repoId: task.repoId,
          runNumber: last.runNumber + 1,
          dedupeKey: makeDedupeKey(taskId, last.runNumber + 1),
          runner: derived.runner,
          model: derived.model,
          targetBranch: last.targetBranch,
          branch: last.branch,
          promptHash: derived.promptHash,
          maxDurationMin: last.maxDurationMin,
          stallTimeoutMin: last.stallTimeoutMin,
          maxRunsPerTask: last.maxRunsPerTask,
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
    try {
      const result = await db.$transaction(async (tx) => {
        const locked = await lockTask(tx, taskId);
        if (!locked) return { error: "Task not found", code: 404 as const };
        if (locked.archivedAt !== null) return { error: "Cannot start an archived task", code: 409 as const };
        if (locked.status === TaskStatus.DONE) return { error: "Task is already done", code: 409 as const };
        const task = await tx.task.findUniqueOrThrow({
          where: { id: taskId },
          include: { assigneeAgent: { select: { archivedAt: true } } },
        });
        if (task.assigneeType !== AssigneeType.AGENT) {
          return { error: "Human steps cannot be started", code: 409 as const };
        }
        if (await hasActiveRun(tx, taskId)) {
          return { error: "Task already has an active run", code: 409 as const };
        }
        // A count, not the latest run number: Run is one-to-many and a task at
        // its ceiling whose last run failed must not look startable.
        const total = await tx.run.count({ where: { taskId } });
        if (total >= task.maxSessionsPerTask) {
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
        if (!startable({ ...task, archivedAt: locked.archivedAt }, { total, active: false }, task.maxSessionsPerTask)) {
          // The one remaining `startable` condition with no message of its own
          // is the archived assignee, and `enqueueTaskRun` already throws an
          // error that names the agent — a better sentence than anything this
          // branch could write. Fall through to it; the catch maps it to 409.
          if (!task.assigneeAgent?.archivedAt) {
            return { error: "This step cannot be started", code: 409 as const };
          }
        }
        const run = await enqueueTaskRun(tx, taskId);
        if (locked.status === TaskStatus.BACKLOG) {
          await tx.task.update({ where: { id: taskId }, data: { status: TaskStatus.TODO } });
        }
        await tx.taskActivity.create({ data: {
          taskId, actorType: "operator", body: "Started manually from the chain view",
        } });
        return { run };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
      if ("error" in result) return context.json({ error: result.error }, result.code);
      return context.json({ runId: result.run.id, runNumber: result.run.runNumber }, 201);
    } catch (error: unknown) {
      if (isArchivedAssigneeError(error) || isArchivedTaskError(error)) return context.json({ error: error.message }, 409);
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
      const locked = await lockTask(tx, taskId);
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
    // No lock: unarchiving cannot race a run into existence.
    const before = await db.task.findUnique({ where: { id: taskId }, select: { archivedAt: true } });
    if (!before) return context.json({ error: "Task not found" }, 404);
    if (before.archivedAt === null) return context.json(await db.task.findUniqueOrThrow({ where: { id: taskId } }));
    const task = await db.task.update({ where: { id: taskId }, data: { archivedAt: null } });
    await db.taskActivity.create({ data: { taskId, actorType: "operator", body: "Task unarchived" } });
    return context.json(task);
  });
  app.post("/projects/:projectId/tasks/archive-done", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const result = await db.$transaction(async (tx) => {
      const candidates = await tx.task.findMany({
        where: { projectId, status: TaskStatus.DONE, archivedAt: null },
        select: { id: true },
      });
      // Lock before reading runs, so a retry cannot slip a run in between the
      // selection and the write. Ids that vanished, moved out of `Done` or were
      // archived in between simply do not come back from the lock and count as
      // neither archived nor skipped.
      const lockedIds = await lockDoneTasks(tx, projectId, candidates.map((task) => task.id));
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
    const task = await db.task.findUnique({ where: { id: taskId }, select: { scheduleKind: true } });
    if (!task) return context.json({ error: "Task not found" }, 404);
    if (task.scheduleKind !== ScheduleKind.CRON) return context.json({ error: "Only CRON tasks can be paused" }, 400);
    // In-flight copies are left alone: pausing stops future occurrences, it does
    // not reach into work that already started.
    const paused = await db.task.update({ where: { id: taskId }, data: { schedulePausedAt: new Date() } });
    await db.taskActivity.create({ data: { taskId, actorType: "operator", body: "Schedule paused" } });
    return context.json(paused);
  });
  app.post("/tasks/:taskId/schedule/resume", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: { scheduleKind: true, cron: true, timezone: true },
    });
    if (!task) return context.json({ error: "Task not found" }, 404);
    if (task.scheduleKind !== ScheduleKind.CRON) return context.json({ error: "Only CRON tasks can be resumed" }, 400);
    let runAt: Date;
    try {
      if (!task.cron) throw new Error("CRON tasks require cron");
      // Recomputed from *now*, so a long pause produces no catch-up burst.
      runAt = computeNextOccurrence(task.cron, task.timezone, new Date());
    } catch (error: unknown) {
      return context.json({ error: error instanceof Error ? error.message : "Invalid schedule" }, 400);
    }
    const resumed = await db.task.update({ where: { id: taskId }, data: { schedulePausedAt: null, runAt } });
    await db.taskActivity.create({ data: { taskId, actorType: "operator", body: "Schedule resumed" } });
    return context.json(resumed);
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
    return context.json(await db.taskStepOutput.upsert({
      where: { taskId },
      create: { taskId, kind: body.kind, body: body.body, ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
      update: { kind: body.kind, body: body.body, ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
    }));
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
      const result = await applyInboxDecision(db, {
        inboxMessageId: id.parse(context.req.param("messageId")),
        externalEventId: `web:${body.requestId}`,
        decision: body.decision,
        actorOpenId: "web-operator",
      });
      return context.json(result, result.duplicate ? 200 : 201);
    } catch (error: unknown) {
      if (isArchivedAssigneeError(error) || isArchivedTaskError(error)) return context.json({ error: error.message }, 409);
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
      if (isArchivedAssigneeError(error) || isArchivedTaskError(error)) return context.json({ error: error.message }, 409);
      if (error instanceof Error && /(No matching|must be approve|no executable)/i.test(error.message)) {
        return context.json({ error: error.message }, 409);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return context.json({ duplicate: true, resumed: false });
      }
      throw error;
    }
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
        capabilities: jsonValue(body.capabilities),
        lastPreflightAt: now,
        lastPreflightOk: body.ok,
        circuitOpen: !body.ok,
        circuitReason: body.ok ? null : body.error ?? "Preflight failed",
        circuitOpenedAt: body.ok ? null : now,
      },
      update: {
        cliVersion: body.cliVersion ?? null,
        authMode: body.authMode ?? null,
        capabilities: jsonValue(body.capabilities),
        lastPreflightAt: now,
        lastPreflightOk: body.ok,
        ...(body.ok
          ? { circuitOpen: false, circuitReason: null, circuitOpenedAt: null, consecutiveAuthFailures: 0 }
          : { circuitOpen: true, circuitReason: body.error ?? "Preflight failed", circuitOpenedAt: now }),
      },
    });
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

  app.post("/runner/tasks/claim", async (context) => {
    const body = await readJson(context.req.raw, claimInput);
    const now = new Date();
    await reconcileDatabaseRuns(db, now);
    await noteArchivedQueuedRunsOnClaim(now).catch((error: unknown) => console.error("Archived-run notice failed", error));
    const claimed = await db.$transaction(async (tx) => {
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
          task: { include: { templateStep: { select: { name: true } } } },
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
      for (const candidate of candidates) {
        if (!candidate.task || !candidate.repo) continue;
        if (!candidate.agent.repoAccess.some((grant) => grant.repoId === candidate.repoId && grant.projectId === candidate.projectId)) continue;
        const backend = await tx.runnerBackendState.findUnique({ where: { runner: candidate.runner } });
        if (backend?.circuitOpen) continue;
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
        const priorResume = candidate.session?.resumeInput && candidate.session.providerConversationId ? {
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
        const grants = [
          ...candidate.agent.environment.secrets,
          ...candidate.agent.secretGrants,
        ].filter(({ secret }) => !secret.disabledAt);
        const secrets: Record<string, string> = {};
        for (const { envVar, secret } of grants) {
          if (["OPERATOR_TOKEN", "RUNNER_TOKEN", "AGENTOS_API_TOKEN", "AGENTOS_SESSION_TOKEN", "AGENTOS_FENCING_TOKEN"].includes(envVar)) {
            throw new Error(`Secret grant may not override reserved principal variable ${envVar}`);
          }
          if (Object.hasOwn(secrets, envVar)) throw new Error(`Duplicate effective secret envVar ${envVar}`);
          secrets[envVar] = decryptSecret(secret.encryptedValue, secret.ciphertextVersion);
        }
        const run = await tx.run.findUniqueOrThrow({ where: { id: candidate.id } });
        const priorOutputsRaw = candidate.task.chainId && candidate.task.chainIndex !== null
          ? await tx.taskStepOutput.findMany({
            where: { task: { chainId: candidate.task.chainId, chainIndex: { lt: candidate.task.chainIndex } } },
            select: { kind: true, body: true, task: { select: { name: true, chainIndex: true } } },
            orderBy: { task: { chainIndex: "asc" } },
          })
          : [];
        const priorOutputs = priorOutputsRaw.map((output) => ({
          ...output,
          body: output.body.length > 10_000 ? output.body.slice(-10_000) : output.body,
        }));
        return {
          task: candidate.task,
          agent: candidate.agent,
          repo: candidate.repo,
          run,
          session,
          runner: candidate.runner,
          fencingToken,
          sessionToken: sessionCredential.token,
          secrets,
          priorOutputs,
          resume: priorResume,
          nextEventSeq: (latestEvent._max.seq ?? -1) + 1,
        };
      }
      return null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return claimed ? context.json(claimed) : context.body(null, 204);
  });

  app.post("/runner/runs/:runId/start", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, startInput);
    const now = new Date();
    const updated = await db.run.updateMany({
      where: {
        id: runId,
        runnerId: body.runnerId,
        fencingToken: body.fencingToken,
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
    if (updated.count !== 1) return context.json({ error: "Stale fencing token" }, 409);
    await db.session.update({
      where: { runId },
      data: {
        executionStatus: SessionExecutionStatus.RUNNING,
        runtimeHandle: body.runtimeHandle ?? null,
        resumeInput: null,
        provisionedAt: now,
        startedAt: now,
      },
    });
    return context.json({ ok: true });
  });

  app.post("/runner/runs/:runId/heartbeat", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, heartbeatInput);
    const now = new Date();
    const updated = await db.run.updateMany({
      where: {
        id: runId,
        runnerId: body.runnerId,
        fencingToken: body.fencingToken,
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
    if (updated.count === 1) return context.json({ ok: true });
    const waiting = await db.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
    return waiting
      ? context.json({ error: "Run suspended for Inbox", code: "WAITING_INBOX" }, 409)
      : context.json({ error: "Stale fencing token" }, 409);
  });

  app.post("/runner/runs/:runId/events", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, eventsInput);
    const run = await db.run.findFirst({
      where: { id: runId, runnerId: body.runnerId, fencingToken: body.fencingToken, leaseExpiresAt: { gt: new Date() }, status: { in: activeRunStatuses } },
      include: { session: true },
    });
    if (!run?.session) {
      const waiting = await db.run.findFirst({ where: { id: runId, status: RunStatus.WAITING_INBOX }, select: { id: true } });
      return waiting
        ? context.json({ error: "Run suspended for Inbox", code: "WAITING_INBOX" }, 409)
        : context.json({ error: "Stale fencing token" }, 409);
    }
    await db.sessionEvent.createMany({
      data: body.events.map((event) => ({
        sessionId: run.session!.id,
        runId,
        seq: event.seq,
        at: event.at ?? new Date(),
        source: event.source,
        type: event.type,
        providerEventId: event.providerEventId ?? null,
        toolCallId: event.toolCallId ?? null,
        payload: jsonValue(event.payload),
      })),
      skipDuplicates: true,
    });
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
    if (body.events.some((event) => event.type === "FINAL_OUTPUT")) {
      try {
        await recomputeSessionUsage(db, run.session.id);
      } catch (error) {
        console.error(`Session usage recompute failed for ${run.session.id}`, error);
      }
    }
    if (body.providerConversationId && !run.session.providerConversationId) {
      await db.session.update({ where: { id: run.session.id }, data: { providerConversationId: body.providerConversationId } });
    }
    return context.json({ accepted: body.events.length });
  });

  const appendFencedActivity = async (context: Context<AppEnvironment, string>) => {
    const runId = id.parse(context.req.param("runId"));
    const body = await readJson(context.req.raw, fencedActivityInput);
    const principal = context.get("principal");
    const run = await db.run.findFirst({
      where: {
        id: runId,
        fencingToken: body.fencingToken,
        leaseExpiresAt: { gt: new Date() },
        status: { in: activeRunStatuses },
        ...(principal.kind === "runner" ? {} : { leaseGeneration: principal.kind === "session" ? principal.leaseGeneration : -1 }),
      },
      select: { taskId: true },
    });
    if (!run?.taskId) return context.json({ error: "Stale fencing token" }, 409);
    return context.json(await db.taskActivity.create({
      data: {
        taskId: run.taskId,
        actorType: principal.kind,
        actorId: body.actorId ?? null,
        body: body.body,
        ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}),
      },
    }), 201);
  };
  app.post("/runner/runs/:runId/activity", appendFencedActivity);
  app.post("/session/runs/:runId/activity", appendFencedActivity);

  // The agent's own view of its run: what it is working on, what budget is left,
  // and what the prior chain steps produced. Read-only, session-scoped.
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
      where: { id: runId, fencingToken: body.fencingToken, leaseExpiresAt: { gt: new Date() }, status: { in: activeRunStatuses } },
      select: { taskId: true },
    });
    if (!run?.taskId) return context.json({ error: "Stale fencing token" }, 409);
    return context.json(await db.taskStepOutput.upsert({
      where: { taskId: run.taskId },
      create: { taskId: run.taskId, runId, kind: body.kind, body: body.body, ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
      update: { runId, kind: body.kind, body: body.body, ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}) },
    }));
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
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      const run = await tx.run.findFirst({
        where: { id: runId, runnerId: body.runnerId, fencingToken: body.fencingToken, leaseExpiresAt: { gt: now }, status: { in: activeRunStatuses } },
        include: { task: { include: { templateStep: true } }, session: true },
      });
      if (!run?.session) return null;
      const succeeded = completionSucceeded({
        exitCode: body.exitCode,
        signal: body.signal ?? null,
        terminalEventSeen: body.terminalEventSeen,
        terminalSuccess: body.terminalSuccess,
        terminationReason: body.terminationReason ?? null,
      });
      const failureClass = succeeded
        ? null
        : body.failureClass ?? (body.exitCode === 0 ? FailureClass.PROTOCOL_ERROR : FailureClass.TASK_FAILED);
      const retryable = failureClass ? (body.retryable ?? failureIsRetryable(failureClass)) : false;
      const retryAt = failureClass && retryable ? new Date(now.getTime() + retryDelayMs(run.runNumber, failureClass)) : null;
      // An external failure buys the task one more attempt rather than spending one.
      const external = externalFailure({ succeeded, signal: body.signal ?? null, reported: body.externalFailure, failureClass });
      const budgetCeiling = run.maxRunsPerTask + (external ? 1 : 0);
      const terminalStatus = succeeded
        ? RunStatus.SUCCEEDED
        : body.terminationReason?.includes("walltime") || body.terminationReason?.includes("stall")
          ? RunStatus.TIMED_OUT
          : RunStatus.FAILED;
      const closed = await tx.run.updateMany({
        where: { id: runId, fencingToken: body.fencingToken, leaseExpiresAt: { gt: now }, status: { in: activeRunStatuses } },
        data: {
          status: terminalStatus,
          endedAt: now,
          leaseExpiresAt: null,
          sessionTokenRevokedAt: now,
          failureClass,
          failureReason: succeeded ? null : body.failureReason ?? "Execution failed",
          retryable,
          retryAt,
          terminationReason: body.terminationReason ?? null,
          branch: body.branch ?? run.branch,
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
            targetBranch: run.targetBranch,
            promptHash: run.promptHash,
            maxDurationMin: run.maxDurationMin,
            stallTimeoutMin: run.stallTimeoutMin,
            maxRunsPerTask: budgetCeiling,
            readyAt: retryAt ?? now,
          },
        });
        retryCreated = true;
      }
      if (run.taskId) {
        const budgetExhausted = !succeeded && retryable && !retryCreated;
        if (succeeded && run.task && (run.task.templateId || run.task.chainId || run.task.followUpTaskId)) {
          const existingOutput = await tx.taskStepOutput.findUnique({ where: { taskId: run.taskId } });
          if (existingOutput) {
            await tx.taskStepOutput.update({
              where: { taskId: run.taskId },
              data: {
                runId: run.id,
                metadata: jsonValue({ branch: body.branch ?? run.branch, headSha: body.headSha }),
              },
            });
          } else {
            await tx.taskStepOutput.create({ data: {
              taskId: run.taskId,
              runId: run.id,
              kind: run.task.templateStep?.outputKind ?? "result",
              body: body.output?.trim() || `Run ${run.runNumber} completed successfully.`,
              metadata: jsonValue({ branch: body.branch ?? run.branch, headSha: body.headSha }),
            } });
          }
        }
        if (succeeded && run.task?.templateId) {
          await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now, run.task.status);
        } else if (succeeded && (run.task?.chainId || run.task?.followUpTaskId)) {
          if (run.task.approvalGate) {
            const claimed = await tx.task.updateMany({
              where: { id: run.taskId, status: run.task.status },
              data: { status: TaskStatus.REVIEW, failureReason: null },
            });
            if (claimed.count === 1) await gateQuestion(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null);
          } else {
            const completed = await tx.task.updateMany({
              where: { id: run.taskId, status: run.task.status }, data: { status: TaskStatus.DONE, failureReason: null },
            });
            if (completed.count === 1) {
              await activateChainSuccessor(tx, run.task, {
                sourceRunId: run.id,
                chatId: process.env.FEISHU_DEFAULT_CHAT_ID ?? null,
              }, now);
            }
          }
        } else {
          await tx.task.updateMany({
            where: { id: run.taskId, ...(run.task ? { status: run.task.status } : {}) },
            data: {
              status: retryCreated ? TaskStatus.DOING : TaskStatus.REVIEW,
              failureReason: succeeded ? null : budgetExhausted
                ? `Maximum ${budgetCeiling} runs reached`
                : body.failureReason ?? "Execution failed",
            },
          });
        }
        await tx.taskActivity.create({
          data: {
            taskId: run.taskId,
            actorType: "runner",
            actorId: body.runnerId,
            body: succeeded && (run.task?.templateId || run.task?.chainId || run.task?.followUpTaskId) ? `Run ${run.runNumber} succeeded; chain advanced or awaiting approval`
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
      return { taskId: run.taskId, succeeded, retryCreated, failureClass };
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
    await reconcileWorkspaces(
      db,
      process.env.RUNNER_WORKSPACE_ROOT ?? defaultWorkspaceRoot(),
      Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10),
    ).catch((error: unknown) => console.error("Post-run workspace reconciliation failed", error));
    return context.json(result);
  });

  // Plural, and it must stay plural: principalMayAccess denies the operator any
  // path starting with "/session/" (auth.ts), which "/sessions" misses by one
  // character. A singular route here 403s with no useful message.
  const sessionInclude = {
    agent: { select: { id: true, title: true } },
    task: { select: { id: true, name: true } },
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

  app.get("/sessions", async (context) => {
    const projectId = context.req.query("projectId");
    const limit = Math.min(Math.max(Number.parseInt(context.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const before = context.req.query("before");
    const beforeDate = before ? new Date(before) : null;
    return context.json(await db.session.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        // An unparseable cursor drops the filter rather than reaching Prisma as
        // an Invalid Date and surfacing as a 500.
        ...(beforeDate && !Number.isNaN(beforeDate.getTime()) ? { requestedAt: { lt: beforeDate } } : {}),
      },
      include: sessionInclude,
      orderBy: { requestedAt: "desc" },
      take: limit,
    }));
  });

  app.get("/sessions/:sessionId", async (context) => {
    const session = await db.session.findUnique({
      where: { id: id.parse(context.req.param("sessionId")) },
      include: sessionInclude,
    });
    return session ? context.json(session) : context.json({ error: "Session not found" }, 404);
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

export const app = createApp();
