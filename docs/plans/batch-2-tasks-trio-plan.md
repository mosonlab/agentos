# PLAN — Batch 2: Tasks automation trio (cron, webhook, chain advance) + dead-model cleanup

Status: draft for review · Author: plan agent · Date: 2026-08-16
Spec: `docs/specs/batch-2-tasks-trio.md` (PR #2, approved). Authority behind it:
`docs/BACKLOG-V2.md` 批次 2, `docs/reference/danny-agentos-video/decisions.md` §5/§10/§12.

Planning only. Five work items in dependency order, one commit each, all on the
feature branch `agentos/cmsv93pyg006dmpj2xeqjspog/run-1` so the batch lands as
one PR with one migration. Every spec requirement (§4.1–§4.4, §5, §6) maps to a
numbered step below; §8 lists what the spec left ambiguous and what this plan
proposes instead of deciding silently.

## 0. Approach summary

- **One migration first** (WI-1): all schema changes ride together
  (decisions §5 — one independent migration per batch). The inbox telemetry
  deletion is in the same commit because dropping `InboxConnectionWindow`
  breaks `packages/inbox/src/index.ts` compilation the moment the Prisma
  client regenerates.
- **Chain advance before cron/webhook** (WI-2): it is pure behavior change on
  the existing schema, and both later features create chains/tasks that flow
  through it; landing it early lets their tests assert end-to-end flow.
- **Cron in two commits** (WI-3 API surface + validation, WI-4 scheduler
  loop): the validation layer is independently testable and reviewable; the
  loop builds on it.
- **Webhook last** (WI-5): needs the WI-1 columns and reuses
  `instantiateTemplate` untouched except for actor attribution.
- **Transactional dedupe pattern**: the scheduler uses the same
  compare-and-set-inside-ReadCommitted-transaction house pattern as
  `applyInboxDecisionTx` (`updateMany` with a predicate; loser sees
  `count === 0`). The CAS anchor is `runAt` itself (spec §4.1 next-fire
  bookkeeping).
- **Rollback lever**: `SCHEDULER_POLL_INTERVAL_MS=0` short-circuits scheduler
  startup in `packages/api/src/index.ts`; `createApp` is untouched by the
  loop, so with the lever pulled the API behaves byte-identically (AC-C6).

Verification commands used throughout: `npm test -w @agentos/api`,
`npm test -w @agentos/db` (if tests exist there), `npm test -w @agentos/inbox`,
`npm run typecheck` per touched package, `npx prisma migrate diff` for AC-D1,
and the manual §8-of-spec walkthrough at the end.

---

## WI-1 — Migration + dead-model cleanup

Covers spec §4.4, §5, and the additive schema needs of §4.1/§4.2.

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

**Interfaces changed**

- Generated Prisma client loses `trigger`, `automation`,
  `inboxConnectionWindow` delegates; gains three `TaskTemplate` fields. No
  TypeScript outside `packages/inbox/src/index.ts` references the dead models
  (verified by grep), so this is the only code delta.

**Tests / verification**

- `npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-migrations ...` empty (AC-D1); `grep -rn "inboxConnectionWindow\|\bTrigger\b\|\bAutomation\b"` over `packages/*/src` clean (AC-D1).
- `npm test -w @agentos/inbox` green (connection/supervisor tests never touched
  the model — AC-D2).
- `npm run typecheck` across all packages (catches any missed client usage).
- No new tests: this item is verified by compilation, grep, and the existing
  suites (spec §6 "Migration/cleanup").

**Commit**: `feat(db): batch 2 migration — drop Trigger/Automation/InboxConnectionWindow, webhook columns on TaskTemplate, schedule poll index`

---

## WI-2 — Chain auto-advance generalized to chainId/chainIndex

Covers spec §4.3 (K1–K9, AC-K1–K4).

**Files**

- `packages/db/src/workflow.ts`
  - New exported routine, e.g.
    `activateChainSuccessor(tx, task, options: { sourceRunId?: string | null; chatId?: string | null }, now): Promise<{ nextTaskId: string | null; gated: boolean }>`:
    1. Successor lookup: if `task.chainId != null`, `findFirst({ where: { chainId, chainIndex: { gt: task.chainIndex } }, orderBy: { chainIndex: "asc" } })`
       (smallest higher index — gap-tolerant, K6); else fall back to
       `followUpTaskId` (A8).
    2. No successor: if the task had a `chainId`, write a
       "chain complete" activity on it (K4); return.
    3. Idempotency guard (K5, K9, AC-K3): if the successor has a run in
       `QUEUED|CLAIMED|PROVISIONING|RUNNING|WAITING_INBOX`, only ensure
       status/activity, never enqueue. The `@@unique([taskId, runNumber])`
       constraint backstops the read-then-write race; callers in a transaction
       surface no violation to API clients (the tx retriable path is the same
       as today's template flow).
    4. Agent successor with repo: ensure `status: TODO` (resets a rejected
       `REVIEW`/`DOING` leftover), `enqueueTaskRun`, activity
       "predecessor completed; step queued".
    5. Human / no-agent / no-repo successor: when `sourceRunId` is present
       **and** the successor is a template gate task, keep today's
       REVIEW + `gateQuestion` card; otherwise leave `TODO` with an activity
       entry and no Inbox message (A9 — operator-PATCH advance has no
       run/session for a card).
  - `advanceTemplateTask`: replace its successor selection
    (`task.followUpTask`) with `activateChainSuccessor`; the gating of the
    *current* task (approvalGate → REVIEW + card) stays as is. Behavior for
    template chains must be unchanged (AC-K2: existing template tests green).
  - `applyInboxDecisionTx` approve branch (lines ~234–237): replace the
    `followUpTaskId`-only block with `activateChainSuccessor` (passing
    `sourceRunId: question.session.run.id`). Reject branch unchanged (K8).
- `packages/api/src/app.ts`
  - `POST /runner/runs/:runId/complete` (~line 1627): today only
    `run.task?.templateId` advances. Add the non-template chain branch: on
    success, if the task has a `chainId` and `approvalGate === false`, set it
    `DONE` and call `activateChainSuccessor` inside the same transaction (K1)
    instead of parking in `REVIEW`. Non-chain non-template tasks and gated
    non-template chain tasks keep today's `REVIEW` parking (see §8-1).
  - `PATCH /tasks/:taskId` (~line 970): when the patch transitions status to
    `DONE` and the task has a `chainId` or `followUpTaskId`, wrap
    update + advance in one `db.$transaction` and call
    `activateChainSuccessor` (no `sourceRunId`) — trigger 3 (K3). The
    template+gate 409 guard at line 974 stays untouched (AC-K4). Tasks with
    neither chain nor follow-up take exactly today's code path (K7).
  - `taskInput` (~line 179): add optional `chainId` (string cuid-ish, reuse
    `id` schema? — no: `chainId` is a `randomUUID()` for template chains, so
    plain `z.string().trim().min(1).max(100)`) and `chainIndex`
    (`z.number().int().min(0)`), with a `superRefine` requiring both-or-neither
    (A10). `taskPatch` explicitly does **not** gain them.
  - `POST /projects/:projectId/tasks`: catch Prisma `P2002` on
    `[chainId, chainIndex]` and return 409 (same pattern as the inbox routes at
    lines 1116/1137). Note: the spec says "the existing 409", but task create
    has no P2002 mapping today — this catch is a required consequential edit.

**Interfaces changed**

- `@agentos/db` exports `activateChainSuccessor`; `advanceTemplateTask`
  signature unchanged. API: `taskInput` accepts `chainId`/`chainIndex`;
  `PATCH /tasks/:id` → DONE now has side effects on successors.

**Tests** (K-rows, colocated)

- `packages/api/src/workflow.test.ts` (extend, mock-Tx style like the existing
  file): K1 run-success advance for non-template chain; K2 gate approve via
  chain lookup (agent + human successor variants); K4 last-step no-op +
  chain-complete activity; K5/K9 idempotency (successor already has an active
  run; double advance); K6 index gap; K8 reject unchanged.
- `packages/api/src/app.test.ts` (extend): K3 operator PATCH → DONE queues
  successor run; K7 no-chain PATCH behaves as today; AC-K4 template-gate PATCH
  still 409; create with `chainId`+`chainIndex` collision → 409; create with
  only one of the pair → 400.
- Regression: existing `templates.test.ts`, `workflow.test.ts` stay green
  (AC-K2).

**Commit**: `feat(workflow): chain auto-advance on run success, gate approval, and operator PATCH`

---

## WI-3 — Schedule fields on the task API + cron validation

Covers spec §4.1 rows C1, C5, C8, C9-at-create and the input extensions of §3.5.

**Files**

- `packages/api/package.json`: add dependency `cron-parser` (MIT, maintained,
  IANA-timezone aware `CronExpressionParser.parse(expr, { tz })`; 5-field
  standard dialect — matches the spec's dialect requirement).
- New `packages/api/src/scheduler.ts` (shared by WI-4), first slice:
  - `computeNextOccurrence(cron: string, timezone: string | null, after: Date): Date`
    — pure; throws on unparsable expression; `timezone ?? server local` (A5).
  - `validateSchedule(fields)` helper used by both create and patch: CRON
    requires parsable `cron` (C5), AT requires `runAt` (C8); returns the
    normalized `{ scheduleKind, runAt, cron, timezone }` where for CRON,
    `runAt` is always recomputed from the expression (caller-supplied `runAt`
    ignored — see §8-2).
- `packages/api/src/app.ts`
  - `taskFields`/`taskInput`: add `scheduleKind` (`z.nativeEnum(ScheduleKind)`,
    default `NOW`), `runAt` (`z.coerce.date().nullable()`), `cron`
    (`z.string().trim().min(9).max(100).nullable()`), `timezone`
    (`z.string().trim().min(1).max(64).nullable()` — validity check =
    cron-parser accepts it / `Intl` lookup). Cross-field checks run in the
    route handler via `validateSchedule` so patches can merge with the
    stored row: `PATCH` on any schedule field re-validates the merged view
    and recomputes `runAt` for CRON (spec: "set on create/patch").
  - `POST /projects/:projectId/tasks`: enqueue run 1 at creation **only when
    `scheduleKind === NOW`** (today's block at lines 939–958 gets the guard);
    AT/CRON tasks are created with no run (C1, C9 waits for the loop). 400 on
    validation failure (C5/C8, AC-C5).
  - `taskPatch`: accepts the same four fields; pausing/retuning stays
    "patch `cron`/`runAt`/`scheduleKind`" per spec non-goals.

**Interfaces changed**

- `taskInput`/`taskPatch` shape; task creation semantics for AT/CRON (no
  immediate run). Defaults preserve today's behavior — `scheduleKind` omitted
  ⇒ `NOW` ⇒ byte-identical create path.

**Tests**

- `packages/api/src/scheduler.test.ts` (new): `computeNextOccurrence` — basic
  next-minute math, `Asia/Shanghai` timezone case, DST boundary
  (e.g. `America/New_York` spring-forward), invalid expression throws.
- `packages/api/src/app.test.ts` (extend): C1 CRON create → 201, zero runs,
  `runAt` = correct next occurrence; C5 invalid cron → 400; C8 CRON without
  cron / AT without runAt → 400; C9 AT with past `runAt` → 201 + no run yet;
  NOW default → run created exactly as before (regression).

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
       maxDurationMin/stallTimeoutMin/maxSessionsPerTask`; `scheduleKind: NOW`;
       `cron/timezone/runAt/chainId/chainIndex/followUpTaskId/templateId` null;
       name = `` `${task.name} — ${fireTime formatted in task tz}` `` (spec
       naming rule; clamp to the 200-char column limit).
    3. If the copy is agent-assigned with a repo: `enqueueTaskRun(tx, copy.id)`
       (C2). Human-assigned: leave `TODO`, no run (C10).
    4. Activity on both tasks with
       `metadata: { recurringTaskId, firedAt }` (spec bookkeeping).
    5. On `computeNextOccurrence` throw (malformed stored cron, C6): separate
       transaction — clear `runAt`, write one parse-failure activity; the task
       leaves the due set until re-patched (no tight loop, AC-C5).
  - `fireAtTask(db, task, now)` — enqueue run 1 for the task itself inside a
    transaction; no copy, `runAt` untouched (A4). Dedupe: the due query
    requires `runs: { none: {} }`, and the `@@unique([taskId, runNumber])` +
    `dedupeKey` constraint makes the concurrent-tick loser fail its insert;
    catch P2002 and treat as already-fired (AC-C4 exactly once).
  - `schedulerTick(db, now = new Date())` — the poll body, exported for tests:
    query due CRON (`scheduleKind: CRON, status: TODO, runAt: { lte: now }` —
    rides the WI-1 index) and due AT (`scheduleKind: AT, status: TODO,
    runAt: { lte: now }, runs: { none: {} }`); fire each; per-task try/catch so
    one bad row never wedges the loop; returns counts for logging.
  - `startScheduler(db)` — reads `SCHEDULER_POLL_INTERVAL_MS`
    (default 30 000); **`0` ⇒ return null, no interval ever created**
    (rollback lever, AC-C6); otherwise `setInterval` with the same busy-flag
    reentrancy guard as the inbox delivery poll
    (`packages/inbox/src/index.ts:73–79`); returns the timer for shutdown.
- `packages/api/src/index.ts`: after `serve(...)`, call
  `startScheduler(prisma)`; `clearInterval` in `shutdown`. `createApp` is
  untouched, so app-level tests never see the loop.

**Interfaces changed**

- New env var `SCHEDULER_POLL_INTERVAL_MS` (API process; document in the root
  `.env.example` if one exists — check at implementation time).
- `Task.runAt` semantics for CRON: "next fire at", server-maintained.

**Tests** (`packages/api/src/scheduler.test.ts`, against the real-Postgres
harness used by `app.test.ts`; drive `schedulerTick(db, fakeNow)` directly —
no timers in tests)

- C2: due CRON task → exactly one copy (`scheduleKind=NOW`, cleared schedule
  fields, suffixed name) + one QUEUED run; definition `runAt` advanced;
  activity on both sides.
- AC-C2 race: run two `fireCronTask` bodies concurrently
  (`Promise.all`) over the same due row → exactly one copy.
- C3: two due occurrences in the past → single tick fires once, `runAt`
  strictly future.
- C4/AC-C4: due AT task → run 1 queued once; second tick is a no-op.
- C6: stored garbage cron → no fire, `runAt` cleared, one activity, tick
  returns normally.
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
    null template, `webhookSecretId` null, `disabledAt` set, decrypt failure,
    or mismatch all collapse to the same null (W2/W3/W6, AC-W4). Comparison:
    `timingSafeEqual(sha256(supplied), sha256(decrypted))` — hashing first
    gives constant time regardless of length (same trick as
    `auth.ts` `tokenEquals` but length-safe; AC-W3). Decrypt via the existing
    `decryptSecret` (`packages/api/src/secrets.ts`).
- `packages/api/src/app.ts`
  - `isPublic` (~line 310): add
    `|| (path.startsWith("/hooks/") && method === "POST")` — the existing
    middleware then sets `principal: public` and skips bearer auth (AC-W3).
  - Route `POST /hooks/templates/:templateId`:
    1. `bodyLimit` (hono built-in middleware) at 1 MB → 413; JSON parse +
       "must be an object" check → 400 (W7).
    2. `authenticateWebhook` with header `X-AgentOS-Webhook-Secret` → on null,
       401 `{ error: "Unauthorized" }` — identical body/status for every
       failure flavor (W2/W3/W6, AC-W4). Add the header to the CORS
       `allowHeaders` list.
    3. `resolvePayloadVariables` → 400 listing unresolved names (W4/W5).
    4. `instantiateTemplate(db, template.projectId, template.id, { repoId: template.webhookRepoId, variables })`
       — reject with 401→? No: a webhook-enabled template with
       `webhookRepoId` null is a config error; treat as 401-equivalent
       (not-enabled) to preserve indistinguishability. Response 201
       `{ chainId, taskIds }` (W1). All-or-nothing: `instantiateTemplate` is
       already one Serializable transaction, and every failure path above runs
       before it (AC-W2).
  - `PATCH /task-templates/:templateId` (new — no template PATCH exists):
    zod `webhookConfigPatch` accepting the three nullable fields; validation:
    secret exists with `purpose === WEBHOOK` (else 400), repo belongs to the
    template's project (else 400) (W9), mapping shape
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

- New public route `POST /hooks/templates/:templateId`; new
  `PATCH /task-templates/:templateId`; `instantiateTemplate` optional options
  param; CORS allow-header addition.

**Tests**

- `packages/api/src/hooks.test.ts` (new, real-Postgres app-level like
  `app.test.ts`): W1 happy path — 201, chain + first run + activities equal
  the operator instantiate shape (AC-W1); W2/W3 wrong secret vs unknown
  template vs non-enabled template → byte-identical 401s (AC-W4); W4 missing
  mapped field → 400 with names, zero `Task`/`Run`/`TaskActivity` rows
  (AC-W2, assert counts); W5 object-valued path → same; W6 disabled secret →
  401; W7 non-JSON → 400 and >1 MB → 413; W8 double fire → two chains;
  W9 PATCH with non-WEBHOOK secret / foreign repo → 400.
- Unit tests for `resolvePayloadVariables` (dot paths, defaults precedence,
  scalar stringification) in the same file.
- Auth regression (AC-W3): `/hooks/templates/x` reachable with no
  Authorization header; a sibling route (e.g. `/tasks`) still 401 without a
  token — extend the existing auth cases in `app.test.ts`.

**Commit**: `feat(api): webhook fire route on task templates with shared-secret auth and payload mapping`

---

## 6. Requirement → step traceability

| Spec item | Covered by |
|---|---|
| §4.1 C1/C5/C8/C9-create, input extensions | WI-3 |
| §4.1 C2–C4, C6, C7, C9-fire, C10, poll env, AC-C1–C6 | WI-4 (index from WI-1) |
| §4.2 W1–W9, AC-W1–W4, template PATCH/read-back | WI-5 (columns from WI-1) |
| §4.3 K1–K9, AC-K1–K4, chain fields on create | WI-2 |
| §4.4 + §5 migration, AC-D1–D3 | WI-1 |
| §6 test expectations | per-WI test lists above |
| §7 rollback levers | WI-4 (`=0` lever), WI-5 (null secret ⇒ 401), WI-2 revert-only (no flag, per spec) |

## 7. Sequencing & PR mechanics

Commits 1→5 in the order above on `agentos/cmsv93pyg006dmpj2xeqjspog/run-1`
(PR #2 accumulates spec + plan + implementation). Between WI-3 and WI-4 an
AT/CRON task can be created but never fires — acceptable inside one PR, flagged
so the implementer doesn't "fix" it by re-adding create-time enqueue. Full
suite + typecheck after every commit; the spec §8 manual walkthrough after
WI-5 on a dev instance with a runner attached.

## 8. Ambiguities flagged for the reviewer (not silently decided)

1. **Gated non-template chain task on run success.** Spec trigger 1 is
   "succeeded, *non-gated* chain task"; it never says what run-success does to
   a non-template chain task with `approvalGate=true`. Plan reading: it parks
   in `REVIEW` exactly as today (no gate card — those are template-only), and
   the operator releases it via PATCH → trigger 3. If Leo instead wants gate
   cards for non-template chains, that's new Inbox surface — say so in review.
2. **Caller-supplied `runAt` on a CRON task.** Spec says `runAt` "doubles as
   next fire, set on create/patch from the cron expression". Plan: for CRON
   the server always recomputes and silently ignores a supplied `runAt`
   (rather than 400). Cheap to flip to a 400 if preferred.
3. **Does the cron copy inherit `approvalGate`?** Spec lists the copy as "a
   copy of the recurring task" without enumerating fields. Plan: copy it (a
   gated recurring task's fires each park in `REVIEW` for sign-off), since
   dropping it silently weakens an operator-chosen guard.
4. **Webhook-enabled template with `webhookRepoId = null`.** Spec requires
   both for a fire but doesn't give the failure mode when only the secret is
   set. Plan: treat as not-webhook-enabled → 401 (keeps W2/W3
   indistinguishability). The PATCH endpoint could alternatively force
   both-or-neither; not imposed since the spec made them independently
   nullable.
5. **`chainId` collision status code.** Spec §4.3 says collisions "surface as
   the existing 409", but `POST /projects/:id/tasks` has no P2002→409 mapping
   today (only the inbox routes do). WI-2 adds the catch; noting it because it
   is technically a new mapping, not an existing one.
6. **Timezone validation source.** Spec validates `cron` but is silent on
   rejecting an unknown IANA `timezone` at write time. Plan: validate it in
   `validateSchedule` (cron-parser throws on bad tz) so C6-style skips can't
   be caused by a typo'd timezone.

## 9. Revision-loop note

A review step follows this plan. Must-fix findings will be addressed by
editing this file in place on the same branch; each should-fix will be adopted
or declined with one line of reasoning in the revision commit message and the
task activity log, per the chain contract.
