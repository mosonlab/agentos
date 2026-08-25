# Repository instructions

These public rules apply to every repository change, including work in a fork.
Host configuration, credentials, and private operator procedure belong in the
operator documentation, not here.

## Work directly

Work in the current session by default. Create or dispatch a task chain only
when the human user explicitly requests one. Complexity may justify recommending
a chain; it does not authorize one.

When the user requests a chain:

- Use the direct chain when one implementation context window can deliver a
  brief whose change points are enumerable. Its `description` is the
  specification of record; write it using [`docs/BRIEF-TEMPLATE.md`](docs/BRIEF-TEMPLATE.md)
  before instantiating the chain.
- Use the full assurance chain when the work exceeds one implementation context
  window or decomposes into independently demonstrable slices worth executing
  in parallel. Its specification and plan stages own that decomposition.
- Keep the direct template's implementation assignee when the brief enumerates
  its change points. Assign `senior-dev-high` before the chain starts when the
  work touches persisted data, a defense-list path, or a surface too large or
  cross-cutting for the brief to enumerate. Defense-list paths are the merge
  gate, gate worker, migrations, release authority, and merge automation. When
  classification is uncertain, use `senior-dev-high`. Keep the review-fix
  step's template assignee, raising it to `senior-dev-high` under the same
  criteria.
- Archive a backlog card in the same action that dispatches its work or records
  the decisions that settle it. Leave only genuinely open questions on the
  board.

Before changing canonical Agents, roles, or task templates, read
[`agents/README.md`](agents/README.md). Its source map and the contract files it
names own canonical defaults; do not copy those defaults into another document.

## Design simply

Implement the simplest design that fully meets the current requirement. Add an
abstraction, configuration option, or compatibility path only when a current
acceptance criterion or caller requires it.

## Test safely

- Before tests outside the merge gate, set `RUNNER_WORKSPACE_ROOT` to a new
  temporary directory. Runner tests provision real workspaces.
- Run database tests only against a throwaway PostgreSQL server. Set
  `TEST_DATABASE_URL` and `TEST_DATABASE_MAINTENANCE_URL`, and give each
  worktree its own `?schema=`. `npm run test:db` drops and recreates its target.
- Spawn the real API entrypoint in tests through
  `packages/api/src/test-startup-environment.ts`. The entrypoint loads the root
  `.env`, and dotenv restores omitted credentials unless the helper pins them
  from the test URL.
- **Appliance checkout:** before changing files or branches in a checkout named
  by a loaded `com.agentos.*` service, read
  [`docs/runbooks/quiet-window-auto-deploy.md`](docs/runbooks/quiet-window-auto-deploy.md).
  Leave that checkout on clean `main`; do the work in a separate worktree.

[`CONTRIBUTING.md`](CONTRIBUTING.md) owns the full test-safety rules, disposable
development-database bootstrap, public-snapshot policy, and repository style.
Read the applicable section before acting on one of those surfaces.

## Deliver an exact head

`scripts/merge-gate.sh` is the only CI. A merge requires
`MERGE GATE: PASS <oid>` for the exact commit being merged:

```sh
scripts/merge-gate.sh --expect-head <oid>
```

The gate selects its proof profile from the exact baseline-to-candidate diff.
Only content modifications to its explicit prose allowlist use the `docs-only`
profile; structural changes, executable surfaces, and unknown paths use the full
profile. Callers cannot request the cheaper profile.

The gate owns an exclusive worktree lock. When another gate might be running,
use `scripts/gate-worker/gate-dispatch.sh <oid>` so the first free local or
remote slot runs it. Read [`docs/runbooks/gate-worker.md`](docs/runbooks/gate-worker.md)
before operating or troubleshooting a remote worker.

Every delivery that advances `main` — PR merge or direct push, regardless of
size — must acquire `scripts/merge-lease.sh` before beginning the final sequence
of integrating the latest `main`, running the merge gate, and performing the
merge. Release it immediately after the delivery lands or fails. Writing code,
pushing a feature branch, and opening a PR do not require the lease. The lease
keeps an exact-head gate proof valid from the moment its baseline is fixed until
that proof is consumed by the merge.

Pass `--task <id>` to both `acquire` and `release`. The default holder is
`user@host`, which every agent window on one machine shares, so without a task
id a release cannot tell its own lease from a sibling window's.

Several agent windows work one checkout at a time. Deliver from a dedicated
`git worktree` on your own branch, never by switching the shared checkout's
branch, and stage only the exact paths you changed. A branch switch in the
shared checkout carries away another window's uncommitted work.

## Frozen records

`docs/reviews/`, `docs/merge-notes/`, `docs/briefs/`, and
`docs/plans/archive/` contain dated, append-only records and are never current
authority. They live in the private operator repository and are not tracked by
this public repository.

`scripts/check-frozen-docs.sh` enforces immutable merged records, dated names,
byte-identical corrective renames, and the exact `> Superseded by
<repository-root-relative path> (YYYY-MM-DD)` marker shape. The gate cannot
detect a missing marker; reviewers must identify documents that stopped being
authority.

## Editing these instructions

Keep this file as the repository-wide routing and guardrail layer. Put
branch-specific detail in its owning document and add a trigger-first pointer
here only when agents must discover it. Treat `package.json`, configuration,
the directory tree, and command `--help` output as live authority instead of
caching them here. Keep every rule in one authoritative place and remove an
obsolete path when its replacement lands.
