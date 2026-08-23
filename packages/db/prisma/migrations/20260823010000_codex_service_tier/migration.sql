CREATE TYPE "CodexServiceTier" AS ENUM ('default', 'fast');

ALTER TABLE "Agent"
  ADD COLUMN "codexServiceTier" "CodexServiceTier" NOT NULL DEFAULT 'default';

ALTER TABLE "Run"
  ADD COLUMN "codexServiceTier" "CodexServiceTier" NOT NULL DEFAULT 'default',
  ADD COLUMN "subprocessModel" TEXT,
  ADD COLUMN "subprocessCodexServiceTier" "CodexServiceTier";
