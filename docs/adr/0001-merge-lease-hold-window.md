# 0001 - Narrow the merge lease hold window

Status: proposed

## Context

`scripts/merge-lease.sh` serialises the final merge window on `main` through one
ref on `origin`. `AGENTS.md` states its purpose precisely: the lease "keeps an
exact-head gate proof valid from the moment its baseline is fixed until that
proof is consumed by the merge". The segment that must be held is therefore
`fix the baseline -> run the gate -> merge`. Nothing else in the tail produces
or consumes that proof.

The autonomous chain tail holds it far wider than that. On 2026-08-26 two
delivery lines ran concurrently and the lease became the throughput bottleneck.

### Observed timeline (2026-08-26, UTC)

Chain `af3c73f5` (*Run duration display*, PR #138):

| Time | Event |
| --- | --- |
| 10:57:30 | regression run 7 acquires the lease, refreshes onto `origin/main` `0cb8f3c`, merge commit `d532af7` |
| 11:00:44 | semantic verification passes (3m14s) |
| 11:05:05 | `MERGE GATE: PASS` at `d532af7`; the run's own activity records "Merge lease released" |
| 11:06:34 | regression PASS recorded; readiness queued |
| 11:06:40 | independent review obligation opened |
| 11:59:13 | independent review approved (52m33s) |
| 11:59:18 | mechanical authorization |
| 11:59:32 | merged as `f1d6cf6` |

Chain `ff7a6904` (*Rollover and seed hardening*):

| Time | Event |
| --- | --- |
| 10:31:58 | regression run 1 acquires the lease |
| 10:50:23 | refresh onto `0cb8f3c` conflicts |
| 10:50:54 | `refresh-conflict` recorded, repair queued, control plane releases the lease |
| 11:13:28 | refresh-conflict repair completes (22m34s, unleased - correct) |
| 11:17:35 | regression run 2 acquires the lease (`acquiredAt` on the lease blob) |
| 11:18:08 | refresh onto `0cb8f3c`: already up to date |
| 11:57:43 | semantic verification complete (39m35s, in-lock) |
| 12:00:57 | release-authority check exit 0 |
| 12:01:23 | regression PASS recorded against base `0cb8f3c` |
| 12:01:27 | readiness: "target base advanced after regression PASS" `0cb8f3c` -> `f1d6cf6`; regression requeued |
| 12:02:56 | regression run 3 re-acquires (same task id, idempotent), refreshes onto `f1d6cf6` |
| 12:11:43 | regression PASS recorded at `9335539` |
| 12:11:48 | independent review obligation opened |
| 12:19:54 | independent review rejected, blocking round 1; review-fix repair queued; control plane releases the lease |
| 12:20:05 | chain `65d229d6` acquires the lease |

`ff7a6904` held the lease continuously for 62m19s (11:17:35 - 12:19:54) and
merged nothing. Of that window, 39m35s was semantic verification, 8m06s was an
independent review, and roughly 12 minutes was the gate plus the
release-authority check. `65d229d6` had been polling since about 12:17:33 and
was released only by the other chain's failure, not by its success.

### Where the lease is taken and given back

Acquire happens in exactly one place, and it is a prompt, not code:

- `agents/templates/direct-engineer-workflow/05-regression-verification.md:16`
- `agents/templates/compound-engineer-workflow/10-regression-verification.md:16`

Both say: "before the first fetch, acquire the chain merge lease with
`scripts/merge-lease.sh acquire --task {{chainId}} ...`". Acquire is idempotent
for one task id, so every later regression run of the same chain re-acquires
without contending with itself.

Release is control-plane only, always `--task <chainId>`:

- `packages/api/src/run-completion.ts:557` - a merge-tail run fails terminally with no retry
- `packages/api/src/run-completion.ts:596` - the mechanical merge step succeeded
- `packages/api/src/run-completion.ts:671` - canonical output refused on a regression step
- `packages/api/src/run-completion.ts:698` - regression completed but did not advance
- `packages/api/src/run-completion.ts:950` - a repair reported unable, or the independent review rejected
- `packages/api/src/merge-readiness-worker.ts:151` - `stopReadiness`
- `packages/api/src/reconcile.ts:379` - leases stranded by cancelled or lost runs
- `packages/api/src/app.ts:3689`, `:4201`, `:4398` - run settlement and cancellation

Two paths deliberately do not release: regression advancing to readiness, and
readiness requeueing regression after base drift. `steal` has no caller in the
repository; it is operator-only.

The lock therefore spans `regression acquire -> merge execution`, with a release
at every stop or bounce, and includes both agent-reasoning phases in the tail.

## Findings

### A. The independent review is inside the lock, by design

`merge-readiness-worker.ts:createReviewObligation` creates the review task and
parks readiness with `INDEPENDENT_REVIEW_OPEN_PREFIX` without releasing.
`merge-lease.ts:mergeTailLeaseChainId` enumerates independent reviews as tasks
that run under the lease, so this is intended behaviour, not an oversight. The
review neither produces nor consumes the gate proof: it reads
`baseSha..headSha` on GitHub and returns findings. Its duration is an agent
session's duration - 8m06s in one observation, 52m33s in the other - and all of
it is charged to every other delivery line's queue.

The review's cost is bounded three times over: up to
`MAX_BLOCKING_REVIEW_ROUNDS = 3` blocking rounds, each round adding a review-fix
repair session, a full regression run, and another review, all inside the lock.

The lease is not what makes the merge exact-head correct. Three independent
checks already are:

- readiness requeues regression when the PR head moved
  (`merge-readiness-worker.ts:398`) or when
  `snapshot.baseSha !== verdict.baseHeadSha` (`:433`);
- the server-side ancestry check refuses anything but `ahead`/`identical` with
  `behind_by == 0` (`:457`);
- the merge executor re-verifies every precondition against the live pull
  request and the exact-head authorization before merging.

The requeue at 12:01:27 above is that safety net firing correctly. So the lease
buys efficiency - it stops a gate run from being wasted - not safety.

The price of releasing across the review is therefore bounded and known: if
`main` advances while the review runs, readiness requeues regression, and the
chain pays one full regression run. That is more than one gate run, because the
step's prompt re-does semantic verification on every run: 3m14s for `af3c73f5`,
39m35s for `ff7a6904`.

### B. Acquire-before-integrate ordering: no defect found

Only three places state the ordering, and all three agree with `AGENTS.md`:

- `AGENTS.md:101` - acquire "before beginning the final sequence of integrating
  the latest `main`, running the merge gate, and performing the merge";
- both regression prompts, at line 16 - acquire "before the first fetch".

No code acquires the lease, so no call site can contradict them, and
`docs/runbooks/merge-delivery.md` does not mention the lease at all. The live
evidence matches: every regression run above acquired first and fetched second.
There is nothing to correct here.

The ordering is, however, what pulls the refresh and the whole semantic
verification phase inside the lock - see finding E.

### C. A regression agent released the lease itself

At 11:05:05 chain `af3c73f5`'s regression run recorded: "Gate PASS at `d532af7`
against baseline `0cb8f3c`; release-authority check exit 0. Merge lease
released, branch pushed fast-forward, pass output persisted."

Nothing asked it to. Neither regression prompt nor `agents/roles/regression-verifier.md`
mentions release; the release contract exists only in control-plane code, so it
is invisible to the agent, while `AGENTS.md:102` ("Release it immediately after
the delivery lands or fails") reads as an instruction to release whenever it
reaches a chain agent's context.

The consequence is the expensive one in this incident. `af3c73f5` then ran its
52-minute review, authorized, and merged PR #138 at 11:59:30 holding no lease at
all - while `ff7a6904` held it. `main` advanced under a held lease, which voided
`ff7a6904`'s baseline and made its entire 11:17:35 - 12:01:27 hold, including
39m35s of semantic verification and a full gate run, produce nothing.

### D. Thresholds are calibrated for a narrower window than the code produces

`STALE_SECONDS` is 45 minutes and `MERGE_LEASE_TIMEOUT_MINUTES` defaults to 60.
A lawful 62-minute hold is machine-stealable for its last 17 minutes and starves
a waiter just before it ends. No automatic caller of `steal` exists today, so
this is latent rather than active, but the numbers describe a window the tail no
longer fits in.

### E. Semantic verification is also inside the lock, and costs more than the review

The regression prompt orders the run as: acquire, fetch, merge base, semantic
verification, release-authority check, gate. Semantic verification is a full
agent reading of the fix diff. It neither produces nor consumes the gate proof,
and it was the single largest in-lock segment observed (39m35s versus roughly 12
minutes for the authority check and gate together). Any fix here is a prompt
change - see the cost note below.

### Cost note: prompt fixes are not cheap

`docs/runbooks/chain-template-changes.md` is explicit: once any task has been
created from a step, `sync-canonical-prompts.ts` refuses to change that step's
prompt at all. On a template with live history there is no prompt-only change; a
prompt rewrite must ride a shape change that rolls the canonical row over, which
means registering the outgoing graph in `canonical-template-transition.ts`,
extending the name-plus-ordinal predicates, and moving
`template-sources.ts`/`seed.ts` with it.

That asymmetry decides the sequencing below: control-plane fixes ship on their
own, prompt fixes ride the next rollover.

## Decision (proposed - awaiting a ruling)

### R1. Release across the independent review; readiness re-acquires

When the readiness worker parks on an open review obligation, release the lease
using the releaser it already holds. When the review clears and readiness is
handed back, acquire once before validating the pull-request snapshot; on
failure leave the step parked and retry on a later tick rather than blocking the
2-second poll loop. `merge-lease.sh acquire --timeout-minutes 0` already gives a
single-attempt acquire that exits 75 on contention, so no change to
`scripts/merge-lease.sh` is required. Rate-limit the retry to roughly the
script's own poll interval so a parked step does not push to `origin` every
tick.

This also closes finding C's blast radius: with readiness acquiring before it
authorizes, a stray agent-side release costs a re-acquire instead of an
unleased merge.

Scope: `packages/api/src/merge-readiness-worker.ts` only. This is a merge
automation path on the defense list, so it needs `senior-dev` and an explicit
authorization to touch it.

### R2. Rides the next template rollover

1. State the release contract in both regression prompts: the control plane owns
   release; the run never calls `release` or `steal`. (Fixes C at the source.)
2. Move the acquire from "before the first fetch" to immediately before gate
   dispatch, after semantic verification and the release-authority check pass,
   and add a post-acquire re-check that the base head has not moved since the
   refresh - re-fetch and re-merge if it has. (Fixes E.)
3. Amend `AGENTS.md:101` in the same change, since (2) contradicts its current
   wording for the chain tail.

### R3. Revisit `STALE_SECONDS` and the acquire timeout after R1

With R1 and R2 the tail's hold drops to roughly gate plus authorization plus
merge. Re-derive the thresholds from measured holds then; changing them now
would only paper over findings A and E.

## Alternatives considered

- **Do nothing; raise the thresholds (R3 alone).** Cheapest, changes no
  behaviour, and leaves the queueing exactly as observed. Rejected as a
  standalone answer: it treats the symptom.
- **Move the independent review before the gate.** Not possible. The review
  reviews `baseSha..headSha` on the refreshed head, which does not exist until
  the refresh, and its value is that it is bound to the exact head that will be
  merged.
- **Run the review concurrently with the gate.** Attractive on wall clock - the
  tail becomes `max(review, gate)` instead of the sum - but it requires the
  control plane to learn the refreshed head before the regression run finishes,
  which today it only learns from the run's final output. Larger change, and
  orthogonal to the lease: it shortens the tail without narrowing the lock.
  Worth reconsidering after R1.
- **Fix C with a prompt-only edit.** Blocked by the frozen-prompt rule above.
  R1 defuses it instead, and R2 fixes it properly at the next rollover.

## Consequences

- Base drift during an independent review becomes likely rather than rare, so
  the requeue path in `merge-readiness-worker.ts` moves from a rarely-exercised
  safety net to an ordinary path. It costs the drifting chain one full
  regression run, semantic verification included.
- The exact-head correctness argument is unchanged: it never rested on the
  lease. R1 removes an efficiency guarantee over one segment, not a safety one.
- Concurrent delivery lines stop paying each other's agent-session time. Under
  the observed incident, `65d229d6` would have acquired at about 12:11:48
  instead of 12:20:05, and `ff7a6904`'s wasted 44-minute hold would not have
  happened at all, because `af3c73f5` would have had to acquire before merging
  PR #138.
- Until R2 lands, semantic verification stays inside the lock, so holds shorten
  but do not become minimal.
