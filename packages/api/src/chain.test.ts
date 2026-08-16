import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chainKey,
  chainProgress,
  chainProgressByChain,
  positions,
  runFactsByTask,
  startable,
  stepName,
  type ChainRow,
  type StartableRow,
} from "./chain.js";

const row = (overrides: Partial<ChainRow> & Pick<ChainRow, "id">): ChainRow => ({
  projectId: "project-1",
  chainId: "chain-1",
  chainIndex: 0,
  name: `Task ${overrides.id}`,
  status: "TODO",
  archivedAt: null,
  templateStep: null,
  ...overrides,
});

const nineSteps = (doneCount: number): ChainRow[] => Array.from({ length: 9 }, (_, index) => row({
  id: `step-${index + 1}`,
  chainIndex: index + 1,
  status: index < doneCount ? "DONE" : "TODO",
  templateStep: { name: `Step ${index + 1}` },
}));

test("chainProgress counts done rows and names the first unfinished step", () => {
  assert.deepEqual(chainProgress(nineSteps(0)), {
    done: 0, total: 9, activeStepName: "Step 1", activeStatus: "todo",
  });
  assert.deepEqual(chainProgress(nineSteps(3)), {
    done: 3, total: 9, activeStepName: "Step 4", activeStatus: "todo",
  });
});

test("chainProgress on a finished chain reports the last row as active", () => {
  assert.deepEqual(chainProgress(nineSteps(9)), {
    done: 9, total: 9, activeStepName: "Step 9", activeStatus: "done",
  });
});

test("chainProgress counts rows, not chainIndex, so a sparse template reads n/3", () => {
  const sparse = [
    row({ id: "a", chainIndex: 1, status: "DONE" }),
    row({ id: "b", chainIndex: 5, status: "DOING" }),
    row({ id: "c", chainIndex: 9 }),
  ];
  assert.deepEqual(chainProgress(sparse), {
    done: 1, total: 3, activeStepName: "Task b", activeStatus: "doing",
  });
});

test("chainProgress handles a single row and an empty chain", () => {
  assert.deepEqual(chainProgress([row({ id: "only", status: "DONE" })]), {
    done: 1, total: 1, activeStepName: "Task only", activeStatus: "done",
  });
  assert.equal(chainProgress([]), null);
});

test("an archived-but-DONE row counts toward both numbers", () => {
  const rows = [
    row({ id: "a", chainIndex: 1, status: "DONE", archivedAt: new Date() }),
    row({ id: "b", chainIndex: 2, status: "TODO" }),
  ];
  assert.deepEqual(chainProgress(rows), {
    done: 1, total: 2, activeStepName: "Task b", activeStatus: "todo",
  });
});

test("stepName prefers the template step's name", () => {
  assert.equal(stepName(row({ id: "a", templateStep: { name: "Implementation" } })), "Implementation");
  assert.equal(stepName(row({ id: "a" })), "Task a");
});

test("positions are 1-based ordinals by chainIndex, ignoring gaps and input order", () => {
  const sparse = [
    row({ id: "c", chainIndex: 9 }),
    row({ id: "a", chainIndex: 1 }),
    row({ id: "b", chainIndex: 5 }),
  ];
  assert.deepEqual([...positions(sparse)], [["a", 1], ["b", 2], ["c", 3]]);
});

test("chainProgressByChain keys by project and chain, so a cross-project collision stays separate", () => {
  const shared = "shared-chain-id";
  const rows = [
    row({ id: "p1-a", projectId: "p1", chainId: shared, chainIndex: 1, status: "DONE" }),
    row({ id: "p1-b", projectId: "p1", chainId: shared, chainIndex: 2 }),
    row({ id: "p2-a", projectId: "p2", chainId: shared, chainIndex: 1 }),
  ];
  const grouped = chainProgressByChain(rows);
  assert.equal(grouped.size, 2);
  assert.equal(grouped.get(chainKey({ projectId: "p1", chainId: shared }))!.total, 2);
  assert.equal(grouped.get(chainKey({ projectId: "p1", chainId: shared }))!.done, 1);
  assert.equal(grouped.get(chainKey({ projectId: "p2", chainId: shared }))!.total, 1);
});

test("chainProgressByChain skips rows with no chain", () => {
  assert.equal(chainProgressByChain([row({ id: "loner", chainId: null })]).size, 0);
});

const startableRow = (overrides: Partial<StartableRow> = {}): StartableRow => ({
  status: "TODO",
  assigneeType: "AGENT",
  assigneeAgentId: "agent-1",
  repoId: "repo-1",
  archivedAt: null,
  assigneeAgent: { archivedAt: null },
  ...overrides,
});

test("a TODO agent step with no runs is startable", () => {
  assert.equal(startable(startableRow(), { total: 0, active: false }, 3), true);
});

test("a BACKLOG agent step is startable — that is what parks it there", () => {
  assert.equal(startable(startableRow({ status: "BACKLOG" }), { total: 0, active: false }, 3), true);
});

test("human steps, done steps, and archived steps are not startable", () => {
  assert.equal(startable(startableRow({ assigneeType: "HUMAN", assigneeAgentId: null }), { total: 0, active: false }, 3), false);
  assert.equal(startable(startableRow({ status: "DONE" }), { total: 0, active: false }, 3), false);
  assert.equal(startable(startableRow({ status: "REVIEW" }), { total: 0, active: false }, 3), false);
  assert.equal(startable(startableRow({ archivedAt: new Date() }), { total: 0, active: false }, 3), false);
});

test("a step with no agent or no repo is not startable", () => {
  assert.equal(startable(startableRow({ assigneeAgentId: null }), { total: 0, active: false }, 3), false);
  assert.equal(startable(startableRow({ repoId: null }), { total: 0, active: false }, 3), false);
});

test("an archived assignee blocks starting", () => {
  assert.equal(startable(startableRow({ assigneeAgent: { archivedAt: new Date() } }), { total: 0, active: false }, 3), false);
});

test("an active run blocks starting — including a run parked on an Inbox question", () => {
  // `active` is computed from ACTIVE_RUN_STATUSES, which includes WAITING_INBOX:
  // that run resumes the moment the operator answers.
  assert.equal(startable(startableRow(), { total: 1, active: true }, 3), false);
});

test("the run budget compares the count of runs, not the latest one", () => {
  assert.equal(startable(startableRow(), { total: 2, active: false }, 3), true);
  assert.equal(startable(startableRow(), { total: 3, active: false }, 3), false);
  assert.equal(startable(startableRow(), { total: 4, active: false }, 3), false);
});

test("runFactsByTask sums a grouped run query into totals and an active flag", () => {
  const facts = runFactsByTask([
    { taskId: "a", status: "SUCCEEDED", _count: { _all: 2 } },
    { taskId: "a", status: "WAITING_INBOX", _count: { _all: 1 } },
    { taskId: "b", status: "FAILED", _count: { _all: 1 } },
  ], ["QUEUED", "CLAIMED", "PROVISIONING", "RUNNING", "WAITING_INBOX"]);
  assert.deepEqual(facts.get("a"), { total: 3, active: true });
  assert.deepEqual(facts.get("b"), { total: 1, active: false });
  assert.equal(facts.get("c"), undefined);
});
