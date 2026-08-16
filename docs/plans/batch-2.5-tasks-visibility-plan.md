# PLAN — Batch 2.5: tasks visibility (chain view, triggers & automations UI, kanban completeness)

Status: **revision 0** (first pass) · Author: plan agent (chain step ②) · Date: 2026-08-16
Spec: `docs/specs/batch-2.5-tasks-visibility.md` (approved, commit `2802d36`).
Authority behind the spec: `docs/BACKLOG-V2.md` 批次 2.5 · `docs/reference/danny-agentos-video/detail-gaps.md` §2/§4/§5/§6 · `decisions.md` §12.
Plan verified against the working tree at commit `2802d36` (branch
`agentos/cmsw6zrz50hcimpyjx8ajyqwv/run-1`). Every file, line anchor, constant and
query quoted below was re-read in the source while writing this plan; §0.2 lists
the eight places where the code contradicts or under-specifies the spec, and each
is corrected here rather than silently re-specified. §16 lists everything this
plan is still guessing about.

Planning only. **Thirteen work items in dependency order, one commit each, on one
feature branch, landing as one PR with two migration folders.** Every spec
requirement maps to a numbered work item in §14.

---

## 0. Approach summary

- **Schema first (WI-1), because nothing else compiles without it.** Two
  migration folders — `ALTER TYPE "TaskStatus" ADD VALUE 'backlog'` alone, then
  everything else — plus one shared `ACTIVE_RUN_STATUSES` constant that the whole
  batch's guards agree on (§0.2-C1). Additive only: no drop, no `NOT NULL`, no
  rewrite.
- **The data backfill is a script, not migration SQL (WI-2).** The dbtest harness
  runs `prisma migrate reset` against an empty scratch schema
  (`packages/api/src/testdb.ts:19-29`), so a backfill embedded in a migration has
  nothing to touch and can never be asserted — which is exactly what spec §7 test
  23 asks for. Batch 4 already set the precedent
  (`packages/db/prisma/backfill-session-usage.ts` + a callable in
  `packages/db/src/usage.ts`). See §0.2-C3.
- **The `workflow.ts` parked-successor guard lands third (WI-3), before any code
  path can produce a `BACKLOG` task.** This is the single highest-risk change in
  the batch: without it the new enum value makes the CAS at
  `packages/db/src/workflow.ts:226-252` spin forever *inside a database
  transaction* on run completion. Landing it before the board can write
  `BACKLOG` (WI-10) means the dangerous window never exists, even mid-branch.
- **One chain-assembly module, three consumers (WI-4).** `chainProgress`,
  `positions` and `startable` are computed in `packages/api/src/chain.ts` from
  plain row arrays, with no Prisma types in the signature; `GET /tasks`,
  `GET /tasks/:taskId/chain` and `GET /triggers/:id/fires` all call it. That is
  what makes spec §6-E4 ("one grouped query, not N+1") a property of one function
  instead of a discipline three routes have to remember.
- **API before web, pure web leaves before web pages.** WI-4…WI-7 finish the API
  surface; WI-8 lands the pure functions and types the four new pages share; WI-9
  lands the tab shell that gives them somewhere to live; WI-10…WI-13 are the
  pages, each mechanical by then.
- **Secret hygiene is a select-list discipline, not a review promise.** Every new
  trigger route selects columns explicitly and never `include`s `webhookSecret`.
  `packages/api/src/hooks.dbtest.ts:98` already guards this for the existing
  template routes; WI-7 extends that test to the new ones.

Verification commands used throughout, in this order:

```bash
npm run db:validate           # schema parses
npm run db:migrate            # dev DB; see §15 for the ordered deploy
npm run db:drift-check        # DB matches schema.prisma exactly
npm run build                 # root; MUST precede npm test (see below)
npm test                      # root; every workspace's `test` script
npm run test:db -w @agentos/api   # the real-Postgres *.dbtest.ts set
```

**`npm run build` must precede `npm test`**: `apps/web/src/tests/styles.test.tsx:11-14`
reads `apps/web/dist/assets/*.css` and throws `Build apps/web before running CSS
regression tests` if the build is missing.

---

## 0.1 What was verified in the tree (the spec's §2 re-checked, not assumed)

Confirmed exactly as the spec describes — no correction needed:

| Spec claim | Verified at |
|---|---|
| `TaskStatus = TODO\|DOING\|REVIEW\|DONE`, no `BACKLOG`, no archive concept | `packages/db/prisma/schema.prisma:46-51`, `441-493` |
| `Task` has `chainId`/`chainIndex` + `@@unique([chainId, chainIndex])`, no parent/child | `schema.prisma:457-458`, `485` |
| `TaskTemplate` has webhook fields, no pause flag, no replay window | `schema.prisma:397-418` |
| `Agent.archivedAt` is the soft-retire precedent | `schema.prisma` + `app.ts:708-729` |
| `instantiateTemplate` creates one task per step, enqueues run 1 for the first only | `packages/api/src/templates.ts:62-101` (`enqueueTaskRun` at `:92`) |
| `activateChainSuccessor` finds the successor by `chainId` + `chainIndex >` , scoped by `projectId` | `packages/db/src/workflow.ts:180-185` |
| **The CAS loop spins forever on a status outside `{TODO,DOING,REVIEW}`** | `workflow.ts:226-252` — `updateMany` matches 0 rows, the re-read finds a non-`DONE` task with no active run, `successor = current`, loop repeats with the same `updatedAt` and the same status. Confirmed by reading; this is real |
| Archived assignee parks in `REVIEW` with a `failureReason` | `workflow.ts:276-295` |
| Seeded nine-step template uses `stepIndex` 1..9, step 9 is `HUMAN` + gate | `packages/db/prisma/seed.ts:193-202` |
| Webhook records no fire anywhere but `TaskActivity` | `app.ts:473-505` |
| `schedulerTick` copies a `CRON` task, no chain, no template, `TODO`-only filter | `packages/api/src/scheduler.ts:99-140`, `154-164` |
| Quarantine sets `runAt = null` + an activity row | `scheduler.ts:56-76` |
| `POST /tasks/:taskId/retry` requires a prior run (`409`) | `app.ts:1366-1372` |
| Run claim only accepts `task.status in [TODO, DOING]` | `app.ts:1566-1568` — so `BACKLOG` is already mechanically un-runnable |
| Board has four hard-coded columns and a one-option `Segmented` placeholder | `apps/web/src/pages/Tasks.tsx:35-40`, `:304` |
| `TaskDetail` `STATUSES` is a hand-written array | `apps/web/src/pages/TaskDetail.tsx:170` |
| `taskTones` is an exhaustive `Record<TaskStatus, PillTone>` | `apps/web/src/components/ui.tsx:117` |
| Router matches path segments only, no query strings | `apps/web/src/lib/router.tsx:28-40` |
| Web `Task` type omits `chainId`/`chainIndex` | `apps/web/src/lib/types.ts:224-249` |
| No cron-formatting dependency in the web app | `apps/web/package.json` |

Two additions the spec did not state, verified here because the plan depends on
them:

- **`GET /tasks` has exactly one caller: the web app.** `packages/cli/src` contains
  no `tasks` reference at all; `packages/runner` and `packages/inbox` reach tasks
  only through `/runner/*`. The archived-default flip (spec §5.2) is therefore a
  one-consumer change, and the "documented deliberate break" is a runbook line,
  not a coordination problem.
- **`cronstrue@3.24.0` resolves from the configured registry** (checked with
  `npm view`). WI-8's dependency add is not a guess.

---

## 0.2 Corrections — where the code contradicts or under-specifies the spec

Each of these changes what the implementer must write. None of them changes what
the operator sees, except C4 and C7 where the spec contradicts itself.

### C1 — "an active run" has four different definitions in this repo; the spec picks the wrong one

| Definition | Where | Statuses |
|---|---|---|
| Successor-is-busy | `packages/db/src/workflow.ts:160-166` | QUEUED, CLAIMED, PROVISIONING, RUNNING, **WAITING_INBOX** |
| Lease-holding run (fencing) | `packages/api/src/app.ts:420` | CLAIMED, PROVISIONING, RUNNING, WAITING_INBOX |
| Retry guard | `app.ts:1369` | QUEUED, CLAIMED, RUNNING |
| Web `retryable()` | `apps/web/src/pages/Tasks.tsx:61` | QUEUED, CLAIMED, PROVISIONING, RUNNING |

Spec §4.3 defines startable using `QUEUED | CLAIMED | PROVISIONING | RUNNING`,
which **omits `WAITING_INBOX`**. A run parked on an Inbox question is as alive as
a running one — it resumes the moment the question is answered
(`workflow.ts:463-473`). With the spec's set, `Start now` would enqueue a second
run for a task whose session is waiting on the operator, and `Archive` / the
Backlog-drag guard would both let that task be moved out from under a live
session.

**Correction.** Export the existing five-status set from
`packages/db/src/workflow.ts` as `ACTIVE_RUN_STATUSES` (rename the module-local
`activeSuccessorStatuses` to it and keep using it in place), and use it for every
new guard in this batch: `POST /tasks/:id/start`, `POST /tasks/:id/archive`,
`archive-done`, and the `PATCH` `BACKLOG` guard. `app.ts:420`'s
`activeRunStatuses` is a *different* concept (a run holding a lease) and must not
be touched. The retry guard's narrower set is a pre-existing inconsistency — it is
**out of scope** here (changing it changes existing behaviour and its tests);
recorded as a follow-up in §17.

### C2 — `TriggerFire` cannot be written "in the same transaction as the instantiation" from the caller

Spec §5.2 requires the ledger row to be created in the instantiation transaction.
`instantiateTemplate` (`packages/api/src/templates.ts:58-106`) opens and owns its
own `Serializable` transaction inside a five-attempt retry loop; the caller only
ever sees the returned `{chainId, branchName, tasks}`. A caller-side write is a
second transaction and can be lost while the chain survives (or, worse, land
twice if the caller retries).

**Correction.** Extend the existing `options` parameter (already the extension
point — it carries `actorType` and `activityMetadata`):

```ts
options: {
  actorType?: string;
  activityMetadata?: Record<string, unknown>;
  source?: TaskSource;                                    // spec §5.2, stamped on every task
  fire?: { source: TriggerFireSource; dedupeKey?: string | null };  // NEW
}
```

and create the `TriggerFire` row inside the same `tx`, after the tasks, with
`chainId` set. A serialization retry then rolls back the ledger row with the
chain, which is the only shape in which "exactly one fire per chain" is true.

### C3 — an in-migration backfill is untestable under this repo's harness

Spec §5.1 puts the `source` / `recurringSourceTaskId` / `TriggerFire` backfill
inside the second migration, and spec §7 test 23 asks a dbtest to assert its
result. Those cannot both hold: `setupTestDb` (`packages/api/src/testdb.ts:19-29`)
runs `prisma migrate reset --force --skip-seed` **once**, against an empty schema.
The migration executes with zero rows present; the fixture rows a test inserts
afterwards are never touched by it.

**Correction, following the batch-4 precedent exactly.** Migrations are
schema-only. The backfill ships as:

- `packages/db/src/task-source.ts` — an exported, idempotent
  `backfillTaskSource(db)` that returns `{ sourceCron, sourceWebhook, recurringLinked, firesCreated }`.
- `packages/db/prisma/backfill-task-source.ts` — the thin runner script
  (mirrors `backfill-session-usage.ts`), wired as
  `"db:backfill-task-source"` in `packages/db/package.json` and hoisted to the
  root `package.json` the same way `db:backfill-session-usage` already is.
- `packages/api/src/migration.dbtest.ts` — a test that seeds the three shapes and
  calls `backfillTaskSource` directly.

Deploy order gains one step: migrate → **backfill** → API → web (§15). Running
the API before the backfill is harmless: unbackfilled tasks read `manual` and no
fires are listed, which is an observability gap for a few seconds, not a fault.

### C4 — the spec contradicts itself on the `archive-done` response

§5.2 says `200 { archived: n }`; §6-E8 says it returns `{ archived, skipped }` and
the UI reports `Archived 6, skipped 1 (running)`; §4.9-A2 asserts
`200 { archived: 0 }`.

**Correction.** Return `{ archived: number, skipped: number }` always. A2's
assertion holds as a subset (`archived === 0`). The UI renders the skipped clause
only when `skipped > 0`.

### C5 — `GET /tasks` cannot compute `chainProgress` from the rows it returns

`m` counts **all** chain rows including archived ones (spec §4.1-C6, §4.9-A5),
but the board query excludes archived rows by default. Computing progress from
the response rows would make a chain with four archived steps read `n/5` on the
board and `n/9` on task detail.

**Correction.** After the main `findMany`, issue exactly one additional query:

```ts
const chainIds = [...new Set(tasks.map(t => t.chainId).filter(Boolean))];
const chainRows = chainIds.length === 0 ? [] : await db.task.findMany({
  where: { projectId, chainId: { in: chainIds } },   // projectId scope: spec §6-E2
  select: { id: true, chainId: true, chainIndex: true, status: true, name: true,
            archivedAt: true, templateStep: { select: { name: true } } },
  orderBy: { chainIndex: "asc" },
});
```

then `chainProgressByChain(chainRows)` in memory. Two queries per request
regardless of task count — spec §6-E4 satisfied, and satisfied by construction
rather than by a note.

### C6 — the trigger routes use two different base paths for one resource

Spec §5.2 lists `GET /triggers/:templateId`, `POST /triggers/:templateId/pause`
and `POST /task-templates/:templateId/fire`. That is inconsistent, but it is what
the spec's reviewer checklist (§8.5) and test list (§7-21) name.

**Decision: implement the spec's paths verbatim.** Renaming would silently
invalidate the reviewer's steps for a cosmetic gain. Recorded as open question
O5 (§18) instead.

### C7 — spec §4.3 leaves a parked step unreachable

`startable` requires `status ∈ {TODO, BACKLOG}`. A step parked in `REVIEW` by an
archived assignee (`workflow.ts:276-295`) is therefore not startable from the
chain view, and `POST /tasks/:id/retry` refuses it too because it has no prior run
(`app.ts:1368`). After unarchiving the agent, that step can only be released by
editing its status by hand.

**Not fixed here** — widening `startable` to `REVIEW` would let the operator start
a step whose gate is open, which §5.5 forbids, and distinguishing the two cases is
new behaviour the spec did not ask for. Recorded as a follow-up (§17-F2) and
surfaced to the operator: the chain row shows the `failureReason` sub-line
(§4.1), so the state is at least visible.

### C8 — `E1` (chainId set, chainIndex null) needs an explicit branch, not an ordering assumption

Postgres sorts `NULL` last under `ORDER BY … ASC`, so a null-`chainIndex` row
would render last in its chain rather than as its own `1/1`. `activateChainSuccessor`
already treats this state as broken and logs it (`workflow.ts:186-192`).

**Correction.** `GET /tasks/:taskId/chain` branches before querying: if the
subject task's `chainIndex` is `null`, return that single row as
`{ total: 1, done: task.status === DONE ? 1 : 0, steps: [<that row at position 1>] }`.
Rows *other* than the subject with a null `chainIndex` are excluded from the chain
query (`chainIndex: { not: null }`) so they cannot silently shift positions.

---

## WI-1 — Schema, two migrations, and one shared active-run constant

**Goal.** Every column, enum and index spec §5.1 asks for, plus the constant C1
requires. Nothing else in the batch compiles until the Prisma client is
regenerated, so this is strictly first.

**Files**

- `packages/db/prisma/schema.prisma` — `TaskStatus` (`:46-51`), new `TaskSource`
  and `TriggerFireSource` enums, `Task` (`:441-493`), `TaskTemplate` (`:397-418`),
  new `TriggerFire` model.
- `packages/db/prisma/migrations/20260816180000_task_status_backlog/migration.sql` (new)
- `packages/db/prisma/migrations/20260816180100_tasks_visibility/migration.sql` (new)
- `packages/db/src/workflow.ts:160-166` — rename + export.

**What to do**

1. Schema, exactly as spec §5.1 writes it. `BACKLOG @map("backlog")` goes **first**
   in `TaskStatus` so the datamodel's value order matches the DB's (see step 3).
   `Task` gains `source TaskSource @default(MANUAL)`, `archivedAt DateTime?`,
   `schedulePausedAt DateTime?`, `recurringSourceTaskId String?` + the self
   relation `TaskRecurringSource` (`onDelete: SetNull`), and the two new indexes
   `@@index([projectId, archivedAt, status])`, `@@index([recurringSourceTaskId])`.
   `TaskTemplate` gains `webhookPausedAt DateTime?`,
   `webhookReplayWindowSec Int?`, `fires TriggerFire[]`. `TriggerFire` verbatim,
   including both indexes.
2. Generate the folders with
   `npx prisma migrate dev --create-only --name task_status_backlog` and then
   `--name tasks_visibility`, so the SQL is byte-compatible with what
   `db:drift-check` expects; hand-edit only to add explanatory comments (the
   batch-2 migration is the precedent for commented migration SQL).
3. **The first migration is `ALTER TYPE` and nothing else.** Postgres 16
   (`docker-compose.yml:3`) permits `ALTER TYPE … ADD VALUE` inside a transaction
   but forbids *using* the new value in that same transaction, and Prisma runs
   each migration in one. The second migration does not reference `'backlog'`, so
   one file would very likely work — splitting removes the entire failure class
   for free, and the spec asks for it. Prefer the positioned form so DB order
   matches the datamodel:
   ```sql
   ALTER TYPE "TaskStatus" ADD VALUE 'backlog' BEFORE 'todo';
   ```
   If `npm run db:drift-check` reports a diff after this, fall back to the
   unpositioned `ADD VALUE 'backlog'` and move `BACKLOG` to the end of the Prisma
   enum — drift-check is the arbiter, not this plan (§16-G1).
4. Second migration: `CREATE TYPE "TaskSource"`, `CREATE TYPE "TriggerFireSource"`,
   the `ALTER TABLE`s, `CREATE TABLE "TriggerFire"` + FK + indexes. Creating a
   type and using it as a column default in the same transaction is fine — the
   restriction applies only to values added by `ALTER TYPE … ADD VALUE`.
   `ADD COLUMN "source" … DEFAULT 'manual'` does not rewrite the table on PG 16.
5. `workflow.ts`: rename `activeSuccessorStatuses` → `ACTIVE_RUN_STATUSES` and
   `export` it; it is re-exported by `packages/db/src/index.ts:14` automatically.
   Update its two uses at `:213` and `:243`. No behaviour change.

**Verification**

- `npm run db:validate` and `npm run db:migrate` on the dev DB, then
  `npm run db:drift-check` → exit 0.
- `npm run build` at the root (the regenerated client must typecheck against
  every workspace).
- `npm run test:db -w @agentos/api` — the existing suite must stay green with
  zero edits. `packages/api/src/migration.dbtest.ts` proves the harness applies
  the new migrations.
- New assertions appended to `migration.dbtest.ts` (structural, in the style of
  its existing first test): `TriggerFire` exists with both indexes; `Task` has the
  four new columns; `'backlog'` is present in `pg_enum` for `TaskStatus`;
  `Task_projectId_archivedAt_status_idx` exists.

**Rollback.** Revert the two folders and the schema hunk. On a database that has
already migrated, follow §16 — leave the enum value in place and revert code
only, after running the `UPDATE … SET status='todo'` statement.

---

## WI-2 — Backfill: `Task.source`, `recurringSourceTaskId`, and the webhook fire ledger

**Goal.** Spec §5.1's backfill, as an idempotent callable (C3).

**Files**

- `packages/db/src/task-source.ts` (new) — `backfillTaskSource(db, options?)`.
- `packages/db/src/index.ts` — add `export * from "./task-source.js";`.
- `packages/db/prisma/backfill-task-source.ts` (new) — runner script, modelled
  line-for-line on `backfill-session-usage.ts`.
- `packages/db/package.json` — `"db:backfill-task-source"` script;
  root `package.json` — the hoisted alias.
- `packages/api/src/migration.dbtest.ts` — the data test.

**What to do**

1. `source = 'cron'` + `recurringSourceTaskId` for every task that has a
   `TaskActivity` row with `actorType = 'scheduler'` and a non-null
   `metadata->>'recurringTaskId'` (`scheduler.ts:133-137` is the writer). Set the
   FK only when the referenced task still exists — the column is `SetNull`, but a
   backfill that writes a dangling id fails the FK outright.
2. `source = 'webhook'` for every task with a `TaskActivity` row whose
   `actorType = 'webhook'` (`app.ts:495`).
3. `TriggerFire`: one row per distinct
   `(metadata->>'webhookTemplateId', metadata->>'firedAt')` pair from those
   activity rows, `chainId` from the task's `chainId`, `source = 'webhook'`,
   `createdAt` = the parsed `firedAt`. Skip pairs whose `templateId` no longer
   exists (FK is `Cascade`, but the template may have been deleted).
4. Idempotence: step 1/2 update only rows still at `source = 'manual'`; step 3
   skips a pair that already has a `TriggerFire` with the same
   `(templateId, createdAt)`. Re-running must report zeros, not duplicates.
5. Never write `'backlog'`.

**Verification**

- New `migration.dbtest.ts` tests (real Postgres, seeded rows then a direct call):
  a scheduler-created task ends `source='cron'` with a resolved
  `recurringSourceTaskId`; a webhook-created task ends `source='webhook'` with one
  `TriggerFire`; a hand-made task stays `manual`; a scheduler task whose parent was
  deleted gets `source='cron'` and a **null** FK; **a second call returns all
  zeros and creates no rows.**
- `npm run test:db -w @agentos/api`.

**Rollback.** The script is additive and re-runnable; reverting the code leaves
the backfilled values in place, where old code ignores them. To undo the data:
`UPDATE "Task" SET source='manual', "recurringSourceTaskId"=NULL; DELETE FROM "TriggerFire" WHERE source='webhook';`

---

## WI-3 — `workflow.ts`: parked successors (the batch's highest-risk change)

**Goal.** Spec §5.3. A `BACKLOG` or archived successor must make
`activateChainSuccessor` **return**, not spin.

**Files**

- `packages/db/src/workflow.ts:202-252` — insert the guard between the
  "successor already active" block (`:213-220`) and the `for(;;)` CAS (`:226`).
- `packages/api/src/chain.dbtest.ts` — two regression tests.

**What to do**

```ts
// Between workflow.ts:220 and :226 — BEFORE the CAS loop.
if (successor.archivedAt !== null) {
  await tx.taskActivity.create({ data: { taskId: successor.id, actorType: "control-plane",
    body: `Predecessor ${task.name} completed; successor is archived and was not queued` } });
  return { nextTaskId: successor.id, gated: false };
}
if (successor.status === TaskStatus.BACKLOG) {
  await tx.taskActivity.create({ data: { taskId: successor.id, actorType: "control-plane",
    body: `Predecessor ${task.name} completed; successor is parked in Backlog — use Start now` } });
  return { nextTaskId: successor.id, gated: false };
}
```

Two details the implementer must not lose:

- **The re-read inside the loop needs the same guard.** `workflow.ts:236-251`
  re-reads `current` and assigns `successor = current`; if a concurrent operator
  drags the successor to `Backlog` *between* the read and the claim, the loop
  re-enters with a `BACKLOG` row and hangs exactly as before. Add the identical
  `archivedAt` / `BACKLOG` check to the re-read branch, right after the existing
  `current.status === DONE` check at `:240`.
- The guard goes **after** the "already active" check so a successor that is both
  archived and running still reports as active (that ordering is what makes E8's
  skip-if-running semantics consistent across the batch).

`ChainSuccessor` already selects the whole row, so `archivedAt` is present with no
query change.

**Verification**

- `packages/api/src/chain.dbtest.ts`, two new tests, each wrapped so a hang fails
  rather than blocks — the failure mode is an infinite loop inside a transaction,
  so a bare `await` would stall the whole run:
  ```ts
  const withTimeout = <T>(work: Promise<T>, ms = 5_000): Promise<T> => Promise.race([
    work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("activateChainSuccessor hung")), ms)),
  ]);
  ```
  1. Successor set to `BACKLOG` → `activateChainSuccessor` resolves inside the
     timeout, the successor has **zero** runs, its status is still `BACKLOG`, and
     the activity row matches `/parked in Backlog/`.
  2. Successor with `archivedAt` set → resolves, zero runs, activity row matches
     `/is archived and was not queued/`.
- `npm run test:db -w @agentos/api` — `chain.dbtest.ts`'s eleven existing tests
  must stay green (they cover the concurrent-advance and CAS-retry paths this
  edit sits inside).

**Rollback.** Revert this hunk alone — but only together with WI-10, because
without the guard a `BACKLOG` task can hang run completion. Noted in §16.

---

## WI-4 — API: chain assembly, `GET /tasks/:taskId/chain`, and the `GET /tasks` extension

**Goal.** Spec §4.1, §4.2, §5.2's `GET /tasks/:taskId/chain` and the `GET /tasks`
row shape.

**Files**

- `packages/api/src/chain.ts` (new) — the pure module.
- `packages/api/src/chain.test.ts` (new) — unit tests, no database.
- `packages/api/src/app.ts:1210-1221` (`GET /tasks`), after `:1280` (the new
  chain route).
- `packages/api/src/chain.dbtest.ts` — route-level coverage.

**What to do**

1. `packages/api/src/chain.ts`, taking plain rows (no Prisma payload types in the
   signature — that is what keeps it unit-testable and shareable):
   ```ts
   export type ChainRow = {
     id: string; chainId: string | null; chainIndex: number | null;
     name: string; status: TaskStatus; archivedAt: Date | null;
     templateStep: { name: string } | null;
   };
   export const stepName = (row: ChainRow): string => row.templateStep?.name ?? row.name;
   export const chainProgress = (rows: ChainRow[]) => ({ done, total, activeStepName, activeStatus });
   export const chainProgressByChain = (rows: ChainRow[]): Map<string, ChainProgress> => …;
   export const positions = (rows: ChainRow[]): Map<string, number> => …;   // 1-based, chainIndex asc
   ```
   - `total` = row count (**not** `max(chainIndex)+1`) — spec §4 terminology, [A1].
   - `done` = rows with `status === DONE`, archived rows included (§4.1-C6).
   - active step = lowest `chainIndex` whose status is not `DONE`; if all are
     `DONE`, the last row.
   - `activeStatus` is the lowercased `TaskStatus` ([A2]).
2. `startable(row, runs, maxSessionsPerTask)` lives here too and is the **single**
   source for both the API guard (WI-5) and the web button (WI-8 re-implements the
   same predicate against the API's `startable` boolean rather than duplicating
   the logic — the API computes it, the web only reads it). Conditions, all seven,
   from §4.3, with "active run" = `ACTIVE_RUN_STATUSES` (C1).
3. `GET /tasks/:taskId/chain`, returning
   `{ chainId, total, done, steps: [...] }` with each step carrying
   `taskId, position, chainIndex, name, stepName, status, approvalGate,
   assigneeType, agent {id,title}|null, archivedAt, failureReason,
   latestRun {id,status,runNumber}|null, startable`.
   - No chain → `200 { chainId: null, total: 0, done: 0, steps: [] }` (not 404).
   - Task not found → `404`.
   - `chainIndex === null` on the subject → the single-row branch of C8.
   - Query is scoped by `projectId` **and** `chainId` (§6-E2), with
     `chainIndex: { not: null }`, `orderBy: { chainIndex: "asc" }`, and
     `include: { assigneeAgent: { select: { id, title, archivedAt } }, templateStep: { select: { name } }, runs: { orderBy: { runNumber: "desc" }, take: 1 } }`.
4. `GET /tasks` (`app.ts:1210-1221`):
   - new query param `archived` ∈ `false|true|all`, **default `false`** → `where`
     gains `archivedAt: null` / `{ not: null }` / nothing. Reject other values with
     `400` rather than silently defaulting.
   - `include` gains `templateStep: { select: { name: true } }`.
   - the second chain query + `chainProgressByChain` of C5; each task gains
     `chainProgress: { chainId, position, total, done, activeStepName, activeStatus } | null`.
   - `source`, `archivedAt`, `chainId`, `chainIndex`, `schedulePausedAt` ride along
     automatically as Prisma scalars.

**Verification**

- `packages/api/src/chain.test.ts` (`npm test -w @agentos/api`): `chainProgress`
  over a nine-row chain at 0/3/9 done; sparse `chainIndex` 1/5/9 → positions
  1,2,3 and `total = 3`; a single row; an empty array; an all-done chain picking
  the **last** row as active; an archived-but-DONE row counting toward both `n`
  and `m`; `startable` — one test per condition, including the `WAITING_INBOX`
  case C1 exists for.
- `chain.dbtest.ts`: `GET /tasks/:id/chain` over a real nine-step
  `instantiateTemplate` result — nine steps, positions 1..9, step 9
  `assigneeType: HUMAN` + `approvalGate` + `startable: false`; the no-chain task
  returns the empty envelope with `200`; `GET /tasks?projectId=…` returns
  `chainProgress` identical for all nine cards.

**Rollback.** Both routes are additive except the `archived` default. Reverting
restores the old behaviour with no data implications.

---

## WI-5 — API: `Start now`, archive, unarchive, archive-done, and the `BACKLOG` PATCH guard

**Goal.** Spec §4.3, §4.8-B1, §4.9, §6-E8/E9.

**Files** — `packages/api/src/app.ts` (`:1281-1349` PATCH, new routes after
`:1406`), `packages/api/src/app.test.ts` (selection-logic unit test),
`packages/api/src/tasks.dbtest.ts` (new).

**What to do**

1. `POST /tasks/:taskId/start` → `201 { runId, runNumber }`, in one
   `ReadCommitted` transaction:
   - `404` task not found;
   - `409 "Human steps cannot be started"` when `assigneeType !== AGENT` (S3);
   - `409 "Task is already done"` when `status === DONE` (S6);
   - `409 "Cannot start an archived task"` when `archivedAt !== null`;
   - `409 "Task already has an active run"` when any run is in
     `ACTIVE_RUN_STATUSES` (S2 — the double-press case);
   - `409 "Run budget exhausted"` when `runs.length >= maxSessionsPerTask` (S5);
   - archived assignee → `409` with `ArchivedAssigneeError`'s own message (S4) —
     `enqueueTaskRun` (`workflow.ts:75-77`) already throws it, so catch it with
     `isArchivedAssigneeError` and map to `409` rather than re-deriving the text;
   - otherwise `enqueueTaskRun(tx, taskId)`, flip `BACKLOG` → `TODO` in the same
     transaction (S7), and write
     `TaskActivity { actorType: "operator", body: "Started manually from the chain view" }`.
2. `POST /tasks/:taskId/archive` → `200 task`. `409 "Cannot archive a task with an
   active run"` (A3, `ACTIVE_RUN_STATUSES`); `409 "Decide the approval gate in the
   Inbox first"` when `status === REVIEW` **and** an `InboxMessage` exists with
   `gateTaskId = taskId, status: OPEN` (E9 — the exact query shape `app.ts:1336-1339`
   already uses). Sets `archivedAt = now()` and writes an activity row.
3. `POST /tasks/:taskId/unarchive` → `200 task`, sets `archivedAt = null`,
   idempotent (already-null is `200`, not an error).
4. `POST /projects/:projectId/tasks/archive-done` → `200 { archived, skipped }`
   (C4). Select `status: DONE, archivedAt: null, projectId`, partition by
   whether any run is in `ACTIVE_RUN_STATUSES`, `updateMany` the rest in one
   statement, and write one activity row per archived task.
5. `PATCH /tasks/:taskId`: `status: BACKLOG` arrives for free —
   `taskPatch` (`app.ts:226`) is `z.nativeEnum(TaskStatus)`. Add, next to the
   existing gate guard at `:1285-1287`:
   `409 "Cannot move a task with an active run to Backlog"` when the new status is
   `BACKLOG` and an active run exists (B1). Everything else in that handler,
   including the `advances` transaction at `:1329-1344`, is untouched.

**Verification**

- `app.test.ts`: `archive-done` partitioning as a pure function over fixture rows
  — only `DONE`, only unarchived, active-run rows counted as `skipped`.
- `tasks.dbtest.ts` (new file, same `setupTestDb`/`resetTestDb` preamble as
  `chain.dbtest.ts:1-13`):
  1. `start` happy path → exactly one `QUEUED` run, activity row present;
  2. double-press → second call `409`, `Run` count still 1;
  3. human step → `409`;
  4. archived assignee → `409` naming the agent;
  5. `runs.length === maxSessionsPerTask` → `409 "Run budget exhausted"`;
  6. `BACKLOG` task → `201` and the task ends `TODO`;
  7. a task whose only run is `WAITING_INBOX` → `409` (the C1 regression);
  8. archive / unarchive round trip, and `GET /tasks?projectId=…` excludes the
     archived task while `?archived=all` returns it;
  9. `archive-done` with 6 done + 1 done-with-a-running-run → `{archived:6, skipped:1}`;
  10. archive a `REVIEW` task with an OPEN gate message → `409`;
  11. `PATCH {status:"BACKLOG"}` with an active run → `409`; without one → `200`.

**Rollback.** All five routes are additive; the PATCH guard is a rejection that
did not exist. Reverting restores prior behaviour exactly.

---

## WI-6 — API: automations (schedule pause/resume, recurring fires, scheduler filters)

**Goal.** Spec §4.7, §5.2's scheduler rows, §6-E11.

**Files** — `packages/api/src/app.ts` (new routes),
`packages/api/src/scheduler.ts:99-140`, `:154-164`,
`packages/api/src/scheduler.dbtest.ts`.

**What to do**

1. `POST /tasks/:taskId/schedule/pause` → `200 task`;
   `400 "Only CRON tasks can be paused"` when `scheduleKind !== CRON`. Sets
   `schedulePausedAt = now()`. Does not touch in-flight copies.
2. `POST /tasks/:taskId/schedule/resume` → `200 task`. Clears
   `schedulePausedAt` and recomputes
   `runAt = computeNextOccurrence(task.cron, task.timezone, new Date())`
   (`scheduler.ts:12-21`) — from **now**, so a long pause produces no catch-up
   burst (M2). A `cron` that still fails to parse returns `400` with the parser's
   message and changes nothing (M3).
3. `GET /tasks/:taskId/recurring-fires?take=5` → the newest copies by
   `recurringSourceTaskId`, `orderBy: { createdAt: "desc" }`, each with
   `{ taskId, name, createdAt, status, latestRun {id,status,runNumber,session{costUsd}}|null }`.
   `take` is clamped to 1..50 and defaults to 5 ([A11]). Empty array when the
   copies were deleted (E11).
4. `scheduler.ts`:
   - `schedulerTick`'s cron query (`:156`) gains `schedulePausedAt: null` and
     `archivedAt: null`; the AT query (`:157-163`) gains `archivedAt: null`.
   - `fireCronTask`'s claim `where` (`:101`) **also** gains `schedulePausedAt: null`,
     so a pause landing between the poll and the claim wins the race instead of
     firing one more copy.
   - the copy created at `:106-129` gains `source: TaskSource.CRON` and
     `recurringSourceTaskId: task.id`. The recurring definition itself stays
     `MANUAL` (§4.10).

**Verification**

- `scheduler.dbtest.ts`, new tests: a `schedulePausedAt` task is not fired across
  a simulated due time (`schedulerTick(db, futureNow)` → `cronFired: 0`); resume
  puts `runAt` strictly in the future and the next tick fires exactly one copy;
  the fired copy has `source='cron'` and `recurringSourceTaskId` = the definition;
  an archived recurring task does not fire. Its six existing tests must stay green
  — particularly `"paused definitions do not fire…"` (`:59`), which uses the
  *status* mechanism and must keep working alongside the new flag.
- `tasks.dbtest.ts`: pause on a `NOW` task → `400`; resume with an unparseable
  cron → `400` and `schedulePausedAt` unchanged.

**Rollback.** Additive routes plus two `where` predicates; reverting restores the
prior firing behaviour and leaves `schedulePausedAt` as an ignored column.

---

## WI-7 — API: the fire ledger, replay window, trigger pause, and `Fire now`

**Goal.** Spec §4.5, §4.6, §5.2's trigger rows, §6-E5/E6/E7/E13.

**Files** — `packages/api/src/templates.ts:25-107`,
`packages/api/src/app.ts:326-330` (`webhookConfigPatch`), `:473-505` (the hook),
new trigger routes; `packages/api/src/hooks.dbtest.ts`;
`packages/api/src/triggers.dbtest.ts` (new).

**What to do**

1. `instantiateTemplate` options gain `source?: TaskSource` (stamped on every
   `tx.task.create` at `:71-85`, default `MANUAL`) and
   `fire?: { source, dedupeKey }` (C2), which creates the `TriggerFire` row inside
   the same transaction with the chain's `chainId`.
2. `webhookConfigPatch` gains
   `webhookReplayWindowSec: z.number().int().min(0).max(86400).nullable().optional()`.
   `0` and `null` both mean disabled — normalise `0` → `null` on write so the
   read side has one representation.
3. `POST /hooks/templates/:templateId` (`app.ts:473-505`):
   - **paused → `401`, byte-identical to a wrong secret** (T4, §5.5). Implement it
     inside `authenticateWebhook` (`packages/api/src/hooks.ts:48`) by adding
     `|| template.webhookPausedAt` to the existing null-return condition, so
     there is exactly one place that can produce the `401` and no second response
     shape can drift into existence.
   - replay: when `webhookReplayWindowSec > 0`, compute
     `dedupeKey = header "X-AgentOS-Delivery-Id" ?? sha256(raw body)`. Read the
     raw body **once** (`await context.req.text()`, then `JSON.parse`) — the
     current code calls `context.req.json()` at `:482` and the body cannot be read
     twice. Look for a `TriggerFire` with the same `(templateId, dedupeKey)` and
     `createdAt > now - window`; on a hit return
     `200 { duplicate: true, chainId }` and create nothing. The
     `@@index([templateId, dedupeKey, createdAt])` from WI-1 serves this lookup.
   - on a real fire, pass
     `{ source: TaskSource.WEBHOOK, fire: { source: TriggerFireSource.WEBHOOK, dedupeKey } }`.
   - `X-AgentOS-Delivery-Id` must be added to the CORS `allowHeaders` list at
     `app.ts:444`.
4. `GET /projects/:projectId/triggers` → templates with `webhookSecretId != null`,
   returning `{ id, name, description, repo {id,name}, stepCount, paused,
   secretDisabled, lastFiredAt, fireCount }`. `fireCount`/`lastFiredAt` come from
   **one** `triggerFire.groupBy({ by: ["templateId"], _count, _max: { createdAt } })`
   over the listed ids — never per row (E5). `secretDisabled` reads
   `webhookSecret.disabledAt` through an explicit
   `select: { disabledAt: true }` — never `include: { webhookSecret: true }`.
5. `GET /triggers/:templateId` → the detail envelope of §5.2, including
   `endpointPath`, `secretName`, `variables`, `mapping`, `defaults`,
   `replayWindowSec`, `paused`, `stepCount`, `fireCount`, `lastFiredAt`, and
   `canFire`/`cannotFireReason` so E13 (zero-step template) renders inline instead
   of only failing on press. **No secret value, ever.**
6. `GET /triggers/:templateId/fires?take=20` → newest fires with
   `{ id, createdAt, source, chainId, firstTask {id,name}|null, progress|null }`.
   Resolve all referenced chains in one `findMany` + `chainProgressByChain`
   (WI-4); a fire whose chain no longer exists returns `firstTask: null,
   progress: null` (the UI renders `chain deleted`).
7. `POST /triggers/:templateId/pause` / `/enable` → `200 { paused }`.
8. `POST /task-templates/:templateId/fire` (C6 — spec path kept):
   body `{ variables?: Record<string,string> }`; merge over
   `webhookPayloadMapping.defaults`; unresolved names → `400 { error, unresolved }`
   (reuse `resolvePayloadVariables`'s vocabulary, `hooks.ts:22-40`); succeeds on a
   paused trigger ([A5]); calls `instantiateTemplate` with
   `{ source: MANUAL, fire: { source: TriggerFireSource.MANUAL } }`; maps
   `instantiateTemplate`'s thrown `"Template has no steps"` to `400` (the regex at
   `app.ts:1203` already covers `has no`); returns
   `201 { chainId, taskIds, fireId }`.

**Verification**

- `hooks.dbtest.ts`, extended: paused trigger with the correct secret → `401` and
  a body **byte-identical** to a wrong-secret call (assert on the serialized body,
  not just the status), and zero `TriggerFire` rows; two identical deliveries 3 s
  apart with window 300 → one chain, one ledger row, second response
  `200 {duplicate:true}`; the same pair outside the window → two chains, two
  rows; window disabled → two chains (unchanged W8 behaviour); the existing
  "never include the Secret relation" test (`:98`) extended to cover
  `GET /projects/:id/triggers` and `GET /triggers/:id`.
- `triggers.dbtest.ts` (new): `Fire now` on a fully-defaulted trigger → exactly
  **one** `QUEUED` `Run` across the whole new chain
  (`db.run.count({ where: { task: { chainId } } }) === 1`, the §2.5-2 assertion)
  and exactly one `MANUAL` `TriggerFire`; unresolved variable → `400`, zero tasks,
  zero fires; zero-step template → `400`; the triggers list reports
  `fireCount`/`lastFiredAt` from the ledger; a disabled secret surfaces
  `secretDisabled: true`.

**Rollback.** All routes additive. The hook's two behaviour changes (paused
`401`, duplicate `200`) revert with the code; the ledger is append-only and read
by nothing else.

---

## WI-8 — Web: types, the two pure modules, `cronstrue`, and the `BACKLOG` tone

**Goal.** Spec §5.4's pure leaves. Nothing renders yet; every subsequent web item
is mechanical once this lands.

**Files** — `apps/web/src/lib/types.ts:4`, `:224-249`;
`apps/web/src/lib/chain.ts` (new); `apps/web/src/lib/schedule.ts` (new);
`apps/web/src/components/ui.tsx:117`; `apps/web/package.json`;
`apps/web/src/tests/chain.test.tsx`, `apps/web/src/tests/schedule.test.tsx` (new).

**What to do**

1. `types.ts`: `TaskStatus` union gains `"BACKLOG"`; `Task` gains `chainId`,
   `chainIndex`, `source: TaskSource`, `archivedAt`, `schedulePausedAt`,
   `recurringSourceTaskId`, `templateStep: { name: string } | null`, and
   `chainProgress: ChainProgress | null`. New exported types `TaskSource`,
   `ChainProgress`, `ChainStep`, `Trigger`, `TriggerDetail`, `TriggerFire`,
   `RecurringFire`.
2. `ui.tsx:117`: `taskTones.BACKLOG = "grey"`. The `Record<TaskStatus, PillTone>`
   is exhaustive, so the build fails until this is added — which is the point.
3. `lib/chain.ts`: **marker formatting only** —
   `chainMarker(progress) => \`${done}/${total} · ${activeStepName} · ${activeStatus}\``,
   returning `null` when `progress` is null. The arithmetic itself is the API's
   (WI-4); the web must not own a second implementation that can disagree with the
   board's own numbers.
4. `lib/schedule.ts`: `cronProse(expr, timezone)` wrapping `cronstrue`
   (`toString(expr, { throwExceptionOnParseError: true })`) inside try/catch,
   returning the **raw expression** on any throw (E10 — never an exception
   string); `nextRunLabel(runAt)` over `timeAgo`; `automationState(task)` →
   `"active" | "paused" | "quarantined"` per §4.7 (`paused` when
   `schedulePausedAt !== null`; `quarantined` when `runAt === null` and not
   paused; else active).
5. `apps/web/package.json` dependencies gain `"cronstrue": "^3.24.0"`; run
   `npm install` at the **root** (workspaces) so `package-lock.json` updates in
   the same commit.

**Verification**

- New tests in `apps/web/src/tests/` — the package's test glob is
  `src/**/*.test.tsx`, which npm runs through `sh`, where `**` behaves as `*`;
  only files exactly one directory below `src/` and ending `.test.tsx` are
  collected. Existing tests all live in `src/tests/`; new ones must too.
- `chain.test.tsx`: `4/9 · Implementation · doing` formatting; `null` progress →
  `null` marker.
- `schedule.test.tsx`: `cronProse("0 9 * * *", "Asia/Shanghai")` reads as English
  prose; a `cronstrue`-rejected expression returns the raw string verbatim and
  contains no `Error`; a null timezone does not throw; `automationState` over the
  three shapes.
- `npm run build && npm test -w @agentos/web`.

**Rollback.** Reverting drops the dependency and the two modules; nothing else
imports them until WI-9.

---

## WI-9 — Web: the tab shell, four routes, the sidebar, and the `Archived` page

**Goal.** Spec §4.4 and §4.9's `Archived` tab. The `Archived` page is the
simplest of the three new pages, so it lands with the shell and proves it.

**Files** — `apps/web/src/components/tasks-tabs.tsx` (new);
`apps/web/src/pages/Archived.tsx` (new); `apps/web/src/App.tsx:18-33`;
`apps/web/src/components/Shell.tsx:21-31`; `apps/web/src/pages/Tasks.tsx:294-304`;
`apps/web/src/tests/tasks-tabs.test.tsx` (new).

**What to do**

1. `components/tasks-tabs.tsx` exports `TasksPageHead({ active, children })`
   rendering the existing `PAGE_HEAD` block (lifted verbatim from
   `Tasks.tsx:294-302`, `+ Create Task` included) plus a `Segmented`
   (`ui.tsx:211-238`) with
   `[{tasks,"Tasks"},{automations,"Automations"},{triggers,"Triggers"},{archived,"Archived"}]`,
   whose `onChange` calls `navigate("/" + value)`. Four tabs — `My Tasks` is
   dropped per §2.5-4. The `+ Create Task` panel stays owned by `Tasks.tsx`;
   the head takes an `actions` slot so the other three pages render the head
   without a creation panel.
2. `App.tsx`: four route entries — `/automations`, `/triggers`,
   `/triggers/:templateId`, `/archived`. Siblings of `/tasks`, because
   `matchRoute` (`router.tsx:28-40`) compares segment counts and `/tasks/:taskId`
   already owns the second segment.
3. `Shell.tsx:22`: the Tasks NAV entry's `match` becomes
   `["/tasks", "/automations", "/triggers", "/archived"]`. `active()` (`:67-68`)
   already prefix-matches, so `/triggers/:id` highlights `Tasks` too.
4. `pages/Archived.tsx`: `usePoll<Task[]>('/tasks?projectId=…&archived=true')`,
   rendered as a `Table` (not a board): `Name / Status / Agent / Chain / Archived`
   + a `RowMenu` with `Unarchive`. `Chain` renders `chainMarker(task.chainProgress)`
   or `—`. Newest `archivedAt` first, sliced to 200 with a
   `Showing the 200 most recently archived` footer when the slice bit ([A7]).
   Empty state: `Nothing archived yet.`
5. **All four routes are registered in this commit**, and
   `pages/Automations.tsx` / `pages/Triggers.tsx` land here as `EmptyState` stubs
   (`Loading…`-style placeholder, one screen each), replaced wholesale in WI-12
   and WI-13. The alternative — registering each route with its page — leaves two
   commits in which a rendered tab navigates to the unknown-route notice. Stubs
   keep every commit green and every tab clickable.

**Verification**

- `tasks-tabs.test.tsx` (`renderToStaticMarkup`, the harness
  `apps/web/src/tests/task-detail.test.tsx:1-10` establishes): the head renders
  exactly four tab labels in order; the active one carries the `bg-accent` class
  the `Segmented` applies; an `Archived` table with one chain row renders the
  marker text and one without renders `—`; the 200-row footer appears at 201 rows
  and not at 200.
- `npm run build && npm test -w @agentos/web`.

**Rollback.** Revert the four route entries and the NAV `match` array; the board
is untouched by this item.

---

## WI-10 — Web: the board (Backlog column, chain marker, source pills, Archive All)

**Goal.** Spec §4.2, §4.8, §4.9's `Archive All` and per-card `Archive`, §4.10.

**Files** — `apps/web/src/pages/Tasks.tsx` (`:35-40` columns, `:65-105` card,
`:277-288` actions, `:294-332` render), `apps/web/src/tests/tasks-board.test.tsx`
(new).

**What to do**

1. `COLUMNS` gains `{ status: "BACKLOG", label: "Backlog" }` as the **first**
   entry. Drag-and-drop needs no change: `move` (`:277-281`) already PATCHes any
   status and already no-ops on a same-column drop (`:279` — §6-E15).
2. `move` must surface the new `409`s. `useAction`'s `error` already renders
   through the `ErrorNotice` at `:308`, and `reload()` sits inside the `run`
   callback after the PATCH, so a rejection skips it. Note for the reviewer: the
   board is **not** optimistic — cards render from polled data — so B1's "card
   snaps back" is satisfied by the card never having moved, not by a revert path.
   B4 needs no code either: dragging out of `Backlog` PATCHes status only and
   enqueues nothing ([A6]).
3. `TaskCard` meta block (`:85-93`) gains, between the pill row and the run line,
   the single marker line:
   ```tsx
   {task.chainProgress ? (
     <div className={cn(TASK_META_ROW, "overflow-hidden text-ellipsis whitespace-nowrap")}>
       {chainMarker(task.chainProgress)}
     </div>
   ) : null}
   ```
   No placeholder for chain-less cards (K4).
4. Source pills in the existing pill row (`:86-90`):
   `task.source === "CRON" ? <Pill tone="grey">cron</Pill> : task.source === "WEBHOOK" ? <Pill tone="accent">webhook</Pill> : null`
   — `MANUAL` renders nothing ([A8]).
5. `RowMenu` (`:80-83`) gains `Archive` → `POST /tasks/:id/archive` then `reload()`.
6. The `Done` column header gains `Archive All`, rendered only when that column is
   non-empty (A2). `window.confirm(\`Archive ${n} done tasks?\`)` (the precedent is
   `remove` at `:283`), then `POST /projects/:projectId/tasks/archive-done`, then
   `reload()`. When the response has `skipped > 0`, surface
   `Archived ${archived}, skipped ${skipped} (running)` through the existing
   notice area (E8).
7. Replace the placeholder `Segmented` at `:304` with `TasksPageHead` from WI-9
   and delete the now-duplicated head block.

**Verification**

- `tasks-board.test.tsx`: five columns render in `Backlog, Todo, Doing, Review,
  Done` order and a `BACKLOG` task lands in the first; a chain card renders
  `3/9 · Implementation · doing` and a chain-less card renders no marker; `cron`
  and `webhook` pills render and a `MANUAL` task renders neither string;
  `Archive All` is absent with an empty `Done` and present with one card;
  `Backlog` with zero cards renders `Drop tasks here` (E16).
- Manual (against the live API on `:3000` — never a second control plane): drag a
  running task to `Backlog` → refused with a message, card snaps back.

**Rollback.** Revert `Tasks.tsx`. Any task already sitting in `BACKLOG` becomes
invisible on the board until the `UPDATE … SET status='todo'` of §16 runs — call
that out in the runbook line, it is the one user-visible rollback trap in the
batch.

---

## WI-11 — Web: the chain card and `Start now` on task detail

**Goal.** Spec §4.1, §4.3, §4.9-A6, §6-E3/E14.

**Files** — `apps/web/src/components/chain-list.tsx` (new);
`apps/web/src/pages/TaskDetail.tsx` (`:170` statuses, `:201-233` header,
`:235-265` details/insert point); `apps/web/src/tests/chain-list.test.tsx` (new).

**What to do**

1. `components/chain-list.tsx` takes the `GET /tasks/:taskId/chain` envelope and
   the open task's id, and renders a `Card` titled `Chain` with
   `extra={<span className={COUNT}>{done}/{total}</span>}`. One row per step, left
   to right: position · step name (a `Link` to `/tasks/<id>`) · `AgentChip`
   (`ui.tsx:143`, `Human` for `assigneeType === "HUMAN"`, `Unassigned` when no
   agent) · a lock glyph with
   `title="requires approval before unblocking dependents"` when `approvalGate` ·
   `TaskPill` · a grey `archived` pill when `archivedAt` · a right-aligned
   `Start now` button when `step.startable`.
   - The open task's row gets an accent left border + `bg-accent` and the text
     `You are here` ([A3]).
   - `failureReason` (or `Parked in Backlog` when `status === "BACKLOG"`) renders
     as a muted sub-line under the step name.
   - E3: render `steps.slice(0, 50)` with a `Show all N steps` button when longer,
     local `useState` (`ShowMore` is text-only and cannot be reused here).
2. `TaskDetail.tsx`:
   - `usePoll<ChainEnvelope>('/tasks/:id/chain')` at the page's default cadence
     (no new loop, §4.1); render `<ChainList>` **directly under `Details` and
     above `Prompt`**, and only when `data?.chainId !== null` (C3 of §4.1 — no
     empty state).
   - `Start now` calls `POST /tasks/:id/start` through `useAction`, shows the
     pending state, reloads both polls on success, and lets the existing
     `ErrorNotice` at `:223` render the API's 409 text.
   - `STATUSES` (`:170`) gains `"BACKLOG"` first, so the header select can park a
     task.
   - header (`:201-220`) gains an `archived` `Pill` when `task.archivedAt` and an
     `Archive` / `Unarchive` button beside `Retry` (A6).
3. E14 needs no code: `usePoll` surfaces the `404` and the page's existing
   `error !== null && task === null` branch (`:178-180`) renders it.

**Verification**

- `chain-list.test.tsx`: a nine-step envelope renders nine rows; exactly one row
  carries `You are here`; exactly one lock per gated step and the `title` text
  appears **verbatim**; a `HUMAN` step renders `Human` and no `Start now`; a
  sparse-index envelope renders positions `1 2 3` with header `1/3` (the brief's
  skipped-step check, K2/§8.3); a 60-step envelope renders 50 rows plus
  `Show all`; an archived row renders the `archived` pill.
- `npm run build && npm test -w @agentos/web`.

**Rollback.** Revert both files; the API route stays and is simply uncalled.

---

## WI-12 — Web: the `Automations` page

**Goal.** Spec §4.7, §6-E10/E11.

**Files** — `apps/web/src/pages/Automations.tsx` (replaces the WI-9 stub);
`apps/web/src/tests/automations.test.tsx` (new).

**What to do**

- `usePoll<Task[]>('/tasks?projectId=…')` filtered client-side to
  `scheduleKind === "CRON" && archivedAt === null` — the board query already
  returns exactly this set, so the page adds no endpoint (spec §4.7 says "every
  non-archived Task with scheduleKind = CRON"; reusing the board's poll keeps one
  source of truth and one cache).
- Columns `Title / Agent / Schedule / Status / Last run`, a chevron, and a
  `RowMenu` (`Pause`/`Resume`, `Open task`, `Delete`).
- `Schedule` = `cronProse(task.cron, task.timezone)` with the muted sub-line
  `` `${task.cron} · ${task.timezone ?? "UTC"}` ``.
- `Status` = `automationState(task)` → `Active` (green, sub-line
  `Next run ${timeAgo(runAt)}`) / `Paused` (amber) / `Quarantined` (red, sub-line
  `Fix the cron expression`). When `task.status === "BACKLOG"`, append a muted
  `in Backlog` note next to `Active` (B5, O3).
- `Last run` = the newest `recurring-fires` entry's `createdAt`, else `Never`.
- Expanded row polls `GET /tasks/:id/recurring-fires?take=5` **only while
  expanded** (pass `null` to `usePoll` when collapsed — that is the hook's
  documented idle mode, `hooks.ts:32-37`), listing fire time · run-status pill ·
  cost · a `Link` to the copy · a session link when the run has one, plus
  `View all sessions →` to `/sessions`. Empty → `No sessions yet` (E11).
- Empty state (M5): lightning glyph, `No automations yet`, and the sentence
  explaining that a task with a cron schedule becomes an automation.

**Verification**

- `automations.test.tsx`: `0 9 * * *` renders English prose plus the raw
  sub-line; a `cronstrue`-rejected expression renders the raw expression and the
  markup contains no `Error`; the three status shapes render their pills; a
  `BACKLOG` cron task renders `Active` **and** `in Backlog`; an automation with no
  copies renders `Never` and `No sessions yet`.
- Manual (§8.8): pause across one occurrence → no fire; resume → `runAt` in the
  future.

**Rollback.** Revert the page to its stub; the API routes stay unused.

---

## WI-13 — Web: the `Triggers` list and detail pages

**Goal.** Spec §4.5, §4.6, §6-E13.

**Files** — `apps/web/src/pages/Triggers.tsx` (list + detail, replacing the WI-9
stub); `apps/web/src/tests/triggers.test.tsx` (new).

**What to do**

1. **List** (`/triggers`) — `usePoll<Trigger[]>('/projects/:id/triggers')`.
   Columns `Name / Target / Status / Last fired / Fires`; the name links to
   `/triggers/:id` with the description as a muted, ellipsized sub-row;
   `Target` = `` `${repo.name} · ${stepCount} steps` `` ([A4]); `Status` =
   `Enabled` (green) / `Paused` (amber) / `Disabled secret` (red, when
   `secretDisabled`); `Fires` renders `0` as `0`, never `—`. `RowMenu`:
   `Fire now`, `Pause`/`Enable`, `Open`. Empty state verbatim from §4.5.
2. **Detail** (`/triggers/:templateId`) — header with back link, name, `Template`
   pill, the enabled/paused pill, `⏸ Pause` / `▶ Enable`, `⚡ Fire now`, then four
   cards in order:
   - **Endpoint** — read-only `POST <apiBase>/hooks/templates/<id>`, a copy
     button, the header name `X-AgentOS-Webhook-Secret`, and the **name** of the
     configured secret. No value is fetched and none can be: no route returns one.
     `secret-value-input.tsx` exists but must **not** be reused here.
   - **Default variables** — a row per `variables[]` with the mapped path (as
     code) or `—`, the default literal or `—`, and a red `required` badge when the
     variable has neither. Both fields inline-editable; one
     `PATCH /task-templates/:id` for the whole card on `Save changes`, sending the
     merged `webhookPayloadMapping` (`{ map, defaults }` — the whole object, since
     the zod schema at `app.ts:322-325` replaces it wholesale).
   - **Delivery** — `Replay window (seconds)` number input, empty/`0` = disabled,
     `min 1 max 86400`, with the hint from §4.6, saved by the same `Save changes`.
   - **Recent fires** — `GET /triggers/:id/fires?take=20`: relative time, a
     `webhook`/`manual` source pill, the chain's first task name (linked), and the
     chain progress via `chainMarker`. A fire whose chain is gone renders
     `chain deleted`.
   - `canFire === false` renders `cannotFireReason` inline above `Fire now` (E13).
3. `Fire now` → `POST /task-templates/:id/fire`, then `reload()`; the new fire is
   the first `Recent fires` row on the next poll (T1). It stays enabled while
   paused ([A5]). A `400` with `unresolved` renders those names in the
   `ErrorNotice` (T2).

**Verification**

- `triggers.test.tsx`: the `required` badge renders **only** for a variable with
  neither a mapping nor a default; **the rendered markup contains no secret value
  and no `OPERATOR_TOKEN`** (assert `doesNotMatch` against the fixture's secret
  string); `Fires: 0` renders as `0`; a paused trigger renders the `Paused` pill
  while `Fire now` stays enabled; a fire with a null chain renders
  `chain deleted`.
- Manual (§8.5-8.7): `Fire now` → exactly one new chain and one `Run`; `curl` the
  same payload twice with window 300 → second is `200 {"duplicate":true}`; paused
  + correct secret → `401` with a body identical to a wrong secret.

**Rollback.** Revert the page; the trigger routes stay unused.

---

## 14. Requirement → work-item traceability

| Spec | Requirement | Work item |
|---|---|---|
| §4.1 | Chain card, rows, lock, highlight, parked sub-line, C1–C6 | WI-4 (data), WI-11 (render) |
| §4.2 | Kanban marker, K1–K5 | WI-4 (`chainProgress`), WI-8 (`chainMarker`), WI-10 |
| §4.3 | `Start now`, S1–S7 | WI-4 (`startable`), WI-5 (route), WI-11 (button) |
| §4.4 | Four tabs, five routes, shared head, sidebar | WI-9 |
| §4.5 | Triggers table, all six columns | WI-7 (list route), WI-13 |
| §4.6 | Trigger detail, four cards, T1–T8 | WI-7, WI-13 |
| §4.7 | Automations table, M1–M5 | WI-6, WI-8 (`cronProse`), WI-12 |
| §4.8 | `Backlog` column, B1–B5 | WI-1 (enum), WI-3 (park), WI-5 (guard), WI-10 |
| §4.9 | `Archive All`, `Archived` view, A1–A6 | WI-5, WI-9, WI-10, WI-11 |
| §4.10 | Source badges | WI-1, WI-2, WI-6, WI-7, WI-10 |
| §5.1 | Schema + migration + backfill | WI-1, WI-2 |
| §5.2 | Every new/changed endpoint | WI-4…WI-7 |
| §5.3 | Parked successors | WI-3 |
| §5.4 | Frontend modules + `cronstrue` | WI-8…WI-13 |
| §5.5 | What must not change | No work item touches run claiming, leases, reconciliation, gate semantics, or the webhook `401` surface; WI-7 §3 keeps the `401` in one place, WI-5 leaves `app.ts:1285-1287` intact |
| §6-E1 | null `chainIndex` → `1/1` | WI-4 (C8) |
| §6-E2 | `projectId`-scoped chain query | WI-4 |
| §6-E3 | 200-step chain → 50 + `Show all` | WI-11 |
| §6-E4 | No N+1 for `chainProgress` | WI-4 (C5) |
| §6-E5 | 601 fires → count + `take:20` + index | WI-1 (index), WI-7 |
| §6-E6 | Concurrent manual + webhook fire | WI-7 (existing serialization retry) |
| §6-E7 | Same-millisecond duplicates accepted | WI-7 (documented, [A10]) |
| §6-E8 | `Archive All` skips running | WI-5 (C4), WI-10 |
| §6-E9 | Open gate refuses archive | WI-5 |
| §6-E10 | `cronstrue` throw → raw expression | WI-8 |
| §6-E11 | Copies all deleted | WI-6, WI-12 |
| §6-E12 | 500 on a new endpoint | Existing `ErrorNotice` + `onRetry`; no new code |
| §6-E13 | Zero-step template | WI-7 (`canFire`), WI-13 |
| §6-E14 | Task deleted mid-view | Existing `TaskDetail.tsx:178-180` |
| §6-E15 | Same-column drop | Existing `Tasks.tsx:279` |
| §6-E16 | Empty `Backlog` | WI-10 |
| §7 | Every listed test | WI-1…WI-13 verification blocks; §7-23's migration test becomes a backfill test per C3 |
| §8 | Reviewer verification | §15's manual checklist |
| §9 | Rollback | §16 |

---

## 15. Sequencing, migration and restart steps, PR mechanics

**Branch.** One feature branch, thirteen commits, one PR. Do not merge (chain
standing rule).

**Hard dependencies** (everything else may be reordered within its layer):

```
WI-1 ─┬─ WI-2
      ├─ WI-3 ────────────────┐
      └─ WI-4 ─┬─ WI-5 ───────┤
               ├─ WI-6        │
               └─ WI-7        │
WI-8 (after WI-1's enum) ─ WI-9 ─┬─ WI-10 (also needs WI-3, WI-5)
                                 ├─ WI-11 (needs WI-4, WI-5)
                                 ├─ WI-12 (needs WI-6)
                                 └─ WI-13 (needs WI-7)
```

**WI-3 must land before WI-10.** WI-10 is the first thing that can put a task in
`BACKLOG`; WI-3 is what stops that hanging run completion. Landing them in the
other order leaves a window where a mid-branch dogfood run can wedge a database
transaction.

**Migration and restart procedure (dev, and again for deploy):**

1. `npm run db:validate`
2. `npm run db:migrate` — applies `20260816180000_task_status_backlog` then
   `20260816180100_tasks_visibility`.
3. `npm run db:generate` (the root `postinstall` does this; run it explicitly
   after a hand-edited migration).
4. `npm run db:drift-check` → exit 0.
5. `npm run db:backfill-task-source` (WI-2) — idempotent, safe to re-run.
6. `npm run build` at the root.
7. **Restart the API process** so the new Prisma client and the scheduler's new
   filters are live. The scheduler runs in-process (`scheduler.ts:196-210`), so an
   un-restarted API keeps firing paused automations.
   **Do not touch launchd services or restart the runner** (chain standing rule):
   the runner needs no restart — nothing in its contract changed — and service
   management is the operator's call. If the API is under launchd, hand the
   restart to Leo in the PR description rather than doing it.
8. Web is a static bundle; `npm run build -w @agentos/web` and reload.

**Test gate before the PR is considered done:**

```bash
npm run build && npm test && npm run test:db -w @agentos/api && npm run typecheck
```

Paste the output into the PR (spec §8.1).

**Manual reviewer checklist** — spec §8's eleven steps, unchanged, with the hard
rule restated: browse the **live API on `:3000`**, or a scratch database built
from migrations with fixture rows. Never start a second control plane against the
live database or a copy of it; the second reconciler classifies live runs as
orphans and deletes their workspaces.

Step 11 (secret hygiene) is mechanical and should be run as written:

```bash
grep -r "<the webhook secret value>" apps/web/dist packages/*/src | wc -l   # expect 0
grep -rn "OPERATOR_TOKEN" apps/web/dist packages/api/src/*.dbtest.ts        # expect 0
```

---

## 16. Rollback, per section

**Global note (the one trap).** `TaskStatus.BACKLOG` is the only irreversible-ish
piece. Before rolling the **API** back to a build without the enum member, run:

```sql
UPDATE "Task" SET status = 'todo' WHERE status = 'backlog';
```

Otherwise Prisma throws while deserializing those rows. Ship this as a line in
`docs/runbooks/` (new file `docs/runbooks/batch-2.5-rollback.md`, alongside the
existing `files-deployment.md`) — not as folklore in a PR comment.

| Section | Rollback | Data lost |
|---|---|---|
| WI-1 schema | Code-only revert is safe: every new column is nullable or defaulted and old code ignores them. Full schema revert per spec §9, in reverse order; the `backlog` enum value **stays** (dropping it rewrites a hot table) | none, until the schema revert |
| WI-2 backfill | Re-runnable; revert code and leave data, or `UPDATE "Task" SET source='manual', "recurringSourceTaskId"=NULL` + `DELETE FROM "TriggerFire" WHERE source='webhook'` | source attribution, backfilled fires |
| WI-3 workflow | Revert **only together with WI-10**; without the guard a `BACKLOG` task hangs run completion | none |
| WI-4 chain API | Additive except the `GET /tasks` `archived` default; revert restores prior behaviour | none |
| WI-5 task lifecycle | All additive; the `BACKLOG` PATCH guard is a rejection that did not exist | none |
| WI-6 automations | Two `where` predicates revert; `schedulePausedAt` becomes an ignored column and paused automations **resume firing** — run the pause-equivalent by hand (move them out of `TODO`) before reverting | pause state |
| WI-7 triggers | Additive routes; the hook's paused-`401` and duplicate-`200` revert with the code; the ledger is append-only and unread elsewhere | replay protection, pause state, ledger |
| WI-8 web leaves | Revert drops `cronstrue` from `package.json` + lock | none |
| WI-9 tabs | Revert the four routes and the NAV `match`; `#/automations` becomes the existing unknown-route notice | none |
| WI-10 board | Revert hides any `BACKLOG` task from the board until the `UPDATE` above runs — the one user-visible trap | none |
| WI-11 chain card | Revert the two files; the API route goes unused | none |
| WI-12/13 pages | Revert the page; routes 404 into the existing notice | none |

---

## 17. Where this plan is guessing, and known gaps it does not close

- **G1 — enum value positioning.** `ALTER TYPE … ADD VALUE 'backlog' BEFORE 'todo'`
  is chosen so the DB's value order matches the Prisma datamodel, on the belief
  that `prisma migrate diff` compares enum values as an ordered list. If
  `db:drift-check` disagrees, use the unpositioned form and move `BACKLOG` to the
  end of the enum. **The drift check is the arbiter; do not argue with it.**
- **G2 — `cronstrue` under `node --test`.** The web tests run through `tsx`
  without Vite. `cronstrue` ships both CJS and ESM builds and should import
  cleanly, but this was not executed. If the import fails under the test runner,
  spec §5.4's stated fallback applies: a hand-written formatter for the shapes we
  use, with `cronProse` degrading to the raw expression rather than
  mis-describing one ([A9]).
- **G3 — `chainProgress` cost at real volume.** The two-query design (C5) is
  reasoned, not measured. At dogfood volume (hundreds of tasks) it is
  irrelevant; the `@@index([projectId, archivedAt, status])` covers the board
  query and `@@unique([chainId, chainIndex])` covers the chain query.
- **G4 — the `Show all` threshold of 50** (E3) is the spec's number, not a
  measured one. No 200-step template exists.
- **G5 — `X-AgentOS-Delivery-Id` as the dedupe key header.** The spec names it;
  no real external sender has been configured, so the header name is a
  convention this batch invents. The `sha256(raw body)` fallback is what will
  actually fire in dogfood.
- **F1 (follow-up, not fixed here) — the retry guard's narrower active-run set**
  (`app.ts:1369` omits `PROVISIONING` and `WAITING_INBOX`). Pre-existing;
  changing it changes existing behaviour and its tests. Worth a backlog line.
- **F2 (follow-up, not fixed here) — a step parked in `REVIEW` by an archived
  assignee has no UI release path** (C7). Visible via the `failureReason`
  sub-line, but the operator must edit the status by hand after unarchiving the
  agent.
- **F3 — `PATCH /tasks/:id` can still set `status: DONE` on a chain step and
  advance the chain** (`app.ts:1329-1344`). Unchanged by this batch, and correct
  for non-gated steps, but it means the board's drag-to-Done is a second way to
  advance a chain alongside run completion. Noted so a reviewer does not read it
  as new.

---

## 18. Open questions carried forward (recorded, never blocking)

Spec §11's four, unchanged and unresolved — all deliberately answered by the
spec's simplest reading, all cheap to reverse:

- **O1** — `Archived` lists one row per task, not per chain. A nine-step chain
  archives as nine rows.
- **O2** — `+ New Trigger` is not built; the Triggers tab configures existing
  templates only, until template creation exists in the UI.
- **O3** — a `CRON` task in `Backlog` stops firing but the Automations tab still
  reads `Active` (with the `in Backlog` note WI-12 renders).
- **O4** — `Fires` counts manual fires as well as webhook ones.

One added by this plan:

- **O5** — the trigger endpoints straddle two base paths
  (`/triggers/:id/pause` vs `/task-templates/:id/fire`, C6). Implemented as the
  spec writes them so the reviewer's checklist stays valid. Worth unifying under
  `/triggers/:id/*` in a later batch, together with the template-creation UI that
  O2 waits on.
