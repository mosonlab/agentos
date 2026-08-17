# PLAN — CP-A v1.0: cross-database workspace-root ownership

Status: first-pass implementation plan for review  
Author: plan agent · Date: 2026-08-17  
Product Contract: **CP-A v1.0**  
Routing: **Planned Critical** · implementation agent **`senior-dev`** · high effort  
Baseline: `70995b5` (`master` and this task branch at inspection time)

Planning only. This document does not implement or activate the change.

## 0. Approach summary

Make the canonical workspace root, rather than a database row, the authority for
control-plane exclusivity. The API process will take a non-blocking POSIX
advisory lock on a persistent file inside the physical workspace root before it
imports the Prisma client or application, reconciles anything, starts the
scheduler, or listens. Because the lock belongs to the filesystem inode and the
kernel-held file description, it excludes another process even when that
process uses a different or copied database. A database lease is neither needed
nor sufficient and will not be added.

The root also stores a stable control-plane ID and an atomic owner evidence
record. The stable ID survives clean restarts; every process gets a new
incarnation ID. A contending process never removes or steals a held lock. After
a crash the kernel releases the lock automatically, but a successor may replace
an `owned` evidence record only when the prior record is valid, names this host,
and the recorded PID returns `ESRCH`. A live PID, PID reuse, `EPERM`, a foreign
host, malformed evidence, or any other uncertain liveness result fails closed.
There is no timeout-based takeover.

The API captures the canonical root in its application instance so startup and
post-run workspace reconciliation use the root for which that process holds the
ownership capability. Shutdown reverses startup: stop scheduling, stop and
drain HTTP, disconnect Prisma, record clean release, unlock, then exit. Runner
daemons do **not** acquire this lock; any number may continue to poll one owning
control plane and create run subdirectories beneath its root.

Implementation is six ordered steps. Steps 1–5 should be separate commits;
step 6 is verification/evidence only. No Prisma schema or migration changes are
planned.

## 1. Verified starting state and risk boundaries

### 1.1 Current startup and destructive paths

- `packages/api/src/index.ts` loads `.env`, imports `@agentos/db`, `app`,
  reconciliation, scheduler, and Files configuration concurrently. It checks
  Files/root isolation, calls `reconcileAtStartup`, then listens and starts the
  scheduler. There is no ownership acquisition before those operations.
- `packages/api/src/reconcile.ts` can mark expired active Runs `LOST`, enqueue
  retries, and recursively delete any directory under the configured root that
  is not protected by the current database view.
- `packages/api/src/app.ts` calls `reconcileDatabaseRuns` on every runner claim
  and `reconcileWorkspaces` after run completion. The latter re-reads
  `RUNNER_WORKSPACE_ROOT` instead of using an immutable startup value.
- `packages/runner/src/config.ts` independently resolves
  `RUNNER_WORKSPACE_ROOT`; runner daemons are clients and workspace users, not
  control planes. `packages/api/src/runners.ts` intentionally supports multiple
  daemon identities.
- `packages/api/src/reconcile.test.ts` covers GC behavior with temporary roots;
  `packages/api/src/testdb.ts` provides a dedicated-schema database harness,
  but there is no real-process control-plane exclusivity test.

### 1.2 Incident evidence this plan must close

The existing runbooks record the 2026-08-16 failure mode: a second API pointed
at a live database or its copy can treat active Runs as orphaned and delete
their workspace, including `.git`. The runtime wiki also records mixed
workspace roots across runners and APIs causing missing/resumed workspace
failures. CP-A addresses control-plane exclusivity; it does not redesign runner
root negotiation or runner concurrency.

### 1.3 Fixed boundaries

- Local POSIX filesystems only. Remote/distributed control planes and remote
  filesystem lock semantics are out of scope.
- Never start a test process against the live database, any live-data copy, or
  the live root. All process tests create uniquely named temporary roots and
  empty scratch databases from committed migrations.
- No schema migration. If implementation discovers a need for one, stop for a
  reviewed-plan change as required by the Product Contract.
- No changes to claim concurrency, Run fencing, runner concurrency, Goal,
  Inbox, public release, or production services.
- Stop immediately on unexplained workspace deletion, ambiguous liveness that
  does not fail closed, contact with production data, or a lock implementation
  that cannot prove exclusivity with real processes.

## 2. Ownership protocol (normative for implementation)

### 2.1 Root-local artifacts

After creating the configured root and resolving it with `realpath`, the API
uses three non-directory files inside that canonical root:

| File | Purpose | Lifecycle |
|---|---|---|
| `.agentos-control-plane.lock` | Persistent inode held with `flock(LOCK_EX | LOCK_NB)` | Never unlinked by normal code; close/unlock releases ownership |
| `.agentos-control-plane-id.json` | Stable UUID and format version for this physical root | Created atomically once while locked; survives restarts |
| `.agentos-control-plane-owner.json` | Atomic operator evidence for the current/last incarnation | Replaced by temp-file + rename while locked; survives crashes |

All files are mode `0600`; the implementation must not chmod the workspace root
or runner-created directories. `reconcileWorkspaces` already ignores files and
only considers directory entries, so these artifacts cannot enter workspace GC.
Runners neither read nor lock them.

The API package will use `fs-ext` for callback-based POSIX `flock`, wrapped in a
small Promise API; add `@types/fs-ext` only for its narrow TypeScript surface.
`fs-ext` is a runtime dependency of `@agentos/api`, not the runner. A native
dependency install/build failure is a failed gate, not permission to replace
the protocol with a time-based lockfile.

### 2.2 Stable identity and owner evidence

The stable identity record contains `formatVersion`, `controlPlaneId`, and the
canonical root. The owner record contains:

```text
formatVersion
state: owned | released
controlPlaneId
incarnationId
pid
hostname
canonicalWorkspaceRoot
acquiredAt
releasedAt (released state only)
```

Generate `controlPlaneId` once with `crypto.randomUUID()` and retain it across
restarts. Generate `incarnationId` once per process. Never derive either from a
database, database URL, port, PID alone, or mutable hostname. Logs and errors
may include the IDs, PID, hostname, timestamps, and canonical root, but never a
database URL or credential.

### 2.3 Acquisition and recovery decision table

1. Resolve the configured root to one canonical physical path (`mkdir` first,
   then `realpath`) so symlink and lexical aliases contend on the same inode.
2. Open the persistent lock file without truncating or replacing it and request
   an exclusive non-blocking `flock`.
3. If the kernel reports contention, close the descriptor, read owner evidence
   only for diagnostics, emit `CONTROL_PLANE_OWNERSHIP_CONFLICT`, and exit with
   a dedicated non-zero code before any database/app import, reconciliation,
   scheduler creation, or listen attempt. Missing/malformed diagnostics do not
   weaken the conflict.
4. If the lock is acquired and there is no prior owner record, this is a first
   acquisition. Create/load the stable ID, atomically write `state=owned`, and
   continue.
5. If the prior valid record says `released`, treat it as a clean handoff,
   atomically write the new `state=owned` record, and continue.
6. If the prior valid record says `owned`, recovery is permitted only when its
   canonical root and stable ID match, its hostname equals the current host,
   and `process.kill(recordedPid, 0)` throws exactly `ESRCH`. Log
   `CONTROL_PLANE_OWNERSHIP_RECOVERED` with old/new incarnation IDs before
   replacing the record.
7. A successful PID probe, `EPERM`, an unknown error, PID reuse, foreign host,
   invalid PID, malformed JSON/schema, root/identity mismatch, or filesystem
   lock error is ambiguous. Unlock/close and emit a fail-closed diagnostic; do
   not reconcile, listen, delete, rewrite evidence, or retry by elapsed time.

Successful `flock` is the cross-process serialization point; the PID/host check
is the stricter stale-owner recovery policy required by CP-A. Neither mtime nor
wall-clock age grants ownership.

### 2.4 Held capability and shutdown ordering

`acquireControlPlaneOwnership` returns one in-memory capability containing the
canonical root, stable/incarnation identity, `assertHeld()`, and idempotent
`release()`. Production startup passes that exact canonical root and assertion
into `createApp` and startup reconciliation. No live destructive path may
re-read the environment to select another root.

Startup order:

1. load `.env`;
2. import only root/ownership code;
3. canonicalize root and acquire ownership;
4. import Prisma, application, reconciliation, scheduler, and Files modules;
5. validate Files/root isolation against the canonical root;
6. assert ownership and run startup reconciliation;
7. create/listen HTTP server;
8. start scheduler.

Shutdown or startup-failure order:

1. prevent a second shutdown and stop/clear scheduler;
2. stop accepting HTTP and await server close/drain if it exists;
3. disconnect Prisma if imported;
4. while still locked, atomically write `state=released`;
5. unlock and close the ownership descriptor;
6. exit.

`SIGKILL` cannot run cleanup; that is intentional. The kernel releases the
descriptor, the `owned` record remains as crash evidence, and the next process
must pass the dead-owner rule above.

## 3. Ordered implementation steps

### Step 1 — Add the canonical-root ownership primitive

**Files:** new `packages/api/src/workspace-root.ts`; new
`packages/api/src/control-plane-ownership.ts`; new
`packages/api/src/control-plane-ownership.test.ts`;
`packages/api/package.json`; `package-lock.json`; move/re-export
`defaultWorkspaceRoot` from `packages/api/src/reconcile.ts` as needed by
existing imports.

**Changes:**

1. Put `defaultWorkspaceRoot()` and `canonicalizeWorkspaceRoot()` in
   `workspace-root.ts`. Preserve today's default (`~/.agentos/runs`) and lexical
   `resolve` behavior, create the root, then use `realpath` for ownership.
2. Implement the protocol in §2 with a narrow `fs-ext` wrapper, typed owner
   record parser, atomic same-directory metadata writes, redaction-safe typed
   errors, `assertHeld`, and idempotent `release`.
3. Never unlink or rename the persistent lock file. Never mutate owner evidence
   after a conflict or ambiguous stale check.
4. Add `fs-ext` and its types to the API workspace and lockfile only; do not add
   a database model, heartbeat, expiry, or runner dependency.

**Verification:**

- Unit tests use temporary physical roots plus injectable liveness probes to
  prove: symlink/lexical aliases canonicalize identically; stable ID survives a
  clean release/reacquire while incarnation changes; held lock conflicts;
  `ESRCH` permits crash recovery; live/reused PID, `EPERM`, foreign host,
  malformed evidence, root mismatch, and unknown errors all fail closed; clean
  release writes evidence before unlock; double release is harmless.
- Add a child-process lock probe in the test file so exclusivity is tested
  across processes rather than inferred from mocks.
- Run `npm ci`, then
  `npm run test -w @agentos/api -- --test-name-pattern=control-plane` and
  `npm run typecheck -w @agentos/api`.

### Step 2 — Make ownership the first and last API lifecycle operation

**Files:** `packages/api/src/index.ts`; `packages/api/src/app.ts`;
`packages/api/src/reconcile.ts`; `packages/api/src/app.test.ts`; optionally
`packages/api/src/control-plane.test.ts` for entrypoint-order assertions.

**Changes:**

1. Replace the current parallel pre-ownership imports in `index.ts` with the
   exact startup state machine in §2.4. Import `@agentos/db`, `app`, reconcile,
   scheduler, and Files configuration only after acquisition.
2. Import `createApp`, not the eager exported singleton. Extend `createApp` with
   immutable live options containing the canonical workspace root and
   ownership assertion; remove the unused module-level `app` export so the
   production entrypoint cannot silently use default/env-derived GC state.
3. Pass the canonical root to Files/root isolation and
   `reconcileAtStartup`; call `assertHeld()` immediately before startup
   reconciliation.
4. Change the post-run completion GC in `app.ts` to use the captured canonical
   root and assert ownership before `reconcileWorkspaces`. Keep claim-time
   database reconciliation inside the already-owned served application.
5. Make server close awaitable and implement one idempotent shutdown path for
   `SIGINT`, `SIGTERM`, startup exceptions, and normal test teardown. Release
   ownership only after scheduler, HTTP, and Prisma are stopped.
6. Emit stable machine-greppable acquired/conflict/recovered/released markers.
   A conflict message names root and available owner identity, says that no
   reconciliation/listen occurred, and exits non-zero without a stack trace or
   secret.

**Verification:**

- API unit tests capture `createApp` options and prove post-run GC receives the
  immutable canonical root and refuses when `assertHeld()` fails.
- An entrypoint ordering test supplies an already-held root and an invalid or
  query-trapping database URL; the process must emit only the ownership
  conflict and exit without importing/connecting to Prisma, printing
  `Startup reconciliation`, or printing `listening`.
- Existing reconciliation tests remain green, proving the ownership metadata
  files are not considered workspace directories.
- Run `npm run test -w @agentos/api` and
  `npm run typecheck -w @agentos/api`.

### Step 3 — Prove same-DB and copied-DB conflicts with real processes

**Files:** new `packages/api/src/control-plane-ownership.dbtest.ts`;
`packages/api/src/testdb.ts` (bounded scratch-database helpers only);
`packages/api/package.json` (ensure the API is built before the process DB
suite if it spawns `dist/index.js`).

**Changes:**

1. Extend test infrastructure with a narrowly guarded scratch database helper.
   It creates uniquely prefixed empty databases, applies only committed
   migrations, clones a source scratch database to a second scratch database
   before either API connects, and drops only names created by that test.
   Refuse `public`/production targets, existing names, unrecognized prefixes,
   source/target equality, or cleanup outside the recorded test IDs. Never log
   credential-bearing URLs.
2. Spawn the built production entrypoint with explicit isolated environment:
   scratch `DATABASE_URL`, `API_HOST=127.0.0.1`, `API_PORT=0`, scheduler disabled,
   distinct Files temp root, shared workspace temp root, and test-only tokens.
   Treat `CONTROL_PLANE_OWNERSHIP_ACQUIRED` followed by `listening` as ready.
3. **Same DB / same canonical root:** after owner A listens, insert an expired
   active Run and an orphan directory. Start B with the same database/root.
   Assert B exits non-zero with conflict before reconciliation/listen, the Run
   is unchanged, and the directory still exists.
4. **Copied DB / same canonical root:** create DB B as a physical copy of an
   empty, migrated scratch DB A before startup. Start owner A, then put an
   expired active Run in copied DB B and an orphan directory in the shared temp
   root. Start B against the copy. Assert the same early conflict and that both
   database state and directory are unchanged.
5. Assert the losing process never writes acquired/recovered/released evidence
   and that owner A remains healthy. Teardown terminates only recorded child
   PIDs, awaits exit, disconnects clients, and removes only recorded temp roots
   and scratch databases.

**Verification:**

- Run
  `npm run test:db -w @agentos/api -- --test-name-pattern='workspace-root ownership'`
  with an explicitly dedicated `TEST_DATABASE_URL` server. Both conflict
  shapes must pass without retries.
- Inspect captured markers to prove the order: owner acquired → owner
  reconciled → owner listened; loser conflict → loser exited, with no loser
  reconcile/listen marker.
- A failure to create an isolated scratch copy is a failed gate; do not replace
  it with a live-data copy or the live root.

### Step 4 — Prove crash recovery and preserve multiple runner daemons

**Files:** `packages/api/src/control-plane-ownership.dbtest.ts`;
`packages/api/src/runners.test.ts` only if an additional focused registry
assertion is needed.

**Changes:**

1. Add a real-process crash case: start an owner on a scratch DB/root, capture
   stable and incarnation IDs, send `SIGKILL`, await confirmed child exit, and
   verify the on-disk record still says `owned`. Start a successor on the same
   root. It must obtain the released kernel lock, observe `ESRCH` for the old
   PID, emit `CONTROL_PLANE_OWNERSHIP_RECOVERED`, retain the stable ID, allocate
   a new incarnation, reconcile, and listen.
2. Pair it with fail-closed cases using a free kernel lock plus synthetic valid
   `owned` records for a live PID and an ambiguous probe. Both must exit before
   reconciliation/listen and leave evidence byte-for-byte unchanged.
3. While one owner is listening on a clean scratch database, send claim polls
   from two distinct runner IDs that both report the same canonical workspace
   root. Both receive the normal no-work response; `/runners` reports both
   daemons. Neither runner creates/contends on control-plane ownership files.
   Keep all existing claim/lease/concurrency semantics unchanged.

**Verification:**

- The focused real-process DB suite passes the crash, ambiguity, and two-runner
  cases in one run.
- Existing `packages/api/src/runners.test.ts` and all runner package tests pass.
- Review the runner diff: expected product-code change under `packages/runner`
  is **none**. Any required runner lock or concurrency change is scope drift and
  must stop the step.

### Step 5 — Document rollout evidence and code-only rollback, without activation

**Files:** new
`docs/runbooks/control-plane-workspace-ownership.md`; `README.md`;
`.env.example`; `docs/wiki/batch-2-repairs-runtime.md` (replace the statement
that no root ownership is enforced and link the English runbook).

**Changes:**

1. Document the invariant, the three root-local files, stable/incarnation
   identity, exact log markers, conflict exit, stale recovery decision table,
   supported multiple-runner topology, and why a DB lease cannot provide
   cross-database exclusion.
2. State the future activation preflight but do not perform it: select one
   absolute local `RUNNER_WORKSPACE_ROOT`, verify every API/runner config agrees,
   drain Runs, stop the old API, install/build, start exactly one new API, and
   verify acquired → reconciliation → listening order. Runner daemons may be
   restarted/continued only under the existing runner procedure; they do not
   own the root.
3. Name exact operator evidence: canonical root, stable/incarnation IDs, PID and
   host from the acquired line; absence of reconcile/listen after a deliberate
   isolated conflict rehearsal; recovery line after a killed isolated owner;
   focused test names; and final gate command/exit codes. Never suggest a test
   against live state.
4. Document ambiguity handling: do not delete lock/evidence because a PID is
   merely old or a timestamp elapsed. Stop on live PID, PID reuse, `EPERM`,
   foreign host, malformed record, filesystem lock failure, or root mismatch.
5. Document rollback: drain/stop the new API; revert the ownership code and
   `fs-ext` dependency/lockfile changes; rebuild; leave the three regular files
   in place (old reconciliation ignores files); start only one old API under a
   manual single-control-plane rule. No database rollback or workspace deletion
   is involved. Explicitly warn that code rollback removes enforced protection
   and therefore must never be used to run two APIs.

**Verification:**

- Run a documentation grep/check proving every marker and filename in the
  runbook matches source/tests.
- Review the diff and task activity for absence of production commands,
  launchd edits, migrations, database URLs, tokens, or live evidence claims.
- `npm run snapshot:scan` and `npm run test:snapshot-scan` pass if these docs are
  in the public snapshot boundary; otherwise record that the scan found no
  affected public artifact.

### Step 6 — Run final gates and capture authoritative evidence

**Files:** no product file; record results in the implementation task output
and activity log. If the implementation workflow requires a checked-in result,
use a new English review/result document named by that workflow rather than
editing this approved plan.

**Changes:** none. Run from a clean worktree after rebasing/fetching current
`master` according to the implementation task's authority. Use one dedicated
test database/server and unique scratch names. Do not retry a red concurrency
test until it becomes green; diagnose the first failure.

**Verification gates, in order:**

```sh
npm ci
npm run db:validate
npm run test -w @agentos/api
npm run test -w @agentos/runner
npm run test:db -w @agentos/api
npm run typecheck
npm run build
npm test
npm run snapshot:scan
npm run test:snapshot-scan
```

Also run `git diff --check` and confirm `git status --short` contains only the
planned files. Record command, exit code, test counts, scratch root/database
identifiers (names only, no credentials), and the acquired/conflict/recovered
marker sequence. Any affected full gate failure blocks completion.

## 4. Acceptance and evidence matrix

| Contract acceptance | Plan coverage | Required executable evidence |
|---|---|---|
| 1. Same DB/root loser fails before reconcile/listen | Steps 1–3 | Same-DB real-process test; loser has conflict only; expired Run unchanged |
| 2. Copied/different DB/root loser also fails | Steps 1–3 | Physically copied scratch-DB test with identical root and unchanged copied-DB fixture |
| 3. Loser cannot reconcile or delete workspaces | Steps 2–3 | Database sentinel and orphan directory both survive; no loser reconciliation marker |
| 4. Multiple runner daemons remain supported | Steps 2 and 4 | Two runner IDs poll one owned API/root and both appear in `/runners`; runner code unchanged |
| 5. Recovery only after demonstrably dead owner; ambiguity fails closed | Steps 1 and 4 | `SIGKILL` + awaited exit + `ESRCH` recovery; live PID/`EPERM`/malformed cases refuse unchanged |
| 6. Focused unit and real-process/database tests | Steps 1–4 | Unit protocol suite plus production-entrypoint DB suite for same/copy/recovery |
| 7. Full affected tests/typecheck/build pass | Step 6 | Exact gate list, exit codes, and counts recorded once on final tree |
| 8. English rollback/operations evidence without activation | Step 5 | New runbook with exact markers, commands, evidence, rollout, and code-only rollback |

Scope requirements are also covered: canonical cross-process/cross-database
ownership (Steps 1–3), stable owner identity (Step 1), acquisition before work
(Step 2), fail-closed UX (Steps 1–2), stale recovery (Steps 1 and 4), runner
compatibility (Step 4), lock ordering/lifecycle (Steps 1–2), and rollback/operator
evidence (Step 5).

## 5. Review and implementation checkpoints

- The review must reject any design based only on a database advisory lock,
  database lease/generation, port binding, PID file, mtime expiry, or
  check-then-delete lockfile. Those do not satisfy copied-database exclusion or
  safe crash recovery.
- The implementation must not unlink/replace the persistent flock inode. Doing
  so permits two processes to lock different inodes at the same pathname.
- Root ownership must precede the **import** that creates the production Prisma
  client/app, not merely precede `serve`; this makes the loser-before-database
  assertion mechanically testable.
- `createApp` test instances are not control planes. Only the production
  entrypoint acquires ownership; test apps must receive a no-op/test capability
  when directly exercising handlers.
- A clean release is written while the lock is still held. Crash recovery is a
  separate state and must retain the prior owner evidence in the recovery log.
- Do not weaken liveness to “old enough.” If a real-process recovery test is
  flaky, stop and diagnose process-exit observation and lock lifecycle rather
  than adding sleeps or a stale timeout.
- No production activation, API/runner restart, live-root probe, or launchd
  change is part of CP-A implementation or verification.

## 6. Rollback summary

There is no data migration and no workspace content transformation. The safe
code rollback is: drain work, stop the new API, revert Steps 1–2 dependency and
code changes, rebuild, and start exactly one old API. Leave root-local lock and
JSON evidence files untouched; old GC ignores non-directory files. This restores
the prior software but also restores the prior risk, so manual single-instance
operation is mandatory until CP-A is re-applied. Full operator detail and exact
evidence belong in `docs/runbooks/control-plane-workspace-ownership.md` from
Step 5.
