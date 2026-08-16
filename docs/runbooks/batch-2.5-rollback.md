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
few seconds the backfill takes, not a fault.

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

### Code-only rollback (recommended)

Every new column is nullable or defaulted and old code ignores all of them;
`TriggerFire` is append-only and nothing else reads it. So a code revert is safe
once the `UPDATE` above has run.

Two ordering rules:

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

```sql
UPDATE "Task" SET source = 'manual', "recurringSourceTaskId" = NULL;
DELETE FROM "TriggerFire" WHERE source = 'webhook';
```

## Deliberate behaviour changes worth announcing

- `GET /tasks` excludes archived tasks by default. That flows through to the
  Projects page's per-project `Tasks` count and the project detail's per-status
  counts, which now drop archived tasks. Reverting restores the old,
  archived-inclusive numbers — a visible jump in both directions.
- `POST /tasks/:id/retry` now refuses an archived task with `409`. It cannot
  fire for any task that existed before this batch, since nothing was archived.
