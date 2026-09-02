import assert from "node:assert/strict";
import test from "node:test";

import {
  AssigneeType,
  COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
  type PrismaClient,
  TaskStatus,
} from "@anneal/db";

import { composeBrief, readBrief } from "./task-brief.js";
import { patchTask } from "./task-patch.js";

const patchFixture = (description: string, outputKind = "implementation") => {
  let update: Record<string, unknown> | null = null;
  const activities: Array<Record<string, unknown>> = [];
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
    status: TaskStatus.TODO as TaskStatus,
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
        Object.assign(task, data);
        return { ...task, ...data };
      },
    },
    taskTemplateStep: { findUnique: async () => templateStep },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activities.push(data);
        return { id: `activity-${activities.length}` };
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  return { db, update: () => update, activities: () => activities };
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

test("a compound implementation reassignment returns a structured refusal directly", async () => {
  const task = {
    id: "task-compound",
    projectId: "project-1",
    templateStepId: "step-compound",
    chainId: "chain-1",
    approvalGate: false,
    archivedAt: null,
    status: TaskStatus.TODO,
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "executioner",
    repoId: "repo-1",
    scheduleKind: null,
  };
  const db = {
    task: { findUniqueOrThrow: async () => task },
    agent: { findFirst: async () => null },
    taskTemplateStep: { findUnique: async () => ({
      stepIndex: 5,
      outputKind: "implementation",
      taskTemplate: { name: "compound-engineer-workflow" },
    }) },
  } as unknown as PrismaClient;

  assert.deepEqual(await patchTask(db, task.id, {
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
  }), {
    reason: "compound-implementation-assignee",
    message: "Compound implementation step must remain assigned to the active in-project Agent implementation-plan-executioner",
    detail: { code: COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE },
  });
});

test("TODO specification and merge slots accept approval-gate toggles with activity", async () => {
  for (const [outputKind, slot] of [["spec", "spec"], ["merge-authorization-v2", "merge"]] as const) {
    const fixture = patchFixture("Gate slot", outputKind);

    const enabled = await patchTask(fixture.db, "task-1", { approvalGate: true });
    assert.ok("task" in enabled);
    assert.equal(fixture.update()?.approvalGate, true);
    assert.deepEqual(fixture.activities(), [{ taskId: "task-1", actorType: "operator", body: `Approval gate changed: ${slot} = true` }]);

    const disabled = await patchTask(fixture.db, "task-1", { approvalGate: false });
    assert.ok("task" in disabled);
    assert.equal(fixture.update()?.approvalGate, false);
    assert.deepEqual(fixture.activities().map(({ taskId: _taskId, ...activity }) => activity), [
      { actorType: "operator", body: `Approval gate changed: ${slot} = true` },
      { actorType: "operator", body: `Approval gate changed: ${slot} = false` },
    ]);
  }
});

test("a non-slot chain task keeps the gate restriction", async () => {
  const fixture = patchFixture("Non-slot", "implementation");
  const result = await patchTask(fixture.db, "task-1", { approvalGate: true });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "Only the specification and merge readiness steps carry a configurable gate",
  });
  assert.equal(fixture.update(), null);
  assert.deepEqual(fixture.activities(), []);
});

test("a slot that is no longer TODO is refused under the Task lock", async () => {
  const fixture = patchFixture("Gate slot", "spec");
  const task = {
    id: "task-1",
    projectId: "project-1",
    templateId: "template-1",
    templateStepId: "step-1",
    chainId: "chain-1",
    description: composeBrief({
      prompt: "Implement the Specification of record.",
      brief: "Gate slot",
      attachmentsFromPrevious: false,
      outputKind: "spec",
    }),
    name: "Specification",
    approvalGate: false,
    archivedAt: null,
    status: TaskStatus.TODO,
    dispatchAfterTaskId: null,
    dispatchAfter: null,
    assigneeType: AssigneeType.HUMAN,
    assigneeAgentId: null,
    repoId: null,
    scheduleKind: null,
    templateStep: {
      stepIndex: 1,
      outputKind: "spec",
      priorOutputKinds: [],
      taskTemplate: { name: "compound-engineer-workflow" },
    },
  };
  let lockedRead = false;
  const tx = fixture.db as unknown as {
    task: { findUnique: (...args: unknown[]) => Promise<unknown>; findUniqueOrThrow: (...args: unknown[]) => Promise<unknown> };
  };
  tx.task.findUniqueOrThrow = async () => ({ ...task });
  tx.task.findUnique = async () => {
    if (lockedRead) return { ...task, status: TaskStatus.DOING };
    lockedRead = true;
    return { ...task };
  };

  const result = await patchTask(fixture.db, task.id, { approvalGate: true });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "The specification gate is already DOING; approval gates may only be changed while the step is TODO",
  });
  assert.equal(fixture.update(), null);
  assert.deepEqual(fixture.activities(), []);
});
