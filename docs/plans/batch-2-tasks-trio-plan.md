# PLAN — Batch 2: Tasks automation trio (cron, webhook, chain advance) + dead-model cleanup

Status: revised after plan review (FAIL → 6 must-fix, 6 should-fix all addressed) · Author: plan agent · Date: 2026-08-15
Spec: `docs/specs/batch-2-tasks-trio.md` (PR #2, approved). Authority behind it:
`docs/BACKLOG-V2.md` 批次 2, `docs/reference/danny-agentos-video/decisions.md` §5/§10/§12.
Review baseline: plan commit `3c75c4b`, spec commit `9b995b8`. See §10 修订记录.

Planning only. Five work items in dependency order, one commit each, all on the
feature branch `agentos/cmsv93pyg006dmpj2xeqjspog/run-1` so the batch lands as
one PR with one migration. Every spec requirement (§4.1–§4.4, §5, §6) maps to a
numbered step below; §8 records the six ambiguities and their now-final
rulings (Leo's pre-ruling + review verdicts) — nothing is left open.

## 0. Approach summary

- **One migration first + real-Postgres test harness** (WI-1): all schema
  changes ride together (decisions §5 — one independent migration per batch).
  The inbox telemetry deletion is in the same commit because dropping
  `InboxConnectionWindow` breaks `packages/inbox/src/index.ts` compilation the
  moment the Prisma client regenerates. WI-1 also introduces the
  `*.dbtest.ts` harness (docker-compose Postgres, dedicated schema, `prisma
  migrate deploy`) because applying the migration to an empty schema *is* the
  executable migration verification, and WI-2/4/5 concurrency tests need it.
- **Chain advance before cron/webhook** (WI-2): it is pure behavior change on
  the existing schema, and both later features create chains/tasks that flow
  through it; landing it early lets their tests assert end-to-end flow.
- **Cron in two commits** (WI-3 API surface + validation, WI-4 scheduler
  loop): the validation layer is independently testable and reviewable; the
  loop builds on it.
- **Webhook last** (WI-5): needs the WI-1 columns and reuses
  `instantiateTemplate` untouched except for actor attribution.
- **Transactional dedupe pattern**: every multi-writer race in this batch is
  resolved with the same house pattern as `applyInboxDecisionTx`
  (`packages/db/src/workflow.ts:200-204,267-275`): a conditional `updateMany`
  on the row's **own observed columns** inside a ReadCommitted transaction —
  PostgreSQL re-checks the predicate after a concurrent row lock releases, so
  the loser sees `count === 0` and skips instead of erroring. Three instances:
  scheduler fire (CAS anchor `runAt`), scheduler quarantine (CAS anchor the
  full observed schedule tuple), and chain successor activation (CAS anchor
  `updatedAt`). A P2002 catch remains as belt-and-braces only.
- **Rollback lever**: `SCHEDULER_POLL_INTERVAL_MS=0` short-circuits scheduler
  startup in `packages/api/src/index.ts`; `createApp` is untouched by the
  loop, so with the lever pulled the API behaves byte-identically (AC-C6).

Verification commands used throughout: `npm test -w @agentos/api` (mock
suites), `npm run test:db -w @agentos/api` (real-Postgres suites, needs
`docker compose up -d postgres`), `npm test -w @agentos/inbox`,
`npm run typecheck`, the exact `prisma migrate diff` command in WI-1, and the
manual §8-of-spec walkthrough at the end.

---

## WI-1 — Migration + dead-model cleanup + real-Postgres test harness

Covers spec §4.4, §5, the additive schema needs of §4.1/§4.2, and the test
infrastructure every later WI's concurrency ACs depend on (must-fix 3).

**Files**

- `packages/db/prisma/schema.prisma`
  - Delete models `Trigger` (lines ~854–872), `Automation` (~874–893),
    `InboxConnectionWindow` (~841–852).
  - Delete relation fields: `Project.triggers`, `Project.automations`,
    `Agent.triggers`, `Agent.automations`, `Secret.webhookTriggers`,
    `TaskTemplate.automations`.
  - Add to `TaskTemplate`: `webhookSecretId String?`, `webhookRepoId String?`,
    `webhookPayloadMapping Json?`, relations
    `webhookSecret Secret? @relation("WebhookCredential", fields: [webhookSecretId], references: [id], onDelete: SetNull)`
    (relation name migrates from the dropped `Trigger`, per spec) and
    `webhookRepo Repo? @relation("WebhookRepo", fields: [webhookRepoId], references: [id], onDelete: Restrict)`;
    back-relations `Secret.webhookTemplates` and `Repo.webhookTemplates`;
    `@@index` on the two FK columns.
  - Add to `Task`: `@@index([scheduleKind, status, runAt])`.
- `packages/db/prisma/migrations/20260816000000_batch2_tasks_automation/migration.sql`
  — generated via `npm run db:migrate -w @agentos/db` (`prisma migrate dev`).
  Expected content: 3× `DROP TABLE` (no inbound FKs on any of the three —
  FK-safe in any order), `ALTER TABLE "TaskTemplate" ADD COLUMN` ×3 + 2 FKs,
  `CREATE INDEX` on `Task`. Add a README comment in the migration noting that
  any residual `Trigger`/`Automation`/`InboxConnectionWindow` rows are
  accepted loss (spec §5.4).
- `packages/inbox/src/index.ts` — remove the telemetry writes: the
  `window` create (line 19), the two `inboxConnectionWindow.update` calls in
  the supervisor status callback (lines 96–101; keep the `console.log`), and
  the update in `shutdown` (line 109). The supervisor callback body shrinks to
  the log line; shutdown keeps `clearInterval`/`supervisor.stop`/`$disconnect`.
- **New `packages/api/src/testdb.ts`** — the real-Postgres harness (must-fix
  3; no such harness exists today — `app.test.ts` casts object literals to
  `PrismaClient` and stays that way for branch-coverage tests):
  - URL resolution: `TEST_DATABASE_URL` if set, else
    `postgresql://agentos:agentos@localhost:5432/agentos?schema=agentos_test`
    — a dedicated schema in the docker-compose Postgres (`docker-compose.yml`
    already provisions `agentos`/`agentos`), so no extra database or
    provisioning step is needed.
  - `setupTestDb()` (once per test process): `execSync` of
    `npx prisma migrate deploy --schema <repo>/packages/db/prisma/schema.prisma`
    with `DATABASE_URL` set to the test URL. This creates the schema, applies
    every migration in order, and therefore **executes** the WI-1 migration
    SQL as part of the test run. Returns a real `new PrismaClient({ datasources: { db: { url } } })`.
  - `resetTestDb(db)`: `TRUNCATE` every table in the test schema except
    `_prisma_migrations` (enumerated from `pg_tables`), `RESTART IDENTITY
    CASCADE`; called in each test's `beforeEach`.
  - DB-backed tests use the filename suffix `.dbtest.ts` so the existing
    `npm test` glob (`src/*.test.ts`) never picks them up and stays green
    without a database.
- `packages/api/package.json`: add script
  `"test:db": "node --import tsx --test src/*.dbtest.ts"`; root
  `package.json` gains `"test:db": "npm run test:db -w @agentos/api"`.
- **New `packages/api/src/migration.dbtest.ts`** — WI-1's executable
  verification: after `setupTestDb()`, assert via `$queryRaw` over
  `information_schema` that `Trigger`/`Automation`/`InboxConnectionWindow`
  tables are absent, the three `TaskTemplate` columns and two FKs exist, and
  the `Task` index exists; assert `onDelete` behavior with real rows
  (delete a webhook secret → template column nulls out; deleting a repo
  referenced by `webhookRepoId` → rejected).

**Interfaces changed**

- Generated Prisma client loses `trigger`, `automation`,
  `inboxConnectionWindow` delegates; gains three `TaskTemplate` fields. No
  TypeScript outside `packages/inbox/src/index.ts` references the dead models
  (verified by grep), so this is the only code delta.
- New dev-facing scripts `test:db` (api + root).

**Tests / verification**

- Exact drift check (AC-D1), runnable after migrations with `DATABASE_URL`
  pointing at the same migrated schema used by the datamodel:

  ```
  DATABASE_URL="postgresql://agentos:agentos@localhost:5432/agentos?schema=agentos_test" \
    npm run db:drift-check
  ```

  This uses Prisma 6.19's working `--from-url` path and binds `DATABASE_URL`
  to the same namespace, avoiding the false whole-schema remove/add diff from
  `--from-migrations` with a differently named shadow schema. Exit 0 = no
  drift. Additionally `npm run db:validate`.
- `npm run test:db -w @agentos/api` — runs `migration.dbtest.ts`
  (migration applies to an empty schema; dead tables gone; FK behavior).
- `grep -rn "inboxConnectionWindow\|\bTrigger\b\|\bAutomation\b"` over
  `packages/*/src` clean (AC-D1).
- `npm test -w @agentos/inbox` green (connection/supervisor tests never touched
  the model — AC-D2).
- `npm run typecheck` across all packages (catches any missed client usage).

**Commit**: `feat(db): batch 2 migration — drop Trigger/Automation/InboxConnectionWindow, webhook columns on TaskTemplate, schedule poll index, real-Postgres test harness`

---

## WI-2 — Chain auto-advance generalized to chainId/chainIndex

Covers spec §4.3 (K1–K9, AC-K1–K4) plus Leo's ruling that gated non-template
chain tasks get an Inbox card on run success (must-fix 1, in batch 2 scope).

**Files**

- `packages/db/src/workflow.ts`
  - New exported routine, e.g.
    `activateChainSuccessor(tx, task, options: { sourceRunId?: string | null; chatId?: string | null }, now): Promise<{ nextTaskId: string | null; gated: boolean }>`:
    1. Successor lookup (should-fix 2): only when **both** `task.chainId` and
       `task.chainIndex` are non-null —
       `findFirst({ where: { projectId: task.projectId, chainId, chainIndex: { gt: task.chainIndex } }, orderBy: { chainIndex: "asc" } })`
       (smallest higher index — gap-tolerant, K6; `projectId` scopes out any
       cross-project chain collision). If `chainId` is set but `chainIndex` is
       null (malformed pre-existing/manual row — the both-or-neither zod guard
       only protects new API writes), write one activity
       "chain row missing chainIndex; auto-advance skipped" on the task and
       fall through to the `followUpTaskId` branch. Else if no chain, fall
       back to `followUpTaskId` (A8).
    2. No successor: if the task had a `chainId`, write a
       "chain complete" activity on it (K4); return.
    3. **Successor activation CAS** (must-fix 2 — K5, K9, AC-K3). The prior
       read-then-check design was not transactionally idempotent
       (`enqueueTaskRun` at `packages/db/src/workflow.ts:32-60` does an
       unguarded create and no retry helper exists in the repo). Replace with
       the house pattern:
       - Read the successor (including its latest run status and
         `updatedAt`).
       - If it already has a run in
         `QUEUED|CLAIMED|PROVISIONING|RUNNING|WAITING_INBOX`, only ensure
         activity, never enqueue (fast path).
       - Otherwise claim the row:
         `tx.task.updateMany({ where: { id: successor.id, updatedAt: successor.updatedAt }, data: { status: TODO } })`
         — the CAS anchor is the observed `updatedAt` (Prisma bumps it on
         every update, so any concurrent advancer/patch invalidates the
         claim). `count === 0` ⇒ another transaction advanced first ⇒ write
         nothing further and return without enqueueing. `count === 1` ⇒ this
         transaction owns activation; the claim also resets a rejected
         `REVIEW`/`DOING` leftover to `TODO`.
       - Belt-and-braces: wrap the subsequent `enqueueTaskRun` so a residual
         `P2002` (on `Run.dedupeKey` or `@@unique([taskId, runNumber])`) is
         caught inside the routine and treated as already-advanced (return
         `nextTaskId` with no enqueue) — it must never surface as a 500/409
         to the API client of the completing/patching request. All three
         callers (run complete, Inbox approve, operator PATCH) go through
         this one routine inside a ReadCommitted `$transaction`, so the
         semantics are specified once.
    4. Agent successor with repo (claim won): `enqueueTaskRun`, activity
       "predecessor completed; step queued".
    5. Human / no-agent / no-repo successor: when `sourceRunId` is present,
       set `REVIEW` + `gateQuestion` card (template and non-template alike —
       `gateQuestion` at `workflow.ts:89-118` only needs a run with a
       session, which every run-success/gate-approve path has); on
       operator-PATCH advance (`sourceRunId` null — no run/session exists for
       a card) leave `TODO` with an activity entry and no Inbox message (A9).
  - `advanceTemplateTask`: replace its successor selection
    (`task.followUpTask`) with `activateChainSuccessor`; the gating of the
    *current* task (approvalGate → REVIEW + card) stays as is. Behavior for
    template chains must be unchanged (AC-K2: existing template tests green).
  - `applyInboxDecisionTx` approve branch (lines ~234–237): replace the
    `followUpTaskId`-only block with `activateChainSuccessor` (passing
    `sourceRunId: question.session.run.id`). Reject branch unchanged (K8).
- `packages/api/src/app.ts`
  - `POST /runner/runs/:runId/complete` (~line 1627): today only
    `run.task?.templateId` advances. Add the non-template chain branch, per
    Leo's ruling (must-fix 1 — §8-1):
    - success + `chainId` + `approvalGate === false`: set `DONE`, call
      `activateChainSuccessor` inside the same transaction (K1).
    - success + `chainId` + `approvalGate === true`: set `REVIEW` **and
      create the gate card** via `gateQuestion(tx, task.id, run.id, chatId)`
      — same card, dedupe (`gate:task:<id>:run:<runId>`), and chatId source
      as the template branch. Inbox approve then flows through
      `applyInboxDecisionTx` → task `DONE` → `activateChainSuccessor`
      advances the chain. This is in-scope work, not future work.
    - Non-chain non-template tasks keep today's `REVIEW` parking unchanged.
  - `PATCH /tasks/:taskId` (~line 970): when the patch transitions status to
    `DONE` and the task has a `chainId` or `followUpTaskId`, wrap
    update + advance in one ReadCommitted `db.$transaction` and call
    `activateChainSuccessor` (no `sourceRunId`) — trigger 3 (K3). The
    template+gate 409 guard at line 974 stays untouched (AC-K4). For a
    **non-template gated** task, PATCH → DONE stays legal (operator
    override); explicitly defined behavior: the transaction also closes any
    open gate card for the task
    (`tx.inboxMessage.updateMany({ where: { gateTaskId: task.id, status: OPEN }, data: { status: CLOSED } })`)
    so a stale card cannot be approved later — and if one races through
    anyway, `applyInboxDecisionTx`'s own OPEN CAS or the successor-activation
    CAS makes it a no-op. Tasks with neither chain nor follow-up take exactly
    today's code path (K7).
  - `taskInput` (~line 179): add optional `chainId` (string cuid-ish, reuse
    `id` schema? — no: `chainId` is a `randomUUID()` for template chains, so
    plain `z.string().trim().min(1).max(100)`) and `chainIndex`
    (`z.number().int().min(0)`), with a `superRefine` requiring both-or-neither
    (A10). `taskPatch` explicitly does **not** gain them.
  - `POST /projects/:projectId/tasks`: **no route-local P2002 catch**
    (should-fix 3 / §8-5 ruling): the app-wide error handler at
    `packages/api/src/app.ts:1732-1736` already maps every Prisma P2002 to
    409, which satisfies the spec's "existing 409". The test asserts the 409
    lands through that path.

**Interfaces changed**

- `@agentos/db` exports `activateChainSuccessor`; `advanceTemplateTask`
  signature unchanged. API: `taskInput` accepts `chainId`/`chainIndex`;
  `PATCH /tasks/:id` → DONE now has side effects on successors and open gate
  cards; run success on a gated non-template chain task now produces an Inbox
  gate card.

**Tests** (K-rows)

- `packages/api/src/workflow.test.ts` (extend, mock-Tx style like the existing
  file — branch coverage): K1 run-success advance for non-template chain;
  **gated non-template chain run success → REVIEW + gateQuestion card
  created** (must-fix 1); K2 gate approve via chain lookup (agent + human
  successor variants); K4 last-step no-op + chain-complete activity; K5/K9
  fast-path idempotency (successor already has an active run); K6 index gap;
  K8 reject unchanged; malformed chain row (chainIndex null) → activity +
  followUpTaskId fallback (should-fix 2).
- **New `packages/api/src/chain.dbtest.ts`** (real Postgres via WI-1 harness
  — must-fix 2/3): AC-K3 concurrent double advance — run two
  `activateChainSuccessor` transactions over the same predecessor with
  `Promise.all` → exactly one run row on the successor, zero client-visible
  errors; CAS-loser path (successor patched between read and claim → no
  enqueue); PATCH → DONE closes the open gate card and a subsequent approve
  attempt is a duplicate no-op.
- `packages/api/src/app.test.ts` (extend): K3 operator PATCH → DONE queues
  successor run; K7 no-chain PATCH behaves as today; AC-K4 template-gate PATCH
  still 409; create with `chainId`+`chainIndex` collision → 409 via the
  global P2002 handler; create with only one of the pair → 400.
- Regression: existing `templates.test.ts`, `workflow.test.ts` stay green
  (AC-K2).

**Commit**: `feat(workflow): chain auto-advance on run success, gate approval, and operator PATCH`

---

## WI-3 — Schedule fields on the task API + cron validation

Covers spec §4.1 rows C1, C5, C8, C9-at-create and the input extensions of §3.5.

**Files**

- `packages/api/package.json`: add dependency `cron-parser` (MIT, maintained,
  IANA-timezone/DST aware `CronExpressionParser.parse(expr, { tz })`).
  **Caveat (must-fix 4): cron-parser accepts 6-field/seconds expressions and
  its strict mode requires six fields, so it does not itself enforce the
  spec's 5-field dialect.** `computeNextOccurrence` therefore pre-validates
  the dialect before parsing: trim, split on whitespace, require **exactly 5
  fields**, and reject `@`-prefixed macros (`@daily`, `@reboot`, …); only
  then hand to `CronExpressionParser.parse`.
- New `packages/api/src/scheduler.ts` (shared by WI-4), first slice:
  - `computeNextOccurrence(cron: string, timezone: string | null, after: Date): Date`
    — pure; throws on non-5-field dialect (above) or unparsable expression;
    `timezone ?? server local` (A5).
  - `validateSchedule(fields)` helper used by both create and patch: CRON
    requires parsable 5-field `cron` (C5); AT requires `runAt` **and an
    agent+repo assignee** (must-fix 5 — see below); timezone, when non-null,
    must be a valid IANA name (`Intl.DateTimeFormat` probe; §8-6). Returns
    the normalized `{ scheduleKind, runAt, cron, timezone }` where for CRON,
    `runAt` is always recomputed from the expression (caller-supplied `runAt`
    ignored — §8-2 ruling; the zod field description documents this and a
    test asserts it).
  - **Human/agent-less `AT` semantics (must-fix 5)**: `scheduleKind=AT`
    requires `assigneeType === AGENT` with agent and repo set, enforced at
    create **and** on every patch of the merged view (including patches that
    flip `assigneeType` or clear the agent/repo on an existing AT task) →
    400. Rationale: `fireAtTask` enqueues run 1 for the task itself, and
    `enqueueTaskRun` (`workflow.ts:32-44`) throws for any human/no-agent/
    no-repo task — without this rule a valid-looking human AT task would fail
    every due tick forever. Scheduled human TODOs are not promised anywhere
    in the spec (C10 covers human **CRON** only, which is unaffected: cron
    copies are materialized without enqueue).
- `packages/api/src/app.ts`
  - `taskFields`/`taskInput`: add `scheduleKind` (`z.nativeEnum(ScheduleKind)`,
    default `NOW`), `runAt` (`z.coerce.date().nullable()`), `cron`
    (`z.string().trim().min(9).max(100).nullable()`), `timezone`
    (`z.string().trim().min(1).max(64).nullable()`). Cross-field checks run in
    the route handler via `validateSchedule` so patches can merge with the
    stored row: `PATCH` on any schedule field re-validates the merged view
    and recomputes `runAt` for CRON (spec: "set on create/patch").
  - `POST /projects/:projectId/tasks`: enqueue run 1 at creation **only when
    `scheduleKind === NOW`** (today's block at lines 939–958 gets the guard);
    AT/CRON tasks are created with no run (C1, C9 waits for the loop). 400 on
    validation failure (C5/C8/AT-assignee, AC-C5).
  - `taskPatch`: accepts the same four fields; pausing/retuning stays
    "patch `cron`/`runAt`/`scheduleKind`" per spec non-goals.

**Interfaces changed**

- `taskInput`/`taskPatch` shape; task creation semantics for AT/CRON (no
  immediate run); AT requires an agent+repo assignee. Defaults preserve
  today's behavior — `scheduleKind` omitted ⇒ `NOW` ⇒ byte-identical create
  path.

**Tests**

- `packages/api/src/scheduler.test.ts` (new, pure unit — no DB):
  `computeNextOccurrence` — basic next-minute math, `Asia/Shanghai` timezone
  case, DST boundary (e.g. `America/New_York` spring-forward), invalid
  expression throws; **dialect enforcement (must-fix 4): 6-field
  `0 */2 * * * *` throws, seconds-style `* * * * * *` throws, `@daily`
  throws, 5-field `*/2 * * * *` accepted**.
- `packages/api/src/app.test.ts` (extend): C1 CRON create → 201, zero runs,
  `runAt` = correct next occurrence; CRON create with caller-supplied `runAt`
  → stored `runAt` is the computed one (§8-2); C5 invalid cron → 400;
  6-field cron → 400; invalid timezone → 400 (§8-6); C8 CRON without cron /
  AT without runAt → 400; **AT with human assignee or missing agent/repo →
  400, at create and via patch of the merged view** (must-fix 5); C9 AT with
  past `runAt` → 201 + no run yet; NOW default → run created exactly as
  before (regression).

**Commit**: `feat(api): schedule fields on task create/patch with cron validation`

---

## WI-4 — Scheduler loop

Covers spec §4.1 rows C2–C4, C6, C7, C9-fire, C10 and AC-C2/C3/C4/C6.

**Files**

- `packages/api/src/scheduler.ts` (second slice):
  - `fireCronTask(db, task, now)` — one transaction
    (`ReadCommitted`, house pattern):
    1. **CAS dedupe (the spec's transactional dedupe)**:
       `tx.task.updateMany({ where: { id: task.id, scheduleKind: CRON, status: TODO, runAt: task.runAt }, data: { runAt: computeNextOccurrence(cron, tz, now) } })`
       — advancing `runAt` from **now** (not from the stored value) coalesces
       missed occurrences into one catch-up fire and lands strictly in the
       future (C4, AC-C3). `count === 0` ⇒ another tick won the race or the
       task changed ⇒ skip (AC-C2 double-tick safety).
    2. Create the copy task: same `projectId/repoId/assigneeAgentId/
       assigneeType/approvalGate/description/workingDirectory/targetBranch/
       maxDurationMin/stallTimeoutMin/maxSessionsPerTask/spendCap/
       spendCapApplicable` (should-fix 1: the budget-guard pair is copied so
       a recurring definition cannot lose an operator-set cap; run-level
       propagation is unchanged — `enqueueTaskRun` today does not copy
       `spendCap` onto `Run`, and this batch does not change that);
       `scheduleKind: NOW`;
       `cron/timezone/runAt/chainId/chainIndex/followUpTaskId/templateId` null;
       name = `` `${task.name} — ${fireTime formatted in task tz}` `` (spec
       naming rule; clamp to the 200-char column limit).
    3. If the copy is agent-assigned with a repo: `enqueueTaskRun(tx, copy.id)`
       (C2). Human-assigned: leave `TODO`, no run (C10).
    4. Activity on both tasks with
       `metadata: { recurringTaskId, firedAt }` (spec bookkeeping).
    5. **Quarantine on `computeNextOccurrence` throw** (malformed stored
       cron/timezone, C6 — must-fix 6): a plain clear-`runAt` transaction
       could erase a concurrent operator repair (PATCH recomputes `runAt`
       between the failed read and the write). Quarantine is therefore itself
       a CAS:
       `tx.task.updateMany({ where: { id: task.id, scheduleKind: CRON, status: TODO, cron: task.cron, timezone: task.timezone, runAt: task.runAt }, data: { runAt: null } })`
       — conditional on the **full observed schedule tuple**, and the single
       parse-failure activity is written only when `count === 1`. A repaired
       row no longer matches (cron/timezone/runAt changed) so the repair
       survives; the quarantined task leaves the due set until re-patched (no
       tight loop, AC-C5).
  - `fireAtTask(db, task, now)` — enqueue run 1 for the task itself inside a
    transaction; no copy, `runAt` untouched (A4). Dedupe: the due query
    requires `runs: { none: {} }`, and the `@@unique([taskId, runNumber])` +
    `dedupeKey` constraint makes the concurrent-tick loser fail its insert;
    catch P2002 and treat as already-fired (AC-C4 exactly once).
  - `schedulerTick(db, now = new Date())` — the poll body, exported for tests:
    query due CRON (`scheduleKind: CRON, status: TODO, runAt: { lte: now }` —
    rides the WI-1 index) and due AT (`scheduleKind: AT, status: TODO,
    runAt: { lte: now }, runs: { none: {} }, assigneeType: AGENT` — the
    assignee filter is defense-in-depth behind WI-3's create/patch rejection,
    must-fix 5); fire each; per-task try/catch, and a task whose fire threw
    unexpectedly is quarantined with the same observed-tuple CAS (clear
    `runAt` + one activity) so it, too, leaves the due set instead of
    tight-looping; returns counts for logging.
  - `startScheduler(db)` — reads `SCHEDULER_POLL_INTERVAL_MS`
    (default 30 000); **`0` ⇒ return null, no interval ever created**
    (rollback lever, AC-C6); otherwise `setInterval` with the same busy-flag
    reentrancy guard as the inbox delivery poll
    (`packages/inbox/src/index.ts:73–79`); returns the timer for shutdown.
- `packages/api/src/index.ts`: after `serve(...)`, call
  `startScheduler(prisma)`; `clearInterval` in `shutdown`. `createApp` is
  untouched, so app-level tests never see the loop.
- `.env.example` (exists; currently ends at line 55 without the variable —
  should-fix 4): add `SCHEDULER_POLL_INTERVAL_MS=30000` with a comment noting
  `0` disables the loop.

**Interfaces changed**

- New env var `SCHEDULER_POLL_INTERVAL_MS` (API process; documented in
  `.env.example`).
- `Task.runAt` semantics for CRON: "next fire at", server-maintained.

**Tests** — split between pure-unit and the WI-1 real-Postgres harness
(must-fix 3); drive `schedulerTick(db, fakeNow)` directly — no timers in
tests.

`packages/api/src/scheduler.dbtest.ts` (real Postgres — everything that
claims locking/isolation/unique behavior):

- C2: due CRON task → exactly one copy (`scheduleKind=NOW`, cleared schedule
  fields, suffixed name, copied `spendCap`/`spendCapApplicable`) + one QUEUED
  run; definition `runAt` advanced; activity on both sides.
- AC-C2 race: run two `fireCronTask` bodies concurrently
  (`Promise.all`) over the same due row → exactly one copy.
- C3: two due occurrences in the past → single tick fires once, `runAt`
  strictly future.
- C4/AC-C4: due AT task → run 1 queued once; second tick is a no-op;
  concurrent double `fireAtTask` → one run, loser's P2002 swallowed.
- **Must-fix 6 race**: start a fire on a malformed-cron task, PATCH-repair
  cron/timezone (recomputing `runAt`) before the quarantine write → the
  repair survives (`runAt` non-null, no failure activity for the repaired
  tuple).

`packages/api/src/scheduler.test.ts` (extend the WI-3 unit file — branch
coverage on mocks):

- C6: stored garbage cron → no fire, quarantine CAS issued with the observed
  tuple, one activity only on `count === 1`, tick returns normally.
- C7: definition with `status != TODO` never fires; setting back to `TODO`
  resumes (runAt still due).
- C10: human-assigned CRON → copy exists `TODO`, zero runs.
- AC-C6: `SCHEDULER_POLL_INTERVAL_MS=0` ⇒ `startScheduler` returns null
  (unit-level assert; the byte-identical claim is covered by the untouched
  `createApp` + existing suite).

**Commit**: `feat(api): scheduler loop fires due CRON/AT tasks with transactional dedupe`

---

## WI-5 — Webhook trigger on TaskTemplate

Covers spec §4.2 (W1–W9, AC-W1–W4).

**Files**

- New `packages/api/src/hooks.ts` — keeps `app.ts` from growing another 200
  lines; exports:
  - `resolvePayloadVariables(template, payload)`: walks
    `webhookPayloadMapping.map` dot-paths into the JSON body; scalar
    (string/number/boolean, stringified) ⇒ value; object/array/missing ⇒ fall
    to `defaults` literal ⇒ else collect as unresolved (W4/W5). Resolves for
    every name in `template.variables`; returns
    `{ variables } | { unresolved: string[] }`.
  - `authenticateWebhook(db, templateId, suppliedSecret)`: single code path
    returning the template or null — load template incl. `webhookSecret`;
    null template, `webhookSecretId` null, **`webhookRepoId` null** (config
    hole defense-in-depth — §8-4), `disabledAt` set, decrypt failure,
    or mismatch all collapse to the same null (W2/W3/W6, AC-W4). Comparison:
    `timingSafeEqual(sha256(supplied), sha256(decrypted))` — hashing first
    gives constant time regardless of length (same trick as
    `auth.ts` `tokenEquals` but length-safe; AC-W3). Decrypt via the existing
    `decryptSecret` (`packages/api/src/secrets.ts`).
- `packages/api/src/app.ts`
  - `isPublic` (~line 310): match **only the exact route shape**
    (should-fix 5): `method === "POST" && /^\/hooks\/templates\/[^/]+$/.test(path)`
    — the spec grants public access to this one route; a broad
    `/hooks/` prefix would silently pre-authorize future hook endpoints.
    AC-W3's regression test pins this down (`POST /hooks/other` → 401).
  - Route `POST /hooks/templates/:templateId`:
    1. `bodyLimit` (hono built-in middleware) at 1 MB → 413; JSON parse +
       "must be an object" check → 400 (W7).
    2. `authenticateWebhook` with header `X-AgentOS-Webhook-Secret` → on null,
       401 `{ error: "Unauthorized" }` — identical body/status for every
       failure flavor (W2/W3/W6, AC-W4). Add the header to the CORS
       `allowHeaders` list.
    3. `resolvePayloadVariables` → 400 listing unresolved names (W4/W5).
    4. `instantiateTemplate(db, template.projectId, template.id, { repoId: template.webhookRepoId, variables })`
       — response 201 `{ chainId, taskIds }` (W1). All-or-nothing:
       `instantiateTemplate` is already one Serializable transaction, and
       every failure path above runs before it (AC-W2). The
       secret-without-repo state is primarily prevented at PATCH time
       (below); the route's 401 for it is defense-in-depth for rows written
       outside the API (§8-4 ruling).
  - `PATCH /task-templates/:templateId` (new — no template PATCH exists):
    zod `webhookConfigPatch` accepting the three nullable fields; validation
    on the **merged** config (stored row + patch): secret exists with
    `purpose === WEBHOOK` (else 400); repo belongs to the template's project
    (else 400) (W9); **a non-null `webhookSecretId` in the merged result
    requires a non-null in-project `webhookRepoId`** (should-fix 6 — else
    400 with an explicit message, so an operator cannot enable a webhook that
    can only ever 401); nulling the secret while keeping the repo stays legal
    (the documented kill switch); mapping shape
    `{ map?: Record<string,string>, defaults?: Record<string,string|number|boolean> }`.
    Operator-only (default auth already enforces it).
  - `GET /projects/:projectId/task-templates` / `GET /task-templates/:templateId`
    already return the raw model ⇒ new columns appear automatically; they
    never include the `Secret` relation, so no secret value can leak (spec:
    only `webhookSecretId` visible). Add a test asserting absence anyway.
- `packages/api/src/templates.ts` — `instantiateTemplate` gains an optional
  `options?: { actorType?: string; activityMetadata?: Record<string, unknown> }`
  defaulting to today's `control-plane`, so the webhook fire writes
  `actorType: "webhook"` + fire metadata on the creation activities (W1,
  AC-W1 "plus fire metadata"). Consequential edit — named here per the task
  brief; existing callers pass nothing and are unaffected.

**Interfaces changed**

- New public route `POST /hooks/templates/:templateId` (exact-shape public
  matcher); new `PATCH /task-templates/:templateId` (merged-config
  validation); `instantiateTemplate` optional options param; CORS
  allow-header addition.

**Tests** — split per must-fix 3:

`packages/api/src/hooks.dbtest.ts` (real Postgres via the WI-1 harness,
app-level through `createApp` with the real client — the DB-state ACs):

- W1 happy path — 201, chain + first run + activities equal the operator
  instantiate shape (AC-W1); W4 missing mapped field → 400 with names, zero
  `Task`/`Run`/`TaskActivity` rows (AC-W2, assert real row counts); W8 double
  fire → two chains.

`packages/api/src/hooks.test.ts` (mock — branch coverage and pure units):

- W2/W3 wrong secret vs unknown template vs non-enabled template vs
  secret-set-repo-null → byte-identical 401s (AC-W4); W5 object-valued path
  → 400; W6 disabled secret → 401; W7 non-JSON → 400 and >1 MB → 413;
  W9 PATCH with non-WEBHOOK secret / foreign repo → 400; **merged-config
  PATCH setting a secret while repo stays null → 400; nulling the secret
  with repo retained → 200** (should-fix 6).
- Unit tests for `resolvePayloadVariables` (dot paths, defaults precedence,
  scalar stringification).
- Auth regression (AC-W3): `/hooks/templates/x` reachable with no
  Authorization header; **`POST /hooks/other` and a sibling route (e.g.
  `/tasks`) still 401 without a token** (should-fix 5) — extend the existing
  auth cases in `app.test.ts`.

**Commit**: `feat(api): webhook fire route on task templates with shared-secret auth and payload mapping`

---

## 6. Requirement → step traceability

| Spec item | Covered by |
|---|---|
| §4.1 C1/C5/C8/C9-create, input extensions, AT assignee rule | WI-3 |
| §4.1 C2–C4, C6, C7, C9-fire, C10, poll env, AC-C1–C6 | WI-4 (index + harness from WI-1) |
| §4.2 W1–W9, AC-W1–W4, template PATCH/read-back | WI-5 (columns from WI-1) |
| §4.3 K1–K9, AC-K1–K4, chain fields on create, gated-chain gate card | WI-2 |
| §4.4 + §5 migration, AC-D1–D3 | WI-1 |
| §6 test expectations | per-WI test lists above (mock + dbtest split) |
| §7 rollback levers | WI-4 (`=0` lever), WI-5 (null secret ⇒ 401), WI-2 revert-only (no flag, per spec) |

## 7. Sequencing & PR mechanics

Commits 1→5 in the order above on `agentos/cmsv93pyg006dmpj2xeqjspog/run-1`
(PR #2 accumulates spec + plan + implementation). Between WI-3 and WI-4 an
AT/CRON task can be created but never fires — acceptable inside one PR, flagged
so the implementer doesn't "fix" it by re-adding create-time enqueue. After
every commit: `npm test` + `npm run typecheck`; after WI-1/2/4/5 additionally
`npm run test:db -w @agentos/api` (docker-compose Postgres up). The spec §8
manual walkthrough after WI-5 on a dev instance with a runner attached.

## 8. Ambiguities — 已裁决（评审 + Leo 预裁决，无悬而未决项）

1. **Gated non-template chain task on run success — 已裁决（Leo 推翻计划默认；
   评审 must-fix 1 一致）**: run success creates the same Inbox gate card as
   template gates (REVIEW + `gateQuestion`), in batch 2 scope; Inbox approve
   advances via `activateChainSuccessor`; direct PATCH → DONE stays legal,
   advances the chain, and closes the open card. Implemented in WI-2.
2. **Caller-supplied `runAt` on a CRON task — 已裁决（评审认可计划默认）**:
   the server always recomputes and silently ignores a supplied `runAt`; the
   API field description documents it and an app test asserts it (WI-3).
3. **Cron copy inherits `approvalGate` — 已裁决(评审认可计划默认)**: copied;
   a gated recurring task's fires each park in `REVIEW` (WI-4 field list).
4. **Webhook secret without repo — 已裁决（评审推翻计划默认，should-fix 6）**:
   rejected at the authenticated PATCH boundary (merged config: non-null
   secret ⇒ non-null in-project repo, else 400); the route's 401 for such a
   row remains only as defense-in-depth for rows written outside the API
   (WI-5).
5. **`chainId` collision status code — 已裁决（评审推翻计划默认，
   should-fix 3）**: the app-wide P2002→409 handler at `app.ts:1732-1736`
   already provides the spec's "existing 409"; no route-local mapping is
   added (WI-2).
6. **Timezone validation — 已裁决（评审认可计划默认）**: unknown IANA names
   are rejected at create/patch in `validateSchedule` (WI-3), so C6-style
   quarantine can't be caused by a typo'd timezone.

## 9. Revision-loop note

This file was revised in place on the feature branch after the plan review
(verdict FAIL — 6 must-fix, 6 should-fix). §10 records the disposition of
every finding; the review step's re-check reads this same file.

## 10. 修订记录 (plan review of commit `3c75c4b`)

**Must-fix — all six implemented in the plan:**

1. Gated non-template chain run success now creates the Inbox gate card
   (Leo's pre-ruling); PATCH → DONE override defined (advance + close card).
   → WI-2 (`/runner/runs/:runId/complete` branch, PATCH branch, tests).
2. Successor activation is now a real CAS (`updateMany` on observed
   `updatedAt` inside ReadCommitted) with a P2002 swallow as belt-and-braces,
   specified once in `activateChainSuccessor` for all three callers; AC-K3
   gets a concurrent real-DB test. → WI-2 step 3 + `chain.dbtest.ts`.
3. The nonexistent "real-Postgres harness" is replaced by a concrete one:
   `packages/api/src/testdb.ts` (docker-compose Postgres, `agentos_test`
   schema, `prisma migrate deploy`, truncate-per-test), `.dbtest.ts` suffix +
   `test:db` scripts, with AC-C2/AC-C3/AC-C4/AC-K3/AC-W1/AC-W2 and
   migration/FK verification on the real DB and mocks retained for branch
   coverage. → WI-1 (harness + `migration.dbtest.ts`), WI-2/4/5 test splits.
4. Five-field dialect is enforced by explicit pre-parse token validation
   (exactly 5 whitespace fields, no `@` macros) since cron-parser accepts
   6-field input; tests reject `0 */2 * * * *`, `* * * * * *`, `@daily`.
   → WI-3 `computeNextOccurrence`.
5. Human/agent-less `AT` is rejected at create and merged-view patch (400);
   the due query additionally filters `assigneeType: AGENT` and the tick
   quarantines any unexpectedly-throwing row, so no tight loop is possible.
   → WI-3 `validateSchedule`, WI-4 `schedulerTick`.
6. Malformed-cron quarantine is a conditional `updateMany` on the full
   observed tuple (`id, scheduleKind, status, cron, timezone, runAt`) and the
   failure activity is written only when the claim wins; PATCH-repair-vs-tick
   race test added. → WI-4 step 5 + `scheduler.dbtest.ts`.

**Should-fix — all six adopted:**

1. Adopted — copy field list gains `spendCap`/`spendCapApplicable`, with an
   explicit note that run-level propagation follows today's `enqueueTaskRun`
   (which does not copy them) unchanged. → WI-4 step 2.
2. Adopted — successor lookup requires both chain columns non-null, scopes by
   `projectId`, and a malformed row (chainId without chainIndex) gets an
   activity + followUpTaskId fallback instead of a crash. → WI-2 step 1.
3. Adopted — the route-local P2002→409 catch is dropped; the existing global
   handler (`app.ts:1732-1736`) is relied on and tested. → WI-2, §8-5.
4. Adopted — exact `prisma migrate diff` command with `--shadow-database-url`
   and `--exit-code` spelled out; `.env.example` (which exists) explicitly
   listed in WI-4 with the new variable. → WI-1 verification, WI-4 files.
5. Adopted — `isPublic` matches the exact `POST /hooks/templates/:id` shape
   (regex), not a `/hooks/` prefix; regression test pins `POST /hooks/other`
   → 401. → WI-5.
6. Adopted — template PATCH validates the merged config: non-null secret
   requires non-null in-project repo (400); nulling the secret with repo
   retained stays legal as the kill switch; route 401 kept as
   defense-in-depth only. → WI-5, §8-4.
