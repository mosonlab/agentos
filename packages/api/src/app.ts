import {
  AssigneeType,
  advanceTemplateTask,
  applyInboxDecision,
  CleanupStatus,
  FailureClass,
  Prisma,
  type PrismaClient,
  RepoPermission,
  RunStatus,
  PushStatus,
  RunnerKind,
  RunnerPreference,
  SessionEventSource,
  SessionExecutionStatus,
  TaskStatus,
  prisma,
} from "@agentos/db";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { authenticate, issueSessionToken, principalMayAccess, type Principal } from "./auth.js";
import {
  completionSucceeded,
  failureIsRetryable,
  hashPrompt,
  jsonValue,
  makeDedupeKey,
  makeFencingToken,
  retryDelayMs,
  runnerFor,
} from "./execution.js";
import { reconcileDatabaseRuns, reconcileWorkspaces } from "./reconcile.js";
import { decryptSecret } from "./secrets.js";
import { suspendForInbox } from "./inbox.js";
import { instantiateTemplate } from "./templates.js";

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
  maxSessionsPerTask: taskFields.maxSessionsPerTask.default(3),
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
  decision: z.enum(["approve", "reject"]),
  requestId: z.string().trim().min(1).max(200),
});

const readJson = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await request.json());

const withoutUndefined = (value: object): Record<string, unknown> => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined),
);

const isPublic = (path: string, method: string): boolean =>
  path === "/" || path === "/health" || method === "OPTIONS";

const activeRunStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX];

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
    const agent = await db.agent.findUnique({ where: { id: id.parse(context.req.param("agentId")) } });
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

  app.get("/inbox/messages", async (context) => context.json(await db.inboxMessage.findMany({
    where: { from: "AGENT" },
    include: { decisions: true },
    orderBy: { createdAt: "desc" },
  })));
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
      if (error instanceof Error && /(No matching|must be approve|no executable)/.test(error.message)) {
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
      await db.inboxMessage.create({
        data: {
          from: "AGENT",
          kind: "TEXT",
          body: `${body.runner.toLowerCase()} runner preflight failed and its circuit is open: ${body.error ?? "unknown error"}`,
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
          task: true,
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
      if (!succeeded && retryable && run.task && run.runNumber < run.maxRunsPerTask) {
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
            maxRunsPerTask: run.maxRunsPerTask,
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
                ? `Maximum ${run.maxRunsPerTask} runs reached`
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
              body: `Run budget exhausted after ${run.maxRunsPerTask} attempts; operator action required.`,
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
      process.env.RUNNER_WORKSPACE_ROOT ?? "/tmp/agentos-runs",
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
