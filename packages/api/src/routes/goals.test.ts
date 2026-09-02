import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";
import { withTokens } from "./test-support.js";

const goalRow = (status: string) => ({
  id: "goal-1",
  projectId: "project-1",
  title: "Ship",
  spec: "Do it",
  dodApproved: false,
  status,
  spendCap: null,
  spendUsd: new Prisma.Decimal("1.25"),
  maxDurationMin: 240,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 3,
  stuckThreshold: 19,
  runnerPreference: "AUTO",
  sharedFolderPath: null,
  goalGeneration: 1,
  nextGoalIteration: 1,
  startedAt: null,
  endedAt: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  definitionOfDone: [],
  progressLog: [],
});

const listGoals = async (status: string): Promise<Response> => {
  const database = {
    goal: { findMany: async () => [goalRow(status)] },
  } as unknown as PrismaClient;
  return await createApp(database).request("/projects/project-1/goals", {
    headers: { Authorization: "Bearer operator-unit-token" },
  });
};

test("a Goal list answers with the console contract, Decimal columns as strings", async () => {
  await withTokens(async () => {
    const response = await listGoals("ACTIVE");
    assert.equal(response.status, 200);
    const [goal] = await response.json() as Array<Record<string, unknown>>;
    assert.equal(goal?.status, "ACTIVE");
    assert.equal(goal?.spendUsd, "1.25");
    assert.equal(goal?.spendCap, null);
  });
});

/* The console names three of the eight persisted GoalStatus values on purpose
 * (`wire-contract.ts`). A row carrying one of the other five means a writer
 * appeared without the console decision that goes with it: the route says so
 * instead of sending a status with no label, tone or legend behind it. */
test("a persisted Goal status the console does not name is refused, not sent", async () => {
  await withTokens(async () => {
    for (const status of ["STOPPED_SPEND", "STOPPED_TIME", "STOPPED_STUCK", "FAILED", "CANCELLED"]) {
      const response = await listGoals(status);
      assert.equal(response.status, 500, status);
    }
  });
});
