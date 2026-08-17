# Control-plane workspace-root ownership

## Invariant and topology

One canonical `RUNNER_WORKSPACE_ROOT` has at most one active AgentOS API control
plane on a host. The invariant holds when contenders use the same database,
different databases, or a physical database copy: a database lease cannot
exclude a process whose database has no shared rows. Any number of runner
daemons may poll the one owning API and use its workspace root. Runners and
model processes never acquire or write control-plane ownership state.

The API canonicalizes the configured workspace path with `realpath`, pins its
device/inode, hashes the canonical path with SHA-256, and uses that digest as a
directory below `CONTROL_PLANE_STATE_DIR` (default
`~/.agentos/control-plane`). No ownership artifact lives in the runner-writable
workspace. Each digest directory has three durable regular files:

- `ownership.lock`: mode `0600`; its persistent inode is opened with
  `FD_CLOEXEC` and held by non-blocking exclusive `flock`. Never unlink, rename,
  replace, or recreate it as recovery.
- `control-plane-id.json`: the stable UUID, canonical root, digest, and format.
  It survives clean restarts.
- `owner.json`: the current or last incarnation, PID, hostname, root identity,
  persistent lock device/inode, acquisition time, and `owned` or `released`
  state. Every process gets a new incarnation UUID.

Atomic writes can leave one bounded crash-debris grammar:
`.control-plane-id.json.tmp-<pid>-<incarnation-uuid>` or
`.owner.json.tmp-<pid>-<incarnation-uuid>`. A successful owner removes only
matching, API-owned, mode-`0600` regular temp files while holding the lock.
Anything else is refused for investigation; the lock inode is never cleanup.

## Enforced preflight

The canonical state directory and digest entry must be owned by the API
effective uid, mode `0700`, contain no symlinked component, and be disjoint from
both workspace and Files roots. The implementation admits only these `statfs`
types: Darwin APFS/HFS+; Linux ext2/3/4, XFS, Btrfs, tmpfs, and local overlayfs.
NFS, SMB/CIFS, FUSE, and unknown types fail closed. Pathname shape is not
filesystem evidence. The open descriptor must prove `FD_CLOEXEC`, and open/path
lock device+inode must match. Every destructive assertion rechecks those values
and the pinned workspace root target/device/inode; drift permanently poisons
the capability and prevents reconciliation.

Production activation additionally requires a distinct API uid and distinct
runner/model uids. Record `ps -o pid,uid,command` and run read/write access
probes as every configured runner/model principal; each must receive permission
denied for `CONTROL_PLANE_STATE_DIR`. The shipped same-principal development
default is not CP-A activation-ready.

## Startup, markers, and conflict evidence

Ownership is acquired before importing Prisma, the application, reconciliation,
the scheduler, or Files modules. Startup then validates root isolation, asserts
the capability, reconciles, awaits the HTTP `listening` event, emits the listen
line, and only then starts the scheduler. A pre-listen error and signals use the
same idempotent cleanup: stop scheduler, await HTTP close, disconnect Prisma,
write a clean release while still locked, unlock/close, flush the terminal
marker, and set the exit code.

Machine-greppable ownership markers are exactly:

- `CONTROL_PLANE_OWNERSHIP_ACQUIRED`
- `CONTROL_PLANE_OWNERSHIP_RECOVERED`
- `CONTROL_PLANE_OWNERSHIP_CONFLICT`
- `CONTROL_PLANE_OWNERSHIP_REFUSED`
- `CONTROL_PLANE_OWNERSHIP_RELEASED`

A held-lock conflict emits only `CONTROL_PLANE_OWNERSHIP_CONFLICT` and exits
with `CONTROL_PLANE_OWNERSHIP_EXIT_CODE=75` before reconciliation or listen.
Other acquisition ambiguity emits `CONTROL_PLANE_OWNERSHIP_REFUSED` and also
exits 75. Logs include only safe root, stable/incarnation identity, PID/host,
filesystem and inode evidence, and a bounded reason; database URLs and
credentials are never logged.

For operator evidence record: canonical root; state directory canonical path,
filesystem type/device, uid/mode; stable/incarnation IDs, PID and host from the
acquired line; open/path lock device+inode; acquired -> startup reconciliation
-> listening order; runner/model permission-denied probes; and final test gate
commands/exit codes. An isolated conflict rehearsal must show conflict -> exit
with no acquired/reconcile/listen marker from the loser. An isolated killed
owner rehearsal with a still-live execed descendant must show recovered ->
acquired for the successor. Never rehearse against a live database, a live-data
copy, or a live workspace root.

The code-review regressions are pinned by these exact focused checks:

```sh
node --import tsx --test --test-name-pattern='RP-OWN-FILES-ALIAS' packages/api/src/control-plane-ownership.test.ts
# With the explicitly opted-in scratch environment described below:
AGENTOS_ALLOW_SCRATCH_DATABASES=1 node --import tsx --test --test-concurrency=1 --test-name-pattern='workspace-root ownership real-process database acceptance' packages/api/src/control-plane-ownership.dbtest.ts
```

The database test must emit `RP-OWN-FILES-WRITER`, `RP-OWN-LIFECYCLE signal
plus reconciliation failure`, `RP-OWN-RECOVERY-DESCENDANT`, and
`RP-RUNNERS-TWO`. The first and same-database loser checks jointly prove that a
Files API request cannot replace ownership state and that a contender still
exits 75 while the original descriptor remains locked. The lifecycle check
proves a signal racing a reconciliation rejection releases ownership and keeps
the failure exit nonzero. The recovery and runner checks use production
entrypoints and one genuinely owned API, respectively. Use only generated temp
roots plus physical scratch databases; unset safe DB variables must skip/refuse
the suite, never fall back to live state.

## Recovery decision table

Recovery is serialized by the acquired kernel lock. Elapsed time and mtime
never grant ownership.

| Stable ID | Owner evidence | Decision |
| --- | --- | --- |
| absent | absent | first start: create stable ID, then `owned` |
| valid | absent | retain stable ID after the one allowed partial first write; create `owned` |
| valid | matching `released` | clean handoff; create a new incarnation |
| valid | matching `owned`, same host, PID probe is exactly `ESRCH` | emit recovered, retain stable ID, create a new incarnation |
| absent | present in any form | refuse unchanged |
| malformed/unsupported stable | any owner state | refuse unchanged |
| valid stable | malformed owner or any root/digest/ID mismatch | refuse unchanged |

A successful PID probe means
`pid-present-owner-identity-ambiguous`; it does not prove identity and the code
does not claim PID-reuse detection. `EPERM`, unknown probe errors, foreign host,
invalid PID, filesystem/CLOEXEC/inode failure, root symlink retarget, malformed
evidence, and every other ambiguity fail closed and preserve durable bytes. Do
not delete evidence because a PID looks old or a timestamp elapsed.

## Future activation preflight (not performed by CP-A)

1. Select one canonical local `RUNNER_WORKSPACE_ROOT` and verify every API and
   runner config agrees. Select a disjoint `CONTROL_PLANE_STATE_DIR`.
2. Prove the state filesystem type is on the source allowlist, its canonical
   path has no symlink components, and the base is API-owned mode `0700`.
3. Prove the API uid differs from every runner/model uid using process evidence,
   and run denied read/write probes as each runner/model principal.
4. Drain Runs and stop the old API. Install/build the reviewed code, then start
   exactly one new API. This is a future operator action, not performed here.
5. Verify acquired -> startup reconciliation -> listening in that order and
   retain the exact evidence above. Continue/restart runner daemons only under
   their existing procedure; runners do not own the root.

## Code-only rollback

Drain work and stop the new API. Revert the ownership modules, startup/app
wiring, `CONTROL_PLANE_STATE_DIR` configuration, and `fs-ext` dependency and
lockfile changes; rebuild; then start exactly one old API under a manual
single-control-plane rule. Leave the protected state directory, all three
durable files, and bounded temp debris untouched. Old workspace reconciliation
does not scan this disjoint directory. No database rollback and no workspace
deletion are involved.

Rollback removes enforced protection. It must never be used to run two APIs.
Removing control-state artifacts is a separate deliberate manual cleanup after
rollback, never part of recovery or rollback itself.
