# Opus blind review — runner: fail loudly when a runner CLI is unreachable

Written and committed before `sol-findings.md` was opened.

## Range

| | |
|---|---|
| Labelled `implementation_range.base` | `9914a401d0f9fa94dbe9d8556a66bcbf46a7f4ce` |
| Labelled `implementation_range.head` | `29f687921d12552fc8aacb3804b3003a41b21d12` |
| Range actually reviewed | `0d5b93e..29f6879` plus the tree at `29f6879` |

Both labelled commits resolve. The labelled base does not, however, bound the
implementation: `9914a40` is itself a fix commit inside the feature, and the
range `9914a40..29f6879` contains no `packages/runner` change at all — the whole
runner-side implementation (`availability.ts`, `runner.ts`, `api.ts`,
`index.ts`, `runner.test.ts`) landed in `ad8bc67`, the WIP-salvage commit whose
parent is `0d5b93e`. Reviewing the labelled range alone would have skipped the
majority of the feature, so this review took the superset `0d5b93e..29f6879`
plus the resulting tree. That superset is a strict containment of the labelled
range, so nothing labelled was skipped. See OPUS-15.

Chain carries no `slices/` directory: direct chain, specification only.
Everything the chain carries is reachable at `29f6879`.

## Tooling actually run at `29f6879`

| Check | Result |
|---|---|
| `npm run typecheck -w @agentos/api -w @agentos/runner` | pass |
| `npx biome lint` on the five changed source files | pass, no fixes |
| `npx eslint` on the three new/changed modules | pass |
| `RUNNER_WORKSPACE_ROOT=$(mktemp -d) npm run test -w @agentos/runner` | 155 pass, 0 fail |
| `RUNNER_WORKSPACE_ROOT=$(mktemp -d) npm run test -w @agentos/api` | 411 pass, 1 skipped, 0 fail |
| `npm run snapshot:scan` | pass, `unclassifiedFiles: 0` |
| `npm run test:db -w @agentos/api -- src/runner-cli-availability.dbtest.ts` | **not run** |

The database tests could not be executed in this session: the throwaway clone has
no `.env`, and the local PostgreSQL rejects every credential the repository
defaults document (`P1000` for `agentos:agentos`). Acceptance 4's dbtest half is
therefore unverified here and was reviewed statically only. This is an
environment limitation, not an observed failure.

Checks a required tool already ran and passed are not re-derived below. No lint,
type or format failure was observed.

---

## Axis 1 — repository and engineering standards

### OPUS-1 — P1 — the copied Feishu-thread block swallows an error inside a transaction, discarding the whole availability report

`packages/api/src/app.ts:3311-3320`

```js
const thread = chatId ? (
  await tx.inboxThread.findFirst({ ... })
  ?? await tx.inboxThread.create({ ... }).catch(() => null)
) : null;
await tx.inboxMessage.create({ ... });
```

This block is a verbatim copy of `app.ts:3385-3392` in `/runner/preflight`, with
one difference that changes its meaning: the original runs on `db`, outside any
transaction, where `.catch(() => null)` degrades correctly to a threadless
message. The copy runs on `tx` inside
`{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }`. In
PostgreSQL a statement error aborts the enclosing transaction, so once
`inboxThread.create` fails the swallow does not recover anything — the next
statement, `tx.inboxMessage.create`, fails with `25P02`, and the transaction
rolls back. The `RunnerBackendState` upsert and the `task.failureReason` writes
go with it.

Failure scenario: any transient error on the thread insert (connection reset,
statement timeout, a future constraint on `InboxThread`) turns the entire outage
report into a 500 with a `current transaction is aborted` message whose real
cause has been discarded by `() => null`. The runner logs a report failure, the
backend is never marked unavailable, and the outage stays exactly as silent as
the feature exists to prevent.

This also violates the specification's own constraint — "a failure to report
availability to the control plane must itself be logged loudly, never swallowed;
no new silent fallback paths" — and the repository's global rule against silent
fallbacks. Fowler: duplicated code, and the duplication is what carried a
correct-in-context idiom into an incorrect context.

The copy also dropped the comment that justified the original:

> Attach the operator chat so the alert can actually leave the web Inbox;
> threadless messages are skipped by the Feishu outbox forever.

`CONTRIBUTING.md` §Style: "Comments in this repository explain why a thing is
the way it is… If you remove one, be sure you know which failure it was standing
in front of." The reason the thread attach matters is now recorded at only one
of the two sites that need it.

**Fix direction:** extract the two sites into one shared
`operatorThread(client, chatId)` helper that takes a `Prisma.TransactionClient |
PrismaClient`, carries the comment once, and either resolves the thread or
throws. Do not swallow inside the transaction; if a threadless message is an
acceptable outcome, resolve the thread *before* opening the transaction.

### OPUS-2 — P1 — a malformed `capabilities.cliAvailability` is accepted on one route and then wedges every route that reads it, with no path back

`packages/api/src/runner-cli-availability.ts:20-42` and `:52-61`;
`packages/api/src/app.ts:933`, `:3289`, `:3364`, `:3374`, `:3520`

`readStoredCliAvailability` throws on any value under the `cliAvailability` key
that fails its invariant check. Failing loudly on corrupt state is the right
instinct and matches the repository standard. The defect is that the same change
opens a way in and closes every way out.

The way in: `/runner/preflight` validates `capabilities` only as
`z.record(z.string(), z.unknown())` (`app.ts:493`), and `preserveCliAvailability`
spreads that record wholesale:

```js
return { ...reported, ...(availability ? { [CAPABILITY_KEY]: availability } : {}) };
```

When no prior stored availability exists, `availability` is `null` and a
client-supplied `reported.cliAvailability` of any shape passes straight through
to the database unvalidated. `cliAvailability` is a reserved key of the stored
document; nothing defends it.

The ways out, all closed:

- `/runner/tasks/claim` (`app.ts:3520`) reads it inside the candidate loop, so
  the throw aborts the claim transaction. Claiming stops for **every** runner
  kind, not just the corrupted one.
- `/runners` (`app.ts:933`) reads it, so the operator surface that would show
  the problem 500s.
- `/runner/preflight` (`app.ts:3364`, `:3374`) reads it through
  `preserveCliAvailability`, so preflight 500s.
- `/runner/availability` (`app.ts:3289`) reads `previous` before writing, so the
  one write that would overwrite the corrupt document refuses to run.

Failure scenario: a runner-token or merge-executor-token holder posts
`/runner/preflight` with `capabilities: { cliAvailability: "x" }` against a
backend row that has no stored availability yet. Every subsequent task claim in
the installation returns 500 until someone edits `RunnerBackendState.capabilities`
by hand in PostgreSQL. No API route can repair it.

**Fix direction:** make `preserveCliAvailability` strip `CAPABILITY_KEY` from
`reported` before spreading, so the stored document is only ever written by the
availability path; and let `/runner/availability` treat an unreadable previous
document as absent-and-replaceable (log loudly, then overwrite) rather than as
fatal, so the loud failure has a mechanical cure.

### OPUS-3 — P2 — the injected `check` parameter is speculative generality, and the seam it builds is half-built

`packages/runner/src/availability.ts:16-43`

```ts
type AccessExecutable = (path: string, mode: number) => Promise<void>;
const executable = async (path: string, check: AccessExecutable): Promise<boolean> => {
  try {
    await check(path, constants.X_OK);
    return (await stat(path)).isFile();
```

No caller supplies `check`: `probeCliAvailability` calls
`resolveCliExecutable(binary, config.path)` with two arguments, and both tests in
`availability.test.ts` use real files on a real temp directory. The parameter is
also unusable as a seam even if someone wanted it, because `stat` — the second
half of the same predicate — is not injected, so a fake `check` still hits the
filesystem.

Fowler: speculative generality (dispensables). Repository rule: "Remove obsolete
paths instead of accommodating them."

**Fix direction:** delete the `AccessExecutable` type and the parameter; call
`access` directly. The temp-directory tests already prove the behaviour.

### OPUS-4 — P2 — `onAvailability` is bolted onto a retry-options bag it has nothing to do with

`packages/runner/src/runner.ts:453-457`, `:520-531`

```ts
export type StartupReportRetryOptions = {
  attempts?: number;
  wait?: (attempt: number) => Promise<void>;
  onRetry?: (runner: RunnerKind, attempt: number, attempts: number) => void;
  onAvailability?: (availability: CliAvailability) => void;
};
```

Every other member of this type describes how to retry a failed startup report.
`onAvailability` describes how to log a probe result, which is neither a retry
nor a report. It is then passed down through `runStartupPreflight`'s
`retryOptions` parameter and never reaches `reportStartupStateWithRetry`.
Fowler: the option object has grown a second, unrelated responsibility, and the
parameter name at the call site (`retryOptions`) now lies about what it carries.

The same callback also doubles as the production logger and the test spy, which
is what produces OPUS-6.

**Fix direction:** give `runStartupPreflight` a separate `options: { onAvailability?, retry?: StartupReportRetryOptions }`
shape, or hoist the availability probe and its logging out of
`runStartupPreflight` into its own exported step that `index.ts` calls first.

### OPUS-5 — P2 — an unhandled rejection inside the heartbeat timer can kill the daemon

`packages/runner/src/runner.ts:568-577`

```ts
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  void reportCliAvailabilityHeartbeat(config, options).finally(() => { busy = false; });
}, config.heartbeatIntervalMs);
```

`void p.finally(f)` discards a promise that still rejects when `p` rejects.
`reportCliAvailabilityHeartbeat` catches per-runner report errors, but not a
rejection from `probeSupportedCliAvailability` or from a caller-supplied
`onReportError`. A rejection there becomes an unhandled rejection raised from a
timer callback, which on the Node versions this package declares
(`^20.19.0 || ^22.13.0 || >=24`) terminates the process — the runner dies mid-run
rather than logging. That is the inverse of the specification's "must itself be
logged loudly, never swallowed", and it also puts item 5 at risk: one backend's
probe failure would stop claiming for all of them.

**Fix direction:** `.catch((error) => console.error("CLI availability heartbeat failed", error)).finally(...)`,
so the loop reports and survives.

### OPUS-6 — P2 — the loud not-found line required by item 1 is never executed by a test

`packages/runner/src/runner.ts:521-525`; `packages/runner/src/runner.test.ts:221-224`

The default `onAvailability` — the branch that emits
`"… runner CLI NOT FOUND: … is not executable in configured RUNNER_PATH"` — runs
only when `retryOptions.onAvailability` is absent. The one test that inspects
availability at startup supplies its own callback, so the production logging
branch has no coverage anywhere. Acceptance 1 asks for exactly this ("runner
startup records that kind unavailable in RunnerBackendState **and logs it**").

**Fix direction:** capture `console.error` in that test and assert the not-found
line names the binary, or split the logger into an exported pure function and
assert on its output.

### OPUS-7 — P2 — the heartbeat timer itself is untested; only the function it calls is

`packages/runner/src/runner.ts:563-577`; `packages/runner/src/runner.test.ts:491-515`

`startCliAvailabilityMonitor` is the only code that delivers acceptance 2's
"within one heartbeat interval and without a restart": the interval, the fact
that it reads `config.heartbeatIntervalMs` rather than `pollIntervalMs`, the
`busy` re-entrancy guard, and `stop()`. The added test calls
`reportCliAvailabilityHeartbeat` directly, twice, by hand. Nothing exercises the
monitor. A wrong interval field or a `busy` flag that never resets would pass the
whole suite.

**Fix direction:** one test with a small `heartbeatIntervalMs` that starts the
monitor, waits for two ticks, asserts two rounds of posts and that `stop()` ends
them.

### OPUS-8 — P2 — `SUPPORTED_RUNNERS` restates the `RunnerKind` union without enforcing exhaustiveness, and the result is cast to a total record

`packages/runner/src/availability.ts:7`, `:54-61`

```ts
export const SUPPORTED_RUNNERS = ["CLAUDE", "CODEX", "PI"] as const satisfies readonly RunnerKind[];
...
return Object.fromEntries(entries) as Record<RunnerKind, CliAvailability>;
```

`satisfies readonly RunnerKind[]` proves every element is a `RunnerKind`; it does
not prove every `RunnerKind` is an element. A fourth kind added to
`config.ts:15` and to the Prisma enum would compile cleanly here, produce a
`Record` missing that key, and hand `availability[runner]` an `undefined` to
`reportAvailabilityWithRetry` — a silent gap in exactly the coverage this feature
exists to guarantee. The `as` cast is what hides it.

**Fix direction:** derive the list from the type so the compiler checks totality
— e.g. build the record from a `Record<RunnerKind, true>` literal key set, or add
a `const _exhaustive: Record<RunnerKind, true> = { CLAUDE: true, CODEX: true, PI: true }`
next to it and key the array off `Object.keys` of that.

---

## Axis 2 — the approved specification

### OPUS-9 — P2 — the availability probe does not resolve as the launched account when a run-as prefix is configured

Governing specification text:

> On runner startup, resolve each supported runner CLI executable **against the
> configured runner PATH** and log per-runner availability

and the constraint

> probing must be cheap (executable resolution or a `capture()`-class version
> check, never a full agent session)

`packages/runner/src/availability.ts:18-25` resolves with `access(path, X_OK)`
and `stat`, both evaluated as the daemon's own uid. When
`RUNNER_RUN_AS_PREFIX` is set the CLI is spawned as a different account
(`packages/runner/src/workspace.ts:60-73` deliberately withholds `USER`/`LOGNAME`
in that case). The probe can therefore report a binary available that the
launched account cannot execute — reproducing the original silent-unclaimed
symptom with an "available" backend — or report unavailable a binary only the
launched account can reach.

The specification says "resolve … as the configured runner environment will",
which under a run-as prefix this does not. Cheapness is not in conflict: the same
`command()`/run-as path already used for `/bin/mkdir` in `workspace.ts:107` is a
single `test -x`-class spawn.

**Fix direction:** when `config.runAsPrefix.length > 0`, resolve through the same
run-as prefix; otherwise keep the direct `access`. Or state the limitation in a
comment at the probe and in the not-found log line.

### OPUS-10 — P2 — behaviour the specification did not ask for: an unavailable CLI now suppresses its preflight report, freezing that backend's preflight telemetry

Nearest governing specification text:

> Report per-runner availability to the control plane: a configured-but-unresolvable
> runner kind is recorded as unavailable in `RunnerBackendState` (reusing its
> circuit/reason semantics or an equivalent explicit availability field), **never
> silently skipped**.

Out of scope, per the specification: "spawn-level failure classification
(`classifyError`, `FailureClass`) and retry/budget semantics". The *preflight
report* is neither in the Changes list nor in the out-of-scope list.

`packages/runner/src/runner.ts:533-537` adds:

```ts
for (const runner of SUPPORTED_RUNNERS) {
  if (!availability[runner].available) {
    results[runner] = false;
    continue;
  }
```

so an unavailable backend no longer POSTs `/runner/preflight` at all.
Consequently `lastPreflightAt`, `lastPreflightOk`, `cliVersion`, `authMode`,
`circuitOpen` and `circuitReason` keep whatever values a previous run left, and
`/runners` (`app.ts:933-950`) presents them next to the new
`cliAvailable: false`. An operator reading that row sees
`lastPreflightOk: true, cliVersion: "claude-cli 2.x"` for a CLI that is not on
the machine.

The evidence that this is a deliberate prior decision being reversed is in the
diff itself: `runner.test.ts:229` still carries the comment

> Telemetry for the absent backends is not dropped: someone does use them, and a
> silent gap is worse than a reported failure.

while the assertion underneath it was rewritten from "three preflight posts" to
"three availability posts". The comment now stands in front of a different
guarantee than the one it was written for — the case `CONTRIBUTING.md` §Style
names explicitly.

Skipping a spawn for a binary that provably does not exist is a defensible and
cheap choice. Leaving stale preflight telemetry behind it is not.

**Fix direction:** when a kind is unavailable, either still POST the
`cli-missing` preflight verdict as before, or have `/runner/availability` null
`cliVersion`/`authMode` and set `lastPreflightOk: false` for that kind so the
operator surface cannot show a stale pass. Then correct or move the test comment
to the guarantee it now protects.

### OPUS-11 — P2 — the blocked reason overwrites an unrelated `failureReason`, and recovery erases it

Governing specification text:

> While a runner kind is unavailable, a task assigned to it surfaces an
> operator-visible reason naming the missing CLI through existing task/inbox
> surfaces

and

> once the CLI becomes resolvable again … the blocked reason set in item 3 is
> cleared.

`packages/api/src/app.ts:3301-3309` writes `failureReason` over every TODO/DOING
task with a QUEUED run of that kind, and `:3337-3341` sets `failureReason: null`
on recovery. `Task.failureReason` is not a field this feature owns: `app.ts:4175`,
`:4220` and `:4368` write real execution failures into it, and a task whose run
failed and was re-queued sits in TODO/DOING with a QUEUED run and a genuine
reason.

Failure scenario: task T's run 1 fails with "Execution failed: …"; run 2 is
queued; the CLAUDE CLI then goes missing. The heartbeat overwrites T's real
failure reason with the CLI reason, and the recovery report nulls it. The
operator's task card has lost why run 1 failed. The `Run` row still holds it, but
the surface the specification asked this feature to use no longer does.

The specification asks for the reason to be *surfaced* and later *cleared*; it
does not license destroying a different reason occupying the same field.

**Fix direction:** carry the blocked reason in a field this feature owns — the
stored availability document already holds it, and `/tasks` could join it by
`run.runner` — or capture and restore the prior `failureReason` around the
outage. Failing that, restrict the write to rows whose `failureReason` is null.

### OPUS-12 — P2 — "exactly one InboxMessage per continuous outage" holds for one runner daemon, not for two

Governing specification text:

> exactly one `InboxMessage` is emitted per continuous outage - not one per poll
> or heartbeat.

`RunnerBackendState` is keyed by `RunnerKind` alone, and the outage identity
(`app.ts:3287-3299`, `runner-cli-availability.ts:83-91`) is derived only from the
previous stored value. With two runner daemons where host A has `claude` and host
B does not, B's heartbeat writes `available: false` (new `outageKey`, new
`InboxMessage`), A's heartbeat writes `available: true` (closes it), and the pair
repeats every heartbeat interval: one `InboxMessage` per heartbeat, and claiming
for CLAUDE alternates between blocked and allowed globally even though host A can
serve every CLAUDE task.

This is a faithful reuse of the semantics the specification pointed at — the
`AUTH_REQUIRED` circuit at `app.ts:3382-3397` flaps the same way for the same
reason — so it is a scoping judgement call rather than a specification violation,
and it is recorded here so the choice is explicit rather than inherited.

**Fix direction:** either state in the route's comment that availability is a
single-runner-per-kind installation assumption, or key the stored availability by
`runnerId` and treat a kind as unavailable only when no reporting daemon has it.

### OPUS-13 — P2 — an `available: false` report has no expiry, so a stopped daemon blocks its kind forever

Governing specification text:

> Availability is re-probed on the existing heartbeat cadence: once the CLI
> becomes resolvable again, the backend returns to available and claiming resumes
> **without a runner restart**.

Recovery is entirely report-driven: `app.ts:3520` blocks on the last stored value
with no staleness check. `lastCheckedAt` is stored
(`runner-cli-availability.ts:14`, `:71`) and surfaced as `lastAvailabilityAt`
(`app.ts:937`) but never read by any decision. If the reporting daemon stops
while unavailable, the kind stays blocked indefinitely and no restart of *that*
runner helps, because a fresh daemon on a host that does have the CLI is what
clears it — which is fine — but a fresh daemon that never starts leaves the
control plane refusing work forever with the reason frozen at whatever the dead
daemon last said. The existing `AUTH_REQUIRED` circuit at least records
`circuitOpenedAt`.

**Fix direction:** treat a stored availability older than N heartbeat intervals
as unknown rather than as blocking, and say so in the route comment.

### OPUS-14 — P2 — `/runner/availability` is reachable by the merge-executor principal with no per-route refusal

`packages/api/src/auth.ts:73-76` grants both `runner` and `merge-executor`
principals every path under `/runner/`, and notes that what a merge-executor may
actually do "is decided per route by `mechanicalPrincipalRefusal`". The new route
(`app.ts:3284`) has no such check, so the gate worker's independently issued
token can mark any `RunnerKind` unavailable, halt all agent claiming, write
`failureReason` across every project's tasks, and post an operator alert.

`/runner/preflight` has the same exposure today and can already open a circuit,
so this is the existing trust boundary rather than a new one — recorded as a
judgement call, not as a regression.

**Fix direction:** if the boundary is intended, say so in a comment at the route;
if not, refuse a merge-executor principal here and at `/runner/preflight`
together.

---

## Process

### OPUS-15 — P2 — the recorded `implementation_range.base` does not bound the implementation

`.chain/runner-cli-availability-fail-loud/sessions.md`

The file records `base: 9914a40`, but `9914a40` is itself a commit inside the
feature and its own changes to `packages/runner/src/availability.ts` fall outside
the range it labels. `git diff 9914a40 29f6879 --stat` touches no `packages/runner`
file at all. The implementation's true base is `0d5b93e`, the parent of the
`ad8bc67` WIP salvage.

Any reviewer who trusts the label reviews about a quarter of the feature and none
of the runner daemon.

**Fix direction:** correct the entry to `base: 0d5b93e4…` before this chain's
record is closed.

---

## Summary

| ID | Severity | Axis | Location |
|---|---|---|---|
| OPUS-1 | P1 | standards | `packages/api/src/app.ts:3311` |
| OPUS-2 | P1 | standards | `packages/api/src/runner-cli-availability.ts:52`, `app.ts:3289` |
| OPUS-3 | P2 | standards | `packages/runner/src/availability.ts:16` |
| OPUS-4 | P2 | standards | `packages/runner/src/runner.ts:453` |
| OPUS-5 | P2 | standards | `packages/runner/src/runner.ts:568` |
| OPUS-6 | P2 | standards | `packages/runner/src/runner.ts:521` |
| OPUS-7 | P2 | standards | `packages/runner/src/runner.ts:563` |
| OPUS-8 | P2 | standards | `packages/runner/src/availability.ts:7` |
| OPUS-9 | P2 | spec | `packages/runner/src/availability.ts:18` |
| OPUS-10 | P2 | spec | `packages/runner/src/runner.ts:533` |
| OPUS-11 | P2 | spec | `packages/api/src/app.ts:3301` |
| OPUS-12 | P2 | spec | `packages/api/src/app.ts:3287` |
| OPUS-13 | P2 | spec | `packages/api/src/app.ts:3520` |
| OPUS-14 | P2 | spec | `packages/api/src/app.ts:3284` |
| OPUS-15 | P2 | process | `.chain/runner-cli-availability-fail-loud/sessions.md` |

No P0. Two P1. The feature's specified behaviour is implemented and its stated
acceptance shape is present; both P1 findings are in how the new code handles its
own failure modes, which is the one thing this feature is about.
