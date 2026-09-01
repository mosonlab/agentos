# Quiet-window auto-deploy

> **Audience and support status.** This runbook documents the repository
> maintainer's macOS appliance-deployment profile. It is published for
> auditability and reproducibility, but it is not part of the Developer Preview
> Quickstart, the supported installation shape, or a production-support
> commitment.

This job advances the macOS appliance from the release named by `current` to an
exact `main` commit. It controls `com.agentos.api`, `com.agentos.inbox`, ten
runner labels, and `com.agentos.web`. The release artifact also carries the
resident merge-executor runtime, but that process is outside this thirteen-label
activation set. The job never deploys an Anneal run workspace.

## Runtime layout

```text
releases/<commit>-<digest>/   immutable, verified runtime artifacts
shared/.env                   mode-0600 operator configuration
shared/{files,runs,state,...} mutable operator data
shared/bin/                   stable service wrapper
current -> releases/...       activation authority
previous -> releases/...      pointer rollback target
```

Release artifacts contain the compiled applications, runtime dependency graph,
Prisma schema, DB maintenance source modules, generated client, native assets,
deployment scripts, build stamps, and canonical agent sources. The verifier
checks every Prisma maintenance import rooted at `packages/db/src` before the
quiet window. Release artifacts contain no `.env`, credentials, or
mutable operator state. Every excluded secret-shaped path is written to the
builder log and the release manifest.

The source checkout is inspection state. Services and auto-deploy run through
`current`; deployment does not read, fast-forward, clean, or publish files from
the source checkout. Development happens in an independent clone or worktree.

`com.agentos.web` serves `apps/web/dist` with Vite preview on
`http://127.0.0.1:4173`. The numeric loopback address is intentional; the
credential-bearing proxy rejects other origins.

## Preconditions

Run operator commands as the account that owns the LaunchAgents, never as
root. Require:

- `current` and `previous` to be relative symlinks to direct children of
  `releases/`;
- `shared/.env` to be mode 0600 and contain `DATABASE_URL`,
  `FEISHU_DEFAULT_CHAT_ID`, and the five absolute persistent paths beneath
  `shared/`;
- all thirteen service labels to use `shared/bin/agentos-service-wrapper.mjs`;
- the configured PostgreSQL container and its `pg_dump` binary to be running;
- the source remote, Node, npm CLI, Git, and Docker paths recorded in the
  auto-deploy plist to remain executable.

Do not delete or synchronize legacy mutable-data roots during deploy. Their
retirement is a separate operator decision.

## Build a release artifact explicitly

The builder and activator are separate programs. The builder alone may clone
the exact target into a disposable build directory, install its lockfile, and
compile it. It then assembles, hashes, makes read-only, probes, and verifies the
release directory before returning its identity. A failed build never enters
the quiet-window phase.

Auto-deploy invokes the builder as its first ledger-backed phase and records
`ARTIFACT_PREPARED` after its receipt is independently verified. For an
operator build before `--dry-run`, set the same explicit toolchain contract and
pass a full commit:

```sh
export AGENTOS_REPOSITORY_ROOT="$PWD"
export DEPLOY_SOURCE_REMOTE="$(git remote get-url origin)"
export DEPLOY_GIT_BINARY="$(command -v git)"
export DEPLOY_NODE_BINARY="$(command -v node)"
export DEPLOY_NPM_BINARY="$(command -v npm)"
target="$(git ls-remote --exit-code "$DEPLOY_SOURCE_REMOTE" refs/heads/main | awk '{print $1}')"
"$DEPLOY_NODE_BINARY" current/scripts/deploy/build-release-artifact.mjs "$target"
```

The final line is `RELEASE-ARTIFACT` followed by the release name, commit, and
digest. An existing exact artifact is reverified and reused. Missing output,
wrong build stamps, excluded secret-shaped paths, ambiguous identities, and
content digest drift are named outcomes; none falls back inside the activator.

## Read-only verification

Define the production backup contract without printing secrets:

```sh
DEPLOY_DOCKER_BINARY="$(command -v docker)"
test -n "$DEPLOY_DOCKER_BINARY"
export DEPLOY_PG_DUMP_MODE=container
export DEPLOY_DOCKER_BINARY
export DEPLOY_PG_DUMP_CONTAINER=agentos-postgres-1
export DEPLOY_CONTAINER_PG_DUMP_BINARY=/usr/local/bin/pg_dump
```

Then run:

```sh
node current/scripts/deploy/quiet-window-deploy.mjs --dry-run
```

Dry-run does not take the deploy lock, build, back up, migrate, sync, activate,
write Inbox rows, or restart services. It reports the deployed and target
commits, exact artifact readiness, blocking Run count, all thirteen service
states, backup readiness, and every skipped activation step. `claimed`,
`provisioning`, and `running` block; `queued` and `waiting-inbox` do not.

Do not proceed after a non-zero dry-run. Build or repair the named artifact or
resolve the named production precondition first.

## Install service wrappers

The wrapper migration is required before pointer activation. Plan and apply the
complete thirteen-service definition set:

```sh
node scripts/deploy/install-launchd-services.mjs --replace-existing
node scripts/deploy/install-launchd-services.mjs --replace-existing --apply
```

The installer creates `shared/bin/agentos-service-wrapper.mjs`, records the
original definitions and manifest, and writes wrapper-based plists. It does not
call `launchctl`. Reload labels one by one, allowing a graceful predecessor to
disappear before bootstrapping the same label. Require every label to be
running, every log to name the same `current` identity, `/health` to pass, and
`/version` to report the current exact commit.

## Install auto-deploy

The old definition must be explicitly unloaded and removed before a definition
with a different log path is installed. Plan, then apply:

```sh
node scripts/deploy/install-launchd.mjs \
  --pg-dump-mode container \
  --docker-binary "$DEPLOY_DOCKER_BINARY" \
  --pg-dump-container agentos-postgres-1 \
  --container-pg-dump-binary /usr/local/bin/pg_dump

node scripts/deploy/install-launchd.mjs \
  --pg-dump-mode container \
  --docker-binary "$DEPLOY_DOCKER_BINARY" \
  --pg-dump-container agentos-postgres-1 \
  --container-pg-dump-binary /usr/local/bin/pg_dump \
  --apply
launchctl print "gui/$(id -u)/com.agentos.auto-deploy"
```

The plist runs `current/scripts/deploy/quiet-window-deploy.mjs`, records the
source remote and absolute toolchain, logs under `~/Library/Logs/Anneal`, runs
at load, and repeats every five minutes. The installer refuses to overwrite a
different existing definition.

## Activation sequence

For a new remote commit, the job records `STARTED`, invokes the explicit
builder, and then performs exactly this sequence:

1. After `ARTIFACT_PREPARED`, verify the artifact directory name, exact commit stamp, manifest inventory,
   content digest, excluded-path record, and read-only permissions. Record
   `ARTIFACT_VERIFIED`. A missing artifact or digest mismatch records `FAILED`
   before quiet-window acquisition.
2. Query for zero blockers, acquire the exclusive PostgreSQL deploy barrier,
   and query again. Hold the barrier through activation, verification, or
   recovery.
3. Copy the verified release to a disposable writable operation workspace.
   This is not a Git checkout and is never published.
4. Prove the thirteen loaded services are running through the stable wrapper
   and still identify the old `current` release.
5. Stream a custom-format `pg_dump` to a mode-0600 temporary host file, fsync
   it, and rename it only after a successful non-empty result. Record
   `BACKED_UP`.
6. Run the guarded migration preflight and Prisma migration from the operation
   workspace with configuration inherited from `shared/.env`. No environment
   file is copied into any workspace. Record `SCHEMA_ADVANCED` with migration
   tails.
7. Regenerate and verify the operation workspace Prisma Client, then run the
   canonical prompt sync. Structural drift remains a terminal refusal.
8. Recheck the deploy barrier and blocking statuses, then reverify the original
   immutable artifact.
9. Atomically update `previous` and `current`, durably record `ACTIVATED`, and
   restart all thirteen labels.
10. Require all labels running, `/health` successful, and `/version` reporting
    the target clean commit. Record `VERIFIED` and `SUCCEEDED` and write the
    success Inbox record.

There is no install, compile, Git checkout mutation, or multi-directory
publication in this sequence. The only activation unit is the verified release
directory selected by the pointer.

### Step deadlines and barrier watchdog

Every command-backed deployment step has its own deadline. The artifact build,
migration preflight, migration, Prisma Client generation, prompt sync, and
service-control commands are budgeted independently; there is no single global
step timeout. A step that reaches its deadline is terminated with `SIGTERM`,
followed by `SIGKILL` if it does not exit, and is reported as a
`DeployFailure`.

The deploy barrier also has an independent duration watchdog. It starts with
barrier acquisition and covers hangs outside a child command, so a process
that is no longer making step progress cannot keep new Run claims closed
without an escalation. A watchdog expiry is logged, written to
`.agentos-deploy/escalated.json`, and sent to the operator Inbox through the
same escalation mechanism as other deployment failures.

Timeouts for ordinary steps follow the normal failure path: the deployment
process exits, its session-scoped PostgreSQL barrier is released automatically,
and before publication the current release remains active. After publication,
recovery attempts to restore the prior release and services; database
migrations are not rolled back. The `prisma migrate deploy` migration step is
the deliberate exception. If it
reaches its deadline, the child is terminated and the failure is written to
`escalated.json` and notified, but the deploy process remains alive with the
same database session and barrier held. The current release's service processes
remain running, but no new Run may be claimed and activation and restart do not
proceed. The barrier is not a service-process stop; do not restart services onto
a possibly half-applied schema.

After the cause has been repaired, use the existing `--clear-escalation`
operation. The held deploy process observes the cleared marker, releases its
barrier, and exits non-zero. Only after that normal exit should the scheduled
job be kicked again using the retry procedure below.

While the log says `HOLD deploy-barrier migration-timeout`, do not boot out,
kickstart, or kill `com.agentos.auto-deploy`, and do not log out or reboot the
host. `SIGTERM` is deliberately refused during this hold, but launchd can
eventually escalate to `SIGKILL`, which would drop the session-scoped barrier.
The existing `--clear-escalation` operation is the only safe way to end the
hold after an operator has established that the schema is safe.

#### Timeout or hang evidence

Start with `~/Library/Logs/Anneal/auto-deploy.log` and identify the stalled
auto-deploy child PID. Before changing process state, capture its stack on the
affected host:

```sh
sample <pid> 10 -file ~/Library/Logs/Anneal/auto-deploy-<pid>.sample.txt
```

At the same time, record machine load and the competing process inventory,
including merge-gate workers and `packages/db` test processes. For example:

```sh
uptime
top -l 1 -stats pid,ppid,command,cpu,mem,state,time,threads
ps -axo pid,ppid,lstart,state,%cpu,%mem,command
iostat -w 1 -c 3
```

Preserve these outputs with the auto-deploy log timestamps. The observed slow
incident had no database connection from the stalled Prisma parent, and a
later real migration completed normally, so do not restart diagnosis at
PostgreSQL locks or connection counts; collect the process stack, host load,
I/O state, and concurrent-task evidence first.

If restart or health verification fails after pointer activation, the job
atomically points `current` back at `previous`, records the rollback outcome,
and restarts the prior release. Database migration rollback is not attempted.
There is no checkout or partial-directory fallback.

After success or a no-op, retention keeps the newest three immutable releases
while protecting both pointer targets, the newest fourteen database dumps, one
dump per UTC day for thirty days, and the newest fourteen deployment ledgers.
Locks, escalation state, operation workspaces, and unrecognized entries are
not retention candidates.

Apply retention explicitly with:

```sh
node current/scripts/deploy/quiet-window-deploy.mjs --prune-history
```

## Failure and escalation

Remote-main-unreadable is treated as a potentially transient transport failure.
Before escalating that class, a scheduled invocation retries the remote-main
read within a bounded retry budget and uses backoff between attempts. The retry
burst and each resulting outcome are visible in the deploy log; a successful
retry continues without writing an escalation.

An existing escalation is eligible for an unattended retry only when its reason
is one of `remote-main-unreadable`, `remote-main-read-timeout`,
`quiet-window-query-failed`, or `deploy-barrier-unavailable`. These reasons
cover transient remote, platform-database, and deploy-barrier reads. Environment,
Prisma client import, authentication, malformed remote state, build, verify,
artifact, and filesystem-state failures remain operator-latched.

The initial escalation is attempt 1. Each later failed eligible run atomically
replaces the marker with an incremented attempt count. Attempts below the fixed
cap of 5 may run again; a marker at attempt 5 blocks subsequent ticks exactly
like a permanent escalation. This bounds repeated artifact preparation when an
eligible condition flaps.

Admission alone never clears the marker. The scheduled cycle must complete the
full deployment successfully, or prove that the target is already deployed.
Only then does it report the recovery through the existing notification channel,
remove `.agentos-deploy/escalated.json`, and log
`SELF-CLEAR escalation reason=<reason> attempts=<n>`. If that success
notification fails, the marker remains for the next tick. The original failure
notification remains historical evidence; confirm the SELF-CLEAR entry and
closed recovery notification before dismissing it.

Every non-allowlisted escalation and every eligible escalation at the cap stays
latched for manual clearing. Inspect the ledger, logs, pointer identities,
service states, and Inbox record; repair the named cause; build and verify the
artifact again; and rerun `--dry-run`.

Only then clear and retry:

Run this from the deployment root — the directory holding `current/` and
`.agentos-deploy/`. The marker path hangs off `AGENTOS_REPOSITORY_ROOT`, so
without it the command resolves its state directory to `current/.agentos-deploy/`,
deletes nothing, and prints `NO-ESCALATION-TO-CLEAR path=...` while the real
marker stays latched. Check that path in the output before assuming the
escalation is gone.

```sh
AGENTOS_REPOSITORY_ROOT="$PWD" \
  node current/scripts/deploy/quiet-window-deploy.mjs --clear-escalation
launchctl kickstart -k "gui/$(id -u)/com.agentos.auto-deploy"
```

Signals before activation enter the normal `FAILED` path and remove the
operation workspace. Signals after activation perform pointer recovery before
releasing the deploy barrier. An uncatchable stale process owner is reclaimed
once and escalated instead of starting an unrecorded second deployment.
