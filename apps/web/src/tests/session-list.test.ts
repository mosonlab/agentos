import assert from "node:assert/strict";
import test from "node:test";

import { storage } from "../lib/storage";
import type { Session } from "../lib/types";
import {
  groupSessionsByDay, isSessionUnseen, localDayKey, markSessionOpened,
  readSessionSeenState, sessionFinishTimestamp, sessionSeenKey, sessionTimestamp,
} from "../lib/session-list";

const atLocalDay = (offset: number, hour: number): string => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, 0, 0, 0).toISOString();
};

const row = (id: string, requestedAt: string, startedAt: string | null = requestedAt): Session => ({
  id,
  requestedAt,
  startedAt,
} as Session);

test("groups sessions by their local started day, falling back to requested time", () => {
  const todayEarly = row("today-early", atLocalDay(0, 8));
  const todayLate = row("today-late", atLocalDay(0, 17));
  const yesterday = row("yesterday", atLocalDay(-1, 12));
  const queued = row("queued", atLocalDay(-2, 9), null);

  const groups = groupSessionsByDay([queued, todayEarly, yesterday, todayLate]);

  assert.deepEqual(groups.map((group) => group.key), [
    localDayKey(todayLate.startedAt!),
    localDayKey(yesterday.startedAt!),
    localDayKey(queued.requestedAt),
  ]);
  assert.deepEqual(groups[0]?.sessions.map((session) => session.id), ["today-late", "today-early"]);
  assert.equal(sessionTimestamp(queued), queued.requestedAt);
});

test("grouping does not mutate the input order", () => {
  const older = row("older", atLocalDay(0, 8));
  const newer = row("newer", atLocalDay(0, 9));
  const input = [older, newer];

  groupSessionsByDay(input);

  assert.deepEqual(input.map((session) => session.id), ["older", "newer"]);
});

test("unseen uses the terminal finish fallback and never marks live sessions", () => {
  const baseline = "2026-08-20T00:00:00.000Z";
  const state = { since: baseline, opened: {} };
  const base = row("seen-test", "2026-08-21T00:00:00.000Z");

  assert.equal(isSessionUnseen({ ...base, executionStatus: "RUNNING" } as Session, state), false);
  assert.equal(isSessionUnseen({ ...base, executionStatus: "SUCCEEDED", endedAt: baseline } as Session, state), false);
  assert.equal(isSessionUnseen({ ...base, executionStatus: "SUCCEEDED", endedAt: "2026-08-21T01:00:00.000Z" } as Session, state), true);
  assert.equal(isSessionUnseen({ ...base, executionStatus: "LOST", endedAt: null, startedAt: "2026-08-21T00:00:00.000Z" } as Session, state), true);
  assert.equal(sessionFinishTimestamp({ ...base, endedAt: null, startedAt: null } as Session), base.requestedAt);
  assert.equal(isSessionUnseen({ ...base, executionStatus: "SUCCEEDED", endedAt: "2026-08-21T01:00:00.000Z" } as Session, {
    ...state,
    opened: { [base.id]: "2026-08-21T02:00:00.000Z" },
  }), false);
});

test("first read creates a per-project baseline and marking opened writes the exact key", () => {
  const first = readSessionSeenState("seen-baseline-project");
  assert.match(first.since, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(first.opened, {});
  const raw = storage.get(sessionSeenKey("seen-baseline-project"));
  assert.ok(raw);
  assert.deepEqual(JSON.parse(raw), first);

  const second = readSessionSeenState("seen-baseline-project");
  assert.deepEqual(second, first);
  const other = readSessionSeenState("seen-other-project");
  assert.notEqual(other.since, undefined);
  assert.notEqual(sessionSeenKey("seen-baseline-project"), sessionSeenKey("seen-other-project"));

  const opened = markSessionOpened("seen-baseline-project", "session-a", "2026-08-22T00:00:00.000Z");
  assert.equal(opened.opened["session-a"], "2026-08-22T00:00:00.000Z");
  assert.equal(readSessionSeenState("seen-baseline-project").opened["session-a"], "2026-08-22T00:00:00.000Z");
});

test("opening prunes to the 500 newest entries and malformed records recover", () => {
  const projectId = "seen-prune-project";
  const opened = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
    `old-${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  ]));
  storage.set(sessionSeenKey(projectId), JSON.stringify({ since: "2025-01-01T00:00:00.000Z", opened }));
  const next = markSessionOpened(projectId, "newest", "2026-08-22T00:00:00.000Z");
  assert.equal(Object.keys(next.opened).length, 500);
  assert.equal(next.opened.newest, "2026-08-22T00:00:00.000Z");
  assert.equal(next.opened["old-0"], undefined);

  const malformedId = "seen-malformed-project";
  storage.set(sessionSeenKey(malformedId), "{not-json");
  assert.doesNotThrow(() => readSessionSeenState(malformedId));
  const recovered = readSessionSeenState(malformedId);
  assert.deepEqual(recovered.opened, {});
  assert.deepEqual(JSON.parse(storage.get(sessionSeenKey(malformedId))!), recovered);
});
