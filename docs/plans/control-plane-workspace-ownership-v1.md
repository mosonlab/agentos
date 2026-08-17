# PLAN — CP-A v1.0: cross-database workspace-root ownership

Status: authoritative revised implementation plan after consolidated review
Author: plan agent · Date: 2026-08-17  
Product Contract: **CP-A v1.0**  
Routing: **Planned Critical** · implementation agent **`senior-dev`** · high effort  
Baseline: product/code baseline `70995b5`; consolidated review commit `bf53cae`

Planning only. This document does not implement or activate the change.

## 0. Approach summary

Make the canonical workspace root, rather than a database row, the identity that
selects control-plane exclusivity. The API hashes that canonical root to one
entry in an API-only local control-state directory and takes a non-blocking
POSIX advisory lock there before it imports the Prisma client or application,
reconciles anything, starts the scheduler, or listens. The authoritative lock
is deliberately outside `RUNNER_WORKSPACE_ROOT`: runner cleanup and model code
must not be able to unlink its directory entry. The state directory is accepted
only after an ownership, permission, symlink, and local-filesystem preflight;
unsupported or ambiguous state fails closed. This host-local lock excludes a
second process even when the workspace itself is on a filesystem whose locking
semantics are unsuitable and the processes use different or copied databases.
A database lease is neither needed nor sufficient and will not be added.

The same protected per-root entry stores a stable control-plane ID and an atomic
owner evidence record. The stable ID survives clean restarts; every process
gets a new incarnation ID. A contending process never removes or steals a held
lock. After a crash the kernel releases the lock automatically, but a successor
may replace an `owned` evidence record only when the prior record is valid,
names this host, and the recorded PID returns `ESRCH`. A successful PID probe
means only `pid-present-owner-identity-ambiguous`; `EPERM`, a foreign host,
malformed evidence, or any other uncertain liveness result also fails closed.
There is no timeout-based takeover and no claim that PID reuse is detectable.

The API captures the canonical root, its physical identity, and the original
configured path in its application instance so startup and post-run workspace
reconciliation use the root for which that process holds the ownership
capability. Every destructive assertion rechecks both the open lock inode and
the pinned root identity. HTTP listen success/failure and shutdown join the same
awaited state machine. Runner daemons do **not** acquire this lock; any number
may continue to poll one owning control plane and create run subdirectories
beneath its root, but the supported deployment keeps runner/model principals
unable to write the API control-state directory.

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

- One local host/process namespace only; remote or distributed control planes
  remain out of scope. `RUNNER_WORKSPACE_ROOT` may reside on any filesystem for
  which canonical path and identity inspection succeeds because the lock is not
  stored there. The separate control-state directory must pass the explicit
  local-filesystem allowlist in §2.1; network, FUSE, and unknown filesystem
  types are refused before acquisition. This is an enforced lock prerequisite,
  not an assumption inferred from an absolute pathname.
- The API control-state directory is a distinct OS protection boundary: it is
  owned by the API uid, mode `0700`, contains no symlinked path component, does
  not overlap the workspace or Files root, and is not writable by any runner
  daemon or model principal. Production activation must use distinct principals
  and prove this with the executable access probe in Step 5. The shipped
  same-principal default is not activation-ready for CP-A.
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

### 2.1 Protected control-state artifacts and filesystem preflight

After creating the configured workspace root and resolving it with `realpath`,
the API computes `sha256(canonicalWorkspaceRoot)` and uses one directory named
by that 64-hex digest below `CONTROL_PLANE_STATE_DIR` (default
`~/.agentos/control-plane`). The digest is only a lookup key: every metadata
record also stores the full canonical root, and any key/root mismatch refuses
startup. The base and per-root directories are mode `0700`, owned by the API
effective uid, disjoint from `RUNNER_WORKSPACE_ROOT` and `FILES_ROOT`, and
created/inspected without following symlinks. The per-root entry contains:

| File | Purpose | Lifecycle |
|---|---|---|
| `ownership.lock` | Persistent inode held with `flock(LOCK_EX | LOCK_NB)` | Never unlinked/replaced; close/unlock releases ownership |
| `control-plane-id.json` | Stable UUID, format version, digest, and canonical root | Created atomically once while locked; survives restarts |
| `owner.json` | Atomic operator evidence for the current/last incarnation | Replaced by temp-file + rename while locked; survives crashes |

All files are regular files mode `0600` owned by the API uid. Before opening a
lock, use `lstat`/directory-file-descriptor-relative operations to reject
symlinks, owner/mode drift, path replacement, and traversal outside the accepted
base. `assertHeld()` compares `fstat(openLockFd).{dev,ino}` with
`lstat(authoritativeLockPath).{dev,ino}`, confirms the descriptor remains
locked, and revalidates the pinned configured-root resolution and root
`{dev,ino}`. Any mismatch makes the capability permanently invalid and blocks
reconciliation/GC. Manual deletion, rename, or recreation is never recovery.

Before any per-root entry is used, inspect the state directory's mounted
filesystem with a platform-specific `statfs` mapping. The implementation has an
explicit supported-local allowlist (Darwin APFS/HFS+; Linux ext2/3/4, XFS,
Btrfs, tmpfs, and local overlayfs) and refuses NFS, SMB/CIFS, FUSE, other known
network/user-space types, or an unknown type. Unit tests cover every mapping;
real-process tests prove refusal on an injected unsupported/unknown result. The
runbook records the detected type, device, owner uid, and mode as activation
evidence. The workspace filesystem is not used as the exclusion primitive.

The API package will use `fs-ext` for callback-based POSIX `flock`, wrapped in a
small Promise API, plus the narrow platform inspection needed above; add
`@types/fs-ext` only for its TypeScript surface. The lock open must be
close-on-exec. Immediately after opening, verify `FD_CLOEXEC` through a narrow
native `fcntl(F_GETFD)` wrapper and refuse before ownership if the flag is
absent or cannot be proved. `fs-ext` is a runtime dependency of `@agentos/api`,
not the runner. A native dependency install/build or local-filesystem/CLOEXEC
verification failure is a failed gate, not permission to substitute a timeout,
PID file, DB lease, or workspace-local lock.

Atomic metadata writes use only
`.<destination>.tmp-<pid>-<incarnationId>` in the same protected entry. While
holding and validating the lock, acquisition inventories leftover regular files
that match exactly this bounded grammar, are owned by the API uid, and are not
symlinks; every other unexpected entry refuses startup. Safe debris is removed
only after the durable pairwise state is accepted for advancement; a refused
state is wholly unchanged. The lock inode is never part of cleanup. Crash debris
is therefore documented but cannot accumulate across a successful acquisition.

### 2.2 Stable identity and owner evidence

The stable identity record contains `formatVersion`, `controlPlaneId`, and the
canonical root plus its control-state digest. The owner record contains:

```text
formatVersion
state: owned | released
controlPlaneId
incarnationId
pid
hostname
canonicalWorkspaceRoot
controlStateDigest
workspaceRootDevice
workspaceRootInode
acquiredAt
releasedAt (released state only)
```

Generate `controlPlaneId` once with `crypto.randomUUID()` and retain it across
restarts. Generate `incarnationId` once per process. Never derive either from a
database, database URL, port, PID alone, or mutable hostname. Logs and errors
may include the IDs, PID, hostname, timestamps, and canonical root, but never a
database URL or credential.

### 2.3 Acquisition, partial-state, and recovery decision tables

1. Resolve the configured root to one canonical physical path (`mkdir` first,
   then `realpath`), capture its `dev`/`ino` and configured spelling, derive the
   control-state digest, and pass every §2.1 state-directory preflight.
2. Open `ownership.lock` without truncating or replacing it, prove
   `FD_CLOEXEC`, request an exclusive non-blocking `flock`, and confirm the open
   descriptor and authoritative pathname still name the same `dev`/`ino`.
3. If the kernel reports contention, close the descriptor, read owner evidence
   only for diagnostics, emit `CONTROL_PLANE_OWNERSHIP_CONFLICT`, and exit with
   `CONTROL_PLANE_OWNERSHIP_EXIT_CODE=75` before any database/app import,
   reconciliation, scheduler creation, or listen attempt. Exit 75 is the
   dedicated temporary-failure status for every refused acquisition; the marker
   and a bounded `reason` distinguish held-lock conflicts from ambiguous stale
   evidence. Missing/malformed diagnostics do not weaken the conflict.
4. If the lock is acquired, inventory bounded safe temp debris from §2.1, then
   apply the pairwise stable/owner matrix below without mutation. On a refusing
   pair, leave the entire entry byte-for-byte unchanged. Only after an advancing
   pair is validated may the process remove safe temp debris and write. Never
   infer first start from one missing file in isolation.
5. If the prior valid record says `released`, treat it as a clean handoff,
   atomically write the new `state=owned` record, and continue.
6. If the prior valid record says `owned`, recovery is permitted only when its
   canonical root and stable ID match, its hostname equals the current host,
   and `process.kill(recordedPid, 0)` throws exactly `ESRCH`. Log
   `CONTROL_PLANE_OWNERSHIP_RECOVERED` with old/new incarnation IDs before
   replacing the record.
7. A successful PID probe is recorded as
   `pid-present-owner-identity-ambiguous`; `EPERM`, an unknown error, a foreign
   host, invalid PID, malformed JSON/schema, root/identity mismatch, or a
   filesystem/descriptor error is also ambiguous. Unlock/close and emit a
   fail-closed diagnostic; do not reconcile, listen, delete, rewrite durable
   evidence, or retry by elapsed time. The protocol neither detects nor claims
   to detect PID reuse.

Pairwise stable-ID/owner-file matrix, evaluated only with the lock held:

| Stable-ID file | Owner file | Decision |
|---|---|---|
| absent | absent | Documented first start: atomically create the stable ID, then `owned` |
| valid | absent | Documented crash after stable-ID rename and before first owner rename: retain the stable ID and create `owned` |
| valid | valid `released`, all root/digest/ID fields match | Clean handoff; write new `owned` incarnation |
| valid | valid `owned`, all root/digest/ID fields match | Apply the hostname/PID recovery rule above |
| absent | present in any form | Refuse byte-for-byte unchanged |
| malformed/unsupported stable record | absent, valid, or malformed owner | Refuse byte-for-byte unchanged |
| valid stable record | malformed/unsupported owner | Refuse byte-for-byte unchanged |
| valid stable record | valid owner with any root/digest/control-plane-ID mismatch | Refuse byte-for-byte unchanged |

The two advancing partial states are therefore only a wholly empty durable pair
and a valid stable ID with no owner record. Tests snapshot the entire entry
before a refusal. A leftover validly named temp file is handled separately by
§2.1 and does not make a malformed durable pair valid.

Successful `flock` is the cross-process serialization point; the PID/host check
is the stricter stale-owner recovery policy required by CP-A. Neither mtime nor
wall-clock age grants ownership.

### 2.4 Held capability and shutdown ordering

`acquireControlPlaneOwnership` returns one in-memory capability containing the
canonical root and its pinned identity, configured spelling, stable/incarnation
identity, `assertHeld()`, and idempotent `release()`. Production startup passes
that exact canonical root and assertion into `createApp` and startup
reconciliation. No live destructive path may re-read the environment to select
another root. Once an assertion detects path/inode/root retargeting, the
capability stays poisoned and the common shutdown path runs without further
reconciliation.

Startup order:

1. load `.env`;
2. import only root/ownership code;
3. canonicalize root and acquire ownership;
4. import Prisma, application, reconciliation, scheduler, and Files modules;
5. validate Files/root isolation against the canonical root;
6. assert ownership and run startup reconciliation;
7. create the HTTP server and await a Promise that resolves only on its
   `listening` event and rejects on a pre-listen `error`;
8. emit the listening marker only after resolution, then start the scheduler.

Shutdown or startup-failure order:

1. atomically select one idempotent cleanup owner and stop/clear scheduler;
2. stop accepting HTTP and await server close/drain callback if a server exists;
3. disconnect Prisma if imported;
4. if the capability is still valid, while locked atomically write
   `state=released`; if integrity was lost, retain prior evidence and emit a
   refusal rather than claiming a clean release;
5. unlock and close the ownership descriptor;
6. emit and flush the terminal marker, set `process.exitCode`, and let handles
   close naturally. Do not call immediate `process.exit()` in ordinary paths.

Pre-listen `error`, including `EADDRINUSE`, rejects into this same cleanup.
`SIGINT`/`SIGTERM` received during import, reconciliation, or listen also joins
it and no later phase may start. Scheduler creation is impossible until the
listen Promise resolves. Terminal marker write completion precedes exit-code
observation in child-process tests.

`SIGKILL` cannot run cleanup; that is intentional. `FD_CLOEXEC` prevents a
spawned/execed descendant from inheriting the descriptor, so after the owner
dies the kernel releases the lock even when a long-lived child remains. The
`owned` record remains as crash evidence, and the next process must pass the
dead-owner rule above.

### 2.5 Lock ordering and failure surface

The process-wide order is always **protected control-state flock →
Prisma/database work
or task-row locks**. Ownership is acquired once before Prisma is imported and
is never acquired or upgraded inside a request, database transaction, runner
claim, reconciliation pass, or scheduler tick. Metadata temp-file writes occur
while the flock is held and do not acquire an application/database lock.
Shutdown finishes HTTP/database work before releasing the flock. This single
outer lock order prevents an ownership/transaction cycle and leaves all
existing task-row and Run fencing order unchanged.

The exact markers are `CONTROL_PLANE_OWNERSHIP_ACQUIRED`,
`CONTROL_PLANE_OWNERSHIP_RECOVERED`, `CONTROL_PLANE_OWNERSHIP_CONFLICT` (held
flock), `CONTROL_PLANE_OWNERSHIP_REFUSED` (ambiguous evidence or lock failure),
and `CONTROL_PLANE_OWNERSHIP_RELEASED`. Each is a one-line, machine-greppable
record with the canonical root, safe identity fields, and a bounded reason; it
never contains `DATABASE_URL`. A supervisor such as the shipped launchd
`KeepAlive` configuration may retry exit 75, so operations must identify and
stop the duplicate service/process instead of deleting lock or evidence files.
No launchd behavior is changed by CP-A.

## 3. Ordered implementation steps

### Step 1 — Add the canonical-root ownership primitive

**Files:** new `packages/api/src/workspace-root.ts`; new
`packages/api/src/control-plane-state.ts`; new
`packages/api/src/control-plane-ownership.ts`; new
`packages/api/src/control-plane-ownership.test.ts`;
`packages/api/package.json`; `package-lock.json`; move/re-export
`defaultWorkspaceRoot` from `packages/api/src/reconcile.ts` as needed by
existing imports.

**Changes:**

1. Put `defaultWorkspaceRoot()` and `canonicalizeWorkspaceRoot()` in
   `workspace-root.ts`. Preserve today's default (`~/.agentos/runs`) and lexical
   `resolve` behavior, create the root, then use `realpath` plus `lstat` identity
   for ownership; retain the configured spelling for retarget checks.
2. Implement the protected control-state path, digest collision/root check,
   API-uid/mode/symlink/overlap validation, explicit local-filesystem allowlist,
   and bounded temp cleanup in `control-plane-state.ts`. `RUNNER_WORKSPACE_ROOT`
   itself is not required to implement `flock`; the verified state directory is.
3. Implement the protocol and complete pairwise matrix in §2 with a narrow
   `fs-ext`/`fcntl` wrapper, typed record parsers, atomic same-directory metadata
   writes, redaction-safe typed errors, descriptor/path/root integrity in
   `assertHeld`, permanent capability poisoning, and idempotent `release`.
4. Never unlink or rename the persistent lock file. Never mutate durable owner
   evidence after a conflict or ambiguous stale check. Temp cleanup is limited
   to §2.1's exact regular-file grammar while the validated lock is held.
5. Add `fs-ext` and its types to the API workspace and lockfile only; do not add
   a database model, heartbeat, expiry, or runner dependency.

**Verification:**

- `UT-OWN-INTEGRITY` uses temporary physical roots plus injectable
  platform/liveness
  probes to prove: symlink/lexical aliases canonicalize identically; digest/root
  matching; state-dir uid/mode/symlink/overlap checks; every allowed and refused
  filesystem mapping; stable ID survives clean reacquire while incarnation
  changes; and `FD_CLOEXEC` is required rather than assumed.
- `UT-OWN-STATE-MATRIX` covers every §2.3 stable/owner pair: empty first start;
  post-stable/pre-owner crash retaining the stable ID; released and dead-owned
  advancement; missing/malformed stable evidence; owner-without-stable;
  malformed owner; and released/owned root, digest, or ID mismatch. All refused
  states remain byte-for-byte unchanged.
- Protocol tests prove held-lock conflict; `ESRCH` recovery;
  `pid-present-owner-identity-ambiguous`, `EPERM`, foreign host, invalid PID,
  root mismatch, and unknown errors fail closed; clean release writes before
  unlock; double release is harmless; and one leftover safe temp is removed
  without touching `ownership.lock` while unsafe/unexpected debris refuses.
- Add child-process probes so contention, unsupported/unknown filesystem
  refusal, missing CLOEXEC refusal, and lock-path unlink/rename/recreate are not
  inferred only from mocks. In the replacement case A's next `assertHeld()` is
  permanently poisoned, B refuses because the durable live-owner evidence is
  ambiguous, and neither child reaches reconciliation/listen. Also assert that
  changing the configured root symlink target poisons A before GC. Name the
  adversarial replacement/retarget group `RP-OWN-REPLACE`.
- Run `npm ci`, then
  `npm run test -w @agentos/api -- --test-name-pattern=control-plane` and
  `npm run typecheck -w @agentos/api`.

### Step 2 — Make ownership the first and last API lifecycle operation

**Files:** `packages/api/src/index.ts`; `packages/api/src/app.ts`;
`packages/api/src/reconcile.ts`; new `packages/api/src/test-app.ts`;
`packages/api/src/app.test.ts`; `packages/api/src/control-plane.test.ts`; and
the existing direct app-factory callers migrated mechanically to the test-only
factory: `packages/api/src/{agent-foundation.dbtest.ts,agent-tools.dbtest.ts,chain-branch.dbtest.ts,chain.dbtest.ts,goals.test.ts,hooks.dbtest.ts,hooks.test.ts,runners.test.ts,scheduler.dbtest.ts,tasks.dbtest.ts,triggers.dbtest.ts,workflow.test.ts}`
and `packages/api/src/files/{grant-alias.test.ts,routes.test.ts,session-routes.test.ts}`.

**Changes:**

1. Replace the current parallel pre-ownership imports in `index.ts` with the
   exact startup state machine in §2.4. Import `@agentos/db`, `app`, reconcile,
   scheduler, and Files configuration only after acquisition.
2. Import `createApp`, not the eager exported singleton. Extend `createApp` with
   required immutable live options containing the canonical workspace root and
   ownership assertion; remove the unused module-level `app` export so the
   production entrypoint cannot silently use default/env-derived GC state. Add
   a test-only app factory/capability for direct Hono tests; production code
   cannot obtain or default to that no-op capability.
3. Pass the canonical root to Files/root isolation and
   `reconcileAtStartup`; call `assertHeld()` immediately before startup
   reconciliation.
4. Assert the same held capability immediately before claim-time
   `reconcileDatabaseRuns` and post-run `reconcileWorkspaces`; the latter uses
   only the captured canonical root. An assertion failure must prevent that
   reconciliation call and must not be swallowed as an ordinary GC failure.
5. Wrap server startup in the normative listen Promise from §2.4, start the
   scheduler only after `listening`, and implement one idempotent awaited
   shutdown path for `SIGINT`, `SIGTERM`, pre-listen `error`, startup exceptions,
   and normal test teardown. Release ownership only after scheduler, HTTP, and
   Prisma are stopped.
6. Emit and flush the exact machine-greppable terminal markers from §2.5 before
   setting `process.exitCode`; exit 75 on every
   conflict/refusal before importing database/application code.
   A conflict message names root and available owner identity, says that no
   reconciliation/listen occurred, and exits non-zero without a stack trace or
   secret.

**Verification:**

- API unit tests capture `createApp` options and prove both claim-time database
  reconciliation and post-run GC assert ownership first; post-run GC receives
  the immutable canonical root and neither reconciler runs when
  `assertHeld()` fails.
- An entrypoint ordering test supplies an already-held root and an invalid or
  query-trapping database URL; the process must emit only the ownership
  conflict, exit 75, and avoid importing/connecting to Prisma, printing
  `Startup reconciliation`, or printing `listening`.
- `RP-OWN-LIFECYCLE` production-entrypoint tests reserve the requested port to
  force `EADDRINUSE`, signal the process while startup reconciliation is held at
  a test barrier, and exercise a normal signal after listen. They assert no
  scheduler-before-listen, one cleanup, awaited close/disconnect/release order,
  no clean-release claim after capability poisoning, and terminal-marker flush
  before the observed exit code.
- Existing reconciliation tests remain green; a focused fixture proves the
  workspace contains no ownership artifacts and that reconciliation is passed
  only the pinned canonical root.
- Run `npm run test -w @agentos/api` and
  `npm run typecheck -w @agentos/api`.

### Step 3 — Prove same-DB and copied-DB conflicts with real processes

**Files:** new `packages/api/src/control-plane-ownership.dbtest.ts`;
`packages/api/src/testdb.ts` (bounded scratch-database helpers only);
`packages/api/package.json` (ensure the API is built before the process DB
suite if it spawns `dist/index.js`).

**Changes:**

1. Extend test infrastructure with a narrowly guarded scratch database helper.
   This new physical-database mode has no fallback: it refuses unless both
   `AGENTOS_ALLOW_SCRATCH_DATABASES=1` and an explicit `TEST_DATABASE_URL` are
   present, and also requires a distinct explicit
   `TEST_DATABASE_MAINTENANCE_URL` on the same dedicated server. It parses both,
   preserves Prisma's `schema` parameter when deriving generated database URLs,
   refuses the repository's default `agentos` target, source/maintenance
   equality, cross-server or cross-role URLs, and any URL/name not matching the
   test-only contract, and never logs credentials.
2. Connect only through `TEST_DATABASE_MAINTENANCE_URL` for create/drop and
   verify the session user has `rolcreatedb` before creating anything. Create
   uniquely prefixed, random, distinct PostgreSQL **database
   names** (not merely two schemas), record each exact name in an in-memory
   allowlist before use, apply only committed migrations to source A, close all
   source connections, and clone A to B with PostgreSQL template copy before
   either API connects. Refuse an existing target, active template connection,
   source/target equality, maintenance/source equality, or an unrecognized
   prefix. Cleanup may terminate only connections owned by the exact recorded
   scratch database and must refuse to drop any name absent from the allowlist.
3. Spawn the built production entrypoint with explicit isolated environment:
   scratch `DATABASE_URL`, `API_HOST=127.0.0.1`, `API_PORT=0`,
   `SCHEDULER_POLL_INTERVAL_MS=0`, distinct Files and verified local
   control-state temp roots, one shared physical workspace temp root, and
   test-only tokens. Treat
   `CONTROL_PLANE_OWNERSHIP_ACQUIRED` followed by `listening` as ready.
4. **Same DB / same canonical physical root through aliases:** give owner A the
   real workspace path and B a symlink path containing a lexical `..` segment
   that resolves to the same directory. After A listens, insert an expired
   active Run and an orphan directory. Start B with the same database.
   Assert B exits 75 with conflict before reconciliation/listen, the Run
   is unchanged, the directory still exists, and both markers contain the same
   canonical root. This wires canonicalization through two production
   entrypoints rather than only testing its helper.
5. **Copied DB / same canonical root:** create DB B as a physical copy of an
   empty, migrated scratch DB A before startup. Start owner A, then put an
   expired active Run in copied DB B and an orphan directory in the shared temp
   root. Start B against the copy. Assert the same exit-75 early conflict and that both
   database state and directory are unchanged.
6. Assert the losing process never writes acquired/recovered/released evidence
   and that owner A remains healthy. Teardown terminates only recorded child
   PIDs, awaits exit, disconnects clients, and removes only recorded temp roots
   and scratch databases.

**Verification:**

- Run
  `npm run test:db -w @agentos/api -- --test-name-pattern='workspace-root ownership'`
  only with `AGENTOS_ALLOW_SCRATCH_DATABASES=1`, an explicitly dedicated
  redacted `TEST_DATABASE_URL` plus `TEST_DATABASE_MAINTENANCE_URL`, and a role
  whose preflight proves `rolcreatedb`. Both conflict shapes must pass without
  retries.
- `DB-HARNESS-GUARD` negative tests cover unset opt-in, either unset/default URL,
  cross-server/role URLs, insufficient privilege, existing target, active
  template connection, source/target and maintenance/source equality,
  schema-query preservation, and attempted cleanup of an unrecorded name. Each
  refuses before an unauthorized create/drop statement.
- Inspect captured markers to prove the order: owner acquired → owner
  reconciled → owner listened; loser conflict → loser exited, with no loser
  reconcile/listen marker.
- Record the same-DB case as `RP-OWN-SAME-ALIAS` and the copied-DB case as
  `RP-OWN-COPY`; each name must appear in the test runner output.
- A failure to prove the maintenance/allowlist contract or create an isolated
  scratch copy is a failed gate; do not replace
  it with a live-data copy or the live root.

### Step 4 — Prove crash recovery and preserve multiple runner daemons

**Files:** `packages/api/src/control-plane-ownership.dbtest.ts`;
`packages/api/src/runners.test.ts` only if an additional focused registry
assertion is needed.

**Changes:**

1. Add `RP-OWN-RECOVERY-DESCENDANT`, a real-process crash/inheritance case:
   start an owner on a scratch
   DB/root, make it spawn+exec a long-lived child after acquisition, capture
   stable and incarnation IDs, send `SIGKILL` only to the owner, await confirmed
   owner exit, prove the descendant remains alive, and verify `owner.json` still
   says `owned`. Start a successor on the same root. It must obtain the released
   kernel lock despite the live descendant (proving non-inheritance), observe
   `ESRCH` for the recorded owner PID, emit
   `CONTROL_PLANE_OWNERSHIP_RECOVERED`, retain the stable ID, allocate a new
   incarnation, reconcile, and listen. Teardown then terminates the recorded
   descendant PID.
2. Pair it with fail-closed cases using a free kernel lock plus synthetic valid
   `owned` records for a present PID (`pid-present-owner-identity-ambiguous`) and
   `EPERM`/unknown probes. Each exits before reconciliation/listen and leaves
   durable evidence byte-for-byte unchanged. Do not label any case “PID reuse
   detected.”
3. In `RP-RUNNERS-TWO`, while one owner is listening on a clean scratch
   database, send claim polls
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

1. Document the invariant, `CONTROL_PLANE_STATE_DIR`, its digest-named per-root
   entries and three durable files plus bounded transient temp grammar,
   stable/incarnation identity, exact log markers, conflict exit, complete
   partial-state/recovery tables, supported multiple-runner topology, and why a
   DB lease cannot provide cross-database exclusion. State plainly that no
   ownership file lives in the runner-writable workspace root.
2. State the future activation preflight but do not perform it: select one
   canonical `RUNNER_WORKSPACE_ROOT`; select a disjoint
   `CONTROL_PLANE_STATE_DIR`; prove the latter's filesystem type is on the exact
   source allowlist, owner/mode are API-uid/`0700`, there are no symlinked
   components, and each actual runner daemon/model principal gets permission
   denied from `test -r/-w` there. The API uid must differ from every runner and
   model uid; `ps -o pid,uid,command` plus an access probe executed as each
   configured runner principal are required evidence. Verify every API/runner
   root config agrees, drain Runs, stop the old API, install/build, start exactly
   one new API, and verify acquired → reconciliation → listening order. Runner
   daemons may be restarted/continued only under the existing runner procedure;
   they do not own the root. This plan performs none of those activation steps.
3. Name exact operator evidence: canonical root, stable/incarnation IDs, PID and
   host from the acquired line; state-directory canonical path, filesystem type,
   device, uid/mode and runner-denied access probes; open/path lock dev+inode;
   absence of reconcile/listen after a deliberate isolated conflict rehearsal;
   recovery line after a killed isolated owner with a live descendant; focused
   test names; and final gate command/exit codes. Pathname shape is not
   filesystem evidence. Never suggest a test against live state.
4. Document ambiguity handling: do not delete lock/evidence because a PID is
   merely old or a timestamp elapsed. Call a successful probe
   `pid-present-owner-identity-ambiguous`; stop on it, `EPERM`, foreign host,
   malformed/partial record outside the two allowed advancing states,
   filesystem/CLOEXEC/inode failure, root symlink retarget, or root mismatch.
   Do not claim PID reuse detection. Never delete/recreate `ownership.lock` as
   recovery. Explain that matching temp crash debris is removed only by the
   owner under lock and other debris requires investigation.
5. Document rollback: drain/stop the new API; revert the ownership code and
   `fs-ext` dependency/lockfile and configuration changes; rebuild; leave the
   protected `CONTROL_PLANE_STATE_DIR` and its three durable files/temp debris
   untouched; start only one old API under a manual single-control-plane rule.
   No database rollback or workspace deletion is involved. Explicitly warn that
   code rollback removes enforced protection and therefore must never be used to
   run two APIs. Removing control-state artifacts is a separate manual cleanup
   after rollback, not part of recovery or rollback.

**Verification:**

- Run a documentation grep/check proving every marker, durable filename, temp
  grammar, environment variable, supported filesystem mapping, and refusal
  reason in the runbook matches source/tests.
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
test database/server and unique scratch names. Before any DB suite, assert and
record (without credentials) that `AGENTOS_ALLOW_SCRATCH_DATABASES=1`,
`TEST_DATABASE_URL` and `TEST_DATABASE_MAINTENANCE_URL` are explicitly set to
distinct databases on the dedicated server, and the harness preflight reports
the redacted host/port/maintenance database, schema parameter, matching role,
`rolcreatedb=true`, and empty per-test allowlist. An unset value is a failed
gate; never use `testdb.ts`'s legacy fallback. Do not retry a red concurrency
test until it becomes green; diagnose the first failure.

**Verification gates, in order:**

```sh
npm ci
npm run db:validate
npm run test -w @agentos/api
npm run test -w @agentos/runner
# secure environment already contains both explicit test URLs; record them redacted
AGENTOS_ALLOW_SCRATCH_DATABASES=1 npm run test:db -w @agentos/api
npm run typecheck
npm run build
npm test
npm run snapshot:scan
npm run test:snapshot-scan
```

Also run `git diff --check` and confirm `git status --short` contains only the
planned files. Record the redacted safe environment assertion, command, exit
code, test counts, scratch root/state-root/database identifiers (names only, no
credentials), filesystem/principal preflight, and the
acquired/conflict/refused/recovered/released marker sequences. Any affected full
gate failure blocks completion.

## 4. Acceptance and evidence matrix

| Contract acceptance | Numbered work items | Required executable evidence |
|---|---|---|
| 1. Same DB/root loser fails before reconcile/listen | Steps 1.1–1.5, 2.1–2.6, 3.3–3.4 | `RP-OWN-SAME-ALIAS`: two production entrypoints use real versus symlink/`..` spellings, emit one canonical root, loser conflict only, expired Run unchanged |
| 2. Copied/different DB/root loser also fails | Steps 1.2–1.5, 2.1–2.6, 3.1–3.3 and 3.5 | `RP-OWN-COPY`: physical scratch DB copy, common canonical root, unchanged copied-DB fixture, loser conflict only |
| 3. Loser cannot reconcile or delete workspaces | Steps 2.3–2.6 and 3.4–3.6 | Both `RP-OWN-SAME-ALIAS` and `RP-OWN-COPY`: database sentinel and orphan directory survive; no loser reconcile/listen/acquired marker |
| 4. Multiple runner daemons remain supported | Steps 2.2–2.4 and 4.3 | `RP-RUNNERS-TWO`: two runner IDs poll one owned API/root and appear in `/runners`; runner product diff remains empty |
| 5. Recovery only after demonstrably dead owner; ambiguity fails closed | Steps 1.3–1.4 and 4.1–4.2 | `RP-OWN-RECOVERY-DESCENDANT`: `SIGKILL`, awaited owner exit, live descendant, `ESRCH`, retained stable ID; `UT-OWN-STATE-MATRIX` and refusal process cases preserve bytes for PID-present/`EPERM`/malformed states |
| 6. Focused unit and real-process/database tests | Steps 1–4 | `UT-OWN-STATE-MATRIX`, `UT-OWN-INTEGRITY`, `DB-HARNESS-GUARD`, `RP-OWN-REPLACE`, `RP-OWN-LIFECYCLE`, `RP-OWN-SAME-ALIAS`, `RP-OWN-COPY`, and `RP-OWN-RECOVERY-DESCENDANT` all pass without retries |
| 7. Full affected tests/typecheck/build pass | Step 6 | Exact safe-environment preflight and gate list, exit codes, and counts recorded once on final tree |
| 8. English rollback/operations evidence without activation | Steps 5.1–5.5 | New runbook names protected state, filesystem/principal evidence, markers, safe rehearsal, debris handling, and code-only rollback; activation diff is absent |

Scope requirements are also covered: canonical cross-process/cross-database
ownership (Steps 1–3), stable owner identity and partial-state handling (Step 1),
acquisition before work and joined asynchronous startup/shutdown (Step 2),
fail-closed UX (Steps 1–2), stale recovery without descriptor inheritance
(Steps 1 and 4), runner compatibility (Step 4), lock ordering/lifecycle (Steps
1–2), and rollback/operator evidence (Step 5).

## 5. Consolidated review conflict ledger

| Finding | Decision | Plan resolution and proof |
|---|---|---|
| MF-1 writable root-local lock inode | **Addressed.** | §2.1 moves authority to API-only `CONTROL_PLANE_STATE_DIR`, requires distinct runner/model principals and `0700` DAC, validates open/path inode identity, and Step 1 adds `RP-OWN-REPLACE`. Manual deletion is never recovery. |
| MF-2 unenforced filesystem semantics | **Addressed.** | §2.1 makes the authoritative state filesystem independently verified with an explicit local allowlist and refuses network/FUSE/unknown types; Step 1 tests the map/refusals and Step 5 names exact operator evidence. Workspace filesystem locks are not relied upon. |
| MF-3 descriptor inheritance | **Addressed.** | §§2.1/2.4 require verified `FD_CLOEXEC`; Step 4.1 keeps an execed descendant alive across owner `SIGKILL` and proves successor recovery. |
| MF-4 production canonicalization wiring | **Addressed.** | Step 3.4 runs real-path versus symlink-plus-`..` production entrypoints and asserts a common emitted canonical root; Step 1 also poisons a capability on root retarget. Sentinels remain required. |
| MF-5 asynchronous listen/shutdown | **Addressed.** | §2.4 specifies the awaited listen Promise, scheduler gate, awaited close/drain, idempotent cleanup, and marker flush/`exitCode`; Step 2 adds `EADDRINUSE`, signal-during-reconcile, and ordering process tests. |
| MF-6 unsafe scratch DB fallback/CREATEDB | **Addressed.** | Step 3.1–3.2 requires explicit opt-in and URL, maintenance DB plus `rolcreatedb`, exact-name allowlist, safe URL derivation, guarded cleanup, and all requested negative tests; Step 6 records the redacted environment. |
| SF-1 PID reuse claim | **Adopted.** | All prose/tests use `pid-present-owner-identity-ambiguous`; no process-birth fingerprint or PID-reuse detection is claimed. This is the smaller fail-closed correction. |
| SF-2 partial recovery matrix | **Adopted.** | §2.3 defines the full pairwise matrix; Step 1 tests each state, including stable-ID-created/owner-missing retention and byte-preserving refusals. |
| SF-3 atomic-write temp debris | **Adopted.** | §2.1 defines one bounded temp grammar and safe under-lock cleanup; Steps 1 and 5 test/document debris without touching the lock inode. |

No should-fix is declined. Consequential edits forced by these findings are the
new protected-state module/configuration and deployment preflight, platform
filesystem/CLOEXEC inspection, stronger production process fixtures, and the
physical-database safety contract. The Product Contract, Planned Critical route,
six-step sequencing, no-migration decision, runner concurrency, and
non-activation boundary are unchanged.

## 6. Review and implementation checkpoints

- The review must reject any design based only on a database advisory lock,
  database lease/generation, port binding, PID file, mtime expiry, or
  check-then-delete lockfile. Those do not satisfy copied-database exclusion or
  safe crash recovery.
- The implementation must not unlink/replace the persistent flock inode. Doing
  so permits two processes to lock different inodes at the same pathname.
  `assertHeld()` must poison the capability on descriptor/path or pinned-root
  identity drift, and protected-directory DAC is an activation prerequisite.
- The implementation must prove the control-state filesystem is supported and
  the descriptor is close-on-exec. Absolute path shape, a successful host probe,
  or today's Node defaults are not substitutes for executable evidence.
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

## 7. Rollback summary

There is no data migration and no workspace content transformation. The safe
code rollback is: drain work, stop the new API, revert Steps 1–2 dependency and
code/configuration changes, rebuild, and start exactly one old API. Leave the
protected control-state directory, lock, JSON evidence, and any bounded temp
debris untouched; it is outside workspace GC. This restores the prior software
but also restores the prior risk, so manual single-instance operation is
mandatory until CP-A is re-applied. Full operator detail and exact evidence
belong in `docs/runbooks/control-plane-workspace-ownership.md` from Step 5.
