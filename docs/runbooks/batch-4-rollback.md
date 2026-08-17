# Runbook — batch 4 FIXES: deploy and rollback of `20260816165548_batch4_session_usage`

| | |
|---|---|
| **Version** | 1.1 |
| **Written against** | usage implementation `792570da5c8f6a4fc7af75cd65b395dead53033b` (or a tested descendant), on top of `20260816165548_batch4_session_usage` |
| **Last rehearsed** | **2026-08-16**, end to end, deploy **and** rollback **and** forward redeploy |
| **Rehearsed against** | scratch PostgreSQL databases created empty and built **from the committed migrations**: the original `agentos_rehearsal_b4` with five fixture sessions, then `agentos_rehearsal_b4_reviewfix` for the v1.1 failure/recovery sequence. Both were dropped afterwards. **Never a dump or clone of live**, and no second control plane was started. See §9. |
| **Rehearsal result** | Pass. v1.1 re-proved bare/query URL targeting, `SHOW lock_timeout = 3s`, a barrier-confirmed `55P03`/`P3018` failed row followed by `resolve --rolled-back`, successful physical rollback with zero-row history verification, forward redeploy, drift, and two zero-failure backfills. Corrections are summarized in §8; spec and plan carry the same sequence. |

This document extends `docs/runbooks/batch-2.5-rollback.md` §"Index locking during
`db:migrate`" rather than replacing it. Batch 2.5 accepted a blocking index build
because `Task` was small. Batch 4 cannot: `SessionEvent` is ~70 000 rows / 122 MB
with six runner processes streaming into it, and an ordinary `CREATE INDEX` takes
`SHARE` on the table — which blocks every `INSERT` for the build **and** queues
every later writer behind its own lock request. The build itself is seconds; the
lock queue is what is unacceptable.

**Never inline a credential.** Every command below uses `"$DATABASE_URL"`. No
connection string, no password and no `OPERATOR_TOKEN` belongs in this file, in a
commit message, or in a task output.

---

## 1. Deploy order

Run these in order, on a checkout of this batch's code.

### 1.0 Pre-flight

Prisma accepts the repository's `?schema=...` URL parameter; libpq/psql does
not. Derive a separate psql URL and a validated search path without ever
printing the credential-bearing URL:

```bash
DB_SCHEMA="$(DATABASE_URL="$DATABASE_URL" node -e '
  const u = new URL(process.env.DATABASE_URL);
  const schema = u.searchParams.get("schema") || "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("schema is not a simple PostgreSQL identifier");
  process.stdout.write(schema);')"
PSQL_URL="$(DATABASE_URL="$DATABASE_URL" node -e '
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.delete("schema");
  process.stdout.write(u.toString());')"

npm run db:validate
DATABASE_URL="$DATABASE_URL" npx prisma migrate status --schema packages/db/prisma/schema.prisma
PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c '\d+ "Session"'
                                                  # the four token columns must be ABSENT
PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c "SELECT migration_name, finished_at, rolled_back_at
                           FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;"
                                                  # 20260816165548 must NOT be recorded
PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c "SELECT relname, n_live_tup FROM pg_stat_user_tables
                           WHERE relname IN ('Session','SessionEvent');"
```

`Session.costUsd` **will** already be there. It predates this migration — see §4.

Record the complete pending-migration set printed by `migrate status`. If
`20260816180000_task_status_backlog` or `20260816180100_tasks_visibility` is
pending, this is a combined batch-4/batch-2.5 window: read and execute
`docs/runbooks/batch-2.5-rollback.md` too, including its Task-index lock handling
and `npm run db:backfill-task-source` before restart. `migrate deploy` always
applies every pending migration in timestamp order; it cannot be described as a
single-migration operation unless history proves these later two are applied.

If the host has no `psql`, the database runs in docker-compose and
`docker exec -e PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" -i
agentos-postgres-1 psql -U agentos -d agentos …` is equivalent. Do not omit the
validated search path: the fallback must target the same schema as the URL, not
silently operate on `public`. That is how the rehearsal was run.

### 1.1 Build both indexes out of band

Both indexes are on **pre-existing** columns — `Session(projectId, requestedAt)`
and `SessionEvent(runId, seq)`. Neither touches a column this migration adds, so
they can be built before it with no ordering dependency at all. That is the fact
that makes this split legal.

```bash
PGOPTIONS="-c lock_timeout=3s -c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Session_projectId_requestedAt_idx" ON "Session"("projectId", "requestedAt");'
PGOPTIONS="-c lock_timeout=3s -c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "SessionEvent_runId_seq_idx" ON "SessionEvent"("runId", "seq");'
```

**One statement per `psql -c`. Never `psql -1` / `--single-transaction`, and never
put anything else — not even a `SET` — in the same `-c`.** psql wraps multiple
statements passed to one `-c` in an implicit transaction block, and
`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. Rehearsed: the
bundled form fails, and it fails *quietly enough to miss* — psql prints `ERROR`
and carries on to the next `-c`, leaving the index unbuilt.

`PGOPTIONS` works here because psql is libpq. It does **not** work for step 1.3:
Prisma connects with its own Rust driver and ignores libpq's environment.

### 1.2 Prove both indexes are valid

A `CONCURRENTLY` build that fails leaves an **invalid** index behind: never used
by the planner, never repaired by itself, and invisible unless you look.

```bash
PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c "SELECT c.relname, i.indisvalid, i.indisready FROM pg_index i
                           JOIN pg_class c ON c.oid = i.indexrelid
                          WHERE c.relname IN ('Session_projectId_requestedAt_idx','SessionEvent_runId_seq_idx');"
```

Both rows must read `t | t`. For any row with `indisvalid = f`:

```bash
PGOPTIONS="-c lock_timeout=3s -c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c 'DROP INDEX CONCURRENTLY "<name>";'
# then repeat step 1.1 for that index when the table is quieter.
```

A failed build is retried **by hand**. Nothing retries it automatically.

### 1.3 Apply the migration with a bounded lock wait

`ADD COLUMN` on a nullable column with no default is metadata-only, but it still
takes `ACCESS EXCLUSIVE`, which queues behind the six writers. Bound the wait
rather than discover it.

**Do not append a second `?options=` to `$DATABASE_URL`.** This repo's URLs often
already carry a query (`?schema=…`). A second `?` is not a delimiter — it is
absorbed into the preceding parameter's value. Rehearsed on a
`?schema=b4_schema_shape` URL, the naive append made `prisma migrate status`
report:

```
Datasource "db": … schema "b4_schema_shape?options=-c lock_timeout=3s"
Following migrations have not yet been applied:  20260815000000_phase0_init  …
```

— i.e. the timeout is not installed, the migration is aimed at a schema that does
not exist, and `migrate deploy` would have **silently created a new schema and
applied all migrations into it** while you believed you were bounding a lock.
Use the URL API to replace `options` deterministically while preserving every
unrelated parameter:

```bash
MIGRATE_URL="$(DATABASE_URL="$DATABASE_URL" node -e '
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.set("options", "-c lock_timeout=3s");
  process.stdout.write(u.toString());')"

# Verify what was actually built, WITHOUT printing the URL (it carries the password):
MIGRATE_URL="$MIGRATE_URL" node -e '
  const u = new URL(process.env.MIGRATE_URL);
  console.log("params:", [...u.searchParams.keys()].join(","));
  console.log("options:", u.searchParams.get("options"));
  console.log("schema:", u.searchParams.get("schema"));'
# expect  params: schema,options   (or just `options` on a bare URL)
#         options: -c lock_timeout=3s      <- decoded, a real space and a real `=`
#         schema:  <unchanged, or null>    <- if this grew a `?`, STOP

DATABASE_URL="$MIGRATE_URL" npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
```

Prisma 6.19 was rehearsed with the `+` serialization produced by
`URLSearchParams.set`; `SHOW lock_timeout` returned `3s`. The earlier claim that
Prisma passes a literal plus was false.

Confirm the option actually reached the server (the rehearsal did):

```
SHOW lock_timeout;  ->  3s
```

On `55P03` (`lock_not_available`), PostgreSQL rolls the migration objects back,
but Prisma records a failed row and the next deploy stops with `P3009`. Do not
blindly retry. Prove all four columns and both indexes are absent, inspect the
failed `_prisma_migrations` row, then run:

```bash
DATABASE_URL="$MIGRATE_URL" npx prisma migrate resolve --schema packages/db/prisma/schema.prisma --rolled-back 20260816165548_batch4_session_usage
PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = '20260816165548_batch4_session_usage';"
```

Only retry after `rolled_back_at` is populated. If any object survived, stop and
reconcile it explicitly; do not mark a partial shape rolled back. If the
URL-options form is unavailable, apply the `ALTER TABLE` by hand in psql under a
bounded lock wait, then record it with the explicit target and schema:

```bash
DATABASE_URL="$DATABASE_URL" npx prisma migrate resolve --schema packages/db/prisma/schema.prisma --applied 20260816165548_batch4_session_usage
```

Because the migration's `CREATE INDEX` statements carry `IF NOT EXISTS`, the
batch-4 migration itself applies only the four columns after the indexes exist,
and Prisma records it — no `migrate resolve --applied` in the happy path. The
overall deploy may also apply later pending migrations identified in §1.0.

### 1.4 Prove the database matches the datamodel

```bash
npm run db:generate
npm run db:drift-check          # must exit 0
```

This is not ceremony. `IF NOT EXISTS` matches on **name only**, so an index with
the right name and a wrong definition is accepted silently by step 1.3.
`drift-check` compares the live schema against the datamodel and is the only thing
that catches it.

### 1.5 Restart the API — onto THIS batch's code

This batch never performs the restart, never touches launchd and never touches the
runner. Service management is the operator's call.

**Restart onto `792570da5c8f6a4fc7af75cd65b395dead53033b` or a tested descendant,
never onto `2737113` (batch 4 as merged).**
The live ingest path (`packages/api/src/app.ts:2519`) uses the same extractor as
the backfill. An API restarted onto the merged-but-unfixed code starts writing
under-counted totals for every finishing CLAUDE session immediately — reading only
the top-level `usage` block, which describes one model out of however many the
session used — and those rows look self-consistent to `sameColumns`, so only a
later backfill corrects them. MF-2 blocks the restart, not just the backfill.

### 1.6 Backfill, twice

Run it **after** the restart, so a session that finished between 1.3 and 1.5 —
ingested by the old API, which writes none of these columns — is repaired too.
Concurrent ingest during the backfill is safe: that is what the advisory lock in
`recomputeSessionUsage` is for.

```bash
npm run db:backfill-session-usage    # exits non-zero if any session failed
npm run db:backfill-session-usage    # second run: `updated 0`, exit 0
```

Rehearsed: `scanned 5, updated 5, failed 0` then `scanned 5, updated 0, failed 0`,
both exit 0. The second run reporting `updated 0` **and exiting zero** is the
acceptance evidence for idempotence.

---

## 2. Preferred rollback: revert the code, leave the migration applied

**This is the default. Reach for §4 only when the columns genuinely must go.**

Four nullable columns that no old code reads are inert — no default, no
constraint, no trigger, nothing to evaluate. Both indexes are on pre-existing
columns, so old code either benefits from them or ignores them. Nothing is lost,
nothing needs undoing, and a later re-deploy needs no migration work at all.

---

## 3. The one code-rollback ordering rule this batch inherits

From `docs/specs/batch-4-sessions-viewer.md`: `GET /runs/:runId/events` returns an
envelope as of batch 4. Revert **API and web together**, or revert **the API
alone** (the envelope-aware client tolerates the old array shape). **Never revert
the web app alone while keeping the new API** — the old client reads the envelope
as an array and renders nothing.

---

## 4. Exceptional physical rollback

Only when the columns must actually go. Indexes first, outside any transaction, so
a failure there leaves the columns intact.

```bash
# One statement per -c. PGOPTIONS bounds the wait; a `SET` in the same -c would
# put the DROP inside an implicit transaction block and it would be REFUSED.
PGOPTIONS="-c lock_timeout=3s -c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c 'DROP INDEX CONCURRENTLY IF EXISTS "SessionEvent_runId_seq_idx";'
PGOPTIONS="-c lock_timeout=3s -c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c 'DROP INDEX CONCURRENTLY IF EXISTS "Session_projectId_requestedAt_idx";'
```

Then the columns, in one bounded transaction:

```sql
-- Feed this block to psql with the same PSQL_URL and a validated search_path:
-- PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL"
BEGIN;
  SET LOCAL lock_timeout = '3s';
  ALTER TABLE "Session"
    DROP COLUMN "totalTokens", DROP COLUMN "cachedInputTokens",
    DROP COLUMN "outputTokens", DROP COLUMN "inputTokens";
COMMIT;
```

> **`Session.costUsd` is NOT in that list, and must never be added to it.**
> `costUsd` predates this migration — it is in `20260815000000_phase0_init`, not
> in `20260816165548`'s `ALTER TABLE`. Dropping it destroys cost data that no
> backfill in this batch restores, because the recompute writes `costUsd` from
> `SessionEvent` payloads only for sessions that still have their events.

Verify afterwards that the four token columns are gone **and `costUsd` is still
there**:

```bash
PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c '\d "Session"' | grep -E 'inputTokens|outputTokens|cachedInputTokens|totalTokens|costUsd'
# expect exactly one line, costUsd
```

---

## 5. Reconcile `_prisma_migrations`

Mandatory, not cosmetic: without it the next `migrate deploy` skips a migration
whose objects no longer exist, and the four columns never come back.

```bash
PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c "DELETE FROM _prisma_migrations
                          WHERE migration_name = '20260816165548_batch4_session_usage';"
PGOPTIONS="-c search_path=$DB_SCHEMA,pg_catalog" psql "$PSQL_URL" -c "SELECT migration_name FROM _prisma_migrations
                          WHERE migration_name = '20260816165548_batch4_session_usage';"
# expect (0 rows)
```

**`npx prisma migrate resolve --rolled-back 20260816165548_batch4_session_usage`
does not work here, and the spec is wrong to prescribe it.** Rehearsed verbatim,
Prisma answers:

```
Migration `20260816165548_batch4_session_usage` cannot be rolled back because it is not in a failed state.
```

`--rolled-back` exists for a migration whose **apply failed**. A
migration that applied successfully and was then undone by hand is not in that
state, and Prisma offers no resolve command for it — the rehearsed recovery is a
targeted history-row deletion followed by a zero-row verification. Keep
`--rolled-back` only for §1.3's failed-apply row.

---

## 6. Drift after the rollback, and the pairing rule

A physical rollback is complete only when the **checked-out datamodel and the live
schema agree**. The schema rollback and the code rollback are one step, not two.

```bash
npm run db:drift-check          # against the rolled-back checkout; must exit 0
```

Rehearsed against a datamodel with exactly this batch's four columns and two
indexes removed: `No difference detected`, exit 0.

**Read the output, do not just read the exit code.** If you roll back to a
checkout that predates *another* applied migration as well, drift-check reports
that migration's objects too and exits 2. In the rehearsal, comparing against the
checkout immediately before `20260816165548` also reported batch 2.5's
`TriggerFire` foreign key and two `Task` indexes — nothing to do with batch 4. The
pairing rule applies per migration: every migration applied to the live database
must be declared by the checked-out datamodel.

---

## 7. Forward redeploy, and the dev-database checksum note

**Forward redeploy.** Re-checkout this batch's code and re-run §1.1 – §1.4.
Rehearsed with one index deliberately left behind: `migrate deploy` applied
cleanly, and `db:drift-check` exited 0 afterwards. That is `IF NOT EXISTS` earning
its keep — before this batch, a surviving index aborted the whole transactional
migration file and the redeploy was stuck.

**Dev-database checksum.** This batch edits `20260816165548`'s `migration.sql` in
place (two `IF NOT EXISTS` plus a header comment). That is legitimate only because
production has not applied it — but the **local dev** database has, so a later
`migrate deploy`/`dev` there reports the file as modified after it was applied.
One-time fix, on the dev database only:

```bash
DEV_SCHEMA="$(DATABASE_URL="$DEV_DATABASE_URL" node -e '
  const u = new URL(process.env.DATABASE_URL);
  const schema = u.searchParams.get("schema") || "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("schema is not a simple PostgreSQL identifier");
  process.stdout.write(schema);')"
DEV_PSQL_URL="$(DATABASE_URL="$DEV_DATABASE_URL" node -e '
  const u = new URL(process.env.DATABASE_URL); u.searchParams.delete("schema"); process.stdout.write(u.toString());')"
PGOPTIONS="-c search_path=$DEV_SCHEMA,pg_catalog" psql "$DEV_PSQL_URL" -c "DELETE FROM _prisma_migrations
                              WHERE migration_name = '20260816165548_batch4_session_usage';"
DATABASE_URL="$DEV_DATABASE_URL" npx prisma migrate resolve --schema packages/db/prisma/schema.prisma --applied 20260816165548_batch4_session_usage
PGOPTIONS="-c search_path=$DEV_SCHEMA,pg_catalog" psql "$DEV_PSQL_URL" -c "SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = '20260816165548_batch4_session_usage';"
```

or, on a disposable dev database, `npx prisma migrate reset`. Neither
`npm run test:db` nor `npm run db:drift-check` is affected: the former drops its
whole schema (`_prisma_migrations` included) before every run, and the latter never
reads checksums.

---

## 8. What the backfill actually is

`npm run db:backfill-session-usage` is **an absolute recompute from
`SessionEvent` of every session that has a `FINAL_OUTPUT` event; it overwrites any
populated cache that differs from the recomputed value, and writes nothing when
they match.**

It is **not** "write-only-to-null" — earlier documents said so and they were
wrong. The distinction is the whole point of running it in this batch: a
write-only-to-null backfill would skip every session whose columns are already
populated, which is exactly the population MF-2 corrects. The rehearsal shows the
same property from the other side: the second pass reports `updated 0` because the
values already match, not because it refuses to look.

One operational asymmetry, for §2: rolling the **code** back after a backfill
leaves the corrected (higher) totals in place until some later recompute rewrites
them downward. No schema implication; just do not read it as evidence the rollback
failed.

### Corrections the rehearsal and independent review produced

Kept as an audit trail; spec, plan, and this runbook now agree on the corrected mechanism.

| # | as specified | what actually happens | what this runbook does |
|---|---|---|---|
| 1 | `migrate resolve --rolled-back` reconciles `_prisma_migrations` after a physical rollback (spec §4.5 item 5) | refused — *"cannot be rolled back because it is not in a failed state"* | delete the row (§5) |
| 2 | `SET lock_timeout = '3s';` then `DROP INDEX CONCURRENTLY …` in one block (spec §4.5 item 4) | *"cannot run inside a transaction block"*; the index is silently left behind | one statement per `-c`, bounded with `PGOPTIONS` (§4) |
| 3 | drift-check against the pre-batch-4 checkout exits 0 (spec §4.5 item 6) | exits 2 when that checkout also predates another applied migration | compare against a batch-4-only rollback, and read the output (§6) |
| 4 | pass the repository's Prisma `?schema=...` URL directly to psql | libpq rejects the unknown `schema` parameter, or an unscoped docker fallback reaches `public` | derive `PSQL_URL`, validate `DB_SCHEMA`, and set `search_path` on every call (§1.0) |
| 5 | retry deploy immediately after `55P03` | Prisma leaves a failed row; the retry stops at `P3009` | prove objects absent, mark the failed row rolled back, verify, then retry (§1.3) |
| 6 | root-level `migrate resolve`, with an implicit target | Prisma cannot find the schema; the dev form can target the wrong database | pass both `DATABASE_URL` and `--schema`, then verify the target row (§§1.3, 7) |
| 7 | deploy applies only batch 4 | `migrate deploy` applies every pending migration, including batch 2.5 in the tested pre-batch-4 state | enumerate the pending set and compose the batch-2.5 runbook (§1.0) |

---

## 9. Rehearsal rule

Rehearse on a **scratch database or schema built from the committed migrations
with fixture rows only**. The harness exists: `packages/api/src/testdb.ts` drops
and re-applies a dedicated non-`public` schema named by `TEST_DATABASE_URL` and
**refuses to run against `public`**; `npm run db:fixture -w @agentos/db` seeds
rows. This runbook's own rehearsal created an empty database
`agentos_rehearsal_b4`, applied the twelve committed migrations, seeded five
sessions, and dropped the database afterwards.

**Never rehearse against a dump or a clone of the live database, and never point a
second API at one.** A clone still lists the live runs as `RUNNING` with runtime
handles the second control plane does not own; its reconciler classifies them as
orphans and deletes their workspaces — `.git` included, mid-task. Learned by
destroying a workspace on 2026-08-16.

"I could not get a scratch schema" is a failed gate. "I rehearsed against a clone
instead" is that incident.
