# Repository instructions

Public rules for every repository change. Host configuration, credentials, and
private operator procedure stay in the operator documentation outside this
repository.

## Work directly

Work in the current session by default; create or dispatch a task chain only
when the human user explicitly requests one. Everything about chains — tier
selection, the brief, implementation-assignee routing, chain-to-chain
sequencing, and the backlog card lifecycle — is owned by
[`docs/governance/task-routing-v1.md`](docs/governance/task-routing-v1.md);
qualify dependencies there before every instantiation.

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
  touches (`npm run test:db -w @anneal/api -- src/<file>.dbtest.ts` runs a
  subset). Do not run a full database suite by hand. The gate parallelises it
  across the worker's cores against a tmpfs PostgreSQL with durability off,
  while a local run is capped at four lanes on real storage; the hand-run is
  several times slower and proves less. When the operator has explicitly
  configured remote capacity, dispatch the gate with
  `AGENTOS_WORKSPACE_PATH="$(git rev-parse --show-toplevel)" scripts/gate-worker/gate-dispatch.sh <oid>`;
  otherwise run the exact local gate with `scripts/merge-gate.sh --expect-head
  <oid>`. Never infer or invent a worker hostname.
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
`MERGE GATE: PASS <oid>` for the exact commit being merged. The delivery
procedure — gate dispatch, merge lease, pull-request timing, and worktree
isolation — is owned by the "Delivering to main" section of
[`CONTRIBUTING.md`](CONTRIBUTING.md). Never switch branches or commit feature
work in the shared checkout: deliver from an isolated worktree on your own
branch, and remove the worktree once merged.

## Platform runs

For an agent executing inside an Anneal run: your checkout is exclusive to
this run. Create any worktree you need inside your own run workspace (a
relative path such as `./worktrees/<name>`), never outside it — host-window
rules elsewhere in this file do not move your work off the run workspace.
Gates, merge leases, and merges belong to the mechanical merge tail, not to
implementation or review steps. Never operate on a production or appliance
checkout.

## Editing these instructions

This file is the routing and guardrail layer: branch-specific detail lives in
its owning document, with a trigger-first pointer here only when agents must
discover it. `package.json`, configuration, the directory tree, and `--help`
output are live authority — never cached here. One authoritative home per rule;
an obsolete path is removed when its replacement lands.

For the operator-facing HTTP route handbook, see [docs/operator-api.md](docs/operator-api.md). A change that adds, removes, or alters an HTTP route updates the handbook in the same change.
