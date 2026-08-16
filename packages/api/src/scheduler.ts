import {
  AssigneeType,
  enqueueTaskRun,
  Prisma,
  type PrismaClient,
  ScheduleKind,
  type Task,
  TaskStatus,
} from "@agentos/db";
import { CronExpressionParser } from "cron-parser";

export const computeNextOccurrence = (cron: string, timezone: string | null, after: Date): Date => {
  const expression = cron.trim();
  if (expression.startsWith("@") || expression.split(/\s+/).length !== 5) {
    throw new Error("Cron expressions must use exactly five fields and may not use macros");
  }
  return CronExpressionParser.parse(expression, {
    currentDate: after,
    ...(timezone ? { tz: timezone } : {}),
  }).next().toDate();
};

export type ScheduleFields = {
  scheduleKind: ScheduleKind;
  runAt: Date | null;
  cron: string | null;
  timezone: string | null;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  repoId: string | null;
};

export const validateSchedule = (fields: ScheduleFields, now = new Date()): Pick<ScheduleFields, "scheduleKind" | "runAt" | "cron" | "timezone"> => {
  if (fields.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: fields.timezone }).format(now);
    } catch {
      throw new Error(`Invalid IANA timezone: ${fields.timezone}`);
    }
  }
  if (fields.scheduleKind === ScheduleKind.CRON) {
    if (!fields.cron) throw new Error("CRON tasks require cron");
    return { ...fields, runAt: computeNextOccurrence(fields.cron, fields.timezone, now) };
  }
  if (fields.scheduleKind === ScheduleKind.AT) {
    if (!fields.runAt) throw new Error("AT tasks require runAt");
    if (fields.assigneeType !== AssigneeType.AGENT || !fields.assigneeAgentId || !fields.repoId) {
      throw new Error("AT tasks require an agent assignee and Repo configuration");
    }
  }
  return { scheduleKind: fields.scheduleKind, runAt: fields.runAt, cron: fields.cron, timezone: fields.timezone };
};

const uniqueConflict = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const quarantineTask = async (db: PrismaClient, task: Task, reason: unknown): Promise<boolean> => db.$transaction(async (tx) => {
  const claimed = await tx.task.updateMany({
    where: {
      id: task.id,
      scheduleKind: task.scheduleKind,
      status: task.status,
      cron: task.cron,
      timezone: task.timezone,
      runAt: task.runAt,
    },
    data: { runAt: null },
  });
  if (claimed.count !== 1) return false;
  await tx.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "scheduler",
    body: `Schedule quarantined: ${reason instanceof Error ? reason.message : String(reason)}`,
  } });
  console.warn("Scheduler quarantined task", { taskId: task.id, reason: reason instanceof Error ? reason.message : String(reason) });
  return true;
}, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

const fireLabel = (now: Date, timezone: string | null): string => new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeStyle: "short",
  ...(timezone ? { timeZone: timezone } : {}),
}).format(now);

export const fireCronTask = async (
  db: PrismaClient,
  task: Task,
  now: Date,
  onQuarantined: () => void = () => {},
): Promise<boolean> => {
  let nextRunAt: Date;
  try {
    if (!task.cron) throw new Error("CRON task is missing cron");
    nextRunAt = computeNextOccurrence(task.cron, task.timezone, now);
  } catch (error: unknown) {
    if (await quarantineTask(db, task, error)) onQuarantined();
    return false;
  }

  return db.$transaction(async (tx) => {
    const claimed = await tx.task.updateMany({
      where: { id: task.id, scheduleKind: ScheduleKind.CRON, status: TaskStatus.TODO, runAt: task.runAt },
      data: { runAt: nextRunAt },
    });
    if (claimed.count !== 1) return false;
    const suffix = ` — ${fireLabel(now, task.timezone)}`;
    const copy = await tx.task.create({ data: {
      projectId: task.projectId,
      repoId: task.repoId,
      assigneeAgentId: task.assigneeAgentId,
      assigneeType: task.assigneeType,
      approvalGate: task.approvalGate,
      description: task.description,
      workingDirectory: task.workingDirectory,
      targetBranch: task.targetBranch,
      maxDurationMin: task.maxDurationMin,
      stallTimeoutMin: task.stallTimeoutMin,
      maxSessionsPerTask: task.maxSessionsPerTask,
      spendCap: task.spendCap,
      spendCapApplicable: task.spendCapApplicable,
      name: `${task.name.slice(0, Math.max(0, 200 - suffix.length))}${suffix}`,
      scheduleKind: ScheduleKind.NOW,
      runAt: null,
      cron: null,
      timezone: null,
      chainId: null,
      chainIndex: null,
      followUpTaskId: null,
      templateId: null,
    } });
    if (copy.assigneeType === AssigneeType.AGENT && copy.assigneeAgentId && copy.repoId) {
      await enqueueTaskRun(tx, copy.id, now);
    }
    const metadata = { recurringTaskId: task.id, firedAt: now.toISOString() };
    await tx.taskActivity.createMany({ data: [
      { taskId: task.id, actorType: "scheduler", body: `Recurring task fired copy ${copy.id}`, metadata },
      { taskId: copy.id, actorType: "scheduler", body: `Created from recurring task ${task.id}`, metadata },
    ] });
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
};

export const fireAtTask = async (db: PrismaClient, task: Task, now: Date): Promise<boolean> => {
  try {
    return await db.$transaction(async (tx) => {
      await enqueueTaskRun(tx, task.id, now);
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error: unknown) {
    if (uniqueConflict(error)) return false;
    throw error;
  }
};

export const schedulerTick = async (db: PrismaClient, now = new Date()): Promise<{ cronFired: number; atFired: number; quarantined: number }> => {
  const [cronTasks, atTasks] = await Promise.all([
    db.task.findMany({ where: { scheduleKind: ScheduleKind.CRON, status: TaskStatus.TODO, runAt: { lte: now } } }),
    db.task.findMany({ where: {
      scheduleKind: ScheduleKind.AT,
      status: TaskStatus.TODO,
      runAt: { lte: now },
      runs: { none: {} },
      assigneeType: AssigneeType.AGENT,
    } }),
  ]);
  let cronFired = 0;
  let atFired = 0;
  let quarantined = 0;
  for (const task of cronTasks) {
    try {
      if (await fireCronTask(db, task, now, () => { quarantined += 1; })) cronFired += 1;
    } catch (error: unknown) {
      console.error("Scheduled CRON task fire failed", { taskId: task.id, error });
    }
  }
  for (const task of atTasks) {
    try {
      if (await fireAtTask(db, task, now)) atFired += 1;
    } catch (error: unknown) {
      console.error("Scheduled AT task fire failed", { taskId: task.id, error });
    }
  }
  return { cronFired, atFired, quarantined };
};

export const schedulerPollIntervalMs = (raw = process.env.SCHEDULER_POLL_INTERVAL_MS): number => {
  const fallback = 30_000;
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 0) {
    console.warn(`Invalid SCHEDULER_POLL_INTERVAL_MS=${JSON.stringify(raw)}; using ${fallback}ms`);
    return fallback;
  }
  return parsed;
};

export const startScheduler = (db: PrismaClient): ReturnType<typeof setInterval> | null => {
  const intervalMs = schedulerPollIntervalMs();
  if (intervalMs === 0) return null;
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void schedulerTick(db)
      .then((result) => {
        if (result.cronFired || result.atFired || result.quarantined) console.log("Scheduler tick", result);
      })
      .catch((error: unknown) => console.error("Scheduler tick failed", error))
      .finally(() => { busy = false; });
  }, intervalMs);
};
