# Runbook — the offshore merge-gate worker and the gate dispatcher

A merge gate selects its own profile from the exact baseline-to-candidate diff.
Content-only modifications to the gate's explicit prose allowlist use the
install-free `docs-only` profile; callers cannot request it. Every structural,
runtime-coupled, executable, configuration, or unknown change uses the full
profile.

A full profile is `npm ci`, a whole-workspace compile, unit tests, a throwaway
PostgreSQL and the api dbtests. End-to-end worker logs measured on 2026-08-23
were stable at about 6 minutes 7 seconds with the worker to themselves. Two
overlapping full gates took 8 minutes 14 seconds and 8 minutes 42 seconds on the
same four vCPUs, which is why the worker now exposes one execution slot. The
install-free `docs-only` profile takes about 4 seconds. Use
`scripts/gate-worker/bench-postgres.sh` and
`scripts/gate-worker/bench-dbtest-concurrency.sh` when changing the database
runner itself; each alternates its arms over one fixed commit so a tuning claim
is not inferred from unrelated gate runs.

Everything here is `scripts/gate-worker/`:

| File | Runs on | What it does |
| --- | --- | --- |
| `provision.sh` | the server | Installs the pinned toolchain and creates `~/gate/`. Idempotent, dry-run by default. |
| `mirror-push.sh` | the local machine | Pushes one exact candidate and one exact baseline into immutable `refs/gate/.../<oid>` cache refs, creating `~/gate/<repo>/mirror.git` on first push, and installs `run-gate.sh` beside it. |
| `run-gate.sh` | the server | Holds the worker-wide execution lock, checks one oid out of its repository's mirror and runs `scripts/merge-gate.sh --expect-head <oid> --master <baseline-oid>` against it. |
| `remote-gate.sh` | the local machine | One synchronous `ssh` call; returns the verdict line and the exit code. |
| `gate-dispatch.sh` | the local machine | Freezes the candidate and integration baseline, then tries the worker slot first and the local slot while the worker is busy. |
| `lib.sh` | the local machine | Shared repository-name derivation for the three local-side scripts. |

The worker hosts one directory per repository, keyed by the origin repository's
name: `~/gate/<repo>/{mirror.git,worktrees,logs,run-gate.sh}`. The toolchain is
worker-wide and provision.sh's job; a repository's directory is created by its
first `mirror-push.sh`. A repository qualifies by shipping its own
`scripts/merge-gate.sh` — the gate that judges a commit is the gate that commit
ships.

## The slot model

A full gate saturates every core of whatever machine runs it. The dispatcher
cannot know the candidate-selected profile before running it, so it rations
machines, not processes: the local machine contributes **one** slot —
it is also where the agent sessions and the local services live — and the
four-vCPU worker contributes **one**. Two slots, machine-wide, shared by every
repository that dispatches from this machine.

`gate-dispatch.sh` is the way to run a gate when anything else might also be
running one:

```sh
scripts/gate-worker/gate-dispatch.sh <oid>
```

- The candidate is the exact requested `<oid>`. Unless `--master <oid>` is
  supplied, the dispatcher fetches origin's current default branch without
  creating a local tracking ref, re-reads `origin HEAD`, and freezes that exact
  oid as the baseline before taking a slot.
- The remote slot is preferred. It runs `mirror-push.sh` before
  `remote-gate.sh`, pushing only the frozen candidate and baseline under
  oid-named cache refs. The local checkout may be detached or single-branch;
  its incomplete ref namespace is never mirrored and cannot delete worker refs.
- The local slot is spillover only while the remote slot is busy, and only when
  this worktree is clean at `<oid>`.
- Both busy: the dispatcher blocks and re-polls (default every 30s, for
  60 minutes — `GATE_DISPATCH_POLL_SECONDS`, `GATE_DISPATCH_TIMEOUT_MINUTES`).
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

The dispatcher accounts for `remote-1` and `local` under
`~/.cache/gate-dispatch/`, outside any repository because the slots belong to
the machines. A direct `merge-gate.sh` bypasses that accounting. A direct
`remote-gate.sh` bypasses the local lock too, but it cannot add worker capacity:
every installed `run-gate.sh` contends for the worker-wide
`~/gate/.full-gate.lock`, held with `flock` for the real process lifetime. If an
SSH connection drops while its remote process survives, that process keeps the
worker lock and a later invocation waits instead of running beside it.

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
| `76` | `GATE NOT RUN: <reason>` — a precondition failed: the mirror push failed, a slot lock could not be operated, origin was unreadable, the baseline is not in this checkout, the commit is not in the mirror, the worker's toolchain is incomplete, a credential is set in the worker's environment, or `merge-gate.sh` died without printing a verdict | no gate ran |
| `130` / `143` | interrupted | no gate ran |
| `128+N` | the gate process died on signal N without a verdict; `137` is `SIGKILL`, which is almost always the OOM killer | no gate ran |
| `255` | ssh transport failure | no gate ran |

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

## The red lines

These are Leo's ruling of 2026-08-18, not preferences. A change that crosses
one of them is not a tuning decision.

- **No execution plane on the server.** No AgentOS runner, no agent session, no
  Anthropic API call. The server builds and tests; it never acts.
- **No secrets on the server.** No `RUNNER_TOKEN`, no `OPERATOR_TOKEN`, no `gh`
  credential, no Anthropic key, no SSH private key. `provision.sh` refuses to
  finish if it finds one, and `run-gate.sh` re-checks the environment on every
  single run — a profile can acquire a variable months after provisioning.
- **No GitHub credential and no remote on the worker.** Code reaches the worker
  only by SSH push from the local machine. The worker holds no GitHub
  credential, its mirror has no remote configured, and both `provision.sh` and
  every `mirror-push.sh` refuse to proceed if one appears — including when the
  check cannot read the mirror's remotes at all, which is treated as "unknown"
  and therefore refused. `run-gate.sh` re-checks the credential list on every
  run. All `gh` reads and writes stay local. This is what makes the *mirror*
  unable to fetch and the worker unable to push anywhere.

  **The worker is not network-isolated, and this repository does not claim it
  is** (Leo's ruling, 2026-08-20). The gate's normal flow never needs GitHub —
  the mirror arrives over SSH, nothing fetches — but nothing here denies the
  host a route to GitHub or anywhere else, and no firewall rule is required
  before a box may gate. That was weighed and declined: the gate executes the
  candidate commit's own build and test scripts, so blocking GitHub alone would
  leave every other host reachable and buy little, at the cost of maintaining
  deny rules against addresses that move. What carries the weight instead is the
  line above plus no merge authority: a remote PASS is evidence, never an
  authoritative verdict.

  So when a worker's verdicts are quoted, the accurate claim is "holds no
  credential, has no remote, cannot merge" — **never** "cannot reach GitHub".
- **Local production is untouched by any of this.** `localhost:5432`,
  `localhost:3000`, `~/.agentos/` and launchd are not in this picture at all.

## What a remote PASS is worth

State this honestly wherever a remote verdict is quoted.

A remote PASS is **evidence, not authority**. The merge still happens on the
local machine and still binds an exact head, so the worst a compromised worker
can do is forge a PASS for a commit that would not really pass. It cannot merge
anything, and it holds no credential worth stealing. What it can do is whatever
its network allows the candidate commit's own build and test scripts to do —
the box is not isolated, and this repository does not pretend otherwise.

The hedge against a forged PASS is **spot-checking**: for release-grade merges,
re-run the gate locally and compare. That is a deliberate trade — one gate's
worth of local compute occasionally, instead of on every gate.

Three properties keep the evidence honest even when the worker is trusted:

- `run-gate.sh` runs `merge-gate.sh --expect-head <oid>`, so a checkout that is
  not the requested commit produces a FAIL rather than a verdict about the
  wrong tree.
- A verdict also names the baseline it was formed against, and prints it in the
  preflight. The gate's frozen-record rules (`scripts/check-frozen-docs.sh`)
  ask what is already on the default branch, and the worker cannot find that
  out — it holds no credential and its mirror is whatever was last pushed. So
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

You need: an SSH-reachable Ubuntu server, an account on it that can `sudo`, and
a `Host` entry in `~/.ssh/config` on the local machine. Use the alias
everywhere below — it keeps the address, user, port and key in one place that
is not this repository. `gate-dispatch.sh` and the other local scripts default
to the alias `agentos-gate` (`AGENTOS_GATE_SERVER` overrides it).

```
Host agentos-gate
  HostName <ip>
  User <user>
  Port <port>
  IdentityFile ~/.ssh/<key>
```

**1. Provision (server).** Dry run first; it changes nothing and prints the
plan.

```sh
scp scripts/gate-worker/provision.sh agentos-gate:/tmp/
ssh agentos-gate 'bash /tmp/provision.sh'
ssh agentos-gate 'bash /tmp/provision.sh --apply'
```

It pins Node to the version in the script (`v26.5.0` — the local machine's
version on 2026-08-18; `package.json` engines only sets a floor), installs
Docker with mainland registry mirrors, points npm at `registry.npmmirror.com`,
pre-pulls `postgres:16-alpine`, and creates `~/gate/`.

If it adds the account to the `docker` group, **log out and back in and re-run
it** — group membership does not apply to the session that granted it, and the
re-run is what confirms `docker info` works.

It also refuses to finish while a known credential variable or file is present
on the box. That is the red line above, and it is checked again on every gate
run.

It does **not** check or install any egress rule: the worker is not
network-isolated by design (see the red lines), so there is no firewall step
between provisioning and the first gate.

**2. Push the exact gate inputs (local).** The first push creates
`~/gate/<repo>/mirror.git` and installs `run-gate.sh` beside it.

```sh
scripts/gate-worker/mirror-push.sh agentos-gate --candidate <candidate-oid> --baseline <baseline-oid> --dry-run
scripts/gate-worker/mirror-push.sh agentos-gate --candidate <candidate-oid> --baseline <baseline-oid>
```

Both oids must resolve in the local object database. Routine use does not ask an
operator to prepare that state: `gate-dispatch.sh` refreshes and freezes the
origin baseline before it calls `mirror-push.sh`.

**3. Gate a commit (local).**

```sh
scripts/gate-worker/gate-dispatch.sh <oid>                           # first free slot
scripts/gate-worker/remote-gate.sh agentos-gate <oid>                # this worker, explicitly
scripts/gate-worker/remote-gate.sh agentos-gate <oid> --verbose      # stream it
scripts/gate-worker/remote-gate.sh agentos-gate <oid> --fetch-log    # copy the log back
scripts/gate-worker/remote-gate.sh agentos-gate <oid> --master <oid> # state the baseline
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
scripts/gate-worker/remote-gate.sh agentos-gate <oid>    # remote
```

Both must end in `MERGE GATE: PASS <oid>` naming the same oid. Record both
lines in the PR.

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
merges — are the backpressure. When both slots are occupied, every later caller
waits and re-polls; requests are not pinned to a machine and strict FIFO order
is not promised. The first waiter to acquire whichever slot frees runs there.

The database step runs cores-1 files at once — three on this worker — each with
a database of its own and its own subdirectory of the roots the gate exports.
The worker permits one gate at a time, so that is up to three test processes on
four vCPU; `AGENTOS_DBTEST_CONCURRENCY` lowers it on a busier worker and
`AGENTOS_DBTEST_PROVISION=0` puts the step back on one shared schema, serial.

## Troubleshooting

**`commit <oid> is not in the mirror`** — the mirror is behind. Run
`mirror-push.sh <server> --candidate <oid> --baseline <baseline-oid>` and retry
(the dispatcher does this itself). The worker has no way to fetch what it was
not given.

**`no mirror at ...`** — that repository has never been pushed from this
machine. `mirror-push.sh` creates it.

**`GATE NOT RUN: worker environment carries <VAR>`** (exit 76) — a credential
appeared in the worker's environment. This is a red-line stop, not a gate
failure, and the exit code says so: find what set it (`~/.bashrc`, `~/.profile`,
an ssh `SendEnv`, a systemd drop-in), remove it, and re-run `provision.sh` to
confirm the box is clean again. `run-gate.sh` checks the same variable list
`provision.sh` does, `FEISHU_APP_SECRET` included; the two lists are held
identical by `scripts/gate-worker/gate-worker.test.mjs`.

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

**`GATE DISPATCH: NO SLOT` keeps recurring** — the two slots are systemically
full. That is a capacity signal, not an error to retry harder: either stagger
the merges, or revisit the worker's sizing with the bench scripts.

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

**Reading logs.** They stay on the worker at
`~/gate/<repo>/logs/<stamp>-<oid>.log`, one per run, and are never pruned
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
`~/.cache/gate-dispatch/`, which are inert when nothing runs. To retire one repository from the worker,
delete `~/gate/<repo>` on it; to decommission the worker, delete `~/gate`.
Gating locally is, and remains, `bash scripts/merge-gate.sh`.
