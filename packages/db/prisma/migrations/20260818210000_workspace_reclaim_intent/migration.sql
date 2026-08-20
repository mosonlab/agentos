-- Workspace GC ownership moves to the runner (issue #115): the API publishes a
-- reclaim intent and the runner that owns the workspace root disposes of the
-- directory. Both columns are nullable and default NULL, so every existing row
-- starts with "no intent published", which is the safe state: nothing is
-- reclaimable until the control plane says so.
ALTER TABLE "Run" ADD COLUMN "workspaceReclaimAt" TIMESTAMP(3);
ALTER TABLE "Run" ADD COLUMN "workspaceReclaimedAt" TIMESTAMP(3);

-- Failed reclaim attempts. Non-null with a default so an existing row starts at
-- zero rather than at "unknown", and so a failure report has a column to
-- compare-and-set against without reopening a closed intent.
ALTER TABLE "Run" ADD COLUMN "workspaceReclaimAttempts" INTEGER NOT NULL DEFAULT 0;
