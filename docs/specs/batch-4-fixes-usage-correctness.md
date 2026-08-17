# SPEC — Batch 4 FIXES: session usage correctness, migration safety

Status: draft for the plan step (②). Written against `master` at `749e518` (2026-08-16), i.e. after
batch 4 merged as `2737113` and after the batch 2.5 chain merged (PR #56). Every code fact below was
re-read at that commit; where this document disagrees with the task brief or with the retrospective
review, §9 says so explicitly and gives the mechanism.

Scope authority: [`docs/briefs/batch-4-fixes-usage-correctness.md`](../briefs/batch-4-fixes-usage-correctness.md),
which reproduces the retrospective backend review's findings verbatim.
Prior art the plan step must read before planning:
[`docs/specs/batch-4-sessions-viewer.md`](./batch-4-sessions-viewer.md) §4.6 and §10,
[`docs/plans/batch-4-sessions-viewer-plan.md`](../plans/batch-4-sessions-viewer-plan.md) §"usage" (lines 455-500),
and [`docs/runbooks/batch-2.5-rollback.md`](../runbooks/batch-2.5-rollback.md) §"Index locking during `db:migrate`"
— that section is the convention this batch extends rather than replaces.

> **Source note.** The brief cites `docs/reviews/2026-08-16-batch-4-sol-retro-review.md` as binding.
> **That file is not in this repository** and is not on `origin/master`; it exists only as the output
> of task `cmswiyqdi0s9xmpyj6qlwa08f`. The brief quotes its findings, numbers and prescriptions
> verbatim, so the brief is the working scope basis for this spec. Every finding below was
> re-verified against the code and the captured samples in-tree — see §2 — so nothing here depends on
> reading the missing file. **Assumption A1.**

---

## 1. Problem and audience

**Audience.** Leo, the single self-hosted operator, is the end user and the person who will type the
migration commands. The direct consumers of this document are the plan agent (②/④), the implementer
(⑤) and the reviewer (⑥).

**Problem.** Batch 4 shipped a sessions viewer whose numbers are wrong underneath and whose migration
cannot currently be deployed safely. Concretely:

1. **The production migration has not been applied and the platform has not been restarted onto batch
   4's code.** Both are frozen on this batch. Everything here is on the critical path to that deploy.
2. `recomputeSessionUsage` is a read-modify-write across three unsynchronised awaits. A reproduced
   interleaving writes a stale total over a newer one and it persists indefinitely. The code comment
   and the plan both assert the opposite invariant in writing.
3. The Claude token extractor reads only the top-level `usage` object, which describes **one** model.
   Real Claude terminal events also carry `modelUsage`, keyed by model. `total_cost_usd` covers every
   model. So the session page shows the full cost next to ~13% of the tokens.
4. The documented rollback for the migration does not work by either of its two readings, and the
   migration's two `CREATE INDEX` statements are blocking builds against a 122 MB table with six
   runner processes writing into it continuously.
5. `finite()` accepts negatives, fractions and values outside PostgreSQL `INTEGER` range and hands
   them to `Int?` columns; one such payload aborts the whole backfill scan, permanently, because a
   re-run dies at the same row.

**Why it matters now.** (3) is not merely a backfill problem: the live ingest path
(`packages/api/src/app.ts:2519`) calls the same extractor, so from the moment the new API comes up,
every finishing Claude session starts storing an under-counted total. The extractor must be correct
**before the restart**, not merely before the backfill.

---

## 2. Evidence, re-verified in-tree

Everything in this section was checked at `749e518` while writing this spec. Where the brief's
pointer is stale, the corrected pointer is given; the finding itself held in every case.

### 2.1 MF-1 — the unserialised read-modify-write

`packages/db/src/usage.ts:138-152` is three separate awaits with no transaction and no lock:
`findMany` (events) → `findUnique` (current columns) → `update` (absolute values). Callers:

| caller | site | verified |
|---|---|---|
| live ingest | `packages/api/src/app.ts:2519`, inside `POST /runner/runs/:runId/events` | ✅ (the brief says "~1790"; the call is at **2519** — line numbers moved after batch 2.5 merged) |
| backfill | `packages/db/prisma/backfill-session-usage.ts:23` | ✅ |

The false invariant is written in two places and must be corrected in both:

- `packages/db/src/usage.ts:133-136` — *"this is single-writer in practice; two concurrent callers
  would still converge because both compute from the same table."*
- `docs/plans/batch-4-sessions-viewer-plan.md:478-482` — *"last writer wins and both writers compute
  from the same table, so they converge … a performance note rather than a correctness requirement."*

Both are false for the same mechanical reason: the two callers compute from the same *table*, but not
from the same *snapshot*. A caller that read the event set at T1 can commit its write after a caller
that read at T2 > T1, and because the write is absolute the later-but-staler write wins and nothing
ever revisits it — the no-write comparison in `sameColumns` then makes every subsequent recompute a
no-op, because the stored value is self-consistent, just wrong. The reproduced interleaving:

```
{"expectedInputTokens":30,"storedInputTokens":10,"eventReads":2}
```

### 2.2 MF-2 — `modelUsage` is where a Claude session's real tokens are

`extractUsage` (`packages/db/src/usage.ts:39-65`) reads only `event.usage` (snake_case) and
`event.total_cost_usd`. Both captured Claude `result` events in
`spikes/cli-capabilities/samples/` also carry a top-level **`modelUsage`** object, keyed by model id,
whose entries use **camelCase** field names. Parsed from the untrimmed captures while writing this
spec:

**`claude-tool-event.stdout`** — `total_cost_usd: 0.049117`

| source | input | output | cacheRead | cacheCreation | cost |
|---|---|---|---|---|---|
| top-level `usage` (snake_case) | 4 | 77 | 4332 | 4436 | — |
| `modelUsage["claude-haiku-4-5-20251001"]` | 541 | 21 | 0 | 0 | 0.000646 |
| `modelUsage["claude-opus-5"]` | 4 | 77 | 4332 | 4436 | 0.048471 |
| **`modelUsage` sum** | **545** | **98** | 4332 | 4436 | **0.049117** |

**`claude-start-safe-mode.stdout`** — `total_cost_usd: 0.030392999999999996`

| source | input | output | cacheRead | cacheCreation | cost |
|---|---|---|---|---|---|
| top-level `usage` | 2 | 3 | 0 | 2969 | — |
| `modelUsage["claude-haiku-4-5-20251001"]` | 533 | 17 | 0 | 0 | 0.000618 |
| `modelUsage["claude-opus-5"]` | 2 | 3 | 0 | 2969 | 0.029775 |
| **`modelUsage` sum** | **535** | **20** | 0 | 2969 | **0.030393** |

Three facts follow, and each one drives a rule in §4.2:

1. The top-level `usage` object **is** the primary model's entry, repeated. Adding the two would
   double-count that model. (Verified: `usage` equals `modelUsage["claude-opus-5"]` field for field
   in both captures.)
2. The per-model `costUSD` values sum to `total_cost_usd` exactly (0.000646 + 0.048471 = 0.049117).
   So `total_cost_usd` is already the all-model figure and cost needs no change — it is the *tokens*
   that describe a narrower envelope than the cost sitting next to them.
3. The under-report is 545 → 4, i.e. the stored input token count is **0.7%** of the truth for the
   tool capture and the combined input+output total is 81 of 643, **12.6%** — the "~87% under-report"
   in the brief.

`packages/api/src/usage.test.ts:8-20` states in a comment that its fixture is "pasted from
spikes/cli-capabilities/samples/" while having dropped `modelUsage` (and `server_tool_use`,
`cache_creation`, `iterations`, `speed`, `inference_geo`). Line 59-65 then asserts `inputTokens: 4`.
The test does not merely miss the bug; it certifies it.

### 2.3 MF-3 / MF-3b — the migration and its rollback

`packages/db/prisma/migrations/20260816165548_batch4_session_usage/migration.sql` (11 lines) does
three things, not one:

```sql
ALTER TABLE "Session" ADD COLUMN "cachedInputTokens" INTEGER, ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER, ADD COLUMN "totalTokens" INTEGER;
CREATE INDEX "Session_projectId_requestedAt_idx" ON "Session"("projectId", "requestedAt");
CREATE INDEX "SessionEvent_runId_seq_idx" ON "SessionEvent"("runId", "seq");
```

`docs/specs/batch-4-sessions-viewer.md:659-665` describes the rollback as `DROP COLUMN` on four
columns and calls the backfill "idempotent and write-only-to-null". Both halves are wrong:

- The indexes are not mentioned at all.
- The backfill is **not** write-only-to-null. `recomputeSessionUsage` writes whenever `sameColumns`
  is false — an absolute recompute of every session that has a `FINAL_OUTPUT` event, overwriting a
  populated cache that differs. That is by design (it is what repairs a lost write, and it is what
  will let this batch's MF-2 fix correct already-populated rows), but the document says the opposite.

Neither documented rollback path leaves the app deployable, exactly as the brief states, and this
spec confirms the mechanism:

- Leave `_prisma_migrations` recording the migration as applied after dropping the columns → the next
  `prisma migrate deploy` sees nothing pending, and the new API queries four columns that no longer
  exist.
- `prisma migrate resolve --rolled-back` without dropping the indexes → the next deploy re-runs the
  file, `CREATE INDEX "Session_projectId_requestedAt_idx"` hits the existing name, and because Prisma
  wraps each migration file in a transaction, the whole file aborts — taking the just-re-added
  columns with it. The migration is then unappliable until someone drops the indexes by hand.

**Live sizes (operator-supplied, 2026-08-16):** `SessionEvent` **70,672 rows / 122 MB**, `Session` 99
rows, **six runner processes streaming into `SessionEvent` continuously**.

### 2.4 SF-1 — the validator that validates nothing

`finite` (`packages/db/src/usage.ts:23-24`) is `typeof value === "number" && Number.isFinite(value)`.
Observed against the merged functions:

```
input -7          -> inputTokens -7,          totalTokens -7
input 1.5         -> inputTokens 1.5,         totalTokens 1.5
input 2147483648  -> inputTokens 2147483648,  totalTokens 2147483648
```

All four token columns are `Int?` (PostgreSQL `INTEGER`, max 2147483647). The backfill
(`packages/db/prisma/backfill-session-usage.ts:21-25`) awaits each recompute inside a bare loop with
no per-session `catch`, so the first session whose write throws aborts the scan and every later
session is skipped — permanently, because a re-run sorts by the same `requestedAt` and dies at the
same row.

---

## 3. Users and success

One user: the operator. This batch succeeds when he can run a stated sequence of commands that takes
the production database from "batch 4 migration unapplied, platform on old code" to "fully migrated,
backfilled, platform restarted", without a blocking index build against a live table, and with a
stated sequence that undoes it. Secondary success: the numbers on the sessions page are the real ones
and stay the real ones under concurrency.

---

## 4. Intended behaviour

### 4.1 MF-1 — serialise session usage recomputes

#### 4.1.1 The choice, and why the alternatives lose

The review prescribes one short transaction holding a **transaction-scoped PostgreSQL advisory lock
keyed by session id**, used by every caller. This spec adopts that prescription. The alternatives
were evaluated mechanically:

| option | why not |
|---|---|
| **Cache version column + CAS** | Correct, but costs a fifth column and therefore *more* migration surface in the batch whose other half is trying to make the existing migration deployable. It also needs a retry loop that re-reads the events, so it is strictly more code for the same guarantee. |
| **`SERIALIZABLE` + retry** | Requires wrapping the read-modify-write in a transaction anyway (so it is the advisory-lock work plus more), converts contention into `40001` aborts that every caller must retry, and buys isolation guarantees against writers this function does not have. |
| **Event watermark** (store the max `seq` folded in; skip if the stored watermark is not older) | Serialises correctly *and* needs no lock — but it is **disqualified by this very batch**. A watermark makes the write conditional on the events having changed, so a session whose events are unchanged is never rewritten. MF-2 changes the derived value of **unchanged** events; under a watermark design the backfill would skip every already-populated session and the 545/98 correction could never reach production. The absolute-recompute-on-difference property is load-bearing and must survive. |

The advisory lock keeps the existing design intact (events are the source of truth, columns are a
derived cache, writes are absolute, a differing populated cache is corrected) and adds exactly one
guarantee: at most one recompute per session at a time.

#### 4.1.2 Required behaviour

`recomputeSessionUsage(db, sessionId)` keeps its signature (`PrismaClient`, session id) and its
return type (`Promise<boolean>` — true iff it wrote), and gains this internal shape:

1. Open an interactive transaction (`db.$transaction(async (tx) => …)`) with an explicit `timeout`.
2. As the **first** statement inside it, take a transaction-scoped advisory lock keyed by the session
   id: `SELECT pg_advisory_xact_lock($classId, $key)`, where
   - `$classId` is a module constant reserved for "session usage recompute" — declare it in
     `packages/db/src/usage.ts` with a comment naming what owns it, so the next advisory-lock user
     picks a different class rather than colliding;
   - `$key` is a deterministic 32-bit hash of `sessionId` computed **in TypeScript** (a small
     exported helper), not by PostgreSQL's undocumented `hashtext()`. Reason: it is testable in a
     unit test, it does not depend on a function whose stability across major versions Postgres does
     not promise, and it keeps both `int4` arguments explicit.
   - Hash collisions between two different session ids are acceptable and must be noted in the
     comment: two unrelated sessions serialise against each other briefly. Correctness is unaffected;
     only concurrency is, and the contended population is tiny (§4.1.4).
3. Also issue `SET LOCAL lock_timeout = '3s'` inside the transaction so a pathological wait fails
   fast rather than pinning a pool connection. (Best-effort: whether `lock_timeout` bounds an
   advisory-lock wait is a PostgreSQL implementation detail; the Prisma `$transaction` `timeout` is
   the backstop that must be set regardless.)
4. Then, all on `tx`: read the `FINAL_OUTPUT` events, read the current columns, compare, write.
5. Return `false` without writing when the session row is gone or when `sameColumns` holds — as today.

The lock is released by commit or rollback; a crashed process releases it when its connection dies.
No lock can leak.

#### 4.1.3 The ingest path must stay non-fatal

`packages/api/src/app.ts:2507-2523` wraps the call in `try/catch` and logs. **That must not change**,
and the reason must survive in the comment: `appendEvents` has no retry, so a throw here would 500
the runner's terminal flush and make the runner record a successful run as failed and delete its
workspace unpushed. With the lock added, the catch also absorbs a lock-wait timeout; the session's
columns are then repaired by the next `FINAL_OUTPUT` or by `db:backfill-session-usage`, which is the
same repair path the existing comment already documents.

#### 4.1.4 What is actually contended

A session has exactly one runner posting events sequentially, so the realistic contenders are
(a) ingest versus the backfill running at the same time — which is now an explicitly supported
operation, and is what the deploy sequence in §4.4 does — and (b) a redelivered/retried event batch
overlapping the original. This is not a hot path; the lock's cost is one round trip per terminal
event.

#### 4.1.5 Consequences the plan step must not discover late

- The unit stub in `packages/api/src/usage.test.ts:42-56` will need `$transaction` (invoke the
  callback with the stub itself) and a raw-execute stub. That is a scaffolding change to an existing
  passing test file, not a new file.
- Correct **both** written statements of the false invariant: the doc comment at
  `packages/db/src/usage.ts:133-136` and `docs/plans/batch-4-sessions-viewer-plan.md:478-482`. The
  replacement text must say what is now true: concurrent callers are serialised by an advisory lock
  because absolute writes from different snapshots do not converge.

### 4.2 MF-2 — Claude token totals from the complete terminal payload

#### 4.2.1 Extraction rules

`extractUsage(payload)` keeps its signature, its totality over `unknown` (any shape yields `{}` and
nothing throws) and its absent-≠-zero semantics. It gains a `modelUsage` branch:

1. Read `payload.modelUsage`. It is usable when it is a non-array object with **at least one** entry
   that is a non-array object carrying at least one of `inputTokens`, `outputTokens`,
   `cacheReadInputTokens`, `cacheCreationInputTokens` as a **valid token count** (§4.3).
2. When usable, derive **exclusively** from those entries — the top-level `usage` object contributes
   nothing, because it is the primary model's entry repeated (§2.2 fact 1):
   - `inputTokens` = Σ entry `inputTokens`
   - `outputTokens` = Σ entry `outputTokens`
   - `cachedInputTokens` = Σ (entry `cacheReadInputTokens` + entry `cacheCreationInputTokens`)
   A field stays **absent** if no entry carried a valid value for it — a `modelUsage` whose entries
   report only input must not yield `outputTokens: 0`. Entries that carry no valid token field at all
   are skipped; a single malformed entry does not discard the others.
3. When `modelUsage` is absent, malformed, empty, or has no usable entry, fall back to today's
   top-level snake_case `usage` behaviour, unchanged — this is what keeps CODEX
   (`usage.{input_tokens,cached_input_tokens,output_tokens}`, no `modelUsage`) and every pre-existing
   payload working.
4. Cost is unchanged: `total_cost_usd`, and only that. Do **not** sum per-model `costUSD`.
5. Field-name discipline: `modelUsage` entries are camelCase, the top-level `usage` object is
   snake_case. These are two different vocabularies in one payload; the implementation must not
   share a key list between the branches.

#### 4.2.2 Required results

For `claude-tool-event.stdout`'s `result` event:

| | value |
|---|---|
| `inputTokens` | **545** |
| `outputTokens` | **98** |
| `cachedInputTokens` | 8768 |
| `totalTokens` | **643** |
| `costUsd` | `0.0491` (Decimal(12,4) of 0.049117) |

For `claude-start-safe-mode.stdout`'s `result` event: 535 / 20 / 2969 / **555** / `0.0304`.

`totalTokens` stays input + output with cache excluded, and stays `null` when both input and output
are absent — §4.6.5 of the batch 4 spec ("never `0`, never an estimate") is unchanged by this batch.

#### 4.2.3 The fixture must stop lying

`packages/api/src/usage.test.ts` must paste the **complete** captured `result` object from
`claude-tool-event.stdout` — `modelUsage`, `server_tool_use`, `cache_creation`, `iterations`,
`inference_geo`, `speed` and all — and assert 545 / 98 / 643 against it. Add the second capture
(`claude-start-safe-mode.stdout`, complete) asserting 535 / 20 / 555. The comment claiming fixtures
are pasted from the samples then becomes true, and stays true only if nothing is trimmed; say so in
the comment. The captures are evidence and must not be edited to suit the code.

#### 4.2.4 Ordering: this blocks the restart, not just the backfill

The retro review frames MF-2 as blocking the backfill. It also blocks the **restart**: the live
ingest path at `app.ts:2519` calls the same extractor, so an API restarted onto batch 4's merged code
begins writing under-counted totals for every finishing Claude session immediately, and those rows
look self-consistent to `sameColumns`, so only a later backfill corrects them. The deploy sequence in
§4.4 therefore restarts onto **fixed** code and never onto `2737113`.

#### 4.2.5 No UI change

The number's *meaning* does not change — "tokens this session used" was always the intent; it was
merely computed from one model. So there is no display change and no copy change. `apps/web` must not
appear in this batch's diff (§6).

### 4.3 SF-1 — reject impossible values; never let one row starve the backfill

#### 4.3.1 Token field validation

Replace the token use of `finite` with a validator that accepts a value only when
`typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647`.
An invalid field is **omitted** (the field stays absent, which already means "this payload said
nothing about it") and a one-line diagnostic is emitted naming the field and the offending value.
Omitting must never throw and must never abort the surrounding extraction: the other fields of the
same payload are still read.

#### 4.3.2 Summed-value validation

Sums can leave the column range even when every input was valid. After summation, each derived column
(`inputTokens`, `outputTokens`, `cachedInputTokens`, `totalTokens`) is validated against the same
`INTEGER` range; a column that fails is written as `null` with a diagnostic, and its siblings keep
their valid values. `totalTokens` is validated after it is computed, so an in-range input and an
in-range output whose sum overflows yields `totalTokens: null` rather than a failed write.

#### 4.3.3 Cost validation

`costUsd` is `Decimal(12, 4)`: a value ≥ 10^8 or a negative one fails at write time and takes the
whole recompute with it. Accept cost only when it is finite, `>= 0` and `< 10^8`; otherwise omit with
a diagnostic. **This extends the review's prescription, which named only the token fields**
(assumption A2) — the mechanism is the same class of failure and the guard costs one comparison.

#### 4.3.4 Backfill resilience

`packages/db/prisma/backfill-session-usage.ts`:

- Each session's recompute is wrapped in its own `try/catch`. A failure records the session id and
  the error message and the scan continues.
- The final line reports `scanned N, updated M, failed K`, and lists the failed session ids (capped
  at the first 20, with a count of the remainder — a corrupt-payload class failure must not print
  70,000 lines).
- The process exits **non-zero** when `K > 0`, so an operator running it as part of the deploy
  sequence cannot mistake a partial scan for a clean one. `updated` and `scanned` must still be
  printed on the failing path.
- Behaviour is otherwise unchanged: it still selects every session with a `FINAL_OUTPUT` event, still
  writes absolutely, and is still safe to re-run.

### 4.4 MF-3b — the split deployment (the operator's blocker)

#### 4.4.1 The shape of the split

Two blocking `CREATE INDEX` statements against a 122 MB table with six continuous writers are the
hazard. An ordinary `CREATE INDEX` takes `SHARE` on the table, which blocks every `INSERT` for the
duration **and** queues every later writer behind its own lock request while it waits for the current
writers to finish. At 70k rows the build itself is likely seconds; the lock queue with six streaming
producers is what makes it unacceptable, and that is the honest reason to split — not build time.
`CREATE INDEX CONCURRENTLY` cannot run inside the transaction Prisma wraps each migration file in,
which is exactly what batch 2.5 documented
([`docs/runbooks/batch-2.5-rollback.md`](../runbooks/batch-2.5-rollback.md) §"Index locking during
`db:migrate`"). Batch 2.5 accepted the blocking build because `Task` was small; batch 4 cannot.

**Both indexes are on pre-existing columns** — `Session(projectId, requestedAt)` and
`SessionEvent(runId, seq)`. Neither touches a column this migration adds. That fact is what makes the
split clean: the indexes can be built **before** the migration runs, out of band, with no ordering
dependency on the `ALTER TABLE` at all.

#### 4.4.2 Required change to the migration file

Edit `20260816165548_batch4_session_usage/migration.sql` so that both index statements read
`CREATE INDEX IF NOT EXISTS`, and add a header comment stating that on a production-sized database
the two indexes are built out of band with `CREATE INDEX CONCURRENTLY` **before** this file is
applied, pointing at `docs/runbooks/batch-4-rollback.md`. The `ALTER TABLE` is unchanged.

This single edit does three things:

1. It makes the file a **no-op for the index half** on a database where the indexes already exist —
   so the operator runs one ordinary `prisma migrate deploy`, Prisma records the migration applied by
   itself, and no `migrate resolve --applied` bookkeeping is needed in the happy path.
2. It keeps the file complete for a **fresh** database (local dev, the `.dbtest` database, any future
   rebuild), where the plain build against an empty table is instantaneous and correct.
3. It defuses the redeploy trap in §2.3: after an exceptional physical rollback that leaves an index
   behind, re-running the file no longer aborts the transaction.

Two consequences that must be written down, not discovered:

- **`IF NOT EXISTS` matches on name only.** An index with the right name and a different definition
  would be silently accepted. `npm run db:drift-check` is what catches that, which is why it is a gate
  in §7 and a step in the runbook.
- **Editing an already-applied migration file changes its checksum.** This is legitimate *only*
  because production has not applied it; the only database that has is the local dev one. On that
  database a later `prisma migrate deploy`/`dev` will report the file as modified after it was
  applied. The runbook must carry the one-time re-record step (delete that migration's row from
  `_prisma_migrations`, then `prisma migrate resolve --applied 20260816165548_batch4_session_usage`),
  or, on a disposable dev database, `prisma migrate reset`. Do not create a second migration folder
  to dodge this: a second folder changes nothing about the checksum of the first, and `migrate deploy`
  applies every pending migration in one go, so a split into two folders would not let the operator
  apply only the column half anyway.

#### 4.4.3 What the operator types, in order

The runbook owns the authoritative copy; this is the sequence it must state, and the sequence the
rehearsal in §7.3 must prove. Substitute the real database name/URL; **never write a token or a
password into any artifact**.

```bash
# 0. Pre-flight, on the checkout of this batch's merged code.
npm run db:validate
psql "$DATABASE_URL" -c '\d+ "Session"'          # confirm the four columns are absent
psql "$DATABASE_URL" -c "SELECT migration_name, finished_at, rolled_back_at
                           FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;"
                                                  # confirm 20260816165548 is NOT recorded
psql "$DATABASE_URL" -c "SELECT relname, n_live_tup FROM pg_stat_user_tables
                           WHERE relname IN ('Session','SessionEvent');"

# 1. Build both indexes out of band. Autocommit — one -c per statement, and never
#    psql -1/--single-transaction: CONCURRENTLY cannot run inside a transaction.
psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Session_projectId_requestedAt_idx" ON "Session"("projectId", "requestedAt");'
psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "SessionEvent_runId_seq_idx" ON "SessionEvent"("runId", "seq");'

# 2. Prove both are valid. A CONCURRENTLY build that fails leaves an INVALID index
#    that is never used and never repaired by itself.
psql "$DATABASE_URL" -c "SELECT c.relname, i.indisvalid, i.indisready FROM pg_index i
                           JOIN pg_class c ON c.oid = i.indexrelid
                          WHERE c.relname IN ('Session_projectId_requestedAt_idx','SessionEvent_runId_seq_idx');"
#    Any row with indisvalid = false:
#      DROP INDEX CONCURRENTLY "<name>";  then repeat step 1 for that index when the table is quieter.

# 3. Apply the migration through Prisma with a bounded lock wait. ADD COLUMN on a
#    nullable column with no default is metadata-only, but it still needs
#    ACCESS EXCLUSIVE, which queues behind the six writers — bound the wait rather
#    than discover it (batch 2.5's convention).
DATABASE_URL="${DATABASE_URL}?options=-c%20lock_timeout%3D3s" \
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
#    On 55P03 (lock_not_available): retry when the runners are idle. Nothing was applied.
#    If the URL-options form is unavailable in this Prisma version, the documented
#    fallback is: apply the ALTER TABLE by hand in psql under SET lock_timeout, then
#    `prisma migrate resolve --applied 20260816165548_batch4_session_usage`.

# 4. Prove the database matches the datamodel.
npm run db:generate
npm run db:drift-check          # must exit 0

# 5. Restart the API onto THIS batch's code (operator action; this batch never does it).
#    Not onto 2737113 — see §4.2.4.

# 6. Backfill, after the restart, so that any session that finished between step 3
#    and step 5 (ingested by the old API, which writes none of these columns) is also
#    repaired. Concurrent ingest during the backfill is now safe: that is MF-1's lock.
npm run db:backfill-session-usage    # exits non-zero if any session failed (§4.3.4)
npm run db:backfill-session-usage    # second run: `updated 0`
```

Step 6 running twice, with the second reporting `updated 0`, is the acceptance evidence for
idempotence and replaces the batch 4 spec's §9 item 9 wording.

#### 4.4.4 `db:drift-check` must still pass

`packages/db/scripts/check-drift.mjs` runs `prisma migrate diff --from-url <DATABASE_URL>
--to-schema-datamodel prisma/schema.prisma --exit-code`. It compares the **live schema** against the
datamodel, not the migration history against anything. So indexes created out of band satisfy it
provided their names match Prisma's convention exactly — `Session_projectId_requestedAt_idx` and
`SessionEvent_runId_seq_idx`, the names the merged migration file already uses. The names in the
runbook, the migration file and `schema.prisma`'s `@@index` declarations must be identical; the plan
step should treat any divergence as a build break.

### 4.5 MF-3 — the rollback runbook

Deliver `docs/runbooks/batch-4-rollback.md`, versioned (a header block carrying: version, the commit
it was written against, the date it was last rehearsed, and against what). Required contents, in this
order:

1. **Deploy order** — §4.4.3, verbatim, as the authoritative copy.
2. **Preferred rollback: revert the code, leave the migration applied.** Stated first and stated as
   the default. Mechanism: four nullable columns no old code reads are inert, and the two indexes are
   on pre-existing columns — old code either benefits from them or ignores them. Nothing is lost;
   nothing needs undoing; a later re-deploy needs no migration work.
3. **The one code-rollback ordering rule this batch inherits**, carried over from
   `docs/specs/batch-4-sessions-viewer.md:652-658`: `GET /runs/:runId/events` returns an envelope in
   batch 4. Revert API and web together, or revert the API alone (the envelope-aware client tolerates
   the old array shape) — **never revert the web app alone while keeping the new API**.
4. **Exceptional physical rollback**, only for the case where the columns genuinely must go. In this
   order, with bounded lock waits:

   ```sql
   -- Indexes first, outside any transaction, so a failure here leaves the columns intact.
   SET lock_timeout = '3s';
   DROP INDEX CONCURRENTLY IF EXISTS "SessionEvent_runId_seq_idx";
   DROP INDEX CONCURRENTLY IF EXISTS "Session_projectId_requestedAt_idx";

   -- Then the columns, in one bounded transaction.
   BEGIN;
     SET LOCAL lock_timeout = '3s';
     ALTER TABLE "Session"
       DROP COLUMN "totalTokens", DROP COLUMN "cachedInputTokens",
       DROP COLUMN "outputTokens", DROP COLUMN "inputTokens";
   COMMIT;
   ```

   State explicitly that `Session.costUsd` **predates this migration** and must not be dropped — it
   is in the schema but not in `20260816165548`'s `ALTER TABLE`, and dropping it destroys data no
   backfill in this batch restores.
5. **Reconcile `_prisma_migrations`:**
   `npx prisma migrate resolve --rolled-back 20260816165548_batch4_session_usage`, then the
   verification `SELECT` showing `rolled_back_at` set. State why this is mandatory rather than
   cosmetic: without it the next `migrate deploy` skips a migration whose objects no longer exist.
6. **Verify drift after the rollback** — with the code checkout that predates the migration (whose
   `schema.prisma` declares neither the columns nor the two indexes), `npm run db:drift-check` must
   exit 0. State the pairing rule: a physical rollback is only complete when the checked-out
   datamodel and the live schema agree, so the schema rollback and the code rollback are one step,
   not two.
7. **Prove the forward redeploy**: re-checkout the batch 4 code, re-run §4.4.3 steps 1-4, and confirm
   `migrate deploy` applies the (re-recorded) migration cleanly — which now holds even if an index
   survived the rollback, thanks to §4.4.2's `IF NOT EXISTS`.
8. **What the backfill actually is** (this is the correction MF-3 demands): "an absolute recompute
   from `SessionEvent` of every session that has a `FINAL_OUTPUT` event; it overwrites any populated
   cache that differs from the recomputed value, and writes nothing when they match." Not
   "write-only-to-null".
9. **The dev-database checksum note** from §4.4.2.

### 4.6 Documentation corrections required by this batch

| file | what to correct |
|---|---|
| `packages/db/src/usage.ts:133-136` | the "two concurrent callers would still converge" invariant → the advisory-lock invariant (§4.1) |
| `docs/plans/batch-4-sessions-viewer-plan.md:478-482` | the same claim, plus "a performance note rather than a correctness requirement" |
| `docs/specs/batch-4-sessions-viewer.md:659-665` | §10 item 4 gains the two indexes and points at the new runbook; item 5's "write-only-to-null" → §4.5 item 8's wording |
| `docs/specs/batch-4-sessions-viewer.md:634-635` | §9 item 9's backfill expectation, aligned with §4.4.3 step 6 |
| `packages/api/src/usage.test.ts:6-7` | the "fixtures are pasted from samples" comment, once it is true (§4.2.3) |

Amend the batch 4 spec in place with a dated note that this batch superseded those paragraphs; do not
silently rewrite an approved document.

---

## 5. Data and interface changes

**Database schema: none.** No new column, no new index, no new migration folder. The only migration
change is the `IF NOT EXISTS` edit plus a comment in the existing file (§4.4.2). `schema.prisma` is
untouched.

**Exported TypeScript surface** (`packages/db/src/usage.ts`, re-exported by `packages/db/src/index.ts`):

| symbol | change |
|---|---|
| `extractUsage(payload: unknown): SessionUsage` | unchanged signature; `modelUsage` branch added (§4.2), stricter validation (§4.3) |
| `sumUsage(usages): SessionUsage` | unchanged |
| `deriveUsageColumns(usage): DerivedUsage` | unchanged signature; range validation of summed values (§4.3.2) |
| `recomputeSessionUsage(db, sessionId): Promise<boolean>` | unchanged signature and semantics; body becomes one locked transaction (§4.1.2) |
| *new* — the session-id hash helper and the advisory-lock class constant | exported far enough to be unit-tested |
| `SessionUsage` | unchanged |

**HTTP API: no change.** No route, request or response shape changes anywhere in this batch.

**CLI/scripts:** `npm run db:backfill-session-usage` gains a failure summary and a non-zero exit
(§4.3.4). Its name, arguments and idempotence are unchanged.

**Files expected in the diff.** `packages/db/src/usage.ts`,
`packages/db/prisma/backfill-session-usage.ts`,
`packages/db/prisma/migrations/20260816165548_batch4_session_usage/migration.sql`,
`packages/api/src/usage.test.ts`, a new `packages/api/src/usage.dbtest.ts`,
`docs/runbooks/batch-4-rollback.md`, plus the documentation corrections in §4.6. The comment block at
`packages/api/src/app.ts:2507-2523` may be updated; **no behavioural change to `app.ts` is expected**
(assumption A3). `apps/web` must not appear.

---

## 6. Explicitly out of scope

- **Any change to the batch 4 UI.** Its rendering was reviewed and merged. No number in this batch
  changes meaning (§4.2.5), so nothing in `apps/web` changes.
- **New metrics, a Costs page, PI/CODEX usage collection.** PI's per-message usage shape and the
  PI/CODEX file-path extraction stay docketed in `docs/BACKLOG-V2.md` under batch 4.
- **Retrofitting locking to unrelated write paths.** Batch 2.5 already unified task status writes
  under one row lock; that is not re-litigated, and the advisory-lock class constant exists precisely
  so the two schemes cannot collide.
- **Running the production migration or restarting the platform.** Deliberately held for the
  operator. This chain writes down exactly what those actions are and makes them safe; it never
  performs them, and never touches launchd or the runner.
- **Summing per-model `costUSD`.** `total_cost_usd` is already the all-model figure (§2.2 fact 2).
- **Per-model storage.** `modelUsage` is summed into the existing four columns; storing a per-model
  breakdown is a schema change and a UI change, and is neither requested nor in this batch's budget.
  If it is ever wanted, this batch's extractor is the natural place to hang it.
- **Backfilling PI or CODEX sessions differently.** The fallback branch (§4.2.1 rule 3) preserves
  today's behaviour for them exactly.

---

## 7. How a reviewer verifies this

### 7.1 The four gates

All four green, on a rebase onto the latest `origin/master` (§8):

```bash
npm run build
npm test                 # unit suites across all workspaces
npm run test:db          # the MF-1 regression test lives here
npm run typecheck
npm run db:drift-check   # exit 0
```

`npm test` does not run `*.dbtest.ts`; the acceptance run is not complete without `npm run test:db`.

### 7.2 Behavioural checks

1. **MF-1 regression test** — `packages/api/src/usage.dbtest.ts`, against a real PostgreSQL database
   (the `.dbtest` harness in `packages/api/src/testdb.ts`), reproducing the exact interleaving:
   - seed a session with one `FINAL_OUTPUT` event carrying `input_tokens: 10`;
   - start recompute **A** through a client wrapper that stalls it after its event read and before
     its write, and wait for the read to have been issued;
   - insert a second `FINAL_OUTPUT` event carrying `input_tokens: 20`;
   - start recompute **B** normally, and wait until B either finishes or is observably blocked
     (poll `pg_locks` for a non-granted advisory lock, bounded, so the test is deterministic in both
     branches);
   - release A, await both, read the stored columns.

   **Expected: `inputTokens = 30`.** Without the lock the same test observes
   `{"expectedInputTokens":30,"storedInputTokens":10,"eventReads":2}` — A's stale absolute write
   lands last and `sameColumns` then makes it permanent. The reviewer verifies the test earns its
   keep by deleting the `pg_advisory_xact_lock` statement and watching this test, and only this test,
   fail. That deletion-check must be written into the test file's header comment so the next reader
   can repeat it.
2. **MF-2 numbers** — `npm test` asserts 545 / 98 / 643 for `claude-tool-event.stdout` and
   535 / 20 / 555 for `claude-start-safe-mode.stdout`, against complete pasted captures. The reviewer
   diffs the fixture against the sample file and confirms nothing was trimmed:
   the fixture's `modelUsage`, `iterations`, `cache_creation`, `server_tool_use`, `service_tier`,
   `inference_geo` and `speed` keys must all be present.
3. **CODEX and PI unchanged** — the existing assertions in `usage.test.ts` (CODEX 40764/253/35072
   with no cost, PI `{}`, totality over `unknown`, partial-stays-partial, cost-only session, resume
   accumulation, lost-write repair, missing session row) all still pass **unmodified** apart from the
   stub scaffolding of §4.1.5. Any of them needing a changed expectation is a defect in the fix.
4. **SF-1 rejection** — unit assertions that `-7`, `1.5`, `2147483648`, `NaN`, `Infinity`, `"5"`,
   `null` and `true` each leave the corresponding field **absent** (not zero, not written), that a
   diagnostic is emitted, and that a valid sibling field in the same payload still comes through.
   Plus a summed-overflow case: two events of `input_tokens: 2000000000` each yield
   `inputTokens: null` rather than a write of 4×10⁹.
5. **Backfill resilience** — a `.dbtest` seeding three sessions where the middle one's stored payload
   forces a failure: the scan reports `scanned 3, updated 2, failed 1`, names the failed session, and
   the process exits non-zero. Removing the bad session and re-running exits zero.
6. **Runbook rehearsal** — §7.3.

### 7.3 Rehearsal, and the rule about where

The runbook's deploy and rollback sequences must be rehearsed end to end **before** the operator runs
them, on a **scratch database built from migrations with fixture rows only**. The harness for that
already exists: `packages/api/src/testdb.ts` drops and re-applies a dedicated non-`public` schema
named by `TEST_DATABASE_URL` using `prisma migrate deploy`, and refuses to run against `public`;
`npm run db:fixture -w @agentos/db` seeds rows. **Never rehearse against a dump or clone of the live
database**, and never with a second API pointed at it: a clone still lists the live runs as `RUNNING`
with runtime handles the second control plane does not own, whose reconciler then classifies them as
orphans and deletes their workspaces. This is a hard rule, learned by destroying a workspace on
2026-08-16.

The rehearsal proves, in order: indexes build concurrently and report `indisvalid = true`;
`migrate deploy` applies the columns and records the migration; `db:drift-check` exits 0; the backfill
runs twice with the second reporting `updated 0`; then the rollback drops indexes and columns,
`migrate resolve --rolled-back` records it, drift-check against the pre-batch-4 datamodel exits 0; and
a forward redeploy applies cleanly. Record the date and the result in the runbook's version header.

### 7.4 What the reviewer should specifically try to break

- Pass a payload with `modelUsage` present but every entry empty (`{"m": {}}`) — must fall back to
  top-level `usage`, not report zeros.
- Pass a payload with **both** `usage` and `modelUsage` where the model entry is the only source of
  output tokens — confirm no double count of the primary model.
- Run the backfill while a session is ingesting a `FINAL_OUTPUT` (the §4.4.3 step 6 situation) and
  confirm the stored total equals the recompute of all events, whichever writer commits last.
- Re-run `migrate deploy` after the indexes exist — must be a clean no-op, not an abort.

---

## 8. Constraints for the chain

- **Keep the diff surgical.** Two other chains are in flight. Batch 1 (Settings + i18n) is mostly
  `apps/web` but may touch `packages/api/src/app.ts`; the platform repair batch touches
  `packages/db/src/workflow.ts` and `packages/runner/src/delivery.ts`. Confine this batch to the
  files in §5. At the fixes step, **rebase onto the latest `origin/master` before the final push and
  re-run every gate in §7.1 after rebasing** — in particular `db:drift-check`, which is the one that
  can go red from someone else's migration.
- One chain, one branch, one PR. Do not merge anything.
- Never write `OPERATOR_TOKEN` (or any credential) into an artifact, a commit message or a task
  output. The runbook uses `"$DATABASE_URL"` and never inlines a connection string.
- Implementation steps set `maxDurationMin: 240`. Plan steps (②④) use `claude-opus-5:xhigh`;
  implementation and review steps use `:high`. Task-creation field is `name`, not `title`.

---

## 9. Assumptions

Places where the request or its sources were ambiguous, the simplest reading was taken, and the
choice is written down. Ordered by how much a different answer would cost.

- **A1 — the retro review file is unavailable, and the brief is its faithful transcript.** The review
  at `docs/reviews/2026-08-16-batch-4-sol-retro-review.md` is not in this repo or on `origin/master`.
  Every finding was re-verified against the code and the samples (§2) and each one held, so the spec
  does not depend on it. **If the review contains a fourth finding or a caveat the brief did not
  carry, this spec has missed it.** The cheapest fix is to commit the review file and have ② re-read
  it. *Open question for Leo — recorded here and in the activity log rather than blocking.*
- **A2 — cost gets the same range guard as tokens.** SF-1 names only token fields; a `Decimal(12,4)`
  overflow or a negative cost fails the write identically, so §4.3.3 guards it too. If Leo wants the
  review's letter rather than its mechanism, drop §4.3.3 — nothing else depends on it.
- **A3 — `app.ts` gets no behavioural change.** The lock lives inside `recomputeSessionUsage`, so the
  ingest call site keeps its `try/catch` and its comment (the comment may be updated to name the new
  failure mode). The alternative — hoisting the transaction into the route — would put the ingest's
  `createMany` and the recompute in one transaction, lengthening a hot-path transaction for no
  correctness gain, since the recompute is already self-healing.
- **A4 — the migration file is edited rather than split into two folders.** Justified in §4.4.2: a
  second folder does not avoid the checksum change, and `migrate deploy` applies all pending
  migrations at once, so it would not give the operator per-half control either. The cost is the
  one-time dev-database re-record step.
- **A5 — the advisory lock key is hashed in TypeScript, not by `hashtext()`.** Testable, and
  independent of an undocumented PostgreSQL internal. The cost is a helper function and the
  documented collision note.
- **A6 — the MF-1 test lives in `packages/api/src/usage.dbtest.ts`.** It needs a real PostgreSQL for
  advisory locks, and `packages/api` is where the `.dbtest` harness already lives
  (`testdb.ts`, `--test-concurrency=1`). Putting it in `packages/db` would mean standing up a second
  harness.
- **A7 — the fallback branch keeps today's exact behaviour for every non-`modelUsage` payload.** No
  attempt is made to guess at other providers' multi-model shapes. If PI or CODEX later grows a
  per-model object, that is a new finding, not a gap in this one.
- **A8 — a `CREATE INDEX CONCURRENTLY` that fails is retried by hand, not automatically.** The
  runbook tells the operator to detect `indisvalid = false`, drop concurrently and retry when the
  table is quieter. Automating the retry is out of proportion for a two-index, once-ever operation.

---

## 10. Definition of done for this batch

1. Every gate in §7.1 green after a rebase onto the latest `origin/master`.
2. The MF-1 interleaving exists as a test that fails with the lock removed (§7.2 item 1).
3. `claude-tool-event.stdout` yields 545 / 98 / 643 asserted against the untrimmed captured object,
   and `claude-start-safe-mode.stdout` yields 535 / 20 / 555 (§7.2 item 2).
4. Impossible token and cost values are omitted with a diagnostic, and the backfill completes past a
   failing session, summarises the failures and exits non-zero (§7.2 items 4-5).
5. `docs/runbooks/batch-4-rollback.md` exists, versioned, carrying the §4.4.3 deploy sequence and the
   §4.5 rollback sequence, rehearsed on a scratch database per §7.3.
6. The migration file and the runbook agree about which half does what (§4.4.2).
7. Every false statement listed in §4.6 is corrected.
8. Nothing in this batch applied a production migration or restarted the platform.
