# Quiet-window auto-deploy

This job advances one macOS launchd deployment from its currently stamped
build to `origin/main`. It is for the checkout whose services are
`com.agentos.api`, `com.agentos.inbox`, `com.agentos.runner`,
`com.agentos.runner-2` through `com.agentos.runner-6`, and `com.agentos.web`.
It does not deploy an AgentOS run workspace.

## Preconditions

Run every command in the production checkout as the account that owns its
LaunchAgents. Do not run the installer as root.

The checkout must have:

- a clean, stamped build in `packages/api/dist/build-info.json`;
- its existing mode-0600 `.env`, including `DATABASE_URL` and the existing
  Inbox/Feishu settings;
- `git`, `node`, `npm`, Docker CLI, and `launchctl` on the host;
- the running PostgreSQL container `agentos-postgres-1`, with executable
  `/usr/local/bin/pg_dump` inside it (the path used by the supported
  `postgres:16-alpine` image);
- all nine service labels above already loaded.

The job reads `masterSha` and `controlPlaneASha` from the tracked
`release-authority.json`; do not add those values to a plist or `.env`.

## Appliance checkout

The production checkout is a dedicated clone owned by the loaded AgentOS
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
3. At a quiet window, replace all nine service definitions and the auto-deploy
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
count; repository fast-forward state; loaded service state; authority state;
the verified host/container backup contract; and every skipped mutation in
execution order. Container verification runs read-only `docker inspect` and
`docker exec ... test -x` checks. `claimed`, `provisioning`, and `running`
block. `queued` and `waiting-inbox` do not.

Do not install after a non-zero dry-run. Resolve the named condition first.

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
Logs are `~/Library/Logs/AgentOS/auto-deploy.log` and
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
   against the target lockfile. The root `postinstall` generates Prisma Client,
   so the deploy does not run the same generation a second time; the runtime
   client is still verified before publication;
3. materialize the exact target revision's local merge-gate `dist/` snapshot
   when it is present and valid, otherwise run `npm run build` in staging, then
   verify the API build stamp. A missing or cache-evicted snapshot is an explicit
   source-build miss; a present malformed index, symlinked tree, wrong stamp, or
   partial artifact is a terminal refusal rather than a silent fallback;
4. run `/usr/local/bin/pg_dump -Fc` through `docker exec` in
   `agentos-postgres-1`; stream its stdout to a mode-0600 temporary file on the
   host under `.agentos-deploy/backups/`, fsync it, and rename it to `.dump`
   only after a zero exit and non-empty output;
5. run `npm run db:migrate-goal-execution` from staging with the two authority
   SHAs read from that revision's `release-authority.json`;
6. run `npm run db:sync-canonical-prompts`; structural drift outside an
   explicitly source-declared assignee or review-base transition is a terminal
   refusal and is never changed with SQL. Operator model and runner overrides
   are preserved after validation; only uncustomized Agent-default transitions
   declared by the source may be adopted. The review-base
   transitions adopt only `compound-engineer-workflow:6` from `null` to step 5
   and `direct-engineer-workflow:2` from `null` to step 1. Agent-default transitions
   are frozen to `review-coordinator` and `review-coordinator-sol`, from model
   `gpt-5.6-sol:high` with `runnerPreference` `CODEX` to model
   `openai-codex/gpt-5.6-sol:high` with `runnerPreference` `PI`, plus
   `implementation-plan-executioner` from `gpt-5.6-sol:medium` / `CODEX` to
   `gpt-5.6-sol:high` / `CODEX`; the sync adopts one only when both persisted
   fields exactly match that `from` state and the canonical source exactly
   matches the `to` state. The dedicated
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
   It refuses this rollover while any unarchived Task on the old template is
   unfinished, or when the old template carries webhook configuration, rather
   than changing live-chain semantics or moving operator-owned trigger state
   implicitly. The same guarded rollover preserves both pre-merge-lease
   canonical templates before installing their lease-aware Regression prompts;
7. verify the staged generated Prisma client, recheck the barrier and blocking
   statuses, swap the staged `dist/` trees and target `node_modules`, and
   restart the services;
8. require every launchd service to be running, `/health` to pass, and
   `/version` to report the exact target commit before reporting success.

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

The old `dist/` trees and `node_modules` stay in a private `previous-*`
transaction directory. A
build, migration, sync, swap, notification, or restart failure restores or
retains the previous build. Database migration rollback is not attempted.
After a successful deploy, and on every no-op invocation, retention keeps the
newest three successful `previous-*` directories. It keeps the newest fourteen
database dumps plus the newest dump for each UTC day in the last thirty days.
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

Success and failure create an AgentOS Inbox message containing both revisions
and the named outcome. A failure also writes
`.agentos-deploy/escalated.json`. While that file exists, scheduled invocations
never retry the upgrade. If the Inbox write was interrupted, they retry only
that persisted notification until the Inbox row exists, then exit with
`STOP escalation-active`.

The process lock records PID and process-start identity. SIGINT and SIGTERM
during the idle quiet-window wait exit without a sticky escalation because no
upgrade has started; the next scheduled invocation resumes waiting normally.
After the upgrade pipeline starts, the same signals abort the active child,
enter the normal failure path, roll back published artifacts and restart the
previous services when publication already occurred, persist the interruption,
then release the deploy barrier and process lock. After an uncatchable death,
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
