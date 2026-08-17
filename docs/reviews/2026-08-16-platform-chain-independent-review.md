## Must-fix

**Verdict: FAIL — 6 must-fix, 3 should-fix.** Reviewed exact head
`450e7de36c17699c3fa197102fe757b51c218a0b` against baseline `084704c`.
The requested ordered gates all exited 0 (`npm install`; Web build; `npm test`:
132 Web + 185 API + 5 Inbox + 31 Runner passed, with the pre-existing opt-in
race probe skipped; `npm run typecheck`). The additional acceptance gates also
passed on a workspace-unique scratch schema: `npm run test:db` passed 124/124,
including every webhook test, and `npm run db:drift-check` printed `No
difference detected.` Green gates do not cover the interleavings below.

1. **[must-fix; feasibility + coherence] The initial POST path can queue multiple
   steps of one chain concurrently onto the same new branch.** `taskInput`
   defaults every task to `scheduleKind = NOW`
   (`packages/api/src/app.ts:222-235`), and the route creates an inline run for
   every such agent task without checking `chainIndex` or an earlier unfinished
   step (`packages/api/src/app.ts:1702-1733`). The tests explicitly avoid that
   production path for steps 2+ by inserting them directly
   (`packages/api/src/chain-branch.dbtest.ts:121-134`), while the spec assumes
   chains are sequential (`docs/specs/platform-chain-branch-and-pr.md:631-634`)
   and the plan leaves the contradiction as G1
   (`docs/plans/platform-chain-branch-and-pr-plan.md:1466-1475`). **Reproduction:**
   two concurrent real `POST /projects/:id/tasks` calls with one `chainId`,
   indices 0 and 1, and otherwise default fields both returned 201; the database
   contained two `QUEUED` runs with the identical
   `agentos/chain/review-chain-…-46b364d0` head and `main` target. Both runners
   therefore clone `main` (`packages/runner/src/workspace.ts:65-70`); after each
   makes a different commit, the first push succeeds and the second push is
   rejected non-fast-forward (`packages/runner/src/delivery.ts:111-116`). This
   diff turns an API shape that previously delivered separate per-run branches
   into a reliably failing shared-head race. **Remedy:** make chain admission
   atomic: only the earliest runnable chain step may receive the inline run, and
   later steps must be created parked/no-run for `activateChainSuccessor` to
   queue. Alternatively reject `NOW` on a non-head chain step. Add a dbtest that
   creates the whole chain through the public API and asserts exactly one active
   run, rather than bypassing the route.

2. **[must-fix; feasibility] A runner crash after `git push` but before completion
   permanently loses the only publication evidence and wedges the retry.** The
   runner pushes first (`packages/runner/src/delivery.ts:111-116`) but reports
   `pushedBranch` only in the later completion request
   (`packages/runner/src/runner.ts:247-265`). `resolveRunBranches` trusts only a
   persisted `Run.pushedBranch` (`packages/db/src/workflow.ts:143-185`). If the
   process or host dies in that gap, lost-lease reconciliation creates run 2
   with the default/task target because it sees no evidence
   (`packages/api/src/reconcile.ts:137-197`). Run 2 clones that stale base and
   creates the already-existing shared name locally
   (`packages/runner/src/workspace.ts:65-70`); if run 1 published any commit, run
   2's later push is divergent and rejected. This is a concrete partial-delivery
   failure introduced by using a post-push completion payload as the sole source
   of truth; T11 covers “nothing published,” not “published remotely, ACK lost”
   (`packages/api/src/chain-branch.dbtest.ts:462-481`). **Remedy:** make
   provisioning/retry reconcile with the remote: when a chain run is told to
   base on the fallback but its shared head already exists, fetch and check out
   that remote head before work begins. An earlier publication-ACK endpoint can
   narrow the window but cannot eliminate the crash between the remote push and
   database write. Add a git-backed test for push-success/ACK-loss/lost-lease.

3. **[must-fix; feasibility + concurrency] PR discovery is not idempotent across
   the list/create race.** Delivery lists once, creates if empty, and sends every
   create exception directly to the failed result without another lookup
   (`packages/runner/src/delivery.ts:133-179`). **Reproduction:** a fake executor
   returned `[]` for the first list, made `gh pr create` throw “a pull request
   already exists for head,” and would have returned PR 7 on a second list. The
   implementation made only one list call and returned
   `pushStatus: FAILED`, `failureClass: TOOL_FAILED`, despite the branch and PR
   both existing. `runner.ts` then makes the run non-retryably failed
   (`packages/runner/src/runner.ts:247-250`), which stops chain advancement.
   This interleaving occurs when another runner or a human creates the PR after
   the lookup. **Remedy:** isolate `gh pr create` in its own try/catch and, on a
   create failure, re-run the open-PR lookup; if the expected head now has an
   open PR, return success with its URL/number. Preserve failure only when the
   confirming lookup is empty or itself unavailable, and add the race test.

4. **[must-fix; coherence + concurrency] `PATCH opensPullRequest` does not always
   affect the next run created, despite the API contract.** The binding contract
   says a task patch affects the next run, not an already queued run
   (`docs/specs/platform-chain-branch-and-pr.md:480-489`). A non-status PATCH is
   a plain unlocked update (`packages/api/src/app.ts:1803-1806,1849-1852,1901`).
   Automatic completion reads the task snapshot near transaction start
   (`packages/api/src/app.ts:2765-2771`) and later creates the retry from that
   stale `run.task.opensPullRequest` (`packages/api/src/app.ts:2836-2873`). Thus:
   completion reads `true`; an operator PATCH to `false` commits; completion
   inserts run 2 with `true`; run 2 opens a PR the operator explicitly disabled.
   Lost-lease requeue has the same read/create window
   (`packages/api/src/reconcile.ts:165-197`). T19 tests only a patch against an
   already queued run followed by a later operator retry, not either concurrent
   creator (`packages/api/src/chain-branch.dbtest.ts:583-605`). **Remedy:** join
   the Task-row exclusion protocol in automatic retry and reconciliation: lock
   the task row, then read the current flag and insert the run in that ordering.
   Add controlled interleaving dbtests for PATCH vs automatic retry and PATCH vs
   lost-lease requeue.

5. **[must-fix; feasibility + coherence] The documented physical rollback cannot
   execute after a successful migration.** The runbook tells the operator to
   drop the four columns and then run `prisma migrate resolve --rolled-back`
   (`docs/runbooks/platform-chain-branch-and-pr-rollback.md:70-98`). I reproduced
   those exact SQL drops against the isolated schema after all 13 migrations had
   applied successfully; the prescribed resolve command exited 1 with:
   `Error: P3012 — Migration 20260817020000_chain_branch_and_pr cannot be rolled
   back because it is not in a failed state.` Prisma's local schema engine names
   this condition `CannotRollBackSucceededMigration`; `--rolled-back` is recovery
   for a failed migration, not a down-migration mechanism. The promised
   “migrate deploy to prove the way back” therefore cannot happen. **Remedy:**
   keep code-only rollback as the supported procedure. If physical removal is
   truly required, ship a forward compensating migration that drops the columns
   and leave both successful history rows intact; document a later forward
   migration to restore them. Do not instruct operators to mark a successful
   migration rolled back.

6. **[must-fix; scope + coherence] The accepted template-step create surface is
   still missing.** The landed spec requires template-step create and patch
   routes to accept `opensPullRequest`, defaulting true
   (`docs/specs/platform-chain-branch-and-pr.md:480-493`). The branch adds only
   `PATCH /task-templates/:templateId/steps/:stepId`
   (`packages/api/src/app.ts:1292-1309`); the route inventory has no step-create
   endpoint. The revised plan acknowledges the omission and leaves it to Q3
   rather than resolving the accepted requirement
   (`docs/plans/platform-chain-branch-and-pr-plan.md:1526-1535`). Consequently a
   client cannot create a template step with this field through the API at all;
   DB/seed-only creation is not the promised API. **Remedy:** either obtain an
   explicit spec amendment before acceptance, or implement the create route
   with `opensPullRequest` default true plus full template ownership, in-project
   agent, archived-agent, repo-access, required-field and duplicate-index
   validation. The existing instantiation path correctly rejects archived step
   agents (`packages/api/src/templates.ts:48-73`) and copies the flag
   (`packages/api/src/templates.ts:87-103`); preserve those checks.

## Should-fix

1. **[should-fix; feasibility] Q4 is real test-infrastructure collision risk, and
   this diff lengthens the collision window.** With no environment override,
   every workspace uses `agentos_test` (`packages/api/src/testdb.ts:6-10`) and
   each dbtest process drops/recreates it (`packages/api/src/testdb.ts:31-46`).
   `--test-concurrency=1` only serializes files within one process
   (`packages/api/package.json:11-12`). The new suite took 224 seconds in the
   isolated rerun, so another workspace using the default can still drop tables
   under the webhook tests. The reported webhook flake did not reproduce on the
   unique schema (124/124 passed), and none of the changed webhook code indicates
   a functional regression. **Remedy:** refuse an unset `TEST_DATABASE_URL` or
   derive a workspace-unique schema in the harness; do not rely on every caller
   remembering the override.

2. **[should-fix; coherence] G5 leaves custom chain bases and PR bases with
   different meanings.** The resolver deliberately permits the first chain run
   to base on `Task.targetBranch` (`packages/db/src/workflow.ts:183-197`), but PR
   creation always targets `claim.repo.defaultBranch`
   (`packages/runner/src/delivery.ts:147-153`). A chain based on `release/1.x`
   can therefore produce a PR against `main`, showing unrelated commits or
   targeting the wrong integration line. This behaviour predates the diff, but
   the new one-PR contract makes the unresolved mismatch operator-visible; the
   plan itself leaves G5 open (`docs/plans/platform-chain-branch-and-pr-plan.md:1490-1498`).
   **Remedy:** make an explicit product decision. If custom target branches are
   clone-only, say so in the API/spec/runbook. If they also select the PR base,
   snapshot a chain PR base separately (a later opener's `Run.targetBranch` is
   already the shared head and cannot recover the original base) and pass that
   value to `gh pr create`.

3. **[should-fix; feasibility] G7 still converts every post-push GitHub failure
   into a non-retryable task failure.** Outside the idempotency race in must-fix
   3, a rate limit or transient `gh pr list/create` outage after a successful
   push returns `FAILED` with a failure class
   (`packages/runner/src/delivery.ts:158-179`), and the runner makes it
   non-retryable (`packages/runner/src/runner.ts:247-250`). `pushedBranch` now
   prevents the next run from choosing the wrong base, but the failed step does
   not advance, so an operator still has to intervene even though the durable
   code delivery succeeded. This is not caused by the batch and is correctly
   identified as G7 (`docs/plans/platform-chain-branch-and-pr-plan.md:1505-1510`),
   but it is survivable rather than desirable. **Remedy:** model branch
   publication separately from PR delivery and make post-push PR failure a
   warning/retryable delivery state, while retaining the branch and manual
   instructions.

Verification notes, not additional findings: Q1 (Web checkbox) is explicitly
out of scope and the Web build passed; Q2 concerns an external operator script
and no in-repo change is warranted. Create/patch/retry/instantiate archived-agent
guards remain present (`packages/api/src/app.ts:1682-1695,1812-1827,1932-1937`;
`packages/api/src/templates.ts:64-73`) and their tests passed. Existing queued
and running rows receive behaviour-preserving defaults from the additive
migration (`packages/db/prisma/migrations/20260817020000_chain_branch_and_pr/migration.sql:22-30`);
the isolated migration and drift gates confirmed the upgrade shape. The scratch
schema used for DB tests and rollback reproduction was dropped afterward.
