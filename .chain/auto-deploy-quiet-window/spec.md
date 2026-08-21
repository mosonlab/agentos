# Feature brief: quiet-window auto-deploy

Status: pending dispatch as a direct-engineer-workflow chain (repo agentos).
Split out of the autonomous merge tail
(BRIEF-direct-chain-merge-tail-20260821.md) per the 2026-08-21 grilling: Leo
ruled deploy is part of merge automation v1; the two chains share no files
and may run concurrently. Deliverable is deployment tooling on the
production machine, not platform workflow code. Implementation step: no
structural platform risk, but the target is the live deployment itself -
assign senior-dev-high. Suggested branchName: `auto-deploy-quiet-window`.

---

When main advances, the running deployment catches up by itself during the
next quiet window, and any step that cannot complete safely stops loudly
instead of leaving the services half-upgraded.

Background: the live AgentOS runs from the `dist/` of the
`agentos-public` checkout under launchd
(`com.agentos.{api,inbox,runner,runner-2..6,web}`). Today every merged PR
waits for an operator to hand-run the upgrade sequence; the 2026-08-21
session showed the sequence has real teeth: a stale Prisma client fails the
build until `prisma generate` runs first, the guarded migration refuses to
run without the GOAL5A0 authority SHAs from `release-authority.json`,
`db:sync-canonical-prompts` refuses structural template drift (that refusal
correctly caught `baseFromStepIndex` and required a deliberate manual
backfill), and restarts are only safe for runs parked in `waiting-inbox` -
runs in claimed/provisioning/running die with the process. Because merges
are becoming automatic (merge-tail brief), the deployed code will otherwise
drift behind main indefinitely.

Changes:
1. A deploy job on the production machine (script under scripts/deploy/ plus
   a launchd job definition and install doc) that notices main has advanced
   past the deployed revision and performs the upgrade unattended.
2. The job waits for a quiet window before touching anything: no Run in
   claimed, provisioning, or running status (lowercase enums, queried from
   the platform database). Runs in queued and waiting-inbox do not block -
   waiting-inbox runs hold no live process and survive restarts. If the
   window does not open, the job keeps waiting and periodically records that
   it is holding; it never restarts services over live runs.
3. The upgrade sequence inside the window, in order, stopping loudly on the
   first failure: fetch and fast-forward the checkout to origin/main (never
   merge, never reset past local state - a non-fast-forward condition or
   dirty working tree aborts with a named reason); `prisma generate`; build;
   `pg_dump -Fc` backup; the guarded migration with
   GOAL5A0_MASTER_SHA/GOAL5A0_CONTROL_PLANE_A_SHA read from the checkout's
   `release-authority.json`; `db:sync-canonical-prompts`; restart the
   launchd services.
4. A structural refusal from db:sync-canonical-prompts is terminal for the
   job, not a bypass: it stops before restarting services and escalates. The
   job never edits template rows by SQL.
5. Every outcome is observable: success and each named failure produce an
   operator-visible notification through the platform Inbox, including the
   revisions moved between; failures leave the previous build serving (build
   into a staging output and swap only on success, so a failed build never
   takes down the running dist/).
6. The job never runs concurrently with itself (lock), and a failed upgrade
   attempt is not retried automatically - it stays escalated until an
   operator clears it.

Out of scope: the merge automation itself (merge-tail brief); changing
migration or sync semantics in packages/db; restart-safety for
running/provisioning runs; rollback beyond keeping the previous build
serving on failure; deploying anything other than this machine's launchd
deployment.

Constraints: no silent fallback - every abort names its reason and reaches
the Inbox; the guarded migration's authority check and the sync tool's
structural refusal are respected, never worked around; database backup
precedes any migration; the deployment checkout is the job's only mutation
target and agent workspaces are never touched; secrets come from the
existing `.env`/plist locations, none are added to the repo.

Acceptance:
1. Script tests (harness like scripts/gate-worker's) cover: quiet-window
   predicate (claimed/provisioning/running block; queued/waiting-inbox do
   not); non-fast-forward and dirty-tree aborts; stop-on-first-failure
   ordering; lock prevents concurrent runs; failure keeps the previous build
   serving.
2. A dry-run mode executes the full decision path against the live database
   read-only and prints the plan without mutating anything; its output on
   the current deployment is included in the PR evidence.
3. Structural-refusal path is exercised in tests: sync refusal ends the run
   escalated, services not restarted.
4. Existing suites pass; the new job is documented well enough that the
   operator can install it from the doc alone.
