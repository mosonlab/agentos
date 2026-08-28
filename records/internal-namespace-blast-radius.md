# Internal namespace migration blast-radius audit

Date: 2026-08-27

Baseline: `9fc489ac407a1ca5fa7dccd76e4e6f3fd9f7b3ab`

Status: audit evidence only. This record authorizes no infrastructure change.

## Placeholder contract

This record deliberately does not bind the migration to a replacement product
name. The following placeholders are used throughout:

- `<OLD_PRODUCT_CASED>`, `<OLD_PRODUCT_LOWER>`, and `<OLD_PRODUCT_UPPER>`: the
  current product spelling in its three cases.
- `<OLD_NPM_SCOPE>` and `<NEW_NPM_SCOPE>`: the current and replacement npm
  workspace scopes.
- `<OLD_HOME>` and `<NEW_HOME>`: the current and replacement runtime state roots.
- `<OLD_SERVICE_PREFIX>` and `<NEW_SERVICE_PREFIX>`: the current and replacement
  launchd label prefixes.
- `<OLD_REPO_SLUG>` and `<NEW_REPO_SLUG>`: the current and replacement repository
  slugs used by gate-worker mirrors.
- `<OLD_UNIX_USER>` and `<NEW_UNIX_USER>`: an existing and replacement worker or
  service account.

Changing the proposed product name must require rerunning only the code-side
replacement, not rewriting this audit.

## Completeness evidence

The tracked tree was scanned case-insensitively for the old product token. The
baseline contains 2,232 exact tokens on 2,004 lines in 380 files. The
machine-readable companion
[`internal-namespace-occurrences.tsv`](internal-namespace-occurrences.tsv)
contains one row per token with its primary category, placeholder-normalized
path, line, column, and occurrence index. It can be reproduced from the stated
baseline with `git ls-files` plus a case-insensitive token scan.

The category counts are mutually exclusive and sum to 2,232. A category is the
primary operational owner of the containing line; mixed lines remain visible in
the occurrence inventory.

| Primary category | Tokens | Files or surfaces | Reversibility | Running-service impact | Owner and dependency |
| --- | ---: | --- | --- | --- | --- |
| npm workspace scope | 424 | Eight first-party packages, root/workspace scripts, imports, build checks, tests, lockfile, and package-reference prose | Fully reversible by an append-only revert commit | None until a later deploy consumes the commit | B first; replace `<OLD_NPM_SCOPE>/*` and every exact reference |
| filesystem and workspace roots | 210 | Default state roots, mirrors, control-plane state, run workspaces, deploy staging, examples, tests, and `RUNNER_WORKSPACE_ROOT` neighbors | Copy-first migration is reversible while old roots remain | High if defaults or loaded paths change before data and definitions are ready | C plan only; prepare and verify `<NEW_HOME>` before any service switch |
| launchd and service labels | 65 | User LaunchAgents, installer templates, deploy code, OS-isolation scripts, tests, and runbooks | Reversible only while old plist files, checkout, and state are retained | Direct restart interruption; auto-deploy scheduling is interrupted during the switch | C plan only; depends on the new checkout and state roots being ready |
| gate-worker identifiers | 158 | Dispatcher environment, SSH aliases, mirror layout, harness scripts, tests, and runbook | Mirror copies are reversible; account or alias replacement is not safe during an active gate | No product-service restart, but gate capacity and merge evidence are unavailable while a worker is drained | C plan only; drain one worker at a time after confirming its real user and home |
| runner Git identity | 7 | `packages/runner/src/exec.ts` and identity fixtures | Fully reversible for future commits; existing commit authorship is immutable | None for the package-scope change | Separate decision after B; the explicit B scope does not authorize changing identity semantics |
| documentation | 126 | Architecture, install, release, governance, operator, and runbook prose | Reversible | None by itself; incorrect runbooks can make later operations unsafe | Package references follow B; public naming belongs to the separate manual step; infrastructure instructions follow the future approved cutover |
| locales | 12 | English and Chinese user-facing product strings | Fully reversible | Web UI changes only after deploy | Separate manual public-product step, outside B and C execution |
| public snapshot | 6 | Inclusion purposes and exclusion reasons | Fully reversible | None | Update only when a changed path or package-scope reference requires it |
| scripts | 278 | Build, merge gate, deploy, OS isolation, gate worker, setup, release, and verification fixtures | Code changes are reversible; infrastructure effects are not implied | Mixed: build-only scripts have none, deploy and isolation scripts can affect live services if executed | Exact package references follow B; infrastructure behavior remains plan-only |
| other code and configuration | 946 | Runtime protocol keys, repository slugs, database/container names, fixtures, temporary paths, public product strings, and code-native identifiers | Mixed | Mixed; protocol and persisted identifiers may require compatibility or migration decisions | Not covered by the mechanical B replacement unless the exact npm scope occurs |

There are no TypeScript `paths` aliases for `<OLD_NPM_SCOPE>/*`. The only
workspace path alias found is the web application's unrelated `@/*` alias.

## npm workspace dependency graph

The eight first-party packages are `api`, `build-info`, `db`, `github-client`,
`inbox`, `merge-executor`, `runner`, and `web`. The replacement must be atomic
within one commit because manifests, lockfile links, static imports, dynamic
imports, build provenance, workspace commands, tests, and documentation all
refer to the same scope.

The primary-category count contains 424 literal `<OLD_NPM_SCOPE>/` tokens. Four
additional regex fixtures render the same scope while escaping the slash; the
occurrence inventory classifies those lines under other code and configuration,
but B must migrate them too. Verification therefore checks both the literal and
escaped forms rather than relying on a literal-only grep.

The safe order within B is:

1. Replace the exact scope in manifests, sources, scripts, tests, and prose.
2. Update the lockfile without changing unrelated dependency versions.
3. Prove the old exact scope has no tracked occurrence.
4. Run repository lint and snapshot scan before dispatching the exact-head gate.
5. Deliver the gated commit by fast-forward; no runtime service is changed.

Standalone product spellings, filesystem roots, environment-variable prefixes,
service labels, repository slugs, protocol keys, database/container names,
branch prefixes, the runner Git identity, and filenames are not part of this
mechanical replacement.

## Runtime filesystem findings

Read-only host inspection found the current state root contains production,
runs, control-plane, repo-mirror, dependency-cache, binary, recovery, operator
documentation, and prior cutover-backup entries. The production checkout was
not traversed or modified.

Loaded runner and API definitions do not pin the workspace, control-plane, or
mirror roots explicitly, so current code defaults resolve beneath `<OLD_HOME>`.
The API files root has a separate default under the user's Documents directory.
Those roots have overlap and filesystem-safety checks; a cutover cannot point a
test or temporary root at persistent runtime state.

The production checkout, deploy staging and backup directories, runtime state,
logs, database/container identifiers, and example `/opt/...` layouts are
distinct migration objects. A global string replacement would conflate them.

## launchd findings

Read-only host inspection found 15 loaded plist definitions with the old service
namespace, all syntactically valid:

- 13 business definitions covered by the quiet-window runbook: API, Inbox, Web,
  and ten Runner definitions;
- one auto-deploy definition;
- one PostgreSQL backup definition that is not in the runbook's 13-service
  inventory.

At audit time, the 13 business definitions were running. The auto-deploy and
backup jobs were loaded but not running. Their loaded state still matters: the
cutover must account for their definitions and scheduled behavior even when no
process is active at the instant of inspection.

The business definitions and auto-deploy resolve their program or working
directory into the old production checkout. The backup definition also carries
old runtime, database, and container identifiers. Omitting that fifteenth
definition would leave a live namespace dependency after an otherwise successful
cutover.

## remote gate-worker findings

The dispatcher has a primary and a fallback SSH alias. Repository scripts derive
worker storage as `~/gate/<OLD_REPO_SLUG>/`, containing a bare mirror, isolated
worktrees, logs, and the installed gate harness. Worker-wide slot locks and the
capacity marker live one level above the repository directory.

The local SSH configuration indicates different Unix users for the two aliases:
the primary uses `<OLD_UNIX_USER>`, while the fallback uses `ubuntu`. Therefore
the assumption that both workers use `/home/<OLD_UNIX_USER>/...` is not proven.
No SSH connection was made. A future cutover must confirm each remote `$HOME`,
effective user, idle gate state, mirror path, and capacity marker before writing.

The benchmark scripts also contain a default mirror path tied directly to
`<OLD_REPO_SLUG>`. Repository renaming and Unix-user migration are separate
dimensions and must not be collapsed into one unverified move.

## Dependency order

1. Preserve this audit and freeze the old/new mappings for the intended cutover.
2. Complete and deliver B's exact npm-scope commit without touching runtime
   services.
3. Confirm the desired treatment of non-package code identifiers, including the
   runner Git identity, protocol keys, environment-variable prefixes, and
   filenames.
4. Confirm each worker's effective user and home, and enumerate every loaded
   service definition from the host at cutover time.
5. Prepare `<NEW_HOME>`, the replacement checkout, state copies, permissions,
   build, and staged plist definitions while old services continue to run.
6. Choose a quiet window only after the deploy dry-run has no blockers and no
   product run, deploy, backup, or gate conflicts with the relevant surface.
7. Switch service definitions as one controlled change, verify health and exact
   version, and roll back to retained old definitions and state on any failure.
8. Drain and migrate gate workers independently. Retain old mirrors until the
   replacement worker produces exact-head evidence.
9. Delete old state, definitions, accounts, mirrors, or logs only under a later
   explicit cleanup authorization.

## Red-line confirmation

The audit made no write under the current runtime state root, made no change in
the production checkout, did not stop or unload launchd services, and made no
SSH connection or remote-worker change.
