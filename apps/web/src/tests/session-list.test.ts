import assert from "node:assert/strict";
import test from "node:test";

import { storage } from "../lib/storage";
import type { Session, SessionExecutionStatus } from "../lib/types";
import {
  ALL_SESSION_FILTER, filterAndGroupSessions, groupSessionsByDay, isSessionUnseen, localDayKey, sessionAgentOptions,
  markSessionOpened, readSessionSeenState, sessionFinishTimestamp,
  sessionSeenKey, sessionStatusMatches, sessionTimestamp,
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

  const wrongShapeId = "seen-wrong-shape-project";
  storage.set(sessionSeenKey(wrongShapeId), JSON.stringify({ since: 42, opened: {} }));
  assert.doesNotThrow(() => readSessionSeenState(wrongShapeId));
  const recoveredWrongShape = readSessionSeenState(wrongShapeId);
  assert.match(recoveredWrongShape.since, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(recoveredWrongShape.opened, {});
});

test("marking one Session opened clears only that Session", () => {
  const projectId = "seen-one-project";
  const first = row("first", "2026-08-21T00:00:00.000Z");
  const second = row("second", "2026-08-22T00:00:00.000Z");
  const state = { since: "2026-08-20T00:00:00.000Z", opened: {} };
  storage.set(sessionSeenKey(projectId), JSON.stringify(state));
  const opened = markSessionOpened(projectId, first.id, "2026-08-23T00:00:00.000Z");

  assert.equal(isSessionUnseen({ ...first, executionStatus: "SUCCEEDED", endedAt: first.requestedAt } as Session, opened), false);
  assert.equal(isSessionUnseen({ ...second, executionStatus: "SUCCEEDED", endedAt: second.requestedAt } as Session, opened), true);
  assert.deepEqual(Object.keys(opened.opened), [first.id]);
});

test("seen state works through the storage wrapper's degraded path", () => {
  const projectId = "seen-degraded-project";
  const key = sessionSeenKey(projectId);
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const blockedWindow = {};
  Object.defineProperty(blockedWindow, "localStorage", {
    configurable: true,
    get: () => { throw new Error("storage blocked"); },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: blockedWindow });
  try {
    const initial = readSessionSeenState(projectId);
    const opened = markSessionOpened(projectId, "degraded-session", "2026-08-23T00:00:00.000Z");
    assert.equal(opened.opened["degraded-session"], "2026-08-23T00:00:00.000Z");
    assert.equal(storage.get(key) !== null, true);
    assert.equal(isSessionUnseen({
      ...row("degraded-session", "2026-08-22T00:00:00.000Z"),
      executionStatus: "SUCCEEDED", endedAt: "2026-08-22T00:00:00.000Z",
    } as Session, opened), false);
    assert.notEqual(initial.since, undefined);
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", priorWindow);
  }
});

test("status filters map each lifecycle bucket without overlap", () => {
  const statuses: SessionExecutionStatus[] = [
    "REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX", "SUCCEEDED", "FAILED", "TIMED_OUT", "LOST", "CANCELLED",
  ];
  const expected = {
    live: ["REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX"],
    done: ["SUCCEEDED"],
    failed: ["FAILED", "TIMED_OUT", "LOST"],
    cancelled: ["CANCELLED"],
  } as const;

  for (const [bucket, matching] of Object.entries(expected)) {
    for (const status of statuses) assert.equal(sessionStatusMatches(status, bucket as keyof typeof expected), matching.includes(status as never), `${bucket}/${status}`);
  }
  for (const status of statuses) assert.equal(sessionStatusMatches(status, ALL_SESSION_FILTER), true, `all/${status}`);
});

test("agent options are distinct, title-labelled, sorted, and include All", () => {
  const sessions = [
    { ...row("z", atLocalDay(0, 8)), agentId: "agent-1" },
    { ...row("a", atLocalDay(0, 9)), agentId: "agent-z", agent: { id: "agent-z", title: "Zed" } },
    { ...row("b", atLocalDay(0, 10)), agentId: "agent-a", agent: { id: "agent-a", title: "Ada" } },
    { ...row("c", atLocalDay(0, 11)), agentId: "agent-z", agent: { id: "agent-z", title: "Zed" } },
  ] as Session[];

  assert.deepEqual(sessionAgentOptions(sessions), [
    { value: ALL_SESSION_FILTER, label: "All" },
    { value: "agent-a", label: "Ada" },
    { value: "agent-1", label: "agent-1" },
    { value: "agent-z", label: "Zed" },
  ]);
});

test("filter composition happens before grouping and the day cap", () => {
  const today = Array.from({ length: 7 }, (_, index) => ({
    ...row(`match-${index}`, atLocalDay(0, 8 + index)),
    agentId: index < 6 ? "agent-match" : "agent-other",
  })) as Session[];
  const groups = filterAndGroupSessions(today, { agentId: "agent-match", status: ALL_SESSION_FILTER });

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.sessions.length, 6, "heading count sees matching rows only");
  assert.deepEqual(groups[0]?.sessions.slice(0, 5).map((session) => session.id), [
    "match-5", "match-4", "match-3", "match-2", "match-1",
  ], "the five-row cap is applied after filtering");
});
