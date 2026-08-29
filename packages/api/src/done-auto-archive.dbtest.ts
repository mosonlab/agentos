import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, TaskStatus } from "@anneal/db";

import { archiveDoneTasks, schedulerTick } from "./scheduler.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const DAY_MS = 24 * 60 * 60 * 1_000;

const seedProject = (label: string) => db.project.create({
  data: { name: label, slug: `${label.toLowerCase().replaceAll(" ", "-")}-${Date.now()}` },
});

const setDoneAt = async (taskIds: string[], doneAt: Date): Promise<void> => {
  await db.task.updateMany({ where: { id: { in: taskIds } }, data: { doneAt } });
};

test("the scheduler archives an old DONE task but leaves a younger DONE task on the board", async () => {
  const project = await seedProject("Done auto archive age");
  const now = new Date("2026-08-29T12:00:00.000Z");
  const old = new Date(now.getTime() - 8 * DAY_MS);
  const young = new Date(now.getTime() - 1 * DAY_MS);
  const oldTask = await db.task.create({ data: {
    projectId: project.id,
    name: "Old done task",
    description: "old",
    status: TaskStatus.DONE,
    createdAt: old,
    updatedAt: old,
  } });
  const youngTask = await db.task.create({ data: {
    projectId: project.id,
    name: "Young done task",
    description: "young",
    status: TaskStatus.DONE,
    createdAt: young,
    updatedAt: young,
  } });
  await setDoneAt([oldTask.id], old);
  await setDoneAt([youngTask.id], young);

  await schedulerTick(db, now);

  assert.deepEqual((await db.task.findUniqueOrThrow({ where: { id: oldTask.id } })).archivedAt, now);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: youngTask.id } })).archivedAt, null);
});

test("a post-completion edit does not restart the archive age", async () => {
  const project = await seedProject("Done auto archive stable age");
  const now = new Date("2026-08-29T12:00:00.000Z");
  const old = new Date(now.getTime() - 8 * DAY_MS);
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: "Old completed task",
    description: "before edit",
    status: TaskStatus.DONE,
  } });
  await setDoneAt([task.id], old);

  await db.task.update({ where: { id: task.id }, data: { description: "edited after completion" } });
  const edited = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.deepEqual(edited.doneAt, old);
  assert.ok(edited.updatedAt > old);

  await schedulerTick(db, now);

  assert.deepEqual((await db.task.findUniqueOrThrow({ where: { id: task.id } })).archivedAt, now);
});

test("the completion clock resets across transitions out of and back into DONE", async () => {
  const project = await seedProject("Done auto archive transitions");
  const historical = new Date("2026-08-01T12:00:00.000Z");
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: "Transitioning task",
    description: "clock lifecycle",
    status: TaskStatus.TODO,
  } });

  const firstDone = await db.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE } });
  assert.notEqual(firstDone.doneAt, null);
  await setDoneAt([task.id], historical);

  const reopened = await db.task.update({ where: { id: task.id }, data: { status: TaskStatus.TODO } });
  assert.equal(reopened.doneAt, null);
  const completedAgain = await db.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE } });
  assert.ok(completedAgain.doneAt !== null && completedAgain.doneAt > historical);
});

test("the sweep excludes a DONE chain step before locking while a sibling is non-terminal", async () => {
  const project = await seedProject("Done auto archive chain");
  const now = new Date("2026-08-29T12:00:00.000Z");
  const old = new Date(now.getTime() - 8 * DAY_MS);
  const chainId = `done-auto-archive-${Date.now()}`;
  const doneStep = await db.task.create({ data: {
    projectId: project.id,
    name: "Finished chain step",
    description: "done",
    status: TaskStatus.DONE,
    chainId,
    chainIndex: 0,
    chainLayer: 1,
    createdAt: old,
    updatedAt: old,
  } });
  const liveStep = await db.task.create({ data: {
    projectId: project.id,
    name: "Live chain sibling",
    description: "not done",
    status: TaskStatus.TODO,
    chainId,
    chainIndex: 1,
    chainLayer: 2,
    createdAt: old,
    updatedAt: old,
  } });
  await setDoneAt([doneStep.id], old);

  assert.deepEqual(await archiveDoneTasks(db, now), { candidates: 0, archived: 0, notArchived: 0 });

  assert.equal((await db.task.findUniqueOrThrow({ where: { id: doneStep.id } })).archivedAt, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: liveStep.id } })).archivedAt, null);
});

test("the scheduler archives old members of a fully terminal chain", async () => {
  const project = await seedProject("Done auto archive terminal chain");
  const now = new Date("2026-08-29T12:00:00.000Z");
  const old = new Date(now.getTime() - 8 * DAY_MS);
  const chainId = `terminal-done-auto-archive-${Date.now()}`;
  const steps = await Promise.all([0, 1].map((chainIndex) => db.task.create({ data: {
    projectId: project.id,
    name: `Finished chain step ${String(chainIndex)}`,
    description: "done",
    status: TaskStatus.DONE,
    chainId,
    chainIndex,
    chainLayer: chainIndex + 1,
  } })));
  await setDoneAt(steps.map((step) => step.id), old);

  await schedulerTick(db, now);

  const archived = await db.task.findMany({
    where: { id: { in: steps.map((step) => step.id) } },
    select: { archivedAt: true },
  });
  assert.equal(archived.length, 2);
  assert.ok(archived.every((step) => step.archivedAt?.getTime() === now.getTime()));
});

test("the sweep processes a deterministic bounded candidate batch", async () => {
  const project = await seedProject("Done auto archive batch");
  const now = new Date("2026-08-29T12:00:00.000Z");
  const old = new Date(now.getTime() - 8 * DAY_MS);
  await db.task.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
    projectId: project.id,
    name: `Old standalone task ${String(index).padStart(3, "0")}`,
    description: "done",
    status: TaskStatus.DONE,
  })) });
  await db.task.updateMany({ where: { projectId: project.id }, data: { doneAt: old } });

  assert.deepEqual(await archiveDoneTasks(db, now), { candidates: 100, archived: 100, notArchived: 0 });
  assert.equal(await db.task.count({ where: { projectId: project.id, archivedAt: null } }), 1);
  assert.deepEqual(await archiveDoneTasks(db, now), { candidates: 1, archived: 1, notArchived: 0 });
});
