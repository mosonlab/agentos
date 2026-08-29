# Immutable releases production cutover plan

Date: 2026-08-29

Status: dry-run and definition preview complete; apply not authorized or run

Production checkout: `/Users/leohe/.agentos/production/agentos`

Production head: `ff4a4e6376d1dbb533018b93ad94a6ed554042bc`

This record covers the Artifact deploy card 2 cutover from checkout-backed
services to immutable `releases/` trees selected by an atomic `current`
pointer. It stops before every mutating installer or `launchctl` operation.

## Decision

The deploy decision path and both installer plans pass with exit code 0. The
generated definitions implement the intended wrapper-first boundary, preserve
the existing service environment and lifecycle policy, and contain the full
container backup contract.

The cutover is not ready to apply yet. The required `shared/` tree and
mode-0600 `shared/.env` do not exist. The five mutable roots still live outside
`shared/`. The existing auto-deploy plist also differs from the planned plist,
so the installer will refuse a direct overwrite. These are explicit apply
preconditions, not conditions to bypass.

Apply only after Moson confirms that the dashboard recording has stopped,
there are no blocking Runs, the mutable roots have been staged and verified,
and a fresh dry-run still passes. The recommended window includes the service
reload plus a fifteen-minute runner-registry observation period.

## Read-only production evidence

The checkout was `main`, clean, and at the same commit as `origin/main`.
Commands ran as uid 501, not root. No `releases/`, `current`, `previous`,
`shared/`, `shared/.env`, launchd migration manifest, or `escalated.json`
existed at inspection time. Three legacy `.agentos-deploy/previous-*`
directories existed.

The old scheduled environment had previously emitted this complete refusal:

```text
2026-08-29T09:38:29.364Z STOP environment-unreadable detail=backup-configuration-invalid:DEPLOY_PG_DUMP_MODE-must-be-host-or-container
```

The operator shell then defined the runbook's exact container contract:

```sh
DEPLOY_DOCKER_BINARY="$(command -v docker)"
test -n "$DEPLOY_DOCKER_BINARY"
export DEPLOY_PG_DUMP_MODE=container
export DEPLOY_DOCKER_BINARY
export DEPLOY_PG_DUMP_CONTAINER=agentos-postgres-1
export DEPLOY_CONTAINER_PG_DUMP_BINARY=/usr/local/bin/pg_dump
```

The complete `quiet-window-deploy.mjs --dry-run` output was:

```text
2026-08-29T09:39:35.960Z DRY-RUN revisions from=ff4a4e6376d1dbb533018b93ad94a6ed554042bc source=ff4a4e6376d1dbb533018b93ad94a6ed554042bc target=ff4a4e6376d1dbb533018b93ad94a6ed554042bc
2026-08-29T09:39:35.962Z DRY-RUN quiet-window=open blockers=0
2026-08-29T09:39:35.962Z DRY-RUN repository branch=main dirty=false fast-forward=yes
2026-08-29T09:39:35.962Z DRY-RUN services=ready
2026-08-29T09:39:35.962Z DRY-RUN backup=ready mode=container
2026-08-29T09:39:35.962Z DRY-RUN plan step=fast-forward mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=install-dependencies mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=build mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=backup mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=guarded-migration mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=generate-prisma-client mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=canonical-prompt-sync mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=verify-runtime-prisma-client mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=materialize-release mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=verify-stable-service-paths mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=publish-build mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=restart-services mutation=skipped
2026-08-29T09:39:35.962Z DRY-RUN plan step=verify-services mutation=skipped
DRY_RUN_EXIT=0
```

The wrapper migration plan output was:

```text
PLAN service-wrapper=/Users/leohe/.agentos/production/agentos/shared/bin/agentos-service-wrapper.mjs
PLAN service-definitions=14
PLAN no files or launchd state changed
SERVICE_PLAN_EXIT=0
```

The count is fourteen because the plan owns one wrapper artifact plus thirteen
service plists.

The auto-deploy installer plan output was:

```text
PLAN label=com.agentos.auto-deploy
PLAN destination=/Users/leohe/Library/LaunchAgents/com.agentos.auto-deploy.plist
PLAN repository=/Users/leohe/.agentos/production/agentos
PLAN node=/opt/homebrew/Cellar/node/26.5.0/bin/node
PLAN path=/opt/homebrew/Cellar/node/26.5.0/bin:/opt/homebrew/Cellar/git/2.48.1/bin:/usr/local/bin:/usr/bin:/bin
PLAN git=/opt/homebrew/Cellar/git/2.48.1/bin/git
PLAN npm=/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js
PLAN rendered_toolchain=verified
PLAN pg_dump_mode=container
PLAN docker=/Applications/Docker.app/Contents/Resources/bin/docker
PLAN pg_dump_container=agentos-postgres-1
PLAN container_pg_dump=/usr/local/bin/pg_dump
PLAN no files or launchd state changed
AUTO_DEPLOY_PLAN_EXIT=0
```

The read-only runtime baseline remained:

- `/health`: status `ok`, database `connected`.
- `/version`: package `@anneal/api`, version `0.4.0`, commit and build SHA
  `ff4a4e6376d1dbb533018b93ad94a6ed554042bc`, `dirty=false`,
  `stamped=true`.
- Process survival baseline: API 1, runner 10, merge-executor 1, total 12.
- All thirteen `com.agentos.*` service labels were loaded and running.
- Runner registry: 11 online of 11 total, comprising ten ordinary runners and
  `merge-executor-macos-1`.

Targeted non-production fixtures passed 18 of 18. They exercised atomic
activation and rollback, `current` and `shared` wrapper invocation, bootstrap
of the first release, explicit thirteen-plist replacement, and exact
backup/revert restoration.

## Existing and planned definition differences

For all thirteen service definitions, replacement mode preserves every
non-controlled environment value without printing it, preserves the existing
`PATH`, and preserves all lifecycle fields and log paths. It adds these stable
wrapper fields:

```text
DEPLOY_NODE_BINARY
AGENTOS_REPOSITORY_ROOT
AGENTOS_SHARED_ROOT
AGENTOS_SHARED_ENV_FILE
AGENTOS_CURRENT_POINTER=current
AGENTOS_RELEASES_DIRECTORY=releases
AGENTOS_SERVICE_LABEL
```

The launchd-level `WorkingDirectory` is intentionally the stable production
root, not `current`. Launchd starts the stable wrapper from `shared/bin`; the
wrapper validates `current`, then starts the child with a `current/...`
entrypoint and a `current`-based working directory. This is the canonical
wrapper-first design and avoids storing a resolved release directory in a
loaded plist.

| Label | Existing program and cwd | Planned launchd program and cwd | Wrapper child target | Other change |
| --- | --- | --- | --- | --- |
| `com.agentos.api` | `/opt/homebrew/bin/node packages/api/dist/index.js`; production root | real Node, `shared/bin/agentos-service-wrapper.mjs`, label; production root | `current/packages/api/dist/index.js`; `current/` | Stable wrapper variables added |
| `com.agentos.inbox` | `/opt/homebrew/bin/node packages/inbox/dist/index.js`; production root | real Node, wrapper, label; production root | `current/packages/inbox/dist/index.js`; `current/` | Stable wrapper variables added |
| `com.agentos.runner` | `/opt/homebrew/bin/node packages/runner/dist/index.js`; production root | real Node, wrapper, label; production root | `current/packages/runner/dist/index.js`; `current/` | `RUNNER_ID`: unset to `runner-1` |
| `com.agentos.runner-2` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-2` to `runner-2` |
| `com.agentos.runner-3` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-3` to `runner-3` |
| `com.agentos.runner-4` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-4` to `runner-4` |
| `com.agentos.runner-5` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-5` to `runner-5` |
| `com.agentos.runner-6` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-6` to `runner-6` |
| `com.agentos.runner-7` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-7` to `runner-7` |
| `com.agentos.runner-8` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-8` to `runner-8` |
| `com.agentos.runner-9` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-9` to `runner-9` |
| `com.agentos.runner-10` | Direct runner; production root | real Node, wrapper, label; production root | Current runner; `current/` | `RUNNER_ID`: `leo-runner-10` to `runner-10` |
| `com.agentos.web` | Direct Vite preview; `apps/web`; explicit port 5174 | real Node, wrapper, label; production root | `current/node_modules/vite/bin/vite.js`; `current/apps/web` | `vite.config.ts` retains preview port 5174 and `strictPort: true` |
| `com.agentos.auto-deploy` | Real Node and checkout deploy script; production root | Same program, cwd, controlled `PATH`, toolchain, schedule, and backup contract | Not wrapper-managed; it advances the checkout and release pointers | stdout/stderr move from `~/Library/Logs/AgentOS` to `~/Library/Logs/Anneal` |

The planned service Node path is the resolved
`/opt/homebrew/Cellar/node/26.5.0/bin/node`; the existing service plists use the
`/opt/homebrew/bin/node` symlink. Existing `RUNNER_PATH` values are preserved.

The auto-deploy environment contains the complete backup contract:

```text
DEPLOY_PG_DUMP_MODE=container
DEPLOY_DOCKER_BINARY=/Applications/Docker.app/Contents/Resources/bin/docker
DEPLOY_PG_DUMP_CONTAINER=agentos-postgres-1
DEPLOY_CONTAINER_PG_DUMP_BINARY=/usr/local/bin/pg_dump
```

Because the auto-deploy log paths differ, `install-launchd.mjs --apply` would
stop with `launchd-definition-conflict` while the old plist remains. The old
definition must be explicitly backed up, unloaded, and removed before the new
installer is applied.

## Apply preconditions

All conditions below are mandatory:

1. Moson explicitly releases this cutover after the dashboard recording is
   complete.
2. The operator is the LaunchAgent owner and is not root.
3. Production remains clean `main`; `HEAD` is an ancestor of `origin/main`.
4. A fresh deploy dry-run exits 0 with zero blockers, services ready, and the
   container backup ready.
5. `.agentos-deploy/escalated.json` is absent.
6. The five mutable roots are staged below `shared/`, byte-verified, and the
   mode-0600 `shared/.env` names only those absolute shared paths.
7. The old auto-deploy plist backup destination does not already exist.
8. No unrelated service or task state is changed as part of this cutover.

The current-to-target mutable path mapping is:

| Variable | Current path | Shared path |
| --- | --- | --- |
| `FILES_ROOT` | `/Users/leohe/Documents/agentos` | `/Users/leohe/.agentos/production/agentos/shared/files` |
| `RUNNER_WORKSPACE_ROOT` | `/Users/leohe/.agentos/runs` | `/Users/leohe/.agentos/production/agentos/shared/runs` |
| `RUNNER_DEPENDENCY_CACHE_ROOT` | `/Users/leohe/.agentos/dependency-cache` | `/Users/leohe/.agentos/production/agentos/shared/dependency-cache` |
| `RUNNER_REPO_MIRROR_ROOT` | `/Users/leohe/.agentos/repo-mirrors` | `/Users/leohe/.agentos/production/agentos/shared/repo-mirrors` |
| `CONTROL_PLANE_STATE_DIR` | `/Users/leohe/.agentos/control-plane` | `/Users/leohe/.agentos/production/agentos/shared/state` |

## Exact apply sequence

This sequence is a future operator action. It was not run while preparing this
record. Run it from the production checkout in one shell with `set -e`; a
non-zero command is a stop condition.

First re-establish the read-only proof and stage stable configuration without
printing it:

```sh
cd /Users/leohe/.agentos/production/agentos
set -euo pipefail
test "$(id -u)" -ne 0
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
git merge-base --is-ancestor HEAD origin/main
test ! -e .agentos-deploy/escalated.json

DEPLOY_DOCKER_BINARY="$(command -v docker)"
test -n "$DEPLOY_DOCKER_BINARY"
export DEPLOY_PG_DUMP_MODE=container
export DEPLOY_DOCKER_BINARY
export DEPLOY_PG_DUMP_CONTAINER=agentos-postgres-1
export DEPLOY_CONTAINER_PG_DUMP_BINARY=/usr/local/bin/pg_dump

node scripts/deploy/quiet-window-deploy.mjs --dry-run

install -d -m 0700 shared
install -m 0600 .env shared/.env
install -d -m 0700 \
  shared/files \
  shared/runs \
  shared/dependency-cache \
  shared/repo-mirrors \
  shared/state

for key in \
  FILES_ROOT \
  RUNNER_WORKSPACE_ROOT \
  RUNNER_DEPENDENCY_CACHE_ROOT \
  RUNNER_REPO_MIRROR_ROOT \
  CONTROL_PLANE_STATE_DIR; do
  /usr/bin/sed -i '' -E "/^(export[[:space:]]+)?${key}[[:space:]]*=/d" shared/.env
done

/usr/bin/printf '%s\n' \
  'FILES_ROOT=/Users/leohe/.agentos/production/agentos/shared/files' \
  'RUNNER_WORKSPACE_ROOT=/Users/leohe/.agentos/production/agentos/shared/runs' \
  'RUNNER_DEPENDENCY_CACHE_ROOT=/Users/leohe/.agentos/production/agentos/shared/dependency-cache' \
  'RUNNER_REPO_MIRROR_ROOT=/Users/leohe/.agentos/production/agentos/shared/repo-mirrors' \
  'CONTROL_PLANE_STATE_DIR=/Users/leohe/.agentos/production/agentos/shared/state' \
  >> shared/.env
chmod 0600 shared/.env

node --input-type=module <<'NODE'
import { readFileSync, statSync } from "node:fs";
import { parseSharedEnvironment } from "./scripts/deploy/launchd-service-wrapper.mjs";

const path = "shared/.env";
if ((statSync(path).mode & 0o777) !== 0o600) {
  throw new Error("shared-environment-mode-is-not-0600");
}
const environment = parseSharedEnvironment(readFileSync(path, "utf8"));
const expected = {
  FILES_ROOT: "/Users/leohe/.agentos/production/agentos/shared/files",
  RUNNER_WORKSPACE_ROOT: "/Users/leohe/.agentos/production/agentos/shared/runs",
  RUNNER_DEPENDENCY_CACHE_ROOT: "/Users/leohe/.agentos/production/agentos/shared/dependency-cache",
  RUNNER_REPO_MIRROR_ROOT: "/Users/leohe/.agentos/production/agentos/shared/repo-mirrors",
  CONTROL_PLANE_STATE_DIR: "/Users/leohe/.agentos/production/agentos/shared/state",
};
for (const [key, value] of Object.entries(expected)) {
  if (environment[key] !== value) throw new Error(`shared-environment-path-mismatch:${key}`);
}
process.stdout.write("OK shared environment mode and persistent paths verified\n");
NODE

/usr/bin/ditto /Users/leohe/Documents/agentos shared/files
/usr/bin/ditto /Users/leohe/.agentos/runs shared/runs
/usr/bin/ditto /Users/leohe/.agentos/dependency-cache shared/dependency-cache
/usr/bin/ditto /Users/leohe/.agentos/repo-mirrors shared/repo-mirrors
/usr/bin/ditto /Users/leohe/.agentos/control-plane shared/state

/usr/bin/diff -qr /Users/leohe/Documents/agentos shared/files
/usr/bin/diff -qr /Users/leohe/.agentos/runs shared/runs
/usr/bin/diff -qr /Users/leohe/.agentos/dependency-cache shared/dependency-cache
/usr/bin/diff -qr /Users/leohe/.agentos/repo-mirrors shared/repo-mirrors
/usr/bin/diff -qr /Users/leohe/.agentos/control-plane shared/state
```

Inspect the five path assignments and modes without printing any other
`shared/.env` content. Then back up and unload only the scheduler so it cannot
race the cutover:

```sh
install -d -m 0700 .agentos-deploy/manual-cutover
test ! -e .agentos-deploy/manual-cutover/com.agentos.auto-deploy.plist.before-immutable-cutover
install -m 0600 \
  "$HOME/Library/LaunchAgents/com.agentos.auto-deploy.plist" \
  .agentos-deploy/manual-cutover/com.agentos.auto-deploy.plist.before-immutable-cutover
/usr/bin/cmp -s \
  "$HOME/Library/LaunchAgents/com.agentos.auto-deploy.plist" \
  .agentos-deploy/manual-cutover/com.agentos.auto-deploy.plist.before-immutable-cutover

launchctl bootout "gui/$(id -u)/com.agentos.auto-deploy"
```

Apply the filesystem-only wrapper migration while the thirteen old loaded
definitions continue to serve the checkout:

```sh
node scripts/deploy/install-launchd-services.mjs --replace-existing --apply
```

This command must create the immutable bootstrap release, atomically create
`current`, install the wrapper, write the thirteen new plists, and record the
original files in `.agentos-deploy/launchd/manifest.json` and its backup
directory. It does not call `launchctl`.

At the coordinated interruption, unload all old service definitions, take one
final quiescent sync of mutable data, verify it, and load all new definitions:

```sh
service_labels=(
  com.agentos.api
  com.agentos.inbox
  com.agentos.runner
  com.agentos.runner-2
  com.agentos.runner-3
  com.agentos.runner-4
  com.agentos.runner-5
  com.agentos.runner-6
  com.agentos.runner-7
  com.agentos.runner-8
  com.agentos.runner-9
  com.agentos.runner-10
  com.agentos.web
)

for label in "${service_labels[@]}"; do
  launchctl bootout "gui/$(id -u)/$label"
done

/usr/bin/rsync -a --extended-attributes --delete /Users/leohe/Documents/agentos/ shared/files/
/usr/bin/rsync -a --extended-attributes --delete /Users/leohe/.agentos/runs/ shared/runs/
/usr/bin/rsync -a --extended-attributes --delete /Users/leohe/.agentos/dependency-cache/ shared/dependency-cache/
/usr/bin/rsync -a --extended-attributes --delete /Users/leohe/.agentos/repo-mirrors/ shared/repo-mirrors/
/usr/bin/rsync -a --extended-attributes --delete /Users/leohe/.agentos/control-plane/ shared/state/

/usr/bin/diff -qr /Users/leohe/Documents/agentos shared/files
/usr/bin/diff -qr /Users/leohe/.agentos/runs shared/runs
/usr/bin/diff -qr /Users/leohe/.agentos/dependency-cache shared/dependency-cache
/usr/bin/diff -qr /Users/leohe/.agentos/repo-mirrors shared/repo-mirrors
/usr/bin/diff -qr /Users/leohe/.agentos/control-plane shared/state

for label in "${service_labels[@]}"; do
  launchctl bootstrap \
    "gui/$(id -u)" \
    "$HOME/Library/LaunchAgents/$label.plist"
done
```

Do not remove the five old mutable roots yet. They are the no-divergence retreat
copy until the new services pass every acceptance check.

Once the thirteen services pass the immediate checks below, replace the old
auto-deploy definition explicitly and let the installer bootstrap it:

```sh
/bin/rm "$HOME/Library/LaunchAgents/com.agentos.auto-deploy.plist"

node scripts/deploy/install-launchd.mjs \
  --pg-dump-mode container \
  --docker-binary "$DEPLOY_DOCKER_BINARY" \
  --pg-dump-container agentos-postgres-1 \
  --container-pg-dump-binary /usr/local/bin/pg_dump \
  --apply
```

Retire the old mutable roots only after immediate service verification and the
fifteen-minute runner-registry observation pass. Removal must be a separately
confirmed, exact-path operation because these directories are the cutover
retreat copy.

## Post-apply acceptance criteria

Every item is required. A failure triggers the applicable rollback below.

1. Production remains clean `main`; its source head remains
   `ff4a4e6376d1dbb533018b93ad94a6ed554042bc` unless a separately authorized
   deploy changed it.
2. `shared/.env` is mode 0600. Its five persistent paths are absolute children
   of `shared/`. No release contains `.env`.
3. `releases/` exists and contains a read-only bootstrap release named
   `<40-character-commit>-<digest>` with a valid manifest and build stamp.
4. `current` is a relative symlink directly to that release. It is not dangling
   and does not resolve to the checkout. `previous` is expected to be absent
   immediately after this first bootstrap; it appears on the first later
   pointer-path deployment.
5. `shared/bin/agentos-service-wrapper.mjs` exists and the launchd migration
   manifest records fourteen entries: one wrapper and thirteen plist files,
   with valid original and installed SHA-256 values and existing backups for
   every replaced file.
6. All thirteen service labels are loaded with `state = running`. Each loaded
   definition contains the exact shared wrapper path and its own label
   argument. No full `launchctl print` output is emitted because it can contain
   environment secrets.
7. The latest wrapper line for every service is
   `SERVICE-WRAPPER service=<label> release=<same-current-release>` and names a
   `current/...` entrypoint.
8. `/health` returns HTTP 200 with database `connected`.
9. `/version` returns version `0.4.0`, commit
   `ff4a4e6376d1dbb533018b93ad94a6ed554042bc`, `dirty=false`, and
   `stamped=true`; the commit equals `current/packages/api/dist/build-info.json`.
10. The survival process baseline is API 1 plus runner 10 plus merge-executor 1,
    total 12. Inbox and web are checked through their labels separately.
11. Ten new ordinary runner identities `runner-1` through `runner-10` and the
    merge executor are online. Because the registry retains old identities for
    fifteen minutes and caps the registry at sixteen entries, the immediate
    result may be 11 online of up to 16 total. After fifteen minutes it must
    converge to exactly 11 online of 11 total; otherwise the cutover has not
    passed its observation period.
12. `com.agentos.auto-deploy` is loaded from the new plist. Its idle scheduled
    state need not be `running`, but its program, cwd, toolchain, controlled
    `PATH`, four-field container backup contract, five-minute interval, and
    `~/Library/Logs/Anneal` paths must match the preview.
13. A final `quiet-window-deploy.mjs --dry-run` exits 0 and reports services and
    container backup ready. This dry-run does not yet prove a pointer-path
    deployment; card 3 remains blocked until a later real deployment activates
    a second release and Moson accepts it.

## Rollback plan and feasibility conclusion

There are two rollback boundaries.

### Wrapper cutover rollback

Before the first real pointer-path deployment there is no `previous` pointer,
so pointer rollback is correctly unavailable. The cutover retreat is the
installer's exact plist backup plus the preserved old mutable roots and the
unchanged root `.env`.

If any new service fails before auto-deploy is replaced:

1. Stop every newly loaded service label.
2. If a new service could have written mutable state, sync the corresponding
   shared tree back to its preserved old root while all services are stopped.
3. Run
   `node scripts/deploy/install-launchd-services.mjs --revert --apply`.
   The command verifies current and backup SHA-256 values before restoring all
   thirteen original plists and removing the newly installed wrapper.
4. Bootstrap all thirteen restored plist files from
   `~/Library/LaunchAgents`.
5. Restore the manually backed-up auto-deploy plist, bootstrap it, and repeat
   the old `/health`, `/version`, label, process, and 11/11 runner checks.

If only the new auto-deploy install fails after the thirteen services are
healthy, restore only
`.agentos-deploy/manual-cutover/com.agentos.auto-deploy.plist.before-immutable-cutover`
to `~/Library/LaunchAgents/com.agentos.auto-deploy.plist` and bootstrap that
definition. Do not revert healthy wrapper services solely for an auto-deploy
plist failure.

This rollback is feasible, not speculative: all thirteen source plists exist;
the plan rendered replacements from them without conflict; non-controlled
environment and lifecycle fields were preserved; and the real migration
fixture proved exact replacement and revert restoration. The bootstrap
`releases/` tree and `current` may remain for forensics because restored old
plists do not reference them.

### Pointer-path deployment rollback

On the first later successful pointer activation, the deployer sets `previous`
to the bootstrap release before atomically renaming `current` to the new
release. Before that switch it proves all thirteen wrappers are running from
the old `current`, checks API health and version, and rechecks the deploy
barrier and zero blockers. Therefore the old release has already demonstrated
that it can start through the exact wrapper path used for rollback.

For a post-switch restart, health, version, build, or notification failure, the
normal deploy failure path atomically swaps `current` back to `previous`, keeps
the failed target as the new `previous`, records the rollback outcome, and
restarts all thirteen services. The pointer and wrapper fixtures passed this
exact transition. There is no checkout fallback.

Retention has three distinct rules:

- There is one `previous` pointer and therefore one immediate pointer rollback
  target.
- Immutable retention keeps the newest three release directories and always
  protects both `current` and `previous`. Normally those pointers are among the
  newest three; if not, protected directories are retained in addition.
- Legacy retention keeps the newest three `.agentos-deploy/previous-*`
  directories. Production currently has exactly three.

The pointer rollback conclusion is affirmative after the first real pointer
activation: repointing `current` to `previous` and restarting the wrappers can
return services to the verified prior release. It does not roll back a database
migration. The pre-migration container dump is the database recovery artifact,
and database restoration remains a separate operator decision.

## Rollback triggers

Rollback immediately on any of these conditions:

- any installer or reload command exits non-zero;
- a backup SHA, plist, wrapper, release manifest, build stamp, symlink, or
  immutable-permission check fails;
- any of the thirteen labels is absent or not running after the readiness
  deadline;
- any loaded service does not name the stable wrapper and its exact label;
- wrapper logs disagree on release identity or name a resolved `releases/...`
  child instead of `current/...`;
- `/health`, `/version`, the 12-process survival baseline, or runner online
  status fails;
- any persistent path resolves outside `shared/` under the new wrappers;
- the auto-deploy backup contract is incomplete or points at a missing Docker
  binary, stopped container, or non-executable container `pg_dump`;
- a fresh post-cutover dry-run exits non-zero.

## Risks requiring operator attention

1. The current dry-run succeeds through the legacy root `.env` fallback. It
   does not prove the absent `shared/.env`; that must be prepared and validated
   before apply.
2. Mutable data migration spans five live roots. Use the two-pass copy and the
   final sync only after all thirteen old services are stopped. Preserve the
   originals through the observation period.
3. Runner identities change. The expected transient registry shape is 11
   online with stale old identities retained, followed by 11/11 after fifteen
   minutes. Treat fewer than 11 online as failure; do not mistake expected stale
   rows for additional live processes.
4. The auto-deploy installer cannot replace the current plist in place because
   the log paths changed. Losing its verified manual backup would remove the
   scheduler retreat path.
5. The first bootstrap has `current` but no `previous`. Until a real second
   release is activated, only the recorded plist/data retreat can undo the
   wrapper cutover.
6. Pointer recovery is intentionally fail-closed. A missing, dangling, or
   checkout-backed `current` makes wrappers refuse startup; there is no degraded
   source-checkout fallback.
7. A pointer rollback does not reverse database migrations. Backup success is a
   hard precondition for every real deployment.
8. Auto-deploy logs move from `AgentOS` to `Anneal`; monitoring and operator
   tails must use the new paths after cutover.
9. Reloading thirteen services interrupts the dashboard recording and briefly
   removes API and web availability. The apply window must be coordinated, not
   inferred from a zero-blocker dry-run alone.

## Stop point

No apply flag, plist write, `launchctl bootout`, `launchctl bootstrap`, service
restart, pointer update, mutable-data move, `.env` modification, task-state
change, build, or dependency installation was performed while producing this
record.
