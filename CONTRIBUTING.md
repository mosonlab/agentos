# Contributing

Thank you for reading this before opening something.

## The current state of contributions

Anneal v0.6.0 is a Developer Preview published so that people can evaluate it,
read it, and tell us where it is wrong. **We are not yet accepting outside pull
requests.** The review and merge process this repository uses is built around a
single gate run by maintainers, and we would rather say that plainly than leave
pull requests sitting unread.

What is genuinely useful right now:

- **Bug reports** with the release tag or commit, your platform, the exact
  command, and the exact reason code or message. The authoritative support
  statement is in
  [`docs/release/support-matrix.md`](docs/release/support-matrix.md).
- **Documentation corrections**, especially anywhere a document claims something
  the code does not do. That class of error is the one we most want reported, and
  a report naming the file and line is enough — you do not need to send a patch.
- **Security reports**, through the private channel in
  [`SECURITY.md`](SECURITY.md), never a public issue.

When outside pull requests open, this file will say so and will describe the
process. Until then, an issue is the contribution.

## If you are working in a fork

Everything below applies to anyone changing this repository, including someone
who arrived with a fork and no context.

### The gate

`scripts/merge-gate.sh` is this repository's only CI. It pins the candidate and
baseline, enforces frozen records, tests its automatic profile classifier, and
selects evidence from that exact diff. Content-only modifications to an explicit
prose allowlist use the `docs-only` profile: diff hygiene, the closed public
snapshot scan, and final HEAD/worktree drift. Adds, deletes, renames, mode
changes, runtime-coupled documentation, code, configuration, and unknown paths
use the full profile: a clean `npm ci` whose postinstall generates the database
client, the database CLI typecheck, repository lint, the whole-workspace build,
unit tests, the gate schema's migration, the database tests, and final drift
verification. A caller cannot select the cheaper profile. Those steps run as
three concurrent groups rather than one serial chain; every one of them still
runs, and a group passes only when all of its members do.

```sh
scripts/merge-gate.sh --expect-head <oid>
```

It holds a lock, so run one gate per worktree. A verdict belongs to the exact
commit it names — not to an earlier one on the same branch, and not to "the
branch".

This local command is the public path available to every clone and fork. Remote
gate workers are optional operator-provided infrastructure: the repository
ships their provisioning code, but no worker, hostname or credential. Use the
dispatcher only after configuring that capacity explicitly.

Some checks are deliberately outside the gate and belong to the list a developer
runs: `npm run test:dependency-gate` and `npm run verify:compose-binding`.

### Delivering to main

This section is for a repository maintainer with write authority to the target
`origin`. It does not grant an outside contributor authority to advance the
upstream repository.

A merge requires `MERGE GATE: PASS <oid>` for the exact integrated head being
merged (`scripts/merge-gate.sh --expect-head <oid>`). When another gate might
be running and remote capacity has been configured explicitly, dispatch through
`scripts/gate-worker/gate-dispatch.sh <oid>`; otherwise run the local gate. Read
[`docs/runbooks/gate-worker.md`](docs/runbooks/gate-worker.md) before operating
any remote worker.

For one candidate, acquire `scripts/merge-lease.sh` before running the merge
gate for the final integrated head and hold it until the merge consumes that
proof. Writing code, pushing a feature branch, and opening a pull request need
no lease. Pass `--task <id>` to both `acquire` and `release`: the default holder
`user@host` is shared by every agent window on one machine, so a release without
a task id cannot tell its own lease from a sibling's.

When two or three host-side pull requests are ready together, their feature
windows push, open the pull requests, and hand one coordinating window the
ordered `(PR number, exact head OID)` tuples. They do not acquire the lease or
advance `main` themselves. The coordinating window reads the gate-worker
runbook, then runs one fixed-width cumulative batch:

```sh
scripts/merge-train.mjs \
  --task <coordinator-id> \
  --candidate <pr>:<40-character-head> \
  --candidate <pr>:<40-character-head> \
  [--candidate <pr>:<40-character-head>]
```

The command builds nested merge prefixes, gates them concurrently, and acquires
the same merge lease only to publish the longest contiguous PASS prefix. A
conflict ends the batch at the preceding prefix; the coordinator never resolves
one. A stale `main` publishes nothing. Rerun the same command after a partial
publication: it reads live `main`, skips candidate heads already contained
there, and rebuilds the rest. The command requires an authenticated `gh` CLI to
verify exact PR state.

Changes to the merge train, merge lease, gate dispatcher, merge gate, or their
delivery authority use the existing single-candidate path. Delivery machinery
does not use its new implementation to authorize its own first publication.

Open the pull request right after pushing the feature branch, before
dispatching the gate: once the exact-head fast-forward lands, GitHub refuses a
pull request from a branch main already contains, while one opened beforehand
flips to merged on its own.

Several agent windows share one checkout, and a branch switch there carries
away another window's uncommitted work — the shared checkout stays on `main`
and never receives feature commits. Deliver from an isolated worktree on your
own branch: use your tool's native worktree mechanism when it has one, and
otherwise create one under a fresh temporary directory
(`git worktree add "$(mktemp -d)/checkout" <branch>`). Stage only the paths
you changed, and remove the worktree once merged.

### Testing red lines

These are not style preferences. Each one exists because ignoring it destroys
something outside the checkout.

- `export RUNNER_WORKSPACE_ROOT=$(mktemp -d)` before any test run. The runner's
  tests provision real workspaces, and without this they are provisioned wherever
  the configuration points — which on a working checkout is a directory holding
  someone's runs. The same applies to `home` in a hand-built `RunnerConfig`:
  provisioning keeps its persistent repository mirror under it.
- Database tests target a scratch PostgreSQL and nothing else. Point
  `TEST_DATABASE_URL` and `TEST_DATABASE_MAINTENANCE_URL` at a throwaway server,
  and give each worktree its own `?schema=` so parallel runs stay apart. Never
  point them at a database whose contents you would miss: `npm run test:db` drops
  and recreates what it is given.
- A hand-built scratch server has three requirements the harness enforces but
  does not advertise, each of which otherwise costs a full run to discover.
  Export `AGENTOS_ALLOW_SCRATCH_DATABASES=1`; the `@anneal/db` suite refuses
  without it. Give the server a password of at least 24 characters, because the
  tests that spawn the real API entrypoint inherit it as `POSTGRES_PASSWORD` and
  the startup check refuses a shorter one. Name a schema other than `public` in
  `TEST_DATABASE_URL`, because the harness resets the schema it is given.
- Do not commit while a database suite is running. `build-provenance.dbtest.ts`
  asserts that the build stamp names the commit the worktree is at, so a commit
  mid-run fails the suite on the first file and aborts everything after it.
- Repository-owned canonical templates are edited in `agents/templates/` and
  reach production through an ordinary pull request; the closed sync contract
  remains enforced here. Operators can clone canonical or custom templates and
  edit unused, non-canonical clones through the API documented in
  [`docs/operator-api.md`](docs/operator-api.md).
- A checkout named by a loaded Anneal service is an appliance checkout. Follow
  its ownership and isolation contract in
  [`docs/runbooks/quiet-window-auto-deploy.md`](docs/runbooks/quiet-window-auto-deploy.md);
  use a separate worktree for development. A fresh worktree needs
  `npm install && npm run db:generate && npm run build -w @anneal/db` before
  anything else works.

### Development database bootstrap

`npm run db:migrate` is `prisma migrate dev`. It bypasses the release migration
preflight and may create or rewrite development migration history. Use it only
against a disposable developer database. It is never an installation or upgrade
command; the release install path is `npm run db:migrate:release -- --fresh`.
Adding a migration does not bump `RELEASE_CANDIDATE_MIGRATIONS`; the release-cut
commit (the `chore(release): prepare` commit) does.

### The public surface is closed by default

`public-snapshot.json` names what may be published. Every tracked file must be
classified: a file no rule reaches is a scan failure, not a silent inclusion. If
you add a file that belongs in the public release, add it to the manifest with a
purpose; if it does not, add it to the exclusions with a reason. `npm run
snapshot:scan` checks this, and it requires a clean worktree matching `HEAD`.

### Records that do not change

`docs/reviews/`, `docs/merge-notes/`, `docs/briefs/` and `docs/plans/archive/`
are dated records of finished work: append-only, and never current authority.
They are not kept here — they live in this project's private operator
repository — so nothing you contribute needs to read them.
`scripts/check-frozen-docs.sh` still runs in the gate: it would enforce those
directories if they appeared, and it enforces the `> Superseded by ` marker
shape on every tracked `*.md`.

### Style

Match the code you are changing. Comments in this repository explain why a thing
is the way it is, not what the line does; several of them exist because the
obvious alternative was tried and was wrong. If you remove one, be sure you know
which failure it was standing in front of.
