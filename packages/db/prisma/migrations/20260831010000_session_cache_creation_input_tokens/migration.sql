-- Split cache reads from cache writes without rewriting retained history.
-- Existing rows stay NULL until the idempotent session-usage backfill derives
-- their pair from retained SessionEvent payloads. A nullable column with no
-- default is safe for the release tail and does not change existing totals.
ALTER TABLE "Session"
ADD COLUMN "cacheCreationInputTokens" INTEGER;
