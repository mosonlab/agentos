import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { fireAtTask, fireCronTask, schedulerTick } from "./scheduler.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const seedExecutor = async () => {
  const project = await db.project.create({ data: { name: "Scheduler", slug: `scheduler-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo" } });
  return { project, agent, repo };
};

test("due CRON fires one fully-normalized copy and advances strictly into the future", async () => {
  const { project, agent, repo } = await seedExecutor();
  const now = new Date("2026-08-15T12:05:00Z");
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Recurring", description: "work",
    scheduleKind: "CRON", cron: "*/2 * * * *", timezone: "UTC", runAt: new Date("2026-08-15T11:00:00Z"),
    spendCap: "42.50", spendCapApplicable: true,
  } });
  assert.equal(await fireCronTask(db, definition, now), true);
  const refreshed = await db.task.findUniqueOrThrow({ where: { id: definition.id } });
  assert.ok(refreshed.runAt!.getTime() > now.getTime());
  const copy = await db.task.findFirstOrThrow({ where: { projectId: project.id, id: { not: definition.id } } });
  assert.equal(copy.scheduleKind, "NOW");
  assert.equal(copy.cron, null);
  assert.equal(copy.runAt, null);
  assert.equal(copy.chainId, null);
  assert.equal(copy.spendCap?.toString(), "42.5");
  assert.equal(copy.spendCapApplicable, true);
  assert.equal(await db.run.count({ where: { taskId: copy.id, status: "QUEUED" } }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: { in: [definition.id, copy.id] } } }), 2);
});

test("concurrent CRON ticks materialize exactly one copy", async () => {
  const { project, agent, repo } = await seedExecutor();
  const now = new Date();
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Race", description: "work",
    scheduleKind: "CRON", cron: "*/5 * * * *", runAt: new Date(now.getTime() - 60_000),
  } });
  await Promise.all([fireCronTask(db, definition, now), fireCronTask(db, definition, now)]);
  assert.equal(await db.task.count({ where: { projectId: project.id } }), 2);
});

test("paused definitions do not fire, and human CRON resumes to a TODO copy without a run", async () => {
  const { project } = await seedExecutor();
  const now = new Date();
  const definition = await db.task.create({ data: {
    projectId: project.id, name: "Human", description: "review", assigneeType: "HUMAN", status: "REVIEW",
    scheduleKind: "CRON", cron: "*/5 * * * *", runAt: new Date(now.getTime() - 60_000),
  } });
  assert.deepEqual(await schedulerTick(db, now), { cronFired: 0, atFired: 0, quarantined: 0 });
  await db.task.update({ where: { id: definition.id }, data: { status: "TODO" } });
  assert.equal((await schedulerTick(db, now)).cronFired, 1);
  const copy = await db.task.findFirstOrThrow({ where: { projectId: project.id, id: { not: definition.id } } });
  assert.equal(copy.status, "TODO");
  assert.equal(await db.run.count({ where: { taskId: copy.id } }), 0);
});

test("AT task queues once under sequential and concurrent ticks", async () => {
  const { project, agent, repo } = await seedExecutor();
  const now = new Date();
  const task = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "At", description: "work",
    scheduleKind: "AT", runAt: new Date(now.getTime() - 60_000),
  } });
  const otherDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let arrived = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  const instrument = (client: PrismaClient): PrismaClient => new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
        // Both callers must reach the row lock before either takes it. The
        // rendezvous has to sit *before* the lock is issued, not after: the
        // loser blocks inside PostgreSQL until the winner commits, so a gate
        // that waits for its return would never open.
        const instrumentedTx = new Proxy(tx, {
          get(txTarget, txProperty, txReceiver) {
            if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
            return async (...args: Parameters<typeof tx.$queryRaw>) => {
              arrived += 1;
              if (arrived === 2) release();
              await bothRead;
              return (tx.$queryRaw as (...inner: unknown[]) => Promise<unknown>)(...args);
            };
          },
        });
        return operation(instrumentedTx);
      }, options as any);
    },
  }) as PrismaClient;
  try {
    const results = await Promise.all([fireAtTask(instrument(db), task, now), fireAtTask(instrument(otherDb), task, now)]);
    assert.deepEqual(results.sort(), [false, true]);
  } finally {
    await otherDb.$disconnect();
  }
  assert.deepEqual(await schedulerTick(db, now), { cronFired: 0, atFired: 0, quarantined: 0 });
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);
});

test("a cancelled Run still consumes its one-shot AT schedule", async () => {
  const { project, agent, repo } = await seedExecutor();
  const now = new Date();
  const task = await db.task.create({ data: {
    projectId: project.id,
    assigneeAgentId: agent.id,
    repoId: repo.id,
    name: "Cancelled one-shot",
    description: "work",
    scheduleKind: "AT",
    runAt: new Date(now.getTime() - 60_000),
  } });
  assert.equal((await schedulerTick(db, now)).atFired, 1);
  const run = await db.run.findFirstOrThrow({ where: { taskId: task.id } });
  await db.run.update({ where: { id: run.id }, data: { status: "CANCELLED", endedAt: now } });
  assert.deepEqual(await schedulerTick(db, new Date(now.getTime() + 1_000)), { cronFired: 0, atFired: 0, quarantined: 0 });
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);
});

test("a task with stored invalid cron can still be disabled without repairing cron", async () => {
  const { project } = await seedExecutor();
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Broken schedule", description: "retire me", assigneeType: "HUMAN",
    scheduleKind: "CRON", cron: "bad cron", runAt: new Date(),
  } });
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-scheduler-token";
  try {
    const response = await createApp(db).request(`/tasks/${task.id}`, {
      method: "PATCH", headers: { Authorization: "Bearer operator-scheduler-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 200);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, "DONE");
});

test("a concurrent cron repair survives stale quarantine and receives no failure activity", async () => {
  const { project } = await seedExecutor();
  const stale = await db.task.create({ data: {
    projectId: project.id, name: "Repair", description: "work", assigneeType: "HUMAN",
    scheduleKind: "CRON", cron: "bad cron", timezone: "UTC", runAt: new Date(Date.now() - 60_000),
  } });
  const repairDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let repaired!: () => void;
  const ready = new Promise<void>((resolve) => { repaired = resolve; });
  const repair = repairDb.$transaction(async (tx) => {
    await tx.task.update({ where: { id: stale.id }, data: { cron: "*/5 * * * *", runAt: new Date(Date.now() + 300_000) } });
    repaired();
    await hold;
  });
  await ready;
  const firing = fireCronTask(db, stale, new Date());
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await Promise.all([repair, firing]);
  await repairDb.$disconnect();
  const row = await db.task.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(row.cron, "*/5 * * * *");
  assert.notEqual(row.runAt, null);
  assert.equal(await db.taskActivity.count({ where: { taskId: stale.id } }), 0);
});

// --- batch 2.5: pause flag, provenance, and archive-vs-scheduler races -------

test("a paused definition does not fire across a due time, and resume moves runAt into the future", async () => {
  const { project, agent, repo } = await seedExecutor();
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Paused", description: "work",
    scheduleKind: "CRON", cron: "*/5 * * * *", timezone: "UTC", runAt: new Date("2026-08-15T11:00:00Z"),
    schedulePausedAt: new Date("2026-08-15T10:00:00Z"),
  } });
  const dueLater = new Date("2026-08-15T12:00:00Z");
  assert.deepEqual(await schedulerTick(db, dueLater), { cronFired: 0, atFired: 0, quarantined: 0 });
  assert.equal(await db.task.count({ where: { projectId: project.id } }), 1, "no copy exists");
  // Even a direct fire is refused: the claim, not the poll, is the guard.
  assert.equal(await fireCronTask(db, definition, dueLater), false);

  await db.task.update({ where: { id: definition.id }, data: {
    schedulePausedAt: null, runAt: new Date("2026-08-15T11:00:00Z"),
  } });
  const result = await schedulerTick(db, dueLater);
  assert.equal(result.cronFired, 1);
  const refreshed = await db.task.findUniqueOrThrow({ where: { id: definition.id } });
  assert.ok(refreshed.runAt!.getTime() > dueLater.getTime());
});

test("a fired copy is cron-sourced and linked, while the definition stays manual", async () => {
  const { project, agent, repo } = await seedExecutor();
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Nightly", description: "work",
    scheduleKind: "CRON", cron: "*/2 * * * *", timezone: "UTC", runAt: new Date("2026-08-15T11:00:00Z"),
  } });
  assert.equal(await fireCronTask(db, definition, new Date("2026-08-15T12:05:00Z")), true);
  const copy = await db.task.findFirstOrThrow({ where: { projectId: project.id, id: { not: definition.id } } });
  assert.equal(copy.source, "CRON");
  assert.equal(copy.recurringSourceTaskId, definition.id);
  const refreshed = await db.task.findUniqueOrThrow({ where: { id: definition.id } });
  assert.equal(refreshed.source, "MANUAL");
  assert.equal(refreshed.recurringSourceTaskId, null);
});

test("an archived recurring definition does not fire", async () => {
  const { project, agent, repo } = await seedExecutor();
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Archived cron", description: "work",
    scheduleKind: "CRON", cron: "*/5 * * * *", runAt: new Date("2026-08-15T11:00:00Z"), archivedAt: new Date(),
  } });
  const now = new Date("2026-08-15T12:00:00Z");
  assert.equal((await schedulerTick(db, now)).cronFired, 0);
  assert.equal(await fireCronTask(db, definition, now), false);
  assert.equal(await db.task.count({ where: { projectId: project.id } }), 1);
});

test("archiving between the CRON poll and the claim wins the race", async () => {
  const { project, agent, repo } = await seedExecutor();
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Race cron", description: "work",
    scheduleKind: "CRON", cron: "*/5 * * * *", runAt: new Date("2026-08-15T11:00:00Z"),
  } });
  // `definition` is the stale poll row; archive lands after it was read.
  await db.task.update({ where: { id: definition.id }, data: { archivedAt: new Date() } });
  assert.equal(await fireCronTask(db, definition, new Date("2026-08-15T12:00:00Z")), false);
  assert.equal(await db.task.count({ where: { projectId: project.id } }), 1);
});

test("archiving between the AT poll and the fire wins the race", async () => {
  const { project, agent, repo } = await seedExecutor();
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Race at", description: "work",
    scheduleKind: "AT", runAt: new Date("2026-08-15T11:00:00Z"),
  } });
  await db.task.update({ where: { id: definition.id }, data: { archivedAt: new Date() } });
  // Without fireAtTask's lock and re-read this enqueues off the stale row.
  assert.equal(await fireAtTask(db, definition, new Date("2026-08-15T12:00:00Z")), false);
  assert.equal(await db.run.count({ where: { taskId: definition.id } }), 0);
});
