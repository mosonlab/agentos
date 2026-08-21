import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chainKey,
  chainProgress,
  chainProgressByChain,
  chainStartDecisions,
  positions,
  runFactsByTask,
  startable,
  stepName,
  taskStartability,
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
  hasRepoGrant: true,
  ...overrides,
});

test("a TODO agent step with no runs is startable", () => {
  assert.equal(startable(startableRow(), { total: 0, active: false }, 3), true);
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

test("a missing repo grant blocks starting", () => {
  assert.equal(startable(startableRow({ hasRepoGrant: false }), { total: 0, active: false }, 3), false);
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

test("a run refunded as an external failure does not count against the budget", () => {
  // Issue #113's shape: three runs, two of which died provisioning and were
  // refunded. Exactly one attempt of a budget of three has actually been spent,
  // so the step is still startable — and it was not, because this predicate
  // only ever read the task's configured budget.
  assert.equal(startable(startableRow(), { total: 3, active: false, budgetGrants: 2 }, 3), true);
  assert.equal(startable(startableRow(), { total: 5, active: false, budgetGrants: 2 }, 3), false);
  // Omitted entirely — a caller with nothing granted — is the configured budget.
  assert.equal(startable(startableRow(), { total: 3, active: false }, 3), false);
});

test("lowering a task's budget bites immediately, and only the grants survive it", () => {
  // The reason grants are counted rather than read off a historical
  // `maxRunsPerTask`: two ordinary EXECUTE failures leave `maxRunsPerTask: 5`
  // on their rows and grant nothing. After the budget is lowered to 2 those
  // rows must not buy a third attempt.
  assert.equal(startable(startableRow(), { total: 2, active: false, budgetGrants: 0 }, 2), false);
  // A task that really was refunded twice keeps both refunds across the same
  // edit: two runs, none of them the agent's own attempt.
  assert.equal(startable(startableRow(), { total: 2, active: false, budgetGrants: 2 }, 2), true);
  // And raising the budget takes effect just as directly.
  assert.equal(startable(startableRow(), { total: 3, active: false, budgetGrants: 0 }, 5), true);
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

const decisionRow = (index: number, overrides: Partial<ChainRow & StartableRow & { maxSessionsPerTask: number }> = {}) => ({
  ...row({ id: `step-${index}`, chainIndex: index }),
  ...startableRow(),
  maxSessionsPerTask: 3,
  ...overrides,
});

test("chain dependency exposes only the first unfinished TODO or BACKLOG action", () => {
  const prefix = [1, 2, 3].map((index) => decisionRow(index, { status: "DONE" }));
  const doing = chainStartDecisions([...prefix, decisionRow(4, { status: "DOING" }), decisionRow(5), decisionRow(6)], new Map());
  assert.deepEqual([...doing.values()].map((item) => item.startAction), [null, null, null, null, null, null]);
  assert.equal(doing.get("step-5")!.blockingPredecessor?.name, "Task step-4");

  const todo = chainStartDecisions([...prefix, decisionRow(4), decisionRow(5)], new Map());
  assert.equal(todo.get("step-4")!.startAction, "start");
  assert.equal(todo.get("step-5")!.startAction, null);

  const parked = chainStartDecisions([...prefix, decisionRow(4, { status: "BACKLOG" }), decisionRow(5)], new Map());
  assert.equal(parked.get("step-4")!.startAction, "recover");
});

test("REVIEW, HUMAN, archive, grant, budget, and active-run facts fail closed", () => {
  for (const first of [
    decisionRow(1, { status: "REVIEW" }),
    decisionRow(1, { assigneeType: "HUMAN", assigneeAgentId: null }),
    decisionRow(1, { archivedAt: new Date() }),
    decisionRow(1, { hasRepoGrant: false }),
  ]) {
    assert.equal(chainStartDecisions([first, decisionRow(2)], new Map()).get("step-1")!.startAction, null);
  }
  assert.equal(chainStartDecisions([decisionRow(1)], new Map([["step-1", { total: 3, active: false }]])).get("step-1")!.startAction, null);
  // …but the same three runs with two of them refunded still leave an attempt.
  assert.equal(
    chainStartDecisions([decisionRow(1)], new Map([["step-1", { total: 3, active: false, budgetGrants: 2 }]])).get("step-1")!.startAction,
    "start",
  );
  const active = chainStartDecisions([decisionRow(1)], new Map([["step-1", { total: 1, active: true }]])).get("step-1")!;
  assert.equal(active.startAction, null);
  assert.equal(active.currentExecution, true);
});

test("deleted predecessors disappear while archived unfinished predecessors still block", () => {
  const deletedGap = chainStartDecisions([decisionRow(1, { status: "DONE" }), decisionRow(3)], new Map());
  assert.equal(deletedGap.get("step-3")!.startAction, "start");
  const archived = chainStartDecisions([
    decisionRow(1, { status: "DONE" }),
    decisionRow(2, { status: "BACKLOG", archivedAt: new Date() }),
    decisionRow(3),
  ], new Map());
  assert.equal(archived.get("step-3")!.blockingPredecessor?.id, "step-2");
});
