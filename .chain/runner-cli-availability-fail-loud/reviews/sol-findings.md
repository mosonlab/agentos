# Sol review findings

## Review authority

- `implementation_range.base`: `9914a401d0f9fa94dbe9d8556a66bcbf46a7f4ce`
- `implementation_range.head`: `29f687921d12552fc8aacb3804b3003a41b21d12`
- Both objects resolve as commits; checkout `HEAD` was exactly the persisted head throughout both harness runs and code inspection. The review-record commit was added only afterward.
- Direct chain: no revised plan exists. Governing specification: `.chain/runner-cli-availability-fail-loud/spec.md`.
- Scope covered the complete authoritative `base...head` diff, the resulting tree, all feature-relevant runner/API/task/inbox/claim paths, and acceptance tests. No alternate base was substituted.

## Finding counts

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 1 |
| P2 | 0 |

## SOL-STD-001 — P1 — Concurrent preflight can overwrite the latest CLI availability

- Axis: Standards and Specification.
- Classification: hard correctness violation, not a Fowler smell judgement.
- Location: `packages/api/src/app.ts:3357`, `packages/api/src/app.ts:3374`; affected availability write at `packages/api/src/app.ts:3287-3300` and claim decision at `packages/api/src/app.ts:3517-3520`.
- Governing specification:
  - “While a runner kind is unavailable, a task assigned to it surfaces an operator-visible reason naming the missing CLI through existing task/inbox surfaces, and exactly one InboxMessage is emitted per continuous outage - not one per poll or heartbeat.”
  - “Availability is re-probed on the existing heartbeat cadence: once the CLI becomes resolvable again, the backend returns to available and claiming resumes without a runner restart, and the blocked reason set in item 3 is cleared.”
- Problem: `/runner/preflight` reads `RunnerBackendState.capabilities` before its `upsert`, outside a transaction, then `preserveCliAvailability` writes the entire stale JSON object back. A concurrent `/runner/availability` transaction writes the same JSON column. Either route can therefore erase the other route's just-committed state.
- Evidence:
  1. `packages/api/src/app.ts:3357` reads `previous` before any transaction or row lock.
  2. `packages/api/src/app.ts:3374` derives the replacement JSON from that old snapshot and replaces `capabilities` as one value.
  3. `/runner/availability` independently reads and replaces the same value at `packages/api/src/app.ts:3287-3300`; its `Serializable` transaction cannot protect a read/write performed by the separate preflight request outside that transaction.
  4. The repository explicitly permits the trigger: `README.md:228-231` says any number of runner daemons may poll one API, and every starting daemon sends preflight while existing daemons continue availability heartbeats.
  5. If preflight restores stale `available: true` after a missing report, `packages/api/src/app.ts:3520` permits a claim for the absent CLI. The next missing heartbeat sees a false outage transition and can create a second InboxMessage for the same physical outage. The reverse interleaving restores stale `available: false` after recovery and keeps claiming blocked until another heartbeat.
  6. `packages/api/src/runner-cli-availability.dbtest.ts:99-101` and `:161-166` exercise only serial report sequences; they do not falsify this interleaving.
- Fix direction: make availability and preflight update disjoint JSON subtrees atomically, or put both read/merge/write paths behind the same row-locking transaction with bounded retry for serialization conflicts. Do not preserve one field by replacing the whole `capabilities` value from a stale snapshot.
- Required regression: deterministically pause preflight after its read, commit a missing availability report, resume preflight, then assert the stored backend remains unavailable, its queued task is unclaimable, and repeated missing heartbeats still leave exactly one InboxMessage. Add the reverse ordering for recovery and assert the available state, cleared task reason, closed outage message, and normal claim all survive the delayed preflight write.

## Axis conclusions

- Standards: one confirmed P1 hard correctness violation. No P0, P2, or retained Fowler smell judgement.
- Specification: every requirement and acceptance criterion was traced. No independent specification-only finding remained after verification; SOL-STD-001 also violates requirements 3-4 under the documented concurrent-daemon deployment model.

## Verification evidence

- Required Standards harness: exit 0; one candidate, confirmed as SOL-STD-001.
- Required Specification harness: exit 0; no candidate findings.
- Harness verification in isolated temporary roots/PostgreSQL: runner `155/155`; API unit `411 passed, 1 skipped`; API dbtest `332/332`.
- Coordinator narrow regressions after fresh-worktree setup:
  - `node --import tsx --test packages/runner/src/availability.test.ts packages/api/src/runner-cli-availability.test.ts`: `5/5` passed under a scratch `RUNNER_WORKSPACE_ROOT`.
  - `node --import tsx --test --test-name-pattern='startup reports Claude and Pi blocked|availability heartbeat reports a CLI recovery|a Codex claim passes its own preflight' packages/runner/src/runner.test.ts`: `3/3` passed under a scratch `RUNNER_WORKSPACE_ROOT`.
- The first narrow-test attempt did not enter test bodies because the fresh checkout lacked `node_modules/tsx`. After `npm install`, `npm run db:generate`, and builds of `@agentos/db` and `@agentos/github-client`, the same regressions passed. This was an environment failure, not product evidence.
- `git diff --check`: passed.

## Harness commands

Both commands ran in the background from the delivered head with stdin detached and separate logs:

```sh
codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from 9914a401d0f9fa94dbe9d8556a66bcbf46a7f4ce to 29f687921d12552fc8aacb3804b3003a41b21d12. Standards axis only. Independently review the complete integrated diff and resulting tree for correctness, security, repository conventions, and the five Fowler smell families; documented repository standards override the smell baseline; label smells as judgement calls with a named fix direction; do not duplicate passed lint/type/format checks; inspect implementation and tests first; return exact candidate findings only; do not modify files." </dev/null > /tmp/cmt2f7yl2065jmp4593k1ij84-standards.log 2>&1 &
codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from 9914a401d0f9fa94dbe9d8556a66bcbf46a7f4ce to 29f687921d12552fc8aacb3804b3003a41b21d12. Specification axis only. Trace every requirement and acceptance criterion through the complete integrated diff, resulting tree, and tests; every candidate must quote the governing specification and identify violating code or missing evidence; flag unrequested behavior; use exact locations, evidence, severity, and test direction; do not modify files. The approved specification follows verbatim: <full contents of .chain/runner-cli-availability-fail-loud/spec.md>" </dev/null > /tmp/cmt2f7yl2065jmp4593k1ij84-spec.log 2>&1 &
```
