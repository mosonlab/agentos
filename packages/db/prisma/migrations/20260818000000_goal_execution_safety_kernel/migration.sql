-- Goal 5a0 idempotent execution kernel — one additive forward migration.
--
-- Plan: docs/plans/goal-5a0-idempotent-execution-kernel-plan.md, Step 2.
-- Spec: docs/specs/goal-5a0-single-flight-lineage-safety-kernel.md §6.1-§6.5.
--
-- Order: extension -> enum labels -> columns -> indexes/FKs -> named checks ->
-- backfill of unambiguous closed history. The backfill runs last on purpose, so
-- every row it writes is validated by the constraints installed above it.

-- Step 2.6: the backfill hash is computed by PostgreSQL, and PostgreSQL 16 has
-- no built-in sha256() on this baseline, so pgcrypto is explicit.
--
-- This migration is applied through `npm run db:migrate-goal-execution`, which
-- runs packages/db/prisma/preflight-goal-execution.ts first and refuses to
-- continue unless it exits 0. The preflight proves either that the extension
-- already exists in schema public, or that it is absent and the migration role
-- holds database CREATE plus CREATE on public — because CREATE EXTENSION IF NOT
-- EXISTS does *not* relocate a pgcrypto installed in another schema, and the
-- schema-qualified public.digest() call further down would then fail after the
-- schema changes had already been made.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- CreateEnum
CREATE TYPE "GoalDispatchState" AS ENUM ('executing', 'awaiting-decision', 'advanced', 'goal-completed', 'goal-failed', 'cancelled', 'migrated-closed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GoalStatus" ADD VALUE 'failed';
ALTER TYPE "GoalStatus" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "goalGeneration" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "nextGoalIteration" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "goalGeneration" INTEGER,
ADD COLUMN     "goalIteration" INTEGER,
ADD COLUMN     "retryOfRunId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "goalDecisionAt" TIMESTAMP(3),
ADD COLUMN     "goalDecisionKey" TEXT,
ADD COLUMN     "goalDecisionRequestHash" TEXT,
ADD COLUMN     "goalDecisionRunId" TEXT,
ADD COLUMN     "goalDispatchKey" TEXT,
ADD COLUMN     "goalDispatchRequestHash" TEXT,
ADD COLUMN     "goalDispatchState" "GoalDispatchState",
ADD COLUMN     "goalGeneration" INTEGER,
ADD COLUMN     "goalId" TEXT,
ADD COLUMN     "goalIteration" INTEGER,
ADD COLUMN     "goalPredecessorTaskId" TEXT;

-- CreateTable
CREATE TABLE "GoalExecutionEvent" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "goalGeneration" INTEGER NOT NULL,
    "goalIteration" INTEGER,
    "taskId" TEXT,
    "runId" TEXT,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoalExecutionEvent_dedupeKey_key" ON "GoalExecutionEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "GoalExecutionEvent_goalId_createdAt_idx" ON "GoalExecutionEvent"("goalId", "createdAt");

-- CreateIndex
CREATE INDEX "GoalExecutionEvent_goalId_goalGeneration_goalIteration_idx" ON "GoalExecutionEvent"("goalId", "goalGeneration", "goalIteration");

-- CreateIndex
CREATE INDEX "GoalExecutionEvent_taskId_idx" ON "GoalExecutionEvent"("taskId");

-- CreateIndex
CREATE INDEX "GoalExecutionEvent_runId_idx" ON "GoalExecutionEvent"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Run_retryOfRunId_key" ON "Run"("retryOfRunId");

-- CreateIndex
CREATE INDEX "Run_goalId_goalGeneration_goalIteration_idx" ON "Run"("goalId", "goalGeneration", "goalIteration");

-- CreateIndex
CREATE INDEX "Run_retryOfRunId_idx" ON "Run"("retryOfRunId");

-- CreateIndex
CREATE UNIQUE INDEX "Run_id_goalId_goalGeneration_goalIteration_key" ON "Run"("id", "goalId", "goalGeneration", "goalIteration");

-- CreateIndex
CREATE UNIQUE INDEX "Task_goalPredecessorTaskId_key" ON "Task"("goalPredecessorTaskId");

-- CreateIndex
CREATE INDEX "Task_goalId_goalDispatchState_idx" ON "Task"("goalId", "goalDispatchState");

-- CreateIndex
CREATE INDEX "Task_goalPredecessorTaskId_idx" ON "Task"("goalPredecessorTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_goalId_goalGeneration_goalIteration_key" ON "Task"("goalId", "goalGeneration", "goalIteration");

-- CreateIndex
CREATE UNIQUE INDEX "Task_goalId_goalDispatchKey_key" ON "Task"("goalId", "goalDispatchKey");

-- CreateIndex
CREATE UNIQUE INDEX "Task_goalId_goalDecisionKey_key" ON "Task"("goalId", "goalDecisionKey");

-- CreateIndex
CREATE UNIQUE INDEX "Task_id_goalId_goalGeneration_key" ON "Task"("id", "goalId", "goalGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "Task_id_goalId_goalGeneration_goalIteration_key" ON "Task"("id", "goalId", "goalGeneration", "goalIteration");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalId_projectId_fkey" FOREIGN KEY ("goalId", "projectId") REFERENCES "Goal"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalDecisionRunId_fkey" FOREIGN KEY ("goalDecisionRunId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalPredecessorTaskId_fkey" FOREIGN KEY ("goalPredecessorTaskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_goalPredecessorTaskId_goalId_goalGeneration_fkey" FOREIGN KEY ("goalPredecessorTaskId", "goalId", "goalGeneration") REFERENCES "Task"("id", "goalId", "goalGeneration") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_retryOfRunId_fkey" FOREIGN KEY ("retryOfRunId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_taskId_goalId_goalGeneration_goalIteration_fkey" FOREIGN KEY ("taskId", "goalId", "goalGeneration", "goalIteration") REFERENCES "Task"("id", "goalId", "goalGeneration", "goalIteration") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalExecutionEvent" ADD CONSTRAINT "GoalExecutionEvent_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalExecutionEvent" ADD CONSTRAINT "GoalExecutionEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalExecutionEvent" ADD CONSTRAINT "GoalExecutionEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalExecutionEvent" ADD CONSTRAINT "GoalExecutionEvent_taskId_goalId_goalGeneration_goalIterat_fkey" FOREIGN KEY ("taskId", "goalId", "goalGeneration", "goalIteration") REFERENCES "Task"("id", "goalId", "goalGeneration", "goalIteration") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalExecutionEvent" ADD CONSTRAINT "GoalExecutionEvent_runId_goalId_goalGeneration_goalIterati_fkey" FOREIGN KEY ("runId", "goalId", "goalGeneration", "goalIteration") REFERENCES "Run"("id", "goalId", "goalGeneration", "goalIteration") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Step 2.4 / 2.7: the constraints Prisma cannot express.
-- ---------------------------------------------------------------------------

-- Spec §6.3: the database-enforced single-flight index. At most one Task per
-- Goal may be open (executing or awaiting-decision) at a time. Prisma cannot
-- express a partial unique index, so it is raw SQL and is asserted by
-- packages/api/src/migration.dbtest.ts against pg_indexes.indexdef.
CREATE UNIQUE INDEX "Task_one_open_goal_dispatch_key"
ON "Task" ("goalId")
WHERE "goalId" IS NOT NULL
  AND "goalDispatchState" IN ('executing', 'awaiting-decision');

-- ---------------------------------------------------------------------------
-- Step 2.3: named checks. Spec §6.3 items 1-5 and §6.4.
-- ---------------------------------------------------------------------------

-- §6.3.1 — the Goal tuple and goalDispatchState are all null or all non-null.
-- This is what keeps a manual Task's lineage columns entirely absent rather than
-- partially filled.
ALTER TABLE "Task" ADD CONSTRAINT "Task_goal_lineage_all_or_none_check" CHECK (
  ("goalId" IS NULL AND "goalGeneration" IS NULL AND "goalIteration" IS NULL AND "goalDispatchState" IS NULL)
  OR ("goalId" IS NOT NULL AND "goalGeneration" IS NOT NULL AND "goalIteration" IS NOT NULL AND "goalDispatchState" IS NOT NULL)
);

-- §6.3.2 — dispatch key and hash are present exactly on Goal-linked Tasks.
ALTER TABLE "Task" ADD CONSTRAINT "Task_goal_dispatch_key_presence_check" CHECK (
  ("goalId" IS NULL AND "goalDispatchKey" IS NULL AND "goalDispatchRequestHash" IS NULL)
  OR ("goalId" IS NOT NULL AND "goalDispatchKey" IS NOT NULL AND "goalDispatchRequestHash" IS NOT NULL)
);

-- §6.3.3 — the decision quartet by dispatch state. Null while the iteration is
-- still open; all four present in a terminal runtime state; all four null for
-- MIGRATED_CLOSED generation-0 history, which never had a decision.
ALTER TABLE "Task" ADD CONSTRAINT "Task_goal_decision_quartet_check" CHECK (
  "goalDispatchState" IS NULL
  OR (
    "goalDispatchState" IN ('executing', 'awaiting-decision', 'migrated-closed')
    AND "goalDecisionKey" IS NULL AND "goalDecisionRequestHash" IS NULL
    AND "goalDecisionRunId" IS NULL AND "goalDecisionAt" IS NULL
  )
  OR (
    "goalDispatchState" IN ('advanced', 'goal-completed', 'goal-failed', 'cancelled')
    AND "goalDecisionKey" IS NOT NULL AND "goalDecisionRequestHash" IS NOT NULL
    AND "goalDecisionRunId" IS NOT NULL AND "goalDecisionAt" IS NOT NULL
  )
);

-- §6.3.4 — generation and iteration ranges, and the generation-0 restriction.
-- Generation 0 exists only as MIGRATED_CLOSED history; runtime services require
-- generation >= 1 and never create generation-0 rows.
ALTER TABLE "Task" ADD CONSTRAINT "Task_goal_lineage_range_check" CHECK (
  "goalGeneration" IS NULL
  OR (
    "goalGeneration" >= 0 AND "goalIteration" >= 1
    AND ("goalGeneration" > 0 OR "goalDispatchState" = 'migrated-closed')
  )
);

-- §6.3.5 — a predecessor is null at iteration 1 and non-null after it.
ALTER TABLE "Task" ADD CONSTRAINT "Task_goal_predecessor_shape_check" CHECK (
  "goalIteration" IS NULL
  OR ("goalIteration" = 1 AND "goalPredecessorTaskId" IS NULL)
  OR ("goalIteration" > 1 AND "goalPredecessorTaskId" IS NOT NULL)
);

-- Step 2.3, runtime shape. A runtime Goal Task is an ordinary NOW/AGENT Task and
-- nothing else: no schedule, no recurrence, no chain, no template, no follow-up,
-- no approval gate, and not archived. Generation-0 MIGRATED_CLOSED history is
-- exempt, because it was created before the kernel existed.
ALTER TABLE "Task" ADD CONSTRAINT "Task_goal_runtime_shape_check" CHECK (
  "goalId" IS NULL
  OR "goalGeneration" = 0
  OR (
    "scheduleKind" = 'once-now' AND "assigneeType" = 'agent'
    AND "runAt" IS NULL AND "cron" IS NULL AND "timezone" IS NULL
    AND "schedulePausedAt" IS NULL AND "recurringSourceTaskId" IS NULL
    AND "chainId" IS NULL AND "chainIndex" IS NULL
    AND "templateId" IS NULL AND "templateStepId" IS NULL
    AND "followUpTaskId" IS NULL
    AND "approvalGate" = false
    AND "archivedAt" IS NULL
  )
);

-- §6.4 — a Run's Goal tuple is all null or all non-null, and a Goal-linked Run
-- always belongs to a Task.
--
-- ADDED NOT VALID ON PURPOSE, AND VALIDATED AFTER THE BACKFILL. Spec §840-856
-- requires expand, then backfill the historical Task/Run tuples, then validate.
-- Added and validated here, this constraint fails on any pre-existing Run whose
-- `goalId` is non-null — the ordinary pre-kernel shape — because ADD COLUMN has
-- just given every such row a null `goalGeneration`/`goalIteration` and the
-- backfill that fills them has not run yet. NOT VALID skips only the scan of
-- existing rows; the constraint still governs every INSERT and UPDATE below it,
-- so the backfill's own writes are checked as they are made. The explicit
-- VALIDATE after the backfill is what turns any surviving half-filled Run into a
-- failed migration rather than silent corruption.
ALTER TABLE "Run" ADD CONSTRAINT "Run_goal_lineage_all_or_none_check" CHECK (
  ("goalId" IS NULL AND "goalGeneration" IS NULL AND "goalIteration" IS NULL)
  OR ("goalId" IS NOT NULL AND "goalGeneration" IS NOT NULL AND "goalIteration" IS NOT NULL AND "taskId" IS NOT NULL)
) NOT VALID;

ALTER TABLE "Run" ADD CONSTRAINT "Run_goal_lineage_range_check" CHECK (
  "goalGeneration" IS NULL OR ("goalGeneration" >= 0 AND "goalIteration" >= 1)
);

-- Step 2.7 — an event's optional Task/Run identity components are absent or
-- present together, so the composite identity FKs above can never be satisfied
-- vacuously by a partially null tuple.
ALTER TABLE "GoalExecutionEvent" ADD CONSTRAINT "GoalExecutionEvent_identity_shape_check" CHECK (
  "goalGeneration" >= 0
  AND ("goalIteration" IS NULL OR "goalIteration" >= 1)
  AND ("taskId" IS NULL OR "goalIteration" IS NOT NULL)
  AND ("runId" IS NULL OR ("taskId" IS NOT NULL AND "goalIteration" IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Step 2.5: backfill only unambiguous closed history.
--
-- Task carried no goalId before this migration, so a historical Task's Goal is
-- *inferred* from its Runs, and only when the inference is unambiguous:
--   * the Task has at least one Run;
--   * every one of its Runs carries the same non-null goalId;
--   * that Goal is in the Task's own project.
-- A Task with a mix of null and non-null Run.goalId, or with Runs naming
-- different Goals, is ambiguous and is left entirely alone — a null Run is never
-- filled from a sibling. packages/db/prisma/preflight-goal-execution.ts refuses
-- to let the migration run at all when any such row exists; this WHERE clause is
-- the second, independent guard.
--
-- Backfilled history is generation 0, 1-based iterations ordered by
-- (createdAt, id), state MIGRATED_CLOSED, no decision fields, no events, and no
-- open dispatch. Existing Goals keep goalGeneration 1 and nextGoalIteration 1,
-- which the ADD COLUMN defaults above already gave them.
-- ---------------------------------------------------------------------------

CREATE TEMPORARY TABLE "goal5a0_backfill_task" ON COMMIT DROP AS
WITH "unambiguous" AS (
  SELECT
    r."taskId"       AS "taskId",
    MIN(r."goalId")  AS "goalId"
  FROM "Run" r
  WHERE r."taskId" IS NOT NULL
  GROUP BY r."taskId"
  HAVING COUNT(*) FILTER (WHERE r."goalId" IS NULL) = 0
     AND COUNT(DISTINCT r."goalId") = 1
)
SELECT
  t."id"                                                  AS "taskId",
  u."goalId"                                              AS "goalId",
  ROW_NUMBER() OVER (PARTITION BY u."goalId" ORDER BY t."createdAt", t."id") AS "goalIteration",
  LAG(t."id") OVER (PARTITION BY u."goalId" ORDER BY t."createdAt", t."id")  AS "goalPredecessorTaskId"
FROM "unambiguous" u
JOIN "Task" t ON t."id" = u."taskId"
JOIN "Goal" g ON g."id" = u."goalId" AND g."projectId" = t."projectId";

-- The migration's own hash is computed in PostgreSQL with pgcrypto, schema-
-- qualified so a pgcrypto installed elsewhere on the search_path cannot be
-- picked up silently. sha256('migration:task-1') is
-- ae09d8434c29001c3151708be633fe60ca2a9837de8f169d003e6539be35bb94.
UPDATE "Task" t
SET "goalId"                  = b."goalId",
    "goalGeneration"          = 0,
    "goalIteration"           = b."goalIteration",
    "goalDispatchKey"         = 'migration:' || t."id",
    "goalDispatchRequestHash" = encode(public.digest(('migration:' || t."id")::text, 'sha256'), 'hex'),
    "goalDispatchState"       = 'migrated-closed',
    "goalPredecessorTaskId"   = b."goalPredecessorTaskId"
FROM "goal5a0_backfill_task" b
WHERE t."id" = b."taskId";

-- Copy the settled tuple down to every Run of a backfilled Task. Runs of a Task
-- that was not backfilled keep whatever they had, and the deferred VALIDATE
-- below is what turns any surviving half-filled Run into a failed migration
-- rather than silent corruption.
UPDATE "Run" r
SET "goalGeneration" = 0,
    "goalIteration"  = b."goalIteration"
FROM "goal5a0_backfill_task" b
WHERE r."taskId" = b."taskId";

-- The deferred validation from §6.4, run only now that the historical tuples
-- exist. Every Run that still carries a non-null `goalId` without its generation
-- and iteration is a Run the backfill deliberately refused to touch — a Task
-- with a mix of null and non-null `Run.goalId`, Runs naming different Goals, a
-- Goal-linked Run with no Task, or a Goal in a different project than its Task —
-- and each of those aborts the migration here with the schema and the data
-- unchanged, because everything above this line is inside the same transaction.
-- packages/db/prisma/preflight-goal-execution.ts refuses to let the migration
-- start when any of them exists; this is the backstop, not the contract.
ALTER TABLE "Run" VALIDATE CONSTRAINT "Run_goal_lineage_all_or_none_check";
