-- Batch 4 columns + two supporting indexes.
--
-- On a production-sized database the two indexes below are built OUT OF BAND with
-- CREATE INDEX CONCURRENTLY *before* this file is applied — see
-- docs/runbooks/batch-4-rollback.md. Prisma wraps each migration file in one
-- transaction and CONCURRENTLY cannot run inside a transaction, so it cannot live
-- here. `IF NOT EXISTS` is what makes this file a clean no-op for the index half on
-- a database where they already exist, keeps it complete for a fresh database, and
-- stops an index that survived a rollback from aborting the whole file on redeploy.
--
-- `IF NOT EXISTS` matches on NAME ONLY: an index with the right name and the wrong
-- definition is accepted silently. `npm run db:drift-check` is what catches that,
-- which is why it is both a gate and a runbook step.
--
-- Edited after this migration was applied to the local dev database only
-- (production has not applied it); the one-time _prisma_migrations re-record step
-- is in the runbook.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "cachedInputTokens" INTEGER,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "totalTokens" INTEGER;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Session_projectId_requestedAt_idx" ON "Session"("projectId", "requestedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SessionEvent_runId_seq_idx" ON "SessionEvent"("runId", "seq");
