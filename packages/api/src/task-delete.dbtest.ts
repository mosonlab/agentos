import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { CHAIN_STRUCTURE_LOCK_CLASS, DependencyProvisioning, MERGE_TAIL_KIND, PrismaClient, RunStatus } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-task-delete-token";

const callApi = async (
  path: string,
  init: { method: "DELETE" | "POST"; body?: Record<string, unknown> },
): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${OPERATOR}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const callDelete = (path: string) => callApi(path, { method: "DELETE" });

const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for coordinated database state");
};

const seedContext = async (label: string) => {
  const suffix = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
  const project = await db.project.create({ data: { name: label, slug: `${label}-${suffix}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "agent",
    title: "Agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "repo",
    remoteUrl: "https://example.test/repo.git",
    mountPath: "/repo",
    dependencyProvisioning: DependencyProvisioning.NONE,
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  return { project, agent, repo };
};

type SeedContext = Awaited<ReturnType<typeof seedContext>>;

const seedChainTask = (
  context: SeedContext,
  chainId: string,
  chainIndex: number,
  name = `Step ${chainIndex}`,
) => db.task.create({ data: {
  projectId: context.project.id,
  assigneeAgentId: context.agent.id,
  repoId: context.repo.id,
  name,
  description: "work",
  chainId,
  chainIndex,
  chainLayer: chainIndex,
} });

const seedRepairTask = async (
  context: SeedContext,
  regressionTaskId: string,
) => {
  const task = await db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    name: "Autonomous merge tail: gate-fix",
    description: "repair",
  } });
  await db.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "control-plane",
    body: `Automatic gate-fix attempt for regression task ${regressionTaskId}`,
    metadata: {
      schemaVersion: 1,
      kind: MERGE_TAIL_KIND.repairAttempt,
      repairKind: "gate-fix",
      regressionTaskId,
    },
  } });
  await db.taskActivity.create({ data: {
    taskId: regressionTaskId,
    actorType: "control-plane",
    body: `Automatic gate-fix attempt queued as repair task ${task.id}`,
    metadata: {
      schemaVersion: 1,
      kind: MERGE_TAIL_KIND.repairAttempt,
      repairKind: "gate-fix",
      repairTaskId: task.id,
    },
  } });
  return task;
};

test("single-task delete refuses a direct Chain member and leaves it intact", async () => {
  const context = await seedContext("delete-chain-member");
  const chainId = `delete-chain-member-${Date.now()}`;
  const task = await seedChainTask(context, chainId, 0);

  const response = await callDelete(`/tasks/${task.id}`);

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: `Task belongs to Chain ${chainId}; delete the whole Chain instead`,
    code: "chain_task_delete_required",
    chainId,
  });
  assert.notEqual(await db.task.findUnique({ where: { id: task.id } }), null);
});

test("single-task delete also refuses a detached repair bound to a Chain marker", async () => {
  const context = await seedContext("delete-chain-repair");
  const chainId = `delete-chain-repair-${Date.now()}`;
  const regression = await seedChainTask(context, chainId, 0, "Regression");
  const repair = await seedRepairTask(context, regression.id);

  const response = await callDelete(`/tasks/${repair.id}`);

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "chain_task_delete_required");
  assert.equal(response.body.chainId, chainId);
  assert.notEqual(await db.task.findUnique({ where: { id: repair.id } }), null);
});

test("Chain delete removes every step and its marker-bound repair in one transaction", async () => {
  const context = await seedContext("delete-whole-chain");
  const chainId = `delete-whole-chain-${Date.now()}`;
  const first = await seedChainTask(context, chainId, 0);
  const regression = await seedChainTask(context, chainId, 1, "Regression");
  const repair = await seedRepairTask(context, regression.id);

  const response = await callDelete(`/tasks/${repair.id}/chain`);

  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(await db.task.count({ where: { id: { in: [first.id, regression.id, repair.id] } } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: repair.id } }), 0);
});

test("Chain delete refuses an active run on any member and deletes nothing", async () => {
  const context = await seedContext("delete-active-chain");
  const chainId = `delete-active-chain-${Date.now()}`;
  const first = await seedChainTask(context, chainId, 0);
  const active = await seedChainTask(context, chainId, 1);
  const repair = await seedRepairTask(context, active.id);
  await db.run.create({ data: {
    projectId: context.project.id,
    taskId: repair.id,
    agentId: context.agent.id,
    repoId: context.repo.id,
    runNumber: 1,
    dedupeKey: `task:${repair.id}:run:1`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "hash",
    status: RunStatus.RUNNING,
  } });

  const response = await callDelete(`/tasks/${first.id}/chain`);

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    error: `Cannot delete Chain ${chainId}; a member has an active run`,
    code: "chain_delete_active_run",
    chainId,
  });
  assert.equal(await db.task.count({ where: { id: { in: [first.id, active.id, repair.id] } } }), 3);
});

test("Chain delete refuses terminal run history with a machine-readable response", async () => {
  const context = await seedContext("delete-run-history-chain");
  const chainId = `delete-run-history-chain-${Date.now()}`;
  const first = await seedChainTask(context, chainId, 0);
  const regression = await seedChainTask(context, chainId, 1, "Regression");
  const repair = await seedRepairTask(context, regression.id);
  for (const [index, task] of [first, repair].entries()) {
    await db.run.create({ data: {
      projectId: context.project.id,
      taskId: task.id,
      agentId: context.agent.id,
      repoId: context.repo.id,
      runNumber: 1,
      dedupeKey: `task:${task.id}:run:1`,
      runner: "CLAUDE",
      model: "claude",
      promptHash: `terminal-${index}`,
      status: RunStatus.SUCCEEDED,
      endedAt: new Date(),
    } });
  }

  const response = await callDelete(`/tasks/${regression.id}/chain`);

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    error: `Cannot delete Chain ${chainId}; a member has run history`,
    code: "chain_delete_run_history",
    chainId,
  });
  assert.equal(await db.task.count({ where: { id: { in: [first.id, regression.id, repair.id] } } }), 3);
  assert.equal(await db.run.count({ where: { taskId: { in: [first.id, repair.id] } } }), 2);
});

test("a chained-task create waiting behind deletion cannot leave a surviving member", async () => {
  const context = await seedContext("delete-create-race");
  const chainId = `delete-create-race-${Date.now()}`;
  const first = await seedChainTask(context, chainId, 0);
  const second = await seedChainTask(context, chainId, 1);
  let releaseBlocker!: () => void;
  let blockerReady!: () => void;
  const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const ready = new Promise<void>((resolve) => { blockerReady = resolve; });
  const blocker = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${first.id} FOR UPDATE`;
    blockerReady();
    await release;
  });
  await ready;

  const deleting = callDelete(`/tasks/${first.id}/chain`);
  await waitFor(async () => {
    const waiting = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid::int = ${CHAIN_STRUCTURE_LOCK_CLASS}
        AND granted
    `;
    return waiting[0]?.count === 1;
  });

  const creating = callApi(`/projects/${context.project.id}/tasks`, {
    method: "POST",
    body: {
      name: "Late disjoint member",
      description: "must not survive deletion",
      assigneeType: "HUMAN",
      status: "BACKLOG",
      chainId,
      chainIndex: 9,
    },
  });
  await waitFor(async () => {
    const waiting = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid::int = ${CHAIN_STRUCTURE_LOCK_CLASS}
        AND NOT granted
    `;
    return waiting[0]?.count === 1;
  });
  releaseBlocker();

  const [deleted, created] = await Promise.all([deleting, creating]);
  await blocker;
  assert.equal(deleted.status, 204);
  assert.equal(created.status, 409);
  assert.deepEqual(created.body, {
    error: `Cannot add Task to Chain ${chainId}; the Chain no longer exists`,
    code: "chain_create_missing",
    chainId,
  });
  assert.equal(await db.task.count({ where: { id: { in: [first.id, second.id] } } }), 0);
  assert.equal(await db.task.count({ where: { projectId: context.project.id, chainId } }), 0);
});

test("single-task delete remains unchanged for a chainless task", async () => {
  const context = await seedContext("delete-chainless");
  const task = await db.task.create({ data: {
    projectId: context.project.id,
    name: "Standalone",
    description: "work",
  } });

  const response = await callDelete(`/tasks/${task.id}`);

  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(await db.task.findUnique({ where: { id: task.id } }), null);
});
