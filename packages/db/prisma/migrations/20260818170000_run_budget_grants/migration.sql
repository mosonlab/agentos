-- Attempts granted on top of the task's configured budget, kept apart from the
-- absolute ceiling in "maxRunsPerTask" so that lowering "maxSessionsPerTask"
-- takes effect while refunds already earned survive.
--
-- Existing rows default to 0. That understates the grants of a task whose
-- history contains refunds, so the only visible effect on live data is a
-- ceiling no higher than the configured budget until the next refund — the
-- conservative direction, and the one that cannot resurrect a budget an
-- operator has already lowered.
ALTER TABLE "Run" ADD COLUMN "budgetGrants" INTEGER NOT NULL DEFAULT 0;
