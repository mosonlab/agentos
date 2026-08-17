# Runbook — batch 2.5 (tasks visibility) deploy and rollback

Covers the schema, backfill, API and web changes of batch 2.5: the `Backlog`
column, task archiving, the trigger fire ledger, automation pause/resume and the
chain view.

## Deploy order

Migrate, backfill, restart the API, then ship the web bundle. The API is
additive except the `GET /tasks` archived default, so an old web bundle against
the new API keeps working.

```bash
npm run db:validate
npm run db:migrate            # 20260816180000_task_status_backlog, then 20260816180100_tasks_visibility
npm run db:generate
npm run db:drift-check        # must exit 0
npm run db:backfill-task-source   # idempotent; safe to re-run
npm run build
# restart the API process
npm run build -w @agentos/web
```

**Restarting the API is not optional.** The scheduler runs in-process
(`packages/api/src/scheduler.ts`), so an un-restarted API keeps firing
automations that the operator has paused, and keeps firing archived recurring
tasks. Service management is the operator's call — this runbook does not touch
launchd or the runner. The runner needs no restart: nothing in its contract
changed.

Running the API before the backfill is harmless. Un-backfilled tasks read
`source = manual` and list no historical fires — an observability gap for the
few seconds the backfill takes, not a fault. Run `db:backfill-task-source` once;
it is safe to re-run and safe to run twice at once, because each backfilled fire
is written under a deterministic primary key with `skipDuplicates`.

### Index locking during `db:migrate`

`20260816180100_tasks_visibility` builds two indexes on the existing `Task`
table with ordinary, non-concurrent `CREATE INDEX`:
`(projectId, archivedAt, status)` and `(recurringSourceTaskId)`. An ordinary
build takes `SHARE` on the table, which **blocks every `INSERT`/`UPDATE` to
`Task` for its duration** — and the old API is still serving during this step,
so chain advance, run completion and the scheduler all stall behind it.

At dogfood volume (`Task` in the thousands) this is milliseconds and needs no
ceremony. Before running it against a large table, bound the wait rather than
discovering it:

```sql
SET lock_timeout = '5s';   -- fail fast instead of queueing behind a long txn
-- then run the migration; on 55P03 (lock_not_available), retry when idle
```

`CREATE INDEX CONCURRENTLY` is the alternative, but it cannot run inside the
transaction Prisma wraps a migration in, so it would have to be applied by hand
outside `db:migrate` and recorded as applied. Not worth it at this size —
documented so the choice is deliberate.

## Rollback

### The one trap: `TaskStatus.backlog`

**Before** rolling the API back to a build without the `BACKLOG` enum member,
run:

```sql
UPDATE "Task" SET status = 'todo' WHERE status = 'backlog';
```

Otherwise Prisma throws while deserializing those rows and every task query
fails. The enum *value* itself cannot be dropped by `ALTER TYPE`; removing it
means recreating the type, which rewrites a hot table. The accepted rollback is
to leave the value in place and revert only the code.

The same statement is what makes a web-only rollback safe: after reverting the
board, a task sitting in `Backlog` is invisible in every column until it is
moved back to `todo`.

### Code-only rollback

Schema-wise a code revert is clean: every new column is nullable or defaulted,
old code ignores all of them, and `TriggerFire` is append-only.

**It is not, however, safe by default, because two of this batch's guarantees
live entirely in the code being reverted and have no database backstop.** Both
concern inbound webhook traffic:

| Guarantee | Enforced only by | On rollback |
|---|---|---|
| A paused trigger rejects deliveries | `authenticateWebhook` reading `webhookPausedAt` (`packages/api/src/hooks.ts`) | **Every paused trigger silently goes live again** and outside traffic instantiates chains from it. The column keeps its value; nothing reads it. |
| A redelivered webhook does not fire twice | the ledger lookup over `TriggerFire` in `POST /hooks/templates/:id` | **The replay window disappears.** A retrying sender creates one chain per delivery. |

So the rollback is conditional on quiescing webhook ingress. Do this **before**
starting the old build, not after:

1. Record the restore list, so pause state survives the rollback:
   ```sql
   SELECT id, name, "webhookPausedAt", "webhookReplayWindowSec"
     FROM "TaskTemplate" WHERE "webhookPausedAt" IS NOT NULL;
   ```
   Keep the output. Nothing else records it once the code that reads the column
   is gone.
2. Detach the credential for every paused trigger, which the old code *does*
   honour — an unauthenticated delivery is rejected by any build:
   ```sql
   UPDATE "TaskTemplate" SET "webhookSecretId" = NULL WHERE "webhookPausedAt" IS NOT NULL;
   ```
   Restore from the list in step 1 when rolling forward again.
3. Drain in-flight redeliveries: wait out the longest configured
   `webhookReplayWindowSec` (`SELECT max("webhookReplayWindowSec") FROM
   "TaskTemplate";`) with ingress stopped, so no sender is mid-retry when the
   window protection disappears. During and after the rollback, duplicate
   deliveries create duplicate chains; there is no way to keep that promise on
   old code.

Two further ordering rules:

- **Revert the `workflow.ts` parked-successor guard only together with the board
  change that introduced the `Backlog` column.** Without the guard, a task in
  `BACKLOG` makes `activateChainSuccessor`'s compare-and-set loop spin forever
  *inside a database transaction* when its predecessor's run completes.
- **Reverting the automation changes makes paused automations resume firing**,
  and re-permits an archived `AT` task to fire. Before that revert, park those
  definitions by hand (move them out of `TODO`, or clear their `runAt`).

### Schema rollback, in reverse order

```sql
DROP TABLE "TriggerFire";
DROP TYPE "TriggerFireSource";
ALTER TABLE "TaskTemplate" DROP COLUMN "webhookPausedAt", DROP COLUMN "webhookReplayWindowSec";
ALTER TABLE "Task" DROP COLUMN "source", DROP COLUMN "archivedAt",
  DROP COLUMN "schedulePausedAt", DROP COLUMN "recurringSourceTaskId";
DROP TYPE "TaskSource";
-- "TaskStatus"'s 'backlog' value stays; see above.
```

### What is lost on rollback

Archive state, source attribution, schedule and trigger pause flags, and the
fire ledger — all observability. Chains, tasks and runs are untouched by every
path above.

### Undoing just the backfill

Backfilled ledger rows are the ones whose primary key carries the
`backfill:<templateId>:<firedAt>` marker `backfillTaskSource` writes
(`packages/db/src/task-source.ts`). Live webhook fires keep their generated
cuid, so the marker — not `source` — is what separates the two.

```sql
UPDATE "Task" SET source = 'manual', "recurringSourceTaskId" = NULL;
DELETE FROM "TriggerFire" WHERE "id" LIKE 'backfill:%';
```

> **Do not** delete by `source = 'webhook'`. Every *live* inbound fire is written
> with that same source into that same table, and those rows are the replay-window
> guard: deleting them erases post-deploy history and immediately re-permits
> duplicate chains for any delivery still inside its window.

Deleting backfilled rows is purely an observability rollback — the historical
fires they describe are outside every live replay window by construction, since
they predate the deploy.

## Deliberate behaviour changes worth announcing

- `GET /tasks` excludes archived tasks by default. That flows through to the
  Projects page's per-project `Tasks` count and the project detail's per-status
  counts, which now drop archived tasks. Reverting restores the old,
  archived-inclusive numbers — a visible jump in both directions.
- `POST /tasks/:id/retry` now refuses an archived task with `409`. It cannot
  fire for any task that existed before this batch, since nothing was archived.
