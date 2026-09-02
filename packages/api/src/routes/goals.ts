import {
  GoalStatus,
  Prisma,
  RunnerPreference,
} from "@anneal/db";
import type {
  Goal as GoalContract,
  GoalDefinitionItem as GoalDefinitionItemContract,
  GoalProgressEntry as GoalProgressEntryContract,
} from "@anneal/db/console-contract";
import type { Context } from "hono";
import { z } from "zod";

import { jsonValue } from "../execution.js";
import { serializable } from "../transaction.js";
import { withoutUndefined } from "../without-undefined.js";
import {
  id,
  readJson,
  type AppEnvironment,
  type RouteApp,
  type RouteDeps,
} from "./support.js";

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

const goalInclude = {
  definitionOfDone: { orderBy: { itemIndex: "asc" as const } },
  progressLog: { orderBy: { createdAt: "asc" as const } },
};

type GoalResponse = GoalContract<Date, Prisma.Decimal>;
type GoalDefinitionItemResponse = GoalDefinitionItemContract;
type GoalProgressEntryResponse = GoalProgressEntryContract<Date>;
type PersistedGoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

/**
 * The console spelling of a persisted Goal status.
 *
 * Five of the eight values in `schema.prisma` are deliberately absent from the
 * console contract because nothing in this repository writes them (the reasons
 * are in `wire-contract.ts`). Reading one here means a writer appeared without
 * the console decision that goes with it, so the route says so instead of
 * sending a status the console has no label, tone or legend for.
 */
const consoleGoalStatus = (status: PersistedGoalStatus): GoalResponse["status"] => {
  if (status === GoalStatus.ACTIVE || status === GoalStatus.PAUSED || status === GoalStatus.COMPLETED) return status;
  throw new Error(`Goal status ${status} has no console wire spelling`);
};

const goalResponse = <T extends { status: PersistedGoalStatus }>(
  goal: T,
): Omit<T, "status"> & { status: GoalResponse["status"] } => ({
  ...goal,
  status: consoleGoalStatus(goal.status),
});

export const registerGoalsRoutes = (app: RouteApp, deps: RouteDeps): void => {
  const { db } = deps;

  app.get("/projects/:projectId/goals", async (context) => context.json((await db.goal.findMany({
    where: { projectId: id.parse(context.req.param("projectId")) },
    include: goalInclude,
    orderBy: { createdAt: "asc" },
  })).map(goalResponse) satisfies GoalResponse[]));
  app.post("/projects/:projectId/goals", async (context) => {
    const projectId = id.parse(context.req.param("projectId"));
    const body = await readJson(context.req.raw, goalInput);
    const { definitionOfDone, ...fields } = body;
    return context.json(goalResponse(await db.goal.create({
      data: {
        ...fields,
        projectId,
        definitionOfDone: {
          create: definitionOfDone.map((item, itemIndex) => ({ itemIndex, text: item.text })),
        },
      },
      include: goalInclude,
    })) satisfies GoalResponse, 201);
  });
  app.get("/goals/:goalId", async (context) => {
    const goal = await db.goal.findUnique({
      where: { id: id.parse(context.req.param("goalId")) }, include: goalInclude,
    });
    return goal ? context.json(goalResponse(goal) satisfies GoalResponse) : context.json({ error: "Goal not found" }, 404);
  });
  app.patch("/goals/:goalId", async (context) => context.json(goalResponse(await db.goal.update({
    where: { id: id.parse(context.req.param("goalId")) },
    data: withoutUndefined(await readJson(context.req.raw, goalPatch)) as Prisma.GoalUncheckedUpdateInput,
    include: goalInclude,
  })) satisfies GoalResponse));
  app.delete("/goals/:goalId", async (context) => {
    await db.goal.delete({ where: { id: id.parse(context.req.param("goalId")) } });
    return context.body(null, 204);
  });

  const approveGoalDod = async (context: Context<AppEnvironment, string>) => {
    const goalId = id.parse(context.req.param("goalId"));
    const goal = await db.goal.findUnique({
      where: { id: goalId },
      include: { definitionOfDone: true },
    });
    if (!goal) return context.json({ error: "Goal not found" }, 404);
    if (goal.definitionOfDone.length === 0) return context.json({ error: "Definition of Done must contain at least one item" }, 409);
    const completed = goal.definitionOfDone.every((item) => item.done);
    const now = new Date();
    return context.json(goalResponse(await db.goal.update({
      where: { id: goalId },
      data: {
        dodApproved: true,
        status: completed ? GoalStatus.COMPLETED : GoalStatus.ACTIVE,
        startedAt: goal.startedAt ?? now,
        endedAt: completed ? now : null,
      },
      include: goalInclude,
    })) satisfies GoalResponse);
  };
  app.post("/goals/:goalId/approve-dod", approveGoalDod);

  const pauseGoal = async (context: Context<AppEnvironment, string>) => {
    const goalId = id.parse(context.req.param("goalId"));
    const updated = await db.goal.updateMany({
      where: { id: goalId, status: GoalStatus.ACTIVE },
      data: { status: GoalStatus.PAUSED },
    });
    if (updated.count !== 1) return context.json({ error: "Only an active Goal can be paused" }, 409);
    return context.json(goalResponse(
      await db.goal.findUniqueOrThrow({ where: { id: goalId }, include: goalInclude }),
    ) satisfies GoalResponse);
  };
  app.post("/goals/:goalId/pause", pauseGoal);

  app.get("/goals/:goalId/definition-of-done", async (context) => context.json((await db.goalDefinitionItem.findMany({
    where: { goalId: id.parse(context.req.param("goalId")) }, orderBy: { itemIndex: "asc" },
  })) satisfies GoalDefinitionItemResponse[]));
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
    return context.json(result satisfies GoalDefinitionItemResponse, 201);
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
    return result
      ? context.json(result satisfies GoalDefinitionItemResponse)
      : context.json({ error: "Definition of Done item not found" }, 404);
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

  app.get("/goals/:goalId/progress-log", async (context) => context.json((await db.goalProgressEntry.findMany({
    where: { goalId: id.parse(context.req.param("goalId")) }, orderBy: { createdAt: "asc" },
  })) satisfies GoalProgressEntryResponse[]));
  app.post("/goals/:goalId/progress-log", async (context) => {
    const goalId = id.parse(context.req.param("goalId"));
    const body = await readJson(context.req.raw, progressInput);
    if (body.sessionId) {
      const session = await db.session.findFirst({ where: { id: body.sessionId, goalId }, select: { id: true } });
      if (!session) return context.json({ error: "Session does not belong to this Goal" }, 400);
    }
    return context.json((await db.goalProgressEntry.create({ data: {
      goalId,
      sessionId: body.sessionId ?? null,
      body: body.body,
      ...(body.metadata ? { metadata: jsonValue(body.metadata) } : {}),
    } })) satisfies GoalProgressEntryResponse, 201);
  });
};
