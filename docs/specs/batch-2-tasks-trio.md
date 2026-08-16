# SPEC — Batch 2: Tasks automation trio (cron, webhook, chain advance) + dead-model cleanup

Status: draft for review · Author: spec agent · Date: 2026-08-15
Sources of authority: `docs/BACKLOG-V2.md` (批次 2) and `docs/reference/danny-agentos-video/decisions.md` (§5, §10, §12).

This is a requirements spec. It contains no implementation plan; a plan agent
should be able to work from it without further questions. Where the request was
ambiguous the simplest reading was chosen and is marked **[Assumption An]**;
all assumptions are consolidated in §9.

---

## 1. Problem and audience

AgentOS Tasks currently automate a single shot: a task is created, one run is
enqueued, an agent executes it. The three automation mechanisms visible in the
reference product (Danny Postma's AgentOS video, item 2 of the comparison) are
modeled in our schema but not wired:

1. **Cron**: `Task.scheduleKind = CRON` with `cron`/`timezone` fields exists,
   but nothing ever fires. The API does not even accept these fields on create
   (`taskInput` omits them), so every task behaves as `NOW`.
2. **Webhook**: no inbound webhook route exists at all. The only trace is the
   dead `Trigger` model (never referenced by any route or service) and the
   `SecretPurpose.WEBHOOK` enum value.
3. **Chain advance**: works only for template-instantiated chains, via
   `followUpTaskId` inside `advanceTemplateTask` (`packages/db/src/workflow.ts`)
   and the gate-approval branch of `applyInboxDecisionTx`. Non-template chain
   tasks and operator-driven completion (`PATCH /tasks/:id` → `DONE`) never
   activate a successor — today Leo releases each step by hand
   (decisions §12: "批次 2 前链式推进手动放行").

The audience is the single operator (Leo) running a self-hosted instance. The
outcome of this batch: the automation loop closes — scheduled work fires
itself, external systems can start chains, and chains flow without manual
release — using only backend changes (a parallel task is migrating the
frontend base; no frontend work here).

### Corrections to the task brief (verified in code)

- The brief says the webhook route "gains" secret validation. **No inbound
  webhook route exists**; this spec defines it from scratch.
- The brief says `InboxConnectionWindow` has "verified zero references". It is
  actively written by `packages/inbox/src/index.ts` (connection-window
  telemetry: create on boot, update on ready/reconnect/close). Dropping the
  model requires deleting those writes. See §5 and **[Assumption A1]**.
- `Trigger` and `Automation` are confirmed dead: their only references are the
  Prisma schema relations themselves (`Project.triggers`, `Agent.triggers`,
  `Secret.webhookTriggers`, `Project.automations`, `Agent.automations`,
  `TaskTemplate.automations`).

---

## 2. Current state (verified)

- `Task` already carries `scheduleKind (NOW|AT|CRON)`, `runAt`, `cron`,
  `timezone`, `chainId`, `chainIndex` (with `@@unique([chainId, chainIndex])`),
  `followUpTaskId`.
- `POST /projects/:projectId/tasks` always enqueues run 1 immediately when the
  task is agent-assigned; `taskInput`/`taskPatch` do not accept scheduling or
  chain fields.
- Run claiming (`POST /runner/tasks/claim`) picks `QUEUED` runs with
  `readyAt <= now` whose task status is `TODO|DOING`; claiming sets the task to
  `DOING`.
- Run completion (`POST /runner/runs/:runId/complete`): template tasks go
  through `advanceTemplateTask` (persist output → `DONE` or gate → enqueue
  successor run); non-template tasks go to `REVIEW` and stop.
- Gate approval (`applyInboxDecisionTx`) sets the gate task `DONE` and enqueues
  the `followUpTaskId` successor if agent-assigned; rejection re-queues the
  producing step.
- The API process (`packages/api/src/index.ts`) has no background loops; the
  inbox process (`packages/inbox/src/index.ts`) demonstrates the house pattern
  (a `setInterval` outbox poll).
- No cron-parsing dependency exists anywhere in the workspace.
- Tests: `node --import tsx --test src/*.test.ts` per package; API tests run
  against a real Postgres via Prisma.

---

## 3. Scope and non-goals

### In scope (backend only)

1. **Cron execution** — a scheduler inside the API process polls for due
   `CRON` (and `AT`, see §4.1) tasks and enqueues work.
2. **Webhook trigger** — a new public inbound route with shared-secret
   validation and payload→template-variable mapping that instantiates a task
   template per fire.
3. **Chain auto-advance** — one generalized advance routine keyed on
   `chainId`/`chainIndex`, triggered by run success, gate approval, and
   operator `PATCH` to `DONE`.
4. **Cleanup migration** — drop `Trigger`, `Automation`,
   `InboxConnectionWindow` models plus their schema relations and the
   inbox telemetry writes.
5. API input extensions required to reach the features: `taskInput`/`taskPatch`
   accept `scheduleKind`, `runAt`, `cron`, `timezone`, and optional `chainId`/
   `chainIndex`; task-template endpoints accept webhook configuration.

### Non-goals (explicitly out)

- Any frontend change (parallel task owns the frontend base migration).
  The API additions are backward-compatible so the existing UI keeps working.
- Danny-style trigger niceties: fire history list ("Recent fires"), replay
  window, "show on task board" flag, first-task auto-start toggle. The webhook
  fires unconditionally; history is observable through created tasks/activity.
- Webhook signature schemes (HMAC of body, timestamp tolerance). V1 is a
  static shared secret in a header. **[Assumption A6]**
- Outbound webhooks of any kind.
- A distributed or multi-process scheduler; single API process is assumed
  (single-user self-hosted, decisions §1).
- Editing or pausing recurring tasks beyond what `PATCH /tasks/:id` already
  allows (patching `cron`/`runAt`/`scheduleKind` is enough to pause/retune).
- Goals/orchestrator interactions (batch 5).

---

## 4. Feature requirements

### 4.1 Cron execution

**Requirement.** A scheduler loop in the API process wakes on a fixed
interval, finds schedule-due tasks, and enqueues work for them, so that a task
created with `scheduleKind = CRON` runs repeatedly without operator action.

**Design decisions.**

- **Recurrence model — fire = materialized copy.** On each cron fire the
  scheduler creates a fresh one-shot task (a copy of the recurring task with
  `scheduleKind = NOW`, `cron`/`timezone` cleared, no `chainId`) and enqueues
  its run 1 via the existing `enqueueTaskRun`. The recurring task itself is
  never claimed or executed; it acts as the definition. **[Assumption A2]**
  Rationale: running the same task repeatedly breaks existing invariants —
  `@@unique([taskId, runNumber])` plus the `runNumber >= maxRunsPerTask`
  budget check would exhaust after N fires, and completion parks the task in
  `REVIEW` where the claim query (`status IN (TODO, DOING)`) can never pick it
  up again. Copies give each fire its own lifecycle, review state, and retry
  budget, and match the reference product (each webhook/cron fire appears as
  its own task, e.g. "Triage cnv_…").
  - The copy's name is suffixed with the fire time (e.g.
    `Nightly digest — 2026-08-16 02:00 +08:00`) so the Tasks list stays
    legible.
  - The copy records `metadata: { recurringTaskId, firedAt }` in its creation
    activity entry; the recurring task gets a mirror activity entry per fire.
- **Next-fire bookkeeping.** `Task.runAt` doubles as "next fire at" for `CRON`
  tasks: set on create/patch from the cron expression, and advanced to the
  next future occurrence after every fire. The scheduler's poll is then a
  simple indexed query (`scheduleKind = CRON AND status = TODO AND runAt <=
  now`). **[Assumption A3]**
- **`AT` tasks ride along.** The same poll handles `scheduleKind = AT`
  (`runAt <= now`, no run yet): enqueue run 1 for the task itself (no copy —
  it is one-shot by definition) and leave `runAt` untouched. Task creation
  stops enqueueing immediately for `AT`/`CRON`; only `NOW` keeps the current
  create-time enqueue. **[Assumption A4]**
- **Timezone.** `Task.timezone` (IANA name) governs cron evaluation; when
  null, the server's local timezone applies. **[Assumption A5]**
- **Cron dialect.** Standard 5-field cron (minute granularity). A maintained
  MIT-licensed parser dependency is expected (e.g. `cron-parser`); the exact
  package is the plan agent's choice. No `@reboot`/seconds extensions.
- **Poll interval.** Env-configurable, `SCHEDULER_POLL_INTERVAL_MS`, default
  30 000. `SCHEDULER_POLL_INTERVAL_MS=0` disables the loop (rollback lever).

**Behavior in concrete scenarios.**

| # | Scenario | Expected behavior |
|---|---|---|
| C1 | Task created with `scheduleKind=CRON`, `cron="0 2 * * *"`, `timezone="Asia/Shanghai"`, agent+repo assigned | 201; no run created at creation; `runAt` set to the next 02:00 Shanghai time; task stays `TODO`. |
| C2 | Scheduler tick at/after `runAt` | Copy task created (`scheduleKind=NOW`) with run 1 `QUEUED`; recurring task's `runAt` advanced to the following occurrence; activity entries written on both tasks. |
| C3 | Previous fire's copy still running when the next fire is due | Fire anyway — copies are independent. Overlap control is out of scope; the operator spaces the cron accordingly. **[Assumption A7]** |
| C4 | API process down across one or more scheduled times | On the first tick after restart exactly one fire happens (missed occurrences coalesce), then `runAt` advances to the next *future* occurrence. |
| C5 | `cron` invalid at create/patch time | 400 with a validation message; the write is rejected. |
| C6 | Stored task whose `cron` can no longer be parsed (e.g. hand-edited DB) | Scheduler skips it, writes one activity entry noting the parse failure, and does not tight-loop on it (e.g. clears `runAt` so it leaves the due set until re-patched). |
| C7 | Recurring task patched to `status=DONE` (or any non-`TODO` status) | No further fires (poll filters `status=TODO`). Patching back to `TODO` resumes. |
| C8 | `scheduleKind=CRON` without `cron`, or `AT` without `runAt` | 400 at create/patch. |
| C9 | `AT` task with past `runAt` created | 201; first scheduler tick enqueues it (equivalent to slightly-late `NOW`). |
| C10 | Human-assigned (`assigneeType=HUMAN`) `CRON` task | Copy is created `TODO` without a run (there is no agent to run it); appears on the board for the human. |

**Data/interface changes.**

- `taskInput`/`taskPatch` gain `scheduleKind`, `runAt`, `cron`, `timezone`
  with cross-field validation (C5, C8). Defaults preserve today's behavior
  (`scheduleKind=NOW`).
- New composite index to keep the poll cheap:
  `@@index([scheduleKind, status, runAt])` on `Task`.
- New env var `SCHEDULER_POLL_INTERVAL_MS` (API process).

**Acceptance criteria.**

- AC-C1: Creating a `CRON` task does not create a run; `runAt` is populated
  with the correct next occurrence in the task's timezone.
- AC-C2: A due `CRON` task produces exactly one copy task + queued run per
  occurrence, under repeated/concurrent scheduler ticks (idempotent per
  occurrence — a tick that races another must not double-fire; uniqueness
  must be enforceable transactionally).
- AC-C3: After downtime spanning k≥1 occurrences, exactly one catch-up fire
  happens and `runAt` lands strictly in the future.
- AC-C4: `AT` tasks enqueue exactly once, at/after `runAt`.
- AC-C5: Invalid `cron`/missing `runAt` combinations are rejected with 400 at
  the API boundary; a malformed stored expression cannot wedge the loop (C6).
- AC-C6: With `SCHEDULER_POLL_INTERVAL_MS=0` the loop never starts and
  existing behavior is byte-identical to today.

### 4.2 Webhook trigger

**Requirement.** An external system can start a template chain by POSTing
JSON to a stable URL guarded by a shared secret, with payload fields mapped
into the template's `{{variables}}`.

**Design decisions.**

- **Webhooks attach to TaskTemplates**, not to individual tasks and not via a
  resurrected `Trigger` model. Template variables are the only variable
  concept in the system, and `instantiateTemplate` already produces a chain
  with the first step queued — the webhook is a thin authenticated adapter in
  front of it. **[Assumption A6]**
- **Configuration** lives on `TaskTemplate` as three nullable columns:
  - `webhookSecretId` — FK to `Secret` (purpose `WEBHOOK`); the relation name
    `WebhookCredential` migrates from the dropped `Trigger` model.
  - `webhookRepoId` — FK to `Repo`; `instantiateTemplate` requires a repo and
    an unauthenticated caller must not choose one.
  - `webhookPayloadMapping` — JSON of shape
    `{ "map": { "<variable>": "<dot.path.into.payload>" }, "defaults": { "<variable>": "<literal>" } }`.
    Resolution order per template variable: mapped path if it resolves to a
    scalar → default literal → otherwise the fire is rejected (W4).
  A template with `webhookSecretId = null` is not webhook-enabled.
- **Route.** `POST /hooks/templates/:templateId` — added to the auth
  middleware's public list (no bearer token); the shared secret is the sole
  authentication. Secret presented in header `X-AgentOS-Webhook-Secret`,
  compared in constant time against the decrypted stored secret.
- **Fire = `instantiateTemplate`** with the resolved variables; response 201
  `{ chainId, taskIds }`. Concurrent/duplicate fires each create their own
  chain (no dedupe/replay window — non-goal).
- Request body must be a JSON object, capped at 1 MB. Non-JSON → 400.

**Behavior in concrete scenarios.**

| # | Scenario | Expected behavior |
|---|---|---|
| W1 | POST with correct secret, payload satisfying all template variables | 201; chain instantiated; first step's run queued; activity notes `webhook` as the creating actor. |
| W2 | Missing or wrong secret header | 401 `{error}`; no side effects. Response must not reveal whether the template exists or is webhook-enabled. |
| W3 | Unknown `templateId`, or template with `webhookSecretId=null` | 401 (indistinguishable from W2). **[Assumption A6]** |
| W4 | Payload missing a mapped field with no default | 400 listing the unresolved variable names; nothing created. |
| W5 | Mapped path resolves to an object/array | Treated as unresolved (W4); only scalars (string/number/boolean, stringified) are legal variable values. |
| W6 | Secret disabled (`Secret.disabledAt` set) | 401; no side effects. |
| W7 | Body > 1 MB or not a JSON object | 400/413; no side effects. |
| W8 | Two identical fires in quick succession | Two independent chains (documented behavior; dedupe is the caller's job). |
| W9 | Template config: operator PATCHes template with a secret whose purpose ≠ `WEBHOOK`, or a repo outside the project | 400. |

**Data/interface changes.**

- Migration adds `webhookSecretId`, `webhookRepoId`, `webhookPayloadMapping`
  to `TaskTemplate` (all nullable; FKs `onDelete: SetNull` for the secret,
  `Restrict` for the repo).
- New public route `POST /hooks/templates/:templateId`.
- Template management API (`GET /projects/:id/task-templates`,
  `GET /task-templates/:id`) exposes the new fields, and a `PATCH
  /task-templates/:templateId` accepting the three webhook fields is added if
  no template PATCH exists yet (currently templates are seed/DB-managed;
  read-back must include the config either way). Webhook config responses
  never include the secret value — only `webhookSecretId`.

**Acceptance criteria.**

- AC-W1: A correctly-authenticated fire creates the same DB state as an
  operator calling `POST /projects/:id/task-templates/:id/instantiate` with
  the same variables (chain, tasks, first run, activity), plus fire metadata.
- AC-W2: All failure paths (W2–W7) produce zero rows in `Task`, `Run`,
  `TaskActivity`.
- AC-W3: Secret comparison is constant-time and the route is reachable
  without a bearer token, while every other route still requires one
  (regression check on the auth middleware's public list).
- AC-W4: Wrong-secret and unknown-template responses are identical in status
  and body shape.

### 4.3 Chain auto-advance

**Requirement.** When a chain task finishes — run success (non-gated), gate
approval, or operator marking it `DONE` — the successor at
`chainIndex + 1` in the same `chainId` is activated automatically: set
runnable and, when agent-assigned, its run enqueued. Manual per-step release
disappears.

**Design decisions.**

- **One advance routine, keyed on the chain.** The successor is the task with
  the same `chainId` and the smallest `chainIndex` greater than the current
  task's (defensive against gaps), falling back to `followUpTaskId` when
  `chainId` is null. `advanceTemplateTask` and the gate-approval branch of
  `applyInboxDecisionTx` converge on this routine so template and
  non-template chains behave identically. **[Assumption A8]**
- **"Set to TODO" semantics.** Successor tasks already sit at `TODO` from
  creation; activation means: ensure status `TODO` (resetting a rejected
  `REVIEW`/`DOING` leftover), then `enqueueTaskRun` when the successor is
  agent-assigned with a repo. The claim loop does the rest.
- **Triggers of advance:**
  1. Run completion of a succeeded, non-gated chain task (existing template
     path, now generalized).
  2. Gate approval via Inbox (existing path, now generalized).
  3. `PATCH /tasks/:taskId` transitioning `status` to `DONE` on a task with a
     `chainId` (or `followUpTaskId`) — this is the new "manual release
     replaced" path. The existing guard stays: template+gate tasks still
     cannot be PATCHed to `DONE` directly (409, gate must decide).
- **Human successors:** when the successor is `assigneeType=HUMAN` (or has no
  agent/repo), it is left `TODO` for the operator with an activity entry; the
  template-gate flow (REVIEW + gate card) continues to apply only where it
  does today (template chains with a run context). Operator-PATCH advance has
  no run/session to hang a gate card on, so no Inbox message is sent there.
  **[Assumption A9]**

  **Amendment (superseded by approved plan §8-1):** with a successful source
  run, template and non-template human successors now behave alike: the
  successor moves to `REVIEW` and receives an Inbox gate card. Rejecting that
  card re-queues the nearest executable predecessor in the same chain.
  Operator-PATCH advance still has no source run/session, so that path leaves
  a human successor `TODO` with activity and sends no card.
- **Idempotency:** advancing must not enqueue a second run if the successor
  already has an active or queued run (re-entrant PATCHes, gate decision
  races). The existing `applyInboxDecisionTx` OPEN compare-and-set already
  serializes gate decisions; the routine adds an active-run existence check.

**Behavior in concrete scenarios.**

| # | Scenario | Expected behavior |
|---|---|---|
| K1 | Non-template chain: task at `chainIndex=0` completes its run successfully (no gate) | Task 0 → `DONE`; task at index 1 gets run 1 `QUEUED`; activity on both. |
| K2 | Gated chain task's gate approved | Gate task → `DONE`; successor by `chainId`/`chainIndex` enqueued (agent) or left `TODO` (human). Unchanged for template chains. |
| K3 | Operator PATCHes a `REVIEW` chain task to `DONE` | Same successor activation as K1. |
| K4 | Last task in the chain finishes | Chain complete; no error, no enqueue; activity notes chain completion. |
| K5 | Successor already has a queued/active run | No new run; advance is a no-op beyond status/activity (idempotent). |
| K6 | Successor missing (gap: index 2 exists, 1 deleted) | The smallest higher index (2) is activated; a gap does not stall the chain. |
| K7 | Task without `chainId` and without `followUpTaskId` PATCHed to `DONE` | Exactly today's behavior; no advance logic runs. |
| K8 | Gate rejected | Unchanged from today: producing step re-queued, no successor activation. |
| K9 | PATCH sets a chain task to `DONE` twice (retry/double-submit) | Second call is a no-op for the chain (K5 idempotency). |

**Data/interface changes.**

- `taskInput` (create) optionally accepts `chainId` + `chainIndex` (both or
  neither) so non-template chains can be assembled via API; collisions with
  `@@unique([chainId, chainIndex])` surface as the existing 409. `taskPatch`
  does not accept chain fields (re-chaining live tasks is out of scope).
  **[Assumption A10]**
- No schema change; behavior change concentrated in
  `packages/db/src/workflow.ts` and the two call sites plus `PATCH /tasks`.

**Acceptance criteria.**

- AC-K1: For a two-step non-template chain, completing step 1's run leaves
  step 1 `DONE` and step 2 with a `QUEUED` run — no operator involvement.
- AC-K2: All three trigger paths (run success, gate approve, operator PATCH)
  activate the successor; all existing template-chain tests stay green.
- AC-K3: Advance is idempotent under concurrent triggers (no duplicate runs;
  no `[taskId, runNumber]` unique violations surfaced to callers).
- AC-K4: The template+gate PATCH guard (409) still holds.

### 4.4 Cleanup migration (dead models)

**Requirement.** Remove `Trigger`, `Automation`, and `InboxConnectionWindow`
from the Prisma schema, their relation fields on `Project`, `Agent`, `Secret`
(`webhookTriggers`), and `TaskTemplate` (`automations`), and drop the tables.

- `Trigger` and `Automation` have zero code references (verified: only schema
  relations). Their conceptual payloads are superseded by this spec: webhook
  config moves to `TaskTemplate` (§4.2); cron config already lives on `Task`.
- `InboxConnectionWindow` **is referenced**: `packages/inbox/src/index.ts`
  creates a row per process boot and updates it on ready/reconnect/shutdown.
  This is write-only telemetry — nothing reads it. Scope includes deleting
  those writes along with the model. **[Assumption A1]**
- `SecretPurpose.WEBHOOK` stays (used by §4.2).

**Acceptance criteria.**

- AC-D1: `npx prisma migrate diff` between schema and migrated DB is empty;
  no generated-client references to the three models remain anywhere in the
  workspace (grep clean).
- AC-D2: The inbox process boots, connects, reconnects, and shuts down
  cleanly with the telemetry writes removed (its tests stay green).
- AC-D3: The migration is a plain `DROP TABLE` ×3 + column/relation cleanup;
  it must not touch any other table's data.

---

## 5. DB migration notes

One migration for the whole batch (decisions §5: schema changes ride their
batch, one independent migration per batch), e.g.
`20260816000000_batch2_tasks_automation`:

1. `ALTER TABLE "TaskTemplate" ADD COLUMN "webhookSecretId" …, "webhookRepoId" …, "webhookPayloadMapping" JSONB` + FKs (secret: `ON DELETE SET NULL`; repo: `ON DELETE RESTRICT`).
2. `CREATE INDEX` on `Task (scheduleKind, status, runAt)`.
3. `DROP TABLE "Trigger", "Automation", "InboxConnectionWindow"` (order: FK-safe; all three have no inbound FKs).
4. No data backfill: `Trigger`/`Automation` are empty in practice (dead since
   creation); `InboxConnectionWindow` rows are disposable telemetry. If
   non-empty, they are dropped with the tables — accepted loss, note it in
   the migration README comment.

Forward-only, applied via `prisma migrate deploy` on the platform instance's
next restart (dogfood flow, decisions §12). No long-running locks expected:
all touched tables are small; index creation on `Task` is the largest and the
table is single-user scale.

---

## 6. Test expectations

Existing suite (≈180 test files, `node --import tsx --test`) **must stay
green** — in particular `packages/api/src/templates.test.ts`,
`workflow.test.ts`, `app.test.ts`, `control-plane.test.ts` and
`packages/inbox/src/*` after the telemetry removal.

New tests, colocated with the code they exercise:

**Cron (scheduler + validation)**
- next-occurrence computation incl. timezone and DST boundary (pure function
  level);
- C1–C10 table rows as integration tests: no run on `CRON` create; one
  copy+run per fire; coalesced catch-up; invalid-cron 400; malformed stored
  cron skip; disabled loop.
- double-tick race: two concurrent poll bodies over the same due task produce
  one fire (transactional guard).

**Webhook (route)**
- W1–W9 rows: happy path equals operator instantiate; wrong/missing secret,
  unknown/un-enabled template indistinguishable 401; unresolved-variable 400;
  non-scalar mapping value; disabled secret; oversized body; no partial
  writes on any failure path (assert row counts).
- auth middleware regression: `/hooks/…` public, everything else still 401
  without a token.

**Chain advance (workflow)**
- K1–K9 rows: non-template advance on run complete, gate approve, operator
  PATCH; last-step no-op; idempotency under double PATCH and gate/complete
  race; index-gap tolerance; PATCH guard for template gates unchanged.

**Migration/cleanup**
- grep-level check (or compile) that the generated Prisma client no longer
  exports the three models; inbox package tests pass without
  `inboxConnectionWindow` calls.

---

## 7. Rollback notes

- **Code**: every feature has a small blast radius and reverts cleanly.
  Operational kill switches without deploys: `SCHEDULER_POLL_INTERVAL_MS=0`
  stops all cron/AT firing; nulling a template's `webhookSecretId` disables
  its webhook (route then answers 401). Chain advance has no flag — rollback
  is `git revert` (behavior returns to manual release; no data cleanup
  needed, already-advanced chains are just tasks).
- **Migration**: dropping the three tables is irreversible for their data;
  accepted because the data is dead/telemetry (§5). A down path, if ever
  needed, recreates the tables empty from the pre-batch schema. The additive
  parts (TaskTemplate columns, Task index) can be dropped without data
  considerations.
- **Mid-flight state after a rollback**: cron copy tasks and webhook-created
  chains are ordinary tasks/chains; they complete or get closed manually.
  Recurring definitions simply stop firing (`runAt` goes stale — harmless).

---

## 8. Reviewer verification (how to check the feature works)

On a dev instance with runner attached:

1. **Cron**: create an agent+repo task with `scheduleKind=CRON`,
   `cron="*/2 * * * *"`. Verify: no immediate run; within ~2.5 min a copy
   task appears with a queued/claimed run; the definition's `runAt` moved
   forward; stop the API for 5 min, restart, exactly one catch-up copy.
2. **Webhook**: configure a template with a `WEBHOOK` secret, repo, and a
   mapping. `curl -X POST …/hooks/templates/<id>` with wrong secret → 401,
   with right secret + payload → 201 and a full chain visible in Tasks with
   step 1 running. Omit a mapped field → 400, and confirm no tasks appeared.
3. **Chain advance**: instantiate any two-step chain (or hand-create two
   tasks sharing a `chainId`); let step 1 succeed → step 2 runs unaided.
   Mark a `REVIEW` chain task `DONE` via PATCH → successor runs. Approve a
   gate via Inbox → successor runs.
4. **Cleanup**: `psql \dt` shows no `Trigger`/`Automation`/
   `InboxConnectionWindow`; inbox process logs a clean boot; full test suite
   green (`npm test` at the root).

---

## 9. Consolidated assumptions (need Leo's eyes, roughly by weight)

- **A1 — `InboxConnectionWindow` is not zero-reference.** The batch premise
  ("verified zero references") is false for this model; the Feishu supervisor
  writes connection-window telemetry to it. Spec choice: drop the model *and*
  delete the write-only telemetry code. Alternative: keep the model and drop
  only `Trigger`/`Automation`.
- **A2 — Cron fire materializes a copy task** instead of re-running the
  recurring task itself. Chosen because same-task recurrence breaks the run
  budget (`maxRunsPerTask`), the `[taskId, runNumber]` uniqueness, and the
  `REVIEW` parking flow. Cost: more Task rows (one per fire) on the board.
- **A6 — Webhook = template instantiation** configured on `TaskTemplate`
  (secret + repo + payload mapping columns), static secret in
  `X-AgentOS-Webhook-Secret`, 401 indistinguishability, no HMAC/replay
  protection in V1.
- **A8/A10 — Chain advance generalizes to `chainId`/`chainIndex`** with
  `followUpTaskId` as fallback; `chainId`/`chainIndex` become settable at
  task creation (not patchable).
- **A4 — `AT` tasks are wired up by the same scheduler** (they were equally
  dead; one poll covers both). Strictly speaking batch 2 only names cron.
- **A5 — Null `timezone` means server-local time** for cron evaluation.
- **A7 — No overlap suppression across cron fires** (copies are independent);
  operator paces the schedule.
- **A9 — Operator-PATCH advance sends no gate card** for human successors
  (no run/session context); they're left `TODO` with an activity entry.
  **Amendment (approved plan §8-1):** A9 applies only to the operator-PATCH
  path. A successful source run gates template and non-template human
  successors uniformly (`REVIEW` + Inbox card), with chain-predecessor lookup
  providing a valid reject/re-run target.
