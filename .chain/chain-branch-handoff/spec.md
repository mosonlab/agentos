# Feature brief: chain branch handoff and salvage-before-destroy

Status: pending dispatch as a direct-engineer-workflow chain (template
cmt1n48zh001impg5cup0c1zw, repo agentos cmsv8gofe0005mpj2esyr3a0e), only
after the "Template chain retry branch" chain (c28b4c05, PR #22) has merged -
shared files in packages/db/src/workflow.ts and packages/api/src/app.ts.
Pass this brief verbatim as the instantiation `description`; suggested
branchName: `chain-branch-handoff`. Implementation hits structural risk
(runner/api component boundary, chain machinery) - patch step 1 assignee to
senior-dev-high before starting. Covers board cards cmt2druxs (chain branch
handoff bugs, minus the automatic-retry defect fixed by c28b4c05) and
cmt2p1p0o (salvage-before-destroy; folded in per Leo 2026-08-21 - same
salvage family). Queue ruling: this chain runs next; DAG Phase 2, control
gaps, sequencing follow.

Incidents 2026-08-21: (a) chain 7b459c83 - an operator-retried step run
adopted the WIP-salvage lineage and published to agentos/<taskId>/run-3, so
the declared chain branch never existed and the successor died at clone;
fixed by hand-PATCHing steps 2-6. (b) deploy-chain run cmt2lgs92 - after
event-ingestion poisoning starved its heartbeat (separate card cmt2omrr8),
delivery could not complete and the runner's cleanup deleted the workspace
repo with the branch never pushed: 64 minutes of implementation destroyed
with zero durable trace, and the loss was labeled transient-provider.

---

A chain survives retries, lost leases, and runner cleanup without losing
work or needing manual branch surgery: every run's work is durable before
its workspace can be destroyed, and every new run starts from where the
chain actually published.

Background: Publication evidence in this codebase is `Run.pushedBranch` and
nothing else. Two run-creating paths still lose the chain branch after the
automatic-retry fix: the operator retry route (packages/api/src/app.ts)
passes the prior run to `resolveRunBranches` (packages/db/src/workflow.ts)
and `inheritedBase` can adopt a WIP-salvage ref (`agentos/<taskId>/run-<n>`)
as the new run's published name; successor activation creates the
successor's first run with `prior = null`, so template chains resolve the
declared `targetBranch` verbatim and clone a ref that may exist nowhere. And
upstream of both, the runner's cleanup path (packages/runner: runner.ts
cleanup / workspace.ts cleanupWorkspace) deletes the workspace whether or
not the branch state was ever pushed - so any death between claim and
delivery erases the work that the resolver changes below would otherwise
recover.

Changes:
1. Operator retry of a chain step derives the new run's head from the
   chain's declared branch, never from salvage lineage; salvage refs remain
   eligible as the *base* when they hold the newest published work, but must
   not become the published head's name.
2. Successor activation resolves the successor's clone base from the chain's
   newest published ref - `pushedBranch` evidence scoped by chainId and
   repoId across sibling steps - falling back to the declared
   targetBranch/default branch only when no sibling published anything.
3. Both changes go through `resolveRunBranches` (single decision point per
   its own contract), not new per-call-site logic.
4. Salvage before destroy: the runner pushes the workspace's current branch
   state to the run's salvage ref (`agentos/<taskId>/run-<n>`) before any
   workspace deletion, on every terminal path including failed delivery and
   a dead lease - the push needs git credentials, not a live platform lease.
   Deletion proceeds only after the salvage push is confirmed durable (or
   there is verifiably nothing to push: no commits past the clone base and a
   clean tree, recorded as such). A salvage push that fails leaves the
   workspace in place with cleanup marked failed and the reason named.
5. The salvage ref pushed by change 4 is exactly the publication evidence
   changes 1-2 consume (`pushedBranch` recorded when the push lands, on
   whatever write path remains available; if no API write is possible the
   ref itself is still on the remote and the resolver's chain-scoped lookup
   finds it on the next run's activation).
6. A run reconciled as lost while its session is still resumable and its
   runner alive gets one resume attempt (the machinery waiting-inbox runs
   already use) before a from-scratch rerun; resume failure falls through to
   a fresh run, which now starts from the salvaged base. If bounded reuse of
   the existing resume path is not achievable inside this chain's scope,
   deliver changes 1-5 and record the resume gap explicitly in the PR and
   task output instead of forcing it.
7. A loss caused by lease expiry or reconciliation is classified as what it
   is (platform/lease loss), not transient-provider; the failure reason
   names the starved heartbeat or expired lease.

Out of scope: the automatic-retry path (fixed by c28b4c05 - rebase on it,
do not re-fix); the event-ingestion NUL-byte defect and heartbeat/flush
ordering (card cmt2omrr8, separate chain); chain-to-chain sequencing; run
cancel and operator controls; merge-tail machinery; periodic mid-run
checkpointing beyond terminal salvage; any change to how `pushedBranch` is
written by the normal delivery path.

Constraints: publication evidence is read exclusively from `Run.pushedBranch`
scoped by repo, per the existing resolver invariants, with the remote
salvage ref as its on-remote counterpart; no database migration; a chain
with no publications anywhere behaves exactly as today; cleanup never
reports success when the salvage push did not land; no silent fallback -
every degraded path names its reason.

Acceptance:
1. Automated test (incident a shape): a chain step with a failed run whose
   salvage push succeeded, when operator-retried, gets a run whose `branch`
   is the declared chain branch and whose base is the salvage ref; the
   retried run publishes the declared name.
2. Automated test: activating a successor whose predecessor published only
   under a salvage name yields a first run whose clone base is that
   published ref; with a predecessor that published the declared branch,
   behavior is unchanged; a chain with no publications resolves exactly as
   before.
3. Runner test (incident b shape): a run whose delivery fails after commits
   exist in the workspace pushes its salvage ref before cleanup and cleanup
   only then removes the workspace; with a dead lease the push still
   happens; with nothing to push, cleanup records that and proceeds; a
   failed salvage push leaves the workspace and marks cleanup failed.
4. Test: a reconciled-lost run with a resumable session gets one resume
   attempt before a fresh run is queued (or the recorded gap per change 6).
5. Test: reconciliation-declared losses carry the new failure class/reason,
   not transient-provider.
6. Existing api, db and runner suites green (scratch TEST_DATABASE_URL and
   RUNNER_WORKSPACE_ROOT per repository testing rules).
