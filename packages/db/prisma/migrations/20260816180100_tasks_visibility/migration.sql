-- Batch 2.5 — tasks visibility. Additive only: no drop, no NOT NULL without a
-- default, no table rewrite. `ADD COLUMN … DEFAULT 'manual'` does not rewrite
-- Task on PostgreSQL 11+.
--
-- The data backfill for `source` / `recurringSourceTaskId` / the fire ledger is
-- deliberately NOT here: the dbtest harness migrates once against an empty
-- schema, so an in-migration backfill can never be asserted. It ships as the
-- idempotent `db:backfill-task-source` script instead (see the runbook).

-- CreateEnum
CREATE TYPE "TaskSource" AS ENUM ('manual', 'cron', 'webhook');

-- CreateEnum
CREATE TYPE "TriggerFireSource" AS ENUM ('webhook', 'manual');

-- AlterTable
ALTER TABLE "TaskTemplate" ADD COLUMN     "webhookPausedAt" TIMESTAMP(3),
ADD COLUMN     "webhookReplayWindowSec" INTEGER;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "recurringSourceTaskId" TEXT,
ADD COLUMN     "schedulePausedAt" TIMESTAMP(3),
ADD COLUMN     "source" "TaskSource" NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "TriggerFire" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "chainId" TEXT,
    "source" "TriggerFireSource" NOT NULL,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriggerFire_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriggerFire_templateId_createdAt_idx" ON "TriggerFire"("templateId", "createdAt");

-- CreateIndex
CREATE INDEX "TriggerFire_templateId_dedupeKey_createdAt_idx" ON "TriggerFire"("templateId", "dedupeKey", "createdAt");

-- CreateIndex
CREATE INDEX "Task_projectId_archivedAt_status_idx" ON "Task"("projectId", "archivedAt", "status");

-- CreateIndex
CREATE INDEX "Task_recurringSourceTaskId_idx" ON "Task"("recurringSourceTaskId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_recurringSourceTaskId_fkey" FOREIGN KEY ("recurringSourceTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerFire" ADD CONSTRAINT "TriggerFire_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TaskTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
