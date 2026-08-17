# PLAN — Batch 2.5: tasks visibility (chain view, triggers & automations UI, kanban completeness)

Status: **revision 1, verified** (review findings applied, then every anchor
re-read) · Author: plan agent (chain step ④) · Date: 2026-08-16
Spec: `docs/specs/batch-2.5-tasks-visibility.md` (approved, commit `2802d36`).
Review answered by this revision: `docs/reviews/2026-08-16-batch-2.5-plan-review.md`
(**FAIL — 13 must-fix, 4 should-fix**, against plan commit `cd05b9c`).
Authority behind the spec: `docs/BACKLOG-V2.md` 批次 2.5 · `docs/reference/danny-agentos-video/detail-gaps.md` §2/§4/§5/§6 · `decisions.md` §12.
Plan verified against the working tree at commit `2802d36`. Every file, line
anchor, constant and query quoted below was re-read in the source — once while
writing revision 0, and again for every line the review cites while writing
revision 1. §0.2 lists the places where the code contradicts or under-specifies
the spec (C1–C11), **§0.3 is the disposition of all seventeen review findings**,
§0.4 is the binding errata against the approved spec, and §17 lists everything
this plan is still guessing about.

**Revision 1 in one paragraph.** All 13 must-fix findings are applied; all 4
should-fix findings are applied, one of them (S2) partially, with the declined
half and its reason recorded in §0.4 — nothing is dropped silently. The three
findings that changed the *shape* of the batch rather than one work item are
M4 (there is now **one** exclusion protocol — the Task row is the mutex — C9),
M6/M7/M11 (the web client cannot carry structured payloads or success results,
so the API sends prose and the pages own explicit result state — C10), and M8
(`usePoll` keeps stale data on error, so "the 404 renders itself" was false —
C11). Those three are cross-cutting and are written once in §0.2, not repeated
per page.

**Verification pass (same chain step, after revision 1 was written).** Every file,
line anchor and API shape revision 1 introduced was re-read in the tree at
`2802d36` before this document was persisted: `ApiError.status` and `parseError`
(`apps/web/src/lib/api.ts:19-48`, which is what makes C11's `fatal` and C10's
prose-error rule correct), `api.post<T>` returning the parsed body (`:70-77`,
WI-10's `Archive All` notice), `useAction`'s `boolean` (`hooks.ts:66-88`),
`usePoll`'s stale-data-on-error (`:41-51`), `ui.tsx`'s `NOTICE`/`GapNotice`/
`ErrorNotice` neighbours for `InfoNotice` (`:317-353`), the exhaustive
`taskTones` (`:117`), `enqueueTaskRun(tx, taskId, now)` and the five-status
`activeSuccessorStatuses` (`workflow.ts:62-103`, `:160-166`), the `for(;;)` CAS
whose re-read branch is what hangs on `BACKLOG` (`:226-252`), `fireCronTask`'s
row-CAS and `fireAtTask`'s missing re-read (`scheduler.ts:99-152`),
`instantiateTemplate`'s required `repoId` and Serializable retry loop
(`templates.ts:5-8`, `:58-106`), `authenticateWebhook`'s single null-return
(`hooks.ts:42-48`), the `Restrict` webhook-repo FK and its existing proof
(`schema.prisma:409-410`, `migration.dbtest.ts:43-52`), `setupTestDb`'s
single `migrate reset` (`testdb.ts:19-29`), the `Proxy`-around-`tx` race idiom
(`chain.dbtest.ts:66-91`), and all three `GET /tasks` call sites including the
global one (`Projects.tsx:75`). All held. The one thing that did not: §15's
secret-hygiene commands, whose allowlist was still too narrow to pass on a clean
tree — the exact defect review M13 raised, one layer down. They are rewritten
there, and that is the only change this pass made to revision 1's content.

Planning only. **Thirteen work items in dependency order, one commit each, on one
feature branch, landing as one PR with two migration folders.** Every spec
requirement maps to a numbered work item in §14, and every review finding maps to
a work item in §0.3. Revision 1 adds no work item — the findings landed inside the
thirteen that already existed, which is the evidence that they were defects in the
plan's *content*, not gaps in its structure.

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
- **One exclusion protocol, not five (C9, revision 1).** Archive, `Start now`,
  retry, the cron claim and the AT fire all touch the same question — "may this
  task gain a run right now?" — and they run in different transactions. The Task
  row is the mutex: every one of them takes `SELECT … FOR UPDATE` on the task row
  (or an equivalent single-statement CAS **on that row**) before it decides.
  Checking `runs` with a subquery and writing afterwards is not atomic under
  `ReadCommitted`, which is what the review's M4 caught.
- **API before web, pure web leaves before web pages.** WI-4…WI-7 finish the API
  surface; WI-8 lands the pure functions and types the four new pages share; WI-9
  lands the tab shell that gives them somewhere to live; WI-10…WI-13 are the
  pages, each mechanical by then.
- **The web client is thinner than the spec assumes (C10, C11).** `ApiError`
  keeps only the top-level `error` string (`apps/web/src/lib/api.ts:39-48`),
  `useAction` returns `boolean` and never the response body
  (`apps/web/src/lib/hooks.ts:66-88`), and `usePoll` keeps the last good `data`
  when a poll fails (`:41-51`). Three spec behaviours were planned on the
  assumption that none of that was true. They are re-planned here rather than by
  widening the shared hooks under four pages at once.
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

- **`GET /tasks` has exactly one *consumer* — the web app — but three call
  sites** (corrected in revision 1 for review S1; revision 0 said "one caller",
  which reads as one call site and is wrong):

  | Call site | Path | Effect of the archived default |
  |---|---|---|
  | `apps/web/src/pages/Tasks.tsx:268-269` | `/tasks?projectId=…` | the board; intended |
  | `apps/web/src/pages/Projects.tsx:75` | `/tasks` — **global, no `projectId`** | the per-project `Tasks` count drops archived tasks |
  | `apps/web/src/pages/Projects.tsx:135` | `/tasks?projectId=…` | the project detail's per-status counts drop archived tasks |

  `packages/cli/src` contains no `tasks` reference at all; `packages/runner` and
  `packages/inbox` reach tasks only through `/runner/*`. So the archived-default
  flip is still a one-consumer change, but it silently changes two counters the
  spec never mentions. **Decision: keep the flip and let both counters exclude
  archived tasks** — an archived task is finished work, and a count that keeps
  growing after `Archive All` is the bug, not the fix. It goes in the runbook
  (§16) as a named, deliberate change, and WI-4's chain grouping must survive the
  **global** call site, which has no `projectId` at all (C5, revision 1).
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

**Correction.** After the main `findMany`, issue one additional query — and key
the result by `(projectId, chainId)`, not by `chainId`, because
`Projects.tsx:75` calls this endpoint **globally with no `projectId`** and
`chainId` is only unique per project by convention, not by constraint (review S1;
same reason spec §6-E2 scopes the chain route):

```ts
const chainIds = [...new Set(tasks.map(t => t.chainId).filter(Boolean))];
const chainRows = chainIds.length === 0 ? [] : await db.task.findMany({
  where: { chainId: { in: chainIds }, ...(projectId ? { projectId } : {}) },
  select: { id: true, projectId: true, chainId: true, chainIndex: true, status: true,
            name: true, archivedAt: true, templateStep: { select: { name: true } } },
  orderBy: { chainIndex: "asc" },
});
```

then `chainProgressByChain(chainRows)` in memory, whose `Map` key is
`` `${projectId}:${chainId}` `` and whose lookup from a task uses that same
pair. A cross-project `chainId` collision then yields two groups and each task
reads its own — under the old `chainId`-only key it would have read a chain from
another project. Two queries per request regardless of task count — spec §6-E4
satisfied by construction rather than by a note.

**One more query, added in revision 1 for M6:** the Automations page needs
`Last run` on a *collapsed* row, and the expanded-only `recurring-fires` poll
cannot supply it (C10). So `GET /tasks` also runs, only when the response
contains at least one `scheduleKind = CRON` task:

```ts
const cronIds = tasks.filter(t => t.scheduleKind === "CRON").map(t => t.id);
const fired = cronIds.length === 0 ? [] : await db.task.groupBy({
  by: ["recurringSourceTaskId"],
  where: { recurringSourceTaskId: { in: cronIds } },   // scoped by the ids themselves
  _max: { createdAt: true },
  _count: { _all: true },
});
```

giving every `CRON` row `recurringLastFiredAt: string | null` and
`recurringFireCount: number`. It is index-backed by
`@@index([recurringSourceTaskId])` (WI-1), it counts archived copies too (a fire
that happened, happened), and it is skipped entirely on a board with no
automations. Ceiling: **three** queries per `GET /tasks`, constant in task count.

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

### C9 — one exclusion protocol: the Task row is the mutex (revision 1, review M4/M3)

Five code paths answer the same question in five different transactions:

| Writer | Where | What it does today |
|---|---|---|
| `POST /tasks/:id/start` | new (WI-5) | check no active run, then insert a run |
| `POST /tasks/:id/retry` | `app.ts:1356-1403` | read latest run, then insert a run, `ReadCommitted` |
| archive / `archive-done` | new (WI-5) | select candidates, then `updateMany` |
| `fireCronTask` | `scheduler.ts:99-140` | CAS **on the Task row** (`runAt: task.runAt`), then copy + enqueue |
| `fireAtTask` | `scheduler.ts:142-152` | `enqueueTaskRun` with **no re-read of the task at all** |

Revision 0 planned each guard as *read `runs`, decide, write*. That is not atomic
under `ReadCommitted`: Postgres re-checks a row predicate after a blocking write
commits (EvalPlanQual), but a **subquery over another table** in the same
`UPDATE … WHERE` is re-evaluated against the statement's original snapshot. So
`archive`'s "no active run" subquery can miss a run that `retry` inserted a
millisecond earlier, and both commit. Review M4 is correct, and it is not fixable
by adding predicates to the subquery.

**Correction — one protocol, stated once and applied by every writer.** The Task
row itself is the serialization point, because it is the only row all five
touch:

1. Inside its transaction, **before** it reads `runs` or decides anything, a
   writer locks the task row:
   ```ts
   const [locked] = await tx.$queryRaw<Array<{ id: string; status: TaskStatus; archivedAt: Date | null }>>`
     SELECT "id", "status", "archivedAt" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
   `;
   if (!locked) return { error: "Task not found", code: 404 };
   ```
   `tx.$queryRaw` is already used on a transaction client in this repo
   (`packages/db/src/workflow.ts:297-307` issues savepoints through
   `$executeRawUnsafe` on `tx`), so this is an established shape, not a new one.
2. Only then does it read `runs`, evaluate `ACTIVE_RUN_STATUSES`, and write.
   Every other writer that wants the same row now waits at step 1.
3. `fireCronTask` is **already** compliant: its `updateMany` is a CAS on the Task
   row, and a single-statement predicate on that row *is* re-checked after the
   lock releases. It gains `archivedAt: null` and `schedulePausedAt: null` in the
   claim's `where` (WI-6) and needs no `FOR UPDATE`.
4. `fireAtTask` is the one gap: it never re-reads the task, so a task archived
   after the poll still fires. It gains the same `FOR UPDATE` + re-check of
   `archivedAt IS NULL AND status = 'todo'` inside its existing transaction,
   returning `false` (not throwing) when the re-check fails, exactly like its
   existing `uniqueConflict` path.
5. `archive-done` locks its whole candidate set in one statement,
   `… WHERE "id" = ANY(${ids}) AND "archivedAt" IS NULL ORDER BY "id" FOR UPDATE`.
   **`ORDER BY "id"` is not decoration** — it is what stops two concurrent
   `Archive All` presses from deadlocking. Single-row writers lock exactly one
   row, so no lock cycle exists.
6. **`POST /tasks/:id/retry` gains `409 "Cannot retry an archived task"`.** This
   is a behaviour addition the spec did not ask for; it is forced by M4, because
   an exclusion protocol with a writer that ignores `archivedAt` excludes
   nothing. It is one predicate inside the lock, it cannot fire for any
   pre-existing task (nothing is archived before this batch), and spec §5.5's
   "do not change" list covers run claiming, leases, reconciliation and gates —
   not the retry guard's task-state checks. Named here so a reviewer does not
   read it as scope creep.

**Also from M3 — the double-press `409` is not free.** Even with the lock, two
`Start now` presses that arrive at *different API processes* both go through
`enqueueTaskRun`, which derives `runNumber` from the latest run
(`workflow.ts:79`) and inserts against `@@unique([taskId, runNumber])` plus
`Run.dedupeKey @unique` (`schema.prisma:651`, `:590`). The lock serialises them so
the second one sees the first's run and returns `409` — but only if both share
one database, which they do. The unique conflict therefore should not happen; it
is still mapped defensively, because a 500 on a double-click is exactly the
failure S2 forbids:

```ts
catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return context.json({ error: "Task already has an active run" }, 409);
  }
  throw error;
}
```

Both halves are tested with **synchronised** requests (the `Proxy`-around-`tx`
pattern at `packages/api/src/chain.dbtest.ts:66-91`), never two sequential calls —
sequential calls pass with or without the fix.

### C10 — the web client cannot carry structured payloads or success results (revision 1, review M6/M7/M11)

Three spec behaviours were planned as "the existing surface renders it". None of
them can:

| Spec behaviour | Why it cannot work | Fix, and where |
|---|---|---|
| `400 { unresolved: [...] }` renders the variable names (§4.6-T2) | `parseError` (`api.ts:39-48`) keeps **only** `parsed.error`; every other field is discarded before `ApiError` is constructed, and `useAction` flattens even that to a string | The **server** puts the names in the prose: `error: "Unresolved template variables: repoUrl, issueId"`. WI-7 §8 |
| `Archived n, skipped m (running)` (§4.9, E8) | `useAction.run` resolves `boolean` (`hooks.ts:66-88`); the response body is unreachable, and Tasks.tsx owns no success surface — only two `ErrorNotice`s | The page calls `api.post<…>` **directly** and keeps its own `notice` state; `ui.tsx` gains a neutral `InfoNotice`. WI-8, WI-10 |
| `Last run` on a collapsed automation row (§4.7) | `usePoll(null)` is the hook's idle mode — it clears `data` and issues no request (`hooks.ts:32-37`), so a collapsed row has no fire data at all | The **list response** carries `recurringLastFiredAt` (C5). WI-4, WI-12 |

The rule this batch follows: **do not widen `ApiError`/`useAction` for one
message.** Both are used by every page in the app; changing their contract to
carry structured detail is a refactor with a blast radius far larger than this
batch, and it would land under four new pages at once. If a later batch needs
structured errors in more than one place, that is the moment — recorded as F4
(§17).

### C11 — `usePoll` keeps stale data, so E14 does not satisfy itself (revision 1, review M8)

Revision 0 said E14 (task deleted while its chain card is open) "needs no code".
It does. `usePoll`'s catch sets `error` and **leaves `data` at the last good
value** (`hooks.ts:41-51`), and `TaskDetail` only renders the error page when
`error !== null && task === null` (`TaskDetail.tsx:178-180`). A task deleted after
the first successful poll therefore renders forever, silently stale, every 2.5 s.

**Correction.** One shared predicate, in `apps/web/src/lib/poll-state.ts` (new,
WI-8):

```ts
/** A 404 is authoritative even when a prior poll succeeded: the row is gone,
 *  the cached copy is a lie. Any other error keeps the last good render. */
export const fatal = (error: ApiError | null, data: unknown): boolean =>
  error !== null && (data === null || error.status === 404);
```

`TaskDetail` switches its guard to `fatal(error, task)` (WI-11), and the chain
card is not rendered when the subject task is gone, so its own poll's 404 needs
no second branch. The three new pages use the same helper. It is a pure function
of two arguments, so all four combinations are unit-testable without driving a
poll — which matters, because the web tests are `renderToStaticMarkup` snapshots
(`apps/web/src/tests/task-detail.test.tsx:1-10`) and cannot run a 2.5 s interval.

---

## 0.3 Disposition of the review's seventeen findings

Review: `docs/reviews/2026-08-16-batch-2.5-plan-review.md` (verdict FAIL against
plan `cd05b9c`). **Every finding was re-verified against the tree before being
applied** — the review's line references were read, not trusted. All 17 are
applied; one (S2) is applied in part, with the declined half and its reason in
§0.4. Nothing is dropped.

| # | Finding, in one line | Verified? | Where it landed |
|---|---|---|---|
| M1 | Backfill marks the recurring **definition** `CRON`, not just its copies | Yes — `scheduler.ts:133-137` writes the same metadata to both rows | WI-2 §1, new predicate + both-rows assertion |
| M2 | `startable`'s run-budget test is impossible from `take: 1` | Yes — `@@unique([taskId, runNumber])` permits many runs | WI-4 §3, one `groupBy` for counts + active presence |
| M3 | Double-press `Start now` races to a 500, not a `409` | Yes — `enqueueTaskRun:79` derives `runNumber`, unique constraint rejects the loser | C9 + WI-5 §1, lock + `P2002` map + synchronised test |
| M4 | Archive is not atomic with retry / cron / AT | Yes — `ReadCommitted` re-checks the row, not the subquery; `fireAtTask:142-152` never re-reads | **C9**, applied across WI-5, WI-6 |
| M5 | Manual fire never resolves `repoId`; T8 untested | Yes — `InstantiateTemplateInput.repoId` is required (`templates.ts:5-8`, `:38`) | WI-7 §8, plus O7 for T8's unreachable premise |
| M6 | `Last run` is `Never` on every collapsed row | Yes — `usePoll(null)` clears data and fetches nothing | C5 + C10, WI-4 §4, WI-12 |
| M7 | `unresolved` names cannot reach the UI | Yes — `parseError` keeps only `error` | C10, WI-7 §8, WI-13 §3 |
| M8 | E14 is not satisfied by existing polling | Yes — `usePoll` keeps `data` on error | **C11**, WI-8, WI-11 §3 |
| M9 | `Create Task` contradicted itself and vanished from three tabs | Yes — the panel is page-local state in `Tasks.tsx:107-264` | WI-9 §1, panel hoisted to a shared component |
| M10 | The plain-text cron editor the spec requires is missing | Yes — spec §3.2 excludes a *builder*, not the field | WI-12, new edit interaction |
| M11 | `Archive All`'s result notice has no state and no surface | Yes — `useAction` returns `boolean`; Tasks owns only error notices | C10, WI-8 (`InfoNotice`), WI-10 §6 |
| M12 | `Promise.race` does not stop a hanging transaction | Yes — the loop is `for(;;)` inside the tx (`workflow.ts:226-252`) | WI-3, replaced with a Prisma transaction `timeout` + disposable client |
| M13 | The `OPERATOR_TOKEN` grep can never return 0 | Yes — three existing dbtests set it (`hooks.dbtest.ts:100`, `scheduler.dbtest.ts:129`, `chain.dbtest.ts:126`, `:262`) | §15, three greps, allowlist = **test files** (tightened in the verification pass: revision 1's message-shaped allowlist still flagged four pre-existing fixtures, and the corrected commands were executed) |
| S1 | `GET /tasks` has three call sites, one global | Yes — `Projects.tsx:75` calls it with no `projectId` | §0.1 table + C5, keyed by `(projectId, chainId)` |
| S2 | Record the spec deviations as authoritative errata | Yes | **§0.4** — errata written; editing the approved spec declined, see §0.4 |
| S3 | E1/E2/E6 and the CAS re-read are claimed but untested | Yes | WI-3, WI-4, WI-7 verification blocks |
| S4 | The rollback runbook belongs to no work item | Yes — §16 named a file nothing creates | WI-1, file + commit checklist |

## 0.4 Errata against the approved spec (binding for implementation and review)

Review S2 is right that two authoritative documents must not disagree while an
implementer works. Where this plan and the approved spec conflict, **this table
governs**; it is the single place a reviewer needs to read to know which
document won and why.

| # | Spec says | This plan does | Why |
|---|---|---|---|
| E-1 | "no active run (`QUEUED \| CLAIMED \| PROVISIONING \| RUNNING`)" — §4.3, spec `:286-292` | Adds `WAITING_INBOX`; one exported `ACTIVE_RUN_STATUSES` | A run parked on an Inbox question resumes on answer (`workflow.ts:463-473`); the spec's set lets `Start now` double-run it and lets Archive move it out from under a live session (C1) |
| E-2 | Backfill runs "inside the second migration" — spec `:546-559` | Schema-only migrations; an idempotent `backfillTaskSource(db)` + runner script | `setupTestDb` migrates once against an empty schema (`testdb.ts:19-29`), so an in-migration backfill can never be asserted — and spec §7-23 asks for exactly that assertion (C3) |
| E-3 | `archive-done` returns `{ archived: n }` (§5.2, spec `:567-574`) while §6-E8 shows `{ archived, skipped }` and §4.9-A2 asserts `{ archived: 0 }` | Always `{ archived, skipped }` | The spec contradicts itself; A2 holds as a subset (C4) |
| E-4 | — (silent) | `POST /tasks/:id/retry` also refuses archived tasks | Forced by M4: an exclusion protocol with one writer that ignores `archivedAt` excludes nothing (C9-6) |
| E-5 | — (silent) | `GET /tasks` excludes archived by default for **all three** call sites, including the global one | The archived default is the spec's; its effect on the two `Projects.tsx` counters is not, and is accepted deliberately (§0.1) |

**Declined half of S2.** The review asks for the errata to be "referenced by both
documents". This plan does **not** edit `docs/specs/batch-2.5-tasks-visibility.md`:
it is an approved artifact of an earlier chain step, and a plan step that rewrites
its own input destroys the reviewer's ability to see what was approved versus what
was changed afterwards. The one-directional reference above is the substitute, and
amending the spec is recorded as **O6** (§18) for Leo to decide. If that is the
call, it is a two-line follow-up commit, not a re-plan.

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
- `docs/runbooks/batch-2.5-rollback.md` (new) — **this work item owns the runbook**
  §16 describes (review S4; revision 0 named a file no work item created). It
  ships in WI-1's commit, complete, covering the whole batch: the
  `UPDATE "Task" SET status='todo' WHERE status='backlog';` precondition **before**
  any API rollback, the warning that reverting WI-6 makes paused automations
  resume firing, the WI-3/WI-10 joint-revert rule, and the deploy order of §15
  (migrate → backfill → API restart → web). Precedent for the file's shape:
  `docs/runbooks/files-deployment.md`.

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
- **Commit checklist for this work item** (review S4): the commit contains the
  schema hunk, both migration folders, the `workflow.ts` rename **and**
  `docs/runbooks/batch-2.5-rollback.md`. `git show --stat` must list the runbook;
  a WI-1 commit without it is incomplete.

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

1. `source = 'cron'` + `recurringSourceTaskId` for every task that is a **fired
   copy**. The predicate revision 0 used — "has a `TaskActivity` row with
   `actorType = 'scheduler'` and a non-null `metadata->>'recurringTaskId'`" — is
   wrong, and review M1 is right about why: `scheduler.ts:133-137` writes **one
   activity row with that same metadata onto each of two tasks**, the definition
   and the copy:

   ```ts
   const metadata = { recurringTaskId: task.id, firedAt: now.toISOString() };
   await tx.taskActivity.createMany({ data: [
     { taskId: task.id, actorType: "scheduler", body: `Recurring task fired copy ${copy.id}`, metadata },
     { taskId: copy.id, actorType: "scheduler", body: `Created from recurring task ${task.id}`, metadata },
   ] });
   ```

   The revision-0 predicate would therefore stamp the recurring **definition**
   `source='cron'` with `recurringSourceTaskId` pointing at itself — contradicting
   spec §4.10 ("the recurring task itself … is `MANUAL` by source; only its fired
   copies are `CRON`-sourced") and putting a self-referencing FK in the data.

   **Corrected predicate — the copy is the row whose own id is not the
   `recurringTaskId`:**

   ```sql
   activity.actorType = 'scheduler'
     AND activity.metadata->>'recurringTaskId' IS NOT NULL
     AND activity.taskId <> activity.metadata->>'recurringTaskId'
   ```

   Set the FK only when the referenced parent still exists (validate with one
   `task.findMany({ where: { id: { in: parentIds } }, select: { id: true } })`) —
   the column is `SetNull`, but a backfill that writes a dangling id fails the FK
   outright. A copy whose parent was deleted keeps `source='cron'` with a **null**
   FK.
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

- New `migration.dbtest.ts` tests (real Postgres, seeded rows then a direct call).
  The first one seeds through **`schedulerTick` itself**, not by hand-writing
  activity rows — a hand-written fixture is exactly how revision 0's predicate
  survived review:
  1. after a real cron fire, **both rows are asserted**: the copy ends
     `source='cron'` with `recurringSourceTaskId` = the definition, **and the
     definition is still `source='manual'` with a null `recurringSourceTaskId`**
     (review M1's explicit ask);
  2. a webhook-created task ends `source='webhook'` with one `TriggerFire`;
  3. a hand-made task stays `manual`;
  4. a copy whose parent row was deleted gets `source='cron'` and a **null** FK;
  5. **a second call returns all zeros and creates no rows** (idempotence),
     asserted on the returned counts *and* on `triggerFire.count()`.
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

Revision 0 bounded these tests with `Promise.race`. **Review M12 is right that
that proves nothing**: losing a race does not cancel a database operation. The
`for(;;)` at `workflow.ts:226-252` keeps issuing `updateMany`/`findUnique` inside
a live transaction, the test process stays alive holding it, and teardown blocks.
`SET LOCAL statement_timeout` does not fix it either, and the plan says so
explicitly so nobody reaches for it: the loop issues a *sequence of fast
statements*, and a per-statement timeout never fires.

**The boundary must cancel the transaction, not the promise.** Prisma's
interactive-transaction `timeout` does exactly that: when it expires the
transaction is closed server-side and the next query inside the callback throws
`P2028 (Transaction already closed)`, so the loop dies at its own next statement
and the promise settles. Three layers, cheapest first:

```ts
test("a BACKLOG successor is parked, not spun on", { timeout: 20_000 }, async () => {
  const { predecessor, successor } = await seedExecutableChain();
  await db.task.update({ where: { id: successor.id }, data: { status: "BACKLOG" } });
  // A dedicated client so a wedged transaction cannot poison the shared one,
  // and so `finally` can forcibly disconnect it.
  const hangDb = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  try {
    await hangDb.$transaction(
      async (tx) => activateChainSuccessor(tx, predecessor, {}, new Date()),
      { maxWait: 2_000, timeout: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } finally {
    await hangDb.$disconnect();
  }
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: successor.id } })).status, "BACKLOG");
  assert.match((await db.taskActivity.findFirst({ where: { taskId: successor.id }, orderBy: { createdAt: "desc" } }))!.body, /parked in Backlog/);
});
```

1. `timeout: 5_000` on the transaction — the cancellable boundary. Without the
   guard the test **fails** with `P2028` in ~5 s instead of hanging.
2. `{ timeout: 20_000 }` on `node:test` — a second ceiling if Prisma's own
   timeout is ever misconfigured.
3. `hangDb.$disconnect()` in `finally` — releases the connection and the row
   locks even on the failing path, so the rest of the file is unaffected.

**Negative control, run once by hand and pasted into the PR** (this is the only
way to know the test can fail): comment the `BACKLOG` guard out, run
`npm run test:db -w @agentos/api -- --test-name-pattern "parked, not spun on"`,
and confirm the process **exits non-zero within ~20 s** rather than hanging.
A hang-regression test that has never been observed failing is decoration.

Tests:

  1. Successor set to `BACKLOG` → resolves, the successor has **zero** runs, its
     status is still `BACKLOG`, and the activity row matches `/parked in Backlog/`.
  2. Successor with `archivedAt` set → resolves, zero runs, activity row matches
     `/is archived and was not queued/`.
  3. **The re-read branch, under a real race** (review S3; revision 0 described
     this guard but tested only rows that were already parked). Reuse the
     `Proxy`-around-`tx.task.updateMany` pattern at `chain.dbtest.ts:66-91`: on
     the **first** `updateMany` call, a second client sets the successor to
     `BACKLOG`; the CAS then loses on `updatedAt`, the loop re-reads, and the
     re-read guard must return rather than spin. Same three timeout layers.
     Without the re-read guard this test hangs and then fails — which is the
     point, and it is the branch revision 0 left unproven.
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
     id: string; projectId: string; chainId: string | null; chainIndex: number | null;
     name: string; status: TaskStatus; archivedAt: Date | null;
     templateStep: { name: string } | null;
   };
   export const stepName = (row: ChainRow): string => row.templateStep?.name ?? row.name;
   export const chainProgress = (rows: ChainRow[]) => ({ done, total, activeStepName, activeStatus });
   /** Keyed `${projectId}:${chainId}` — `GET /tasks` is callable globally
    *  (`Projects.tsx:75`) and `chainId` is unique per project only by
    *  convention (review S1). `chainKey(row)` is exported so the route and the
    *  test build the key the same way. */
   export const chainKey = (row: { projectId: string; chainId: string }): string => `${row.projectId}:${row.chainId}`;
   export const chainProgressByChain = (rows: ChainRow[]): Map<string, ChainProgress> => …;
   export const positions = (rows: ChainRow[]): Map<string, number> => …;   // 1-based, chainIndex asc
   ```
   - `total` = row count (**not** `max(chainIndex)+1`) — spec §4 terminology, [A1].
   - `done` = rows with `status === DONE`, archived rows included (§4.1-C6).
   - active step = lowest `chainIndex` whose status is not `DONE`; if all are
     `DONE`, the last row.
   - `activeStatus` is the lowercased `TaskStatus` ([A2]).
2. `startable(row, runFacts, maxSessionsPerTask)` lives here too and is the
   **single** source for both the API guard (WI-5) and the web button (WI-8
   re-implements nothing — the API computes it, the web only reads the boolean).
   Conditions, all seven, from §4.3, with "active run" = `ACTIVE_RUN_STATUSES`
   (C1).

   **`runFacts` is not the latest run** (review M2). Revision 0 wrote the budget
   condition as `runs.length < maxSessionsPerTask` while telling the route to
   fetch `runs: { take: 1 }`, so `runs.length` was at most 1 and a task at its
   ceiling looked startable whenever its last run was terminal. `Run` is
   genuinely one-to-many and uniquely numbered
   (`schema.prisma:581-590`, `@@unique([taskId, runNumber])` at `:651`), so the
   count has to be counted:

   ```ts
   export type RunFacts = { total: number; active: boolean };
   export const startable = (row: ChainRow & {…}, facts: RunFacts, maxSessionsPerTask: number): boolean => …
   ```

   The route gets both facts for the whole chain in **one** query — statuses and
   totals together, so there is no second round trip and no per-row query:

   ```ts
   const runRows = await db.run.groupBy({
     by: ["taskId", "status"],
     where: { taskId: { in: stepIds } },
     _count: { _all: true },
   });
   // total = sum of _count per taskId; active = any status in ACTIVE_RUN_STATUSES
   ```

   `latestRun` (for display) still comes from the existing `take: 1` include.
   Note that `maxSessionsPerTask` is the **task's own** column, not the project's
   — `enqueueTaskRun` copies it into `Run.maxRunsPerTask` (`workflow.ts:101`) and
   the retry guard compares against that copy (`app.ts:1372`); the chain route
   compares against `task.maxSessionsPerTask`, which is the same number for every
   task created after the project default was applied.
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
   - the second chain query + `chainProgressByChain` of C5, **keyed by
     `(projectId, chainId)`** so the global call site (`Projects.tsx:75`) cannot
     read another project's chain; each task gains
     `chainProgress: { chainId, position, total, done, activeStepName, activeStatus } | null`.
   - the third (conditional) group-by of C5: every `scheduleKind = CRON` row gains
     `recurringLastFiredAt: string | null` and `recurringFireCount: number`, so
     the Automations page can render `Last run` **while collapsed** (review M6).
     Non-CRON rows get `null`/`0`; a board with no automations issues no third
     query.
   - `source`, `archivedAt`, `chainId`, `chainIndex`, `schedulePausedAt` ride along
     automatically as Prisma scalars.
   - **Three call sites, not one** (§0.1): the two `Projects.tsx` counters now
     exclude archived tasks. Deliberate; runbook line in §16.

**Verification**

- `packages/api/src/chain.test.ts` (`npm test -w @agentos/api`): `chainProgress`
  over a nine-row chain at 0/3/9 done; sparse `chainIndex` 1/5/9 → positions
  1,2,3 and `total = 3`; a single row; an empty array; an all-done chain picking
  the **last** row as active; an archived-but-DONE row counting toward both `n`
  and `m`; `startable` — one test per condition, including the `WAITING_INBOX`
  case C1 exists for **and the budget case M2 exists for**: `{ total: 3, active:
  false }` against `maxSessionsPerTask: 3` is **not** startable, `{ total: 2 }` is;
  `chainProgressByChain` over two same-`chainId` rows in **different** projects
  yields two groups (review S1).
- `chain.dbtest.ts`: `GET /tasks/:id/chain` over a real nine-step
  `instantiateTemplate` result — nine steps, positions 1..9, step 9
  `assigneeType: HUMAN` + `approvalGate` + `startable: false`; the no-chain task
  returns the empty envelope with `200`; `GET /tasks?projectId=…` returns
  `chainProgress` identical for all nine cards. Three route branches revision 0
  claimed in §14 but never exercised (review S3):
  - **E1** — a task with `chainId` set and `chainIndex` **null** returns
    `{ total: 1, done: … , steps: [one row at position 1] }` and `200`, and a
    *sibling* row with a null `chainIndex` never appears in another task's chain;
  - **E2** — two chains created in two projects with the **same** `chainId`
    (write it directly; `instantiateTemplate` generates UUIDs) return three steps
    each, never six, from `GET /tasks/:id/chain` **and** from `GET /tasks`
    without a `projectId`;
  - **M2 at the ceiling** — a step whose `maxSessionsPerTask` runs all exist and
    are terminal reports `startable: false`, and `POST /tasks/:id/start` on it is
    `409` (the WI-5 pair of the same assertion).

**Rollback.** Both routes are additive except the `archived` default. Reverting
restores the old behaviour with no data implications.

---

## WI-5 — API: `Start now`, archive, unarchive, archive-done, and the `BACKLOG` PATCH guard

**Goal.** Spec §4.3, §4.8-B1, §4.9, §6-E8/E9.

**Files** — `packages/api/src/app.ts` (`:1281-1349` PATCH, `:1355-1404` retry,
new routes after `:1406`), `packages/api/src/app.test.ts` (selection-logic unit
test), `packages/api/src/tasks.dbtest.ts` (new).

**Every route in this work item obeys C9: lock the task row first, then read
`runs`, then write.** The lock is the first statement inside the transaction:

```ts
const [locked] = await tx.$queryRaw<Array<{ id: string; status: TaskStatus; archivedAt: Date | null }>>`
  SELECT "id", "status", "archivedAt" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
`;
if (!locked) return { error: "Task not found", code: 404 as const };
```

Reading `runs` before the lock is the bug review M4 found; there is no version of
these guards that is correct without it.

**What to do**

1. `POST /tasks/:taskId/start` → `201 { runId, runNumber }`, in one
   `ReadCommitted` transaction, **after the C9 lock**:
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
   - the run-budget test uses a **count**, not `runs.length` from a `take: 1`
     include (M2, WI-4 §2);
   - otherwise `enqueueTaskRun(tx, taskId)`, flip `BACKLOG` → `TODO` in the same
     transaction (S7), and write
     `TaskActivity { actorType: "operator", body: "Started manually from the chain view" }`;
   - wrap the whole handler's `catch` with the `P2002` → `409 "Task already has an
     active run"` mapping of C9. Under the lock this should be unreachable; an
     unreachable branch that turns a 500 into the spec's own S2 wording costs
     four lines.
2. `POST /tasks/:taskId/archive` → `200 task`. **C9 lock, then** `409 "Cannot
   archive a task with an active run"` (A3, `ACTIVE_RUN_STATUSES`);
   `409 "Decide the approval gate in the Inbox first"` when `status === REVIEW`
   **and** an `InboxMessage` exists with `gateTaskId = taskId, status: OPEN`
   (E9 — the exact query shape `app.ts:1336-1339` already uses). Sets
   `archivedAt = now()` and writes an activity row.
3. `POST /tasks/:taskId/unarchive` → `200 task`, sets `archivedAt = null`,
   idempotent (already-null is `200`, not an error). No lock needed: unarchiving
   cannot race a run into existence.
4. `POST /projects/:projectId/tasks/archive-done` → `200 { archived, skipped }`
   (C4), in one transaction:
   1. select candidate ids (`status: DONE, archivedAt: null, projectId`);
   2. **lock them all in one statement, ordered** —
      `SELECT "id" FROM "Task" WHERE "id" = ANY(${ids}) AND "archivedAt" IS NULL ORDER BY "id" FOR UPDATE`
      (C9-5: `ORDER BY "id"` is the deadlock guard between two concurrent
      `Archive All` presses);
   3. **then** read the runs of the locked ids and partition on
      `ACTIVE_RUN_STATUSES`;
   4. `updateMany` the survivors in one statement + one activity row each.

   Revision 0 did steps 1 and 4 with no lock and no re-read, so E8's concurrent
   retry could land between them (review M4). Ids that vanished between 1 and 2
   simply do not come back from the lock query and count as neither archived nor
   skipped.
5. **`POST /tasks/:taskId/retry` (`app.ts:1355-1404`) joins the protocol**
   (C9-6, errata E-4): the C9 lock becomes the first statement of its existing
   transaction, and it gains
   `409 "Cannot retry an archived task"` when `locked.archivedAt !== null`.
   Nothing else in that handler changes — not its narrower active-run set (F1
   stays a follow-up), not its budget check, not its response shape.
6. `PATCH /tasks/:taskId`: `status: BACKLOG` arrives for free —
   `taskPatch` (`app.ts:226`) is `z.nativeEnum(TaskStatus)`. Add, next to the
   existing gate guard at `:1285-1287`:
   `409 "Cannot move a task with an active run to Backlog"` when the new status is
   `BACKLOG` and an active run exists (B1). This one guard reads runs **outside**
   a transaction, like the gate guard beside it, and that is acceptable: the
   worst case of losing the race is a task sitting in `Backlog` with a live run,
   which the WI-3 guard already handles and which the next run completion
   resolves. Making the whole PATCH handler transactional to close a cosmetic
   race is out of proportion, and §5.5 asks this handler to stay as it is.
   Everything else in it, including the `advances` transaction at `:1329-1344`,
   is untouched.

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
  11. `PATCH {status:"BACKLOG"}` with an active run → `409`; without one → `200`;
  12. **retry on an archived task → `409 "Cannot retry an archived task"`**
      (errata E-4).

  Three **synchronised** race tests, using the `Proxy`-around-`tx` pattern of
  `chain.dbtest.ts:66-91` — two sequential calls prove nothing here, which is why
  review M3/M4 could not be answered by the revision-0 tests:

  13. **double-press `start`**, both requests held until both are inside their
      transaction: exactly one `201`, one `409`, `db.run.count === 1`, and the
      `409` body is the S2 string — **not** a 500 and not a `P2002` leak;
  14. **archive vs retry**: `archive` and `retry` released simultaneously on the
      same `DONE`-with-terminal-run task; whichever wins, the end state is
      consistent — either `archivedAt` set with **no** new run, or a new run with
      `archivedAt` still null. Never both. Assert
      `(archivedAt !== null) !== (runCount > before)`;
  15. **archive vs `archive-done`** on an overlapping set: no row is counted
      twice and no deadlock (the test would hang; it carries the same
      transaction-`timeout` boundary WI-3 establishes).

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
4. `scheduler.ts` — **the poll filters are a hint, the claim is the truth**
   (C9; review M4 caught revision 0 treating the poll as the guard):
   - `schedulerTick`'s cron query (`:156`) gains `schedulePausedAt: null` and
     `archivedAt: null`; the AT query (`:157-163`) gains `archivedAt: null`.
     These only reduce work — both are read outside any transaction and are
     stale by the time the fire runs.
   - `fireCronTask`'s claim `where` (`:100-102`) gains **both**
     `schedulePausedAt: null` **and `archivedAt: null`**. This claim is an
     `updateMany` on the Task row, so its predicate is re-checked after any
     concurrent writer's lock releases — it is C9-compliant as it stands and
     needs no `FOR UPDATE`. A pause or an archive landing between the poll and
     the claim now wins the race instead of firing one more copy.
   - **`fireAtTask` (`:142-152`) is the gap revision 0 missed entirely**: it
     calls `enqueueTaskRun` without re-reading the task, so an archived AT task
     still fires from a stale poll row. It gains the C9 lock as the first
     statement of its existing transaction, then re-checks
     `archivedAt IS NULL AND status = 'todo'`, returning `false` (not throwing)
     when the re-check fails — the same shape as its existing `uniqueConflict`
     path, so `schedulerTick`'s `atFired` count stays honest.
   - the copy created at `:106-129` gains `source: TaskSource.CRON` and
     `recurringSourceTaskId: task.id`. The recurring definition itself stays
     `MANUAL` (§4.10) — the same distinction WI-2's backfill has to make for
     historical rows.

**Verification**

- `scheduler.dbtest.ts`, new tests: a `schedulePausedAt` task is not fired across
  a simulated due time (`schedulerTick(db, futureNow)` → `cronFired: 0`); resume
  puts `runAt` strictly in the future and the next tick fires exactly one copy;
  the fired copy has `source='cron'` and `recurringSourceTaskId` = the definition
  **while the definition stays `source='manual'`** (the WI-2/M1 invariant, proven
  once on the live path and once on the backfill path); an archived recurring
  task does not fire. Its six existing tests must stay green — particularly
  `"paused definitions do not fire…"` (`:59`), which uses the *status* mechanism
  and must keep working alongside the new flag.
- **Two archive-vs-scheduler race tests** (review M4), synchronised with the
  `scheduler.dbtest.ts:74-120` pattern rather than sequenced:
  - archive committed **after** the cron poll returns the task but **before**
    `fireCronTask`'s claim → `cronFired: 0`, no copy row exists;
  - the same for an `AT` task → `atFired: 0`, `run.count === 0`. Without the
    `fireAtTask` lock this test fails, which is the only reason to write it.
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
   returning `{ id, name, description, repo {id,name}|null, stepCount, paused,
   secretDisabled, lastFiredAt, fireCount }`. **`repo` is nullable** — spec §4.5
   defines a trigger by its *secret*, not its repo, so a template with a secret
   and no repo is listed (and is un-fireable; M5). The list route does not
   silently hide it: `Target` renders `no repository` in red (WI-13) rather than
   the row disappearing, because a trigger that cannot fire is exactly what the
   operator needs to see. `fireCount`/`lastFiredAt` come from
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
   `webhookPayloadMapping.defaults`; succeeds on a paused trigger ([A5]); calls
   `instantiateTemplate` with
   `{ source: MANUAL, fire: { source: TriggerFireSource.MANUAL } }`; maps
   `instantiateTemplate`'s thrown `"Template has no steps"` to `400` (the regex at
   `app.ts:1203` already covers `has no`); returns
   `201 { chainId, taskIds, fireId }`. Two things revision 0 got wrong:

   - **It must resolve and pass a repository** (review M5). `repoId` is a
     *required* field of `InstantiateTemplateInput` (`templates.ts:5-8`) and the
     function rejects a missing or cross-project repo outright
     (`templates.ts:38`); revision 0 never mentioned it, so the route as written
     would not have compiled. The repository is the template's own
     `webhookRepoId` — the same one the webhook path passes
     (`app.ts:493`) — and it is **nullable** (`schema.prisma:404`). So:
     load the template with `select: { id, projectId, webhookRepoId, variables, webhookPayloadMapping, steps: { select: { id: true } } }`,
     and return
     `400 { error: "This trigger has no repository configured" }` when
     `webhookRepoId` is null, **before** touching variables. That same condition
     feeds `canFire: false` / `cannotFireReason` in §5, so the button is already
     disabled with the reason shown and the `400` is only reachable by a direct
     API call (E13's shape, applied to a second cause).
   - **Unresolved names go in the `error` string, not only in `unresolved`**
     (review M7, C10): `400 { error: "Unresolved template variables: repoUrl, issueId", unresolved: [...] }`.
     The `unresolved` array stays for API clients; the web client discards it
     (`api.ts:39-48`), so the prose is what the operator actually reads. The
     **webhook** route's 400 body at `app.ts:490` is deliberately left alone —
     it is an externally-observed contract with existing test coverage, and
     nothing renders it in the UI.

   **T8 (`repo deleted`) — what is actually reachable.** Spec §4.6-T8 assumes the
   FK nulls the repo. It does not: `TaskTemplate.webhookRepo` is
   `onDelete: Restrict` (`schema.prisma:410`), and `migration.dbtest.ts:43-52`
   already proves a referenced repo cannot be deleted (the test is literally
   named `"webhook foreign keys set a deleted secret null and restrict repo
   deletion"`). The premise is therefore
   unreachable today, and this plan does **not** change the relation to make it
   reachable — that is a schema change the spec did not ask for (recorded as
   **O7**, §18). What is implemented and tested is the reachable half: a template
   whose `webhookRepoId` is null (never configured, or cleared through
   `webhookConfigPatch`, which already accepts `null`) is `canFire: false` with
   the reason above, and `Fire now` on it is `400`. The restrict behaviour itself
   is asserted so the outcome is documented rather than assumed.

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
  and exactly one `MANUAL` `TriggerFire`; unresolved variable → `400` **whose
  `error` string contains the missing variable's name** (M7), zero tasks, zero
  fires; zero-step template → `400`; the triggers list reports
  `fireCount`/`lastFiredAt` from the ledger; a disabled secret surfaces
  `secretDisabled: true`. Plus, from review M5 and S3:
  - a webhook-configured template with `webhookRepoId: null` → listed with
    `repo: null`, `canFire: false`, and `Fire now` returns
    `400 "This trigger has no repository configured"` with zero tasks created;
  - `db.repo.delete` on a repo referenced by a template **rejects** (the
    restrict behaviour, asserted here as the authoritative T8 outcome rather
    than assumed);
  - **E6, simultaneous manual + webhook fire** — the two requests released
    together against the same template produce **two** chains, **two** ledger
    rows, and two first-step runs, with no `P2034` surfacing to either caller
    (`instantiateTemplate`'s five-attempt Serializable retry is what makes this
    pass; revision 0 asserted that in §14 without testing it).

**Rollback.** All routes additive. The hook's two behaviour changes (paused
`401`, duplicate `200`) revert with the code; the ledger is append-only and read
by nothing else.

---

## WI-8 — Web: types, the two pure modules, `cronstrue`, and the `BACKLOG` tone

**Goal.** Spec §5.4's pure leaves. Nothing renders yet; every subsequent web item
is mechanical once this lands.

**Files** — `apps/web/src/lib/types.ts:4`, `:224-249`;
`apps/web/src/lib/chain.ts` (new); `apps/web/src/lib/schedule.ts` (new);
`apps/web/src/lib/poll-state.ts` (new, C11);
`apps/web/src/components/ui.tsx:117` (tone) and `:338` (the new `InfoNotice`,
C10); `apps/web/package.json`; `apps/web/src/tests/chain.test.tsx`,
`apps/web/src/tests/schedule.test.tsx`, `apps/web/src/tests/poll-state.test.tsx`
(new).

**What to do**

1. `types.ts`: `TaskStatus` union gains `"BACKLOG"`; `Task` gains `chainId`,
   `chainIndex`, `source: TaskSource`, `archivedAt`, `schedulePausedAt`,
   `recurringSourceTaskId`, `templateStep: { name: string } | null`,
   `chainProgress: ChainProgress | null`, and — from C5/M6 —
   `recurringLastFiredAt: string | null` plus `recurringFireCount: number`, which
   are what let a **collapsed** Automations row render `Last run`. New exported
   types `TaskSource`, `ChainProgress`, `ChainStep`, `Trigger`, `TriggerDetail`,
   `TriggerFire`, `RecurringFire`. `Trigger.repo` is `{id,name} | null`, not
   `{id,name}` (M5).
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
6. `lib/poll-state.ts` — `fatal(error, data)`, verbatim from C11. One export, no
   dependencies beyond the `ApiError` type. Every page in this batch, plus
   `TaskDetail`, routes its "render the error page or the stale data?" decision
   through it. This is the whole of the M8 fix: `usePoll` itself is **not**
   changed, because every page in the app shares it and this batch has no
   mandate to change how the Runs, Sessions or Inbox pages behave on a 404.
7. `ui.tsx` — `InfoNotice({ message, onDismiss })` beside `ErrorNotice` (`:338`),
   built from the existing `NOTICE` base class with no tone override (neutral
   card, the same shape as `GapNotice` at `:323`) plus a dismiss affordance.
   `Archive All` (WI-10) is its first caller; without it there is **no** surface
   in the app that can say something succeeded (C10, review M11).

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
- `poll-state.test.tsx` — all four combinations, because the whole point of
  extracting `fatal` is that a `renderToStaticMarkup` suite cannot drive a poll
  through success-then-404 (review M8 asked for that render test; this is the
  testable form of it):
  `fatal(null, task) === false`; `fatal(err500, task) === false` (stale data
  survives a blip); **`fatal(err404, task) === true`** (the deleted row);
  `fatal(err500, null) === true` (nothing to show).
- `npm run build && npm test -w @agentos/web`.

**Rollback.** Reverting drops the dependency and the two modules; nothing else
imports them until WI-9.

---

## WI-9 — Web: the tab shell, four routes, the sidebar, and the `Archived` page

**Goal.** Spec §4.4 and §4.9's `Archived` tab. The `Archived` page is the
simplest of the three new pages, so it lands with the shell and proves it.

**Files** — `apps/web/src/components/tasks-tabs.tsx` (new);
`apps/web/src/components/new-task-panel.tsx` (new — the hoisted panel, M9);
`apps/web/src/pages/Archived.tsx` (new); `apps/web/src/App.tsx:18-33`;
`apps/web/src/components/Shell.tsx:21-31`;
`apps/web/src/pages/Tasks.tsx:107-264` (panel moves out), `:294-304` (head moves out);
`apps/web/src/tests/tasks-tabs.test.tsx` (new).

**What to do**

1. `components/tasks-tabs.tsx` exports `TasksPageHead({ active, onCreated })`
   rendering the existing `PAGE_HEAD` block (lifted verbatim from
   `Tasks.tsx:294-302`, `+ Create Task` included) plus a `Segmented`
   (`ui.tsx:211-238`) with
   `[{tasks,"Tasks"},{automations,"Automations"},{triggers,"Triggers"},{archived,"Archived"}]`,
   whose `onChange` calls `navigate("/" + value)`. Four tabs — `My Tasks` is
   dropped per §2.5-4.

   **The head owns the creation panel, on all four routes** (review M9;
   revision 0 contradicted itself here — it said the head includes
   `+ Create Task`, then said the panel stays in `Tasks.tsx`, which would have
   shipped a button that does nothing on three of the four tabs the spec
   requires it on, spec `:311-329`). Concretely:
   - `NewTask` (`Tasks.tsx:107-264`) moves **verbatim** to
     `components/new-task-panel.tsx` and is exported. It is already a
     self-contained component over `{projectId, agents, repos, onClose,
     onCreated}` with page-local state and its own `usePoll` for templates
     (`:108`), so this is a move, not a rewrite — the diff must be a pure
     relocation plus the `export` keyword, reviewable as such.
   - `TasksPageHead` owns the `creating` boolean, polls `agents`/`repos` itself
     at the same 15 s cadence `Tasks.tsx:270-271` uses, and renders the panel.
   - `onCreated` is optional: the Tasks board passes its `reload`; the other
     three pages pass nothing (a task created from the Triggers tab has nowhere
     to appear on that tab, and the board reloads when the operator navigates
     back).
   - `Tasks.tsx` keeps **no** creation state at all after this — one owner, not
     two.
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
- **`Create Task` on every tab** (review M9): render `TasksPageHead` once per
  `active` value — `tasks`, `automations`, `triggers`, `archived` — and assert the
  `Create Task` control is present in all four, and that with `creating` open the
  panel's first field renders. Four assertions; they are what stops the panel
  quietly regressing to one route.
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
   `reload()`.

   **The result notice needs state this page does not have** (review M11).
   Revision 0 said "surface it through the existing notice area"; there is no
   such area — `Tasks.tsx:306-309` renders exactly two `ErrorNotice`s, and
   `useAction.run` resolves `boolean`, so the response body never reaches the
   page (C10). So:
   ```tsx
   const [notice, setNotice] = useState<string | null>(null);
   const archiveDone = async (): Promise<void> => {
     if (!window.confirm(`Archive ${doneTasks.length} done tasks?`)) return;
     try {
       const result = await api.post<{ archived: number; skipped: number }>(
         `/projects/${projectId}/tasks/archive-done`, {});
       setNotice(result.skipped > 0
         ? `Archived ${result.archived}, skipped ${result.skipped} (running)`
         : `Archived ${result.archived}`);
       reload();
     } catch (reason) { setNotice(null); setActionError(errorMessage(reason)); }
   };
   ```
   rendered as `<InfoNotice message={notice} onDismiss={() => setNotice(null)} />`
   (WI-8) above the board, cleared on dismiss and on the next `archiveDone`.
   `api.post` is called **directly** rather than through `useAction` precisely
   because the payload matters here; the error path still funnels into the same
   `ErrorNotice` the rest of the page uses, so there is one error surface and one
   information surface, not two of each.
7. Replace the placeholder `Segmented` at `:304` with `TasksPageHead` from WI-9,
   delete the now-duplicated head block **and** the `creating` state and
   `NewTask` render that moved with it (WI-9 §1).

**Verification**

- `tasks-board.test.tsx`: five columns render in `Backlog, Todo, Doing, Review,
  Done` order and a `BACKLOG` task lands in the first; a chain card renders
  `3/9 · Implementation · doing` and a chain-less card renders no marker; `cron`
  and `webhook` pills render and a `MANUAL` task renders neither string;
  `Archive All` is absent with an empty `Done` and present with one card;
  `Backlog` with zero cards renders `Drop tasks here` (E16).
- **The notice, both shapes** (review M11): `InfoNotice` rendered with
  `{archived: 6, skipped: 1}` contains `Archived 6, skipped 1 (running)`, and
  with `{archived: 6, skipped: 0}` contains `Archived 6` and **not** the string
  `skipped`. Test the message builder as a pure exported function
  (`archiveDoneNotice(result)`) so the assertion does not depend on driving a
  click through `renderToStaticMarkup`.
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
3. **E14 needs code** (review M8; revision 0 was wrong that it did not).
   `usePoll` keeps the last good `data` when a poll fails (`hooks.ts:41-51`), so
   `TaskDetail`'s guard `error !== null && task === null` (`:178`) is false
   forever after the first successful poll, and a deleted task renders stale for
   as long as the tab is open. Change that one line to
   `if (fatal(error, task))` (C11, WI-8), which treats a `404` as authoritative
   whatever is cached. The chain card is rendered under the same guard, so its
   own poll's `404` needs no second branch — and the chain poll must **not**
   render its own error page over a live task, because a chain `404` can also
   mean "this task never had a chain" on an older API.

**Verification**

- `chain-list.test.tsx`: a nine-step envelope renders nine rows; exactly one row
  carries `You are here`; exactly one lock per gated step and the `title` text
  appears **verbatim**; a `HUMAN` step renders `Human` and no `Start now`; a
  sparse-index envelope renders positions `1 2 3` with header `1/3` (the brief's
  skipped-step check, K2/§8.3); a 60-step envelope renders 50 rows plus
  `Show all`; an archived row renders the `archived` pill.
- **E14**: `fatal`'s four cases are unit-tested in WI-8; here, assert the page
  *uses* it — the repo's existing precedent for "this file wires the right
  helper" is the source-text assertion at `task-detail.test.tsx:10`
  (`readFileSync` on the page, then a regex). Assert `TaskDetail.tsx` contains
  `fatal(error, task)` and no longer contains `error !== null && task === null`.
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
- `Last run` = **`task.recurringLastFiredAt` from the list response** (C5/M6),
  rendered through `timeAgo`, else `Never`. Revision 0 read it from the
  expanded-row poll, which review M6 correctly called impossible: `usePoll(null)`
  clears data and issues no request (`hooks.ts:32-37`), so every collapsed row —
  which is every row, on load — would have read `Never` regardless of history.
- Expanded row polls `GET /tasks/:id/recurring-fires?take=5` **only while
  expanded** (the same idle mode, now used for what it is good for: the detail
  list, not the summary), listing fire time · run-status pill · cost · a `Link`
  to the copy · a session link when the run has one, plus
  `View all sessions →` to `/sessions`. Empty → `No sessions yet` (E11).
- **Plain-text cron editing** (review M10). Spec §3.2 excludes a cron *builder*
  and explicitly keeps the expression editable "through the existing task PATCH,
  which the Automations row exposes as a plain text field"; revision 0 shipped
  prose, status and pause/resume and dropped the field. Add, inside the expanded
  row (not the collapsed one — a text input in a table row is a mis-click
  waiting to happen):
  - two `Input`s, `Cron expression` and `Timezone` (IANA, empty = UTC),
    pre-filled from the task, with the live `cronProse` preview updating as the
    operator types — the preview is the validation feedback a builder would
    otherwise provide, at zero cost, since `cronProse` already degrades to the
    raw string on a parse failure (E10);
  - `Save` → `PATCH /tasks/:id { cron, timezone }`, then `reload()`. **No
    client-side cron validation**: `validateSchedule` (`scheduler.ts:33-52`)
    already rejects a bad expression *and* a bad IANA zone with a specific
    message and a `400` (`app.ts:1305-1323`), and it recomputes `runAt` from now
    on success — the same recomputation `resume` performs (WI-6 §2). A second,
    divergent validator in the browser is exactly the duplication §5.4 warns
    about;
  - the `400` renders in the page's `ErrorNotice`, and the row keeps the
    operator's text so it can be corrected rather than retyped.
- Empty state (M5): lightning glyph, `No automations yet`, and the sentence
  explaining that a task with a cron schedule becomes an automation.

**Verification**

- `automations.test.tsx`: `0 9 * * *` renders English prose plus the raw
  sub-line; a `cronstrue`-rejected expression renders the raw expression and the
  markup contains no `Error`; the three status shapes render their pills; a
  `BACKLOG` cron task renders `Active` **and** `in Backlog`; an automation with no
  copies renders `Never` and `No sessions yet`.
- **`Last run` while collapsed** (review M6): a row whose task carries
  `recurringLastFiredAt` renders the relative time **with the row collapsed and
  no fires poll mounted**; a row with `recurringLastFiredAt: null` renders
  `Never`. This is the assertion that would have failed on revision 0.
- **The cron field** (review M10): the expanded row renders an input holding the
  raw expression and one holding the timezone; typing an invalid expression
  leaves the preview showing that raw text and no `Error` string; `Save` issues
  `PATCH /tasks/:id` with exactly `{cron, timezone}`. API side: `tasks.dbtest.ts`
  asserts `PATCH {cron: "0 9 * * *"}` on a CRON task moves `runAt` into the
  future and `PATCH {cron: "not a cron"}` returns `400` with the parser's message
  and changes nothing (this is existing `validateSchedule` behaviour — the test
  pins it because the Automations row now depends on it).
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
   `Target` = `` `${repo.name} · ${stepCount} steps` `` ([A4]), or a red
   `no repository · ${stepCount} steps` when `repo === null` — that trigger
   cannot fire (M5) and hiding the row would hide the reason; `Status` =
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
   paused ([A5]).

   **T2's variable names arrive inside the `error` string, not in a structured
   field** (review M7, C10): `parseError` (`api.ts:39-48`) keeps only
   `parsed.error` and throws the rest away, so a client-side render of
   `unresolved` is unreachable. WI-7 §8 puts the names in the message; this page
   renders `actionError` in the existing `ErrorNotice` and the names come along
   for free. Nothing in `ApiError` or `useAction` changes.

**Verification**

- `triggers.test.tsx`: the `required` badge renders **only** for a variable with
  neither a mapping nor a default; **the rendered markup contains no secret value
  and no `OPERATOR_TOKEN`** (assert `doesNotMatch` against the fixture's secret
  string); `Fires: 0` renders as `0`; a paused trigger renders the `Paused` pill
  while `Fire now` stays enabled; a fire with a null chain renders
  `chain deleted`; a trigger with `repo: null` renders `no repository` and its
  `cannotFireReason` inline (M5); an `ErrorNotice` given the API's real
  `"Unresolved template variables: repoUrl"` string renders **`repoUrl`** in the
  markup (M7 — the assertion is on the variable name appearing, which is what
  T2 actually promises the operator).
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
| §4.4 | Four tabs, five routes, shared head, sidebar, **`+ Create Task` on all four** | WI-9 (panel hoisted; review M9) |
| §4.5 | Triggers table, all six columns | WI-7 (list route), WI-13 |
| §4.6 | Trigger detail, four cards, T1–T8 | WI-7, WI-13; **T8's premise is unreachable — the FK restricts** (WI-7 §8, O7) |
| §4.7 | Automations table, M1–M5, **plain-text cron field** | WI-6, WI-8 (`cronProse`), WI-12 (field, review M10) |
| §4.8 | `Backlog` column, B1–B5 | WI-1 (enum), WI-3 (park), WI-5 (guard), WI-10 |
| §4.9 | `Archive All`, `Archived` view, A1–A6 | WI-5, WI-9, WI-10, WI-11 |
| §4.10 | Source badges | WI-1, WI-2, WI-6, WI-7, WI-10 |
| §5.1 | Schema + migration + backfill | WI-1, WI-2 |
| §5.2 | Every new/changed endpoint | WI-4…WI-7 |
| §5.3 | Parked successors | WI-3 |
| §5.4 | Frontend modules + `cronstrue` | WI-8…WI-13 |
| §5.5 | What must not change | No work item touches run claiming, leases, reconciliation, gate semantics, or the webhook `401`/`400` bodies; WI-7 §3 keeps the `401` in one place, WI-5 leaves the gate guard at `app.ts:1285-1287` intact. **Two deliberate exceptions, both from review M4 and both listed in §0.4:** `retry` gains the C9 lock + an archived refusal (E-4), and `fireAtTask` gains the C9 lock. Neither changes how a run is *claimed* once it exists |
| §6-E1 | null `chainIndex` → `1/1` | WI-4 (C8) — **dbtest added** (review S3) |
| §6-E2 | `projectId`-scoped chain query | WI-4 — **cross-project collision dbtest added**, grouping keyed `(projectId, chainId)` (review S1/S3) |
| §6-E3 | 200-step chain → 50 + `Show all` | WI-11 |
| §6-E4 | No N+1 for `chainProgress` | WI-4 (C5) — ≤3 queries per `GET /tasks`, constant in task count |
| §6-E5 | 601 fires → count + `take:20` + index | WI-1 (index), WI-7 |
| §6-E6 | Concurrent manual + webhook fire | WI-7 — **synchronised dbtest added** (review S3); the serialization retry is what makes it pass |
| §6-E7 | Same-millisecond duplicates accepted | WI-7 (documented, [A10]) |
| §6-E8 | `Archive All` skips running | WI-5 (C4), WI-10 |
| §6-E9 | Open gate refuses archive | WI-5 |
| §6-E10 | `cronstrue` throw → raw expression | WI-8 |
| §6-E11 | Copies all deleted | WI-6, WI-12 |
| §6-E12 | 500 on a new endpoint | Existing `ErrorNotice` + `onRetry`; no new code |
| §6-E13 | Zero-step template | WI-7 (`canFire`), WI-13 |
| §6-E14 | Task deleted mid-view | **WI-8 (`fatal`) + WI-11 §3** — the existing branch does *not* cover it (C11, review M8) |
| §6-E15 | Same-column drop | Existing `Tasks.tsx:279` |
| §6-E16 | Empty `Backlog` | WI-10 |
| §7 | Every listed test | WI-1…WI-13 verification blocks; §7-23's migration test becomes a backfill test per C3 |
| §8 | Reviewer verification | §15's manual checklist |
| §9 | Rollback | §16, file owned by **WI-1** (review S4) |
| — | Atomicity of archive vs start/retry/cron/AT | **C9**, WI-5 §1-5, WI-6 §4 (review M4) — not a spec clause; a defect the spec's guards would have shipped |

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
WI-8 (after WI-1's enum) ─ WI-9 ─┬─ WI-10 (also needs WI-3, WI-5, WI-8's InfoNotice)
                                 ├─ WI-11 (needs WI-4, WI-5, WI-8's `fatal`)
                                 ├─ WI-12 (needs WI-6 **and WI-4's `recurringLastFiredAt`**)
                                 └─ WI-13 (needs WI-7)
```

Revision 1 tightened three of these edges: WI-10 and WI-11 now depend on leaves
WI-8 did not previously carry (`InfoNotice`, `fatal` — C10/C11), and WI-12's
`Last run` now comes from WI-4's list response rather than its own poll (M6). The
layering is unchanged; only the reasons are more specific.

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

Step 11 (secret hygiene) is mechanical and should be run as written. **Revision 0
wrote a check that can never pass** (review M13): three pre-existing dbtests set
`process.env.OPERATOR_TOKEN` to authenticate their fixtures —
`hooks.dbtest.ts:100-109`, `scheduler.dbtest.ts:129-139`,
`chain.dbtest.ts:126-137` and `:262-270` — so a repo-wide grep for that
identifier expecting zero would have failed on a clean tree, and the reviewer
would have learned to ignore it. What the rule actually forbids is a **token
value** in a build artifact or a persisted artifact, not the environment key's
name in a test that reads it. Corrected commands:

```bash
# 1. The fixture secret VALUE appears only in the *.dbtest.ts files that define it.
#    WI-7's fixtures use one known literal — "wh-secret-batch25" — precisely so
#    this is greppable at all. Listing FILES (-l) and filtering the legitimate
#    ones is what makes the expectation "no output", which is checkable; a
#    `| wc -l` whose expected number is "0 outside the fixture file" is not.
grep -rl "wh-secret-batch25" apps/web/dist apps/web/src packages/*/src \
  | grep -v '\.dbtest\.ts$'                       # expect: NO OUTPUT

# 2. The bundle is absolute: neither a token value, nor the identifier, nor the
#    fixture secret belongs in anything the browser downloads.
grep -rn "OPERATOR_TOKEN\|operator-.*-token\|wh-secret-batch25" apps/web/dist | wc -l   # expect 0

# 3. No hard-coded token in non-test source this batch adds. Scope by the diff,
#    not the tree, and exclude test files — see the allowlist note below.
git diff --name-only main...HEAD | grep -E '\.(ts|tsx)$' | grep -vE '\.(test|dbtest)\.tsx?$' \
  | xargs -r grep -nE 'OPERATOR_TOKEN\s*=\s*"'    # expect: NO OUTPUT
```

**The allowlist is "test files", not a message shape.** Revision 1 allowlisted the
literal string `process.env.OPERATOR_TOKEN = "operator-` — too narrow. Run against
this tree it reports four pre-existing, entirely legitimate fixtures:
`control-plane.test.ts:10`, `files/grant-alias.test.ts:27`,
`files/routes.test.ts:19` and `goals.test.ts:21`, each of which names its throwaway
token after its own suite. That is review M13's defect one layer down — a check
whose expected output is unachievable on a clean tree teaches the reviewer to
ignore it. **Commands 1 and 3 were executed on the tree at `2802d36` and produce no
output.** Command 2 must be run *after* `npm run build` — on an unbuilt tree
`apps/web/dist` does not exist and the count is trivially 0. What the rule forbids is
a token **value** in a build artifact or a persisted
artifact (this plan, the PR body, the task output), not the environment key's name
in a test that saves, sets and restores it — the idiom at
`chain.dbtest.ts:126-137`, `hooks.dbtest.ts:100-109`, `scheduler.dbtest.ts:129-139`
and `goals.test.ts:20-26`. Command 3 therefore excludes test files and flags an
assignment anywhere else; `xargs -r` keeps it from reading stdin when the diff
touches no such file. The **bundle** grep stays absolute, because the browser
never needs either (`api.ts:5-8`: the dev proxy injects the bearer server-side).

---

## 16. Rollback, per section

**Global note (the one trap).** `TaskStatus.BACKLOG` is the only irreversible-ish
piece. Before rolling the **API** back to a build without the enum member, run:

```sql
UPDATE "Task" SET status = 'todo' WHERE status = 'backlog';
```

Otherwise Prisma throws while deserializing those rows. This ships as
`docs/runbooks/batch-2.5-rollback.md` (alongside the existing
`files-deployment.md`) — not as folklore in a PR comment — and **that file is
WI-1's deliverable, in WI-1's commit** (review S4; revision 0 named a file no
work item created).

| Section | Rollback | Data lost |
|---|---|---|
| WI-1 schema | Code-only revert is safe: every new column is nullable or defaulted and old code ignores them. Full schema revert per spec §9, in reverse order; the `backlog` enum value **stays** (dropping it rewrites a hot table) | none, until the schema revert |
| WI-2 backfill | Re-runnable; revert code and leave data, or `UPDATE "Task" SET source='manual', "recurringSourceTaskId"=NULL` + `DELETE FROM "TriggerFire" WHERE source='webhook'` | source attribution, backfilled fires |
| WI-3 workflow | Revert **only together with WI-10**; without the guard a `BACKLOG` task hangs run completion | none |
| WI-4 chain API | Additive except the `GET /tasks` `archived` default. That default also changes the Projects page's `Tasks` count and the project detail's per-status counts (§0.1, three call sites) — reverting restores the old, archived-inclusive numbers, which is a visible jump in both directions. Runbook line | none |
| WI-5 task lifecycle | All additive **except two rejections that did not exist**: the `BACKLOG` PATCH guard and `retry`'s archived refusal (errata E-4). Reverting cannot corrupt anything; it only re-permits both | none |
| WI-6 automations | Predicates and the `fireAtTask` lock revert; `schedulePausedAt` becomes an ignored column and paused automations **resume firing** — run the pause-equivalent by hand (move them out of `TODO`) before reverting. Reverting the `fireAtTask` lock also re-permits an archived AT task to fire; archive those tasks' definitions or clear their `runAt` first | pause state |
| WI-7 triggers | Additive routes; the hook's paused-`401` and duplicate-`200` revert with the code; the ledger is append-only and unread elsewhere | replay protection, pause state, ledger |
| WI-8 web leaves | Revert drops `cronstrue` from `package.json` + lock, and `fatal`/`InfoNotice` with it — **so revert WI-11 and WI-10 first**, they are the callers | none |
| WI-9 tabs | Revert the four routes and the NAV `match`; `#/automations` becomes the existing unknown-route notice. The creation panel moved files in this item, so a partial revert must put `NewTask` back in `Tasks.tsx` or the board loses `Create Task` entirely | none |
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
- **G3 — `chainProgress` cost at real volume.** The now-three-query design (C5,
  revision 1) is reasoned, not measured. At dogfood volume (hundreds of tasks) it
  is irrelevant; `@@index([projectId, archivedAt, status])` covers the board
  query, `@@unique([chainId, chainIndex])` covers the chain query, and
  `@@index([recurringSourceTaskId])` covers the last-fire group-by. All three are
  constant in task count, which is the property E4 actually asks for.
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

Added in revision 1:

- **G6 — `SELECT … FOR UPDATE` through `tx.$queryRaw` (C9).** The shape is
  established in this repo (`workflow.ts:297-307` issues savepoints on a
  transaction client), and the lock is plain Postgres, but this exact call has
  not been executed here. If Prisma's typed `$queryRaw` on a transaction client
  misbehaves, the fallback is `tx.$executeRawUnsafe` with the id bound through a
  parameterised `$queryRawUnsafe` — **never string interpolation of an id into
  SQL**. The race tests in WI-5/WI-6 are what prove the lock works; if they pass
  without it, they are not synchronised properly and the test, not the lock, is
  wrong.
- **G7 — Prisma's interactive-transaction `timeout` as the hang boundary
  (WI-3).** Prisma closes the transaction server-side and the next query throws
  `P2028`; that is documented behaviour, not measured here. The negative control
  in WI-3 is what verifies it, and it must actually be run — if the un-guarded
  test hangs instead of failing, the boundary did not work and the disposable
  client's `$disconnect()` is the next lever.
- **G8 — `Run` rows are assumed to be counted, not maxed, for the budget** (M2).
  `startable` uses `total >= maxSessionsPerTask`, while the existing retry route
  uses `last.runNumber >= last.maxRunsPerTask` (`app.ts:1372`). The two agree
  whenever run numbers are dense, which they are for every path in this repo. If
  a gap ever appears, the count is the conservative side (it refuses earlier).
- **F4 (follow-up, not fixed here) — `ApiError` carries no structured detail**
  (C10). Three separate spec behaviours wanted it in this batch alone. Widening
  `parseError`/`useAction` to keep `issues`/`unresolved`/success payloads is a
  one-file change with an app-wide blast radius; it belongs to a batch that can
  re-test every page, not to one landing four new ones. Backlog line.
- **F5 (follow-up, not fixed here) — `usePoll` silently serves stale data on
  every error** (C11). `fatal()` fixes the two pages this batch touches. The
  other pages still render a deleted row indefinitely. Backlog line.

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

One added by revision 0:

- **O5** — the trigger endpoints straddle two base paths
  (`/triggers/:id/pause` vs `/task-templates/:id/fire`, C6). Implemented as the
  spec writes them so the reviewer's checklist stays valid. Worth unifying under
  `/triggers/:id/*` in a later batch, together with the template-creation UI that
  O2 waits on.

Two added by revision 1. Both are places where the review showed the **spec** is
wrong; per this chain's standing rule the plan records them and implements the
spec as written rather than re-specifying:

- **O6 — should the approved spec be amended with §0.4's errata?** Five clauses
  of `docs/specs/batch-2.5-tasks-visibility.md` are superseded by this plan
  (the active-run set, the in-migration backfill, the `archive-done` envelope,
  and two silent additions). The plan does not edit an approved artifact from an
  earlier chain step — §0.4 carries the errata one-directionally instead. If Leo
  wants the spec amended so a future reader of the spec alone is not misled, it
  is a small follow-up commit. **Until then, §0.4 governs.**
- **O7 — spec §4.6-T8 describes a state the schema forbids.** T8 says "the
  template's webhook repo was deleted → if the FK nulls the repo, the trigger
  drops off the list". The FK is `onDelete: Restrict` (`schema.prisma:410`,
  proven at `migration.dbtest.ts:43-52`), so the repo cannot be deleted at all
  while a template references it, and "drops off the list" contradicts §4.5,
  which defines a trigger by its **secret**. This plan implements and tests the
  reachable half (a null `webhookRepoId` ⇒ `canFire: false` ⇒ `400`) and changes
  no relation. Whether repo deletion should instead null the FK — with the list
  filtering and migration that implies — is Leo's call, not a plan-step decision.
