# Batch 4 fixes — usage correctness and migration safety

Status: current. The behavior-changing implementation is `792570da5c8f6a4fc7af75cd65b395dead53033b`; the reviewed documentation and evidence are its descendants.

This page records the landed session-usage and deployment behavior. The
session-reading surface remains in [`batch-4-sessions-viewer.md`](batch-4-sessions-viewer.md).
The operator procedure is [`batch-4-rollback.md`](../runbooks/batch-4-rollback.md).

## What changed

The session usage columns are a derived cache of `FINAL_OUTPUT` events. The
implementation in [`packages/db/src/usage.ts`](../../packages/db/src/usage.ts)
now derives Claude totals from the complete per-model terminal payload,
validates values before they can reach PostgreSQL, and serializes every
recompute for a session. The backfill uses the same implementation, reports
partial failure, and has a real non-zero exit when it cannot repair every row.

The fix does not add an HTTP route, change a response shape, change the runner,
or change `apps/web`. It does not add a column, a new migration directory, or a
new Prisma model. The existing batch-4 migration still owns the four nullable
token columns and the two supporting indexes; its index statements are now
safe when the indexes were built ahead of the migration or survived a rollback.

## Usage extraction

`extractUsage(payload)` is the single shape-driven entry point. It remains total
over `unknown`: an unrelated payload yields no usage, and an invalid field is
omitted rather than throwing. Diagnostics are bounded and safe even for values
such as `bigint` or cyclic objects, so logging a bad value cannot fail event
ingest.

### Claude's complete terminal payload

Claude `result` events can carry `modelUsage`, whose entries use camelCase
fields. When one or more entries contains a valid token field, the extractor
sums all usable entries exclusively:

- `inputTokens` sums `inputTokens`;
- `outputTokens` sums `outputTokens`;
- `cachedInputTokens` sums `cacheReadInputTokens` and
  `cacheCreationInputTokens`.

The top-level snake_case `usage` object is not added to that result. It repeats
the primary model, so adding it would double-count. A malformed model entry is
skipped while valid siblings survive, and a field with no valid value remains
absent rather than becoming zero.

If `modelUsage` is missing, empty, malformed, or has no usable token entry, the
extractor falls back to the existing top-level `usage` mapping. This preserves
the CODEX path (`input_tokens`, `cached_input_tokens`, `output_tokens`) and
other existing payloads. PI usage remains deliberately unharvested. Cost is
read only from top-level `total_cost_usd`; per-model `costUSD` is not summed
because the top-level value already represents the complete cost.

The complete captured fixtures now produce these derived values:

| capture | input | output | cached input | total | cost at 4 dp |
|---|---:|---:|---:|---:|---:|
| `claude-tool-event.stdout` | 545 | 98 | 8768 | 643 | 0.0491 |
| `claude-start-safe-mode.stdout` | 535 | 20 | 2969 | 555 | 0.0304 |

`totalTokens` is input plus output only. Cache is excluded, and when both input
and output are absent the column remains `null`, never an inferred zero.

### Storage guards and precision

Token fields are accepted only as non-negative integer values in PostgreSQL's
`INTEGER` range (`0..2147483647`). An invalid field is omitted with a diagnostic
and does not discard valid fields from the same payload. After aggregation,
each token column is checked again. This means an overflowing input or total
becomes `null` while a valid output sibling can still be written.

Costs are represented as `Prisma.Decimal` as soon as they are accepted. A cost
must be finite, non-negative, and remain below `100000000` after rounding to
the `Decimal(12,4)` storage scale. Invalid event costs are omitted before the
sum, so one absurd event cannot erase a valid cost from another event. The
aggregate is checked again for a sum of individually valid events, then rounded
once at the column boundary. This avoids binary-JavaScript half-unit errors.

The derived values are absolute values from the event set. Missing usage stays
`null`; recomputing does not add to the current cache and does not treat a
nullable column as an accumulator.

## Recompute concurrency and failure behavior

`recomputeSessionUsage(db, sessionId)` still returns `Promise<boolean>` and
writes only when the absolute derived columns differ. All work now occurs in
one interactive `ReadCommitted` transaction in this order:

1. `SET LOCAL lock_timeout = '3s'` is installed before any wait.
2. The transaction takes `pg_advisory_xact_lock` with class `20260816` and a
   signed 32-bit FNV-1a hash of the session id. The hash helper is in
   `usage.ts`, rather than relying on PostgreSQL's undocumented `hashtext()`.
3. The transaction reads all `FINAL_OUTPUT` events, reads the current session
   columns, compares them, and writes through the transaction client.

The advisory lock is transaction-scoped and releases on commit, rollback, or
connection death. Different session ids can collide in the 32-bit hash; that
only serializes those two short recomputes and does not change correctness.
The raw lock query casts the PostgreSQL `void` return to text because Prisma
6.19 cannot deserialize a bare void result. Removing that cast makes every
recompute fail before it reads an event.

A lock-wait `55P03` or equivalent timed-out Prisma transaction is rolled back
and retried internally without a fixed retry count. Each attempt remains
bounded by PostgreSQL and Prisma, and no application resource is held between
attempts. The public invocation stays pending until it has folded the durable
event; returning cleanly after a fixed number of failed attempts could leave an
older absolute snapshot permanently in the cache.

Other database errors still reach the existing ingest `try/catch`. Ingest keeps
that non-fatal boundary because failing the terminal flush would make a
successful runner run look failed and could lose its workspace. A non-lock
failure can be repaired by a later terminal event or by the backfill; lock
contention is handled inside the recompute instead of being acknowledged as a
completed write.

## Backfill contract

`backfillSessionUsage` is exported from `usage.ts`; the CLI at
[`packages/db/prisma/backfill-session-usage.ts`](../../packages/db/prisma/backfill-session-usage.ts)
is only a client/disconnect wrapper around it. The scan:

- selects every session with at least one `FINAL_OUTPUT` event, including rows
  whose cache is already populated or cost-only;
- pages by ascending unique session id in batches of 100;
- recomputes each session through the same advisory-lock path;
- catches failures per session and continues the scan;
- retains diagnostics for at most 20 failed session ids while counting all
  failures.

The CLI prints `scanned N, updated M, failed K` on both success and partial
failure, prints the capped diagnostics, and returns exit code 1 when `K > 0`.
It returns 0 only when the scan has no failures. The operation is an absolute
recompute: it overwrites a populated cache when the event-derived value
differs, and does nothing when it already matches. Therefore a clean second
run reports `updated 0`; it is not a write-only-to-null migration.

## Migration and deployment boundary

The existing migration
[`20260816165548_batch4_session_usage`](../../packages/db/prisma/migrations/20260816165548_batch4_session_usage/migration.sql)
adds the four nullable token columns and declares:

- `Session_projectId_requestedAt_idx` on pre-existing `Session(projectId,
  requestedAt)`;
- `SessionEvent_runId_seq_idx` on pre-existing `SessionEvent(runId, seq)`.

Both index statements use `CREATE INDEX IF NOT EXISTS`. This makes a fresh
scratch schema complete, makes a production migration a no-op for indexes
that were built ahead of time, and allows forward redeploy when an index
survived an exceptional rollback. The clause matches by index name only; it
does not prove the definition is correct. `npm run db:drift-check` compares the
live schema with the datamodel and is the check that catches a wrong definition.

On a production-sized database the indexes are built out of band with separate
`CREATE INDEX CONCURRENTLY` calls before the migration. Prisma wraps a
migration in a transaction, so `CONCURRENTLY` cannot be placed inside the
migration. Each concurrent operation gets its own `psql -c` and bounded
`PGOPTIONS`; combining it with `SET` or `--single-transaction` makes PostgreSQL
reject it and can leave an invalid index behind.

The runbook's pre-flight records the complete pending migration set. `migrate
deploy` applies every pending migration in timestamp order, not just batch 4;
if batch 2.5 is still pending, its index and `db:backfill-task-source`
obligations are part of the same operator window. Prisma receives a URL built
with `URL`/`URLSearchParams.set` so an existing `?schema=...` query is preserved
and the lock option is actually installed. `psql` receives a separate URL with
Prisma's `schema` parameter removed and a validated `search_path`, because
libpq does not understand that parameter.

The API is restarted only onto the fixed implementation (`792570d` or a tested
descendant), never the merged-but-unfixed code. After deployment, the session
backfill runs twice; the second pass must report `updated 0` and exit 0. No
production migration, restart, launchd operation, or runner change is part of
this batch itself.

## Rollback and recovery rules

The default rollback is to revert code while leaving the migration applied.
The four nullable columns are inert to old code, and the indexes use columns
that already existed. The inherited event endpoint rule still applies: revert
API and web together, or API alone; never revert the web client alone while
keeping the envelope-returning API.

Physical rollback is exceptional. Drop each index separately with
`DROP INDEX CONCURRENTLY`, then drop only the four token columns in one bounded
transaction. `Session.costUsd` predates this migration and must not be dropped;
it contains data that this batch's event recompute cannot restore once removed.

Migration history depends on how the apply stopped:

- A failed apply (`P3018` backed by PostgreSQL `55P03`) leaves no batch-4
  objects but does leave a failed history row. Prove all six objects are absent,
  run `migrate resolve --rolled-back` with the explicit schema and target, verify
  `rolled_back_at`, then retry. A blind retry stops at `P3009`.
- A successfully applied migration that was later physically undone is not a
  failed migration; `--rolled-back` returns `P3012`. Delete only the batch-4
  row from `_prisma_migrations`, verify zero rows, and then redeploy.

After a physical rollback, the checked-out datamodel must remove only batch 4
while retaining every other applied migration. Drift against a checkout that
also predates batch 2.5 is expected to report unrelated objects. The local dev
database has the edited migration checksum; repair that one target explicitly
with the runbook's schema-qualified `migrate resolve --applied` sequence, or
reset a disposable dev database. The test schema is rebuilt from migrations
and is unaffected by that checksum note.

## Verification and boundaries

The unit coverage is in [`packages/api/src/usage.test.ts`](../../packages/api/src/usage.test.ts).
It uses complete captures, tests model-source exclusivity and fallback behavior,
range/overflow handling, Decimal precision, safe diagnostics, absent-vs-zero
semantics, and the valid-sibling write path. Real PostgreSQL coverage is in
[`packages/api/src/usage.dbtest.ts`](../../packages/api/src/usage.dbtest.ts):
it proves the Prisma lock return-type cast, the stale-writer interleaving, lock
visibility/timeout behavior, backfill continuation and exit reporting, and
spawning the real CLI. The lock deletion mutation makes the stale-writer and
contended-recompute tests fail.

The rehearsal is a gate and uses only a scratch schema built from committed
migrations with fixture rows. It must never use a dump or clone of live data or
point a second control plane at one. The reason is operational, not merely
test hygiene: cloned rows can still say `RUNNING` with runtime handles owned by
the live control plane, so a second reconciler can classify live workspaces as
orphans and delete them.

## Deliberate and deferred decisions

- Keep the existing four-column cache and absolute recompute. A per-model
  schema, watermark column, dirty queue, or UI breakdown would change the data
  contract and is not part of this batch.
- Use the advisory lock plus unbounded bounded-attempt retry. A fixed retry
  count would retain a stale-cache window; a watermark would skip unchanged
  events and prevent the corrected Claude extractor from rewriting populated
  rows.
- Preserve the CODEX and PI fallback boundaries. PI's per-message usage and
  cost are deferred because duplicate adapter emissions need identity-aware
  aggregation; CODEX reasoning tokens remain excluded from output tokens.
- Keep the existing ingest catch and runner behavior. Usage is a repairable
  derived cache, and terminal event delivery must not be made failure-prone by
  this fix.
- Keep UI and HTTP behavior unchanged. The visible number changes only because
  the stored value becomes correct after the fixed API/backfill is deployed;
  the viewer's rendering contract is documented on the sessions page.

When changing usage semantics, start with `usage.ts`, then update both unit and
real-database tests and the operator runbook. Do not change the extractor,
backfill, and deployment procedure independently: they are deliberately one
source-of-truth path.
