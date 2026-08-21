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

The installer resolves `git`, `npm`, and Docker to executable absolute paths,
requires an explicit `host` or `container` pg-dump mode, and writes the complete
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

1. refuse a dirty checkout; fetch `origin/main`; prove the current source is
   its ancestor; fast-forward with `git merge --ff-only`;
2. create a detached staging worktree under `.agentos-deploy/`, run `npm ci`
   against the target lockfile, and run `npm run db:generate`;
3. run `npm run build` in staging and verify its API build stamp;
4. run `/usr/local/bin/pg_dump -Fc` through `docker exec` in
   `agentos-postgres-1`; stream its stdout to a mode-0600 temporary file on the
   host under `.agentos-deploy/backups/`, fsync it, and rename it to `.dump`
   only after a zero exit and non-empty output;
5. run `npm run db:migrate-goal-execution` from staging with the two authority
   SHAs read from that revision's `release-authority.json`;
6. run `npm run db:sync-canonical-prompts`; structural drift is a terminal
   refusal and is never changed with SQL;
7. verify the staged generated Prisma client, recheck the barrier and blocking
   statuses, swap the staged `dist/` trees and target `node_modules`, and
   restart the services;
8. require every launchd service to be running, `/health` to pass, and
   `/version` to report the exact target commit before reporting success.

The old `dist/` trees and `node_modules` stay in a private `previous-*`
transaction directory. A
build, migration, sync, swap, notification, or restart failure restores or
retains the previous build. Database migration rollback is not attempted.
Database backups and successful previous-build directories are not deleted
automatically; retain or remove them under the operator's backup policy.
If Docker, the container, or `pg_dump` fails, the attempt stops as
`database-backup-failed`, removes the partial host file, and performs no
migration, sync, publication, or restart.

Success and failure create an AgentOS Inbox message containing both revisions
and the named outcome. A failure also writes
`.agentos-deploy/escalated.json`. While that file exists, scheduled invocations
never retry the upgrade. If the Inbox write was interrupted, they retry only
that persisted notification until the Inbox row exists, then exit with
`STOP escalation-active`.

The process lock records PID and process-start identity. SIGINT and SIGTERM
abort the active child, enter the same failure path as a step refusal, roll back
published artifacts and restart the previous services when publication already
occurred, persist the interruption, then release the deploy barrier and process
lock. After an uncatchable death, the next invocation reclaims a provably stale
owner, records `stale-deploy-owner-recovered`, sends it to Inbox, and remains
escalated instead of starting another upgrade.

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
