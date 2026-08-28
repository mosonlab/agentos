import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@anneal/db";

import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

/**
 * The Goal 5a0 invariant verifier, spec §14 and plan Step 3.2.
 *
 * Its reason to exist is the class of corruption a static constraint cannot
 * express: the composite foreign keys reject a predecessor in another Goal or
 * generation, but no foreign key can say
 * `predecessor.goalIteration = successor.goalIteration - 1`. The tests below
 * therefore corrupt exactly what the database still accepts.
 */

const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const runVerifier = (): { code: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync("npx", ["tsx", "prisma/verify-goal-execution.ts"], {
      cwd: dbDirectory,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
  }
};

const seedGoal = async (): Promise<void> => {
  for (const statement of [
    `INSERT INTO "Project" ("id", "name", "slug", "updatedAt") VALUES ('p-v', 'v', 'v', NOW())`,
    `INSERT INTO "Environment" ("id", "projectId", "name", "updatedAt") VALUES ('e-v', 'p-v', 'env', NOW())`,
    `INSERT INTO "Agent" ("id", "projectId", "environmentId", "name", "title", "model",
                          "foundationalPrompt", "rolePrompt", "updatedAt")
     VALUES ('a-v', 'p-v', 'e-v', 'agent', 'Agent', 'claude', '', '', NOW())`,
    `INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt") VALUES ('g-v', 'p-v', 'Goal', 'spec', NOW())`,
  ]) await db.$executeRawUnsafe(statement);
};

/**
 * Closed history, in the exact shape the backfill writes it: generation 0,
 * MIGRATED_CLOSED, no decision quartet. Any terminal runtime state would need a
 * decision Run, which is irrelevant to the invariants under test here.
 */
const insertClosedTask = async (id: string, iteration: number, predecessor: string | null): Promise<void> => {
  await db.$executeRawUnsafe(`
    INSERT INTO "Task" ("id", "projectId", "name", "description", "updatedAt",
                        "goalId", "goalGeneration", "goalIteration",
                        "goalDispatchKey", "goalDispatchRequestHash", "goalDispatchState",
                        "goalPredecessorTaskId")
    VALUES ('${id}', 'p-v', 'task', 'desc', NOW(), 'g-v', 0, ${iteration},
            'migration:${id}', 'hash:${id}', 'migrated-closed',
            ${predecessor === null ? "NULL" : `'${predecessor}'`})`);
};

test("a consistent Goal lineage passes every invariant", async () => {
  await seedGoal();
  await insertClosedTask("t-1", 1, null);
  await insertClosedTask("t-2", 2, "t-1");

  const result = runVerifier();
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /verify PASS/u);
  assert.match(result.stdout, /verify predecessor-discontinuity 0/u);
});

test("the verifier catches a same-generation predecessor at the wrong iteration", async () => {
  await seedGoal();
  await insertClosedTask("t-1", 1, null);
  await insertClosedTask("t-2", 2, "t-1");
  // Same Goal, same generation, a predecessor no other Task claims — so every
  // foreign key and the predecessor unique index are satisfied — and the chain
  // is still broken, because t-4 sits two iterations after the Task it names.
  await insertClosedTask("t-4", 4, "t-2");

  const result = runVerifier();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /STOP verify predecessor-discontinuity 1:.*t-4/su);
  assert.doesNotMatch(result.stdout, /verify PASS/u);
});

test("the verifier catches a Session whose identity disagrees with its Run", async () => {
  await seedGoal();
  await insertClosedTask("t-1", 1, null);
  await db.$executeRawUnsafe(`
    INSERT INTO "Run" ("id", "projectId", "taskId", "agentId", "goalId", "goalGeneration", "goalIteration",
                       "runNumber", "dedupeKey", "runner", "model", "promptHash", "updatedAt")
    VALUES ('r-1', 'p-v', 't-1', 'a-v', 'g-v', 0, 1, 1, 'dedupe:r-1', 'claude', 'claude', 'hash', NOW())`);
  // The Session carries the Run's project but not its Goal: no foreign key can
  // see the disagreement, and the backfill would have copied it forward.
  await db.$executeRawUnsafe(`
    INSERT INTO "Session" ("id", "runId", "projectId", "agentId", "taskId", "goalId", "runner")
    VALUES ('s-1', 'r-1', 'p-v', 'a-v', 't-1', NULL, 'claude')`);

  const result = runVerifier();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /STOP verify session-identity-mismatch 1:.*s-1/su);
});
