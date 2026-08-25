# Runbook — merge-gate workers and the gate dispatcher

A merge gate selects its own profile from the exact baseline-to-candidate diff.
Content-only modifications to the gate's explicit prose allowlist use the
install-free `docs-only` profile; callers cannot request it. Every structural,
runtime-coupled, executable, configuration, or unknown change uses the full
profile.

A full profile is `npm ci` with Prisma generation in postinstall, the database
CLI typecheck, lint, a whole-workspace compile, unit tests, a throwaway
PostgreSQL, database preflight tests and the API dbtests. It runs as three
concurrent groups rather than one serial chain, in the only order their real
dependencies allow: dependencies alongside the install-free suites, then
everything that needs `node_modules` but not `dist/`, then the three proof waves
together. PostgreSQL starts before the first group so its initdb overlaps work.
Concurrency changes latency, never the question the gate asks — every step still
runs, with the same command, and a group passes only when all of its members do.

How wide each group runs is derived from a stated share of the host, not from
the core count. `run-gate.sh` exports `AGENTOS_GATE_HOST_SHARE` as the worker's
slot count, so on the two-slot desktop each gate sizes itself for half the
machine and two concurrent gates still add up to one host. A gate invoked by
hand states no share and has the machine. Do not restore a per-phase fan-out in
`run-gate.sh`: `7886fad` set `AGENTOS_DBTEST_CONCURRENCY` there, `merge-gate.sh`
recomputed that same variable moments later, and the bound silently never took
effect while both logs claimed it had.

Measured on the 12-vCPU, 20 GiB desktop worker at capacity two, 2026-08-25.
A single full gate is about **130 seconds** end to end with a build-cache miss —
which is every ordinary new commit — and about **116 seconds** on an exact-head
cache hit. The serial predecessor was 241 seconds. Two overlapping full gates
take about **181 seconds each**, against 270 seconds before, with a 7.58 GiB
peak and 12.00 GiB still available, and no leaked container, scratch database,
worktree or lock. The install-free `docs-only` profile still takes about 4
seconds.

Within a gate the proof waves are now the whole cost: roughly 86 seconds against
27 for lint and 26 for a cold build. Widening the database lanes does not move
it — 4, 6 and 8 lanes all landed within 3 seconds of each other over one fixed
commit — because the waves saturate PostgreSQL and the CPU share together rather
than running out of lanes. `NODE_COMPILE_CACHE` was measured and rejected: 80
seconds cold against 82 warm, for 77 MiB of cache. Use
`scripts/gate-worker/bench-postgres.sh` and
`scripts/gate-worker/bench-dbtest-concurrency.sh` when changing the database
runner itself; each alternates its arms over one fixed commit so a tuning claim
is not inferred from unrelated gate runs. The lane widths are overridable
(`AGENTOS_GATE_UNIT_LANES`, `AGENTOS_GATE_DB_LANES`) for exactly that purpose; a
gate never chooses them itself.

`packages/db` and `packages/api` hand their database files to one pool rather
than two waves. Dividing lanes between a five-file wave and a forty-two-file one
is a guess about a ratio nothing maintains, and on the four-core fallback worker
the guess starved the small wave to a single lane and 201 seconds. One pool
balances itself and migrates the template once.

Everything here is `scripts/gate-worker/`:

| File | Runs on | What it does |
| --- | --- | --- |
| `provision.sh` | the server | Installs the pinned toolchain and creates `~/gate/`. Idempotent, dry-run by default. |
| `mirror-push.sh` | the local machine | Pushes one exact candidate and one exact baseline into immutable `refs/gate/.../<oid>` cache refs, creating `~/gate/<repo>/mirror.git` on first push, and installs `run-gate.sh` beside it. |
| `run-gate.sh` | the server | Holds one configured worker-wide execution slot, checks one oid out of its repository's mirror and runs `scripts/merge-gate.sh --expect-head <oid> --master <baseline-oid>` against it. |
| `remote-gate.sh` | the local machine | One synchronous `ssh` call; returns the verdict line and the exit code. |
| `gate-dispatch.sh` | the local machine | Freezes the candidate and integration baseline, then tries the primary worker and fallback worker. Local execution is explicit only. |
| `lib.sh` | both | Shared input validation and atomic pid-slot locking. |

The worker hosts one directory per repository, keyed by the origin repository's
name: `~/gate/<repo>/{mirror.git,worktrees,logs,run-gate.sh}`. The toolchain is
worker-wide and provision.sh's job; a repository's directory is created by its
first `mirror-push.sh`. A repository qualifies by shipping its own
`scripts/merge-gate.sh` — the gate that judges a commit is the gate that commit
ships.

## The slot model

A full gate can consume a host. The dispatcher cannot know the
candidate-selected profile before running it, so it rations fixed, measured
host capacity rather than trying to resize from live CPU or memory readings.
The default topology is two slots on the primary desktop worker and one on the
fallback worker. The explicit `--server` form contributes one dispatcher slot.
The local machine contributes no automatic capacity; it adds one slot only for
an invocation that passes `--allow-local` or sets `AGENTOS_GATE_ALLOW_LOCAL=1`.

`gate-dispatch.sh` is the way to run a gate when anything else might also be
running one:

```sh
scripts/gate-worker/gate-dispatch.sh <oid>
```

- The candidate is the exact requested `<oid>`. Unless `--master <oid>` is
  supplied, the dispatcher fetches origin's current default branch without
  creating a local tracking ref, re-reads `origin HEAD`, and freezes that exact
  oid as the baseline before taking a slot.
- The primary worker is preferred. It runs `mirror-push.sh` before
  `remote-gate.sh`, pushing only the frozen candidate and baseline under
  oid-named cache refs. The local checkout may be detached or single-branch;
  its incomplete ref namespace is never mirrored and cannot delete worker refs.
- If the primary is offline, its mirror push fails, its SSH connection drops,
  or both of its slots are busy, the fallback receives the same frozen candidate and
  baseline. A real `PASS`, `FAIL`, or `NOT AUTHORITATIVE` result is final; only
  absence of a verdict falls through to another machine. SSH connection setup
  is bounded at 10 seconds, and a dead established connection is detected by
  keepalives instead of waiting on the operating-system TCP timeout.
- The local slot is considered only with explicit opt-in and only when this
  worktree is clean at `<oid>`.
- All usable slots busy: the dispatcher blocks and re-polls (default every 30s,
  for 60 minutes — `GATE_DISPATCH_POLL_SECONDS`,
  `GATE_DISPATCH_TIMEOUT_MINUTES`).
  On timeout it exits **75** with `GATE DISPATCH: NO SLOT`: nothing ran, no
  verdict exists, and re-dispatching is the recovery. A timeout that recurs
  means the queue is systemically full, which is a capacity question, not a
  code question.
- A slot whose lock cannot be *operated* — a read-only `~/.cache`, a lock left
  by the pre-#132 dispatcher, a lock naming no pid — is not busy and is never
  waited on. The dispatcher keeps using whatever slots still work; if none do it
  exits **76** immediately with `GATE NOT RUN:` naming the slots to clear, and
  if it waited on a busy slot and the wait ran out with a broken lock still
  around it exits 76 rather than 75. Waiting for a lock nobody can take is
  waiting for nothing, and reporting it as a full queue hides what to fix.

The dispatcher accounts for `remote-1`, `remote-1-2`, `remote-2`, and optional
`local` under `~/.cache/gate-dispatch/`, outside any repository because the
slots belong to the machines. A direct `merge-gate.sh` bypasses that accounting. A direct
`remote-gate.sh` bypasses the local lock too, but it cannot exceed worker
capacity: every installed `run-gate.sh` contends for the worker-wide
`~/gate/.full-gate.lock` and, only on a capacity-two host,
`~/gate/.full-gate-2.lock`. Each is held with `flock` for the real process
lifetime. If an SSH connection drops while its remote process survives, that
process keeps its worker slot and a later invocation waits instead of exceeding
the configured capacity.

A lock is a file created with `ln`, holding the pid of the dispatcher that owns
it. That shape is deliberate and `scripts/gate-worker/lib.sh` explains it:
`link(2)` is the one atomic create-or-fail that also carries its payload, so a
slot lock names its owner from the instant it exists. A lock *directory* with a
pid file written a moment later has a window in which it names nobody, and a
second dispatcher reading that window calls the lock abandoned, deletes it, and
takes the slot its owner is already gating in — one slot silently becoming two
gates. Reclaiming a lock whose pid is gone is done by hard-linking it
to a witness name first, so of two dispatchers that both see the holder dead
exactly one may act; a lock whose pid is still alive is never touched, and a
lock that names no pid at all is never reclaimed automatically — it blocks the
slot and says so, because a file this script did not write is not evidence that
nobody is running a gate.

## Exit codes

One rule: **a verdict and the absence of a verdict never share a code.**
`gate-dispatch.sh` and `remote-gate.sh` transport verdicts and never form one,
so neither can produce a `1` of its own.

| Code | Means | Is it a verdict? |
| --- | --- | --- |
| `0` | `MERGE GATE: PASS <oid>` | yes |
| `1` | `MERGE GATE: FAIL (<step>)` | yes |
| `2` | usage error | no gate ran |
| `3` | `MERGE GATE: NOT AUTHORITATIVE` | yes |
| `75` | `GATE DISPATCH: NO SLOT` — every slot stayed busy until the timeout | no gate ran |
| `76` | `GATE NOT RUN: <reason>` — no configured worker produced a verdict, or a precondition failed: a mirror push failed, a slot lock could not be operated, origin was unreadable, the baseline is absent, the toolchain is incomplete, or `merge-gate.sh` died without printing a verdict | no gate ran |
| `130` / `143` | interrupted | no gate ran |
| `128+N` | the gate process died on signal N without a verdict; `137` is `SIGKILL`, which is almost always the OOM killer | no gate ran |
| `255` | ssh transport failure from direct `remote-gate.sh`; the dispatcher consumes this and tries its fallback | no gate ran |

**`1` is the only code that means the commit was judged and did not pass.**
`75`, `76`, `128+N` and `255` are errands, not judgements: re-dispatch after
fixing what the message names. An automation that treats them as FAIL blocks
merges on network weather and, worse, teaches people to ignore FAILs.

`75` and `76` are not interchangeable. `75` means at least one slot existed that
could have been taken and stayed busy for the whole timeout — a queue, so
re-dispatching later is the fix. `76` means the slot lock itself could not be
operated (a read-only cache directory, a lock left by the pre-#132 dispatcher, a
lock naming no pid): waiting changes nothing, and the message names what to
clear. A slot whose lock is broken is never counted as busy, so a run that sees
nothing but broken locks reports `76` at once instead of polling out the timeout
and claiming the queue was full.

Every code below `128` carries a matching stdout line, so a caller may read
either: a verdict line starts `MERGE GATE:`, and everything that ran no gate
starts `GATE NOT RUN:` or `GATE DISPATCH:`. The exception is a gate killed by a
signal it cannot handle. `merge-gate.sh` traps `INT` and `TERM` and prints
through its `EXIT` trap, so `130` and `143` still say what happened, but `SIGKILL`
cannot be trapped: a gate the OOM killer takes produces `137` and **no stdout
line at all**. Read a missing verdict line as "no verdict", never as a pass —
`128+N` with silence is the one case where the code is the only evidence.

## Operating boundaries

- **No execution plane on the server.** No AgentOS runner, no agent session, no
  Anthropic API call. The server builds and tests; it never acts.
- **Credentials are permitted.** Credentials do not block provisioning or gate
  execution. The normal gate path does not require GitHub or agent credentials,
  but a trusted operator VM may carry them. Candidate build and test code runs
  with the worker account's effective environment and permissions, so only
  place credentials there when that trust is intended.
- **The gate mirror has no remote.** Code reaches it by exact SSH push from the
  calling machine. `provision.sh` and `mirror-push.sh` refuse a mirror with a
  configured remote, including when the remote list cannot be read. This is an
  input-determinism rule: a worker cannot silently fetch a different candidate
  or baseline from the ones the dispatcher froze.

  **The worker is not network-isolated, and this repository does not claim it
  is** (Leo's ruling, 2026-08-20). The gate's normal flow never needs GitHub —
  the mirror arrives over SSH, nothing fetches — but nothing here denies the
  host a route to GitHub or anywhere else, and no firewall rule is required
  before a box may gate. That was weighed and declined: the gate executes the
  candidate commit's own build and test scripts, so blocking GitHub alone would
  leave every other host reachable and buy little, at the cost of maintaining
  deny rules against addresses that move. The exact pushed inputs and the
  caller's merge authority remain the relevant boundaries.
- **Local production is untouched by any of this.** `localhost:5432`,
  `localhost:3000`, `~/.agentos/` and launchd are not in this picture at all.

## What a remote PASS is worth

State this honestly wherever a remote verdict is quoted.

A remote PASS is **evidence, not authority**. The merge still happens on the
local machine and still binds an exact head. A worker can produce false
evidence if it is compromised, and candidate code can access whatever the
worker account can access; this design treats the worker as trusted compute and
does not claim credential or network isolation.

The hedge against a forged PASS is **spot-checking**: for release-grade merges,
re-run the gate locally and compare. That is a deliberate trade — one gate's
worth of local compute occasionally, instead of on every gate.

Three properties keep the evidence honest even when the worker is trusted:

- `run-gate.sh` runs `merge-gate.sh --expect-head <oid>`, so a checkout that is
  not the requested commit produces a FAIL rather than a verdict about the
  wrong tree.
- A verdict also names the baseline it was formed against, and prints it in the
  preflight. The gate's frozen-record rules (`scripts/check-frozen-docs.sh`)
  ask what is already on the default branch, and the worker mirror does not
  fetch it. So
  `gate-dispatch.sh` asks origin — `git ls-remote --symref origin HEAD`, which
  names the default branch and its head in one answer — fetches that branch,
  re-reads the answer, and passes the resulting oid through both transport hops
  as `--master`. `mirror-push.sh` pushes the candidate and baseline atomically
  into separate oid-named cache refs and reads both refs back exactly before the
  harness can run. `run-gate.sh` verifies both objects and hands the stated
  baseline to `merge-gate.sh`.
- A direct `remote-gate.sh` invocation does not transport objects. Its candidate
  and baseline must already have been pushed explicitly; routine callers use
  `gate-dispatch.sh`, which couples the exact transport and gate invocation.
- The gate is run **from inside the checked-out commit**, so the gate that
  judges a commit is the gate that commit ships. A PR that weakens
  `merge-gate.sh` is gated by its own weakened gate — which is true of the
  local gate too, and is why changes to `scripts/merge-gate.sh` get read, not
  just gated.

## First deployment

Each worker needs an SSH-reachable Ubuntu account that can `sudo`, plus a
`Host` entry in `~/.ssh/config` on the local machine. The dispatcher defaults
to `ci-desktop-worker` as primary and `agentos-gate` as fallback;
`AGENTOS_GATE_PRIMARY_SERVER` and `AGENTOS_GATE_FALLBACK_SERVER` override them.
`--server <alias>` remains the explicit one-worker form.

```
Host ci-desktop-worker
  HostName <ip>
  User <user>
  Port <port>
  IdentityFile ~/.ssh/<key>

Host agentos-gate
  HostName <ip>
  User <user>
  Port <port>
  IdentityFile ~/.ssh/<key>
```

**1. Provision (server).** Dry run first; it changes nothing and prints the
plan.

```sh
scp scripts/gate-worker/provision.sh ci-desktop-worker:/tmp/
ssh ci-desktop-worker 'bash /tmp/provision.sh'
ssh ci-desktop-worker 'bash /tmp/provision.sh --apply'
```

It pins Node to the version in the script (`v26.5.0` — the local machine's
version on 2026-08-18; `package.json` engines only sets a floor), installs
Docker with registry mirrors, the native Node build dependencies, and a Git
fixture identity when the account has none; it points npm at
`registry.npmmirror.com`, pre-pulls `postgres:16-alpine`, and creates `~/gate/`.
On a VMware guest it also disables VMware's time synchronization and enables
Ubuntu NTP. Two independent time disciplines caused the guest wall clock to
step backwards under sustained load; database ordering and ready-time tests
then failed even with only one gate running.

If it adds the account to the `docker` group, **log out and back in and re-run
it** — group membership does not apply to the session that granted it, and the
re-run is what confirms `docker info` works.

It does **not** check or install any egress rule: the worker is not
network-isolated by design (see the operating boundaries), so there is no
firewall step between provisioning and the first gate.

An absent `~/gate/worker-capacity` means one whole-GATE slot. Capacity two is a
deliberate host acceptance, not an automatic core-count rule. Temporarily set
the file to the exact value `2` for step 5 and retain it only if that acceptance
passes. `run-gate.sh` refuses every other value and never creates a third slot.
Removing the file returns the worker to one slot.

**2. Push the exact gate inputs (local).** The first push creates
`~/gate/<repo>/mirror.git` and installs `run-gate.sh` beside it.

```sh
scripts/gate-worker/mirror-push.sh ci-desktop-worker --candidate <candidate-oid> --baseline <baseline-oid> --dry-run
scripts/gate-worker/mirror-push.sh ci-desktop-worker --candidate <candidate-oid> --baseline <baseline-oid>
```

Both oids must resolve in the local object database. Routine use does not ask an
operator to prepare that state: `gate-dispatch.sh` refreshes and freezes the
origin baseline before it calls `mirror-push.sh`.

**3. Gate a commit (local).**

```sh
scripts/gate-worker/gate-dispatch.sh <oid>                                # primary, then fallback
scripts/gate-worker/gate-dispatch.sh <oid> --allow-local                  # opt in to Mac last
scripts/gate-worker/remote-gate.sh ci-desktop-worker <oid>                # one worker explicitly
scripts/gate-worker/remote-gate.sh ci-desktop-worker <oid> --verbose      # stream it
scripts/gate-worker/remote-gate.sh ci-desktop-worker <oid> --fetch-log    # copy the log back
scripts/gate-worker/remote-gate.sh ci-desktop-worker <oid> --master <oid> # state the baseline
```

`--master` is only needed when origin cannot be read (no network, expired
credential) or when the baseline is deliberately not origin's current head;
otherwise `remote-gate.sh` asks origin itself.

Exit codes are the table under "Exit codes" above. The short version: `1` is
the only code that means the commit was judged and did not pass; `75`, `76` and
`255` all mean no gate ran.

**4. Acceptance: the double-run.** Gate the *same* commit locally and remotely
and compare the two verdict lines.

```sh
git rev-parse HEAD                                       # <oid>
bash scripts/merge-gate.sh --expect-head <oid>           # local
scripts/gate-worker/remote-gate.sh ci-desktop-worker <oid> # remote
```

Both must end in `MERGE GATE: PASS <oid>` naming the same oid. Record both
lines in the PR.

**5. Capacity-two acceptance.** This is required only for a host proposed for
two slots. Use one fixed full-profile commit and a warm build cache. Record
three single runs, then five rounds with two `remote-gate.sh` processes started
together. Sample host CPU, memory availability and memory pressure during each
round. Keep `worker-capacity=2` only when all ten overlapping gates pass, none
times out or leaks a database/worktree, there is no OOM or sustained memory
pressure, and the median two-gate batch finishes at least 15 percent sooner
than running two median single gates serially. Otherwise remove the capacity
file; one slot remains the supported result rather than a degraded fallback.

The 12-vCPU, 20-GiB desktop VM passed this acceptance on 2026-08-24 at commit
`7886fad3ee03380672832166337c804726b5aec9`, after VMware time synchronization
was disabled and Ubuntu NTP was the sole time discipline. Three warm single
runs took 241, 240 and 240 seconds (median 240). Five two-gate batches took
270, 270, 270, 271 and 270 seconds (median 270); all ten overlapping gates
passed. The median batch was 43.8 percent faster than two median single gates
run serially. Peak CPU reached 100 percent, peak used memory was 5.50 GiB, at
least 13.37 GiB remained available, and there was no OOM, sustained memory
pressure, leaked container, database, worktree or held slot. The retained
desktop setting is therefore `worker-capacity=2`; the four-vCPU fallback stays
at its default capacity of one.

## Routine use

```sh
scripts/gate-worker/gate-dispatch.sh <oid>
```

That is the whole routine: the dispatcher refreshes the baseline and pushes the
two exact gate inputs before any remote run. The call is synchronous and holds
the terminal for the whole gate.
There is no queue file and no daemon by design: the state a queue would need is
exactly the state that makes a worker something to operate rather than
something to use, and the callers — agent sessions blocking on their own
merges — are the backpressure. When all three automatic remote slots are
occupied, every later caller waits and re-polls; requests are not pinned to a
machine and strict FIFO order is not promised. The first waiter to acquire
whichever slot frees runs there.

The database step normally runs cores-1 files at once, capped at four: three on
a four-vCPU worker and four on larger single-slot workers. Each gets a database
of its own and its own subdirectory of the roots the gate exports. A worker
permits one gate by default or two only when `~/gate/worker-capacity` contains
`2`; in capacity-two mode `run-gate.sh` fixes each gate's database concurrency
at two, keeping the host-wide maximum at four. `AGENTOS_DBTEST_CONCURRENCY`
lowers the file concurrency on other paths and
`AGENTOS_DBTEST_PROVISION=0` puts the step back on one shared schema, serial.

## Troubleshooting

**`commit <oid> is not in the mirror`** — the mirror is behind. Run
`mirror-push.sh <server> --candidate <oid> --baseline <baseline-oid>` and retry
(the dispatcher does this itself). The worker has no way to fetch what it was
not given.

**`no mirror at ...`** — that repository has never been pushed from this
machine. `mirror-push.sh` creates it.

**`another merge gate is running in ... (pid N)`** — the per-worktree lock.
Each remote run gets a unique worktree, so this can only mean a previous run in
*this* directory was killed rather than exited. `run-gate.sh` sweeps worktrees
older than `STALE_WORKTREE_MINUTES` (default 180) at the start of every run and
prunes the mirror's registrations, so the reclaim is automatic. Age alone does
not decide: a worktree whose creating pid is still alive is left where it is
however old it is, because a gate waiting on a hung registry or a stalled pull
is slow, not abandoned, and deleting its tree would turn one box's
infrastructure problem into somebody else's FAIL. Intervene only if you need the
disk back sooner:

```sh
ssh agentos-gate 'ls -la ~/gate/<repo>/worktrees'
ssh agentos-gate 'rm -rf ~/gate/<repo>/worktrees/gate-<oid>-<stamp>-<pid> && git -C ~/gate/<repo>/mirror.git worktree prune'
```

**`GATE DISPATCH: NO SLOT` keeps recurring** — the configured slots are
systemically full. That is a capacity signal, not an error to retry harder:
either stagger the merges, or repeat the same-commit overlap acceptance before
changing host capacity.

**`GATE NOT RUN: the slot locks are unusable (...)`** — the named slots have a
lock this dispatcher cannot operate, so nothing was gated and nothing will be
until they are cleared. Look at `~/.cache/gate-dispatch/`: a `<slot>.lock`
*directory* is a leftover from the pre-#132 dispatcher and can go once no old
`gate-dispatch.sh` is running; a `<slot>.slot` file that does not contain a pid
was not written by this script and is cleared by hand, again only once no gate
is running; and a message about not being able to write a lock means the cache
directory itself is read-only or full. Re-dispatch after clearing.

**`docker: permission denied` / `the docker daemon is not reachable`** — the
account is not in the `docker` group yet, or its session predates the change.
Log out, log back in, re-run `provision.sh`.

**A pull or an `npm ci` hangs** — a registry mirror has stopped serving. Check
`/etc/docker/daemon.json` (`registry-mirrors`) and `~/.npmrc` (`registry`). The
direct sources are not reliably reachable from this network, so an unmirrored
install does not run slowly, it hangs.

This is not hypothetical and it does not announce itself. The first deployment
inherited two mirrors from the box's previous tenant that completed a TLS
handshake, answered `/v2/` with the normal `401`, and then served no layers at
all: `docker pull` sat for fifteen minutes with an empty `overlay2` and never
errored. Two lessons are now built in — `provision.sh` gives the pre-pull a
`PULL_TIMEOUT` (default 300s) so a dead mirror fails instead of hanging, and a
mirror's presence in `daemon.json` is never treated as evidence it works; only
a completed pull is.

To find a mirror that actually serves, pull through a fully-qualified one,
which bypasses the daemon's mirror list entirely:

```sh
ssh agentos-gate 'timeout 150 docker pull dockerproxy.net/library/postgres:16-alpine'
```

Then either point `daemon.json` at the one that worked and restart docker, or
retag what you pulled under the canonical name the gate asks for:

```sh
ssh agentos-gate 'docker tag dockerproxy.net/library/postgres:16-alpine postgres:16-alpine'
```

`docker info | grep -A3 "Registry Mirrors"` confirms what the daemon is
actually using, which is not always what the file says if it was edited without
a restart.

**Remote FAIL, local PASS, same commit** — do not merge on the strength of the
local PASS alone. Fetch the remote log (`--fetch-log`) and read the failing
step first; the interesting cases are real (a platform-dependent test, a Node
minor difference, a timing-sensitive dbtest), and a divergence here is exactly
what a second machine is for.

**Timing assertions fail intermittently on a VMware guest** — check both time
disciplines before changing tests. `vmware-toolbox-cmd timesync status` must say
`Disabled`, while `timedatectl show -p NTP -p NTPSynchronized` must report both
as `yes`. Re-run `provision.sh --apply` to converge that state. Do not leave
VMware periodic synchronization and Ubuntu NTP enabled together.

**Reading logs.** They stay on the worker at
`~/gate/<repo>/logs/<stamp>-<oid>-<pid>.log`, one per run, and are never pruned
automatically — a log is small and the reason a verdict happened is worth
keeping. Trim them by hand when the disk asks:

```sh
ssh agentos-gate 'ls -lt ~/gate/<repo>/logs | head'
ssh agentos-gate 'find ~/gate/*/logs -name "*.log" -mtime +30 -delete'
```

## Changing the pinned Node version

The pin lives in `provision.sh` (`GATE_NODE_VERSION`) because the repository
has no `.nvmrc` with a full version. Bump it there, re-run `provision.sh
--apply`, and re-do the double-run from step 4 — a verdict from a different
interpreter than the local one is weaker evidence than it looks.

## Undoing it

The local machine carries only the slot lock files under
`~/.cache/gate-dispatch/`, which are inert when nothing runs. To return a
capacity-two worker to one slot, remove `~/gate/worker-capacity` after its gates
finish. To retire one repository from the worker, delete `~/gate/<repo>` on it;
to decommission the worker, delete `~/gate`.
Gating locally is, and remains, `bash scripts/merge-gate.sh`.
