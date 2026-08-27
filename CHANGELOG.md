# Changelog

What changed in each release of AgentOS, written for the people who run it.
Entries group changes by the part of the product they touch. Versions follow
Semantic Versioning; before 1.0.0 a minor version may change behaviour, and this
file says so where it does.

## Unreleased

### Documentation

- Reduced the published documentation surface: the support note and evidence
  status now live in the README, three operator runbooks are maintained outside
  this repository, and the Simplified Chinese inner documentation pages have
  been retired.

### Snapshot safety

- The public snapshot scanner now fails when an include glob matches no
  git-tracked path.

## v0.3.0 — Developer Preview 3

The third preview. The headline is delivery: the merge tail now runs itself,
from gate proof through review repair to a serialized exact-head merge, and
chains execute in explicit layers that the API and the console both show. As
with every 0.x minor, behaviour changes below are breaking-eligible, and there
is still no upgrade path between previews other than a fresh install. This
release adds ten migrations, including an expand/backfill/contract sequence over
chain layers.

### Merge delivery

- The merge tail is autonomous: a repair loop that reads review severity,
  recovers parked work, hands repair tasks the chain's context and a second
  attempt, and binds the gate proof to the regression head it was produced
  against.
- Merge delivery is serialized on the exact head, recovers pre-merge base drift
  automatically, and centralizes recovery authority instead of deciding it at
  each call site.
- The merge lease is parsed once and its release reports a typed outcome, and
  the hold window is narrowed to the merge itself — see
  [`docs/adr/0001-merge-lease-hold-window.md`](docs/adr/0001-merge-lease-hold-window.md).
- Merge credentials are minted through a private GitHub App, and the
  provisioning path for a self-hosted merge executor is public and documented in
  [`docs/runbooks/merge-executor.md`](docs/runbooks/merge-executor.md).

### Task chains and canonical agents

- Chains have explicit execution layers. The schema expands with a legacy
  backfill and then contracts onto the layered shape, the API exposes layers and
  progress, and the console renders them with blocked-on markers.
- Canonical templates are layered, their review sources split, and their prompts
  now load from markdown rather than from inlined strings. A six-step direct
  engineer workflow template ships alongside the full-assurance chain.
- Blind review and adjudication are separate roles with their own authority
  guard and physical isolation, and the review base is pinned in the schema
  rather than inferred.
- The spec and revise-plan approval gates are removed and the plan reviser
  retiered; regression verification is streamlined, routed to Sol, and its
  repair handoffs are bound to the run that produced them.
- Chain prompts are aligned with the upstream mattpocock-skills baseline, both
  senior-developer roles adopt its implement cadence, `senior-dev-luna` is the
  direct chain's implementation default, the librarian moves onto the Pi runner,
  and canonical model routing is re-pinned across the fleet.
- Implementation runs on native Luna subagents, with configurable executioner
  subprocess profiles and Codex service tiers.

### Control plane and API

- Task dispatch binding: a chain can be instantiated bound to a predecessor
  task, terminal steps dispatch on that binding, and the start guard reports
  chain detail.
- Runs and the merge tail have explicit operator control, unclaimed queued runs
  can be cancelled, and an archived task's Inbox messages are superseded rather
  than left open.
- Refusal-to-HTTP mapping is centralized, and `app.ts` is split into modules
  along its own seams.
- The board confirms task starts, orders cards by activity, shows an approval
  gate's full artifact, and shows estimated cumulative run cost.
- Model and runner choices saved in the Agents page are durable operator
  overrides; canonical seed and prompt sync no longer replace them.

### Runner

- Workspaces are provisioned from a machine-local bare mirror instead of a fresh
  network clone, and provisioned dependencies are cached safely.
- Platform CLI configuration is isolated from the host's, and Pi per-message
  usage is captured into the session columns.

### Development and operations

- The help-only repository command-line interface is retired; this release no
  longer builds or ships an `agentos` binary.
- Production upgrades run in a quiet window without an operator at the keyboard.
- The offshore merge-gate worker is revived with a per-repo layout and a slot
  dispatcher, supports two slots per worker and primary-worker failover, and
  classifies docs-only changes onto a shorter profile. The gate itself runs its
  checks concurrently.
- The README is a landing page again: the evidence tables, architecture, and
  installation and verification detail moved into `docs/`, and the release
  documents that are not tied to one version lost their `v0.1.0-` filename
  prefix.

## v0.2.0 — Developer Preview 2

The second preview. The headline is the task-chain overhaul: the twelve-step
template now plans for parallelism and implements in parallel waves, its code
review runs as two independent blind paths, and the whole chain has been
exercised end-to-end on an isolated rehearsal stack before this release. As
with every 0.x minor, behaviour changes below are breaking-eligible and there
is no upgrade path between previews other than a fresh install.

### Task chain and canonical agents

- The full-assurance code review step is now a dual-path blind review: an
  independent review on the Codex side, a blind review and final adjudication
  on the Claude side, and a regression verification of the applied fixes.
  Legacy nine-step templates are preserved and pinned rather than migrated.
- The twelve-step chain prompts were rewritten end to end. Planning cuts
  tracer-bullet slices engineered for parallel execution; implementation
  schedules those slices in dependency waves, one isolated git worktree and one
  background subprocess per slice, merging serially at each wave barrier; the
  review prompts drive the native `codex exec review` harness in two passes
  with the review range declared in the prompt. Plan review now prices every
  merge and added dependency edge against the frontier width the plan was
  engineered for.
- Chain artifacts (spec, slices, session labels, review findings) live under
  `.chain/<branch>/` on the chain branch.
- The task-claim API now honours a step's `attachmentsFromPrevious=false`, so
  the blind review step really does start blind instead of receiving prior
  step outputs.
- `npm run db:sync-canonical-prompts -w @agentos/db` synchronises every
  canonical step prompt and role prompt from the repository into an existing
  installation, idempotently.
- Seeded skills are retired. The runner never injected them, so the `agents/`
  contract drops the skills pipeline entirely; skills remain an API-managed
  concept.
- The librarian role runs at a higher reasoning tier.

### Control plane and API

- Control-plane ownership recovery is hardened, and ownership tolerates device
  identity drift across restarts.
- The shared maintenance lock recovers its sessions after the lock backend is
  lost, and retains itself across connection-pool recycling.
- Onboarding validates its prerequisites, local service startup is bounded, and
  toolchain and runner identity are enforced.
- Backup quiescence attestations are validated before an existing-mode
  migration will accept them.
- The default session budget is 240 minutes.

### Web

- Agents page: archived agents move to their own tab.

### Development and operations

- The merge gate is substantially faster: independent checks overlap, isolated
  database suites run concurrently, lint workers stop oversubscribing the
  machine, and gate caches publish atomically with their integrity preserved.
- Sanitized operational harnesses are published in-repo.
- `npm run setup:local` can repair an existing local configuration safely.
- Public snapshot scanning is hardened, template release gaps are closed, and
  the v0.1.0 install guidance corrections are folded into the released docs.
- The README shows the task board and agents screens.

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
  does not run the snapshot scan, the dependency gate or the Compose validation;
  those are in the verification list a developer runs, and
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
- **The v0.1.0 command-line interface was help-only.** The tagged v0.2.0 release
  retained it; current main retires it for the next minor release.
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
