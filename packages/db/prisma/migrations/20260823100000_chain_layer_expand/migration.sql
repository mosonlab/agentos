-- Chain-layer expand migration.
--
-- The two guards deliberately run before either new column is added or any
-- backfill update is attempted. Prisma runs a migration in one transaction,
-- so a refusal leaves both the old rows and the schema unchanged.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Task"
    WHERE ("chainId" IS NULL AND "chainIndex" IS NOT NULL)
       OR ("chainId" IS NOT NULL AND "chainIndex" IS NULL)
  ) THEN
    RAISE EXCEPTION 'chain-layer-expand: partial-chain-identity';
  END IF;

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
    RAISE EXCEPTION 'chain-layer-expand: inconsistent-follow-up-relationship';
  END IF;
END;
$$;

-- Nullable is intentional. Existing writers are migrated in later slices;
-- slice 09 adds the non-null contract after those writers have changed.
ALTER TABLE "TaskTemplateStep" ADD COLUMN "layer" INTEGER;
ALTER TABLE "Task" ADD COLUMN "chainLayer" INTEGER;

-- Dense ranks preserve sequential execution for legacy templates even when a
-- hand-created template used sparse or zero-based step indexes.
WITH ranked AS (
  SELECT
    "id",
    DENSE_RANK() OVER (
      PARTITION BY "taskTemplateId"
      ORDER BY "stepIndex"
    )::integer AS layer
  FROM "TaskTemplateStep"
)
UPDATE "TaskTemplateStep" AS step
SET "layer" = ranked.layer
FROM ranked
WHERE step."id" = ranked."id";

-- Only complete chain identities receive a layer. Standalone tasks remain
-- all-null until the contract migration adds the all-or-none CHECK.
WITH ranked AS (
  SELECT
    "id",
    DENSE_RANK() OVER (
      PARTITION BY "projectId", "chainId"
      ORDER BY "chainIndex"
    )::integer AS chain_layer
  FROM "Task"
  WHERE "chainId" IS NOT NULL AND "chainIndex" IS NOT NULL
)
UPDATE "Task" AS task
SET "chainLayer" = ranked.chain_layer
FROM ranked
WHERE task."id" = ranked."id";
