-- Change the default wall-clock budget for newly created execution records.
-- Existing rows keep their explicit values; this migration is intentionally
-- non-destructive and does not extend already-running sessions.
ALTER TABLE "Project" ALTER COLUMN "maxDurationMin" SET DEFAULT 240;
ALTER TABLE "Task" ALTER COLUMN "maxDurationMin" SET DEFAULT 240;
ALTER TABLE "Goal" ALTER COLUMN "maxDurationMin" SET DEFAULT 240;
ALTER TABLE "Run" ALTER COLUMN "maxDurationMin" SET DEFAULT 240;
ALTER TABLE "Session" ALTER COLUMN "maxDurationMin" SET DEFAULT 240;
