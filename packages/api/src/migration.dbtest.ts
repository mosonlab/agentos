import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { PrismaClient } from "@agentos/db";

import { resetTestDb, setupTestDb, testDatabaseSchema } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

test("batch 2 migration removes dead tables and installs columns, FKs, and poll index", async () => {
  const dead = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${testDatabaseSchema}
      AND table_name IN ('Trigger', 'Automation', 'InboxConnectionWindow')
  `;
  assert.deepEqual(dead, []);

  const columns = await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${testDatabaseSchema} AND table_name = 'TaskTemplate'
      AND column_name IN ('webhookSecretId', 'webhookRepoId', 'webhookPayloadMapping')
    ORDER BY column_name
  `;
  assert.deepEqual(columns.map((row) => row.column_name), ["webhookPayloadMapping", "webhookRepoId", "webhookSecretId"]);

  const constraints = await db.$queryRaw<Array<{ constraint_name: string }>>`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_schema = ${testDatabaseSchema} AND table_name = 'TaskTemplate'
      AND constraint_name IN ('TaskTemplate_webhookSecretId_fkey', 'TaskTemplate_webhookRepoId_fkey')
    ORDER BY constraint_name
  `;
  assert.equal(constraints.length, 2);
  const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE schemaname = ${testDatabaseSchema}
      AND indexname = 'Task_scheduleKind_status_runAt_idx'
  `;
  assert.equal(indexes.length, 1);
});

test("batch 2.5 migrations install the backlog status, the visibility columns, and the fire ledger", async () => {
  const statuses = await db.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT enumlabel FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
    WHERE pg_type.typname = 'TaskStatus' AND pg_namespace.nspname = ${testDatabaseSchema}
    ORDER BY enumsortorder
  `;
  assert.deepEqual(statuses.map((row) => row.enumlabel), ["backlog", "todo", "doing", "review", "done"]);

  const taskColumns = await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${testDatabaseSchema} AND table_name = 'Task'
      AND column_name IN ('source', 'archivedAt', 'schedulePausedAt', 'recurringSourceTaskId')
    ORDER BY column_name
  `;
  assert.deepEqual(
    taskColumns.map((row) => row.column_name),
    ["archivedAt", "recurringSourceTaskId", "schedulePausedAt", "source"],
  );

  const templateColumns = await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${testDatabaseSchema} AND table_name = 'TaskTemplate'
      AND column_name IN ('webhookPausedAt', 'webhookReplayWindowSec')
    ORDER BY column_name
  `;
  assert.deepEqual(templateColumns.map((row) => row.column_name), ["webhookPausedAt", "webhookReplayWindowSec"]);

  const ledger = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${testDatabaseSchema} AND table_name = 'TriggerFire'
  `;
  assert.equal(ledger.length, 1);

  const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE schemaname = ${testDatabaseSchema}
      AND indexname IN (
        'TriggerFire_templateId_createdAt_idx',
        'TriggerFire_templateId_dedupeKey_createdAt_idx',
        'Task_projectId_archivedAt_status_idx',
        'Task_recurringSourceTaskId_idx'
      )
    ORDER BY indexname
  `;
  assert.deepEqual(indexes.map((row) => row.indexname), [
    "Task_projectId_archivedAt_status_idx",
    "Task_recurringSourceTaskId_idx",
    "TriggerFire_templateId_createdAt_idx",
    "TriggerFire_templateId_dedupeKey_createdAt_idx",
  ]);
});

test("webhook foreign keys set a deleted secret null and restrict repo deletion", async () => {
  const project = await db.project.create({ data: { name: "Migration", slug: `migration-${Date.now()}` } });
  const secret = await db.secret.create({ data: { name: `secret-${Date.now()}`, encryptedValue: "x", purpose: "WEBHOOK" } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo" } });
  const template = await db.taskTemplate.create({
    data: { projectId: project.id, name: "template", description: "test", variables: [], webhookSecretId: secret.id, webhookRepoId: repo.id },
  });
  await db.secret.delete({ where: { id: secret.id } });
  assert.equal((await db.taskTemplate.findUniqueOrThrow({ where: { id: template.id } })).webhookSecretId, null);
  await assert.rejects(db.repo.delete({ where: { id: repo.id } }));
});
