import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@anneal/db";

import { type BoardRow, boardCard, chainDisplayByTask, etagFor, etagMatches, readBoard, repairBinding, taskChainName } from "./board.js";

const session = (overrides: Partial<NonNullable<BoardRow["runs"][number]["session"]>> = {}): NonNullable<BoardRow["runs"][number]["session"]> => ({
  nativeChildUsed: false, costUsd: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, startedAt: null, endedAt: null, ...overrides,
});

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
  chainLayer: null,
  dispatchAfterTaskId: null,
  updatedAt: new Date("2026-08-16T00:00:00.000Z"),
  templateStep: null,
  assigneeAgent: null,
  runs: [],
  ...overrides,
});

const boardReadDatabase = ({
  rows,
  chainRows = [],
  related = [],
}: {
  rows: BoardRow[];
  chainRows?: Array<Record<string, unknown>>;
  related?: Array<{ id: string; name: string; status: BoardRow["status"] }>;
}): { db: PrismaClient; predecessorLookups: string[][] } => {
  const predecessorLookups: string[][] = [];
  const db = {
    task: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        const where = args.where ?? {};
        if (where.id !== undefined) {
          const ids = (where.id as { in: string[] }).in;
          predecessorLookups.push(ids);
          return related.filter((candidate) => ids.includes(candidate.id));
        }
        if (where.chainId !== undefined) return chainRows;
        return rows;
      },
    },
    taskActivity: { findMany: async () => [] },
  } as unknown as PrismaClient;
  return { db, predecessorLookups };
};

/* ------------------------------------------------------------ the read model */

test("readBoard performs no predecessor lookup for an unbound page", async () => {
  const { db, predecessorLookups } = boardReadDatabase({ rows: [row()] });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });

  assert.equal(cards[0]?.blockedOn, null);
  assert.deepEqual(predecessorLookups, []);
});

test("readBoard resolves every bound row in one deduplicated predecessor lookup", async () => {
  const predecessorOne = { id: "predecessor-1", name: "Build predecessor", status: "DOING" as BoardRow["status"] };
  const predecessorTwo = { id: "predecessor-2", name: "Review predecessor", status: "REVIEW" as BoardRow["status"] };
  const { db, predecessorLookups } = boardReadDatabase({
    rows: [
      row({ id: "first", chainId: "successor-1", chainIndex: 0, dispatchAfterTaskId: predecessorOne.id }),
      row({ id: "same-binding", chainId: "successor-2", chainIndex: 0, dispatchAfterTaskId: predecessorOne.id }),
      row({ id: "second", chainId: "successor-3", chainIndex: 0, dispatchAfterTaskId: predecessorTwo.id }),
      row({ id: "unbound", chainId: "successor-4", chainIndex: 0 }),
    ],
    related: [predecessorOne, predecessorTwo],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });

  assert.deepEqual(predecessorLookups, [[predecessorOne.id, predecessorTwo.id]]);
  assert.deepEqual(cards.find((card) => card.id === "first")?.blockedOn, {
    taskId: predecessorOne.id, taskName: predecessorOne.name,
  });
  assert.deepEqual(cards.find((card) => card.id === "same-binding")?.blockedOn, {
    taskId: predecessorOne.id, taskName: predecessorOne.name,
  });
  assert.deepEqual(cards.find((card) => card.id === "second")?.blockedOn, {
    taskId: predecessorTwo.id, taskName: predecessorTwo.name,
  });
  assert.equal(cards.find((card) => card.id === "unbound")?.blockedOn, null);
});

/* ------------------------------------------------------------ the projection */

test("the board card carries every field the board renders and nothing else", () => {
  // Spelled out rather than derived: a field added to the projection is a
  // deliberate act with a payload cost, so it has to be added here too.
  assert.deepEqual(Object.keys(boardCard(row(), null)).sort(), [
    "approvalGate", "assigneeAgent", "blockedOn", "chainId", "chainIndex", "chainName", "chainProgress", "cron", "displayName",
    "failureReason", "id", "latestRun", "mergeOutcome", "name", "repairOf", "runAt", "scheduleKind", "source", "status",
    "taskCost", "templateId", "timezone", "updatedAt",
  ]);
});

test("a repair task is bound to the chain of the regression task its marker names", () => {
  const chain = (): { chainId: string; chainName: string | null } => ({ chainId: "c1", chainName: "Release" });
  assert.deepEqual(
    repairBinding({ schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: "reg-1" }, chain),
    { chainId: "c1", chainName: "Release", repairKind: "gate-fix" },
  );
  // The regression side of the same marker names the repair task, not a chain
  // this card could be put under, so it is not this card's binding.
  assert.equal(
    repairBinding({ schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", repairTaskId: "fix-1" }, chain),
    null,
  );
  // A regression task that is itself chain-detached binds nothing.
  assert.equal(repairBinding({ repairKind: "review-fix", regressionTaskId: "reg-1" }, () => null), null);
  assert.equal(repairBinding(null, chain), null);
  assert.equal(boardCard(row(), null).repairOf, null);
  assert.deepEqual(
    boardCard(row(), null, undefined, null, { chainId: "c1", chainName: "Release", repairKind: "review-fix" }).repairOf,
    { chainId: "c1", chainName: "Release", repairKind: "review-fix" },
  );
});

test("blockedOn is projected from the resolved predecessor without storing its status", () => {
  const predecessor = { id: "after-1", name: "Finish the release", status: "DOING" as BoardRow["status"] };
  const blocked = boardCard(row({ dispatchAfterTaskId: predecessor.id }), null, undefined, predecessor);
  assert.deepEqual(blocked.blockedOn, { taskId: predecessor.id, taskName: predecessor.name });

  const resolved = boardCard(row({ dispatchAfterTaskId: predecessor.id }), null, undefined, {
    ...predecessor, status: "DONE" as BoardRow["status"],
  });
  assert.equal(resolved.blockedOn, null);

  const unbound = boardCard(row(), null);
  assert.equal(unbound.blockedOn, null);
  const { blockedOn: _blockedOn, ...rest } = unbound;
  assert.deepEqual(rest, {
    id: "t1",
    name: "Ship the thing",
    displayName: "Ship the thing",
    status: "TODO",
    failureReason: null,
    scheduleKind: "NOW",
    runAt: null,
    cron: null,
    timezone: null,
    approvalGate: false,
    templateId: null,
    source: "MANUAL",
    chainId: null,
    chainIndex: null,
    chainName: null,
    updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    assigneeAgent: null,
    chainProgress: null,
    latestRun: null,
    taskCost: null,
    mergeOutcome: null,
    repairOf: null,
  });
});

test("the card's merge outcome is bound to the run it shows, and is null everywhere else", () => {
  const merged = JSON.stringify({ outcome: "merged", mergeCommitSha: "a".repeat(40) });
  const run = { id: "r1", runNumber: 3, status: "SUCCEEDED", model: "gpt-5.6-sol", session: null };
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
      id: "r1", runNumber: 3, status: "FAILED", model: "claude-opus-5",
      // The real row carries ~45 more columns; only these fields survive.
      session: session({ costUsd: "1.25", startedAt: new Date("2026-08-16T00:00:00Z"), endedAt: new Date("2026-08-16T00:02:00Z") }),
    }],
  }), null);
  assert.deepEqual(card.latestRun, {
    id: "r1", runNumber: 3, status: "FAILED", model: "claude-opus-5", costUsd: "1.25",
    startedAt: new Date("2026-08-16T00:00:00Z"), endedAt: new Date("2026-08-16T00:02:00Z"),
  });
  assert.equal(card.taskCost?.costUsd, "1.25");
});

test("the latest run carries its own claimed model, not the assignee's current one", () => {
  // The board card labels the run line with this; a re-tiered agent must not
  // relabel a run that already happened.
  const card = boardCard(row({
    assigneeAgent: { id: "a1", title: "merge-resolver", model: "gpt-5.6-sol:high" },
    runs: [{ id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5:medium", session: null }],
  }), null);
  assert.equal(card.latestRun?.model, "claude-opus-5:medium");
  assert.equal(card.assigneeAgent?.model, "gpt-5.6-sol:high");
});

test("a task with no runs reports no latest run rather than an empty one", () => {
  assert.equal(boardCard(row(), null).latestRun, null);
});

test("a run with no session reports a null cost, not a zero one", () => {
  // `0` would read as "this run spent nothing"; the runner simply never said.
  const card = boardCard(row({ runs: [{ id: "r1", runNumber: 1, status: "RUNNING", model: "gpt-5.6-sol", session: null }] }), null);
  assert.equal(card.taskCost, null);
});

test("a Decimal cost is serialised as the string the web client reads", () => {
  // Prisma hands back a Decimal instance, not a string, and `JSON.stringify`
  // of one is `{"s":1,"e":0,...}` unless it is stringified on the way out.
  const decimal = new Prisma.Decimal("0.42");
  const card = boardCard(row({ runs: [{ id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", session: session({ costUsd: decimal }) }] }), null);
  assert.equal(card.taskCost?.costUsd, "0.42");
  assert.equal(card.latestRun?.costUsd, "0.42");
  assert.match(JSON.stringify(card), /"costUsd":"0\.42"/);
});

test("task cost sums every run including failures and marks an estimated summand", () => {
  const card = boardCard(row({ runs: [
    { id: "r2", runNumber: 2, status: "SUCCEEDED", model: "gpt-5.6-luna:max", session: session({
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0,
    }) },
    { id: "r1", runNumber: 1, status: "FAILED", model: "claude-opus-5:high", session: session({ costUsd: "1.25" }) },
  ] }), null);
  assert.deepEqual(card.latestRun, { id: "r2", runNumber: 2, status: "SUCCEEDED", model: "gpt-5.6-luna:max", costUsd: null, startedAt: null, endedAt: null });
  assert.equal(card.taskCost?.costUsd, "1.45");
  assert.equal(card.taskCost?.estimated, true);
});

test("mixed-model native subagent Runs use the pinned Luna estimate", () => {
  const card = boardCard(row({ runs: [{
    id: "r1", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol:high",
    subagentModel: "gpt-5.6-luna:max",
    session: session({ nativeChildUsed: true, inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  }] }), null);
  assert.equal(card.taskCost?.costUsd, "0.32");
  assert.equal(card.taskCost?.estimated, true);
  assert.equal(card.taskCost?.inputTokens, 1_000_000);
});

test("a native subagent grant without an observed child uses the root estimate", () => {
  const card = boardCard(row({ runs: [{
    id: "r1", runNumber: 1, status: "SUCCEEDED", model: "gpt-5.6-sol:high",
    subagentModel: "gpt-5.6-luna:max",
    session: session({ nativeChildUsed: false, inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000 }),
  }] }), null);
  assert.equal(card.taskCost?.costUsd, "8");
  assert.equal(card.taskCost?.estimated, true);
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

test("readBoard computes chainProgress from the complete chain lookup", async () => {
  const current = row({
    id: "current", chainId: "c1", chainIndex: 0, chainLayer: 0,
    name: "Release: Implementation", templateStep: { name: "Implementation" },
  });
  const { db } = boardReadDatabase({
    rows: [current],
    chainRows: [
      {
        id: current.id, projectId: current.projectId, chainId: "c1", chainIndex: 0, chainLayer: 0,
        status: current.status, name: current.name, archivedAt: null, templateStep: current.templateStep,
      },
      {
        id: "archived-review", projectId: current.projectId, chainId: "c1", chainIndex: 1, chainLayer: 1,
        status: "DONE", name: "Release: Review", archivedAt: new Date("2026-08-15T00:00:00Z"),
        templateStep: { name: "Review" },
      },
    ],
  });

  const cards = await readBoard(db, { projectId: "p1", archived: "false" });

  assert.deepEqual(cards[0]?.chainProgress, {
    chainId: "c1", done: 1, total: 2, activeStepName: "Implementation",
    activeStatus: "todo", currentLayer: 1, layerCount: 2, position: 1,
  });
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
    runs: [{ id: "cmsuawxym0001mpoyd5ga82sm", runNumber: 2, status: "SUCCEEDED", model: "claude-opus-5", session: session({ costUsd: "0.42" }) }],
  }), null);
  // The card carries both cost surfaces — the latest run's own cost and the
  // cross-run task total — so the clean-card bound sits at 800, still under
  // half the ~2.2KB acceptance budget.
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 800, "a clean card must stay well inside its budget");
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
