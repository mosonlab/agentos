import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, TaskStatus } from "@anneal/db";

import { schedulerTick } from "./scheduler.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const DAY_MS = 24 * 60 * 60 * 1_000;

const seedProject = (label: string) => db.project.create({
  data: { name: label, slug: `${label.toLowerCase().replaceAll(" ", "-")}-${Date.now()}` },
});

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

  await schedulerTick(db, now);

  assert.notEqual((await db.task.findUniqueOrThrow({ where: { id: oldTask.id } })).archivedAt, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: youngTask.id } })).archivedAt, null);
});

test("the scheduler leaves a DONE chain step while a sibling is non-terminal", async () => {
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

  await schedulerTick(db, now);

  assert.equal((await db.task.findUniqueOrThrow({ where: { id: doneStep.id } })).archivedAt, null);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: liveStep.id } })).archivedAt, null);
});
