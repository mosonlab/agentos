import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, ScheduleKind } from "@anneal/db";

import { computeNextOccurrence, schedulerPollIntervalMs, schedulerTick, startScheduler, validateSchedule } from "./scheduler.js";

test("computeNextOccurrence handles minute math and an IANA timezone", () => {
  assert.equal(computeNextOccurrence("*/2 * * * *", "UTC", new Date("2026-08-15T12:01:30Z")).toISOString(), "2026-08-15T12:02:00.000Z");
  assert.equal(computeNextOccurrence("0 2 * * *", "Asia/Shanghai", new Date("2026-08-15T12:00:00Z")).toISOString(), "2026-08-15T18:00:00.000Z");
});

test("computeNextOccurrence respects spring-forward DST", () => {
  const next = computeNextOccurrence("30 2 * * *", "America/New_York", new Date("2026-03-08T06:00:00Z"));
  assert.equal(next.toISOString(), "2026-03-08T07:30:00.000Z");
});

test("cron dialect rejects six fields and macros but accepts five fields", () => {
  for (const expression of ["0 */2 * * * *", "* * * * * *", "@daily", "not a cron"]) {
    assert.throws(() => computeNextOccurrence(expression, null, new Date()));
  }
  assert.doesNotThrow(() => computeNextOccurrence("*/2 * * * *", null, new Date()));
});

test("validateSchedule rejects invalid timezones and non-executable AT tasks", () => {
  const base = { scheduleKind: ScheduleKind.AT, runAt: new Date(), cron: null, timezone: null, assigneeType: AssigneeType.AGENT, assigneeAgentId: "agent", repoId: "repo" };
  assert.doesNotThrow(() => validateSchedule(base));
  assert.throws(() => validateSchedule({ ...base, timezone: "Mars/Olympus" }), /Invalid IANA timezone/);
  assert.throws(() => validateSchedule({ ...base, assigneeType: AssigneeType.HUMAN, assigneeAgentId: null }), /require an agent/);
  assert.throws(() => validateSchedule({ ...base, repoId: null }), /require an agent/);
});

test("stored garbage cron is quarantined with the full observed tuple and one activity", async () => {
  const task = { id: "task-1", scheduleKind: "CRON", status: "TODO", cron: "garbage", timezone: "UTC", runAt: new Date(), projectId: "project-1" } as any;
  let where: Record<string, unknown> | undefined;
  let activities = 0;
  const database = {
    task: { findMany: async ({ where: query }: { where: { scheduleKind: string } }) => query.scheduleKind === "CRON" ? [task] : [] },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      task: { updateMany: async ({ where: value }: { where: Record<string, unknown> }) => { where = value; return { count: 1 }; } },
      taskActivity: { create: async () => { activities += 1; return {}; } },
    }),
  } as any;
  assert.deepEqual(await schedulerTick(database, new Date()), { cronFired: 0, atFired: 0, quarantined: 1 });
  assert.deepEqual(where, { id: task.id, scheduleKind: task.scheduleKind, status: task.status, cron: task.cron, timezone: task.timezone, runAt: task.runAt });
  assert.equal(activities, 1);
});

test("transient fire failures remain due and are not quarantined", async () => {
  const task = { id: "task-transient", scheduleKind: "CRON", status: "TODO", cron: "*/5 * * * *", timezone: "UTC", runAt: new Date(Date.now() - 60_000), projectId: "project-1" } as any;
  let transactions = 0;
  const database = {
    task: { findMany: async ({ where }: { where: { scheduleKind: string } }) => where.scheduleKind === "CRON" ? [task] : [] },
    $transaction: async () => { transactions += 1; throw new Error("temporary database failure"); },
  } as any;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await schedulerTick(database, new Date()), { cronFired: 0, atFired: 0, quarantined: 0 });
  } finally {
    console.error = originalError;
  }
  assert.equal(transactions, 1);
});

test("scheduler rollback lever creates no interval", () => {
  const previous = process.env.SCHEDULER_POLL_INTERVAL_MS;
  process.env.SCHEDULER_POLL_INTERVAL_MS = "0";
  try {
    assert.equal(startScheduler({} as any), null);
  } finally {
    if (previous === undefined) delete process.env.SCHEDULER_POLL_INTERVAL_MS; else process.env.SCHEDULER_POLL_INTERVAL_MS = previous;
  }
});

test("scheduler interval accepts only exact non-negative safe integers", () => {
  assert.equal(schedulerPollIntervalMs(undefined), 30_000);
  assert.equal(schedulerPollIntervalMs("0"), 0);
  assert.equal(schedulerPollIntervalMs("30000"), 30_000);
  for (const invalid of ["", "-1", "garbage", "0oops", "1.5", "9007199254740992"]) {
    assert.equal(schedulerPollIntervalMs(invalid), 30_000);
  }
});
