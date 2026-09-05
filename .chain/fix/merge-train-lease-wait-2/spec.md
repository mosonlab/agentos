## Goal

A merge train whose gates PASSed does not discard its proof when another window holds the merge lease at publish time.

## Background

`scripts/merge-train.mjs` builds prefixes, gates them concurrently, and only then acquires the merge lease (`acquireMergeTrainLease`, `scripts/merge-train.mjs` line 110) with `timeoutMinutes: 0`. ADR 0002 decided the lease is held only for publication, and ADR 0003 accepts that a concurrent merge can waste one completed gate. In deepening round 6 (2026-09-04) the same two-candidate train returned `lease-contended` twice in a row: another window's short docs deliveries took the lease inside the train's 5-minute gate window each time, and each contended return threw away two PASSed gates although `main` had not moved at the moment the lease was refused. The coordinator worked around it by pre-acquiring the lease under the train's `--task` before starting the train (`merge-lease.sh acquire` is reentrant per task), which holds the lease across gating and is exactly the wider hold ADR 0002 wanted to avoid.

## Changes

1. `merge-train.mjs` acquires the lease with a bounded wait instead of `timeoutMinutes: 0`: a new `--lease-wait-minutes <n>` flag (default a small value, for example 10) is passed through `acquireMergeTrainLease` to `merge-lease.sh acquire --timeout-minutes`, which already polls.
2. After the lease is acquired, the existing live-main recheck stays as is: if `main` still equals `baseSha`, the already-gated prefixes publish; if it moved, the train returns `stale-base` exactly as today. No gate is re-run and no proof is reused across a moved base.
3. The `lease-contended` status remains for the case where the wait expires, and its JSON carries how long it waited.
4. `docs/adr/0002-coordinate-main-delivery-with-merge-trains.md` gains one paragraph recording that the acquire may wait but still covers publication only, and the reason (gate proof wasted on a lease held for seconds). `docs/operator-api.md` is untouched (no HTTP route).

## Out of scope

- Moving the acquire before gate dispatch, or any longer hold window (ADR 0002 stands).
- Reusing gate proofs after `main` moves.
- Changes to `merge-lease.sh`, the readiness acquire (ADR 0003), or the chain merge tail.
- Any queueing or fairness between windows.

## Constraints

- Fail loud: a lease script exit that is neither acquired nor contended remains `unreachable` and throws.
- The lease is released by the train on every path it is released on today; the wait must not introduce a path that retains it.

## Acceptance

- `scripts/merge-train.test.mjs` (or the existing train unit tests) cover: contended then acquired within the wait with unchanged main publishes; contended then acquired with moved main returns `stale-base`; wait expiry returns `lease-contended` with the waited duration.
- `node scripts/merge-train.mjs --help` documents `--lease-wait-minutes`.
- `npm run lint` and `npm run typecheck` pass; ADR 0002 carries the paragraph.

Evidence: records/anneal/programs/anneal-deepen-20260904/LEDGER.md (train 4, 21:11 and 21:19 entries) and FINAL.md.

Route: implementation=senior-dev-astra-medium - lease and gate ordering semantics that the acceptance suite states but cannot witness under real contention