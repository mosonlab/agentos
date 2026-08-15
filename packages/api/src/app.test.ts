import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@agentos/db";

import { createApp } from "./app.js";

test("public root reports Phase 1 without touching Prisma", async () => {
  const response = await createApp({} as PrismaClient).request("/");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "AgentOS control plane", phase: 1 });
});

test("API routes reject requests without the shared bearer token", async () => {
  const previous = process.env.AGENTOS_API_TOKEN;
  process.env.AGENTOS_API_TOKEN = "unit-test-token";
  try {
    const response = await createApp({} as PrismaClient).request("/projects");
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) delete process.env.AGENTOS_API_TOKEN;
    else process.env.AGENTOS_API_TOKEN = previous;
  }
});

test("task status patch does not apply create defaults to other fields", async () => {
  const previous = process.env.AGENTOS_API_TOKEN;
  process.env.AGENTOS_API_TOKEN = "unit-test-token";
  let updateData: unknown;
  const database = {
    task: {
      findUniqueOrThrow: async () => ({ id: "task-1", projectId: "project-1", status: "REVIEW" }),
      update: async ({ data }: { data: unknown }) => { updateData = data; return { id: "task-1", status: "DONE" }; },
    },
    taskActivity: { create: async () => ({ id: "activity-1" }) },
  } as unknown as PrismaClient;
  try {
    const response = await createApp(database).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer unit-test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(updateData, { status: "DONE" });
  } finally {
    if (previous === undefined) delete process.env.AGENTOS_API_TOKEN;
    else process.env.AGENTOS_API_TOKEN = previous;
  }
});
