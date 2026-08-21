# Feature brief: autonomous merge tail

Status: pending dispatch as a direct-engineer-workflow chain (repo agentos).
Supersedes the 2026-08-21 "mechanical merge tail" draft: grilling with Leo
2026-08-21 round 2 ruled full automation (no human approval anywhere on the
merge path; the defense-list trigger substitutes a forced independent agent
review), conflict resolution by a new merge-resolver agent (Sol high, not
senior-dev-high), cloud-first gate slots, .chain stripped at merge, one
automatic fix attempt on FAIL. Auto-deploy is a separate brief
(BRIEF-auto-deploy-quiet-window-20260821.md); the two chains share no files
and may run concurrently. Implementation step hits structural risk (chain
advancement contract, template step set) - assign senior-dev-high. Suggested
branchName: `merge-tail-auto`.

---

A chain that passes its merge gate merges to main and closes itself with no
human action; a conflicting or gate-failing chain repairs itself once through
a dedicated agent before asking anyone.

Background: every merge today is three manual acts - run the gate on a
hand-built candidate, `gh pr merge`, answer the board's approval inbox. The
2026-08-21 session merged four PRs this way and hit every failure mode the
manual process invites: PR #24 carried a PASS recorded against a stale main
and needed a nine-file semantic resolution by hand; review artifacts under
`.chain/<branch>/` rode four merges into the public main; and the human
approval gates added hours of queue latency while adding no information the
gate did not already have. The machinery to close this exists in halves: the
compound template ends in 12-merge-execution (merge-integrator) consuming
produceMergeAuthorization, while the direct template ends at
06-human-pr-review and leaves the merge to the operator; gate-dispatch.sh
rations three whole-machine slots (local first when the worktree qualifies,
then two remote) and agent workspaces qualify for the local slot, so gates
land on the production machine exactly when it is busiest.

Changes:
1. Regression verification (direct step 05, compound step 09) refreshes the
   chain branch onto current main mechanically before verifying; the
   verification and its merge gate run against the refreshed head, and the
   recorded PASS binds that exact head SHA.
2. A refresh that cannot complete mechanically (conflict) creates one
   conflict-resolution task assigned to the merge-resolver agent instead of
   stopping for an operator. The resolver works the conflict on the chain
   branch; its completion reactivates the regression step, which refreshes
   and verifies again. A conflict the resolver cannot close, or a second
   conflict on the same head, escalates to the Inbox loudly.
3. A gate FAIL at the regression step creates one automatic fix task for the
   chain's fix-step agent, then re-runs regression; a second FAIL on the same
   chain escalates to the Inbox. Every automatic attempt (resolution, fix,
   re-gate) is recorded in task activity with the head SHAs involved.
4. The direct template's 06-human-pr-review is replaced by a mechanical
   merge-readiness step (no HUMAN assignee, no approvalGate): it emits the
   merge authorization itself when (a) head-bound gate PASS evidence matches
   the branch's current head and (b) no independent-review obligation is open.
   The compound template's 11-human-pr-review is replaced the same way. Stale
   or missing evidence keeps the chain at the regression step; it never
   reaches readiness.
5. Independent-review obligation, the only remaining pre-merge review, is
   created mechanically when either trigger fires: (a) the PR's diff against
   main touches a defense-list path - scripts/merge-gate.sh,
   scripts/gate-worker/**, packages/db/prisma/migrations/**,
   release-authority.* (including the public key), or the merge-tail
   machinery itself (the merge-readiness/merge-execution workflow code, the
   merge-resolver and merge-integrator role prompts, the direct/compound
   template step set); or (b) a conflict resolution modified existing lines
   in any test file (pure additions do not trigger). The obligation is a
   blind review task (review-coordinator, Sol medium) whose explicit approval
   clears it; its rejection routes to one resolver/fix attempt, then Inbox.
   The trigger evaluation is server-side and mechanical; no agent
   self-declaration is trusted as the only signal.
6. The direct template gains a terminal step 07-merge-execution
   (merge-integrator, mechanical), the same contract as compound step 12: it
   consumes the merge authorization, creates the pull request if absent,
   re-checks the head-bound PASS evidence against the branch head, and
   merges. Template count validation (template-sources.ts expects exactly six
   direct files) moves to seven in the same change.
7. Merge execution merges a tree with `.chain/` stripped: the merge commit's
   tree contains no `.chain/` entry, while the chain branch keeps its
   artifacts. The same change removes the `.chain/` directories already on
   main (one commit on this chain's own branch).
8. A new merge-resolver role (agents/roles/merge-resolver.md, Sol high,
   registered in seed and sync-canonical-prompts) owns conflict resolution.
   Its prompt encodes: read the merge state and both sides' intent from
   commits, PRs, and the briefs before touching a hunk; resolve every hunk
   preserving both intents, never inventing behavior and never aborting;
   where intents collide, pick the one matching the current main's stated
   goal and record the trade-off in the task output; run typecheck and the
   affected suites before finishing; work only in an isolated worktree, never
   the deployment checkout; list every existing test expectation it changed
   in the task output.
9. gate-dispatch.sh slot order reverses to remote-first: the two worker slots
   are tried before the local slot, and the local slot is used only while
   both remote slots are busy. Verdict semantics and exit codes are
   unchanged.

Out of scope: auto-deploy (separate brief); chain-to-chain sequencing; the
review steps' finding/adjudication semantics; parallel review fan-out (chain
DAG phase 2); retry-machinery defects (chain branch handoff brief); moving
`.chain/` spec authoring to platform outputs; GitHub branch protection or
status checks; retrofitting already-instantiated chains, which keep their
snapshot.

Constraints: no silent fallback anywhere in the tail - a refresh conflict
past its resolution budget, missing or stale evidence, an unmet review
obligation, or absent authorization stops the chain loudly with a named
reason; the defense-list evaluation must not be bypassable by the resolver or
fix agents (server-side, recomputed at readiness time); compound template
merge-execution behavior is preserved where not explicitly changed; every
automatic action leaves an auditable activity record.

Acceptance:
1. Template validation and seed pass with a seven-step direct template whose
   terminal step is merge-execution and a twelve-step compound template whose
   step 11 is the mechanical readiness step; both readiness steps carry no
   approvalGate and no HUMAN assignee (dbtest).
2. dbtest: on a branch stale relative to main, regression verifies a
   refreshed head with head-bound PASS evidence; a mechanical-conflict
   refresh creates exactly one merge-resolver task and re-runs regression on
   its completion; a second conflict escalates to the Inbox.
3. dbtest: gate FAIL creates one fix task and re-runs; a second FAIL
   escalates to the Inbox; the activity trail names both heads.
4. dbtest: readiness auto-authorizes a clean PR; a defense-list-touching diff
   and a resolution that modified existing test lines each create a review
   obligation that blocks authorization until approved.
5. dbtest: merge execution refuses stale evidence, and its merged tree
   contains no `.chain/` path while the chain branch still does; after this
   chain merges, `git ls-tree` of main's root shows no `.chain/`.
6. scripts test (test:gate-worker): dispatch tries remote slots before the
   local slot and takes local only when both remotes are busy.
7. Existing API dbtest and unit suites pass.
