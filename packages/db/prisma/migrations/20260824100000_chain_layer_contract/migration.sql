-- Chain-layer contract migration.
--
-- This is the contraction half of the staged expand. Every check below runs
-- before a column is made stricter or removed. Prisma applies migrations in one
-- transaction, so a refusal leaves the pre-contract schema and its rows intact.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Task"
    WHERE ("chainId" IS NULL AND ("chainIndex" IS NOT NULL OR "chainLayer" IS NOT NULL))
       OR ("chainId" IS NOT NULL AND ("chainIndex" IS NULL OR "chainLayer" IS NULL))
  ) THEN
    RAISE EXCEPTION 'chain-layer-contract: partial-chain-identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "TaskTemplateStep"
    WHERE "layer" IS NULL
  ) THEN
    RAISE EXCEPTION 'chain-layer-contract: missing-template-step-layer';
  END IF;

  -- Re-run the expand fence immediately before contraction. A follow-up is
  -- valid only when both rows belong to one project/chain and move forward in
  -- the stable chainIndex ordering. This check must precede every schema
  -- change in this migration so a refusal is byte-preserving.
  IF EXISTS (
    SELECT 1
    FROM "Task" AS source
    JOIN "Task" AS target ON target."id" = source."followUpTaskId"
    WHERE source."followUpTaskId" IS NOT NULL
      AND (
        source."projectId" IS DISTINCT FROM target."projectId"
        OR source."chainId" IS NULL
        OR target."chainId" IS NULL
        OR source."chainId" IS DISTINCT FROM target."chainId"
        OR source."chainIndex" IS NULL
        OR target."chainIndex" IS NULL
        OR source."chainIndex" >= target."chainIndex"
      )
  ) THEN
    RAISE EXCEPTION 'chain-layer-contract: inconsistent-follow-up-relationship';
  END IF;
END;
$$;

ALTER TABLE "TaskTemplateStep"
  ALTER COLUMN "layer" SET NOT NULL;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_chain_identity_all_or_none_check" CHECK (
    ("chainId" IS NULL AND "chainIndex" IS NULL AND "chainLayer" IS NULL)
    OR
    ("chainId" IS NOT NULL AND "chainIndex" IS NOT NULL AND "chainLayer" IS NOT NULL)
  );

-- The old Goal safety check mentioned the follow-up column. Reinstall its
-- equivalent shape before removing that column so the Goal invariant survives
-- the contraction without a dependency on a retired field.
ALTER TABLE "Task" DROP CONSTRAINT "Task_goal_runtime_shape_check";
ALTER TABLE "Task" ADD CONSTRAINT "Task_goal_runtime_shape_check" CHECK (
  "goalId" IS NULL
  OR "goalGeneration" = 0
  OR (
    "scheduleKind" = 'once-now' AND "assigneeType" = 'agent'
    AND "runAt" IS NULL AND "cron" IS NULL AND "timezone" IS NULL
    AND "schedulePausedAt" IS NULL AND "recurringSourceTaskId" IS NULL
    AND "chainId" IS NULL AND "chainIndex" IS NULL
    AND "templateId" IS NULL AND "templateStepId" IS NULL
    AND "approvalGate" = false
    AND "archivedAt" IS NULL
  )
);

ALTER TABLE "Task" DROP CONSTRAINT "Task_followUpTaskId_fkey";
DROP INDEX "Task_followUpTaskId_key";
ALTER TABLE "Task" DROP COLUMN "followUpTaskId";
