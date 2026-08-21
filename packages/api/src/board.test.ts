import assert from "node:assert/strict";
import test from "node:test";

import { type BoardRow, boardCard, byLatestRunActivity, chainDisplayByTask, etagFor, etagMatches, taskChainName } from "./board.js";

const row = (overrides: Partial<BoardRow> = {}): BoardRow => ({
  id: "t1",
  projectId: "p1",
  name: "Ship the thing",
  status: "TODO" as BoardRow["status"],
  failureReason: null,
  scheduleKind: "NOW" as BoardRow["scheduleKind"],
  runAt: null,
  cron: null,
  timezone: null,
  approvalGate: false,
  templateId: null,
  source: "MANUAL" as BoardRow["source"],
  chainId: null,
  chainIndex: null,
  updatedAt: new Date("2026-08-16T00:00:00.000Z"),
  templateStep: null,
  assigneeAgent: null,
  runs: [],
  ...overrides,
});

/* ------------------------------------------------------------ the projection */

test("the board card carries every field the board renders and nothing else", () => {
  // Spelled out rather than derived: a field added to the projection is a
  // deliberate act with a payload cost, so it has to be added here too.
  assert.deepEqual(Object.keys(boardCard(row(), null)).sort(), [
    "approvalGate", "assigneeAgent", "chainId", "chainIndex", "chainName", "chainProgress", "cron", "displayName",
    "failureReason", "id", "latestRun", "mergeOutcome", "name", "runAt", "scheduleKind", "source", "status",
    "templateId", "timezone", "updatedAt",
  ]);
});

test("the card's merge outcome is bound to the run it shows, and is null everywhere else", () => {
  const merged = JSON.stringify({ outcome: "merged", mergeCommitSha: "a".repeat(40) });
  const run = { id: "r1", runNumber: 3, status: "SUCCEEDED", session: null };
  // §SF-1: an ordinary step's output is not a malformed merge result, it is not
  // a merge result at all, and 112 board cards must not each carry a marker.
  assert.equal(boardCard(row({ runs: [run], stepOutput: { kind: "code-review", body: "fine", runId: "r1" } }), null).mergeOutcome, null);
  assert.equal(boardCard(row({ runs: [], stepOutput: { kind: "merge-result", body: merged, runId: "r1" } }), null).mergeOutcome, null);
  // A stop recorded by an earlier run is not the newest run's outcome.
  assert.equal(boardCard(row({ runs: [run], stepOutput: { kind: "merge-result", body: merged, runId: "r0" } }), null).mergeOutcome, null);
  assert.deepEqual(
    boardCard(row({ runs: [run], stepOutput: { kind: "merge-result", body: merged, runId: "r1" } }), null).mergeOutcome,
    { outcome: "merged", condition: null, incident: false },
  );
});

test("the projection drops the Run and Session columns the board never reads", () => {
  const card = boardCard(row({
    runs: [{
      id: "r1", runNumber: 3, status: "FAILED",
      // The real row carries ~45 more columns; only these four survive.
      session: { costUsd: "1.25", startedAt: new Date("2026-08-16T00:00:00Z"), endedAt: new Date("2026-08-16T00:02:00Z") },
    }],
  }), null);
  assert.deepEqual(card.latestRun, {
    id: "r1", runNumber: 3, status: "FAILED", costUsd: "1.25",
    startedAt: new Date("2026-08-16T00:00:00Z"), endedAt: new Date("2026-08-16T00:02:00Z"),
  });
});

test("a task with no runs reports no latest run rather than an empty one", () => {
  assert.equal(boardCard(row(), null).latestRun, null);
});

test("a run with no session reports a null cost, not a zero one", () => {
  // `0` would read as "this run spent nothing"; the runner simply never said.
  const card = boardCard(row({ runs: [{ id: "r1", runNumber: 1, status: "RUNNING", session: null }] }), null);
  assert.equal(card.latestRun?.costUsd, null);
});

test("a Decimal cost is serialised as the string the web client reads", () => {
  // Prisma hands back a Decimal instance, not a string, and `JSON.stringify`
  // of one is `{"s":1,"e":0,...}` unless it is stringified on the way out.
  const decimal = { toString: () => "0.42" };
  const card = boardCard(row({ runs: [{ id: "r1", runNumber: 1, status: "SUCCEEDED", session: { costUsd: decimal, startedAt: null, endedAt: null } }] }), null);
  assert.equal(card.latestRun?.costUsd, "0.42");
  assert.match(JSON.stringify(card), /"costUsd":"0\.42"/);
});

test("the assignee carries the model spec the card shows", () => {
  const card = boardCard(row({ assigneeAgent: { id: "a1", title: "Frontend Developer", model: "gpt-5.6-sol:medium" } }), null);
  assert.deepEqual(card.assigneeAgent, { id: "a1", title: "Frontend Developer", model: "gpt-5.6-sol:medium" });
});

test("chain names are derived only from the exact persisted template-step suffix", () => {
  assert.equal(taskChainName(row({ chainId: "c1", name: "Release: Review", templateStep: { name: "Review" } })), "Release");
  assert.equal(taskChainName(row({ chainId: "c1", name: "Release: Review notes", templateStep: { name: "Review" } })), null);
  assert.equal(taskChainName(row({ chainId: null, name: "Release: Review", templateStep: { name: "Review" } })), null);
});

test("direct chains derive one verified shared display prefix without changing stored names", () => {
  const rows = [
    row({ id: "build", chainId: "direct", name: "Release: Build" }),
    row({ id: "review", chainId: "direct", name: "Release: Review" }),
  ];
  const display = chainDisplayByTask(rows);
  assert.deepEqual(display.get("build"), { chainName: "Release", displayName: "Build" });
  assert.deepEqual(display.get("review"), { chainName: "Release", displayName: "Review" });
  assert.equal(rows[0]!.name, "Release: Build");
  assert.deepEqual(boardCard(rows[0]!, null, display.get("build")), {
    ...boardCard(rows[0]!, null), chainName: "Release", displayName: "Build",
  });
});

test("a direct chain prefix is not guessed from one row or a partial match", () => {
  const displays = chainDisplayByTask([
    row({ id: "solo", chainId: "solo-chain", name: "Release: Build" }),
    row({ id: "a", chainId: "mixed", name: "Release: Build" }),
    row({ id: "b", chainId: "mixed", name: "Other: Review" }),
  ]);
  assert.deepEqual(displays.get("solo"), { chainName: null, displayName: "Release: Build" });
  assert.deepEqual(displays.get("a"), { chainName: null, displayName: "Release: Build" });
});

test("tasks sort newest run-event activity first with an updatedAt fallback and stable ties", () => {
  const at = (value: string) => new Date(value);
  const rows = [
    row({ id: "later-created", status: "DONE", updatedAt: at("2026-08-16T12:00:00Z") }),
    row({ id: "earlier-created-later-finish", status: "DONE", updatedAt: at("2026-08-16T08:00:00Z") }),
    row({ id: "no-runs", updatedAt: at("2026-08-16T15:00:00Z"), runs: [] }),
  ];
  const activity = new Map([["later-created", at("2026-08-16T13:00:00Z")], ["earlier-created-later-finish", at("2026-08-16T14:00:00Z")]]);
  assert.deepEqual(byLatestRunActivity(rows, activity).map(({ id }) => id), ["no-runs", "earlier-created-later-finish", "later-created"]);
});

test("chainProgress is passed through, not recomputed", () => {
  // The arithmetic belongs to the chain module; a second implementation here
  // could disagree with the numbers the detail page renders.
  const progress = {
    chainId: "c1", done: 3, total: 9, activeStepName: "Implementation",
    activeStatus: "doing", position: 4,
  };
  assert.equal(boardCard(row({ chainId: "c1", chainIndex: 4 }), progress).chainProgress, progress);
});

test("the failure reason is carried in full, because Copy error hands it over", () => {
  const long = `${"/very/long/path/segment".repeat(80)} failed`;
  assert.equal(boardCard(row({ failureReason: long }), null).failureReason, long);
});

test("a board card is an order of magnitude smaller than the row it projects", () => {
  // The measured board: 112 cards, 1,581,550 bytes of full rows. The acceptance
  // bar is a 250KB initial payload, so a card has ~2.2KB to spend and uses far
  // less than that whenever the task did not fail.
  const card = boardCard(row({
    assigneeAgent: { id: "cmsuawxym0000mpoyd5ga82sm", title: "Implementation Plan Executioner", model: "gpt-5.6-sol:medium" },
    runs: [{ id: "cmsuawxym0001mpoyd5ga82sm", runNumber: 2, status: "SUCCEEDED", session: { costUsd: "0.42", startedAt: null, endedAt: null } }],
  }), null);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 700, "a clean card must stay well inside its budget");
});

/* --------------------------------------------------------------- the ETag */

test("the ETag is weak and stable for identical bytes", () => {
  const tag = etagFor('[{"id":"t1"}]');
  assert.match(tag, /^W\/"[A-Za-z0-9_-]+"$/);
  assert.equal(tag, etagFor('[{"id":"t1"}]'));
  assert.notEqual(tag, etagFor('[{"id":"t2"}]'));
});

test("If-None-Match matches a list, a lone tag and the wildcard", () => {
  const tag = etagFor("[]");
  assert.equal(etagMatches(tag, tag), true);
  assert.equal(etagMatches(`W/"stale", ${tag}`, tag), true);
  assert.equal(etagMatches("*", tag), true);
  assert.equal(etagMatches('W/"stale"', tag), false);
  assert.equal(etagMatches(undefined, tag), false);
  assert.equal(etagMatches("", tag), false);
});
