-- Report-only worktree containment observation from runner completion.
--
-- The column is additive and nullable so existing and legacy-runner rows stay
-- truthful: NULL means no observation was reported. Compliant completions and
-- an explicitly empty report remain NULL; a non-empty JSON array stores the
-- absolute paths observed outside the Run workspace.
ALTER TABLE "Run" ADD COLUMN "worktreeContainmentViolations" JSONB;
