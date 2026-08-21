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

test("the chain-branch migration installs opensPullRequest on Task, TaskTemplateStep and Run, and pushedBranch on Run", async () => {
  // Asserted on `column_default`, not merely on existence: the default `true` is
  // what makes this migration behaviour-preserving — every task, template step
  // and already-queued run keeps opening its pull request exactly as before, and
  // a chain creator opts documentation steps *out*. A hand-written migration is
  // exactly where a default gets dropped without anything noticing.
  const flags = await db.$queryRaw<Array<{ table_name: string; is_nullable: string; column_default: string | null }>>`
    SELECT table_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = ${testDatabaseSchema}
      AND table_name IN ('Task', 'TaskTemplateStep', 'Run')
      AND column_name = 'opensPullRequest'
    ORDER BY table_name
  `;
  assert.deepEqual(flags, [
    { table_name: "Run", is_nullable: "NO", column_default: "true" },
    { table_name: "Task", is_nullable: "NO", column_default: "true" },
    { table_name: "TaskTemplateStep", is_nullable: "NO", column_default: "true" },
  ]);

  // Nullable on purpose: no run that completed before this batch counts as
  // evidence that a chain branch exists on a remote.
  const pushed = await db.$queryRaw<Array<{ is_nullable: string; data_type: string }>>`
    SELECT is_nullable, data_type FROM information_schema.columns
    WHERE table_schema = ${testDatabaseSchema} AND table_name = 'Run' AND column_name = 'pushedBranch'
  `;
  assert.deepEqual(pushed, [{ is_nullable: "YES", data_type: "text" }]);
});

test("the blind-review migration installs nullable base and commit columns", async () => {
  const columns = await db.$queryRaw<Array<{ table_name: string; column_name: string; is_nullable: string; data_type: string }>>`
    SELECT table_name, column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = ${testDatabaseSchema}
      AND (table_name, column_name) IN (
        ('TaskTemplateStep', 'baseFromStepIndex'),
        ('TaskStepOutput', 'commitSha')
      )
    ORDER BY table_name, column_name
  `;
  assert.deepEqual(columns, [
    { table_name: "TaskStepOutput", column_name: "commitSha", is_nullable: "YES", data_type: "text" },
    { table_name: "TaskTemplateStep", column_name: "baseFromStepIndex", is_nullable: "YES", data_type: "integer" },
  ]);
});

// ---------------------------------------------------------------------------
// Goal 5a0, plan Step 2.8 — catalog assertions for the idempotent execution
// kernel migration, plus the raw negative inserts Step 2's verification names.
//
// These read the catalog rather than the Prisma client on purpose: the point of
// the step is that the *database* refuses the corrupt shapes, so a test that
// went through the client would prove only that the client agrees.
// ---------------------------------------------------------------------------

const goalKernelSeed = async (client: PrismaClient): Promise<{
  projectId: string; goalId: string; agentId: string;
}> => {
  const projectId = "p-goal5a0";
  const goalId = "g-goal5a0";
  const agentId = "a-goal5a0";
  // One statement per call: Prisma sends raw SQL as a prepared statement, which
  // PostgreSQL refuses to multiplex.
  for (const statement of [
    `INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
     VALUES ('${projectId}', 'goal5a0', 'goal5a0', NOW())`,
    `INSERT INTO "Environment" ("id", "projectId", "name", "updatedAt")
     VALUES ('e-goal5a0', '${projectId}', 'env', NOW())`,
    `INSERT INTO "Agent" ("id", "projectId", "environmentId", "name", "title", "model",
                          "foundationalPrompt", "rolePrompt", "updatedAt")
     VALUES ('${agentId}', '${projectId}', 'e-goal5a0', 'agent', 'Agent', 'claude', '', '', NOW())`,
    `INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt")
     VALUES ('${goalId}', '${projectId}', 'Goal', 'spec', NOW())`,
  ]) await client.$executeRawUnsafe(statement);
  return { projectId, goalId, agentId };
};

const insertGoalTask = (
  id: string, projectId: string, goalId: string | null,
  generation: number | null, iteration: number | null,
  state: string | null, predecessor: string | null,
): string => `
  INSERT INTO "Task" ("id", "projectId", "name", "description", "updatedAt",
                      "goalId", "goalGeneration", "goalIteration",
                      "goalDispatchKey", "goalDispatchRequestHash", "goalDispatchState",
                      "goalPredecessorTaskId")
  VALUES ('${id}', '${projectId}', 'task', 'desc', NOW(),
          ${goalId === null ? "NULL" : `'${goalId}'`},
          ${generation ?? "NULL"}, ${iteration ?? "NULL"},
          ${goalId === null ? "NULL" : `'dispatch:${id}'`},
          ${goalId === null ? "NULL" : `'hash:${id}'`},
          ${state === null ? "NULL" : `'${state}'`},
          ${predecessor === null ? "NULL" : `'${predecessor}'`})`;

const insertGoalRun = (
  id: string, projectId: string, taskId: string | null, agentId: string,
  goalId: string | null, generation: number | null, iteration: number | null,
  runNumber: number, retryOf: string | null,
): string => `
  INSERT INTO "Run" ("id", "projectId", "taskId", "agentId", "goalId", "goalGeneration",
                     "goalIteration", "runNumber", "dedupeKey", "runner", "model",
                     "promptHash", "retryOfRunId", "updatedAt")
  VALUES ('${id}', '${projectId}', ${taskId === null ? "NULL" : `'${taskId}'`}, '${agentId}',
          ${goalId === null ? "NULL" : `'${goalId}'`}, ${generation ?? "NULL"}, ${iteration ?? "NULL"},
          ${runNumber}, 'dedupe:${id}', 'claude', 'claude', 'hash',
          ${retryOf === null ? "NULL" : `'${retryOf}'`}, NOW())`;

/**
 * Asserts the database refuses `sql`, and that its refusal is the named one.
 *
 * Prisma reports a raw-query failure as P2010 carrying PostgreSQL's own message,
 * which names the violated constraint for a check or a foreign key but reports a
 * unique-index violation only as its key detail. `expected` is therefore matched
 * against the message text, and the constraint's existence is asserted
 * separately from the catalog in the test above.
 */
const rejects = async (client: PrismaClient, sql: string, expected: string): Promise<void> => {
  let message = "<no error thrown>";
  try {
    await client.$executeRawUnsafe(sql);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(
    message.includes(expected),
    `expected the database to refuse with ${JSON.stringify(expected)} but got:\n${message}\nfor:\n${sql}`,
  );
};

test("goal 5a0 migration installs the exact enum labels, columns, checks, FKs, and indexes", async () => {
  const dispatchStates = await db.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'GoalDispatchState' AND n.nspname = ${testDatabaseSchema}
    ORDER BY e.enumsortorder
  `;
  assert.deepEqual(dispatchStates.map((row) => row.enumlabel), [
    "executing", "awaiting-decision", "advanced", "goal-completed",
    "goal-failed", "cancelled", "migrated-closed",
  ]);

  const goalStatuses = await db.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'GoalStatus' AND n.nspname = ${testDatabaseSchema}
    ORDER BY e.enumsortorder
  `;
  assert.deepEqual(goalStatuses.map((row) => row.enumlabel), [
    "active", "paused", "completed", "stopped-spend", "stopped-time",
    "stopped-stuck", "failed", "cancelled",
  ]);

  const goalColumns = await db.$queryRaw<Array<{ column_name: string; is_nullable: string; column_default: string | null }>>`
    SELECT column_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = ${testDatabaseSchema} AND table_name = 'Goal'
      AND column_name IN ('goalGeneration', 'nextGoalIteration')
    ORDER BY column_name
  `;
  assert.deepEqual(goalColumns, [
    { column_name: "goalGeneration", is_nullable: "NO", column_default: "1" },
    { column_name: "nextGoalIteration", is_nullable: "NO", column_default: "1" },
  ]);

  const taskColumns = await db.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
    SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_schema = ${testDatabaseSchema} AND table_name = 'Task'
      AND column_name LIKE 'goal%'
    ORDER BY column_name
  `;
  assert.deepEqual(taskColumns.map((row) => row.column_name), [
    "goalDecisionAt", "goalDecisionKey", "goalDecisionRequestHash", "goalDecisionRunId",
    "goalDispatchKey", "goalDispatchRequestHash", "goalDispatchState",
    "goalGeneration", "goalId", "goalIteration", "goalPredecessorTaskId",
  ]);
  assert.ok(taskColumns.every((row) => row.is_nullable === "YES"), "every Task lineage column stays nullable");

  const checks = await db.$queryRaw<Array<{ conname: string }>>`
    SELECT c.conname FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = ${testDatabaseSchema} AND c.contype = 'c'
      AND (c.conname LIKE '%goal%' OR c.conname LIKE 'GoalExecutionEvent%')
    ORDER BY c.conname
  `;
  assert.deepEqual(checks.map((row) => row.conname), [
    "GoalExecutionEvent_identity_shape_check",
    "Run_goal_lineage_all_or_none_check",
    "Run_goal_lineage_range_check",
    "Task_goal_decision_quartet_check",
    "Task_goal_dispatch_key_presence_check",
    "Task_goal_lineage_all_or_none_check",
    "Task_goal_lineage_range_check",
    "Task_goal_predecessor_shape_check",
    "Task_goal_runtime_shape_check",
  ]);

  const foreignKeys = await db.$queryRaw<Array<{ conname: string; confdeltype: string }>>`
    SELECT c.conname, c.confdeltype FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = ${testDatabaseSchema} AND c.contype = 'f'
      AND c.conname IN (
        'Task_goalId_projectId_fkey',
        'Task_goalDecisionRunId_fkey',
        'Task_goalPredecessorTaskId_fkey',
        'Task_goalPredecessorTaskId_goalId_goalGeneration_fkey',
        'Run_retryOfRunId_fkey',
        'Run_taskId_goalId_goalGeneration_goalIteration_fkey',
        'GoalExecutionEvent_goalId_fkey',
        'GoalExecutionEvent_taskId_fkey',
        'GoalExecutionEvent_runId_fkey',
        'GoalExecutionEvent_taskId_goalId_goalGeneration_goalIterat_fkey',
        'GoalExecutionEvent_runId_goalId_goalGeneration_goalIterati_fkey'
      )
    ORDER BY c.conname
  `;
  assert.equal(foreignKeys.length, 11, "all eleven Goal 5a0 foreign keys exist");
  // 'r' is NO ACTION/RESTRICT: no Goal-linked row may be deleted out from under
  // its lineage. Spec §6.3/§6.5 require RESTRICT on every one of them.
  assert.ok(foreignKeys.every((row) => row.confdeltype === "r"), "every Goal 5a0 FK restricts deletes");

  const partial = await db.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = ${testDatabaseSchema} AND indexname = 'Task_one_open_goal_dispatch_key'
  `;
  assert.equal(partial.length, 1);
  assert.match(partial[0]!.indexdef, /CREATE UNIQUE INDEX/);
  assert.match(partial[0]!.indexdef, /\("goalId"\)/);
  assert.match(
    partial[0]!.indexdef,
    /WHERE \(\("goalId" IS NOT NULL\) AND \("goalDispatchState" = ANY \(ARRAY\['executing'::"GoalDispatchState", 'awaiting-decision'::"GoalDispatchState"\]\)\)\)/,
  );

  // Plan Step 2.8 requires catalog assertions for the named unique indexes, not
  // only for the behaviour they produce: a negative insert proves *some* index
  // rejected the row, while this proves the exact named index on the exact
  // columns still exists.
  const uniqueIndexes = await db.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = ${testDatabaseSchema} AND tablename IN ('Task', 'Run')
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
      AND (indexname LIKE '%goal%' OR indexname LIKE '%retryOf%')
    ORDER BY indexname
  `;
  assert.deepEqual(uniqueIndexes.map((row) => row.indexname), [
    "Run_id_goalId_goalGeneration_goalIteration_key",
    "Run_retryOfRunId_key",
    "Task_goalId_goalDecisionKey_key",
    "Task_goalId_goalDispatchKey_key",
    "Task_goalId_goalGeneration_goalIteration_key",
    "Task_goalPredecessorTaskId_key",
    "Task_id_goalId_goalGeneration_goalIteration_key",
    "Task_id_goalId_goalGeneration_key",
    "Task_one_open_goal_dispatch_key",
  ]);
  const columnsOf = (name: string): string =>
    /\((?<columns>[^)]*)\)(?<predicate> WHERE .*)?$/u.exec(uniqueIndexes.find((row) => row.indexname === name)!.indexdef)!
      .groups!.columns!;
  assert.equal(columnsOf("Run_retryOfRunId_key"), '"retryOfRunId"');
  assert.equal(columnsOf("Run_id_goalId_goalGeneration_goalIteration_key"), 'id, "goalId", "goalGeneration", "goalIteration"');
  assert.equal(columnsOf("Task_goalPredecessorTaskId_key"), '"goalPredecessorTaskId"');
  assert.equal(columnsOf("Task_goalId_goalDispatchKey_key"), '"goalId", "goalDispatchKey"');
  assert.equal(columnsOf("Task_goalId_goalDecisionKey_key"), '"goalId", "goalDecisionKey"');
  assert.equal(columnsOf("Task_goalId_goalGeneration_goalIteration_key"), '"goalId", "goalGeneration", "goalIteration"');
  // PostgreSQL prints an all-lowercase identifier unquoted, so `id` carries no
  // quotes here while every camelCase column does.
  assert.equal(columnsOf("Task_id_goalId_goalGeneration_key"), 'id, "goalId", "goalGeneration"');
  assert.equal(columnsOf("Task_id_goalId_goalGeneration_goalIteration_key"), 'id, "goalId", "goalGeneration", "goalIteration"');

  const eventIndexes = await db.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = ${testDatabaseSchema} AND tablename = 'GoalExecutionEvent'
    ORDER BY indexname
  `;
  assert.deepEqual(eventIndexes.map((row) => row.indexname), [
    "GoalExecutionEvent_dedupeKey_key",
    "GoalExecutionEvent_goalId_createdAt_idx",
    "GoalExecutionEvent_goalId_goalGeneration_goalIteration_idx",
    "GoalExecutionEvent_pkey",
    "GoalExecutionEvent_runId_idx",
    "GoalExecutionEvent_taskId_idx",
  ]);

  // Step 2.6: pgcrypto must resolve in schema public, schema-qualified, so the
  // backfill hash cannot silently pick up an extension installed elsewhere.
  const digest = await db.$queryRaw<Array<{ hash: string }>>`
    SELECT encode(public.digest(('migration:' || 'task-1')::text, 'sha256'), 'hex') AS hash
  `;
  assert.equal(digest[0]!.hash, "ae09d8434c29001c3151708be633fe60ca2a9837de8f169d003e6539be35bb94");
});

test("goal 5a0 constraints reject every corrupt lineage shape and accept manual all-null rows", async () => {
  const { projectId, goalId, agentId } = await goalKernelSeed(db);

  // A valid iteration-1 Goal Task and its Run: the positive control.
  await db.$executeRawUnsafe(insertGoalTask("t-1", projectId, goalId, 1, 1, "executing", null));
  await db.$executeRawUnsafe(insertGoalRun("r-1", projectId, "t-1", agentId, goalId, 1, 1, 1, null));

  // A manual Task and Run with all-null lineage still insert. This is the
  // regression that matters most: the kernel must not make ordinary work illegal.
  await db.$executeRawUnsafe(insertGoalTask("t-manual", projectId, null, null, null, null, null));
  await db.$executeRawUnsafe(insertGoalRun("r-manual", projectId, "t-manual", agentId, null, null, null, 1, null));

  // Spec §6.3: at most one open dispatch per Goal — the partial unique index.
  await rejects(db, insertGoalTask("t-2", projectId, goalId, 1, 2, "awaiting-decision", "t-1"),
    'Key ("goalId")=(g-goal5a0) already exists');

  // §6.3.1: partially-null Task lineage.
  await rejects(db, insertGoalTask("t-partial", projectId, goalId, 1, null, "executing", null),
    "Task_goal_lineage_all_or_none_check");

  // §6.3.4: generation 0 is reserved for MIGRATED_CLOSED history.
  await rejects(db, insertGoalTask("t-gen0", projectId, goalId, 0, 1, "executing", null),
    "Task_goal_lineage_range_check");

  // §6.3.5: iteration > 1 requires a predecessor. It runs against a second Goal
  // with an open-state row so it isolates this check: on `goalId` the partial
  // single-flight index would fire first, and a terminal state would trip the
  // decision quartet first.
  await db.$executeRawUnsafe(`
    INSERT INTO "Goal" ("id", "projectId", "title", "spec", "updatedAt")
    VALUES ('g-other', '${projectId}', 'Other', 'spec', NOW())`);
  await rejects(db, insertGoalTask("t-nopred", projectId, "g-other", 1, 3, "executing", null),
    "Task_goal_predecessor_shape_check");

  // §6.3.3: a terminal dispatch state requires the whole decision quartet, which
  // the Goal-linked insert helper never supplies.
  await rejects(db, insertGoalTask("t-terminal", projectId, "g-other", 1, 1, "advanced", null),
    "Task_goal_decision_quartet_check");

  // §6.4: a Run tuple that disagrees with its Task is rejected by the composite
  // lineage FK, not merely by convention.
  await rejects(db, insertGoalRun("r-mismatch", projectId, "t-1", agentId, goalId, 1, 2, 2, null),
    "Run_taskId_goalId_goalGeneration_goalIteration_fkey");

  // §6.4: partially-null Run lineage.
  await rejects(db, insertGoalRun("r-partial", projectId, "t-1", agentId, goalId, 1, null, 3, null),
    "Run_goal_lineage_all_or_none_check");

  // §6.4: a Goal-linked Run must belong to a Task.
  await rejects(db, insertGoalRun("r-notask", projectId, null, agentId, goalId, 1, 1, 4, null),
    "Run_goal_lineage_all_or_none_check");

  // §6.4: one retry child per source Run.
  await db.$executeRawUnsafe(insertGoalRun("r-child", projectId, "t-1", agentId, goalId, 1, 1, 5, "r-1"));
  await rejects(db, insertGoalRun("r-child2", projectId, "t-1", agentId, goalId, 1, 1, 6, "r-1"),
    'Key ("retryOfRunId")=(r-1) already exists');

  // Step 2.7: a predecessor may not cross a Goal or a generation, even when the
  // named Task exists. The single-column FK above cannot see this; the composite
  // identity FK is what rejects it.
  await rejects(db, insertGoalTask("t-cross", projectId, "g-other", 1, 2, "executing", "t-1"),
    "Task_goalPredecessorTaskId_goalId_goalGeneration_fkey");

  // Step 2.7: an event identity that disagrees with the Task it names.
  await rejects(db, `
    INSERT INTO "GoalExecutionEvent" ("id", "goalId", "goalGeneration", "goalIteration",
                                      "taskId", "type", "dedupeKey")
    VALUES ('ev-cross', '${goalId}', 1, 2, 't-1', 'DISPATCH_CREATED', 'dedupe:ev-cross')`,
    "GoalExecutionEvent_taskId_goalId_goalGeneration_goalIterat_fkey");

  // Step 2.7: an event may not name a Run without the Task and iteration that
  // give the composite identity FK anything to check.
  await rejects(db, `
    INSERT INTO "GoalExecutionEvent" ("id", "goalId", "goalGeneration", "goalIteration",
                                      "runId", "type", "dedupeKey")
    VALUES ('ev-shape', '${goalId}', 1, NULL, 'r-1', 'RUN_RETRY_CREATED', 'dedupe:ev-shape')`,
    "GoalExecutionEvent_identity_shape_check");

  // A well-formed event still inserts.
  await db.$executeRawUnsafe(`
    INSERT INTO "GoalExecutionEvent" ("id", "goalId", "goalGeneration", "goalIteration",
                                      "taskId", "runId", "type", "dedupeKey")
    VALUES ('ev-ok', '${goalId}', 1, 1, 't-1', 'r-1', 'DISPATCH_CREATED', 'dedupe:ev-ok')`);
  assert.equal(await db.goalExecutionEvent.count(), 1);
});
