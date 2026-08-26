import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

type QueryEvent = { query: string; params: string; duration: number; target: string };

let db: PrismaClient;
let queryEvents: QueryEvent[];

before(async () => {
  // setupTestDb owns the one-time disposable-schema migration. The client used
  // by this file opts into Prisma query events so the cost rule is executable,
  // rather than inferred from the implementation.
  const bootstrap = setupTestDb();
  await bootstrap.$disconnect();
  db = new PrismaClient({
    datasources: { db: { url: testDatabaseUrl } },
    log: [{ emit: "event", level: "query" }],
  });
  queryEvents = [];
  // The default PrismaClient type has an empty event union even though this
  // instance opts into query events at runtime.
  const onQuery = db.$on as unknown as (
    event: "query", listener: (event: QueryEvent) => void,
  ) => void;
  onQuery.call(db, "query", (event) => queryEvents.push(event));
});

beforeEach(async () => {
  await resetTestDb(db);
  queryEvents = [];
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

/**
 * The board page query selects dispatchAfterTaskId, while the predecessor
 * lookup selects only id, name and status. That shape distinguishes the one
 * optional lookup from chain-progress and card queries without depending on
 * Prisma's parameter values.
 */
const predecessorLookupCount = (): number => queryEvents.filter((event) => (
  /"Task"\."id"\s+IN/u.test(event.query)
  && /"Task"\."name"/u.test(event.query)
  && /"Task"\."status"/u.test(event.query)
  && !/"Task"\."dispatchAfterTaskId"/u.test(event.query)
)).length;

test("GET /tasks?view=board computes blockedOn and performs no lookup for an unbound page", async () => {
  const project = await seedProject("board-unbound");
  const task = await seedTask(project.id, "Unbound task", { status: "TODO" });

  const response = await getBoard(project.id);
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ id: string; blockedOn: unknown }>;
  assert.deepEqual(body.find((card) => card.id === task.id)?.blockedOn, null);
  assert.equal(predecessorLookupCount(), 0, "an unbound page must not query predecessor tasks");
});

test("bound rows are resolved in one deduplicated predecessor lookup", async () => {
  const project = await seedProject("board-bound");
  const predecessorOne = await seedTask(project.id, "Build predecessor", {
    status: "DOING", chainId: "predecessor-one", chainIndex: 0, chainLayer: 0,
  });
  const predecessorTwo = await seedTask(project.id, "Review predecessor", {
    status: "REVIEW", chainId: "predecessor-two", chainIndex: 0, chainLayer: 0,
  });
  const first = await seedTask(project.id, "Waiting on build", {
    status: "TODO", chainId: "successor-one", chainIndex: 0, chainLayer: 0,
    dispatchAfterTaskId: predecessorOne.id,
  });
  const second = await seedTask(project.id, "Waiting on review", {
    status: "TODO", chainId: "successor-two", chainIndex: 0, chainLayer: 0,
    dispatchAfterTaskId: predecessorTwo.id,
  });
  const unbound = await seedTask(project.id, "Ready without binding", {
    status: "TODO", chainId: "unbound-chain", chainIndex: 0, chainLayer: 0,
  });

  const response = await getBoard(project.id);
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ id: string; blockedOn: { taskId: string; taskName: string } | null }>;
  assert.deepEqual(body.find((card) => card.id === first.id)?.blockedOn, {
    taskId: predecessorOne.id, taskName: predecessorOne.name,
  });
  assert.deepEqual(body.find((card) => card.id === second.id)?.blockedOn, {
    taskId: predecessorTwo.id, taskName: predecessorTwo.name,
  });
  assert.equal(body.find((card) => card.id === unbound.id)?.blockedOn, null);
  assert.equal(predecessorLookupCount(), 1, "all bound ids on a page must use one lookup");
});

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
