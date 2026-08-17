-- Platform repair — one branch and one PR per chain. Additive only: three
-- defaulted NOT NULL booleans and one nullable text column. `ADD COLUMN …
-- DEFAULT true` is metadata-only on PostgreSQL 11+ and rewrites no table.
--
-- The boolean default is `true` on purpose and is what makes this migration
-- behaviour-preserving: every existing task, template step and queued run keeps
-- opening its pull request exactly as before, and a chain creator opts
-- documentation steps *out*. Defaulting to `false` would silently stop PRs for
-- every existing chain-shaped workflow, including runs already queued when the
-- migration lands.
--
-- "Run"."pushedBranch" records the ref a run actually pushed. It is NULL for
-- every pre-existing row, which is the conservative answer: no run that
-- completed before this batch counts as evidence that a chain branch exists, so
-- a chain spanning the restart falls back to its Task.targetBranch instead of
-- cloning a ref nothing in this database can vouch for. See the runbook — such
-- chains are finished by hand.
--
-- No backfill. Completed documentation steps are not rewritten: they are done,
-- and rewriting them would change what the audit trail says happened.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "opensPullRequest" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "TaskTemplateStep" ADD COLUMN     "opensPullRequest" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "opensPullRequest" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushedBranch" TEXT;
