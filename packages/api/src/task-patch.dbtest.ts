import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, RunStatus, TaskStatus } from "@anneal/db";

import { patchTask } from "./task-patch.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

/**
 * The seam itself. Every other test of this behaviour drives it over HTTP,
 * where a refusal is only ever a status code and a body; here the refusal is
 * the return value, so a test can ask for one without constructing a request.
 */

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

let sequence = 0;
const seed = async (overrides: {
  chainId?: string;
  archivedAt?: Date | null;
  status?: TaskStatus;
  outputKind?: string;
} = {}) => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({ data: { name: "Patch", slug: `patch-${suffix}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: `agent-${suffix}`, title: "Agent",
    model: "gpt-5.6-sol:high", runnerPreference: "CODEX", foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const template = overrides.outputKind === undefined
    ? null
    : await db.taskTemplate.create({
      data: { projectId: project.id, name: `patch-template-${suffix}`, description: "Patch", variables: [] },
    });
  const templateStep = template === null
    ? null
    : await db.taskTemplateStep.create({
      data: {
        taskTemplateId: template.id,
        stepIndex: 1,
        name: "Gate slot",
        assigneeType: "AGENT",
        prompt: "Gate slot",
        ...(overrides.outputKind === undefined ? {} : { outputKind: overrides.outputKind }),
        layer: 1,
      },
    });
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Patchable", description: "work",
    assigneeAgentId: agent.id, status: overrides.status ?? TaskStatus.TODO,
    chainId: overrides.chainId ?? null,
    ...(overrides.chainId ? { chainIndex: 0, chainLayer: 0 } : {}),
    ...(template === null ? {} : { templateId: template.id, templateStepId: templateStep!.id }),
    archivedAt: overrides.archivedAt ?? null,
  } });
  return { project, agent, task };
};

test("a non-slot dispatched chain task refuses an approval-gate patch", async () => {
  const { task } = await seed({ chainId: `chain-${process.pid}` });
  const result = await patchTask(db, task.id, { approvalGate: true });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "Only the specification and merge readiness steps carry a configurable gate",
  });
});

test("TODO gate slots accept on/off changes and record the operator activity", async () => {
  for (const [outputKind, slot] of [["spec", "spec"], ["merge-authorization-v2", "merge"]] as const) {
    const { task } = await seed({ chainId: `${slot}-${process.pid}`, outputKind });

    const enabled = await patchTask(db, task.id, { approvalGate: true });
    assert.ok("task" in enabled);
    assert.equal(enabled.task.approvalGate, true);
    assert.deepEqual(await db.taskActivity.findMany({
      where: { taskId: task.id },
      select: { actorType: true, body: true },
    }), [{ actorType: "operator", body: `Approval gate changed: ${slot} = true` }]);

    const disabled = await patchTask(db, task.id, { approvalGate: false });
    assert.ok("task" in disabled);
    assert.equal(disabled.task.approvalGate, false);
    assert.deepEqual(await db.taskActivity.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
      select: { actorType: true, body: true },
    }), [
      { actorType: "operator", body: `Approval gate changed: ${slot} = true` },
      { actorType: "operator", body: `Approval gate changed: ${slot} = false` },
    ]);
  }
});

test("a slot past TODO is refused with its locked actual state", async () => {
  for (const status of [TaskStatus.DOING, TaskStatus.REVIEW, TaskStatus.DONE]) {
    const { task } = await seed({ chainId: `${status}-${process.pid}`, outputKind: "spec", status });
    const result = await patchTask(db, task.id, { approvalGate: true });
    assert.deepEqual(result, {
      reason: "conflict",
      message: `The specification gate is already ${status}; approval gates may only be changed while the step is TODO`,
    });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).approvalGate, false);
    assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0);
  }
});

test("a standalone task keeps its existing approval-gate edit behaviour", async () => {
  const { task } = await seed();
  const result = await patchTask(db, task.id, { approvalGate: true });
  assert.ok("task" in result);
  assert.equal(result.task.approvalGate, true);
  assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0);
});

test("an assignee from another project is refused with 400", async () => {
  const { task } = await seed();
  const other = await seed();
  const result = await patchTask(db, task.id, { assigneeAgentId: other.agent.id });
  assert.deepEqual(result, { reason: "invalid-request", message: "Assignee does not belong to this project" });
});

test("an archived task refuses a status write from inside the transaction", async () => {
  const { task } = await seed({ archivedAt: new Date() });
  const result = await patchTask(db, task.id, { status: TaskStatus.DONE });
  assert.deepEqual(result, {
    reason: "conflict",
    message: "Cannot change the status of an archived task; unarchive it first",
  });
});

test("an active Run refuses a move to Backlog from inside the transaction", async () => {
  const { project, agent, task } = await seed();
  await db.run.create({ data: {
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    status: RunStatus.QUEUED,
    runner: "CODEX",
    model: agent.model,
    promptHash: "hash",
    branch: `codex/${task.id}`,
    workspacePath: `/scratch/${task.id}`,
  } });

  const result = await patchTask(db, task.id, { status: TaskStatus.BACKLOG });

  assert.deepEqual(result, {
    reason: "conflict",
    message: "Cannot move a task with an active run to Backlog",
  });
});

test("an archived stored assignee refuses Backlog reactivation", async () => {
  const { agent, task } = await seed({ status: TaskStatus.BACKLOG });
  await db.agent.update({ where: { id: agent.id }, data: { archivedAt: new Date() } });

  const result = await patchTask(db, task.id, { status: TaskStatus.TODO });

  assert.deepEqual(result, {
    reason: "conflict",
    message: `Assignee ${agent.name} is archived; unarchive the agent or reassign this task first`,
  });
});

test("an accepted patch returns the written task rather than a response", async () => {
  const { task } = await seed();
  const result = await patchTask(db, task.id, { name: "Renamed" });
  assert.ok("task" in result, "expected the written task");
  assert.equal(result.task.name, "Renamed");
});
