-- Batch 1 — per-agent tool restrictions. Additive only: one column, NOT NULL with
-- an empty-array default, so every existing agent keeps today's behaviour (every
-- tool the CLI offers) with no backfill. `ADD COLUMN … DEFAULT` does not rewrite
-- Agent on PostgreSQL 11+.
--
-- The column stores the DENIED set, not the allowed one. Empty is the no-op, which
-- is what makes rollback lossless: reverting the code leaves the column unread.
ALTER TABLE "Agent" ADD COLUMN "disabledTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
