# Runbook — the offshore merge-gate worker and the gate dispatcher

A full merge gate is `npm ci`, a whole-workspace compile, unit tests, a
throwaway PostgreSQL and the api dbtests — about 4 minutes on an idle worker,
of which the dbtests are about 1½ and everything else together is about 2½. The
dbtests were about 7 minutes until #146 moved that database's data directory
into RAM and stopped it paying for durability it deletes seconds later, and
about 3½ after that until they stopped queueing behind the one schema every
file dropped and re-applied. The measurements are
`scripts/gate-worker/bench-postgres.sh` (the container's settings) and
`scripts/gate-worker/bench-dbtest-concurrency.sh` (how the files are executed);
each alternates its two arms over one fixed commit, and they are the only thing
these numbers should ever be updated from. The four minutes is those steps
added up, not a stopwatch on a whole gate: two timed runs of one commit took
4.8 and 5.3 minutes, and a second gate overlapped part of both — a busy worker
is slower, because it permits two gates at once by design. That is pure
compute, and it does not need to occupy the local machine. This runbook moves
the compute to a remote server and leaves everything else where it was.

Everything here is `scripts/gate-worker/`:

| File | Runs on | What it does |
| --- | --- | --- |
| `provision.sh` | the server | Installs the pinned toolchain and creates `~/gate/`. Idempotent, dry-run by default. |
| `mirror-push.sh` | the local machine | `git push --mirror` into `~/gate/<repo>/mirror.git`, creating it on first push, and installs `run-gate.sh` beside it. |
| `run-gate.sh` | the server | Checks one oid out of its repository's mirror and runs `scripts/merge-gate.sh --expect-head <oid> --master <baseline-oid>` against it. |
| `remote-gate.sh` | the local machine | One synchronous `ssh` call; returns the verdict line and the exit code. |
| `gate-dispatch.sh` | the local machine | Runs a gate in the first free slot: local first, then one of the worker's two. |
| `lib.sh` | the local machine | Shared repository-name derivation for the three local-side scripts. |

The worker hosts one directory per repository, keyed by the origin repository's
name: `~/gate/<repo>/{mirror.git,worktrees,logs,run-gate.sh}`. The toolchain is
worker-wide and provision.sh's job; a repository's directory is created by its
first `mirror-push.sh`. A repository qualifies by shipping its own
`scripts/merge-gate.sh` — the gate that judges a commit is the gate that commit
ships.

## The slot model

A gate saturates every core of whatever machine runs it, so what the dispatcher
rations is machines, not processes: the local machine contributes **one** slot —
it is also where the agent sessions and the local services live — and the
worker contributes **two**, which is what its four vCPUs were measured to
carry. Three slots, machine-wide, shared by every repository that dispatches
from this machine.

`gate-dispatch.sh` is the way to run a gate when anything else might also be
running one:

```sh
scripts/gate-worker/gate-dispatch.sh <oid>
```

- Local first, when this worktree is already clean at `<oid>` — otherwise the
  local gate would only refuse, so the dispatch goes straight to a remote slot,
  which can gate any pushed oid.
- A remote slot runs `mirror-push.sh` before `remote-gate.sh`, always: a stale
  mirror is the most common failure and it is always benign, so it is automated
  away rather than documented around.
- All three busy: the dispatcher blocks and re-polls (default every 30s, for
  60 minutes — `GATE_DISPATCH_POLL_SECONDS`, `GATE_DISPATCH_TIMEOUT_MINUTES`).
  On timeout it exits **75** with `GATE DISPATCH: NO SLOT`: nothing ran, no
  verdict exists, and re-dispatching is the recovery. 75 is not a FAIL and must
  never be read as one; a timeout that recurs means the queue is systemically
  full, which is a capacity question, not a code question.
- Every other exit code is the gate's own, passed through: 0 PASS, 1 FAIL,
  3 NOT AUTHORITATIVE, 255 ssh transport failure (also not a verdict; re-run).

The accounting is three mkdir locks under `~/.cache/gate-dispatch/`, outside
any repository because the slots belong to the machines. They are the whole
truth about dispatched gates, with one honest exception: running
`merge-gate.sh` or `remote-gate.sh` directly bypasses the rationing, is
invisible to it, and is the operator's own override to answer for.

## The red lines

These are Leo's ruling of 2026-08-18, not preferences. A change that crosses
one of them is not a tuning decision.

- **No execution plane on the server.** No AgentOS runner, no agent session, no
  Anthropic API call. The server builds and tests; it never acts.
- **No secrets on the server.** No `RUNNER_TOKEN`, no `OPERATOR_TOKEN`, no `gh`
  credential, no Anthropic key, no SSH private key. `provision.sh` refuses to
  finish if it finds one, and `run-gate.sh` re-checks the environment on every
  single run — a profile can acquire a variable months after provisioning.
- **The server never talks to GitHub.** Code arrives only by SSH push from the
  local machine; a mirror has no remote configured, and both `provision.sh` and
  every `mirror-push.sh` fail if one appears. All `gh` reads and writes stay
  local.
- **Local production is untouched by any of this.** `localhost:5432`,
  `localhost:3000`, `~/.agentos/` and launchd are not in this picture at all.

## What a remote PASS is worth

State this honestly wherever a remote verdict is quoted.

A remote PASS is **evidence, not authority**. The merge still happens on the
local machine and still binds an exact head, so the worst a compromised worker
can do is forge a PASS for a commit that would not really pass. It cannot merge
anything, it cannot reach GitHub, and it holds no credential worth stealing.

The hedge against a forged PASS is **spot-checking**: for release-grade merges,
re-run the gate locally and compare. That is a deliberate trade — one gate's
worth of local compute occasionally, instead of on every gate.

Two properties keep the evidence honest even when the worker is trusted:

- `run-gate.sh` runs `merge-gate.sh --expect-head <oid>`, so a checkout that is
  not the requested commit produces a FAIL rather than a verdict about the
  wrong tree.
- A verdict also names the baseline it was formed against, and prints it in the
  preflight. The gate's frozen-record rules (`scripts/check-frozen-docs.sh`)
  ask what is already on the default branch, and the worker cannot find that
  out — it holds no credential and its mirror is whatever was last pushed. So
  `remote-gate.sh` asks origin — `git ls-remote --symref origin HEAD`, which
  names the default branch and its head in one answer — and passes the oid as
  `--master`; `run-gate.sh` verifies the mirror can resolve it and hands it on.
  If origin's head is newer than the last mirror push, the fix is `git fetch
  origin` and another `mirror-push.sh` — which checks for exactly that before
  it reports OK.
- `--master` is optional at both worker hops, deliberately. `run-gate.sh` is
  deployed by `mirror-push.sh`, so a worker can be running an older copy than
  the commit being gated; if a required argument were introduced here, that
  commit could not be gated until the worker was redeployed — the gate would be
  broken by its own improvement. Without the oid, `merge-gate.sh` falls back to
  the mirror's own default-branch refs, which are verbatim copies of the
  operator's push, and says so in the preflight line.
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

**2. Push the mirror (local).** The first push creates
`~/gate/<repo>/mirror.git` and installs `run-gate.sh` beside it.

```sh
scripts/gate-worker/mirror-push.sh agentos-gate --dry-run
scripts/gate-worker/mirror-push.sh agentos-gate
```

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

Exit codes are `merge-gate.sh`'s, passed through: `0` PASS, `1` FAIL, `2`
usage, `3` NOT AUTHORITATIVE. **`255` is ssh's own code and is not a verdict** —
the connection failed and no gate ran. Re-run it; never read it as a FAIL. The
dispatcher adds `75`: no slot freed up within the timeout, nothing ran,
re-dispatch.

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

That is the whole routine: the dispatcher pushes the mirror itself before any
remote run. The call is synchronous and holds the terminal for the whole gate.
There is no queue file and no daemon by design: the state a queue would need is
exactly the state that makes a worker something to operate rather than
something to use, and the callers — agent sessions blocking on their own
merges — are the backpressure.

The database step runs cores-1 files at once — three on this worker — each with
a database of its own and its own subdirectory of the roots the gate exports.
The worker permits two gates at the same time by design, so that is up to six
test processes on four vCPU; `AGENTOS_DBTEST_CONCURRENCY` lowers it on a busier
worker and `AGENTOS_DBTEST_PROVISION=0` puts the step back on one shared
schema, serial.

## Troubleshooting

**`commit <oid> is not in the mirror`** — the mirror is behind. Run
`mirror-push.sh` and retry (the dispatcher does this itself). The worker has no
way to fetch what it was not given.

**`no mirror at ...`** — that repository has never been pushed from this
machine. `mirror-push.sh` creates it.

**`MERGE GATE: FAIL (worker environment carries <VAR>)`** — a credential
appeared in the worker's environment. This is a red-line stop, not a gate
failure: find what set it (`~/.bashrc`, `~/.profile`, an ssh `SendEnv`, a
systemd drop-in), remove it, and re-run `provision.sh` to confirm the box is
clean again.

**`another merge gate is running in ... (pid N)`** — the per-worktree lock.
Each remote run gets a unique worktree, so this can only mean a previous run in
*this* directory was killed rather than exited. `run-gate.sh` sweeps worktrees
older than `STALE_WORKTREE_MINUTES` (default 180) at the start of every run and
prunes the mirror's registrations, so the reclaim is automatic; intervene only
if you need the disk back sooner:

```sh
ssh agentos-gate 'ls -la ~/gate/<repo>/worktrees'
ssh agentos-gate 'rm -rf ~/gate/<repo>/worktrees/gate-<oid>-<stamp>-<pid> && git -C ~/gate/<repo>/mirror.git worktree prune'
```

**`GATE DISPATCH: NO SLOT` keeps recurring** — the three slots are systemically
full. That is a capacity signal, not an error to retry harder: either stagger
the merges, or revisit the worker's sizing with the bench scripts.

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

The local machine carries only the slot locks under `~/.cache/gate-dispatch/`,
which are inert when nothing runs. To retire one repository from the worker,
delete `~/gate/<repo>` on it; to decommission the worker, delete `~/gate`.
Gating locally is, and remains, `bash scripts/merge-gate.sh`.
