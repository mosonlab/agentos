# Installation notes and verification

This file holds the detail that used to live in the README. The authoritative
installation sequence is
[`docs/release/developer-preview.md`](release/developer-preview.md).

## Start locally

The Developer Preview targets one platform: an Apple Silicon Mac. For this
release, use Node.js `22.17.0` from `.nvmrc`. Installation enforces Node.js satisfying `^20.19.0 || ^22.13.0 || >=24`,
the range shared by the locked toolchain; Node 22.12.x and 23 are refused. You
also need

- npm 10.9.2 or newer;
- Docker with Docker Compose, for the PostgreSQL service defined here;
- Git;
- the official **Codex CLI, already installed and already signed in**, under the
  same macOS account that will run the AgentOS runner;
- optionally, the GitHub CLI (`gh`), installed and authenticated under that
  account, if AgentOS should open pull requests automatically.

Codex is the only provider CLI this preview requires. The starter agent it
installs runs on Codex; Claude Code and the experimental Pi adapter are optional,
and a machine without them is a complete installation. AgentOS never logs you
into a provider and never reads a credential store.

```sh
git clone https://github.com/mosonlab/agentos.git
cd agentos
git checkout v0.3.0
npm ci
npm run setup:local
npm run build
docker compose up -d --wait --wait-timeout 60 postgres
export GOAL5A0_MASTER_SHA=8d69ee8544196a3310b3d63caf8ce5ec9a0e023b
export GOAL5A0_CONTROL_PLANE_A_SHA=29f8dd354cb99d671c2e2e4e9e23716fd8004f3d
npm run db:migrate:release -- --fresh
```

This is the release installation path, not a contributor bootstrap. Follow the
corrected, literal sequence in
[`docs/release/developer-preview.md`](release/developer-preview.md),
including its filesystem, port, runner identity and repository preflights. Then
start `npm run dev:api`, `npm run dev:runner` and `npm run dev:web`, in that
order, in three terminals, and open `http://127.0.0.1:5173`.

`npm ci` must be allowed to run the lockfile's lifecycle scripts — this
repository's `postinstall` generates the Prisma client — so `--ignore-scripts`
is not supported. The Inbox service is optional. No launchd definition is
shipped for the foreground Developer Preview sequence; remote access and this
repository's internal task-chain templates are also outside that sequence. A
separate self-hosted merge executor instead has documented but unverified macOS
LaunchDaemon and Linux systemd profiles in the public
[`docs/runbooks/merge-executor.md`](runbooks/merge-executor.md) runbook.
Those procedures do not change the platform classifications above or the
authoritative support matrix.

Read [`docs/release/security.md`](release/security.md)
before pointing this at anything, and
[`docs/release/migration-and-recovery.md`](release/migration-and-recovery.md)
before putting data in it.

`npm run db:migrate` is `prisma migrate dev`, and it is **development only**. It
is documented in `CONTRIBUTING.md`, not as an installation command. The guarded
release path above runs `npm run db:migrate:release -- --fresh`, which takes an
exclusive maintenance lock before it inspects schema state and holds it through
the guarded migration. An export without a valid `release-authority.json`
attestation stops rather than defaulting to trusted. `--existing` separately
implements the verified-bundle consumer, but this repository does not ship the
backup producer needed to create a conforming bundle. The supported release
workflow therefore remains fresh-only; `--existing` does not emit a synthetic
"interface unavailable" refusal and must not be treated as an end-to-end
supported migration path. The exact implemented sequence and refusal conditions
are in the release quickstart and migration guide. Packaging, notarization and
auto-update are not in this release candidate.

`npm run setup:local` writes `.env` once, at mode 0600, with distinct random
operator and runner tokens, a session-cookie secret, a base64 32-byte encryption
key, and one database password written identically into `POSTGRES_PASSWORD` and
`DATABASE_URL`. It prints a class and never a value. Its `--upgrade` form
preserves every assignment and adds only missing safe-to-generate keys; it never
rotates weak credentials automatically. There is no overwrite or rotation flag.
`.env.example` documents the keys; it is not a file to copy.

To provision the fail-closed merge executor, first read its
[operator runbook](runbooks/merge-executor.md), then run the repeatable
human-owned capture wizard from the repository root:

```sh
bash scripts/setup-merge-executor.sh
```

The wizard registers no App and performs no administrator action itself. It
captures the installation-local private GitHub App configuration, validates the
dedicated OS-user/key boundary without reading key bytes, and leaves explicit
root-owned service adoption to the matching runbook profile.

## Templates release demo

`npm run demo:templates -- preflight|setup|instantiate|capture|verify|reset`
drives the retained v0.2 twelve-node release-demo workflow; it is not evidence
for the current layered canonical templates. The demo's limits and exact
commands are in [`docs/demos/templates-release-demo.md`](demos/templates-release-demo.md).
The current Direct and Full Assurance graphs are documented in
[`agents/README.md`](../agents/README.md). A rehearsal or one provider run proves
neither universal provider compatibility nor a fresh install.

## Verification

The repository defines these checks, in this order:

```sh
npm run db:validate
npm run typecheck
npm run lint
npm run build
npm test
docker compose config --quiet
npm run test:dependency-gate
npm run test:snapshot-scan
npm run snapshot:scan
```

`npm test` runs every workspace's unit tests and needs no database and no
running service. It does need `npm run build` to have run first: the web CSS
regression test reads the built stylesheet out of `apps/web/dist/`, and without
it that one file fails with `Build apps/web before running CSS regression
tests`.

`npm run test:db` is separate on purpose and is **not** part of `npm test`. It
runs the API's database tests against a live PostgreSQL that the caller
supplies, through `TEST_DATABASE_URL` and `TEST_DATABASE_MAINTENANCE_URL`,
against a scratch database — never a database holding anything you want to keep.
Folding it into `npm test` would make the default check for a fresh clone fail
for a missing service rather than for a defect.

Those tests run several files at once, each against a database of its own: the
runner migrates one template and hands every file a `CREATE DATABASE ...
TEMPLATE` copy of it, plus its own subdirectory of `RUNNER_WORKSPACE_ROOT`,
`CONTROL_PLANE_STATE_DIR` and `FILES_ROOT`. The one shared schema is what used to
force the files into a queue, and separate databases also separate what a schema
never could — advisory locks are per database. Handing out databases needs
`AGENTOS_ALLOW_SCRATCH_DATABASES=1`, the opt-in the scratch-database manager
already requires; without it the run stays serial on the single shared schema,
exactly as before. `AGENTOS_DBTEST_CONCURRENCY` sets how many files run at once
(default: cores-1, at most four — a test file is not one process, and past four
of them a laptop is oversubscribed rather than busy) and
`AGENTOS_DBTEST_PROVISION=0` turns the per-file databases off. Every exit drops
what it created: a failure, a Ctrl-C, a failure while the databases are still
being handed out. A run that cannot drop one says so and fails, rather than
reporting the green tests it also had. Only a run killed outright can leave
`agentos_cp_a_*` databases behind, and the next run reclaims those before it
starts — by name, and only where the process that created it is gone and nothing
is connected to it.

`npm run test:dependency-gate` is in that list because root `npm test` is
`npm run test --workspaces --if-present` and never reaches `scripts/`. Without
this line the published `scripts/goal-5a0-*` files would ship with no executed
proof — the snapshot scan proves they are *listed*, not that they still refuse a
filesystem-root, checkout, non-empty, symlinked, or non-allowlisted evidence
destination. It needs no `node_modules` and no database.

`npm run snapshot:scan` reads the tracked worktree and requires it to match
`HEAD`; it fails closed on a dirty tree rather than attributing the change to
the reported commit.

The snapshot commands are documented in
[`docs/public-snapshot.md`](public-snapshot.md). A green scan is a scoped
release gate, not proof that pattern matching can find every possible secret.

`npm run lint` is a deliberately small gate, and `scripts/merge-gate.sh` runs it:
Biome checks an opt-in list of safety rules (`biome.jsonc`, each entry carrying
the reason it is there), and typescript-eslint checks the single type-aware rule
`no-floating-promises`, plus the one syntactic selector that closes that rule's
unavoidable `node:test` blind spot (`eslint.config.mjs`). It does not check
formatting, and running it never rewrites a file.

