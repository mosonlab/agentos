import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, type PrismaClient, TaskStatus } from "@anneal/db";

import { composeBrief, readBrief } from "./task-brief.js";
import { operatorStatusTransitionRefusal, patchTask } from "./task-patch.js";

const statusSubject = (
  status: TaskStatus,
  assigneeType: AssigneeType,
  chainId: string | null = null,
) => ({ status, assigneeType, chainId });

test("operator status ownership excludes agent execution and chain-derived states", () => {
  assert.equal(operatorStatusTransitionRefusal(
    statusSubject(TaskStatus.TODO, AssigneeType.AGENT),
    TaskStatus.BACKLOG,
  ), null);
  assert.equal(operatorStatusTransitionRefusal(
    statusSubject(TaskStatus.BACKLOG, AssigneeType.AGENT),
    TaskStatus.TODO,
  ), null);
  for (const target of [TaskStatus.DOING, TaskStatus.REVIEW, TaskStatus.DONE]) {
    assert.match(operatorStatusTransitionRefusal(
      statusSubject(TaskStatus.TODO, AssigneeType.AGENT),
      target,
    ) ?? "", /controlled by execution/u);
  }
  assert.match(operatorStatusTransitionRefusal(
    statusSubject(TaskStatus.TODO, AssigneeType.AGENT, "chain-1"),
    TaskStatus.BACKLOG,
  ) ?? "", /controlled by chain execution/u);
});

test("a Human owns queue movement and the Done decision", () => {
  assert.equal(operatorStatusTransitionRefusal(
    statusSubject(TaskStatus.BACKLOG, AssigneeType.HUMAN),
    TaskStatus.TODO,
  ), null);
  assert.equal(operatorStatusTransitionRefusal(
    statusSubject(TaskStatus.TODO, AssigneeType.HUMAN),
    TaskStatus.BACKLOG,
  ), null);
  assert.equal(operatorStatusTransitionRefusal(
    statusSubject(TaskStatus.REVIEW, AssigneeType.HUMAN, "chain-1"),
    TaskStatus.DONE,
  ), null);
  assert.match(operatorStatusTransitionRefusal(
    statusSubject(TaskStatus.TODO, AssigneeType.HUMAN),
    TaskStatus.REVIEW,
  ) ?? "", /may move between Backlog and Todo or be marked Done/u);
});

const patchFixture = (description: string, outputKind = "implementation") => {
  let update: Record<string, unknown> | null = null;
  const templateStep = {
    stepIndex: 1,
    outputKind,
    priorOutputKinds: [],
    taskTemplate: { name: "direct-engineer-workflow" },
  };
  const task = {
    id: "task-1",
    projectId: "project-1",
    templateId: "template-1",
    templateStepId: "step-1",
    chainId: "chain-1",
    description,
    name: "Direct implementation",
    approvalGate: false,
    archivedAt: null,
    status: TaskStatus.TODO,
    dispatchAfterTaskId: null,
    dispatchAfter: null,
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
    repoId: null,
    scheduleKind: null,
    templateStep,
  };
  const tx = {
    $queryRaw: async () => [{ id: task.id }],
    task: {
      findUnique: async () => task,
      findUniqueOrThrow: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        update = data;
        return { ...task, ...data };
      },
    },
    taskTemplateStep: { findUnique: async () => templateStep },
  };
  const db = {
    ...tx,
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  return { db, update: () => update };
};

test("an operator description edit rewrites only a template Chain task's brief", async () => {
  const description = composeBrief({
    prompt: "Implement the Specification of record.",
    brief: "Original brief",
    attachmentsFromPrevious: false,
    outputKind: "implementation",
  });
  const fixture = patchFixture(description);

  const result = await patchTask(fixture.db, "task-1", { description: "Operator-edited brief" });

  assert.ok("task" in result);
  const written = fixture.update()?.description;
  assert.equal(typeof written, "string");
  assert.deepEqual(readBrief(written as string), {
    prompt: "Implement the Specification of record.",
    brief: "Operator-edited brief",
    hadReminder: false,
  });
  assert.match(written as string, /Persist the final implementation output/u);
});

test("a template Chain description patch refuses an unparseable stored brief", async () => {
  const fixture = patchFixture("operator-corrupted description");

  const result = await patchTask(fixture.db, "task-1", { description: "Replacement brief" });

  assert.deepEqual(result, {
    reason: "invalid-request",
    message: "Cannot rewrite task brief: task brief marker is missing",
  });
  assert.equal(fixture.update(), null);
});

test("a mechanical template Step keeps its free-form description patch", async () => {
  const fixture = patchFixture("Run the merge readiness gate.", "merge-authorization");

  const result = await patchTask(fixture.db, "task-1", { description: "concurrent writer completed after recovery" });

  assert.ok("task" in result);
  assert.equal(fixture.update()?.description, "concurrent writer completed after recovery");
});
