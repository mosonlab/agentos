# Changelog

What changed in each release of Anneal, written for the people who run it.
Entries group changes by the part of the product they touch. Versions follow
Semantic Versioning; before 1.0.0 a minor version may change behaviour, and this
file says so where it does. Releases up to v0.3.0 were published under the
project's former name, AgentOS, and their entries below are left as they were
written.

## Unreleased

## v0.5.0 — Developer Preview 5

The fifth preview makes the board read at chain level, makes completed work
self-clearing, and replaces the maintainer appliance's mutable checkout deploy
with immutable release directories. As with every 0.x minor, behaviour changes
below are breaking-eligible. There is still no supported upgrade path between
previews other than a fresh install. This release adds five migrations.

### Board and task lifecycle

- Chains collapse into aggregate board cards that carry their task count,
  progress and available actions. The individual tasks remain available in the
  chain and task detail views.
- Individual task moves are projected from operator-owned transitions rather
  than from every status the runtime can produce. Aggregate chain cards expose
  activation, filtering and archival actions; they are not draggable.
- DONE tasks are archived automatically after seven days, in batches of at
  most 100 tasks. A chain member becomes eligible only after every persisted
  member of that chain is DONE.
- `DELETE /tasks/:taskId/chain` deletes a whole chain and its marker-bound
  repair tasks atomically. It refuses while active runs or retained run/session
  history remain. Chain members can no longer be deleted individually through
  `DELETE /tasks/:taskId`.
- Card rendering, pagination and status projection now share one contract
  between the desktop board, mobile list and API.

### Costs

- The Costs page is rebuilt as a two-column dashboard with model, cache and
  waste breakdowns, while preserving the period totals and top-run views.
- The API now reports model and cache usage, reconciles rounding in the model
  breakdown, and fixes date-bucket gaps across local day and DST boundaries.
  The costs endpoint now requires an IANA `tz` query parameter; omitting it
  returns `400` rather than guessing a timezone.

### Merge-tail reliability

- Readiness claims have an explicit durable handle, so only one worker owns the
  transition while recovery reads are performed.
- Merge-lease handoffs and deferrals are recorded in a durable ledger, and
  deferred releases are indexed and retried rather than being lost after a
  transient failure.
- Requeue attempt authority and budget are persisted for merge-tail repair, and
  chain deletion is serialized with concurrent member creation.
- Recovery refusals and merge-tail transitions are typed and applied through
  shared decision seams, preserving the existing external behaviour while
  removing competing implementations.

### Maintainer deployment

- The macOS appliance deployment path now assembles immutable, verified release
  directories and activates them through an atomic `current` pointer. Service
  wrappers read that pointer, so deployment no longer mutates or serves a source
  checkout.
- A durable ledger records build, backup, migration, activation, verification
  and rollback evidence. Database maintenance runtime and nested dependency data
  are included in the verified artifact.
- These changes apply to the maintainer appliance. The public Developer Preview
  continues to use the foreground fresh-install sequence in the README.

### Release and support surface

- **The public `verify:oss-b0` and `test:oss-b0-harness` commands are removed as
  a breaking change.** No compatibility alias or
  replacement harness is provided. Current verification remains with
  `scripts/merge-gate.sh` and its `scripts/gate-worker/` dispatch path, `npm run
  test:release-docs`, `npm run test:dependency-gate`, `npm run
  verify:secret-hygiene`, and the public-snapshot scans. The merge-integrator
  real/system checks and documented templates release demo remain unchanged;
  the frozen OSS-B0 smoke fixture remains for release, UI and API parity.
- The project-scoped goal action aliases are removed. Call
  `POST /goals/:goalId/approve-dod` and `POST /goals/:goalId/pause` instead of
  the former `/projects/:projectId/goals/...` routes.
- `view=board` adds a `chainAggregate` projection to one row in each chain. The
  web client uses it to render one aggregate card while the API retains the
  underlying task rows.
- Settings now reports the Anneal product version and exact build SHA returned
  by `/version`, separately from runner daemon and provider CLI versions. A
  failed version request is shown as a failure rather than as an unknown build.
- Repository links recognise both SCP-style and `ssh://` GitHub remotes while
  rejecting unsupported SSH remote shapes.
- The README is rewritten around the unattended chain workflow, with current
  board and agent views, clearer trust boundaries and a Linux Do community link.

### Known limitations

- There is no supported in-place upgrade from v0.4.0. Install v0.5.0 against an
  empty schema with `npm run db:migrate:release -- --fresh`.
- macOS on Apple Silicon remains the only target platform. Linux remains
  unverified and Windows unsupported.
- Anneal still launches coding CLIs with the operator account's authority and
  is not a sandbox.

## v0.4.0 — Developer Preview 4

The fourth preview, and the first under the name Anneal. The headline is
operator control over a running chain: a chain can be held mid-flight and
resumed exactly once, and the console's Sessions and new Costs pages make what
a chain did and what it cost readable without leaving the browser. As with
every 0.x minor, behaviour changes below are breaking-eligible, and there is
still no upgrade path between previews other than a fresh install. This release
adds eight migrations.

### The rename

- The project is now called **Anneal**. The repository moved to
  `mosonlab/anneal`, the internal npm scope is `@anneal/*`, and the product
  name in the console, the documentation and the release material follows.
- **Nothing an operator configures was renamed.** The `AGENTOS_*` environment
  variables, the default `agentos` PostgreSQL database and role, the
  `~/.agentos/` runtime directories and the `agentos` MCP server name are
  unchanged in this release, so an existing `.env` and an existing runner host
  keep working. Renaming them is successor work and will be called out as
  breaking when it happens.
- Deployments that were provisioned before the scope rename are recovered
  rather than reinstalled, and the legacy delivery artifacts of a run that
  straddles the rename are bridged instead of failing.
- Two names do change where the product names itself in output: the runner's
  git identity now reads `Anneal Runner` rather than `AgentOS Runner` (its
  address is unchanged), and the canonical
  chain prompts that named the platform are rolled forward under a registered
  prompt-only template generation (`pre-product-rename-anneal`). An existing
  install picks the new prompts up through the ordinary canonical sync; an
  unregistered prompt edit still refuses, as before.

### Chain hold and resume

- A running chain has an explicit control authority. `POST
  /tasks/:taskId/chain/hold` holds it at its current layer and `POST
  /tasks/:taskId/chain/resume` releases it; both are idempotent on a request
  identifier, and a chain's `control` block reports the held layer, who held
  it, why, and when it was last released.
- The hold is enforced where work is admitted rather than only in the UI:
  successor layers do not activate while held, a held step is refused
  admission, held successor runs are excluded at claim time, and a universal
  enqueue barrier covers the paths that used to enqueue around the layer
  machinery. Cancelled runs survive a release instead of being reactivated.
- The board and task console can hold and resume a chain, and a step shows the
  hold-specific refusal it would return.
- Salvage repair is serialized with holds, so a repair raised inside a held
  chain cannot run ahead of the operator releasing it.

### Sessions, Costs, and the console

- Sessions is rebuilt for reading: rows replace the table, sessions group by
  calendar day, agent and status filters narrow the list, unseen sessions are
  tracked locally, and a hover card carries the detail the row drops.
- The session stream is projected rather than dumped: tool calls group, prose
  chunks merge into continuous text, markers and operator input render as their
  own nodes, and output lines are capped so one runaway session cannot make the
  page unusable.
- A read-only **Costs** page reports spend over 7, 30 or 90 days: tiles for
  total spend, run count and average per run, a daily stacked bar chart grouped
  by agent, and by-agent and top-run tables. The chart is inline SVG with no
  charting dependency, and the same figures ship as a table beside it because
  three of the light-theme series colours sit under 3:1 against the card. The
  tiles state what they cannot include — the estimated share of the total, and
  the number of settled runs that reported no cost at all.
- A new project cost aggregation endpoint backs the page, and cached input
  tokens are normalized at the write boundary with the historical rows
  backfilled.
- Native child sessions are priced from what was actually observed rather than
  from a guess: an unsplit native child bills at the parent's rates, a
  cost-only model total is preserved instead of discarded, and the unobserved
  Claude fallback is removed.
- Every control-plane request from the console is bounded, board columns are
  bounded, the Inbox badge polls a summary instead of the full list, and a card
  is labelled with its run's model snapshot rather than the agent's current
  setting.
- The Inbox separates notices from cards that owe a reply, and dismissal is
  based on what actually blocks a run.

### Task chains and canonical agents

- The direct engineer workflow is eight steps and opens with a conditional
  revalidation of the brief: the step materializes only when the chain is bound
  to a predecessor task, and the revalidation session runs fenced with its own
  capability set.
- Prior outputs a step may read are declared per template and enforced as a
  whitelist, so a step cannot silently widen its context; the declarations
  survive an upgrade with their handoffs intact.
- Canonical template identity is derived rather than matched by name, canonical
  agent defaults load from the role sources, and a prompt-only canonical
  rollover can be registered without a structural change.
- Model routing is re-pinned again: regression verification moves to Luna at
  max effort, the plan reviser to Sol at high, spec and blind review are pinned
  to Opus high in the canonical contract, and frontend-heavy implementation
  routes to `frontend-dev`.
- Operator model and runner overrides are respected: canonical sync adopts
  drift only where an operator has not customized the value, notifies on
  customized drift, and a reset route restores the canonical runtime
  configuration.

### Regression verification

- Mechanical verification moved into a script and the verifier is narrowed to
  the semantic recheck it is actually good at.
- Verdicts are persisted mechanically and settled durably, including after a
  transport failure, so a verdict that was reached is not lost to a dropped
  connection.
- Retries are bound to the salvage branch and the run that produced them, and
  the recovery regression head is adopted rather than inferred.

### Merge delivery and recovery

- A cumulative merge train replaces one-candidate-at-a-time delivery, with its
  proof modes documented in
  [`docs/adr/0002-coordinate-main-delivery-with-merge-trains.md`](docs/adr/0002-coordinate-main-delivery-with-merge-trains.md).
- The gate's signature is persisted as a merge precondition, and chain-authored
  commits are attested with stale provenance stripped on rewrite.
- The merge lease is acquired in readiness rather than at the merge itself, is
  recorded project-scoped, reports its acquisition time on release, and
  readiness-owned leases are released against the project target — see
  [`docs/adr/0003-acquire-merge-lease-in-readiness.md`](docs/adr/0003-acquire-merge-lease-in-readiness.md).
- Pre-intent and legacy base drift are recovered rather than parked, and the
  live legacy recovery sentinel is retired.
- The autonomous merge tail no longer holds a merge for an independent review
  of a defense-list diff. Defense-list detection stays as an audit record: a
  match writes one inbox message naming the triggered paths and reasons, and
  the merge proceeds.
- **The Ed25519 release-authority attestation layer is removed whole** — the
  signing and verification module, the mint and check scripts, the tracked key
  and attestation, the preflight `authority` condition, the resign worker, and
  the two `GOAL5A0_*` SHA exports every install path used to require. The
  release-candidate migration set, the gate attestation, the merge lease and
  the gate's own checks are unchanged.
- Delivery fails loudly when a GitHub pull request is not recorded, and a
  pushed branch is preserved when pull request creation fails.

### Control plane and API

- Claim specifications are read from local mirrors at pinned commits against
  the exact claim remote, review specs are verified at pinned implementation
  heads, and the spec verdict cache is bound to its repository. Transient read
  failures are retried and then deferred under a budget rather than parking the
  work.
- Claims are prioritized by remaining chain work.
- A task can be created directly in `BACKLOG` in one call, and it stays parked;
  mechanical task cards stay prompt-only and promptless mechanical starts are
  admitted.
- Upgrade sweeps are decided under a lock rather than from a stale snapshot,
  and spent sweeps are removed.
- Refusals are typed through the workflow layer, and run terminalization, step
  admission, merge lease disposition, base drift recovery decisions and the
  readiness evaluation each moved behind one seam instead of being decided at
  every call site.
- A new [operator API handbook](docs/operator-api.md) documents the routes, and
  a route change is required to update it in the same change.

### Runner

- Session-created worktrees are contained: escapes from the run root are
  observed, persisted and reported, including on cancellation.
- The dispatched prompt's hash is persisted, so what a run was actually given
  can be checked after the fact.
- Host-personal skill roots are isolated from a run, with git configuration
  preserved under that isolation, and Codex resume authorization survives a
  reconnect.
- Operator notes reach retry prompts, missing task output is remediated in the
  session, and reconnect evidence is preserved on a failed exit.
- Deployment and dependency caches are bounded.

### Development and operations

- The merge gate host was resized and its evidence recorded; the database wave's
  two long test files are split and a test that waited out a 35-second delivery
  deadline no longer does.
- The public snapshot scanner fails when an include glob matches no git-tracked
  path.
- The operator handle in published material is replaced with a role name, with
  a `.mailmap` mapping the second author email; the `.mailmap` itself is not
  published.

### Documentation

- Both READMEs lead with the problem and a time-lapse of one real chain, state
  the spec-to-merge value proposition and the subscription authentication
  model, table the twelve-step chain with role, runner, model and effort, and
  point at the support matrix rather than copying it. Pi's authentication
  source is corrected to the Codex login.
- `AGENTS.md` is a trigger layer: the detail moved to the documents that own it,
  and the routing contract now records dependency qualification and the backlog
  card lifecycle.
- The published documentation surface is smaller: the support note and evidence
  status live in the README, three operator runbooks are maintained outside
  this repository, and the Simplified Chinese inner documentation pages are
  retired.
- `THIRD_PARTY_NOTICES.md` carries the mattpocock/skills notice the chain
  prompts require.

### Known limitations

- There is still no upgrade path between previews. Installing v0.4.0 over a
  v0.3.0 database is not supported; the supported install is
  `npm run db:migrate:release -- --fresh` against an empty schema.
- The migration preflight bypass is still procedural, not technically closed:
  nothing prevents a hand-run `prisma migrate deploy`.
- The `--existing` release-migration consumer remains executable but has no
  supported end-to-end workflow, because this repository does not ship the
  backup producer that creates its input.

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
- `npm run db:sync-canonical-prompts -w @anneal/db` synchronises every
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
