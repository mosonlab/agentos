-- Two external failures (a killed process, a lost lease) used to exhaust a
-- three-run budget before the agent got a second real attempt.
ALTER TABLE "Task" ALTER COLUMN "maxSessionsPerTask" SET DEFAULT 5;
ALTER TABLE "Run" ALTER COLUMN "maxRunsPerTask" SET DEFAULT 5;
