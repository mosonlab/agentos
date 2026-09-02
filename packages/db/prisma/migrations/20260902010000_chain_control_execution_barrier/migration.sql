-- Keep the operator-facing heldLayer as a dense one-based ordinal while
-- retaining the stored execution layer needed by queue and claim barriers.
-- Legacy HELD controls recorded the next unfinished layer, not the highest
-- admitted layer. Recompute their execution boundary from the same durable
-- admission evidence as holdChain: a non-TODO status or any Run. RELEASED
-- controls are inert history, so their prior boundary can be preserved.
ALTER TABLE "ChainControl"
  ADD COLUMN "heldExecutionLayer" INTEGER;

UPDATE "ChainControl" AS control
SET "heldExecutionLayer" = CASE
  WHEN control."state" = 'held'::"ChainControlState" THEN (
    SELECT MAX(COALESCE(task."chainLayer", task."chainIndex"))
    FROM "Task" AS task
    WHERE task."projectId" = control."projectId"
      AND task."chainId" = control."chainId"
      AND (
        task."status" <> 'todo'::"TaskStatus"
        OR EXISTS (
          SELECT 1
          FROM "Run" AS run
          WHERE run."taskId" = task."id"
        )
      )
  )
  ELSE control."heldLayer"
END
WHERE control."heldLayer" IS NOT NULL;

-- Normalize pre-existing operator values to the same dense one-based ordinal
-- used by current Chain progress. The stored boundary above remains the queue
-- authority, including for sparse and zero-based Chains.
UPDATE "ChainControl" AS control
SET "heldLayer" = CASE
  WHEN control."state" = 'held'::"ChainControlState"
    AND control."heldExecutionLayer" IS NULL THEN 0
  ELSE (
    SELECT COUNT(DISTINCT COALESCE(task."chainLayer", task."chainIndex"))::INTEGER
    FROM "Task" AS task
    WHERE task."projectId" = control."projectId"
      AND task."chainId" = control."chainId"
      AND COALESCE(task."chainLayer", task."chainIndex") <= control."heldExecutionLayer"
  )
END
WHERE control."heldExecutionLayer" IS NOT NULL
  OR (control."state" = 'held'::"ChainControlState" AND control."heldLayer" IS NOT NULL);
