import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "../lib/types";
import { groupSessionsByDay, localDayKey, sessionTimestamp } from "../lib/session-list";

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
