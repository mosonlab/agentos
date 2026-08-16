import { AssigneeType, ScheduleKind } from "@agentos/db";
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
