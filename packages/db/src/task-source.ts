import { TaskSource, TriggerFireSource, type PrismaClient } from "@prisma/client";

export type BackfillTaskSourceResult = {
  sourceCron: number;
  sourceWebhook: number;
  recurringLinked: number;
  firesCreated: number;
};

type SchedulerActivityRow = { taskId: string; recurringTaskId: string };
type WebhookActivityRow = { taskId: string; chainId: string | null; templateId: string; firedAt: string };

/** The primary key a backfilled fire gets, derived from the pair that identifies
 *  it. Two purposes in one string: it makes concurrent backfills collide in the
 *  database instead of double-counting, and it is the durable marker the rollback
 *  runbook deletes on — live webhook fires keep their cuid and survive. */
export const BACKFILLED_FIRE_ID_PREFIX = "backfill:";

export const backfilledFireId = (templateId: string, firedAt: Date): string =>
  `${BACKFILLED_FIRE_ID_PREFIX}${templateId}:${firedAt.toISOString()}`;

/**
 * Attributes historical Tasks to the trigger that created them, and rebuilds the
 * webhook half of the fire ledger from the activity rows that were the only
 * record of a fire before this batch.
 *
 * Idempotent by construction, and idempotent *concurrently*: the source updates
 * only touch rows still at `manual`, and each fire is written under a
 * deterministic primary key with `skipDuplicates`, so two simultaneous
 * invocations produce one row rather than two. A second call reports all zeros.
 *
 * This is a script rather than migration SQL because the dbtest harness migrates
 * once against an empty schema — a backfill embedded in a migration would have
 * nothing to touch and could never be asserted.
 */
export const backfillTaskSource = async (db: PrismaClient): Promise<BackfillTaskSourceResult> => {
  // `fireCronTask` writes one activity row with the *same* metadata onto two
  // tasks: the recurring definition and the copy. Only the copy is CRON-sourced
  // — the definition stays MANUAL (a recurring task the operator created by
  // hand is still their task). The row whose own taskId is not the
  // recurringTaskId is the copy; without that predicate the definition would be
  // stamped `cron` with a self-referencing FK.
  const schedulerRows = await db.$queryRaw<SchedulerActivityRow[]>`
    SELECT DISTINCT "taskId", "metadata"->>'recurringTaskId' AS "recurringTaskId"
    FROM "TaskActivity"
    WHERE "actorType" = 'scheduler'
      AND "metadata"->>'recurringTaskId' IS NOT NULL
      AND "taskId" <> "metadata"->>'recurringTaskId'
  `;

  // A copy whose parent row was deleted keeps source='cron' with a null FK: the
  // column is SetNull, but writing an id that no longer exists fails the FK
  // outright, which would abort the whole backfill.
  const parentIds = [...new Set(schedulerRows.map((row) => row.recurringTaskId))];
  const livingParents = parentIds.length === 0 ? [] : await db.task.findMany({
    where: { id: { in: parentIds } },
    select: { id: true },
  });
  const living = new Set(livingParents.map((parent) => parent.id));

  let sourceCron = 0;
  let recurringLinked = 0;
  for (const row of schedulerRows) {
    const parent = living.has(row.recurringTaskId) ? row.recurringTaskId : null;
    const claimed = await db.task.updateMany({
      where: { id: row.taskId, source: TaskSource.MANUAL },
      data: { source: TaskSource.CRON, ...(parent ? { recurringSourceTaskId: parent } : {}) },
    });
    if (claimed.count === 1) {
      sourceCron += 1;
      if (parent) recurringLinked += 1;
    }
  }

  const webhookRows = await db.$queryRaw<WebhookActivityRow[]>`
    SELECT DISTINCT activity."taskId",
           task."chainId",
           activity."metadata"->>'webhookTemplateId' AS "templateId",
           activity."metadata"->>'firedAt' AS "firedAt"
    FROM "TaskActivity" activity
    JOIN "Task" task ON task."id" = activity."taskId"
    WHERE activity."actorType" = 'webhook'
      AND activity."metadata"->>'webhookTemplateId' IS NOT NULL
      AND activity."metadata"->>'firedAt' IS NOT NULL
  `;

  let sourceWebhook = 0;
  for (const taskId of new Set(webhookRows.map((row) => row.taskId))) {
    const claimed = await db.task.updateMany({
      where: { id: taskId, source: TaskSource.MANUAL },
      data: { source: TaskSource.WEBHOOK },
    });
    if (claimed.count === 1) sourceWebhook += 1;
  }

  // One ledger row per distinct (template, firedAt) pair: a nine-step chain
  // writes nine activity rows for one fire.
  const templateIds = [...new Set(webhookRows.map((row) => row.templateId))];
  const livingTemplates = templateIds.length === 0 ? [] : await db.taskTemplate.findMany({
    where: { id: { in: templateIds } },
    select: { id: true },
  });
  const templateExists = new Set(livingTemplates.map((template) => template.id));

  const fires = new Map<string, { templateId: string; chainId: string | null; createdAt: Date }>();
  for (const row of webhookRows) {
    if (!templateExists.has(row.templateId)) continue;
    const createdAt = new Date(row.firedAt);
    if (Number.isNaN(createdAt.getTime())) continue;
    const key = backfilledFireId(row.templateId, createdAt);
    if (!fires.has(key)) fires.set(key, { templateId: row.templateId, chainId: row.chainId, createdAt });
  }

  // A read-then-create pair is idempotent only *sequentially*: two operators
  // running the backfill at once both see no row and both create one. The
  // primary key is the lock — a deterministic id per (template, firedAt) plus
  // `skipDuplicates` makes the second writer a no-op inside the database, which
  // no amount of application-side checking can achieve. It also gives the
  // backfilled rows durable provenance, which is what lets the runbook undo
  // them without touching live webhook history.
  const created = await db.triggerFire.createMany({
    data: [...fires].map(([id, fire]) => ({
      id,
      templateId: fire.templateId,
      chainId: fire.chainId,
      source: TriggerFireSource.WEBHOOK,
      createdAt: fire.createdAt,
    })),
    skipDuplicates: true,
  });

  return { sourceCron, sourceWebhook, recurringLinked, firesCreated: created.count };
};
