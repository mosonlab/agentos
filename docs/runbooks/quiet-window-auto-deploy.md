# Quiet-window auto-deploy

> **Audience and support status.** This runbook documents the repository
> maintainer's macOS appliance-deployment profile and its Linux systemd
> deployment profile. It is published for auditability and reproducibility, but
> it is not part of the Developer Preview Quickstart, the supported installation
> shape, or a production-support commitment.

On macOS, this job advances the appliance from the release named by `current`
to an exact `main` commit. It controls `com.agentos.api`, `com.agentos.inbox`,
the configured runner labels (ten by default), and `com.agentos.web`; that is
thirteen labels at the default count. The Linux systemd profile below uses the
same generated inventory. The release artifact also carries the resident
merge-executor runtime, but that process is outside this activation set. The
job never deploys an Anneal run workspace.

## Runner-only host

When runners live on a second host, set `AGENTOS_DEPLOY_ROLE=runner` while
rendering that host's service and auto-deploy definitions. The unset value (or
explicit `control-plane`) remains the role for the host that owns the API,
Inbox, web, database, and canonical prompts. The install manifest records the
role, and stage two refuses to install a manifest whose recorded role does not
match the configured role.

The runner role's service inventory contains only the configured
`com.agentos.runner` labels, using `AGENTOS_RUNNER_COUNT` and
`AGENTOS_RUNNER_ID_PREFIX`. The prefix is required for this role and must be
host-specific and disjoint from the control-plane host's runner IDs; an empty
prefix stops deployment preflight. It never installs, restarts, or verifies
`com.agentos.api`, `com.agentos.inbox`, or `com.agentos.web`. Its phase table
also omits `backup`, `guarded-migration`, `generate-prisma-client`,
`canonical-prompt-sync`, and `verify-runtime-prisma-client`; a runner-only host
does not back up or change the control-plane database or canonical prompts.

Each runner deployment reads the control plane's `GET /version` from the
configured `RUNNER_API_URL`, which must be the numeric-loopback HTTP origin
`http://127.0.0.1:<port>` (normally a tunnel to the control-plane host). The
runner host also needs `OPERATOR_TOKEN` because registration verification reads
the operator-only `GET /runners` endpoint. These values and the required prefix
are checked before an artifact is built. The deployment targets the reported
clean `commit`, which must be present in the source remote before the runner
builds its local artifact. This keeps the runner host on exactly the build the
control plane is running. After building and acquiring the deploy barrier, it
reads `/version` again and refuses to publish if the control plane advanced in
the meantime. An unreachable or dirty control-plane build, an unreadable source
remote, or a commit absent from the source remote stops preflight.

Quiet-window blocking is scoped to active Runs whose `runnerId` belongs to this
host's inventory. After restart, verification requires every local runner to
register with the control plane again and for `GET /runners` to report each
runner's `daemonVersion` as the deployed build commit. A missing registration
or mismatched build fails verification, rolls `current` back to `previous`,
and restarts the runners from the previous release. Recovery is complete only
after every local runner registers again after that restart and reports the
previous release's commit.

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
  `FEISHU_DEFAULT_CHAT_ID`, `GITHUB_READ_TOKEN`, and the five absolute
  persistent paths beneath `shared/`;
- all configured service labels to use `shared/bin/agentos-service-wrapper.mjs`;
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

## Linux systemd

Linux uses system-level systemd units and selects this profile with
`AGENTOS_SERVICE_PLATFORM=linux`. The platform resolver accepts only `darwin`
or `linux`; an unsupported value stops the operation rather than selecting the
macOS profile. The Linux installer is a two-stage operation: rendering and
staging are unprivileged, while copying into `/etc/systemd/system`, changing
systemd state, and installing the control grant are root-only.
The merge executor is installed by hand under its separate operator runbook;
it is not generated, enabled, restarted, or rolled back by this activation set.

### Two-stage install

Set an existing, non-root Linux service account in `SERVICE_USER`. The
`--service-user` value is required on Linux, is validated before rendering,
and is refused when it names an unknown account or `root`. Keep the staging
directory operator-owned; it lives below the existing `.agentos-deploy/`
install root.

First plan, then render both installer manifests as the operator. The
auto-deploy command below uses the host `pg_dump` mode; set its absolute path
in `DEPLOY_PG_DUMP_BINARY` before running it.

```sh
export AGENTOS_SERVICE_PLATFORM=linux
export SERVICE_USER="${SERVICE_USER:?set an existing non-root service account}"
export DEPLOY_PG_DUMP_BINARY="${DEPLOY_PG_DUMP_BINARY:?set an absolute pg_dump path}"

scripts/os-isolation/patch-runner-plists.sh --dry-run
scripts/os-isolation/patch-runner-plists.sh --apply

node scripts/deploy/install-launchd-services.mjs \
  --service-user "$SERVICE_USER" \
  --replace-existing
node scripts/deploy/install-launchd-services.mjs \
  --service-user "$SERVICE_USER" \
  --replace-existing --apply

node scripts/deploy/install-launchd.mjs \
  --service-user "$SERVICE_USER" \
  --pg-dump-mode host \
  --pg-dump-binary "$DEPLOY_PG_DUMP_BINARY"
node scripts/deploy/install-launchd.mjs \
  --service-user "$SERVICE_USER" \
  --pg-dump-mode host \
  --pg-dump-binary "$DEPLOY_PG_DUMP_BINARY" \
  --apply
```

The plan prints `PLAN platform=linux`, the system unit directory, the
count-derived unit total, the staging path, and
`PLAN no files or systemd state changed`. A stage-one apply writes only the
rendered service units, the auto-deploy oneshot and timer, the staged
os-isolation drop-ins, the stable wrapper, and their digest-and-backup
manifests below `.agentos-deploy/`. It does not write `/etc`, call
`systemctl`, or require privilege. Each installer prints the exact root
command for its second stage; run those commands as printed, with
`--install-units`, rather than constructing a different path by hand.

Stage two verifies the already operator-installed stable wrapper, copies only
the system-owned staged files to `/etc/systemd/system` as `root:root` with
mode 0644, independently validates the rendered units and generated
`/etc/sudoers.d/anneal-service-control` with `visudo -c`, runs
`systemctl daemon-reload`, and then enables the generated inventory. The
sudoers grant is rendered from the control adapter's own description of its
verbs, so it names only the generated unit names, only `/bin/systemctl`, and
only the verbs `restart`, `is-active`, and `show -p ExecStart --value`. It
does not grant `enable`, `disable`, or `daemon-reload`; those operations
remain in the root install stage. A non-root control call uses `sudo -n`, and
a denied command is a deployment failure rather than a successful no-op.

Before replacing an existing system file, stage two records its bytes,
ownership, mode, and enabled/active state in a root-owned mode-0600 transaction
record beside the unit definitions. The unprivileged staging manifest cannot
rewrite that record. A successful revert consumes and removes it after the
final `daemon-reload`.

The service installer manifest includes the stable wrapper as its first entry
and one entry for every generated service definition. The separate
auto-deploy installer owns its own definition manifest: one plist on macOS,
and a `Type=oneshot` service plus its timer on Linux. The oneshot service is
installed but is never enabled or started directly: `enable --now` is applied
to the timer so installation cannot trigger an immediate deployment.

### Runner count, accounts, and logs

`AGENTOS_RUNNER_COUNT` controls the generated inventory and defaults to 10;
valid values are integers from 1 through 64. The service labels remain in
inventory order: API, inbox, `com.agentos.runner` for runner 1,
`com.agentos.runner-2` through the configured count, then web. The
os-isolation scripts use `ACCOUNT_COUNT` (default 8) for the account pool and
map runner `i` to account `((i - 1) % ACCOUNT_COUNT) + 1`. Thus a count of 16
places two runners on each of the eight accounts, with runners 1 and 9 on
account 1. Each account keeps its own mode-700 home and its own Git and CLI
state; no account's credentials are copied or shared with another account.

At the default count there are thirteen long-running service units. At a
count of 16 there are nineteen. Stage two runs `systemctl enable --now
<label>.service` for every long-running service and
`systemctl enable --now com.agentos.auto-deploy.timer`; it never enables or
starts `com.agentos.auto-deploy.service` directly.

Linux service output is in the systemd journal, not in
`~/Library/Logs/Anneal`. Inspect a service with:

```sh
journalctl --no-pager -u <label>.service
```

No deployment code parses per-service log files on Linux. The auto-deploy
oneshot's output is likewise inspected through its journal unit.

### Activation and rollback

The release and pointer workflow is unchanged. After the verified `current`
pointer is activated, the Linux control adapter performs the following checks
for each generated service label, in inventory order:

```sh
sudo -n /bin/systemctl restart <label>.service
sudo -n /bin/systemctl is-active <label>.service
sudo -n /bin/systemctl show -p ExecStart --value <label>.service
```

`is-active` must return `active`, and the `ExecStart` value must contain both
the stable wrapper path and the label. The HTTP readiness probes, release
identity checks, and deploy barrier remain the same as on macOS. If
verification fails after activation, atomically point `current` back to
`previous`, then repeat the same `restart`, `is-active`, and wrapper-boundary
checks for the prior release. The auto-deploy oneshot is not restarted as part
of service rollback; its timer remains the scheduler.

To undo the service installation, first run the unprivileged wrapper-revert
stage; it restores only the operator-owned stable wrapper and prints the exact
root command that reverts the system-owned files:

```sh
node scripts/deploy/install-launchd-services.mjs \
  --service-user "$SERVICE_USER" --revert --apply
```

Run that printed `--install-units --revert` command, then use the separate
auto-deploy installer's `--install-units --revert` mode for its oneshot and
timer. The recorded manifests are authoritative: a digest
drift refuses the revert without changing anything; otherwise the installer
restores or removes every recorded file, records `systemctl disable --now` for
units it removes, and finishes with `systemctl daemon-reload`. This restores
the system-unit files, timer, staged drop-ins, wrapper, and generated control
grant to their recorded pre-install state.

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
4. Prove every configured service is running through the stable wrapper
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
   restart every configured label.
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
