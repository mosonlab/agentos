import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

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
  await Promise.all([fireAtTask(db, task, now), fireAtTask(db, task, now)]);
  await schedulerTick(db, now);
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 1);
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
