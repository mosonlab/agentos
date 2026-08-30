import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { GoalStatus, Prisma, type PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";

const operatorRequest = async (path: string, init?: RequestInit): Promise<Response> => createApp(database).request(path, {
  ...init,
  headers: {
    Authorization: "Bearer goals-test-operator",
    "Content-Type": "application/json",
    ...init?.headers,
  },
});

let database: PrismaClient;

const withOperatorToken = async (callback: () => Promise<void>): Promise<void> => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "goals-test-operator";
  try {
    await callback();
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

test("Goal creation persists ordered DoD items and returns the frontend detail shape", async () => {
  await withOperatorToken(async () => {
    let createArguments: Record<string, unknown> | undefined;
    database = {
      goal: {
        create: async (arguments_: Record<string, unknown>) => {
          createArguments = arguments_;
          return {
            id: "goal-1", projectId: "project-1", title: "Ship", spec: "Do it", status: GoalStatus.PAUSED,
            definitionOfDone: [
              { id: "item-1", goalId: "goal-1", itemIndex: 0, text: "Tests pass", done: false },
              { id: "item-2", goalId: "goal-1", itemIndex: 1, text: "PR ready", done: false },
            ],
            progressLog: [],
          };
        },
      },
    } as unknown as PrismaClient;
    const response = await operatorRequest("/projects/project-1/goals", {
      method: "POST",
      body: JSON.stringify({ title: "Ship", spec: "Do it", definitionOfDone: [{ text: "Tests pass" }, { text: "PR ready" }] }),
    });
    assert.equal(response.status, 201);
    const created = await response.json() as { definitionOfDone: Array<{ itemIndex: number }> };
    assert.deepEqual(created.definitionOfDone.map((item) => item.itemIndex), [0, 1]);
    const data = createArguments?.data as { status?: string; maxDurationMin?: number; definitionOfDone: { create: Array<{ itemIndex: number }> } };
    assert.equal(data.status, undefined);
    assert.equal(data.maxDurationMin, 240);
    assert.deepEqual(data.definitionOfDone.create.map((item) => item.itemIndex), [0, 1]);
  });
});

test("approved Goals advance ACTIVE → COMPLETED and reopen when a DoD item is missed", async () => {
  await withOperatorToken(async () => {
    const goal = {
      id: "goal-1", projectId: "project-1", dodApproved: false, status: GoalStatus.PAUSED,
      startedAt: null as Date | null, endedAt: null as Date | null,
    };
    const items = [{ id: "item-1", goalId: goal.id, itemIndex: 0, text: "Tests pass", done: false }];
    const goalDelegate = {
      findUnique: async () => ({ ...goal, definitionOfDone: items.map((item) => ({ ...item })) }),
      findUniqueOrThrow: async () => ({ ...goal }),
      update: async ({ data }: { data: Partial<typeof goal> }) => {
        Object.assign(goal, data);
        return { ...goal, definitionOfDone: items.map((item) => ({ ...item })), progressLog: [] };
      },
    };
    const itemDelegate = {
      findFirst: async ({ where }: { where: { id: string; goalId: string } }) => items.find((item) => item.id === where.id && item.goalId === where.goalId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { done?: boolean } }) => {
        const item = items.find((candidate) => candidate.id === where.id)!;
        Object.assign(item, data);
        return { ...item };
      },
      findMany: async () => items.map(({ done }) => ({ done })),
    };
    const tx = { goal: goalDelegate, goalDefinitionItem: itemDelegate };
    database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;

    const approved = await operatorRequest("/goals/goal-1/approve-dod", { method: "POST" });
    assert.equal(approved.status, 200);
    assert.equal(goal.status, GoalStatus.ACTIVE);
    assert.equal(goal.dodApproved, true);
    assert.ok(goal.startedAt instanceof Date);

    const met = await operatorRequest("/goals/goal-1/definition-of-done/item-1", {
      method: "PATCH", body: JSON.stringify({ done: true }),
    });
    assert.equal(met.status, 200);
    assert.equal(goal.status, GoalStatus.COMPLETED);
    assert.ok(goal.endedAt instanceof Date);

    const missed = await operatorRequest("/goals/goal-1/definition-of-done/item-1", {
      method: "PATCH", body: JSON.stringify({ done: false }),
    });
    assert.equal(missed.status, 200);
    assert.equal(goal.status, GoalStatus.ACTIVE);
    assert.equal(goal.endedAt, null);
  });
});

test("Goal action routes keep canonical forms and remove project-scoped aliases", async () => {
  await withOperatorToken(async () => {
    const app = createApp({} as PrismaClient);
    const inventory = app.routes.map(({ method, path }) => `${method} ${path}`);
    const removed = [
      "POST /projects/:projectId/goals/:goalId/approve-dod",
      "POST /projects/:projectId/goals/:goalId/pause",
    ];
    const retained = [
      "POST /goals/:goalId/approve-dod",
      "POST /goals/:goalId/pause",
    ];
    assert.deepEqual(inventory.filter((route) => removed.includes(route)), []);
    for (const route of retained) assert.ok(inventory.includes(route), `${route} is not registered`);

    for (const [method, path] of removed.map((route) => route.split(" ") as [string, string])) {
      const response = await app.request(path, {
        method,
        headers: {
          Authorization: "Bearer goals-test-operator",
          "Content-Type": "application/json",
        },
      });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "Not found" });
    }
  });
});

test("a DoD write returns 503 after its Serializable retry budget is exhausted", async () => {
  await withOperatorToken(async () => {
    let attempts = 0;
    database = {
      $transaction: async () => {
        attempts += 1;
        throw new Prisma.PrismaClientKnownRequestError("Raw query failed", {
          code: "P2010",
          clientVersion: "test",
          meta: { code: "40001" },
        });
      },
    } as unknown as PrismaClient;

    const response = await operatorRequest("/goals/goal-1/definition-of-done", {
      method: "POST",
      body: JSON.stringify({ text: "Retry the whole transaction" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Transaction is busy; retry later" });
    assert.equal(attempts, 6);
  });
});
