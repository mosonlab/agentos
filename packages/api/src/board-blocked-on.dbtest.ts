import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;

before(async () => {
  db = setupTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
});

after(async () => { await db.$disconnect(); });

const operatorToken = "board-blocked-on-operator";

const withOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = operatorToken;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
};

const seedProject = async (label: string) => {
  const project = await db.project.create({ data: { name: label, slug: `${label}-${Date.now()}` } });
  return project;
};

const seedTask = async (projectId: string, name: string, overrides: Record<string, unknown> = {}) => db.task.create({
  data: {
    projectId,
    name,
    description: name,
    ...overrides,
  },
});

const getBoard = async (projectId: string, database: PrismaClient = db, headers: Record<string, string> = {}) => withOperator(
  () => createApp(database).request(`/tasks?projectId=${projectId}&view=board`, {
    headers: { Authorization: `Bearer ${operatorToken}`, ...headers },
  }),
);

test("a real predecessor DONE transition clears blockedOn and changes the board ETag", async () => {
  const project = await seedProject("board-etag");
  const predecessor = await seedTask(project.id, "Deploy predecessor", {
    status: "DOING", chainId: "etag-predecessor", chainIndex: 0, chainLayer: 0,
  });
  const successor = await seedTask(project.id, "Deploy successor", {
    status: "TODO", chainId: "etag-successor", chainIndex: 0, chainLayer: 0,
    dispatchAfterTaskId: predecessor.id,
  });

  const initial = await getBoard(project.id);
  assert.equal(initial.status, 200);
  const initialTag = initial.headers.get("etag");
  assert.ok(initialTag);
  const initialBody = await initial.json() as Array<{ id: string; blockedOn: unknown }>;
  assert.deepEqual(initialBody.find((card) => card.id === successor.id)?.blockedOn, {
    taskId: predecessor.id, taskName: predecessor.name,
  });

  // This is the only state mutation between the two HTTP reads. The binding
  // remains in place; only the computed predecessor status changes.
  await db.task.update({ where: { id: predecessor.id }, data: { status: "DONE" } });

  const resolved = await getBoard(project.id, db, { "If-None-Match": initialTag });
  assert.equal(resolved.status, 200);
  assert.notEqual(resolved.headers.get("etag"), initialTag);
  const resolvedBody = await resolved.json() as Array<{ id: string; blockedOn: unknown }>;
  assert.deepEqual(resolvedBody.find((card) => card.id === successor.id)?.blockedOn, null);
});
