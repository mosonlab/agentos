# Repository instructions

Public rules for every repository change. Host configuration, credentials, and
private operator procedure stay in the operator documentation outside this
repository.

## Work directly

Work in the current session by default; create or dispatch a task chain only
when the human user explicitly requests one.

When the user requests a chain:

- Direct chain: one implementation context window can deliver a brief whose
  change points are enumerable. Its `description` is the specification of
  record — write it from [`docs/BRIEF-TEMPLATE.md`](docs/BRIEF-TEMPLATE.md)
  before instantiating.
- Full assurance chain: the work exceeds one implementation window or
  decomposes into independently demonstrable slices; its spec and plan stages
  own that decomposition. A surface too large for a brief to enumerate belongs
  here, not to an assignee escalation.
- Implementation assignee: keep the direct template's default. Assign
  `senior-dev` (same rule for the review-fix step) only when the work touches
  persisted data or a defense-list path — merge gate, gate worker, migrations,
  merge automation — or when that classification is uncertain. Assign
  `frontend-dev` when the work is primarily a new or redesigned web page or UI
  surface (Leo 2026-08-27); the defense-list rule above still wins when both
  apply.
- A backlog card that needs a non-default implementation assignee states it as
  the machine-readable line `Route: implementation=senior-dev` (or
  `=frontend-dev`) in its description; the dispatcher copies it into
  `stepOverrides`. Only the implementation step is routable this way.
- Chain-to-chain sequencing: pass `afterTaskId` (the predecessor chain's final
  task) to the instantiate endpoint; the bound chain dispatches when the
  predecessor completes. Incompatible with `autoStart`; one successor per
  predecessor task. Bind only a qualified dependency; ordering preferences
  stay in the backlog — qualification rules in
  [`docs/governance/task-routing-v1.md`](docs/governance/task-routing-v1.md).
- Dispatching, gating, rerouting, and the backlog card lifecycle (create,
  route, archive at instantiation) follow
  [`docs/governance/task-routing-v1.md`](docs/governance/task-routing-v1.md).

Before changing canonical Agents, roles, or task templates, read
[`agents/README.md`](agents/README.md); it and the contract files it names own
canonical defaults.

## Design simply

Implement the simplest design that fully meets the current requirement; add an
abstraction, configuration option, or compatibility path only when a current
acceptance criterion or caller requires it.

## Test safely

- Before tests outside the merge gate, point `RUNNER_WORKSPACE_ROOT` at a new
  temporary directory; a hand-built `RunnerConfig` also pins `home` to one.
  Runner tests provision real workspaces.
- Local pre-gate verification is targeted: run only the test files your change
  touches (`npm run test:db -w @agentos/api -- src/<file>.dbtest.ts` runs a
  subset). The merge gate runs the full suite.
- Spawn the real API entrypoint in tests through
  `packages/api/src/test-startup-environment.ts`: the entrypoint loads the root
  `.env`, and dotenv restores omitted credentials unless the helper pins them
  from the test URL.
- Appliance checkout: before changing files or branches in a checkout named by
  a loaded `com.agentos.*` service, read
  [`docs/runbooks/quiet-window-auto-deploy.md`](docs/runbooks/quiet-window-auto-deploy.md).
  Leave that checkout on clean `main`; work in a separate worktree.

Database bootstrap and the full test-safety rules are in
[`CONTRIBUTING.md`](CONTRIBUTING.md); read the applicable section before acting
on one of those surfaces.

## Deliver an exact head

`scripts/merge-gate.sh` is the only CI; a merge requires
`MERGE GATE: PASS <oid>` for the exact commit being merged
(`scripts/merge-gate.sh --expect-head <oid>`). When another gate might be
running, dispatch through `scripts/gate-worker/gate-dispatch.sh <oid>`; read
[`docs/runbooks/gate-worker.md`](docs/runbooks/gate-worker.md) before operating
a remote worker.

Every delivery that advances `main` acquires `scripts/merge-lease.sh` before
running the merge gate for the final integrated head and holds it until the
merge consumes that proof. Writing code, pushing a feature branch, and opening
a PR need no lease. Pass `--task <id>` to both `acquire` and `release`: the
default holder `user@host` is shared by every agent window on one machine, so
a release without a task id cannot tell its own lease from a sibling's.

Open the PR right after pushing the feature branch, before dispatching the
gate: once the exact-head fast-forward lands, GitHub refuses a PR from a branch
main already contains, while one opened beforehand flips to merged on its own.

Several agent windows share one checkout. Deliver from a dedicated worktree
under `~/Documents/claude_projects/agentos-public-worktrees/<task-name>/` on
your own branch, stage only the paths you changed, and remove the worktree once
merged — a branch switch in the shared checkout carries away another window's
uncommitted work.

## Editing these instructions

This file is the routing and guardrail layer: branch-specific detail lives in
its owning document, with a trigger-first pointer here only when agents must
discover it. `package.json`, configuration, the directory tree, and `--help`
output are live authority — never cached here. One authoritative home per rule;
an obsolete path is removed when its replacement lands.

For the operator-facing HTTP route handbook, see [docs/operator-api.md](docs/operator-api.md). A change that adds, removes, or alters an HTTP route updates the handbook in the same change.
