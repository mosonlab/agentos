# Persisted AgentOS output — Batch4Fix IMPLEMENT

Source task: `cmswjrnf40t4mmpyjn9u931bk`

Output kind: `result`

The content below is a verbatim archive of the task's persisted output.

---

# IMPLEMENT — Batch 4 FIXES: session usage correctness, migration safety

**Branch** `agentos/cmswjrnf40t4mmpyjn9u931bk/run-3`, pushed. Nine commits, `59ecb48` → `55f0929`, one per plan work item, each naming its section. Base: the R1 revision `aaad446` (see "Branch shape" below).

**Status: complete.** All nine work items implemented, all five gates green, the §7.3 rehearsal run end to end. Two environment problems and one flaky pre-existing test are reported below; neither is caused by this batch.

| file | WI | ± |
|---|---|---|
| `packages/db/src/usage.ts` | 1,2,3,4,9 | +318 |
| `packages/db/prisma/backfill-session-usage.ts` | 4 | 29 → 16 lines |
| `packages/api/src/usage.test.ts` | 5,9 | +339 |
| `packages/api/src/app.test.ts` | 5 (C2),9 (C6) | +42 |
| `packages/api/src/app.ts` | 3 (comment only) | +2 |
| `packages/api/src/usage.dbtest.ts` *(new)* | 6 | +385 |
| `…/20260816165548_batch4_session_usage/migration.sql` | 7 | +22 |
| `docs/runbooks/batch-4-rollback.md` *(new)* | 8 | +382 |
| `docs/specs/batch-4-sessions-viewer.md`, `docs/plans/batch-4-sessions-viewer-plan.md` | 9 | +51 |

No `apps/web`, no `schema.prisma`, no new migration folder, no credential. Verified by the §11.2 script — see "The diff-surface gate trips on itself".

---

## What the run settled that reading could not

Three of the plan's open questions are now answered by observation.

**The `::text AS locked` cast is load-bearing, and the parameterised binds work.** WI-6 test 0 — one uninstrumented `recomputeSessionUsage` against a real PostgreSQL — passes. So Prisma 6.19.0 accepts `${SESSION_USAGE_LOCK_CLASS}::int` and `${key}::int` as bound parameters, and the documented `$executeRawUnsafe` fallback was **not** adopted (plan §13 item 2, second half). The plan was right to carry the cast: without it every recompute raises `P2010` and the ingest `try/catch` swallows all of it.

**`lock_timeout` does bound an advisory-lock wait.** WI-6 test 2b holds the lock and races a real recompute:

```
[usage.dbtest 2b] contended recompute failed after 3178 ms, code P2010:
  Invalid `prisma.$queryRaw()` invocation: Raw query failed. Code: `55P03`.
  Message: `ERROR: canceling statement due to lock timeout`
```

`55P03` wrapped in `P2010` at ≈3.1 s, not `P2028` at 15 s (plan §13 item 1). Prisma's `timeout: 15_000` never had to fire and remains the backstop. Recorded in the test file as a comment, not as an assertion — pinning it would make an answer out of the question.

**The three `app.test.ts` ingest tests needed only stub scaffolding.** Their expectations (4 / 77 / 8820 / 81) are unchanged, exactly as plan §13 item 7 reasoned. Their fixture carries no `modelUsage`, so it takes WI-2's fallback branch — and it now says so out loud, which is what keeps that branch covered.

## The deletion check, actually run

Removed the `pg_advisory_xact_lock` line from `packages/db/src/usage.ts`, rebuilt, re-ran:

- **test 1 fails**: `expected 30, stored 10 (eventReads=2)` — A's stale absolute write lands last.
- **test 2b fails**: the contended recompute *resolves*.
- **tests 0, 2a, 3, 4 stay green**, as does every one of the 193 unit tests and the chain and migration db suites.

Restored, rebuilt, re-verified green. The file's header comment states this, states which tests are deliberately insensitive and why, and says "test 1 and test 2b", not "this test only" — a header promising a single failure teaches the next reader to treat a true positive as a broken test.

## The rehearsal (spec §7.3) — run, with three corrections

Run end to end on `agentos_rehearsal_b4`: a database **created empty and built from the twelve committed migrations**, seeded with five fixture sessions, dropped afterwards. Never a dump or clone of live; no second control plane pointed at anything.

Proven in order: both indexes build `CONCURRENTLY` and report `indisvalid | indisready = t | t` → `migrate deploy` applies **only the four columns** and records itself → `db:drift-check` exits 0 → backfill twice, `scanned 5, updated 5, failed 0` then `scanned 5, updated 0, failed 0`, both exit 0 → physical rollback drops indexes then columns with `costUsd` intact → drift against a batch-4-rolled-back datamodel exits 0 → forward redeploy applies cleanly **with one index deliberately left in place** → post-redeploy drift 0. Both URL shapes (bare and `?schema=…`) rehearsed per R1/MF-6.

**Three operator commands do not work as the spec writes them.** The runbook ships the working form and §8 tabulates the difference so a reader holding the spec knows why.

1. **`prisma migrate resolve --rolled-back` is refused** for a successfully-applied migration: *"cannot be rolled back because it is not in a failed state."* Spec §4.5 item 5 and plan WI-8 item 7 both make it the mandatory reconcile step. It only serves a migration whose *apply failed*. After a hand-rolled physical rollback the supported route is deleting the `_prisma_migrations` row — the same mechanism §4.4.2 already prescribes for the dev database.
2. **`SET lock_timeout='3s'; DROP INDEX CONCURRENTLY …` in one `psql -c` fails** — multiple statements in one `-c` share an implicit transaction block, and `CONCURRENTLY` cannot run in one. It fails *quietly enough to miss*: psql prints `ERROR` and moves to the next `-c`, leaving the index behind. I hit this during the rehearsal and only caught it because drift-check still reported the index. Working form: one statement per `-c`, bounded with `PGOPTIONS='-c lock_timeout=3s'` — which works for psql because psql is libpq, and does **not** work for Prisma, which uses its own Rust driver.
3. **Drift-check against "the pre-batch-4 checkout" does not necessarily exit 0.** Here that checkout also predates batch 2.5, so it reported `TriggerFire`'s foreign key and two `Task` indexes. The pairing rule holds per migration; the runbook says compare against a batch-4-only rollback and read the output rather than the exit code.

**MF-6 is worse than the review said.** On a `?schema=…` URL the naive `?options=` append makes `prisma migrate status` report the schema as `b4_schema_shape?options=-c lock_timeout=3s` and **all twelve migrations unapplied** — so `migrate deploy` would silently create a fresh schema and apply everything into it while the operator believed they were bounding a lock. The separator-detecting form was rehearsed on both shapes and `SHOW lock_timeout` confirms `3s` actually reaches the server.

## Gates

| gate | result |
|---|---|
| `npm run build` | ✅ (web bundle rebuilt before the test suite, as instructed) |
| `npm test` | ✅ exit 0 — web 126, api 193, runner 25, inbox 5, cli |
| database suites | ✅ chain 23, hooks 12, migration 8, scheduler 11, tasks 30, triggers 19, **usage 6** |
| `npm run typecheck` | ✅ exit 0 |
| `npm run db:drift-check` | ✅ exit 0 (scratch schema, all 12 migrations) |

Both real captures now derive the plan's numbers exactly: `claude-tool-event` → 545 / 98 / 8768 / 643 / `0.0491`; `claude-start-safe-mode` → 535 / 20 / 2969 / 555 / `0.0304`. Every pre-existing CODEX, PI, totality, partial, cost-only, resume-accumulation, lost-write-repair and missing-session assertion passes **unmodified** — the only removed lines in `usage.test.ts` are the trimmed fixture, one import, one comment and the four CLAUDE numbers.

For the record, read-only: the live database has applied **neither** batch 2.5's nor batch 4's migrations, so `db:drift-check` against it reports `TaskSource`, `TriggerFireSource`, `TriggerFire` and the batch-4 columns as pending. That is the pre-migration production state the spec describes, unchanged by me.

---

## Things the reviewer must know

### `npm run test:db` as a single command is broken here, and it predates this batch

Node **v26.5.0 does not honour `--test-concurrency=1`** for file-level concurrency (nor `--test-isolation=process`). The six suites therefore start together, and each one's `setupTestDb()` runs `DROP SCHEMA … CASCADE; CREATE SCHEMA` + `migrate deploy` on the shared schema — so they destroy each other mid-run. Baseline before I touched anything: the aggregate command failed with `The table agentos_test.Project does not exist`; every file passes alone.

Second, independent hazard: **a sibling AgentOS run is active on this machine** and shares the default `agentos_test` schema.

I ran the suites one file per node process against a private schema:

```bash
cd packages/api
for f in src/*.dbtest.ts; do
  TEST_DATABASE_URL='postgresql://agentos:agentos@localhost:5432/agentos?schema=agentos_test_b4fix' \
    node --import tsx --test "$f"
done
```

I did **not** change `packages/api/package.json`. Fixing the harness is a platform change, out of this batch's stated scope — but it should be fixed, because `usage.dbtest.ts` is the proof this batch rests on and the committed command cannot run it.

### One flaky test, demonstrably unrelated

`hooks.dbtest.ts` → *"concurrent webhook fires retry serialization conflicts and create independent chains"* fails roughly 1 run in 3 (observed: fail, pass, pass). It fires six concurrent webhooks and asserts six `201`s. That file contains **no** reference to `Session`, `FINAL_OUTPUT` or `recomputeSessionUsage`. It is batch 2.5's webhook serialization-retry path, not this batch's.

### The diff-surface gate trips on itself

The §11.2 credential check greps the diff for `operator_token` case-insensitively and reports six matches — every one of them the *identifier* appearing in prose that forbids writing the value (`"no connection string, no password and no OPERATOR_TOKEN belongs in this file"`), plus the check's own source. `OPERATOR_TOKEN` is never assigned a value anywhere in the diff, and the only long token-shaped strings are git SHAs, the public capture's session UUID and the migration folder name. The check is correctly conservative; a reviewer should read its output rather than its exit code. The other three checks (`apps/web`, `schema.prisma`, new migration folder) pass clean against both `origin/master` and the chain base.

---

## Deviations from the plan, each with its reason

1. **No rebase onto `origin/master`** (plan §11.4). Master has moved 8 commits with **zero** overlap with this diff (`apps/web`, `agents/roles`, briefs, two runbooks). The chain's `targetBranch` is the spec branch `agentos/cmswjrn9c0t44mpyjs2n4khwn/run-1`, not master; I had to fast-forward this run's branch to `aaad446` by hand to find ④'s work, so the next step will locate mine the same way — and rebasing off the chain branch is precisely the `targetBranch` failure mode `cb6c807` already books. If Leo wants the chain rebased, that is a one-command operation at merge time, on a branch nobody is mid-step on.
2. **`costUsd?.toString()` is `"0.05"`, not `"0.0500"`** (plan WI-5, mixed invalid-plus-valid cost test). `Decimal#toString` drops trailing zeroes. The stored value and the column's scale are both right, so the assertion compares by value (`toNumber() === 0.05`) and says why. Not a code defect.
3. **The runbook's rollback commands differ from spec §4.5** in the three ways tabulated above. The rehearsal is what found them; writing the spec's version verbatim would have shipped a runbook that fails at its first two steps.
4. **Stub scaffolding shipped inside the WI-3 commit** rather than waiting for WI-5. Plan §11.1 says landing WI-3 alone leaves `npm test` red and "do not stop between them"; folding the nine lines of scaffolding in keeps every commit individually green while leaving WI-5's substantive test additions their own commit. The commit message says so.

## Browser verification — not performed, and why

This batch has **zero `apps/web` diff** by spec §5 mandate, verified by the diff-surface gate, so there is no page whose markup or styling changed. Beyond that, the browser is genuinely unavailable in this workspace for a concrete reason: there is no repository-root `.env`, so the vite dev proxy has no operator token and the control plane answers 401 to every request (the web build says so out loud: *"OPERATOR_TOKEN is not set in the repository root .env; the control plane will answer 401"*). Creating one would mean sourcing a credential I was not granted and writing it into the workspace, for a batch with no visual surface. I ran `npm run build` (web bundle rebuilt, so the style tests read a fresh artifact) and the 126 web unit tests instead; both pass.

What *will* change visually once the operator deploys is the **value** in the Sessions and Tasks token columns — a CLAUDE session that showed 81 will show 643 — and that is proven by unit and database tests against the real captures, not by markup.

## Open questions, carried forward

1. **A1 — the retrospective review file is still missing.** `docs/reviews/2026-08-16-batch-4-sol-retro-review.md` is absent from the tree and from `origin/master`; it exists only as the output of task `cmswiyqdi0s9xmpyj6qlwa08f`. Every finding it carries was re-verified in the spec, in the plan and now in code, so nothing here depends on it — but if it holds a fourth finding the brief did not transcribe, all three documents have missed it. Third step in a row raising this. Cheapest fix: commit the file.
2. **The `test:db` harness is broken under Node 26** (above). Needs a platform decision: pin the node version, or make the harness robust — e.g. derive the schema name per test file, or serialise the resets with an advisory lock of its own.
3. **Whether Leo wants the cost guard (A2) at all.** Implemented, per the plan. It extends the original review's letter, which named only token fields.

Per the chain's standing rules `inbox_ask` was not called. Nothing merged, no production migration run, no restart, no launchd touched, no credential in any artifact. The scratch rehearsal database was dropped; the private test schema `agentos_test_b4fix` was left in place for the reviewer.

