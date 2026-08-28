# Internal namespace infrastructure cutover plan

Date: 2026-08-27

Status: proposal only. This record authorizes no host, service, production
checkout, or remote-worker change. Every command-like action below is for a
future, separately approved operator window.

## Placeholder contract

This plan is deliberately independent of the proposed replacement name. Freeze
the following mapping in the operator change ticket before execution:

- `<OLD_HOME>` and `<NEW_HOME>`: current and replacement runtime state roots.
- `<OLD_CHECKOUT>` and `<NEW_CHECKOUT>`: current and replacement independent
  production clones.
- `<OLD_SERVICE_PREFIX>` and `<NEW_SERVICE_PREFIX>`: current and replacement
  launchd label prefixes.
- `<OLD_REPO_SLUG>` and `<NEW_REPO_SLUG>`: current and replacement repository
  directory names on gate workers.
- `<OLD_UNIX_USER>` and `<NEW_UNIX_USER>`: a worker's current and replacement
  account, when that host actually requires an account migration.
- `<PRIMARY_WORKER_ALIAS>` and `<FALLBACK_WORKER_ALIAS>`: the two dispatcher
  destinations.
- `<CUTOVER_OID>`: the exact commit already built and running when the service
  cutover begins.

Do not replace placeholders by global search. Resolve every value per host and
record it in the private operator ticket; secrets and host details do not belong
in this repository.

## Scope and invariants

The local host migration covers the production checkout and the state beneath
the current runtime root, including run workspaces, control-plane state,
repository mirrors, dependency cache, binaries, recovery data, deployment
staging, backups, and logs. It also covers every effective value of
`RUNNER_WORKSPACE_ROOT`, `CONTROL_PLANE_STATE_DIR`,
`RUNNER_REPO_MIRROR_ROOT`, and `FILES_ROOT`. A separately located files root is
inventoried but is not moved merely because the runtime root changes.

The service inventory is exactly the definitions loaded at execution time and
must contain at least the 15 definitions found by the audit:

- 13 business services: API, Inbox, Web, and ten Runners;
- one auto-deploy service;
- one PostgreSQL backup service.

The worker migration covers both configured gate destinations, each host's
actual effective user and `$HOME`, the repository directory under
`~/gate/<OLD_REPO_SLUG>/`, and the worker-wide capacity marker and slot locks
one level above it.

The following invariants hold throughout:

1. `<OLD_HOME>`, old plist files, old worker accounts, and old gate directories
   remain intact until a later cleanup approval.
2. Production is served from one service-label set at a time. Never load old and
   new Runners together against the same queue.
3. `<NEW_CHECKOUT>` is an independent clone, not a worktree of a development
   clone. It stays on clean `main` at `<CUTOVER_OID>`.
4. Mutable state receives its final copy only after claims and writers are
   stopped. A live copy is preparation, not cutover state.
5. The two gate workers are drained and migrated one at a time. At least one
   verified worker remains available.
6. No old directory, account, plist, mirror, log, or backup is deleted in this
   cutover.
7. The npm-scope change already delivered to `main` is a prerequisite, not an
   authorization to rename runtime protocol keys, environment-variable
   prefixes, database or container identities, the Runner Git identity, or
   filenames. Each needs an explicit mapping decision before use.

## Quiet-window selection

Choose a low-traffic window with enough reserved time to perform one restart,
the full verification checklist, and a complete rollback. Do not begin unless
all of these conditions are true:

- the supported deploy dry-run reports zero `claimed`, `provisioning`, or
  `running` Runs and no other blocker;
- no auto-deploy, database backup, schema migration, recovery, or manual deploy
  is active or scheduled to begin inside the window;
- no gate is active on the worker currently selected for migration;
- a current database backup has been verified without exposing its contents;
- the old checkout is clean `main`, its build stamp is recorded as
  `<CUTOVER_OID>`, and `<CUTOVER_OID>` is an ancestor of remote `main`;
- all staged plist files validate and the complete old definitions have been
  saved for rollback;
- both the forward and rollback owners are present, with enough time remaining
  to choose rollback before the end of the window.

`queued` and `waiting-inbox` Runs do not themselves block the documented deploy
path, but no new claim may begin after the final zero-blocker check. Disable the
auto-deploy schedule first, stop the Runner claimers, and repeat the blocker
check before final state synchronization. If the zero result cannot be made
stable, abort without switching paths.

## Ordered local-host cutover

### 1. Freeze the execution manifest

Operation: in the private change ticket, resolve every placeholder; record
`<CUTOVER_OID>`, the old and new absolute paths, all effective runtime-root
environment values, all loaded service labels, plist paths, owners, modes,
program paths, working directories, log paths, schedules, and secret-bearing
environment keys. Record database and container identifiers without changing
them. Reconcile the list against the 15-definition minimum.

Verification: every loaded definition is assigned to exactly one of the
business, auto-deploy, or backup groups; every old absolute path has an explicit
new value or an explicit decision to remain unchanged.

Rollback: none is needed because this step is read-only. A missing or ambiguous
mapping cancels the cutover.

Interruption: none.

### 2. Prepare the replacement filesystem and checkout

Operation: create `<NEW_HOME>` as a real directory owned by the service account.
Require that neither runtime root contains the other and that neither resolves
through a symlink. Create `<NEW_CHECKOUT>` as an independent clone, check out
clean `main` at `<CUTOVER_OID>`, copy the existing mode-0600 `.env` without
printing it, install from the lockfile, generate the Prisma client, build, and
verify the build stamp. Create the required state subdirectories with the old
ownership and modes.

Verification: the new checkout is clean, reports `<CUTOVER_OID>`, and passes
the production build-stamp check. Files containing secrets remain mode 0600.
Filesystem safety checks accept every new configured root and reject overlap
with persistent old state.

Rollback: remove only the newly prepared clone and empty new directories after
confirming that no plist or process references them. Keep the old installation
unchanged.

Interruption: none; old services continue to run.

### 3. Seed state without publishing it

Operation: copy immutable and append-only content from `<OLD_HOME>` to
`<NEW_HOME>` while preserving ownership, modes, timestamps, and filesystem
boundaries. Seed mutable run, control-plane, mirror, deployment, backup, and log
trees for latency only; mark them stale until the final synchronization. Do not
copy sockets, pid files, live locks, symlinks that escape the source root, or
worktrees with active processes.

Verification: compare an inventory and checksums for immutable files, inspect
ownership and permissions, and prove that all destination paths remain under
`<NEW_HOME>`. Record which trees require a final delta.

Rollback: discard the unpublished destination copy. Nothing points to it.

Interruption: none; this step must not take the deploy barrier or stop a service.

### 4. Stage every replacement plist

Operation: derive replacement definitions from the loaded definitions, not from
stale repository examples. Preserve executable arguments, environment, secrets,
resource limits, schedules, and log policy. Change only the approved checkout,
runtime-root, log, and label mappings. Stage all 13 business definitions plus
auto-deploy and PostgreSQL backup definitions outside the live LaunchAgents
directory. Keep a byte-for-byte rollback copy of every old definition.

Verification: validate every staged plist; diff old and new normalized
definitions; require that every changed field is present in the frozen manifest.
Search the staged set for unresolved old absolute paths and require an explicit
exception for each result.

Rollback: delete the staged files. Loaded definitions remain untouched.

Interruption: none.

### 5. Enter the quiet window and quiesce writers

Operation: run the supported deploy dry-run. Confirm auto-deploy and backup are
idle, then prevent their scheduled definitions from starting during the
window. Stop the old Runner claimers first, then stop the remaining 13 business
services in the runbook-defined order. Repeat the blocker query and prove no
writer retains the old mutable state. If any process or Run remains active,
reload the complete old set and abort.

Verification: neither service-label set is running; no deploy or backup process
is active; the repeated blocker result is zero; there are no live workspace or
control-plane writers.

Rollback: before any new definition is loaded, restore scheduling and load the
complete old definition set, verify old health and version, then leave the
window.

Interruption: yes. Auto-deploy is unavailable from the moment its schedule is
disabled. Product execution is unavailable after the business services stop.

### 6. Perform the final mutable-state synchronization

Operation: copy the recorded final deltas into `<NEW_HOME>` while services are
quiescent. Preserve ownership and modes. Handle runtime state, mirrors, caches,
recovery material, deployment backups, and logs as distinct objects. Apply the
frozen decisions for roots that remain outside `<NEW_HOME>`.

Verification: repeat inventory and checksum checks, validate database and
control-plane references, and prove no configured destination points back into
`<OLD_HOME>` except an approved external root.

Rollback: do not reverse-copy destination state. Leave `<NEW_HOME>` unpublished,
load the old definitions, and continue on `<OLD_HOME>`. Investigate or discard
the failed destination only after service recovery.

Interruption: yes; product execution and auto-deploy remain unavailable.

### 7. Switch the launchd definitions as one controlled change

Operation: install the staged definitions into the live LaunchAgents directory,
replace the complete old label set with the complete new label set, and load the
new business services. Load the replacement backup schedule only after its
paths and database contract are verified. Load auto-deploy last, after the
business verification in step 8.

Verification: launchd's loaded definitions, not merely files on disk, show only
approved absolute paths and labels. No old and new Runner labels overlap.

Rollback: unload the entire new set, restore every saved old plist, load the old
business, backup, and auto-deploy definitions, and verify the old version and
health. Never mix selected old and new definitions.

Interruption: yes. Product execution resumes only when the new business set is
healthy; auto-deploy intentionally remains unavailable.

### 8. Verify service health before enabling auto-deploy

Operation: require every new business label to be running; require `/health` to
pass and `/version` to report `<CUTOVER_OID>`; inspect every loaded Program,
ProgramArguments path, WorkingDirectory, state root, and log path; confirm the
new checkout is clean `main`; submit a controlled non-destructive smoke Run and
verify that its workspace is created beneath the approved new root.

Verification: all checks pass as one acceptance set. Partial success is failure.
The smoke Run must not write under `<OLD_HOME>`.

Rollback: use step 7's complete-set rollback immediately, then verify old health
and preserve the failed new state for diagnosis.

Interruption: yes until all checks pass. A failed check extends downtime only
long enough to execute rollback.

### 9. Enable and observe replacement scheduling

Operation: load the replacement auto-deploy definition, confirm its next
scheduled behavior, and observe one no-op or hold cycle at `<CUTOVER_OID>`.
Observe the backup definition without forcing a backup during the cutover.

Verification: auto-deploy reports the expected deployed and remote revisions,
uses `<NEW_CHECKOUT>`, and does not report an escalation. All 15 loaded
definitions resolve only to approved locations. Product health remains green.

Rollback: disable the new schedules and execute the complete step 7 rollback.
Do not clear an auto-deploy escalation until its named condition has been
diagnosed and the supported dry-run passes.

Interruption: auto-deploy resumes during this step; product service should not
be interrupted if verification succeeds.

### 10. End the local quiet window without cleanup

Operation: record the final label inventory, exact version, health evidence,
effective roots, and start times. Mark old definitions and state retained for
rollback. Set a separately approved retention period.

Verification: no loaded definition references `<OLD_CHECKOUT>` or unapproved
paths below `<OLD_HOME>`; no process holds files in the old checkout; the new
checkout remains clean `main`.

Rollback: the retained old installation remains the rollback target during the
retention period. Any later state divergence requires a new rollback decision;
never overwrite newer production state with an older blind copy.

Interruption: none.

## Ordered gate-worker cutover

Gate-worker work occurs after the local service cutover is stable. It is not
part of the local quiet-window transaction and must not prolong product
downtime.

### 11. Freeze per-worker facts and migration order

Operation: for each worker, confirm through an approved read-only session its
effective user, `$HOME`, repository directory, active gate processes, repository
worktrees, mirror refs, installed harness, logs, capacity marker, and
worker-wide slot-lock locations. Do not infer one worker's account from the
other. Migrate the fallback first while the primary remains available, then the
primary while the verified fallback remains available.

Verification: the worker has no active gate before it is drained; its actual
home and account agree with the private manifest. A host whose current account
is intentionally unrelated to either product name does not receive a cosmetic
account rename.

Rollback: no mutation has occurred. Restore normal dispatch routing if the
facts do not match the manifest.

Interruption: product auto-deploy is unaffected. Aggregate gate capacity is
reduced while one worker is drained.

### 12. Prepare one replacement worker identity and repository directory

Operation: remove the selected worker from normal dispatch routing. If an
account migration is approved for that host, create `<NEW_UNIX_USER>` alongside
the old account with equivalent explicitly reviewed groups, toolchain access,
SSH authorization, limits, and Docker permissions; do not rename the old
account in place. Create `~/gate/<NEW_REPO_SLUG>/` under the actual replacement
home. Copy the idle repository mirror, installed harness, and logs while
preserving ownership and modes. Require the old `worktrees` directory to be
empty. Do not copy worker-wide live slot locks. Preserve and verify the
worker-wide capacity marker's semantics in its documented location.

Verification: the new account has only the required permissions; the mirror has
no remote; expected immutable candidate and baseline refs read back exactly;
the harness matches the candidate that will be tested; no process uses the old
repository directory.

Rollback: route dispatch back to the old alias/account and old repository
directory. Leave the new account and directory disabled for diagnosis; do not
delete them during rollback.

Interruption: one worker's gate capacity is unavailable. Product service and
auto-deploy are unaffected.

### 13. Prove one migrated worker before routing normal traffic

Operation: update only that worker's private SSH/dispatcher mapping to the
replacement account and repository directory. Push an exact candidate and
baseline with the supported mirror transport, then explicitly dispatch
`<CUTOVER_OID>` to that worker.

Verification: require `MERGE GATE: PASS <CUTOVER_OID>`, exact mirror-ref
readback, expected slot capacity, and no leaked worktree, container, scratch
database, or lock. A transport result or missing verdict is not a pass.

Rollback: restore that worker's old SSH/dispatcher mapping and repository
directory, then prove the old route is usable. Preserve the failed new evidence.

Interruption: the selected worker remains unavailable to normal dispatch until
the exact-head proof passes. Product auto-deploy is unaffected.

### 14. Repeat for the other worker

Operation: return the verified first worker to service, then repeat steps 11
through 13 for the other worker. Never drain both simultaneously.

Verification: explicitly dispatch one exact commit through each worker after
its migration, then exercise normal primary/fallback selection without changing
the commit under test.

Rollback: restore only the failing worker's old mapping. Keep the already
verified worker serving gates.

Interruption: aggregate gate capacity is reduced, but at least one worker
remains available. Product auto-deploy is unaffected.

## Interruption summary

| Phase | Product service | Auto-deploy | Gate capacity |
| --- | --- | --- | --- |
| Manifest, checkout, state seed, plist staging | No interruption | No interruption | No interruption |
| Quiet-window entry and final state sync | Stopped after claimers quiesce | Stopped first | No interruption |
| Plist switch and service verification | Interrupted until acceptance or rollback | Remains stopped | No interruption |
| Replacement scheduling observation | Running | Resumes after service acceptance | No interruption |
| One worker migration | Running | Running | Reduced by that worker |
| Retention and later cleanup | Running | Running | No interruption when cleanup is separately approved and idle |

## Rollback acceptance

A local rollback is complete only when the entire old plist set is loaded, all
13 old business labels are running, old `/health` and `/version` checks pass,
auto-deploy and backup schedules are restored, and no old process points into
the failed new checkout. A worker rollback is complete only when the old route
can produce or accept an exact-head gate invocation and the failed new route is
out of dispatcher rotation.

Rollback does not authorize deleting the failed destination or copying its
newer mutable state over the old root. If production writes have occurred after
the cutover, choose a state reconciliation strategy in a new change ticket.

## Deferred cleanup

Deletion of `<OLD_HOME>`, `<OLD_CHECKOUT>`, old plist files, old worker accounts,
`~/gate/<OLD_REPO_SLUG>/`, mirrors, logs, backups, or rollback evidence is a
separate destructive change. It requires explicit approval after the retention
period, proof that no loaded definition or process references the old paths,
and a recoverable backup. This runbook stops before that decision.
