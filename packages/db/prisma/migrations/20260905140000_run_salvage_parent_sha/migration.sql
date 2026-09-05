-- The parent of a Run's WIP salvage commit.
--
-- A failed Run's salvage becomes the commit the next Run of the same task
-- starts on. Until now the successor was told the branch but never the shape
-- of that head, so an Apply-review-fixes step could not tell a salvage that
-- sits directly on the head it was told to fix from an unrelated one, and had
-- to stop and ask a human. Nullable and never backfilled: Runs that ended
-- before this release genuinely have no such evidence.
ALTER TABLE "Run" ADD COLUMN "salvageParentSha" TEXT;
