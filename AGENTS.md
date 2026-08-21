# Repository instructions

These are the rules that hold for anyone changing this repository, including
someone who arrived with a fork and no context. Anything specific to one
operator's machine, hosts, or internal process lives in this repository's
private operator documentation and is deliberately not here.

## Merge gate

`scripts/merge-gate.sh` is this repository's only CI. Present a branch for merge
only with a `MERGE GATE: PASS <oid>` verdict for the exact commit being merged —
not for an earlier one on the same branch, and not for "the branch".

```
scripts/merge-gate.sh --expect-head <oid>
```

It holds a lock, so run one gate per worktree. The script header documents its
variants and what each stage proves. If you ran the gate somewhere other than
the machine that will merge, say so in the pull request.

When anything else might also be running a gate, dispatch instead of running
directly: `scripts/gate-worker/gate-dispatch.sh <oid>` runs the gate in the
first free slot — this machine, then one of the offshore worker's two — and
blocks until a slot frees up. `docs/runbooks/gate-worker.md` is the worker's
runbook, including what a remote PASS is and is not worth.

## Dispatching chains

Choosing a template: work that fits a single implementation context window
goes through the direct chain — the discussion that produces its brief is the
spec phase, done off the board. Work too large for one window, or that
decomposes into independently demonstrable slices worth executing in
parallel, goes through the full assurance chain, whose spec and plan steps
perform that decomposition under human approval gates. Trivial chores stay
off the board entirely.

Instantiating a direct chain: the `description` you pass is the chain's
specification of record — write it as a feature brief per
`docs/BRIEF-TEMPLATE.md` before instantiating.

A backlog card leaves the board the moment its content is taken over, and by
whoever takes it over: dispatching a chain from a card, or recording the
decisions that settle a discussion card, ends with archiving that card (with
an activity pointing at the chain or brief) in the same action. Cards with
genuinely open questions stay — that is what the backlog is for.

## Testing red lines

- `export RUNNER_WORKSPACE_ROOT=$(mktemp -d)` before any test run. The runner's
  tests provision real workspaces, and without this they are provisioned
  wherever the configuration points — which on a working checkout is a directory
  holding someone's runs.
- Database tests target a scratch PostgreSQL and nothing else. Point
  `TEST_DATABASE_URL` and `TEST_DATABASE_MAINTENANCE_URL` at a throwaway server,
  and give each worktree its own `?schema=` so parallel runs stay apart. Never
  point them at a database whose contents you would miss: `npm run test:db`
  drops and recreates what it is given.
- The API entrypoint loads the repository root `.env` itself, and dotenv never
  overwrites a variable that is already set. So a test that spawns the real
  entrypoint cannot remove a variable by omitting it — the child refills it
  from `.env` and fails validation on a value the test never chose, with an
  error that looks nothing like the behaviour under test. Spawn through
  `packages/api/src/test-startup-environment.ts`, which pins the credential
  variables by deriving them from the URL the test hands it.
- A running installation's API, its configuration directory, its service
  definitions, and its built output belong to whoever is running it. Work in a
  separate worktree, not in a checkout something is serving from. A fresh
  worktree needs `npm install && npm run db:generate && npm run build -w
  @agentos/db` before anything else works.
- When a GitHub write (push, pull request, comment) returns an error, read the
  remote back to check whether it landed before resending.

## Records that do not change

`docs/reviews/`, `docs/merge-notes/`, `docs/briefs/` and `docs/plans/archive/`
are dated records of finished work: append-only, and never current authority.
They are not kept here. They live in this project's private operator
repository, and nothing in this repository is meant to be read against them.

`scripts/check-frozen-docs.sh` runs in the gate and enforces exactly three
things, no more: a file merged into one of those four directories is neither
modified nor deleted; a file added to one is named `YYYY-MM-DD-…`; and any line in a tracked `*.md` file that begins
`> Superseded by ` is that file's first line, is exactly the shape
`> Superseded by <repository-root-relative path> (YYYY-MM-DD)`, appears once,
and names a path the commit tracks. A record merged under a wrong name can be
corrected only by a byte-identical rename inside its own directory to a dated
name — nothing else about a merged record may change. The first two rules have
nothing to act on while those directories are absent from this repository; the
third applies to every tracked `*.md`, and is why the check stays in the gate.

What the gate cannot decide is whether a document that *should* carry a
supersession marker does: no diff says "this stopped being authority". That half
stays human, so do not quote the gate as proof that a document is correctly
filed.
