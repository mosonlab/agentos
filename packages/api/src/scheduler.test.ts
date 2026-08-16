import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, ScheduleKind } from "@agentos/db";

import { computeNextOccurrence, validateSchedule } from "./scheduler.js";

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
