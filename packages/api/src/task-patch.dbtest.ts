import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, TaskStatus } from "@agentos/db";

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
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Patchable", description: "work",
    assigneeAgentId: agent.id, status: overrides.status ?? TaskStatus.TODO,
    chainId: overrides.chainId ?? null,
    ...(overrides.chainId ? { chainIndex: 0 } : {}),
    archivedAt: overrides.archivedAt ?? null,
  } });
  return { project, agent, task };
};

test("a dispatched chain task refuses an approval-gate patch", async () => {
  const { task } = await seed({ chainId: `chain-${process.pid}` });
  const result = await patchTask(db, task.id, { approvalGate: true });
  assert.deepEqual(result, {
    error: "Approval gates on dispatched chain tasks are controlled by the chain",
    code: 409,
  });
});

test("an assignee from another project is refused with 400", async () => {
  const { task } = await seed();
  const other = await seed();
  const result = await patchTask(db, task.id, { assigneeAgentId: other.agent.id });
  assert.deepEqual(result, { error: "Assignee does not belong to this project", code: 400 });
});

test("an archived task refuses a status write from inside the transaction", async () => {
  const { task } = await seed({ archivedAt: new Date() });
  const result = await patchTask(db, task.id, { status: TaskStatus.DONE });
  assert.deepEqual(result, {
    error: "Cannot change the status of an archived task; unarchive it first",
    code: 409,
  });
});

test("an accepted patch returns the written task rather than a response", async () => {
  const { task } = await seed();
  const result = await patchTask(db, task.id, { name: "Renamed" });
  assert.ok("task" in result, "expected the written task");
  assert.equal(result.task.name, "Renamed");
});
