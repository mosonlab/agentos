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
