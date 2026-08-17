# Batch 4 review-fix disposition

Implementation base: `55f092920f2ac4f972270d07b9328de3f9bb5d79`

Code-fix commit: `792570da5c8f6a4fc7af75cd65b395dead53033b`

Documentation-fix commit: `b2c7d3a72ca0d79a014f9db95cdf6a3cd128ece3`

Evidence-archive commits: `23b671a13e72e27a776e3446309eeb629dd52c37`,
`de3f3a696a5f95ce50d21e526495dd7c9f9396ba`

## Disposition table

Every finding from the chain review and the independent review task's two runs
is listed. The independent task's run 2 is its final persisted output; run 1 is
included as additional evidence so none of its findings is silently lost.

| source / finding | disposition | mechanically checkable evidence |
|---|---|---|
| Chain MF-1 — spec/plan publish disproved deploy and rollback commands | Applied | `b2c7d3a`: `docs/specs/batch-4-fixes-usage-correctness.md` §4.4.3/§4.5, `docs/plans/batch-4-fixes-usage-correctness-plan.md` WI-8, and `docs/runbooks/batch-4-rollback.md` §§1,4–8 now use one sequence. Scratch rehearsal forced `P3018/55P03`, recovered the failed row, physically rolled back, forward deployed, and finished with `db:drift-check` = 0. |
| Chain MF-2 — runbook has no written-against SHA | Applied | `b2c7d3a`: runbook v1.1 header and §1.5 name code commit `792570da5c8f6a4fc7af75cd65b395dead53033b` or a tested descendant. |
| Chain SF-1 — test 2b races holder and accepts any quick error | Applied with corrected expected behavior | `792570d`: `packages/api/src/usage.dbtest.ts`, test 2b has a `holderLocked` barrier, a 3.3 s lower bound, a 10 s upper bound, and asserts the final stored value. Reverting the barrier makes the schedule nondeterministic; reverting internal retry makes test 1/2b fail after the first 3 s wait. |
| Chain SF-2 — summed-overflow “writes” test was actually a no-op | Applied | `792570d`: `packages/api/src/usage.test.ts`, “summed-overflow session still writes a valid sibling” asserts `wrote === true`, one update, null input/total, and output 9. Reverting the sibling or write path fails this test. |
| Independent run-2 MF-1 — lock timeout can leave the final cache permanently stale | Applied | `792570d`: `packages/db/src/usage.ts` `lockWaitTimedOut`, `recomputeSessionUsageOnce`, and `recomputeSessionUsage` retry a rolled-back bounded attempt without a fixed count. `usage.dbtest.ts` tests 1 and 2b hold beyond 3 s and fail if the retry/lock is removed. |
| Independent run-2 MF-2 — psql rejects Prisma's `schema` URL parameter | Applied | `b2c7d3a`: runbook §1.0 derives `PSQL_URL`, validates `DB_SCHEMA`, and supplies `search_path` to every host/container psql call. Scratch probes returned `public` for the bare database and `reviewfix_shape` for the stripped query URL. |
| Independent run-2 MF-3 — `migrate resolve --applied` lacks schema and target | Applied | `b2c7d3a`: runbook §§1.3 and 7 pass both `DATABASE_URL` and `--schema packages/db/prisma/schema.prisma`, then query the same target. The scratch failed-apply recovery and forward deploy executed these explicit forms. |
| Independent run-2 MF-4 — deploy may apply batch 2.5 too | Applied | `b2c7d3a`: runbook §1.0 requires `migrate status`, records the complete pending set, and composes `batch-2.5-rollback.md` including `db:backfill-task-source`; spec §4.4.3 and plan WI-8 say the same. Fresh-schema logs mechanically show all 12 migrations in timestamp order. |
| Independent run-2 SF-1 — false rejection of `URLSearchParams.set` | Applied | `b2c7d3a`: runbook §1.3 and plan WI-8 use `URL`/`URLSearchParams.set`. A real Prisma 6.19 query returned `SHOW lock_timeout = 3s`; restoring the hand append is caught by the query-bearing URL probe. |
| Independent run-2 SF-2 — retrospective artifact missing | Applied | `23b671a`: exact `docs/reviews/2026-08-16-batch-4-sol-retro-review.md`, recovered from source commit `469ab0e`; plan §14 A1 is now resolved. |
| Independent run-2 SF-3 — `extractUsage` throws on BigInt/cycles | Applied | `792570d`: `packages/db/src/usage.ts` `render` catches diagnostic serialization and bounds output; `usage.test.ts` “total over unknown input” exercises BigInt and a cyclic invalid value. Reverting the guard throws `TypeError` in that test. |
| Independent run-1 MF-1 — 55P03 leaves a failed migration row and blind retry hits P3009 | Applied | `b2c7d3a`: runbook §1.3 requires object absence, failed-row inspection, explicit `--rolled-back`, verification, then retry. Barrier-confirmed scratch rehearsal produced `P3018` / database `55P03` and recovered successfully. |
| Independent run-1 MF-2 — test 2b holder race | Applied | Same `792570d` barrier and bounded-success evidence as Chain SF-1; focused real-DB run passed 6/6. |
| Independent run-1 MF-3 — binary-number cost sum rounds a half-unit down | Applied | `792570d`: `SessionUsage.costUsd`, `costAmount`, `sumUsage`, and `costColumn` use `Prisma.Decimal` before aggregation. `usage.test.ts` exact regression `0.000001 + 0.000049 -> 0.0001` fails if number addition is restored. |
| Independent run-1 MF-4 — retrospective and implementation-output evidence absent | Applied | Retrospective is `23b671a`; `de3f3a6` adds verbatim `docs/reviews/2026-08-16-batch-4-fixes-implementation-output.md`, retrieved from the live AgentOS task-output endpoint. Both source artifacts now coexist with the implementation and review docs. |
| Independent run-1 SF-1 — backfill materializes all sessions and all errors | Applied | `792570d`: `backfillSessionUsage` pages 100 rows by unique `id`, counts every failure, retains 20 diagnostics. Unit tests cover 205 rows/3 pages and 25 failures/20 diagnostics. |
| Independent run-1 SF-2 — runbook header not traceable | Applied | Same `b2c7d3a` header/restart evidence as Chain MF-2. |

No should-fix was skipped. The only non-green aggregate observation is the
pre-existing webhook serialization test: two full DB runs each passed 108/109
with one of six concurrent webhook requests returning 503; the same file then
passed 12/12 in isolation. It references neither Session, FINAL_OUTPUT, nor the
usage module and was already reported by the implementation and independent
review. Changing that path is outside this assignment.

## Conflict ledger

| positions | ruling | mechanism |
|---|---|---|
| Chain SF-1 asked test 2b to assert a surfaced `55P03`/`P2028`; independent run-2 MF-1 proved that surfacing `55P03` can leave a durable event's cache stale. | Independent MF-1 controls. The public recompute stays pending and retries; test 2b asserts a real wait followed by success, not an error. | The event rows commit before recompute. If an older holder commits after a timed-out contender, no future event is guaranteed. An unbounded sequence of independently bounded, rolled-back attempts does not return cleanly until the event is folded. |
| Independent run-2 proposed a watermark/dirty queue as one remedy and rejected merely fixed-count request retries; the original spec rejected a watermark schema change because unchanged events must be recomputed by MF-2. | Use unbounded lock-timeout retry, not a fixed count and not a new schema column. | `recomputeSessionUsage` never converts lock contention into a completed invocation; every attempt is bounded, holds no resource between retries, and the existing absolute recompute still rewrites unchanged historical events. Tests 1 and 2b cover the >3 s stale-writer interleaving. |
| Spec/plan prescribed second-`?` URLs, grouped concurrent drops, and `--rolled-back` after successful physical rollback; the implementation rehearsal and both reviews proved all three wrong. | The rehearsed runbook mechanisms are authoritative and spec/plan were amended to match. | URL parsing changes the schema target; PostgreSQL forbids `CONCURRENTLY` in a transaction; Prisma returns P3012 for a successfully applied row. Scratch rehearsal verifies URL API construction, one-call concurrency, failed-row resolve, successful-row deletion, and redeploy. |
| Independent run-1 reported the aggregate DB harness broken under Node 26; independent run-2 observed 109/109. Current runs produced 108/109 twice, with the same webhook test, while that file passed alone. | Do not change the harness or webhook logic in this batch. Record the unrelated flake and rely on the focused usage suite plus isolated webhook pass. | The command did serialize/rebuild schemas correctly; every usage test passed on both runs. The sole failure is a six-request webhook retry assertion in an untouched file and reproduces the implementation's pre-existing-flake report. |
| The chain review requested the “final” SHA inside the runbook, but editing the file necessarily creates a later SHA. | Pin the code-fix commit `792570d` and allow tested descendants; report the actual final branch head separately. | A commit cannot contain its own hash. The pinned commit is the behavior-changing code reviewed by the runbook; documentation/evidence commits are descendants, and final gates ran on the descendant head. |

## Browser evidence

The independent task's final run-2 output was read from the live AgentOS UI at
task `cmswp9ma214bxmpyj6du1g63n`. The Sessions page was then inspected in explicit
light and dark themes: light body `rgb(246, 242, 231)` / text `rgb(37, 33, 22)`;
dark body `rgb(11, 10, 7)` / text `rgb(241, 239, 228)`. The live control plane
behind that already-running Vite instance did not expose `GET /sessions`, so no
real usage row was available to inspect. This branch has no `apps/web` diff; the
behavioral value change is covered by the real-capture unit tests and PostgreSQL
tests rather than claimed as a visual row verification.
