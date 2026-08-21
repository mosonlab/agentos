An automatic retry of a template chain step runs on the chain branch, so a
step that succeeds on retry publishes where its successor will clone.

Background: The automatic retry inside the run-completion transaction
(packages/api/src/app.ts, the "fifth run-creating path") routes only
non-template chain steps through `resolveRunBranches`; a template chain step's
retry is created with `branch: null`, and the runner's workspace provisioning
(packages/runner/src/workspace.ts) then falls back to
`agentos/<taskId>/run-<n>`. `resolveRunBranches` (packages/db/src/workflow.ts)
already handles template tasks correctly - `branch: prior?.branch ??
templateChainBranch(...)` - and the operator retry route already calls it with
the prior run, which is why a manual retry gets the right branch while the
automatic one does not. The comment on the automatic-retry path records this
asymmetry as deliberately preserved; the 2026-08-21 incident shows it strands
every template chain whose step fails once and then succeeds on automatic
retry.

Changes:
1. The automatic retry in the run-completion transaction resolves the new
   run's `branch` and `targetBranch` through `resolveRunBranches` for
   template chain steps as well, passing the failed run as the prior, so the
   retry keeps the chain branch as its head while base resolution still
   honors publication evidence (including the failed run's own WIP salvage
   recorded moments earlier in the same transaction).
2. Non-chain, non-template retries keep their current behavior; the change is
   scoped to tasks with a templateId and a chainId.

Out of scope: the codex "CLI exited with code 0" terminal-event flakiness that
triggered the retries (separate investigation); operator retry and start
routes (already correct); successor-activation validation of predecessor
publication; workspace.ts fallback naming; run cancel and tier-override
operator controls.

Constraints: the resolution must happen inside the same transaction that
records the completing run's publication evidence, as the existing
non-template reroute does; no database migration.

Acceptance:
1. Automated test: a template chain step whose run fails retryably gets an
   automatic retry whose `branch` is the chain branch (not null), and a
   subsequent successful publication lands on the chain branch name.
2. Automated test: a non-template chain step's automatic retry behavior is
   unchanged by the edit (existing suites covering the non-template reroute
   stay green).
3. Existing api suites are green (scratch TEST_DATABASE_URL per repository
   testing rules).
