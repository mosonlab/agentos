-- Keep the operator-facing heldLayer as a dense one-based ordinal while
-- retaining the stored execution layer needed by queue and claim barriers.
-- Existing controls used the stored layer in heldLayer, so preserve it as the
-- execution boundary during the additive migration.
ALTER TABLE "ChainControl"
  ADD COLUMN "heldExecutionLayer" INTEGER;

UPDATE "ChainControl"
SET "heldExecutionLayer" = "heldLayer"
WHERE "heldLayer" IS NOT NULL;

-- Normalize pre-existing operator values to the same dense one-based ordinal
-- used by current Chain progress. The stored boundary above remains the queue
-- authority, including for sparse and zero-based Chains.
UPDATE "ChainControl" AS control
SET "heldLayer" = (
  SELECT COUNT(DISTINCT COALESCE(task."chainLayer", task."chainIndex"))::INTEGER
  FROM "Task" AS task
  WHERE task."projectId" = control."projectId"
    AND task."chainId" = control."chainId"
    AND COALESCE(task."chainLayer", task."chainIndex") <= control."heldExecutionLayer"
)
WHERE control."heldExecutionLayer" IS NOT NULL;
