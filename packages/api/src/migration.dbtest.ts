import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { PrismaClient } from "@agentos/db";

import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

test("batch 2 migration removes dead tables and installs columns, FKs, and poll index", async () => {
  const dead = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'agentos_test'
      AND table_name IN ('Trigger', 'Automation', 'InboxConnectionWindow')
  `;
  assert.deepEqual(dead, []);

  const columns = await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'agentos_test' AND table_name = 'TaskTemplate'
      AND column_name IN ('webhookSecretId', 'webhookRepoId', 'webhookPayloadMapping')
    ORDER BY column_name
  `;
  assert.deepEqual(columns.map((row) => row.column_name), ["webhookPayloadMapping", "webhookRepoId", "webhookSecretId"]);

  const constraints = await db.$queryRaw<Array<{ constraint_name: string }>>`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_schema = 'agentos_test' AND table_name = 'TaskTemplate'
      AND constraint_name IN ('TaskTemplate_webhookSecretId_fkey', 'TaskTemplate_webhookRepoId_fkey')
    ORDER BY constraint_name
  `;
  assert.equal(constraints.length, 2);
  const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'agentos_test'
      AND indexname = 'Task_scheduleKind_status_runAt_idx'
  `;
  assert.equal(indexes.length, 1);
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
