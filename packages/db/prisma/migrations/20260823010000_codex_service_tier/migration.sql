CREATE TYPE "CodexServiceTier" AS ENUM ('default', 'fast');

ALTER TABLE "Agent"
  ADD COLUMN "codexServiceTier" "CodexServiceTier" NOT NULL DEFAULT 'default';

ALTER TABLE "Run"
  ADD COLUMN "codexServiceTier" "CodexServiceTier" NOT NULL DEFAULT 'default',
  ADD COLUMN "subprocessModel" TEXT,
  ADD COLUMN "subprocessCodexServiceTier" "CodexServiceTier";

-- Luna Max is the one canonical profile whose operator-approved initial
-- setting is Fast. This is a one-time adoption only; prompt sync does not own
-- the field, so later changes made in Agent Setup remain authoritative.
UPDATE "Agent"
SET "codexServiceTier" = 'fast'
WHERE "name" = 'senior-dev-luna'
  AND "archivedAt" IS NULL
  AND "runnerPreference" = 'codex'
  AND "model" LIKE 'gpt-%';
