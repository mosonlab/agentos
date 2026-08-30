import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, TaskStatus } from "@anneal/db";

import { taskMoveAuthority, type TaskMoveFacts } from "./task-move-authority.js";

const facts = (overrides: Partial<TaskMoveFacts> = {}): TaskMoveFacts => ({
  name: "Ship the thing",
  status: TaskStatus.TODO,
  assigneeType: AssigneeType.AGENT,
  chainId: null,
  archivedAt: null,
  dispatchAfterTaskId: null,
  dispatchAfter: null,
  reactivationRefusal: null,
  activeRun: false,
  stopStateRefusal: null,
  chainPredecessor: null,
  ...overrides,
});

const refusal = (subject: TaskMoveFacts, status: TaskStatus): string | null => (
  taskMoveAuthority(subject).refusals.find((candidate) => candidate.status === status)?.message ?? null
);

test("the authority owns Agent, Human, and Chain transition targets", () => {
  assert.deepEqual(taskMoveAuthority(facts()).targets, [TaskStatus.BACKLOG]);
  assert.deepEqual(taskMoveAuthority(facts({ status: TaskStatus.BACKLOG })).targets, [TaskStatus.TODO]);
  assert.deepEqual(taskMoveAuthority(facts({ assigneeType: AssigneeType.HUMAN })).targets, [
    TaskStatus.BACKLOG,
    TaskStatus.DONE,
  ]);
  assert.deepEqual(taskMoveAuthority(facts({
    status: TaskStatus.REVIEW,
    assigneeType: AssigneeType.HUMAN,
    chainId: "chain-1",
  })).targets, [TaskStatus.DONE]);
  assert.match(refusal(facts({ chainId: "chain-1" }), TaskStatus.BACKLOG) ?? "", /controlled by chain execution/u);
});

test("archived and predecessor-bound tasks refuse status movement", () => {
  assert.match(refusal(facts({ archivedAt: new Date() }), TaskStatus.BACKLOG) ?? "", /archived task/u);
  assert.match(refusal(facts({
    dispatchAfterTaskId: "predecessor-1",
    dispatchAfter: { name: "Build", status: TaskStatus.DOING },
  }), TaskStatus.BACKLOG) ?? "", /predecessor Build is done/u);
});

test("reactivation refuses an archived stored assignee", () => {
  const subject = facts({
    status: TaskStatus.BACKLOG,
    reactivationRefusal: "Assignee Retired is archived; unarchive the agent or reassign this task first",
  });
  assert.equal(refusal(subject, TaskStatus.TODO), subject.reactivationRefusal);
  assert.deepEqual(taskMoveAuthority(subject).targets, []);
});

test("an active Run refuses both parking and Human completion", () => {
  assert.match(refusal(facts({ activeRun: true }), TaskStatus.BACKLOG) ?? "", /active run to Backlog/u);
  assert.match(refusal(facts({
    assigneeType: AssigneeType.HUMAN,
    activeRun: true,
  }), TaskStatus.DONE) ?? "", /done while it has an active run/u);
});

test("stop state and an unfinished Chain predecessor keep their refusal priority", () => {
  const stopped = "Merge integrator stopped on head-drift; answer the stop question before changing this task";
  assert.equal(refusal(facts({ stopStateRefusal: stopped }), TaskStatus.BACKLOG), stopped);
  assert.equal(refusal(facts({
    status: TaskStatus.REVIEW,
    assigneeType: AssigneeType.HUMAN,
    chainId: "chain-1",
    chainPredecessor: { name: "Regression" },
  }), TaskStatus.DONE), "Cannot complete Ship the thing; predecessor Regression is not done");
});

test("dynamic facts remain named deferred residue until read under the mutex", () => {
  assert.deepEqual(taskMoveAuthority(facts({ activeRun: undefined })).deferred, [
    { status: TaskStatus.BACKLOG, residue: "active-run" },
    { status: TaskStatus.DONE, residue: "active-run" },
  ]);
  assert.deepEqual(taskMoveAuthority(facts({ stopStateRefusal: undefined })).deferred, [
    { status: TaskStatus.BACKLOG, residue: "stop-state" },
    { status: TaskStatus.DOING, residue: "stop-state" },
    { status: TaskStatus.REVIEW, residue: "stop-state" },
    { status: TaskStatus.DONE, residue: "stop-state" },
  ]);
});
