import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  enqueueTaskRun,
  isChainHeldError,
  PrismaClient,
  resumeChain,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { seedBasicChain } from "./chain-hold-resume-fixture.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const migrationSql = readFileSync(fileURLToPath(new URL(
  "../../db/prisma/migrations/20260902010000_chain_control_execution_barrier/migration.sql",
  import.meta.url,
)), "utf8");

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

test("the execution-boundary migration converts a legacy unstarted one-based hold to before-first", async () => {
  const chain = await seedBasicChain(db, {
    statuses: [TaskStatus.TODO, TaskStatus.TODO],
    layers: [1, 2],
    control: {
      state: ChainControlState.HELD,
      heldLayer: 1,
      heldExecutionLayer: 1,
      holdRequestId: "legacy-before-first-hold",
    },
  });
  assert.equal(await db.run.count({ where: { taskId: { in: chain.tasks.map((task) => task.id) } } }), 0);

  await db.$transaction(async (tx) => {
    // Recreate the schema and control shape immediately before the migration.
    // Keeping the replay transactional restores the fully migrated test schema
    // even when an assertion fails on the old SQL.
    await tx.$executeRawUnsafe('ALTER TABLE "ChainControl" DROP COLUMN "heldExecutionLayer"');
    await tx.$executeRawUnsafe(migrationSql);

    const migrated = await tx.chainControl.findUniqueOrThrow({ where: { id: chain.control!.id } });
    assert.equal(migrated.heldLayer, 0);
    assert.equal(migrated.heldExecutionLayer, null);

    await assert.rejects(
      enqueueTaskRun(tx, chain.first.id),
      (error: unknown) => isChainHeldError(error) && /held before its first layer/u.test(error.message),
    );

    const resumed = await resumeChain(tx, {
      projectId: chain.project.id,
      chainId: chain.chainId,
      taskId: chain.first.id,
      requestId: "resume-migrated-before-first-hold",
    }, new Date("2026-09-02T12:00:00.000Z"));
    if ("message" in resumed) assert.fail(resumed.message);
    assert.equal(resumed.nextTaskId, chain.first.id);
    assert.equal(resumed.control?.state, "released");
    assert.equal(await tx.run.count({ where: { taskId: chain.first.id, status: RunStatus.QUEUED } }), 1);
    assert.equal(await tx.run.count({ where: { taskId: chain.second.id } }), 0);
  });
});
