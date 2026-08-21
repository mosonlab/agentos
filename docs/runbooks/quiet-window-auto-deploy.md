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
- `node_modules` installed for the committed `package-lock.json`;
- `git`, `node`, `npm`, `pg_dump`, and `launchctl` on the host;
- all nine service labels above already loaded.

The job reads `masterSha` and `controlPlaneASha` from the tracked
`release-authority.json`; do not add those values to a plist or `.env`.

## Read-only verification

First run the complete decision path without taking the deploy lock, fetching,
freezing runners, building, backing up, migrating, syncing, writing Inbox rows,
or restarting services:

```sh
node scripts/deploy/quiet-window-deploy.mjs --dry-run
```

The output names the deployed, source, and remote revisions; the blocking Run
count; repository fast-forward state; loaded service state; authority state;
and every skipped mutation in execution order. `claimed`, `provisioning`, and
`running` block. `queued` and `waiting-inbox` do not.

Do not install after a non-zero dry-run. Resolve the named condition first.

## Install

Inspect the exact definition the installer would derive from this checkout and
the current Node binary:

```sh
node scripts/deploy/install-launchd.mjs
```

Apply it only after the dry-run passes:

```sh
node scripts/deploy/install-launchd.mjs --apply
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

## Upgrade behavior

When a new remote revision exists, the job freezes the six runner launchd
processes only after its first zero-blocker query, waits one second, and queries
again. If a run raced into a blocking status, it resumes the runners and keeps
waiting. Once the second query is clear, queued work cannot be claimed during
the upgrade.

The job then performs exactly this sequence and stops at the first failure:

1. refuse a dirty checkout; fetch `origin/main`; prove the current source is
   its ancestor; fast-forward with `git merge --ff-only`;
2. create a detached staging worktree under `.agentos-deploy/`, clone the
   installed dependencies there, and run `npm run db:generate`;
3. run `npm run build` in staging and verify its API build stamp;
4. write a mode-0600 `pg_dump -Fc` backup under
   `.agentos-deploy/backups/`;
5. run `npm run db:migrate-goal-execution` from staging with the two authority
   SHAs read from that revision's `release-authority.json`;
6. run `npm run db:sync-canonical-prompts`; structural drift is a terminal
   refusal and is never changed with SQL;
7. query the blocking statuses again, swap all staged `dist/` trees, and
   restart the nine launchd services.

The old `dist/` trees stay in a private `previous-*` transaction directory. A
build, migration, sync, swap, notification, or restart failure restores or
retains the previous build. Database migration rollback is not attempted.
Database backups and successful previous-build directories are not deleted
automatically; retain or remove them under the operator's backup policy.

Success and failure create an AgentOS Inbox message containing both revisions
and the named outcome. A failure also writes
`.agentos-deploy/escalated.json`. While that file exists, scheduled invocations
exit with `STOP escalation-active` and do not retry.

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
