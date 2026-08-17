import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { backfillTaskSource, backfilledFireId, PrismaClient } from "@agentos/db";

import { fireCronTask } from "./scheduler.js";
import { resetTestDb, setupTestDb, testDatabaseSchema, testDatabaseUrl } from "./testdb.js";

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

// --- batch 2.5: the source / recurring-link / fire-ledger backfill -----------
// Seeded through the real code paths wherever possible. A hand-written activity
// fixture is exactly how the first draft's predicate — which would have stamped
// the recurring *definition* as cron — survived unnoticed.

const seedExecutor = async (label: string) => {
  const project = await db.project.create({ data: { name: label, slug: `${label}-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo" } });
  return { project, agent, repo };
};

test("the backfill marks fired copies cron and leaves the recurring definition manual", async () => {
  const { project, agent, repo } = await seedExecutor("backfill");
  const now = new Date("2026-08-15T12:05:00Z");
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Recurring", description: "work",
    scheduleKind: "CRON", cron: "*/2 * * * *", timezone: "UTC", runAt: new Date("2026-08-15T11:00:00Z"),
  } });
  assert.equal(await fireCronTask(db, definition, now), true);
  const copy = await db.task.findFirstOrThrow({ where: { projectId: project.id, id: { not: definition.id } } });
  // The live path already stamps the copy; clear both rows so the backfill is
  // what is under test rather than the writer.
  await db.task.updateMany({
    where: { id: { in: [definition.id, copy.id] } },
    data: { source: "MANUAL", recurringSourceTaskId: null },
  });

  const result = await backfillTaskSource(db);
  assert.equal(result.sourceCron, 1);
  assert.equal(result.recurringLinked, 1);

  const backfilledCopy = await db.task.findUniqueOrThrow({ where: { id: copy.id } });
  assert.equal(backfilledCopy.source, "CRON");
  assert.equal(backfilledCopy.recurringSourceTaskId, definition.id);

  const backfilledDefinition = await db.task.findUniqueOrThrow({ where: { id: definition.id } });
  assert.equal(backfilledDefinition.source, "MANUAL");
  assert.equal(backfilledDefinition.recurringSourceTaskId, null);
});

test("the backfill keeps an orphaned copy cron with a null recurring link", async () => {
  const { project, agent, repo } = await seedExecutor("orphan");
  const definition = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Recurring", description: "work",
    scheduleKind: "CRON", cron: "*/2 * * * *", runAt: new Date("2026-08-15T11:00:00Z"),
  } });
  assert.equal(await fireCronTask(db, definition, new Date("2026-08-15T12:05:00Z")), true);
  const copy = await db.task.findFirstOrThrow({ where: { projectId: project.id, id: { not: definition.id } } });
  await db.task.update({ where: { id: copy.id }, data: { source: "MANUAL", recurringSourceTaskId: null } });
  await db.task.delete({ where: { id: definition.id } });

  const result = await backfillTaskSource(db);
  assert.equal(result.sourceCron, 1);
  assert.equal(result.recurringLinked, 0);
  const backfilled = await db.task.findUniqueOrThrow({ where: { id: copy.id } });
  assert.equal(backfilled.source, "CRON");
  assert.equal(backfilled.recurringSourceTaskId, null);
});

test("the backfill marks webhook tasks and rebuilds one ledger row per fire, idempotently", async () => {
  const { project } = await seedExecutor("webhook-backfill");
  const template = await db.taskTemplate.create({
    data: { projectId: project.id, name: "template", description: "t", variables: [] },
  });
  const chainId = "chain-webhook-backfill";
  const firedAt = "2026-08-15T09:00:00.000Z";
  const steps = await Promise.all([0, 1, 2].map((index) => db.task.create({ data: {
    projectId: project.id, name: `Step ${index}`, description: "s", chainId, chainIndex: index,
  } })));
  await db.taskActivity.createMany({ data: steps.map((task) => ({
    taskId: task.id,
    actorType: "webhook",
    body: "Template instantiated",
    metadata: { chainId, templateId: template.id, webhookTemplateId: template.id, firedAt },
  })) });
  const manual = await db.task.create({ data: { projectId: project.id, name: "Hand made", description: "h" } });

  const first = await backfillTaskSource(db);
  assert.equal(first.sourceWebhook, 3);
  assert.equal(first.firesCreated, 1);
  for (const task of steps) {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).source, "WEBHOOK");
  }
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: manual.id } })).source, "MANUAL");
  const fire = await db.triggerFire.findFirstOrThrow({ where: { templateId: template.id } });
  assert.equal(fire.source, "WEBHOOK");
  assert.equal(fire.chainId, chainId);
  assert.equal(fire.createdAt.toISOString(), firedAt);

  const second = await backfillTaskSource(db);
  assert.deepEqual(second, { sourceCron: 0, sourceWebhook: 0, recurringLinked: 0, firesCreated: 0 });
  assert.equal(await db.triggerFire.count(), 1);
});

test("the backfill skips fires whose template is gone", async () => {
  const { project } = await seedExecutor("dead-template");
  const task = await db.task.create({ data: { projectId: project.id, name: "Orphan fire", description: "o" } });
  await db.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "webhook",
    body: "Template instantiated",
    metadata: { webhookTemplateId: "template-that-never-existed", firedAt: "2026-08-15T09:00:00.000Z" },
  } });
  const result = await backfillTaskSource(db);
  assert.equal(result.sourceWebhook, 1);
  assert.equal(result.firesCreated, 0);
  assert.equal(await db.triggerFire.count(), 0);
});

test("two backfills running at once produce one ledger row, not two (SOL-REVIEW S1)", async () => {
  // Sequential re-runnability is not concurrency-idempotency: an unlocked
  // findFirst followed by a create lets two operators both observe "no row" and
  // both create one, doubling the fire counts. The deterministic primary key is
  // the lock — the second writer collides inside the database and skips.
  const { project } = await seedExecutor("concurrent-backfill");
  const template = await db.taskTemplate.create({
    data: { projectId: project.id, name: "template", description: "t", variables: [] },
  });
  const firedAt = "2026-08-15T11:00:00.000Z";
  const task = await db.task.create({ data: {
    projectId: project.id, name: "Step", description: "s", chainId: "chain-concurrent-backfill", chainIndex: 0,
  } });
  await db.taskActivity.create({ data: {
    taskId: task.id,
    actorType: "webhook",
    body: "Template instantiated",
    metadata: { templateId: template.id, webhookTemplateId: template.id, firedAt },
  } });

  const other = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  try {
    const results = await Promise.all([backfillTaskSource(db), backfillTaskSource(other)]);
    // Exactly one invocation may report the row as created.
    assert.equal(results.reduce((total, result) => total + result.firesCreated, 0), 1);
  } finally {
    await other.$disconnect();
  }
  assert.equal(await db.triggerFire.count({ where: { templateId: template.id } }), 1);

  // The id carries the provenance the rollback runbook deletes on, so undoing
  // the backfill cannot take live webhook history with it.
  const fire = await db.triggerFire.findFirstOrThrow({ where: { templateId: template.id } });
  assert.equal(fire.id, backfilledFireId(template.id, new Date(firedAt)));
  assert.match(fire.id, /^backfill:/);
});
