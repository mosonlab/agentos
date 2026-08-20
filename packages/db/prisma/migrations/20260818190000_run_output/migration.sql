-- The raw tail of what a run produced, kept on the run that produced it —
-- succeeded or failed. The runner has always sent it on every completion; the
-- API kept it only when a successful run's task had a template, chain or
-- follow-up, so a failed run's account of itself was dropped by the process
-- that received it.
--
-- Purely additive and nullable: every existing row stays NULL, which is the
-- truthful answer for a run whose tail was never stored, and no read path
-- requires the column to be present.
ALTER TABLE "Run" ADD COLUMN "output" TEXT;
