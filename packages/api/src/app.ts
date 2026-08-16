import {
  AssigneeType,
  advanceTemplateTask,
  applyInboxDecision,
  CleanupStatus,
  FailureClass,
  GoalStatus,
  NetworkingMode,
  Prisma,
  type PrismaClient,
  RepoPermission,
  RunStatus,
  PushStatus,
  RunnerKind,
  RunnerPreference,
  SecretPurpose,
  SkillKind,
  SessionEventSource,
  SessionExecutionStatus,
  TaskStatus,
  prisma,
} from "@agentos/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getMimeType } from "hono/utils/mime";
import { z } from "zod";

import { authenticate, issueSessionToken, principalMayAccess, type Principal } from "./auth.js";
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
import { defaultWorkspaceRoot, reconcileDatabaseRuns, reconcileWorkspaces } from "./reconcile.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { suspendForInbox } from "./inbox.js";
import { instantiateTemplate } from "./templates.js";
import { getFileStore } from "./files/config.js";
import { InvalidPathError, NotADirectoryError, NotFoundError, SymlinkError, type FileStore } from "./files/store.js";

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
  folderPath: z.string().trim().min(1).max(4096),
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
  return undefined;
};

const deleteRecursively = async (store: FileStore, path: string): Promise<void> => {
  const stat = await store.stat(path);
  if (!stat) throw new NotFoundError(`Path not found: ${path}`);
  if (stat.kind === "dir") {
    for (const child of await store.list(path)) await deleteRecursively(store, child.path);
  }
  await store.delete(path);
};

const withoutUndefined = (value: object): Record<string, unknown> => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined),
);

const isPublic = (path: string, method: string): boolean =>
  path === "/" || path === "/health" || method === "OPTIONS";

const activeRunStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX];

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

  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "X-Fencing-Token"] }));
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
    await db.agent.delete({ where: { id: id.parse(context.req.param("agentId")) } });
    return context.body(null, 204);
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
  app.post("/agents/:agentId/filesystem-grants", async (context) => {
    const agentId = id.parse(context.req.param("agentId"));
    const body = await readJson(context.req.raw, filesystemGrantInput);
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
    return context.json(await db.filesystemGrant.update({
      where: { id: grantId },
      data: withoutUndefined(await readJson(context.req.raw, filesystemGrantPatch)) as Prisma.FilesystemGrantUncheckedUpdateInput,
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
  app.post("/projects/:projectId/task-templates/:templateId/instantiate", async (context) => {
    try {
      return context.json(await instantiateTemplate(
        db,
        id.parse(context.req.param("projectId")),
        id.parse(context.req.param("templateId")),
        await readJson(context.req.raw, instantiateTemplateInput),
      ), 201);
    } catch (error: unknown) {
      if (error instanceof Error && /(not found|has no|Missing template|Unknown template|must be agent)/i.test(error.message)) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.get("/tasks", async (context) => {
    const projectId = context.req.query("projectId");
    return context.json(await db.task.findMany({
      ...(projectId ? { where: { projectId } } : {}),
      include: {
        assigneeAgent: true,
        repo: true,
        runs: { orderBy: { runNumber: "desc" }, take: 1, include: { session: true } },
      },
      orderBy: { createdAt: "asc" },
    }));
  });
  app.post("/projects/:projectId/tasks", async (context) => {
    const body = await readJson(context.req.raw, taskInput);
    const projectId = id.parse(context.req.param("projectId"));
    const agent = body.assigneeAgentId
      ? await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId } })
      : null;
    if (body.assigneeAgentId && !agent) return context.json({ error: "Assignee does not belong to this project" }, 400);
    const repo = body.repoId ? await db.repo.findFirst({ where: { id: body.repoId, projectId } }) : null;
    if (body.repoId && !repo) return context.json({ error: "Repo does not belong to this project" }, 400);
    if (body.assigneeType === AssigneeType.AGENT && (!agent || !repo)) {
      return context.json({ error: "Agent tasks require an assignee and Repo configuration" }, 400);
    }
    if (agent && repo) {
      const access = await db.agentRepoAccess.findFirst({ where: { agentId: agent.id, repoId: repo.id, projectId } });
      if (!access) return context.json({ error: "Assignee has no grant for this Repo" }, 400);
    }
    const task = await db.$transaction(async (tx) => {
      const created = await tx.task.create({ data: { ...body, projectId } });
      await tx.taskActivity.create({ data: { taskId: created.id, actorType: "operator", body: "Task created" } });
      if (agent && repo && body.assigneeType === AssigneeType.AGENT) {
        const runner = runnerFor(agent.runnerPreference, agent.model);
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
            targetBranch: body.targetBranch ?? repo.defaultBranch,
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
  app.patch("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, taskPatch);
    const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    if (body.status === TaskStatus.DONE && before.templateId && before.approvalGate) {
      return context.json({ error: "Template approval gates must be decided through Inbox" }, 409);
    }
    if (body.assigneeAgentId) {
      const agent = await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId: before.projectId } });
      if (!agent) return context.json({ error: "Assignee does not belong to this project" }, 400);
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
    const task = await db.task.update({ where: { id: taskId }, data: withoutUndefined(body) as Prisma.TaskUncheckedUpdateInput });
    if (body.status && body.status !== before.status) {
      await db.taskActivity.create({ data: { taskId, actorType: "operator", body: `Status changed: ${before.status} → ${body.status}` } });
    }
    return context.json(task);
  });
  app.delete("/tasks/:taskId", async (context) => {
    await db.task.delete({ where: { id: id.parse(context.req.param("taskId")) } });
    return context.body(null, 204);
  });
  app.post("/tasks/:taskId/retry", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        include: { runs: { orderBy: { runNumber: "desc" }, take: 1 } },
      });
      if (!task) return { error: "Task not found", code: 404 as const };
      const last = task.runs[0];
      if (!last) return { error: "Task has no run to retry", code: 409 as const };
      if (last.status === RunStatus.QUEUED || last.status === RunStatus.CLAIMED || last.status === RunStatus.RUNNING) {
        return { error: "Task already has an active run", code: 409 as const };
      }
      if (last.runNumber >= last.maxRunsPerTask) return { error: "Run budget exhausted", code: 409 as const };
      const run = await tx.run.create({
        data: {
          projectId: last.projectId,
          taskId,
          goalId: last.goalId,
          agentId: last.agentId,
          repoId: last.repoId,
          runNumber: last.runNumber + 1,
          dedupeKey: makeDedupeKey(taskId, last.runNumber + 1),
          runner: last.runner,
          model: last.model,
          targetBranch: last.targetBranch,
          branch: last.branch,
          promptHash: last.promptHash,
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
    const claimed = await db.$transaction(async (tx) => {
      const candidates = await tx.run.findMany({
        where: {
          status: RunStatus.QUEUED,
          readyAt: { lte: now },
          task: { status: { in: [TaskStatus.TODO, TaskStatus.DOING] }, assigneeType: AssigneeType.AGENT },
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
        if (succeeded && run.task?.templateId) {
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
          await advanceTemplateTask(tx, run.taskId, run.id, process.env.FEISHU_DEFAULT_CHAT_ID ?? null, now);
        } else {
          await tx.task.update({
            where: { id: run.taskId },
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
            body: succeeded && run.task?.templateId ? `Run ${run.runNumber} succeeded; template chain advanced`
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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

  app.get("/runs/:runId/events", async (context) => context.json(await db.sessionEvent.findMany({
    where: { runId: id.parse(context.req.param("runId")) },
    orderBy: { seq: "asc" },
  })));

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
