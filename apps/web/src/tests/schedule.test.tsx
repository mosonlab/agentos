import assert from "node:assert/strict";
import test from "node:test";

import { automationState, cronProse, nextRunLabel, scheduleLabel } from "../lib/schedule";

test("a cron expression renders as English prose with its timezone", () => {
  const prose = cronProse("0 9 * * *", "Asia/Shanghai");
  assert.match(prose, /9:00/);
  assert.match(prose, /Asia\/Shanghai/);
  assert.doesNotMatch(prose, /\*/);
});

test("an expression cronstrue rejects renders verbatim, never as an exception", () => {
  const prose = cronProse("not a cron at all", "UTC");
  assert.equal(prose, "not a cron at all");
  assert.doesNotMatch(prose, /Error/);
});

test("a null timezone does not throw and a null expression is a dash", () => {
  assert.doesNotMatch(cronProse("0 9 * * *", null), /\(/);
  assert.equal(cronProse(null, "UTC"), "—");
});

test("the next-run label distinguishes future, overdue, and far away", () => {
  assert.equal(nextRunLabel(null), "—");
  assert.equal(nextRunLabel(new Date(Date.now() + 30 * 60_000).toISOString()), "in 30m");
  assert.equal(nextRunLabel(new Date(Date.now() + 3 * 3_600_000).toISOString()), "in 3h");
  // Overdue means the scheduler has not caught up; it is not a future time.
  assert.match(nextRunLabel(new Date(Date.now() - 2 * 3_600_000).toISOString()), /ago$/);
  assert.doesNotMatch(nextRunLabel(new Date(Date.now() + 5 * 86_400_000).toISOString()), /^in /);
});

test("automation state reads pause first, then the quarantine marker", () => {
  const at = "2026-08-16T00:00:00.000Z";
  assert.equal(automationState({ schedulePausedAt: null, runAt: at }), "active");
  assert.equal(automationState({ schedulePausedAt: at, runAt: at }), "paused");
  assert.equal(automationState({ schedulePausedAt: null, runAt: null }), "quarantined");
  // A paused definition whose runAt was cleared is paused, not quarantined:
  // pausing is what the operator did, quarantine is what the scheduler did.
  assert.equal(automationState({ schedulePausedAt: at, runAt: null }), "paused");
});

test("a quarantined row shows the raw expression, never confident prose about it", () => {
  // The failure this pins: `cronstrue` does not throw on everything the control
  // plane rejects — it reinterprets. A seven-field expression is rejected by
  // `cron-parser` (too many fields) and described fluently by `cronstrue`, so
  // the row would say "Fix the cron expression" and describe its schedule in
  // the same breath. Quarantine is the only signal available, and it is enough.
  const wrong = "*/5 * * * * 7 9";
  assert.notEqual(cronProse(wrong, "UTC"), wrong);
  assert.equal(scheduleLabel({ schedulePausedAt: null, runAt: null, cron: wrong, timezone: "UTC" }), wrong);
  // Active and paused rows keep the prose — that is what the column is for.
  const at = "2026-08-16T00:00:00.000Z";
  assert.equal(
    scheduleLabel({ schedulePausedAt: null, runAt: at, cron: "0 9 * * *", timezone: "UTC" }),
    cronProse("0 9 * * *", "UTC"),
  );
  assert.equal(
    scheduleLabel({ schedulePausedAt: at, runAt: null, cron: "0 9 * * *", timezone: "UTC" }),
    cronProse("0 9 * * *", "UTC"),
  );
  // A quarantined row with no expression at all still renders something.
  assert.equal(scheduleLabel({ schedulePausedAt: null, runAt: null, cron: null, timezone: null }), "—");
});
