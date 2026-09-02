# Anneal — security boundaries, and where they stop

This page is written to be believed, which means it has to be usable as a list
of what Anneal does *not* protect you from. Read the limits section before you
decide what to point this at.

The short version: Anneal is a **local, single-operator** control plane. Its
boundaries are authorization and audit boundaries inside its own APIs. It is not
a sandbox, it does not contain the coding CLI it launches, and it is not built
to face a network.

## What the boundaries are

### Loopback only

- The API refuses to start on anything but `127.0.0.1`. A non-loopback
  `API_HOST` is a startup refusal (`api-host-not-loopback`), not a warning.
- The repository's `docker-compose.yml` publishes PostgreSQL on
  `127.0.0.1:5432`. The release migration path refuses an explicit non-loopback
  bind. Compose shorthand with no bind emits a notice because it publishes on
  every interface, while the migration target URL must still name literal
  loopback.
- The web console is served at `http://127.0.0.1:5173` by the development
  server and at `http://127.0.0.1:4173` by the deployed preview server. In
  either mode, the server decides per request that the caller is its own
  loopback origin before it will attach the operator's authority.

**Exposing any of this beyond the loopback interface is unsupported.** There is
no authentication design for a remote caller here — no login, no per-user
identity, no session model for anyone but the machine's own operator. Putting a
tunnel or a reverse proxy in front of it does not add one.

### Secrets at rest and in flight

- `npm run setup:local` generates every value: distinct random operator and
  runner tokens, a session-cookie secret, a base64-encoded 32-byte encryption
  key, and one database password. It writes `.env` at mode `0600`, prints a
  class rather than a value, and refuses to overwrite an existing file. Its
  `--upgrade` mode repairs one in place instead: it preserves every existing
  assignment, adds only the missing locally generated secret keys, and rotates
  nothing.
- Stored secrets are encrypted with AES-256-GCM. Neither plaintext nor
  ciphertext appears in the API's secret representations.
- Per-run credentials are written mode `0600` inside the throwaway run
  workspace and are excluded from git locally.
- Child processes get an explicit environment — configured `PATH`/`HOME`, run
  identity, session credentials, granted secrets — rather than a copy of the
  host environment.

### Nothing in the browser bundle

There is deliberately no `VITE_*` credential. A `VITE_*TOKEN*` key anywhere in
`.env` is a startup refusal, and `npm run verify:secret-hygiene` scans the built
bundle for token variables, bearer headers, `Authorization`, and this checkout's
actual generated secret values — failing closed if the bundle is missing rather
than reporting a green it did not earn. It prints classes, paths and variable
names, never a value.

The operator's bearer token stays in the dev/preview server process, which
attaches it to requests it has decided come from its own loopback origin. The
console never holds it.

### Rotation

There is no rotation command, and that is deliberate rather than missing.
Replacing these values is a human recovery: establish an empty target first,
then generate. In particular, **rotating `AGENTOS_SECRET_ENCRYPTION_KEY` while
encrypted secret rows exist destroys them.** They are not recoverable.

### Repository remotes may not carry credentials

A repository remote that embeds a password or a token is refused — in the
browser, and again on the server, from one shared policy table
(`scripts/fixtures/onboarding-remote-cases.json`) so the two cannot drift apart.
The remote is stored as an address. If your workflow needs a credential in a
URL, this is not the tool for it yet.

### Principals are separated

Operator, runner, and per-run session principals are distinct, with independently
scoped routes. Session tokens expire or are revoked with the run. Runner-
authenticated writes and the session event, activity, output, Inbox and
completion paths are checked against the run's fencing generation; a stale or
expired generation is rejected and the runner terminates the provider's process
group.

Exactly one API control plane may own a canonical workspace root, and ownership
is acquired before Prisma is imported or reconciliation begins. Runner daemons
are ordinary clients; any number of them may poll that one API.

### Grants are created narrowly

- **No Filesystem Grant is created by default.** A fresh installation grants the
  starter agent no filesystem access at all.
- The repository grant the wizard creates is `GIT_WRITE`, and the wizard says so
  before you confirm.

## What the boundaries are not

### It is not a sandbox, and this document will not call it one

The provider adapters launch the coding CLI with non-interactive
permission-bypass flags. With the shipped same-user default, the agent runs
**with your own user's authority** on your own machine. Anneal grants constrain
Anneal's own APIs — which is a real thing, and an audit trail — but they are not
an operating-system containment boundary. Application metadata describing an
environment as restricted is metadata, not enforcement, and nothing in this
release should be read as sandboxing.

Concretely: an agent that decides to read a file outside its Filesystem Grant by
running a shell command is not stopped by the Filesystem Grant. It is stopped
only by what the OS account it is running as cannot do.

### The environment is honestly `OPEN`

The environment a fresh installation creates is labelled `OPEN` because it is.
**No network isolation is enforced.** Do not read the field as a restriction.

### Known open gap: the Files path walk can be raced

The Files store rejects every hostile path string an API caller can express and
every symlink at rest: intermediate components are walked with `lstat`,
list/stat never follow links, and final opens use `O_NOFOLLOW` atomically.
Hardlinks are handled as a separate escape — reads refuse a regular file whose
`fstat` reports `nlink > 1`, and writes land on a private new inode renamed over
the target rather than truncating whatever inode is there.

**What is not closed:** an adversary with concurrent write access *inside* the
Files Root can swap an already-checked intermediate directory after the walk has
passed it and before the open. This is not theoretical — the repository carries
an opt-in probe that wins the race in milliseconds, and it is written to fail the
day the gap closes. Pure Node has no `openat`-style fd-relative primitive to
close it with; closing it needs a native helper.

Until then the backstop is deployment, and it is checked rather than assumed: the
API refuses to boot when `FILES_ROOT` overlaps the run workspace root, and it
warns when `RUNNER_RUN_AS_PREFIX` is empty — that is, when the model CLI is
running as the same principal that can write inside the root. The path algorithm
alone does not claim containment against an attacker who can already write
inside the root.

### Runner separation is partial

`RUNNER_RUN_AS_PREFIX` can launch the CLI under a dedicated, minimally
privileged account, and doing that is the right move when you want stronger host
separation. Note what it separates: the *runners* from each other. One runner's
account still owns every workspace it has ever created, so it can delete its own
earlier ones.

### The repository access level does not gate the push

A repository-access row is required when a task is created and claimed, but its
read/write level does not currently gate delivery's push. Treat any repository
you register as writable by the agent.

## If you are deciding whether to run this

Run it on a machine you own, against repositories you can throw away, with a
provider account whose limits you are willing to spend. Do not run it on a
shared host, do not expose it, and do not point it at anything you would be
unhappy to see rewritten. That is not a disclaimer — it is the actual supported
envelope of this release.
