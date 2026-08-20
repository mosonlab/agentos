# Changelog

What changed in each release of AgentOS, written for the people who run it.
Entries group changes by the part of the product they touch. Versions follow
Semantic Versioning; before 1.0.0 a minor version may change behaviour, and this
file says so where it does.

## v0.1.0 — Developer Preview

The first release of AgentOS: a local, single-operator control plane for handing
scoped software tasks to coding CLIs already installed on your own machine, and
for keeping what they did observable and durable. There is no earlier version, so
this entry describes the surface rather than a difference from one.

AgentOS orchestrates coding CLIs you have already installed and signed into. It
bundles no subscription, resells no capacity, never logs you into a provider and
never reads a credential store; your provider account, its plan limits and its
availability remain yours.

Supported target: macOS on Apple Silicon, Node.js `^20.19.0 || ^22.13.0 || >=24` with
npm 10.9.2 or newer, Docker with Compose, and Git. Linux is unverified. Windows
is unsupported — the runner relies on POSIX process-group, path and command
behaviour.

### Installation and first run

- `npm run setup:local` generates local configuration in one step: distinct
  random operator and runner tokens, a session-cookie secret, a 32-byte
  encryption key and one database password, written to `.env` at mode `0600`. It
  prints a class (`configuration-created`, `configuration-valid`,
  `configuration-raced`) and never a value, and it refuses to overwrite or repair
  an existing file.
- A database with no projects in it opens a five-screen installation wizard and
  nothing else. It states what it is about to create — an environment that is
  honestly open, a starter agent that runs with your own user's authority, no
  filesystem grant, a repository grant that can push — and the server refuses an
  installation whose acknowledgement of that disclosure is false.
- Installing writes the project, environment, starter agent, repository and
  access grant in one transaction, or none of them. Submitting twice creates one
  installation.
- A repository remote that embeds a password or a token is refused, in the
  browser and again on the server, from one shared policy table so the two cannot
  drift apart.
- The supported Node.js range is enforced rather than warned about, by the
  package manifest and by the configuration generator.

### Control plane and console

- A React/Vite console and a Hono API over PostgreSQL expose projects, agents and
  capabilities, tasks and task detail, task chains and approvals, runs, sessions,
  the Inbox, triggers and automations, connections, secrets, settings and an
  archive.
- The console is available in English and Chinese.
- Task state is stored separately from durable run and session-event records, so
  what happened is retained independently of what is currently queued.
- Goals are stored and editable — a goal, its definition of done, its progress log
  and its limits — but no execution model is wired to them: nothing schedules work
  from a goal, nothing measures its spend and nothing stops it on spend, time or
  stall. The console shows no spend figure and no stopped state because the server
  has no writer for either.

### Task execution and the local runner

- The runner claims queued work with a fenced lease, clones the selected
  repository into a controlled per-run workspace, and creates or resumes a
  run-specific branch.
- Provider preflight checks the configured binary, its version command and login
  status before an agent starts, so a missing or signed-out CLI is reported as
  that rather than as a failed run.
- Provider and tool events are recorded as structured records while the agent
  works; the agent logs notable progress and persists its task output.
- Runs are bounded by a wall-clock limit and a stall timeout.
- Successful workspaces are removed; a bounded number of failed ones may be kept
  for recovery according to runner configuration, and orphaned workspaces can be
  reclaimed deliberately by the operator.
- Exactly one API control plane may own a canonical workspace root, and ownership
  is acquired before the database client is imported or reconciliation begins.
  Runner daemons are ordinary clients, and any number of them may poll that one
  API.

### Coding CLI support

- **Codex CLI** — verified adapter and runtime, and the backend the starter agent
  uses. It is the only provider CLI a complete installation requires.
- **Claude Code** — verified adapter and runtime; subscription authentication is
  maintainer-verified on macOS Apple Silicon.
- **Pi** — an experimental adapter, outside the supported surface of this
  release.
- Codex and Claude receive the AgentOS session tools over a per-run stdio MCP
  server; Pi receives the corresponding task tools through an extension.

### Scheduling, triggers and human questions

- Recurring automations run tasks on a schedule, with the next fire and the
  current state shown as one status rather than inferred from several fields.
- Webhook triggers can start work from outside, authenticated by a stored secret;
  a disabled secret is reported as such rather than as a pause.
- An agent can ask a blocking human question through the Inbox and wait for the
  answer, and the operator can answer it from the console.

### Git delivery and review

- AgentOS captures the git result of a run and pushes the run branch. The run's
  "opens a pull request" setting controls whether delivery also attempts to open
  one.
- A gated task moves to review for a human decision; an ungated successful task
  can finish on its own.

### Files, grants and secrets

- No filesystem grant is created by default. Files Root mutations require a
  lease-bound per-run session token and a matching filesystem grant.
- The Files store refuses hostile path strings, does not follow symlinks when
  listing or stating, opens final paths without following links, and treats
  hardlinks as a separate escape: reads refuse a multiply-linked regular file and
  writes land on a private new inode renamed over the target.
- Stored secrets are encrypted with AES-256-GCM; neither plaintext nor ciphertext
  appears in the API's secret representations. Per-run credentials are written at
  mode `0600` inside the throwaway workspace and are excluded from git locally.
- Child processes receive an explicit environment — configured `PATH`/`HOME`, run
  identity, session credentials and granted secrets — rather than a copy of the
  host environment.

### Security posture

- The API refuses to start on anything but the loopback interface; the database
  service publishes on loopback only; the console's dev/preview server decides per
  request that the caller is its own loopback origin before attaching the
  operator's authority.
- Operator, runner and per-run session principals are separate, with independently
  scoped routes and session tokens that expire or are revoked with the run.
- Runner-authenticated run-state writes, and the session event, activity, output,
  Inbox and completion paths, are checked against the run's fencing generation; a
  stale or expired generation is rejected and the runner terminates the provider's
  process group.
- There is deliberately no credential in the browser bundle: a token-shaped
  `VITE_*` key is a startup refusal, and a hygiene scan checks the built bundle
  for token variables, bearer headers and this checkout's own generated values.

### Database and migrations

- PostgreSQL through Prisma, with the schema and its migration history in the
  repository.
- Two commands change a schema and they are not alternatives. `npm run db:migrate`
  is `prisma migrate dev`: development only, no preflight, and it will rewrite
  history. `npm run db:migrate:release` is the release path and the only
  supported migration command: it proves the target is this checkout's own
  database, proves the target is empty in fresh mode, proves the migration set is
  the recorded release candidate, and only then runs the migration through
  `npm run db:migrate-goal-execution`, which is exactly
  `db:preflight-goal-execution && prisma migrate deploy`.
- Refusals print stable, machine-readable lines — `STOP release-migrate
  <condition>: <reason>` — carrying no URL, password, database name, container id,
  path or raw subprocess output.
- The release path recognises `--force`, `--skip-preflight` and `--no-preflight`
  only in order to refuse them by name.

### Release and supply-chain safety

- The public snapshot is closed by default: a manifest names what may be
  published, repository-wide deny rules keep private, generated and installed
  path classes out, and every remaining tracked file must be classified — a file
  nobody has looked at is a scan failure, not a silent inclusion.
- The snapshot scan reads the tracked worktree, requires it to match `HEAD`, and
  fails closed on a dirty tree rather than attributing changes to the reported
  commit. It looks for credentials, personal data, private absolute paths and
  internal-only material.
- The migration preflight refuses to run without evidence that the migration set
  passed review. A published snapshot can carry that evidence as a signed
  attestation verified against a public key the repository tracks; an absent
  attestation refuses rather than defaulting to trusted.

### Verification

- `npm test` runs every workspace's unit tests and needs no database and no
  running service; it does need a build first, because one CSS regression test
  reads the built stylesheet.
- `npm run test:db` is separate on purpose. It runs the API's database tests
  against a PostgreSQL the caller supplies, on a scratch database — never one
  holding anything you want to keep. Several files run at once, each against a
  database of its own, cloned from one migrated template; the per-file databases
  are opt-in, the concurrency is configurable, every controlled exit drops what it
  created, a database that cannot be dropped fails the run, and a run killed
  outright leaves databases that the next run reclaims by name.
- A single merge gate is this repository's only CI, and it runs, in order: the
  append-only check on frozen records and that checker's own fixtures, a clean
  `npm ci`, the database client generation, typecheck and lint across every
  workspace, the build, every workspace's unit tests, the gate schema's
  migration, the database package's preflight tests, the API's database tests,
  and a final check that the commit it gated is the commit it started from. It
  does not run the snapshot scan, the dependency gate, the CLI help check or the
  Compose validation; those are in the verification list a developer runs, and
  this entry does not promise a gate that has them.

### Known limitations

- **Not a sandbox.** The provider adapters launch the coding CLI with
  non-interactive permission-bypass flags. With the shipped same-user default the
  agent runs with your own user's authority; AgentOS grants constrain AgentOS's
  own APIs and give an audit trail, but they are not operating-system
  containment.
- **No enforced network isolation.** The environment a fresh installation creates
  is labelled open because it is.
- **Loopback only.** There is no remote authentication design — no login, no
  per-user identity, no session model for anyone but the machine's own operator.
  A tunnel or reverse proxy does not add one, and exposing any of it is
  unsupported.
- **The repository access level does not gate delivery's push.** A repository
  access row is required when a task is created and claimed, but its read/write
  level is not what decides whether the branch is pushed. Treat any repository you
  register as writable by the agent.
- **The Files path walk can be raced** by an adversary who can already write
  inside the Files Root: an intermediate directory can be swapped after the walk
  has checked it and before the open. Closing it needs a native helper; until then
  the backstop is deployment, and the API refuses to boot when the Files Root
  overlaps the run workspace root.
- **Runner separation is partial.** Running the CLI under a dedicated account
  separates runners from each other; one runner's account still owns every
  workspace it has created.
- **Migrating an existing installation is not supported.** `--existing` stops at
  `oss-d-interface-unavailable`: the verified-backup attestation producer its
  safety story rests on has not merged, and a command that validated a bundle no
  producer creates would look guarded without being it. Fresh mode is the
  supported path; its one precondition is the preflight's `authority` evidence,
  which a release clone carries as `release-authority.pub` and
  `release-authority.json`. These are refusals of a real command, and the fix is
  not to take the preflight out of the path.
- **The unguarded migration bypass is procedural, not closed.** Nothing prevents
  running `prisma migrate dev` or `prisma migrate deploy` against a database by
  hand, with no preflight.
- **No down migration, no supported restore.** Rolling back code does not roll
  back the database, and restoring over a database something is still using is not
  a supported operation of this release.
- **No secret rotation command.** Replacing generated values is a deliberate human
  recovery; rotating the secret encryption key while encrypted rows exist destroys
  them unrecoverably.
- **No upgrade path between preview builds** other than a fresh install. Nothing
  is packaged, notarized or self-updating.
- **Goals have no execution model**, as described above.
- **The command-line interface exposes only `agentos help`.** Broader command
  families are not part of this release.
- **Five surfaces merged without an independent implementation review.** Four —
  the control plane's workspace ownership change, the public snapshot mechanism,
  the templates release closure, and the documentation factual-accuracy pass —
  were reviewed as plans but not as written code, and the verified-backup
  attestation producer was not reviewed at all. The gap is recorded rather than
  closed; the reviews happen after the cutover and any finding lands as
  `v0.1.1`. [`docs/release/v0.1.0-release-notes.md`](docs/release/v0.1.0-release-notes.md)
  names each surface.
- **The release snapshot was assembled by hand.** The deterministic builder and
  provenance manifest the plan calls for are deferred to `v0.1.1`; reproducibility
  for this release is evidenced by two independent builds agreeing on one commit
  id and by independent recomputation of the tree hash.
  [`docs/release/v0.1.0-release-notes.md`](docs/release/v0.1.0-release-notes.md)
  states what was and was not done.
- **The release verification harness is mostly unbuilt.** One of the 25
  `verify:oss-f0` checks is implemented; the rest refuse rather than pass, and the
  release steps they were written to close were closed with direct evidence
  recorded at the exact commit. Deferred to `v0.1.1`.
- **Some published files reference paths the snapshot holds back**, including
  four `package.json` scripts that fail when run from a clone. Deferred to
  `v0.1.1`.
  [`docs/release/v0.1.0-release-notes.md`](docs/release/v0.1.0-release-notes.md)
  says which.
