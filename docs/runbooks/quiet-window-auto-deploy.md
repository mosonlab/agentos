# Quiet-window auto-deploy

This job advances one macOS launchd deployment from its currently stamped
build to `origin/main`. It is for the checkout whose services are
`com.agentos.api`, `com.agentos.inbox`, `com.agentos.runner`,
`com.agentos.runner-2` through `com.agentos.runner-10`, and `com.agentos.web`.
It does not deploy an Anneal run workspace.

## Preconditions

Run every command in the production checkout as the account that owns its
LaunchAgents. Do not run the installer as root.

The checkout must have:

- a clean, stamped build in `packages/api/dist/build-info.json` before the
  wrapper migration, then a valid `current/packages/api/dist/build-info.json`;
- a mode-0600 `shared/.env`, including `DATABASE_URL` and the existing
  Inbox/Feishu settings. The original root `.env` is retained only for the
  legacy publication retreat path during this migration card;
- `git`, `node`, `npm`, Docker CLI, and `launchctl` on the host;
- the running PostgreSQL container `agentos-postgres-1`, with executable
  `/usr/local/bin/pg_dump` inside it (the path used by the supported
  `postgres:16-alpine` image);
- all thirteen service labels above already loaded.

The serving layout is:

```text
releases/<commit>-<digest>/   immutable runtime tree
shared/.env                   stable secret configuration
shared/{files,runs,state,...} mutable operator data
current -> releases/...       sole activation authority
previous -> releases/...      rollback target
```

Release trees contain dist output, runtime `node_modules`, generated Prisma
Client and migration material, build stamps, native/runtime assets, and the
canonical agent sources loaded at runtime. They never contain `.env` or
persistent operator state. `current` and `previous` are relative symlinks whose
targets must be direct children of `releases/`.

`com.agentos.web` serves the published `apps/web/dist` tree with Vite preview;
never point the production label at the Vite development server. The live
checkout may fetch a newer source revision before artifact publication, while
the preview process remains bound to the last verified build.

## Appliance checkout

The production checkout is a dedicated clone owned by the loaded Anneal
services and auto-deploy. Keep it on `main` with a clean tracked and untracked
tree. Development happens in a different clone or worktree; no interactive
agent task uses the production checkout as its working directory. A worktree of
the development clone is not a production clone because it still shares branch
and worktree administration with interactive work.

Before installing or restoring auto-deploy, prove all three conditions:

```sh
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
git merge-base --is-ancestor HEAD origin/main
```

Relocating an existing installation is a controlled cutover:

1. Prepare an independent clone at the target `main`, copy the existing mode-0600
   `.env` without printing it, install dependencies, generate Prisma Client, and
   build the exact stamped commit already running.
2. Stage replacement LaunchAgent definitions from the loaded definitions,
   preserving their environment and changing only paths rooted in the old
   checkout. Validate every staged plist before touching launchd.
3. At a quiet window, replace all thirteen service definitions and the auto-deploy
   definition as one change. Restart the services from the dedicated clone.
4. Require all labels to be running, `/health` to pass, `/version` to report the
   prepared commit, every loaded program and working directory to resolve inside
   the dedicated clone, and the clone to be clean `main`.
5. Retain the old definitions and checkout until every criterion in step 4 has
   passed. Restore the old definitions and services if any criterion fails.

The cutover is complete only when the development checkout is absent from every
loaded `com.agentos.*` definition. After that point it is ordinary development
state and may use task worktrees without coordinating with auto-deploy.

## Read-only verification

The production host has no host `pg_dump`. Define the exact container backup
contract in the operator shell first:

```sh
DEPLOY_DOCKER_BINARY="$(command -v docker)"
test -n "$DEPLOY_DOCKER_BINARY"
export DEPLOY_PG_DUMP_MODE=container
export DEPLOY_DOCKER_BINARY
export DEPLOY_PG_DUMP_CONTAINER=agentos-postgres-1
export DEPLOY_CONTAINER_PG_DUMP_BINARY=/usr/local/bin/pg_dump
```

First run the complete decision path without taking the deploy lock, fetching,
building, backing up, migrating, syncing, writing Inbox rows,
or restarting services:

```sh
node scripts/deploy/quiet-window-deploy.mjs --dry-run
```

The output names the deployed, source, and remote revisions; the blocking Run
count; repository fast-forward state; loaded service state; the verified
host/container backup contract; and every skipped mutation in
execution order. Container verification runs read-only `docker inspect` and
`docker exec ... test -x` checks. `claimed`, `provisioning`, and `running`
block. `queued` and `waiting-inbox` do not.

Do not install after a non-zero dry-run. Resolve the named condition first.

## Wrapper-first service migration

Complete this migration before allowing the deploy job to activate a new
release pointer. It is a separate, revertible change from auto-deploy itself.

First establish the stable shared configuration without printing it:

```sh
install -d -m 0700 shared
install -m 0600 .env shared/.env
```

Before applying, move any existing persistent files into the corresponding
`shared/` directories and set `FILES_ROOT`, `RUNNER_WORKSPACE_ROOT`,
`RUNNER_DEPENDENCY_CACHE_ROOT`, `RUNNER_REPO_MIRROR_ROOT`, and
`CONTROL_PLANE_STATE_DIR` in `shared/.env` to absolute paths beneath this
`shared/` root. Preserve ownership and modes, and verify the moved bytes before
removing an old copy. The installer creates missing shared directories but does
not guess how to merge operator data. The wrapper refuses any configured
persistent path outside `shared/` rather than silently starting against an old
checkout or an empty fallback.

Plan the complete 13-service replacement. `--replace-existing` is explicit
because these are the already-loaded production definitions, not new labels:

```sh
node scripts/deploy/install-launchd-services.mjs --replace-existing
```

Apply it only in a quiet window:

```sh
node scripts/deploy/install-launchd-services.mjs --replace-existing --apply
```

Before replacing any plist, the installer assembles the still-serving checkout
as an immutable release and creates `current` with one symlink rename. The old
service definitions continue to serve the checkout during that bootstrap. The
installer then records exact backups, installs one stable wrapper under
`shared/bin/`, and replaces all thirteen plists. It does not call `launchctl`,
so the filesystem installation and service reload remain separate revertible
boundaries.

Reload every service definition from `~/Library/LaunchAgents`, then require:

- every `launchctl print "gui/$(id -u)/<label>"` to show `state = running`, the
  shared wrapper path, and its exact label argument;
- every service log to begin with `SERVICE-WRAPPER service=<label>
  release=<commit>-<digest>` for the same `current` target;
- `/health` to pass and `/version` to report the commit in
  `current/packages/api/dist/build-info.json`;
- no release tree to contain `.env`, and every service definition to name
  `shared/.env`.

If any check fails, restore the recorded definitions and reload them:

```sh
node scripts/deploy/install-launchd-services.mjs --revert --apply
```

Do not proceed to pointer activation until the wrapper path passes all checks.
The deploy itself repeats this loaded-definition, running-state, health, and
version proof immediately before every pointer switch and fails without a
fallback if it does not pass.

## Install

Inspect the exact definition the installer would derive from this checkout,
the current Node binary, and the production container backup contract:

```sh
node scripts/deploy/install-launchd.mjs \
  --pg-dump-mode container \
  --docker-binary "$DEPLOY_DOCKER_BINARY" \
  --pg-dump-container agentos-postgres-1 \
  --container-pg-dump-binary /usr/local/bin/pg_dump
```

Apply it only after the dry-run passes:

```sh
node scripts/deploy/install-launchd.mjs \
  --pg-dump-mode container \
  --docker-binary "$DEPLOY_DOCKER_BINARY" \
  --pg-dump-container agentos-postgres-1 \
  --container-pg-dump-binary /usr/local/bin/pg_dump \
  --apply
launchctl print "gui/$(id -u)/com.agentos.auto-deploy"
```

The installed plist lives at
`~/Library/LaunchAgents/com.agentos.auto-deploy.plist`. It runs at load and
every five minutes. One invocation stays alive while a main revision is
waiting for a quiet window and records `HOLD quiet-window` once per minute.
Logs are `~/Library/Logs/Anneal/auto-deploy.log` and
`auto-deploy.error.log`.

The installer refuses to replace a different existing plist. Inspect and
unload that definition before replacing it; the installer never guesses that
an existing service definition is obsolete.

The installer resolves Node, `git`, `npm`, and Docker to executable absolute
paths, renders a controlled `PATH` containing the Node and Git binary
directories, and proves Node, Git, and the npm CLI under exactly that environment
before it writes the plist. The deploy invokes npm as `<absolute node>
<absolute npm-cli.js>` rather than trusting an `env node` shebang. The installer
requires an explicit `host` or `container` pg-dump mode and writes the complete
contract into the launchd environment. In container mode it also refuses unless
the named container is running and the configured container-internal `pg_dump`
path is executable. Missing or unexecutable configuration is a named
installation refusal; there is no host/container fallback.

## Upgrade behavior

When a new remote revision exists, the job waits for a zero-blocker query, takes
an exclusive PostgreSQL deploy barrier, and queries again. The claim transaction
takes the shared form before reading candidates. An in-flight claim therefore
finishes before the deploy obtains its barrier; later claims return no work.
The barrier stays held through every restart, verification, notification, or
recovery. The job does not stop runner processes while it waits.

The job then performs exactly this sequence and stops at the first failure:

1. require branch `main`, refuse a dirty checkout, fetch `origin/main`, prove the
   current source is its ancestor, and fast-forward with `git merge --ff-only`.
   The remote revision read and fetch each make at most three attempts, waiting
   two seconds and then five seconds; only the final failure escalates;
2. create a detached staging worktree under `.agentos-deploy/` and run `npm ci`
   against the target lockfile. The root `postinstall` generates the initial
   Prisma Client; after the migration, the deploy runs `npm run db:generate`
   again before canonical prompt sync. The runtime client is still verified
   before publication;
3. materialize the exact target revision's local merge-gate `dist/` snapshot
   when it is present and valid, otherwise run `npm run build` in staging, then
   verify the API build stamp. A missing or cache-evicted snapshot is an explicit
   source-build miss; a present malformed index, symlinked tree, wrong stamp, or
   partial artifact is a terminal refusal rather than a silent fallback;
4. run `/usr/local/bin/pg_dump -Fc` through `docker exec` in
   `agentos-postgres-1`; stream its stdout to a mode-0600 temporary file on the
   host under `.agentos-deploy/backups/`, fsync it, and rename it to `.dump`
   only after a zero exit and non-empty output;
5. run `npm run db:migrate-goal-execution` from staging;
6. run `npm run db:sync-canonical-prompts`; structural drift outside an
   explicitly source-declared assignee or review-base transition is a terminal
   refusal and is never changed with SQL. Operator model and runner overrides
   are preserved after validation. Canonical model and runner defaults are
   loaded from the `agents/roles/*.md` frontmatter through the shared role
   source loader. For each canonical-role Agent with
   `runtimeConfigCustomized` false, the sync adopts any model or
   `runnerPreference` value that differs from that role source and clears its
   `runtimeConfigDriftNoticeFingerprint`; every such adoption is reported with
   the Agent name and from/to values. A customized Agent keeps its persisted
   model and runner values, with the existing drift-notice behavior unchanged.
   The review-base transitions adopt only
   `compound-engineer-workflow:6` from `null` to step 5 and
   `direct-engineer-workflow:3` from `null` to step 2. The dedicated
   `regression-verifier` is the one source-declared role creation: when absent,
   sync creates it from canonical role text in the active
   `review-coordinator-sol` environment, copies that source Agent's repository
   grants and disabled-tool boundary, and refuses an archived target or source.
   Direct step 6 and Full Assurance step 11 may adopt it only from the frozen
   Opus or Sol assignees. Instantiated tasks are migrated only while unarchived,
   TODO, and free of every Run, Session, and step output; every other assignment
   is preserved and counted in the sync result. When the exact historical Full
   Assurance shape has Regression before Librarian, sync preserves that template
   and its task foreign keys under a deterministic legacy identity, then creates
   the documentation-before-regression canonical replacement for new chains.
   It refuses this rollover while an unarchived, not-`DONE` Task on the old
   template still has an active Run or carries no chain identity, or when the
   old template carries webhook configuration, rather than changing live-chain
   semantics or moving operator-owned trigger state implicitly. A quiescent
   chain moves under the legacy identity intact and does not block it. The same guarded rollover preserves both pre-merge-lease
   canonical templates before installing their mechanically-owned Regression prompts;
7. verify the staged generated Prisma client, then assemble
   `releases/<commit>-<digest>/` from the exact runtime inventory. Verify the
   content digest and API stamp, remove all write bits, perform a real
   post-verification write probe, and verify the digest again. `.env` and
   mutable operator paths are excluded rather than linked into the release;
8. while `current` still names the old release, prove every loaded service uses
   the stable shared wrapper, is running, and reports the old `current` release
   identity. Recheck the deploy barrier and blocking statuses. A missing,
   dangling, or checkout-backed `current`, a stale plist, or any readiness
   failure stops here without changing activation;
9. update `previous` to the old `current` target, replace `current` with one
   same-directory symlink `rename(2)`, and synchronously record the release
   directory plus old/new pointer targets in the deployment ledger. The ledger
   `ACTIVATED` event is durable before the first service restart begins;
10. restart all services, require every launchd label to be running, `/health`
    to pass, and `/version` to report the exact target commit. Only then record
    `VERIFIED` and `SUCCEEDED`.

The release snapshot is only a local acceleration path. The exact-head merge
gate publishes its revision index after the final clean-tree drift proof, and
the index points at the gate's existing bounded, immutable build cache rather
than creating a second artifact copy. A gate run on another host provides merge
evidence but no local deployment artifact, so this host performs the normal
source build. Deployment correctness never depends on cache availability.

Runner lease heartbeats remain on `RUNNER_HEARTBEAT_INTERVAL_MS`. CLI
availability reports use a separate one-minute interval, with a deterministic
zero-to-fifteen-second initial offset derived from `runnerId`, so sibling runner
services do not create a synchronized Serializable write burst. The API retries
at most two `P2034` conflicts for this one global availability transaction and
surfaces a third conflict normally.

For the active release path, a post-switch build, notification, restart, health,
or version failure atomically points `current` back at `previous`, records the
rollback pointer outcome in the terminal ledger event, and restarts the previous
services. There is no silent checkout fallback. Database migration rollback is
not attempted. The legacy `publishDirectories()` and `previous-*` restoration
code remain available as the retreat implementation for this card, but the
normal deployment path no longer uses multi-directory rename publication.

After a successful deploy, and on every no-op invocation, retention keeps the
newest three immutable release directories while always protecting both
`current` and `previous`. The existing policy also keeps the newest three
legacy `previous-*` directories, the newest fourteen database dumps, and the
newest dump for each UTC day in the last thirty days.
Only names produced by this deployer are eligible; active stages, the live
build, locks, escalation state, and unrecognized entries are never touched.
Retention runs under the deploy process lock after publication has committed
and the deploy barrier has been released. A cleanup refusal or filesystem error
fails loudly and is retried by a later no-op invocation without rolling back a
healthy deployed build.
If Docker, the container, or `pg_dump` fails, the attempt stops as
`database-backup-failed`, removes the partial host file, and performs no
migration, sync, publication, or restart.

To apply the same bounded policy immediately, after a passing dry-run and while
no deploy process owns the lock:

```sh
node scripts/deploy/quiet-window-deploy.mjs --prune-history
```

The command refuses a non-main or dirty appliance checkout and shares the same
exclusive deploy process lock. It does not fetch, migrate, restart services,
touch the live build, clear escalation state, or delete an active run workspace.

Success and failure create an Anneal Inbox message containing both revisions
and the named outcome. A failure also writes
`.agentos-deploy/escalated.json`. While that file exists, scheduled invocations
never retry the upgrade. If the Inbox write was interrupted, they retry only
that persisted notification until the Inbox row exists, then exit with
`STOP escalation-active`.

The process lock records PID and process-start identity. SIGINT and SIGTERM
during the idle quiet-window wait exit without a sticky escalation because no
upgrade has started; the next scheduled invocation resumes waiting normally.
After the upgrade pipeline starts, the same signals abort the active child and
enter the normal failure path. If `current` already moved, the durable
`ACTIVATED` event and the two filesystem pointers identify both sides of the
transition; recovery points `current` back, records the rollback outcome, and
restarts the previous services before releasing the deploy barrier and process
lock. After an uncatchable death,
the next invocation reclaims a provably stale owner, records
`stale-deploy-owner-recovered`, sends it to Inbox, and remains escalated instead
of starting another upgrade.

## Clear an escalation

Read the failure, the launchd logs, and the corresponding Inbox message. After
repairing the named condition, re-run `--dry-run`. Then clear the sticky state
explicitly:

```sh
node scripts/deploy/quiet-window-deploy.mjs --clear-escalation
launchctl kickstart -k "gui/$(id -u)/com.agentos.auto-deploy"
```

`--clear-escalation` does not fetch, build, migrate, sync, or restart a service.
It authorizes only a later scheduled attempt.
