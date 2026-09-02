import assert from "node:assert/strict";
import { test } from "node:test";

import { ChainControlState, type ChainControlSnapshot } from "@anneal/db";

import {
  chainKey,
  chainProgress,
  chainProgressByChain,
  blockingPredecessor,
  positions,
  refusalForHeldChainStep,
  runFactsByTask,
  stepName,
  taskStartability,
  type ChainRow,
  type StartableRow,
} from "./chain.js";

const row = (overrides: Partial<ChainRow> & Pick<ChainRow, "id">): ChainRow => ({
  projectId: "project-1",
  chainId: "chain-1",
  chainIndex: 0,
  chainLayer: null,
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
    done: 0, total: 9, activeStepName: "Step 1", activeStatus: "todo", currentLayer: 1, layerCount: 9,
  });
  assert.deepEqual(chainProgress(nineSteps(3)), {
    done: 3, total: 9, activeStepName: "Step 4", activeStatus: "todo", currentLayer: 4, layerCount: 9,
  });
});

test("chainProgress on a finished chain reports the last row as active", () => {
  assert.deepEqual(chainProgress(nineSteps(9)), {
    done: 9, total: 9, activeStepName: "Step 9", activeStatus: "done", currentLayer: 9, layerCount: 9,
  });
});

test("chainProgress counts rows, not chainIndex, so a sparse template reads n/3", () => {
  const sparse = [
    row({ id: "a", chainIndex: 1, status: "DONE" }),
    row({ id: "b", chainIndex: 5, status: "DOING" }),
    row({ id: "c", chainIndex: 9 }),
  ];
  assert.deepEqual(chainProgress(sparse), {
    done: 1, total: 3, activeStepName: "Task b", activeStatus: "doing", currentLayer: 2, layerCount: 3,
  });
});

test("chainProgress handles a single row and an empty chain", () => {
  assert.deepEqual(chainProgress([row({ id: "only", status: "DONE" })]), {
    done: 1, total: 1, activeStepName: "Task only", activeStatus: "done", currentLayer: 1, layerCount: 1,
  });
  assert.equal(chainProgress([]), null);
});

test("an archived-but-DONE row counts toward both numbers", () => {
  const rows = [
    row({ id: "a", chainIndex: 1, status: "DONE", archivedAt: new Date() }),
    row({ id: "b", chainIndex: 2, status: "TODO" }),
  ];
  assert.deepEqual(chainProgress(rows), {
    done: 1, total: 2, activeStepName: "Task b", activeStatus: "todo", currentLayer: 2, layerCount: 2,
  });
});

test("parallel siblings share one dense current layer while node progress stays row-based", () => {
  const rows = [
    row({ id: "implementation", chainIndex: 1, chainLayer: 10, status: "DONE" }),
    row({ id: "sol", chainIndex: 2, chainLayer: 40, status: "DONE" }),
    row({ id: "blind", chainIndex: 3, chainLayer: 40, status: "TODO" }),
    row({ id: "adjudication", chainIndex: 4, chainLayer: 90, status: "TODO" }),
  ];
  assert.deepEqual(chainProgress(rows), {
    done: 2,
    total: 4,
    activeStepName: "Task blind",
    activeStatus: "todo",
    currentLayer: 2,
    layerCount: 3,
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
  hasRepoGrant: true,
  ...overrides,
});

test("a TODO agent step with no runs is startable", () => {
  assert.equal(taskStartability(startableRow(), { total: 0, active: false }, 3, true).startable, true);
});

test("an unresolved dispatch binding blocks the first-step decision", () => {
  const rowWithBinding = startableRow({
    dispatchAfterTaskId: "predecessor",
    dispatchAfter: { status: "DOING" },
  });
  const verdict = taskStartability(rowWithBinding, { total: 0, active: false }, 3, true);
  assert.equal(verdict.startable, false);
  assert.equal(verdict.checklist.predecessorsDone, false);
});

test("a resolved dispatch binding restores the ordinary first-step decision", () => {
  const resolved = startableRow({
    dispatchAfterTaskId: "predecessor",
    dispatchAfter: { status: "DONE" },
  });
  assert.equal(taskStartability(resolved, { total: 0, active: false }, 3, true).startable, true);
});

const heldControl = (heldLayer: number | null): ChainControlSnapshot => ({
  projectId: "project-1",
  chainId: "chain-1",
  state: ChainControlState.HELD,
  held: true,
  heldLayer,
  heldExecutionLayer: heldLayer,
  heldAt: new Date("2026-08-28T12:00:00.000Z"),
  holdRequestId: "hold-1",
  holdReason: null,
  releasedAt: null,
  releaseRequestId: null,
  holdGeneration: 1,
});

test("a held Chain refuses only steps above its held layer and names the hold", () => {
  const control = heldControl(2);
  assert.deepEqual(refusalForHeldChainStep({
    projectId: "project-1", chainId: "chain-1", chainIndex: 3, chainLayer: 3, name: "Later",
  }, control), {
    reason: "conflict",
    message: "Cannot start Later; Chain is held after layer 2",
  });
  assert.equal(refusalForHeldChainStep({
    projectId: "project-1", chainId: "chain-1", chainIndex: 2, chainLayer: 2, name: "Held layer",
  }, control), null);
  assert.equal(refusalForHeldChainStep({
    projectId: "project-1", chainId: "chain-1", chainIndex: 1, chainLayer: 1, name: "Earlier",
  }, control), null);
  assert.equal(refusalForHeldChainStep({
    projectId: "project-2", chainId: "chain-1", chainIndex: 3, chainLayer: 3, name: "Other project",
  }, control), null);
});

test("held-layer admission prefers chainLayer and falls back to chainIndex", () => {
  const control = heldControl(2);
  // The stored execution layer is authoritative even when chainIndex is much
  // larger (sparse template step numbering).
  assert.equal(refusalForHeldChainStep({
    projectId: "project-1", chainId: "chain-1", chainIndex: 99, chainLayer: 1, name: "Layer one",
  }, control), null);
  // Legacy rows without chainLayer compare by chainIndex.
  assert.match(refusalForHeldChainStep({
    projectId: "project-1", chainId: "chain-1", chainIndex: 3, chainLayer: null, name: "Legacy later",
  }, control)?.message ?? "", /held after layer 2/u);
  assert.deepEqual(refusalForHeldChainStep({
    projectId: "project-1", chainId: "chain-1", chainIndex: null, chainLayer: null, name: "Missing layer",
  }, control), {
    reason: "conflict",
    message: "Cannot start Missing layer; Chain is held",
  });
  assert.deepEqual(refusalForHeldChainStep({
    projectId: "project-1", chainId: "chain-1", chainIndex: 1, chainLayer: 1, name: "Invalid control",
  }, heldControl(null)), {
    reason: "conflict",
    message: "Cannot start Invalid control; Chain is held",
  });
});

test("released, absent, and chainless control states do not refuse admission", () => {
  const task = { projectId: "project-1", chainId: "chain-1", chainIndex: 3, chainLayer: 3, name: "Later" };
  assert.equal(refusalForHeldChainStep(task, undefined), null);
  assert.equal(refusalForHeldChainStep(task, { ...heldControl(2), held: false, state: ChainControlState.RELEASED }), null);
  assert.equal(refusalForHeldChainStep({ ...task, chainId: null }, heldControl(2)), null);
});

test("the exposed checklist and overall verdict come from the shared start predicate", () => {
  assert.deepEqual(taskStartability(startableRow(), { total: 0, active: false }, 3, true), {
    startable: true,
    checklist: {
      repoBound: true,
      agentAssignee: true,
      repoAccessGrant: true,
      budgetRemaining: true,
      noActiveRun: true,
      predecessorsDone: true,
    },
  });
  const blocked = taskStartability(
    startableRow({ repoId: null, hasRepoGrant: false }),
    { total: 3, active: true },
    3,
    false,
  );
  assert.equal(blocked.startable, false);
  assert.deepEqual(blocked.checklist, {
    repoBound: false,
    agentAssignee: true,
    repoAccessGrant: false,
    budgetRemaining: false,
    noActiveRun: false,
    predecessorsDone: false,
  });
});

test("a BACKLOG agent step is startable — that is what parks it there", () => {
  assert.equal(taskStartability(startableRow({ status: "BACKLOG" }), { total: 0, active: false }, 3, true).startable, true);
});

test("human steps, done steps, and archived steps are not startable", () => {
  assert.equal(taskStartability(startableRow({ assigneeType: "HUMAN", assigneeAgentId: null }), { total: 0, active: false }, 3, true).startable, false);
  assert.equal(taskStartability(startableRow({ status: "DONE" }), { total: 0, active: false }, 3, true).startable, false);
  assert.equal(taskStartability(startableRow({ status: "REVIEW" }), { total: 0, active: false }, 3, true).startable, false);
  assert.equal(taskStartability(startableRow({ archivedAt: new Date() }), { total: 0, active: false }, 3, true).startable, false);
});

test("a step with no agent or no repo is not startable", () => {
  assert.equal(taskStartability(startableRow({ assigneeAgentId: null }), { total: 0, active: false }, 3, true).startable, false);
  assert.equal(taskStartability(startableRow({ repoId: null }), { total: 0, active: false }, 3, true).startable, false);
});

test("a missing repo grant blocks starting", () => {
  assert.equal(taskStartability(startableRow({ hasRepoGrant: false }), { total: 0, active: false }, 3, true).startable, false);
});

test("an archived assignee blocks starting", () => {
  assert.equal(taskStartability(startableRow({ assigneeAgent: { archivedAt: new Date() } }), { total: 0, active: false }, 3, true).startable, false);
});

test("an active run blocks starting — including a run parked on an Inbox question", () => {
  // `active` is computed from ACTIVE_RUN_STATUSES, which includes WAITING_INBOX:
  // that run resumes the moment the operator answers.
  assert.equal(taskStartability(startableRow(), { total: 1, active: true }, 3, true).startable, false);
});

test("the run budget compares the count of runs, not the latest one", () => {
  assert.equal(taskStartability(startableRow(), { total: 2, active: false }, 3, true).startable, true);
  assert.equal(taskStartability(startableRow(), { total: 3, active: false }, 3, true).startable, false);
  assert.equal(taskStartability(startableRow(), { total: 4, active: false }, 3, true).startable, false);
});

test("a run refunded as an external failure does not count against the budget", () => {
  // Issue #113's shape: three runs, two of which died provisioning and were
  // refunded. Exactly one attempt of a budget of three has actually been spent,
  // so the step is still startable — and it was not, because this predicate
  // only ever read the task's configured budget.
  assert.equal(taskStartability(startableRow(), { total: 3, active: false, budgetGrants: 2 }, 3, true).startable, true);
  assert.equal(taskStartability(startableRow(), { total: 5, active: false, budgetGrants: 2 }, 3, true).startable, false);
  // Omitted entirely — a caller with nothing granted — is the configured budget.
  assert.equal(taskStartability(startableRow(), { total: 3, active: false }, 3, true).startable, false);
});

test("lowering a task's budget bites immediately, and only the grants survive it", () => {
  // The reason grants are counted rather than read off a historical
  // `maxRunsPerTask`: two ordinary EXECUTE failures leave `maxRunsPerTask: 5`
  // on their rows and grant nothing. After the budget is lowered to 2 those
  // rows must not buy a third attempt.
  assert.equal(taskStartability(startableRow(), { total: 2, active: false, budgetGrants: 0 }, 2, true).startable, false);
  // A task that really was refunded twice keeps both refunds across the same
  // edit: two runs, none of them the agent's own attempt.
  assert.equal(taskStartability(startableRow(), { total: 2, active: false, budgetGrants: 2 }, 2, true).startable, true);
  // And raising the budget takes effect just as directly.
  assert.equal(taskStartability(startableRow(), { total: 3, active: false, budgetGrants: 0 }, 5, true).startable, true);
});

test("runFactsByTask sums a grouped run query into totals, an active flag and the grants", () => {
  const facts = runFactsByTask([
    { taskId: "a", status: "SUCCEEDED", _count: { _all: 2 }, _max: { budgetGrants: 1 } },
    { taskId: "a", status: "WAITING_INBOX", _count: { _all: 1 }, _max: { budgetGrants: 3 } },
    { taskId: "b", status: "FAILED", _count: { _all: 1 }, _max: { budgetGrants: 0 } },
  ], ["QUEUED", "CLAIMED", "PROVISIONING", "RUNNING", "WAITING_INBOX"]);
  // The largest across the status groups, which arrive in no particular order.
  assert.deepEqual(facts.get("a"), { total: 3, active: true, budgetGrants: 3 });
  assert.deepEqual(facts.get("b"), { total: 1, active: false, budgetGrants: null });
  assert.equal(facts.get("c"), undefined);
});

test("runFactsByTask tolerates a grouped query with no grants column", () => {
  const facts = runFactsByTask([
    { taskId: "a", status: "FAILED", _count: { _all: 2 } },
  ], ["RUNNING"]);
  assert.deepEqual(facts.get("a"), { total: 2, active: false, budgetGrants: null });
});

test("blockingPredecessor respects layered siblings and surviving archived rows", () => {
  const rows = [
    row({ id: "done", chainIndex: 1, chainLayer: 1, status: "DONE" }),
    row({ id: "sibling-a", chainIndex: 2, chainLayer: 2 }),
    row({ id: "sibling-b", chainIndex: 3, chainLayer: 2 }),
    row({ id: "join", chainIndex: 4, chainLayer: 3 }),
  ];
  assert.equal(blockingPredecessor(rows, "sibling-a"), null);
  assert.equal(blockingPredecessor(rows, "sibling-b"), null);
  assert.equal(blockingPredecessor(rows, "join")?.id, "sibling-a");

  const archived = row({ id: "archived", chainIndex: 2, chainLayer: 2, status: "BACKLOG", archivedAt: new Date() });
  assert.equal(blockingPredecessor([rows[0]!, archived, rows[3]!], "join")?.id, "archived");
});
