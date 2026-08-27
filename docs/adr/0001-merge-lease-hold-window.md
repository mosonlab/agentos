# 0001 - Narrow the merge lease hold window

Status: accepted (2026-08-26), amended (2026-08-26)

## Amendment (2026-08-26): the independent review and the release-authority check are retired

Two layers this record analyses no longer exist in the merge tail. Everything
below the amendment is kept verbatim as the analysis and incident record that
produced the decision; read it as history, not as current protocol.

Retired:

- **The independent blind review of defense-list diffs.** Gone with it:
  `createReviewObligation`, the review obligation markers and the
  `INDEPENDENT_REVIEW_OPEN_PREFIX` park and handback, the review completion
  path, the three blocking rounds (`MAX_BLOCKING_REVIEW_ROUNDS`), and the
  review-driven follow-up cards. Defense-list detection survives but is
  audit-only: when a diff touches a defense-list path, merge readiness writes
  one inbox message on the readiness task naming the triggered paths and
  reasons, and the merge proceeds unblocked. Nothing in the tail blocks on a
  review any more. (This is unrelated to the in-chain review template steps
  `code-review-sol` and `code-review-opus-blind`, which are unchanged.)
- **The release-authority Ed25519 signing layer.** Gone with it: the authority
  key material, the signing and verification module, the `db:authority-check`
  npm script the regression step ran before the gate, the migration preflight's
  `authority` condition, the authority-resign worker, and the
  `authority-resign` regression verdict.

What that retires in this record:

- R1's first bullet ("when readiness parks on an open review obligation, it
  releases") has no subject: readiness never parks on a review. The rest of R1
  stands and is in force - readiness acquires the Lease, once and without
  polling, immediately before it writes an authorization, and re-affirms its
  claim inside the authorization transaction.
- R2 item 2's ordering no longer includes a release-authority check; the acquire
  moves to immediately before gate dispatch, after semantic verification.
- The first consequence below (base drift during an independent review becoming
  an ordinary path) does not apply. Drift is still handled by the same requeue,
  but the review is no longer a window in which it happens.
- Finding A and the "move the review" / "run the review concurrently"
  alternatives are historical only; there is nothing left to move or
  parallelise.

Unaffected and still current: the Lease itself and its hold window, gate
attestation, the merge gate's build, lint, and test steps, and the `pass`,
`gate-fail`, and `refresh-conflict` regression verdicts with their gateProof
binding. R3 stands, and the retirements only shorten the holds it asks to be
re-measured.

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
| 11:03:51 | the run issues `git push ... ; scripts/merge-lease.sh release --task af3c73f5-... ; echo "EXIT=$?"` |
| 11:04:08 | the push fails (`SSL_ERROR_SYSCALL`); the release runs anyway and reports `MERGE LEASE: released` |
| 11:04:14 | the run retries the push and it succeeds |
| 11:05:05 | `MERGE GATE: PASS` at `d532af7`; the run reports "branch pushed fast-forward" |
| 11:06:34 | regression PASS recorded; readiness queued |
| 11:06:40 | independent review obligation opened; review run 1 starts |
| 11:36:51 | review run 1 declared `lost` (runner heartbeat starved) after 30m10s |
| 11:51:53 | review run 2 declared `lost` after 15m01s |
| 11:59:13 | review run 3 approves after 7m18s (52m33s wall clock across three runs) |
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
`baseSha..headSha` on GitHub and returns findings. All of its duration is charged to every other
delivery line's queue, and that duration is not bounded by review effort. In the
`af3c73f5` observation the obligation was open for 52m33s across three runs: two
were declared `lost` to runner heartbeat starvation after 30m10s and 15m01s, and
only the third did the review, in 7m18s. The in-lock window is therefore set by
runner-loss detection and retry count, not by how long a review takes. The other
observation, `ff7a6904`, took 8m06s in a single run.

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

The session transcript for chain `af3c73f5`'s regression run 7 is unambiguous.
At 11:03:51 it ran, as one shell line:

```sh
git push origin HEAD:fix/run-duration-display 2>&1 | tail -3; \
scripts/merge-lease.sh release --task af3c73f5-... 2>&1 | tail -3; echo "EXIT=$?"
```

and at 11:04:08 got back:

```
fatal: unable to access 'https://github.com/mosonlab/agentos.git/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443
merge-lease: released refs/merge-lease/holder (1c9e90d...)
```

No cancellation and no lost run occurred anywhere between 11:04 and 11:17:35,
so this release, and not a control-plane path, is what freed the ref.

Two things went wrong on that one line. The release was never authorized:
neither regression prompt nor `agents/roles/regression-verifier.md` mentions
release, the release contract exists only in control-plane code and is invisible
to the agent, and `AGENTS.md:102` ("Release it immediately after the delivery
lands or fails") reads as an instruction to release whenever it reaches a chain
agent's context. And the release ran after the push had already failed, because
`;` ignores the push's status and `EXIT=$?` reports the exit of `tail -3` rather
than of either real command - so the run had no failure signal at all where the
prompt requires it to fail loudly. The branch reached `origin` only on a retry at
11:04:14, a minute after the global lock had been handed away.

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

## Decision

The defect the four findings share is an asymmetry: **release is entirely
code and acquire is entirely a prompt.** Nine control-plane call sites give the
lease back; one model, following a sentence in a template, takes it. A mutual
exclusion protocol half-executed by something that does not have to follow the
protocol produces exactly finding C - a release nobody asked for, issued after
the push on the same shell line had already failed, with no exit code checked.

Closing the asymmetry completely would mean the control plane acquiring for the
regression run. That is worse, not better: the control plane cannot see inside a
run, so a lease taken for the run covers the whole run, including the 39m35s of
semantic verification. Correct granularity there needs the regression step split
in two, which is a template shape change. So the asymmetry closes at the one
point where the lock is actually load-bearing.

### R1. The control plane takes the lease where the lock is load-bearing

The segment that has to be serialised is the one `AGENTS.md` describes and no
larger: from the base an authorization pins to the merge that consumes it. That
segment is entirely inside the control plane, and it is about twenty seconds
long. So:

- When readiness parks on an open review obligation, it releases. The review
  reads a diff on GitHub; it neither produces nor consumes the proof.
  (Retired 2026-08-26 with the independent review itself - see the amendment.)
- Before it writes an authorization, readiness acquires - one attempt, never a
  poll, since a tick cannot block on a lock another line may hold for minutes.
  `merge-lease.sh acquire --timeout-minutes 0` already exits 75 on contention,
  so `scripts/merge-lease.sh` is not touched. A tick that cannot take the lease
  leaves its step claimed; the claim expires after
  `READINESS_CLAIM_LEASE_MS` and a later tick tries again, which rate-limits the
  retry to roughly the script's own poll interval for free.
- Because the acquire is a network round trip spent inside the claim's lease,
  the authorization transaction re-affirms the claim before it writes anything.
  Without that, a worker that lost its step while acquiring could queue a second
  merge execution.

Acquire is idempotent for one task id, so in the ordinary case - no drift, no
stray release - readiness's acquire finds the lease already held for the same
chain and changes nothing.

This also closes finding C's blast radius: with readiness taking the lease
before the only action that consumes the proof, a stray agent-side release costs
a re-acquire instead of an unleased merge.

Scope: `packages/api/src/merge-lease.ts` and
`packages/api/src/merge-readiness-worker.ts`. This is a merge automation path on
the defense list; it was authorized explicitly on 2026-08-26.

### R2. Not a project of its own; rides the next template rollover

1. State the release contract in both regression prompts: the control plane owns
   release; the run never calls `release` or `steal`. (Fixes C at the source.)
2. Move the acquire from "before the first fetch" to immediately before gate
   dispatch, after semantic verification passes, and add a post-acquire re-check
   that the base head has not moved since the refresh - re-fetch and re-merge if
   it has. (Fixes E. The release-authority check that used to sit between the
   two was retired on 2026-08-26.)
3. Amend `AGENTS.md:101` in the same change, since (2) contradicts its current
   wording for the chain tail.

Implemented by the `regression-verification-v2` template rollover. The output
kind is the structural generation marker: renamed v1 rows preserve their
frozen prompts and schema, while new canonical rows require schema version 2
and the narrowed lease protocol above.

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
- **Give the control plane the acquire as well, for the regression run.** The
  symmetric-looking answer, and the wrong one: it widens the lock to the whole
  run rather than narrowing it, because the control plane cannot see the point
  inside the run where the base gets pinned.

## Consequences

- Base drift during an independent review becomes likely rather than rare, so
  the requeue path in `merge-readiness-worker.ts` moves from a rarely-exercised
  safety net to an ordinary path. It costs the drifting chain one full
  regression run, semantic verification included. (Retired 2026-08-26: with no
  review in the tail, this window is gone. The requeue path is unchanged and
  still the safety net for drift from any other cause.)
- The exact-head correctness argument is unchanged: it never rested on the
  lease. R1 removes an efficiency guarantee over one segment, not a safety one.
- Concurrent delivery lines stop paying each other's agent-session time. Under
  the observed incident, `65d229d6` would have acquired at about 12:11:48
  instead of 12:20:05, and `ff7a6904`'s wasted 44-minute hold would not have
  happened at all, because `af3c73f5` would have had to acquire before merging
  PR #138.
- New v2 chains keep semantic verification outside the lock. Renamed v1 chains
  retain their original protocol as immutable execution history.

## Out of scope, reported not fixed

Two independent review runs were lost to runner heartbeat starvation on
2026-08-26 (30m10s and 15m01s before detection). That is a runner reliability
question, not a lease question, and it is recorded here only because it is what
made one in-lock window seven times longer than the work inside it.
