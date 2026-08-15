import {
  AssigneeType,
  Prisma,
  type PrismaClient,
  RunnerKind,
  RunnerPreference,
  SessionStatus,
  TaskStatus,
  prisma,
} from "@agentos/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

const id = z.string().min(1);
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
const taskFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string(),
  workingDirectory: z.string().trim().min(1).nullable(),
  assigneeType: z.nativeEnum(AssigneeType),
  assigneeAgentId: id.nullable(),
  approvalGate: z.boolean(),
};
const taskInput = z.object({
  ...taskFields,
  description: taskFields.description.default(""),
  workingDirectory: taskFields.workingDirectory.default(null),
  assigneeType: taskFields.assigneeType.default(AssigneeType.AGENT),
  assigneeAgentId: taskFields.assigneeAgentId.default(null),
  approvalGate: taskFields.approvalGate.default(false),
});
const taskPatch = z.object(taskFields).partial().extend({ status: z.nativeEnum(TaskStatus).optional() })
  .refine((value) => Object.keys(value).length > 0);
const activityInput = z.object({
  actorType: z.string().trim().min(1).max(40).default("operator"),
  actorId: z.string().trim().min(1).nullable().optional(),
  body: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const claimInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
});
const heartbeatInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
});
const completionInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  exitCode: z.number().int(),
  failureReason: z.string().max(2000).optional(),
});

const readJson = async <T>(request: Request, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await request.json());

const withoutUndefined = (value: object): Record<string, unknown> => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined),
);

const runnerFor = (preference: RunnerPreference, model: string): RunnerKind => {
  if (preference === RunnerPreference.CLAUDE) return RunnerKind.CLAUDE;
  if (preference === RunnerPreference.CODEX) return RunnerKind.CODEX;
  if (preference === RunnerPreference.PI) return RunnerKind.PI;
  const normalized = model.toLowerCase();
  if (normalized.includes("codex")) return RunnerKind.CODEX;
  if (normalized.includes("deepseek") || normalized.includes("pi")) return RunnerKind.PI;
  return RunnerKind.CLAUDE;
};

export const createApp = (db: PrismaClient = prisma): Hono => {
  const app = new Hono();

  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"] }));
  app.use("*", async (context, next) => {
    if (context.req.path === "/" || context.req.path === "/health" || context.req.method === "OPTIONS") {
      await next();
      return;
    }
    const configured = process.env.AGENTOS_API_TOKEN ?? process.env.OPERATOR_TOKEN ?? process.env.RUNNER_TOKEN;
    const supplied = context.req.header("Authorization");
    if (!configured || supplied !== `Bearer ${configured}`) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/", (context) => context.json({ name: "AgentOS control plane", phase: 1 }));
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
  app.post("/projects", async (context) => {
    const body = await readJson(context.req.raw, projectInput);
    return context.json(await db.project.create({ data: body }), 201);
  });
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
    const body = await readJson(context.req.raw, agentInput);
    return context.json(await db.agent.create({ data: { ...body, projectId: id.parse(context.req.param("projectId")) } }), 201);
  });
  app.get("/agents/:agentId", async (context) => {
    const agent = await db.agent.findUnique({ where: { id: id.parse(context.req.param("agentId")) } });
    return agent ? context.json(agent) : context.json({ error: "Agent not found" }, 404);
  });
  app.patch("/agents/:agentId", async (context) => context.json(await db.agent.update({
    where: { id: id.parse(context.req.param("agentId")) },
    data: withoutUndefined(await readJson(context.req.raw, agentPatch)) as Prisma.AgentUncheckedUpdateInput,
  })));
  app.delete("/agents/:agentId", async (context) => {
    await db.agent.delete({ where: { id: id.parse(context.req.param("agentId")) } });
    return context.body(null, 204);
  });

  app.get("/tasks", async (context) => {
    const projectId = context.req.query("projectId");
    return context.json(await db.task.findMany({
      ...(projectId ? { where: { projectId } } : {}),
      include: { assigneeAgent: true, sessions: { orderBy: { startedAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "asc" },
    }));
  });
  app.post("/projects/:projectId/tasks", async (context) => {
    const body = await readJson(context.req.raw, taskInput);
    const projectId = id.parse(context.req.param("projectId"));
    if (body.assigneeAgentId) {
      const agent = await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId } });
      if (!agent) return context.json({ error: "Assignee does not belong to this project" }, 400);
    }
    const task = await db.task.create({ data: { ...body, projectId } });
    await db.taskActivity.create({ data: { taskId: task.id, actorType: "operator", body: "Task created" } });
    return context.json(task, 201);
  });
  app.get("/tasks/:taskId", async (context) => {
    const task = await db.task.findUnique({
      where: { id: id.parse(context.req.param("taskId")) },
      include: { assigneeAgent: true, sessions: { orderBy: { startedAt: "desc" } } },
    });
    return task ? context.json(task) : context.json({ error: "Task not found" }, 404);
  });
  app.patch("/tasks/:taskId", async (context) => {
    const taskId = id.parse(context.req.param("taskId"));
    const body = await readJson(context.req.raw, taskPatch);
    const before = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    if (body.assigneeAgentId) {
      const agent = await db.agent.findFirst({ where: { id: body.assigneeAgentId, projectId: before.projectId } });
      if (!agent) return context.json({ error: "Assignee does not belong to this project" }, 400);
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
  app.post("/tasks/:taskId/activity", async (context) => {
    const body = await readJson(context.req.raw, activityInput);
    return context.json(await db.taskActivity.create({
      data: {
        taskId: id.parse(context.req.param("taskId")),
        actorType: body.actorType,
        actorId: body.actorId ?? null,
        body: body.body,
        ...(body.metadata ? { metadata: body.metadata as Prisma.InputJsonValue } : {}),
      },
    }), 201);
  });

  app.post("/runner/tasks/claim", async (context) => {
    const body = await readJson(context.req.raw, claimInput);
    const now = new Date();
    const claimed = await db.$transaction(async (tx) => {
      const expired = await tx.session.findMany({
        where: { status: SessionStatus.RUNNING, leaseExpiresAt: { lt: now }, taskId: { not: null } },
        select: { id: true, taskId: true },
      });
      if (expired.length > 0) {
        const sessionIds = expired.map((session) => session.id);
        const taskIds = expired.flatMap((session) => session.taskId ? [session.taskId] : []);
        await tx.session.updateMany({
          where: { id: { in: sessionIds }, status: SessionStatus.RUNNING },
          data: { status: SessionStatus.FAILED, endedAt: now, failureReason: "Runner lease expired" },
        });
        await tx.task.updateMany({ where: { id: { in: taskIds }, status: TaskStatus.DOING }, data: { status: TaskStatus.TODO } });
        if (taskIds.length > 0) {
          await tx.taskActivity.createMany({ data: taskIds.map((taskId) => ({ taskId, actorType: "runner", body: "Runner lease expired; task returned to todo" })) });
        }
      }

      const candidates = await tx.task.findMany({
        where: { status: TaskStatus.TODO, assigneeType: AssigneeType.AGENT, assigneeAgentId: { not: null }, workingDirectory: { not: null } },
        include: { assigneeAgent: true },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      for (const task of candidates) {
        if (!task.assigneeAgent) continue;
        const won = await tx.task.updateMany({ where: { id: task.id, status: TaskStatus.TODO }, data: { status: TaskStatus.DOING, failureReason: null } });
        if (won.count !== 1) continue;
        const leaseExpiresAt = new Date(now.getTime() + body.leaseSeconds * 1000);
        const runner = runnerFor(task.assigneeAgent.runnerPreference, task.assigneeAgent.model);
        const session = await tx.session.create({
          data: {
            agentId: task.assigneeAgent.id,
            taskId: task.id,
            runner,
            status: SessionStatus.RUNNING,
            runnerId: body.runnerId,
            heartbeatAt: now,
            leaseExpiresAt,
            runtimeHandle: `${body.runnerId}:${task.id}`,
          },
        });
        await tx.taskActivity.create({ data: { taskId: task.id, actorType: "runner", actorId: body.runnerId, body: `Claimed by ${body.runnerId} with ${runner.toLowerCase()} (${session.id})` } });
        return { task, agent: task.assigneeAgent, session, runner };
      }
      return null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return claimed ? context.json(claimed) : context.body(null, 204);
  });

  app.post("/runner/sessions/:sessionId/heartbeat", async (context) => {
    const body = await readJson(context.req.raw, heartbeatInput);
    const now = new Date();
    const updated = await db.session.updateMany({
      where: { id: id.parse(context.req.param("sessionId")), runnerId: body.runnerId, status: SessionStatus.RUNNING },
      data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + body.leaseSeconds * 1000) },
    });
    return updated.count === 1 ? context.json({ ok: true }) : context.json({ error: "Active lease not found" }, 409);
  });

  app.post("/runner/sessions/:sessionId/complete", async (context) => {
    const sessionId = id.parse(context.req.param("sessionId"));
    const body = await readJson(context.req.raw, completionInput);
    const result = await db.$transaction(async (tx) => {
      const session = await tx.session.findFirst({ where: { id: sessionId, runnerId: body.runnerId, status: SessionStatus.RUNNING } });
      if (!session?.taskId) return null;
      const succeeded = body.exitCode === 0;
      await tx.session.update({
        where: { id: session.id },
        data: {
          status: succeeded ? SessionStatus.DESTROYED : SessionStatus.FAILED,
          endedAt: new Date(),
          leaseExpiresAt: null,
          failureReason: succeeded ? null : body.failureReason ?? `CLI exited with code ${body.exitCode}`,
        },
      });
      await tx.task.update({
        where: { id: session.taskId },
        data: { status: TaskStatus.REVIEW, failureReason: succeeded ? null : body.failureReason ?? `CLI exited with code ${body.exitCode}` },
      });
      await tx.taskActivity.create({
        data: {
          taskId: session.taskId,
          actorType: "runner",
          actorId: body.runnerId,
          body: succeeded ? "Agent process finished; task moved to review" : `Agent process failed (exit ${body.exitCode}); task moved to review`,
          metadata: { exitCode: body.exitCode, failed: !succeeded },
        },
      });
      return { taskId: session.taskId, succeeded };
    });
    return result ? context.json(result) : context.json({ error: "Active lease not found" }, 409);
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
