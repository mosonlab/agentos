# Repository instructions

Public rules for every repository change. Host configuration, credentials, and
private operator procedure stay in the operator documentation outside this
repository. Two kinds of reader use this file: an agent executing inside an
Anneal run (`AGENTOS_RUN_ID` is set in its environment) and a person or agent
in a host window. Read "Everyone", then only the section for your kind.

## Everyone

- Design simply: implement the simplest design that fully meets the current
  requirement; add an abstraction, configuration option, or compatibility path
  only when a current acceptance criterion or caller requires it.
- Verify narrowly: build, lint, typecheck, and test only the workspace(s) your
  change touches (`npm run <script> -w <workspace>`, named test files such as
  `npm run test:db -w @anneal/api -- src/<file>.dbtest.ts`). Never run a whole
  database suite or a repository-wide root script by hand; the merge gate owns
  repository-wide proof.
- Before tests outside the merge gate, point `RUNNER_WORKSPACE_ROOT` at a new
  temporary directory; a hand-built `RunnerConfig` also pins `home` to one.
  Runner tests provision real workspaces.
- Spawn the real API entrypoint in tests through
  `packages/api/src/test-startup-environment.ts`: the entrypoint loads the root
  `.env`, and dotenv restores omitted credentials unless the helper pins them
  from the test URL.
- Before changing canonical Agents, roles, or task templates, read
  [`agents/README.md`](agents/README.md); it and the contract files it names own
  canonical defaults.

## Inside an Anneal run

Your checkout is exclusive to this run and already on the chain branch. Create
any worktree you need inside your own run workspace (a relative path such as
`./worktrees/<name>`), never outside it. Commit your work; the platform pushes,
opens the pull request, and runs the Regression step and merge tail. Never run
`scripts/merge-gate.sh`, `scripts/gate-worker/*`, or a repository-wide root
script inside a run: the guard refuses them, and the Regression step runs the
gate on the gate worker. Never operate on a production or appliance checkout.

## In a host window

- Work in the current session by default; create or dispatch a task chain only
  when the human user explicitly requests one. Everything about chains — tier
  selection, the brief, implementation-assignee routing, chain-to-chain
  sequencing, and the backlog card lifecycle — is owned by
  [`docs/governance/task-routing-v1.md`](docs/governance/task-routing-v1.md);
  qualify dependencies there before every instantiation.
- Database bootstrap, the testing red lines, and the delivery procedure —
  gate, gate dispatch, merge lease, pull-request timing, and worktree
  isolation — are owned by [`CONTRIBUTING.md`](CONTRIBUTING.md); read the
  applicable section before acting on one of those surfaces. Never switch
  branches or commit feature work in the shared checkout: deliver from an
  isolated worktree on your own branch, and remove the worktree once merged.
- Appliance checkout: before changing files or branches in a checkout named by
  a loaded `com.agentos.*` service, read
  [`docs/runbooks/quiet-window-auto-deploy.md`](docs/runbooks/quiet-window-auto-deploy.md).
  Leave that checkout on clean `main`; work in a separate worktree.

## Editing these instructions

This file is the routing and guardrail layer: branch-specific detail lives in
its owning document, with a trigger-first pointer here only when agents must
discover it. `package.json`, configuration, the directory tree, and `--help`
output are live authority — never cached here. One authoritative home per rule;
an obsolete path is removed when its replacement lands. A runnable command
literal is an instruction to every reader whose section contains it: the only
commands written into "Everyone" or "Inside an Anneal run" are ones a run may
execute; host-workflow commands live in host-facing documents, reached from "In
a host window" by pointer.

For the operator-facing HTTP route handbook, see [docs/operator-api.md](docs/operator-api.md). A change that adds, removes, or alters an HTTP route updates the handbook in the same change.
