import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@anneal/db";

import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

/** The read-only, deterministic lineage export of plan Step 3.3. */

const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "goal5a0-export."));

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); rmSync(scratch, { recursive: true, force: true }); });

const runExport = (outputPath: string): { code: number; stdout: string; stderr: string } => {
  try {
    const stdout = execFileSync("npx", ["tsx", "prisma/export-goal-lineage.ts", outputPath], {
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

const seed = async (): Promise<void> => {
  for (const statement of [
    `INSERT INTO "Project" ("id", "name", "slug", "updatedAt") VALUES ('p-x', 'x', 'x', NOW())`,
    `INSERT INTO "Environment" ("id", "projectId", "name", "updatedAt") VALUES ('e-x', 'p-x', 'env', NOW())`,
    `INSERT INTO "Agent" ("id", "projectId", "environmentId", "name", "title", "model",
                          "foundationalPrompt", "rolePrompt", "updatedAt")
     VALUES ('a-x', 'p-x', 'e-x', 'agent', 'Agent', 'claude', 'FOUNDATION SECRET', 'ROLE SECRET', NOW())`,
    `INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt")
     VALUES ('g-x', 'p-x', 'Goal', 'SPEC SECRET', NOW())`,
    `INSERT INTO "Task" ("id", "projectId", "name", "description", "updatedAt",
                         "goalId", "goalGeneration", "goalIteration",
                         "goalDispatchKey", "goalDispatchRequestHash", "goalDispatchState")
     VALUES ('t-x', 'p-x', 'task', 'DESCRIPTION SECRET', NOW(), 'g-x', 0, 1,
             'migration:t-x', 'hash:t-x', 'migrated-closed')`,
    `INSERT INTO "Run" ("id", "projectId", "taskId", "agentId", "goalId", "goalGeneration", "goalIteration",
                        "runNumber", "dedupeKey", "runner", "model", "promptHash", "updatedAt")
     VALUES ('r-x', 'p-x', 't-x', 'a-x', 'g-x', 0, 1, 1, 'dedupe:r-x', 'claude', 'claude', 'PROMPTHASH', NOW())`,
  ]) await db.$executeRawUnsafe(statement);
};

test("the export is deterministic, complete, and free of prompts and secrets", async () => {
  await seed();

  const first = join(scratch, "first.jsonl");
  const result = runExport(first);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /export goal 1/u);
  assert.match(result.stdout, /export task 1/u);
  assert.match(result.stdout, /export run 1/u);

  const body = readFileSync(first, "utf8");
  for (const forbidden of ["SPEC SECRET", "DESCRIPTION SECRET", "FOUNDATION SECRET", "ROLE SECRET", "PROMPTHASH"]) {
    assert.ok(!body.includes(forbidden), `the export must not carry ${forbidden}`);
  }
  const records = body.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((entry) => entry.section), ["goal", "task", "run"]);
  assert.equal(records[1].record.goalDispatchState, "migrated-closed", "the original enum value is preserved");

  // Deterministic: a second export of an unchanged database is byte-identical.
  const second = join(scratch, "second.jsonl");
  const repeat = runExport(second);
  assert.equal(repeat.code, 0);
  assert.equal(readFileSync(second, "utf8"), body);
  assert.match(repeat.stdout, /export checksum sha256:[0-9a-f]{64}/u);
});

test("the export refuses to overwrite and refuses a missing path", async () => {
  await seed();
  const occupied = join(scratch, "occupied.jsonl");
  writeFileSync(occupied, "prior archive\n");

  const refused = runExport(occupied);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refusing to overwrite/u);
  assert.equal(readFileSync(occupied, "utf8"), "prior archive\n");

  try {
    execFileSync("npx", ["tsx", "prisma/export-goal-lineage.ts"], {
      cwd: dbDirectory, env: { ...process.env, DATABASE_URL: testDatabaseUrl }, encoding: "utf8",
    });
    assert.fail("an export with no output path must stop");
  } catch (error) {
    assert.match(String((error as { stderr?: string }).stderr ?? ""), /explicit output path is required/u);
  }
});
