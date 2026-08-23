ALTER TABLE "Agent"
  ADD COLUMN "ordinarySubprocessModel" TEXT,
  ADD COLUMN "ordinarySubprocessCodexServiceTier" "CodexServiceTier",
  ADD COLUMN "elevatedSubprocessModel" TEXT,
  ADD COLUMN "elevatedSubprocessCodexServiceTier" "CodexServiceTier";

ALTER TABLE "Run"
  ADD COLUMN "elevatedSubprocessModel" TEXT,
  ADD COLUMN "elevatedSubprocessCodexServiceTier" "CodexServiceTier";

-- The original service-tier migration briefly made Luna Fast by default. Only
-- repair rows that still predate that migration's completion; a later Agent
-- update is an operator decision and remains authoritative.
UPDATE "Agent" AS agent
SET "codexServiceTier" = 'default'
FROM "_prisma_migrations" AS migration
WHERE migration."migration_name" = '20260823010000_codex_service_tier'
  AND migration."finished_at" IS NOT NULL
  AND agent."name" = 'senior-dev-luna'
  AND agent."archivedAt" IS NULL
  AND agent."codexServiceTier" = 'fast'
  AND agent."updatedAt" < migration."finished_at";

-- The executioner's two subprocess profiles live on the executioner itself.
-- This removes the hidden dependency on another Agent's setup page and makes
-- the values the operator sees the exact source snapshotted into a Run.
UPDATE "Agent"
SET "ordinarySubprocessModel" = 'gpt-5.6-luna:max',
    "ordinarySubprocessCodexServiceTier" = 'default',
    "elevatedSubprocessModel" = 'gpt-5.6-sol:high',
    "elevatedSubprocessCodexServiceTier" = 'default'
WHERE "name" = 'implementation-plan-executioner'
  AND "archivedAt" IS NULL;

ALTER TABLE "Agent"
  ADD CONSTRAINT "Agent_ordinary_subprocess_pair_check" CHECK (
    ("ordinarySubprocessModel" IS NULL) = ("ordinarySubprocessCodexServiceTier" IS NULL)
  ),
  ADD CONSTRAINT "Agent_elevated_subprocess_pair_check" CHECK (
    ("elevatedSubprocessModel" IS NULL) = ("elevatedSubprocessCodexServiceTier" IS NULL)
  );

ALTER TABLE "Run"
  ADD CONSTRAINT "Run_ordinary_subprocess_pair_check" CHECK (
    ("subprocessModel" IS NULL) = ("subprocessCodexServiceTier" IS NULL)
  ),
  ADD CONSTRAINT "Run_elevated_subprocess_pair_check" CHECK (
    ("elevatedSubprocessModel" IS NULL) = ("elevatedSubprocessCodexServiceTier" IS NULL)
  );
