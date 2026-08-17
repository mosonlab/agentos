# Batch 2.5 SPEC — Tasks visibility: chain view, triggers & automations UI, kanban completeness

> **Superseded chain-control semantics:** TC-UX v1.0 replaces this document's
> intentional ordinary out-of-order start behavior with dependency-safe
> sequential execution. See [`tc-ux-v1-errata.md`](./tc-ux-v1-errata.md).

Status: spec (step ① of the nine-step chain)
Author: spec agent, 2026-08-16
Scope authority: `docs/BACKLOG-V2.md` 批次 2.5 · `docs/reference/danny-agentos-video/detail-gaps.md` §2/§4/§5/§6 · `docs/reference/danny-agentos-video/decisions.md` §12 · the task brief's binding UI rulings (Leo, 2026-08-16)
Runs after: the frontend-convergence chain is merged (already on `master`), and after batch 2 (merged: `22b18b6`).

---

## 1. Problem and audience

The single operator (Leo) runs this system on itself. Batch 2 made three things
*work* that nobody can *see*:

1. **A nine-step chain is nine flat kanban cards.** Nothing on the board or on
   task detail says "this is step 4 of 9, step 3 is the gate, step 5 is next".
   The operator reconstructs the chain by reading task names and guessing.
   The first real dogfood run produced exactly this confusion (BACKLOG-V2,
   批次 2 闸门消息条目).
2. **Cron tasks and webhook triggers execute with no UI at all.** The scheduler
   fires copies of recurring tasks every N minutes and `POST /hooks/templates/:id`
   instantiates chains, and there is no page in the product that lists either.
   detail-gaps calls this "做了看不见" — the archetypal invisible-feature debt.
   A trigger that has fired 601 times and one that has never fired look
   identical (i.e. invisible) today.
3. **The board has nowhere to put work that is not started, and nowhere to put
   work that is finished.** Four columns, no `Backlog`, no archive. After a week
   of dogfood the `Done` column is an unreadable wall.

Audience: the operator, on the web app. Not an API consumer, not a multi-user
product. Everything here is read-mostly UI plus the smallest backend that makes
that UI truthful.

**Success condition in one sentence:** after this batch, opening `/tasks` tells
the operator which step of which chain is running, what fired it, what is
scheduled to fire next, and lets them clear finished work off the board.

---

## 2. Verified starting state

Everything in this section was read out of the tree at `2737113`, not assumed.

### 2.1 Data model — `packages/db/prisma/schema.prisma`

- `Task` carries `chainId String?`, `chainIndex Int?` with
  `@@unique([chainId, chainIndex])`, plus `templateId`, `templateStepId`,
  `followUpTaskId`, `approvalGate`, `scheduleKind (NOW|AT|CRON)`, `runAt`,
  `cron`, `timezone`. There is **no** parent/child nesting — decisions §12's flat
  chain is the real model (`schema.prisma:441-493`).
- `TaskStatus = TODO | DOING | REVIEW | DONE` (`schema.prisma:46-51`). No
  `BACKLOG`, no archived concept anywhere on `Task`.
- `TaskTemplate` carries `variables String[]`, `webhookSecretId`,
  `webhookRepoId`, `webhookPayloadMapping Json?` (`schema.prisma:397-418`).
  There is **no** enabled/paused flag and **no** replay-window field.
- `TaskTemplateStep` carries `stepIndex`, `name`, `assigneeType`,
  `assigneeAgentId`, `approvalGate`, `runner`, `outputKind`.
- `Agent` already has the `archivedAt DateTime?` soft-retire precedent
  (plus `POST /agents/:id/archive` / `unarchive`) — this batch copies that shape
  for tasks.
- The dead `Trigger` and `Automation` models were **dropped** by batch 2
  (`d540c03`). "Trigger" in this product means *a webhook-enabled TaskTemplate*;
  "Automation" means *a Task with `scheduleKind = CRON`*. This spec uses those
  two definitions everywhere.

### 2.2 Chain behaviour — `packages/db/src/workflow.ts`

- `instantiateTemplate` (`packages/api/src/templates.ts`) creates **one Task row
  per template step**, all sharing a fresh `chainId`, with
  `chainIndex = step.stepIndex`, wires `followUpTaskId` down the list, and
  enqueues run 1 for the first step only. Steps are *never* skipped at
  instantiation: "template-driven step skipping" (decisions §12) means the
  template itself has fewer steps, and `stepIndex` may be sparse.
- `activateChainSuccessor` finds the successor by
  `chainId = same AND chainIndex > current`, ordered ascending — so a chain is
  defined by its rows, not by a step count stored anywhere.
- The successor claim is a CAS with
  `status: { in: [TODO, DOING, REVIEW] }` inside a `for(;;)` retry loop
  (`workflow.ts:225-252`). **A successor in any status outside that set makes the
  loop spin forever.** This is load-bearing for §5.3.
- Gates: `advanceTemplateTask` puts a gated step in `REVIEW` and opens an Inbox
  question; approval marks it `DONE` and enqueues the follow-up.
- A step whose assignee is archived is *parked* in `REVIEW` with a
  `failureReason`, not queued — the existing precedent for "the chain stopped and
  a human must act".
- The seeded nine-step template (`packages/db/prisma/seed.ts:181-213`) uses
  `stepIndex` **1..9**, step 9 is `assigneeType = HUMAN` with an approval gate.
  So chain views must render human steps and must not assume 0-based indices.

### 2.3 Trigger / automation execution — batch 2, merged

- `POST /hooks/templates/:templateId` (`app.ts:473-505`): constant-time secret
  compare, payload→variable resolution, then `instantiateTemplate` with
  `actorType: "webhook"` and activity metadata `{ webhookTemplateId, firedAt }`.
  Returns `201 { chainId, taskIds }`. **No fire is recorded anywhere except in
  `TaskActivity` rows attached to the created tasks.**
- `schedulerTick` (`packages/api/src/scheduler.ts`) polls every 30 s
  (`SCHEDULER_POLL_INTERVAL_MS`). For a due `CRON` task it **creates a copy**
  (`scheduleKind: NOW`, no chain, no template, name suffixed with the fire time),
  enqueues the copy's run, advances the recurring task's `runAt` to the next
  occurrence, and writes an activity row on both sides with metadata
  `{ recurringTaskId, firedAt }`. The recurring task itself stays `TODO` forever
  and never runs. A broken cron expression is *quarantined* by setting
  `runAt = null` plus an activity row.
- There is **no** pause flag for either mechanism, no fire counter, no
  replay/idempotency window. Batch 2's spec §3 listed "Recent fires", replay
  window, and the auto-start toggle as explicit non-goals — they land here.
- `POST /tasks/:taskId/retry` exists but **requires a prior run**
  (`app.ts:1354-1372`, `409 "Task has no run to retry"`). There is no endpoint
  that starts a never-run task.

### 2.4 Web app — `apps/web`

- `pages/Tasks.tsx`: four hard-coded columns (`COLUMNS`, line 35), drag-and-drop
  `PATCH /tasks/:id {status}`, task card with schedule/approval/template pills,
  run line, agent chip, cost, relative time. A `Segmented` control already sits
  above the board with a **single** option `Tasks` (line 304) — the tab bar's
  placeholder.
- `pages/TaskDetail.tsx`: header + status select over `STATUSES` (line 170),
  Details/Prompt/Step output/Runs/Activity cards. Nothing chain-aware.
- `lib/types.ts` `Task` (line 224) omits `chainId`/`chainIndex` even though the
  API returns them.
- `components/ui.tsx` provides `Tabs`, `Segmented`, `Pill` (tones
  green/amber/violet/red/grey/accent), `TaskPill` with an **exhaustive**
  `Record<TaskStatus, PillTone>` map (line 117), `Card`, `Table`, `RowMenu`,
  `KeyValue`, `EmptyState`, `Toggle`, `Markdown`.
- Router (`lib/router.tsx`) is hash-based and matches by **path segments only**
  — no query-string support. `/tasks/:taskId` already occupies the second
  segment of `/tasks`, so new tabs cannot live at `/tasks/automations`.
- `apps/web/package.json` has **no** cron-formatting dependency. The API has
  `cron-parser`; the web app has nothing.
- Web tests: `node --test` + jsdom over `src/tests/*.test.tsx`, pure-function and
  render-level. API tests: `*.test.ts` (unit) and `*.dbtest.ts` (real Postgres).

### 2.5 Corrections to the task brief (verified, binding on later steps)

1. **"This batch is pure UI over existing chain data" is true only for the chain
   view.** The chain view (§4.1, §4.2) needs no schema change. Everything else in
   the brief's in-scope list does:
   - `Backlog` column → a `TaskStatus` enum value.
   - `Archived` view + `Archive All` → an archived column and queries.
   - task-source badges (cron/webhook/manual) → nothing on the `Task` row records
     who created it; only free-text activity does.
   - Triggers `Last fired` / `Fires` / `Recent fires` → batch 2 records no fire
     ledger; deriving counts from `TaskActivity` JSON is fragile and breaks when
     tasks are deleted.
   - `Replay window (seconds)` → the field does not exist and nothing dedupes.
   - Pause/Enable for triggers and automations → no flag exists for either.
   The brief's acceptance shape already anticipates this ("any enum addition
   gets explicit migration + rollback treatment"). §5.1 keeps the migration as
   small as it can be while leaving no field on screen that lies.
2. **The brief's "`Fire now` creates exactly one run"** is satisfiable exactly
   because `instantiateTemplate` enqueues run 1 for the first step only; the
   other 8 steps are created with zero runs. The acceptance test must assert
   `runs.length === 1` across the whole new chain, not just on the first task.
3. **The review fan-out is cancelled** (Leo, 2026-08-16). No `spawnPolicy`,
   parallel-peer, or `workflow.ts` scheduling change appears anywhere in this
   spec. The one `workflow.ts` change here (§5.3) exists solely to stop the new
   `BACKLOG` status from hanging the successor CAS loop.
4. **`My Tasks` is dropped** per the brief; four tabs.

---

## 3. Scope

### 3.1 In scope

1. **Chain view** on task detail — vertical step list (§4.1).
2. **Kanban chain marker** — one line `n/m · <step> · <status>` (§4.2).
3. **Start now** — manual release of a pending chain step (§4.3).
4. **Four tabs** `Tasks / Automations / Triggers / Archived` with real routes (§4.4).
5. **Triggers**: table (§4.5) + detail page with Fire now, Pause/Enable,
   required-variable badges, replay window, Recent fires (§4.6).
6. **Automations**: table with human-readable schedule, pause toggle,
   expandable Recent sessions (§4.7).
7. **Kanban completeness**: `Backlog` column (§4.8), `Archive All` + `Archived`
   view (§4.9), task-source badges (§4.10).
8. The backend in §5 that makes the above truthful, and only that.

### 3.2 Explicitly out of scope

- `Show on task board` trigger toggle (detail-gaps advises against; no
  high-frequency source in dogfood).
- Parent/child subtask tree, drag handles, per-subtask date pickers, `+ Add
  subtask`, explicit `Dependencies` field UI. The flat step list *is* the
  dependency display (decisions §12).
- Attachment upload / file-preview modal (batch 4's Markdown outputs cover
  reading).
- `First-task auto-start` dropdown (detail-gaps ❌; fires always auto-start).
- Trigger/template **creation** and renaming from the UI. Templates remain
  seed/DB-managed; the Triggers page configures webhook fields on existing
  templates only. `+ New Trigger` is not built (§11 open question O2).
- Cron *editing* UI (a cron builder). Pause/resume only; the expression itself is
  edited through the existing task PATCH, which the Automations row exposes as a
  plain text field (§4.7).
- HMAC signature schemes, timestamp tolerance — the replay window here dedupes
  identical deliveries, it does not authenticate them differently (batch 2's
  static shared secret stands).
- i18n (batch 1), light-mode audits, Goals/Inbox surfaces, Costs page.
- Any change to how runs are claimed, executed, or reconciled.

---

## 4. Intended behaviour, in concrete scenarios

Terminology used throughout:

- **chain** — the set of `Task` rows sharing a non-null `chainId`.
- **m** — `count(chain rows)`. Template-skipped steps were never instantiated, so
  they are not rows, so they do not count. `m` is **not** `max(chainIndex)+1`.
- **n** — `count(chain rows with status = DONE)`.
- **position** — the 1-based ordinal of a row within the chain sorted by
  `chainIndex` ascending. Displayed instead of raw `chainIndex`, so a
  3-step chain with `stepIndex` 1/5/9 reads 1, 2, 3 (**[A1]**).
- **step name** — `templateStep.name` when present, else `task.name`. Task names
  are `"<template>: <step>"`, which is too long for a card line.
- **active step** — the row with the lowest `chainIndex` whose status is not
  `DONE`; if every row is `DONE`, the last row.
- **step status** — the row's `TaskStatus`, lowercased (`todo`, `doing`,
  `review`, `done`, `backlog`) (**[A2]**).

### 4.1 Chain view on task detail — vertical step list

Rendered on `/tasks/:taskId` as a `Card` titled **`Chain`** with
`extra = <count>n/m</count>`, placed **directly under `Details`** and above
`Prompt`. Shown only when the task has a `chainId`; otherwise the card is
absent entirely (no empty state).

One row per chain step, ordered by `chainIndex` ascending. Each row carries,
left to right:

| Element | Content | Notes |
|---|---|---|
| position | `1` … `m` | ordinal, not `chainIndex` (**[A1]**) |
| step name | `templateStep.name ?? task.name` | links to `/tasks/<that task id>` |
| agent | agent title, or `Human` for `assigneeType = HUMAN`, or `Unassigned` | reuses `AgentChip` |
| gate | 🔒 lock glyph when `approvalGate` | native `title="requires approval before unblocking dependents"` |
| status | `TaskPill` | existing tone map, extended for `BACKLOG` |
| action | `Start now` button when the step is *startable* (§4.3) | right-aligned |

The row of the **task currently open** is highlighted (accent left border +
`bg-accent`) and carries the text `You are here` (**[A3]**). A step that the
chain has parked (§5.3 — successor left in `Backlog`, or archived, or
`failureReason` set) shows its `failureReason` (or `Parked in Backlog`) as a
muted sub-line under the step name.

Scenarios:

| # | Situation | Expected |
|---|---|---|
| C1 | Nine-step seeded chain, step 4 running, steps 1–3 done, step 1 was a gate | Card header `3/9`; rows 1–3 `done` (row 1 with lock), row 4 `doing` and highlighted if open, rows 5–9 `todo` with `Start now`, row 9 shows `Human` + lock |
| C2 | Chain whose template has 3 steps with sparse `stepIndex` 1/5/9 | Positions read `1 2 3`, header `n/3` |
| C3 | Task with no `chainId` (blank task, cron copy) | No `Chain` card at all |
| C4 | Chain where a middle step is `REVIEW` because its gate is open | That row shows `review` + lock; rows after it show `todo` and *do* offer `Start now` (out-of-order start is allowed and is the point of the button) |
| C5 | One chain row was deleted by the operator | The card renders the surviving rows; `m` shrinks accordingly; no error |
| C6 | A chain row is archived (§4.9) | The row still renders, with a grey `archived` pill after the status; it counts toward `m`, and toward `n` only if it is also `DONE` |

Polling: the chain card refreshes on the task detail page's existing poll
cadence (`usePoll` default). No new polling loop.

### 4.2 Kanban card chain marker

Every board card belonging to a chain gains **exactly one line** in the card's
meta block, under the schedule/approval pills and above the run line:

```
4/9 · Implementation · doing
```

- Format: `` `${n}/${m} · ${activeStepName} · ${activeStepStatus}` ``.
- The marker describes the **chain**, not the card, so all nine cards of a chain
  show the same line. That is intentional: any card tells you where the chain is.
- Cards with no `chainId` show no marker line (no placeholder, no `—`).
- Truncation: the line is a single row with `overflow-hidden text-ellipsis
  whitespace-nowrap`; long step names ellipsize rather than wrap (card height
  must not change between chain and non-chain cards by more than this one line).

| # | Situation | Expected |
|---|---|---|
| K1 | Seeded nine-step chain, steps 1–3 done, 4 running | Every card of that chain: `3/9 · Implementation · doing` (step name of step 4) |
| K2 | Three-step skipped-template chain, 1 done | `1/3 · <step 2 name> · todo` — **this is the brief's skipped-step acceptance check** |
| K3 | Chain fully done | `9/9 · Human PR review · done` |
| K4 | Blank one-off task | No marker line |
| K5 | Chain step parked in `Backlog` and it is the active step | `3/9 · Implementation · backlog` |

### 4.3 `Start now` — manual release of a pending step

A step is **startable** when *all* of: `assigneeType = AGENT`, an assignee agent
exists and is not archived, a repo is set, status is `TODO` or `BACKLOG`, the
task is not archived, it has **no active run** (`QUEUED | CLAIMED |
PROVISIONING | RUNNING`), and `runs.length < maxSessionsPerTask`. Non-startable
steps show no button (a disabled button with a tooltip is not required).

Pressing it calls `POST /tasks/:taskId/start` (§5.2), which enqueues run
`lastRunNumber + 1` through the existing `enqueueTaskRun`, sets the task to
`TODO` if it was `BACKLOG`, and writes an activity row
`Started manually from the chain view`. The button shows a pending state; on
success the page reloads its polls; on failure the page shows the API's error in
the existing `ErrorNotice`.

| # | Situation | Expected |
|---|---|---|
| S1 | Step 6 of a running chain, never run | `201`, one new `QUEUED` run, activity row, chain view flips step 6 to `todo`/`doing` on the next poll |
| S2 | Press twice quickly | Second call `409 "Task already has an active run"`; still exactly one run |
| S3 | Human step (step 9) | No button; a direct API call returns `409 "Human steps cannot be started"` |
| S4 | Assignee archived | No button; direct API call `409` naming the agent (reuse `ArchivedAssigneeError`'s message) |
| S5 | Run budget exhausted | No button; direct API call `409 "Run budget exhausted"` |
| S6 | Task already `DONE` | No button; direct call `409 "Task is already done"` |
| S7 | Task in `Backlog` | Button present; a successful start also moves it to `TODO` so the runner can claim it |

### 4.4 The four tabs

Tabs, in order: **`Tasks` · `Automations` · `Triggers` · `Archived`**, rendered
with the existing `Segmented` control that already sits on the Tasks page
(replacing its single-option placeholder). Each tab is a **real route** so it can
be linked and bookmarked; the hash router matches segments only, so the tabs are
siblings of `/tasks`, not children (§2.4):

| Tab | Route | Page |
|---|---|---|
| Tasks | `/tasks` | the kanban board (existing) |
| Automations | `/automations` | §4.7 |
| Triggers | `/triggers` | §4.5 |
| Archived | `/archived` | §4.9 |
| (trigger detail) | `/triggers/:templateId` | §4.6 |

All four tab pages share the page head (`Tasks` title, project subtitle,
`+ Create Task`) and the tab bar, so switching tabs feels like one page. The
sidebar keeps a single `Tasks` entry, active for all five routes.

### 4.5 Triggers table — `/triggers`

Lists every `TaskTemplate` in the project that is **webhook-configured**
(`webhookSecretId != null`). Templates without webhook config are not triggers
and do not appear; the empty state reads
`No triggers yet — a trigger is a task template with a webhook secret and repo.`

Columns (per the brief): `Name / Target / Status / Last fired / Fires`, plus a
description sub-row under the name and a `RowMenu`.

- **Name** — `template.name`, links to `/triggers/:templateId`. Sub-row:
  `template.description` (muted, single line, ellipsized).
- **Target** — `<webhookRepo.name> · <steps.length> steps` (**[A4]**).
- **Status** — `Enabled` (green) or `Paused` (amber) from `webhookPausedAt`.
  A trigger whose secret has been disabled (`Secret.disabledAt`) shows
  `Disabled secret` (red) — otherwise the row would claim `Enabled` while every
  inbound fire 401s.
- **Last fired** — relative time of the newest `TriggerFire`, else `Never`.
- **Fires** — `TriggerFire` row count for the template; `0` renders as `0`, not `—`.
- **RowMenu** — `Fire now`, `Pause` / `Enable`, `Open`.

### 4.6 Trigger detail — `/triggers/:templateId`

Header: back link, template name, `Template` pill, `Enabled`/`Paused` pill, then
`⏸ Pause` / `▶ Enable` and `⚡ Fire now` buttons.

Cards, in order:

1. **Endpoint** — read-only. `POST <apiBase>/hooks/templates/<id>` with a copy
   button, the header name `X-AgentOS-Webhook-Secret`, and the *name* of the
   configured secret. **The secret value is never fetched or rendered** — the
   API has no route that returns it and this page must not add one.
2. **Default variables** — one row per `template.variables[]`, showing:
   variable name; the mapped payload path (`webhookPayloadMapping.map[name]`) as
   code, or `—`; the default literal (`.defaults[name]`) or `—`; and a red
   `required` badge when the variable has **neither** a mapping nor a default
   (i.e. every fire that does not carry it will 400). Editable inline: mapping
   path and default literal, saved by `Save changes` (one `PATCH
   /task-templates/:id` for the whole card).
3. **Delivery** — `Replay window (seconds)` number input, empty/`0` = disabled,
   range 1…86400, with the hint
   `Identical deliveries inside this window are acknowledged without starting a
   second chain.` Saved by the same `Save changes`.
4. **Recent fires** — newest 20 `TriggerFire` rows: relative time, `webhook` or
   `manual` source pill, the chain's first task name (linked to that task), and
   the chain's progress rendered with the §4.2 marker. A fire whose chain was
   deleted shows `chain deleted` in muted text.

`Fire now` calls `POST /task-templates/:templateId/fire` (§5.2). On success the
page reloads and the new fire is the first row of `Recent fires`.

| # | Situation | Expected |
|---|---|---|
| T1 | `Fire now` on a fully-defaulted trigger | `201`; one new chain; **exactly one** `QUEUED` run across the whole chain; one `TriggerFire` row with `source = MANUAL`; the row is visible in `Recent fires` without a manual refresh (next poll) |
| T2 | `Fire now` when a variable has no mapping and no default | `400` listing the unresolved variable names; the page shows them in an `ErrorNotice`; nothing created |
| T3 | `Fire now` on a paused trigger | Succeeds — pausing stops inbound webhooks only (**[A5]**); the button is not disabled while paused |
| T4 | `Pause` then external `POST /hooks/templates/:id` with the correct secret | `401`, indistinguishable from a wrong secret (matches batch 2's W2/W3 rule); no chain, no `TriggerFire` |
| T5 | Two identical webhook deliveries 3 s apart, replay window 300 | First `201` and one `TriggerFire`; second `200 { duplicate: true, chainId }` with no new chain, no new `TriggerFire`, no new run |
| T6 | Same two deliveries 400 s apart, window 300 | Two chains, two fires |
| T7 | Replay window empty (disabled), two identical deliveries | Two chains (batch 2's documented W8 behaviour, unchanged) |
| T8 | Template's webhook repo was deleted | `PATCH` guard already forbids a repo outside the project; if the FK nulls the repo, the trigger drops off the Triggers list (it is no longer webhook-configured) and the row's `Fire now` returns `400` |

### 4.7 Automations table — `/automations`

Lists every non-archived `Task` in the project with `scheduleKind = CRON`.
Columns: `Title / Agent / Schedule / Status / Last run`, chevron to expand, and a
`RowMenu` (`Pause`/`Resume`, `Open task`, `Delete`).

- **Schedule** — human prose from `cronstrue` (`At 01:00 AM, only on Monday`),
  with the raw expression and IANA timezone as a muted sub-line
  (`0 1 * * 1 · Asia/Shanghai`). If `cronstrue` throws, fall back to the raw
  expression — never render an exception string.
- **Status** — `Active` (green, sub-line `Next run <relative time>` from
  `runAt`), `Paused` (amber) when `schedulePausedAt != null`, or `Quarantined`
  (red, sub-line `Fix the cron expression`) when `runAt == null` and not paused —
  the state batch 2's `quarantineTask` produces for an unparseable expression.
- **Last run** — relative time of the newest fired copy, else `Never`.
- **Expanded row** — `Recent sessions:` list of the 5 newest fired copies:
  fire time · latest run status pill · cost · link to the copy's task, plus a
  session link when the run has one, and a `View all sessions →` link to
  `/sessions`.
- **Pause / Resume** — `POST /tasks/:taskId/schedule/pause` and
  `.../schedule/resume` (§5.2). Pausing does not touch in-flight copies. Resuming
  recomputes `runAt` from *now*, so a long pause does not produce a catch-up
  burst.

| # | Situation | Expected |
|---|---|---|
| M1 | `0 9 * * *`, Asia/Shanghai, active | `At 09:00 AM` + sub-line; `Next run in 3h` |
| M2 | Pause, wait past two scheduled times, resume | Zero fires while paused; after resume `runAt` is the *next future* occurrence; no backfill fires |
| M3 | Cron quarantined by the scheduler | `Quarantined` red pill; `Resume` is offered and returns `400` with the parse error if the expression is still bad |
| M4 | Automation that has fired 12 times | `Recent sessions` shows the newest 5, newest first |
| M5 | No cron tasks in the project | Empty state: lightning glyph, `No automations yet`, and a line explaining that a task with a cron schedule becomes an automation |

### 4.8 `Backlog` column

The board gains a leftmost column `Backlog`, so: `Backlog / Todo / Doing /
Review / Done`, each with its count. Drag-and-drop works into and out of it
exactly like the other columns.

Semantics: **`Backlog` means "the runner must not pick this up"**. The run-claim
query only accepts tasks in `TODO | DOING`, so this is already true mechanically;
this batch makes the two consequences safe and visible:

| # | Situation | Expected |
|---|---|---|
| B1 | Drag a task with an active run into `Backlog` | `409 "Cannot move a task with an active run to Backlog"`; card snaps back |
| B2 | Drag a never-run chain step into `Backlog`, then its predecessor completes | The chain **parks**: the step stays in `Backlog`, no run is enqueued, an activity row says `Predecessor <name> completed; successor is parked in Backlog — use Start now`, and the chain view shows the parked sub-line (§5.3). The advance call must **return**, not spin (§2.2) |
| B3 | `Start now` on a parked step | It moves to `TODO` and a run is enqueued (S7) |
| B4 | Drag a task from `Backlog` to `Todo` | Status changes only; **no run is enqueued** — moving columns has never enqueued anything and must not start now (**[A6]**) |
| B5 | A `CRON` task dragged to `Backlog` | It stops firing — `schedulerTick` filters `status: TODO`. The Automations tab still shows `Active`, with a muted `in Backlog` note next to it so the discrepancy is visible rather than silent (§11 O3) |

### 4.9 `Archive All`, `Archived` view

- The `Done` column header gains an `Archive All` button, shown only when the
  column is non-empty. It asks for confirmation
  (`Archive N done tasks?`) and calls `POST /projects/:projectId/tasks/archive-done`.
- Archiving sets `archivedAt = now()`. Archived tasks are **excluded from every
  board query** — `GET /tasks` defaults to `archived=false`.
- The `Archived` tab is a table (not a board): `Name / Status / Agent / Chain /
  Archived` + `Unarchive` in the row menu. `Chain` renders the §4.2 marker when
  the row belongs to one. Newest-archived first, capped at 200 rows with a
  `Showing the 200 most recently archived` footer (**[A7]**).
- Individual archive lives in the board card's `RowMenu` (`Archive`) and on task
  detail's header menu.

| # | Situation | Expected |
|---|---|---|
| A1 | `Archive All` with 7 done tasks | 7 rows get `archivedAt`; `Done` column reads 0; `Archived` tab shows 7 |
| A2 | `Archive All` on an empty `Done` column | Button not rendered; a direct API call returns `200 { archived: 0 }` |
| A3 | Archive a task with an active run | `409 "Cannot archive a task with an active run"` |
| A4 | Unarchive | `archivedAt = null`; the task reappears in its original status column |
| A5 | A chain with 4 archived steps | The chain view still shows all 9 rows (C6); the board shows only the 5 unarchived cards, and their `n/m` still reads out of 9 |
| A6 | Archived task opened directly by URL | Task detail renders normally with an `archived` pill in the header and an `Unarchive` action |

### 4.10 Task-source badges

Each `Task` records how it was created: `MANUAL` (operator or an operator-driven
template instantiation), `CRON` (a scheduler-fired copy), `WEBHOOK` (a chain
created by an inbound webhook fire).

Board cards render a pill for `CRON` (grey, `cron`) and `WEBHOOK` (accent,
`webhook`) next to the existing schedule/approval/template pills. `MANUAL` is
the unlabelled default — a badge on every card would be pure noise (**[A8]**).
The recurring task itself (the `CRON`-scheduled parent) keeps its existing
`cron` schedule text and is `MANUAL` by source; only its fired copies are
`CRON`-sourced.

---

## 5. Data and interface changes

### 5.1 Schema and migration

All of this is one Prisma migration folder **except** the `TaskStatus` enum
value, which must be its own earlier migration: Postgres forbids using an enum
value added in the same transaction, and `prisma migrate` runs each migration in
a transaction. So: `NNNN_task_status_backlog` first (ALTER TYPE only), then
`NNNN_tasks_visibility` for everything else.

```prisma
enum TaskStatus {
  BACKLOG @map("backlog")   // NEW — first value in board order
  TODO    @map("todo")
  DOING   @map("doing")
  REVIEW  @map("review")
  DONE    @map("done")
}

enum TaskSource {           // NEW
  MANUAL  @map("manual")
  CRON    @map("cron")
  WEBHOOK @map("webhook")
}

enum TriggerFireSource {    // NEW
  WEBHOOK @map("webhook")
  MANUAL  @map("manual")
}

model Task {
  // ...
  source                TaskSource @default(MANUAL)   // NEW
  archivedAt            DateTime?                     // NEW
  schedulePausedAt      DateTime?                     // NEW  (automation pause)
  recurringSourceTaskId String?                       // NEW  (a cron copy points at its parent)
  recurringSource       Task?   @relation("TaskRecurringSource", fields: [recurringSourceTaskId], references: [id], onDelete: SetNull)
  recurringCopies       Task[]  @relation("TaskRecurringSource")

  @@index([projectId, archivedAt, status])            // NEW — the board query
  @@index([recurringSourceTaskId])                    // NEW
  @@index([chainId, chainIndex])                      // already unique; keep
}

model TaskTemplate {
  // ...
  webhookPausedAt        DateTime?                    // NEW
  webhookReplayWindowSec Int?                         // NEW  (null/0 = disabled)
  fires                  TriggerFire[]                // NEW
}

model TriggerFire {                                   // NEW — the fire ledger
  id         String            @id @default(cuid())
  templateId String
  chainId    String?
  source     TriggerFireSource
  dedupeKey  String?
  createdAt  DateTime          @default(now())
  template   TaskTemplate      @relation(fields: [templateId], references: [id], onDelete: Cascade)

  @@index([templateId, createdAt])
  @@index([templateId, dedupeKey, createdAt])
}
```

**Backfill, inside the second migration:**

- `Task.source = 'cron'` where a `TaskActivity` row for that task has
  `actorType = 'scheduler'` and `metadata->>'recurringTaskId'` is not null;
  `Task.recurringSourceTaskId` from that same `metadata->>'recurringTaskId'`
  (only when the referenced task still exists).
- `Task.source = 'webhook'` where a `TaskActivity` row for that task has
  `actorType = 'webhook'`.
- Everything else keeps the `manual` default.
- `TriggerFire` is backfilled from existing webhook activity: one row per
  distinct `(metadata->>'webhookTemplateId', metadata->>'firedAt')` pair, with
  `chainId` from the task's `chainId` and `source = 'webhook'`. If that produces
  nothing (likely — dogfood has no external webhook traffic yet), the table
  simply starts empty; `Fires 0` is correct, not a regression.
- No row is ever set to `backlog`; the new status is only reachable through the
  UI after deploy.

### 5.2 HTTP endpoints

New:

| Method + path | Body | Returns | Notes |
|---|---|---|---|
| `GET /tasks/:taskId/chain` | — | `{ chainId, total, done, steps: [...] }` | `{ chainId: null, total: 0, done: 0, steps: [] }` for a task with no chain (200, not 404). Each step: `taskId, position, chainIndex, name, stepName, status, approvalGate, assigneeType, agent {id,title}|null, archivedAt, failureReason, latestRun {id,status,runNumber}|null, startable` |
| `POST /tasks/:taskId/start` | — | `201 { runId, runNumber }` | Enqueues via `enqueueTaskRun`; flips `BACKLOG`→`TODO`; guards per S2–S6 |
| `POST /tasks/:taskId/archive` | — | `200 task` | `409` if an active run exists |
| `POST /tasks/:taskId/unarchive` | — | `200 task` | idempotent |
| `POST /projects/:projectId/tasks/archive-done` | — | `200 { archived: n }` | only `status = DONE`, only `archivedAt IS NULL`, skips tasks with an active run and reports the skipped count |
| `POST /tasks/:taskId/schedule/pause` | — | `200 task` | `400` unless `scheduleKind = CRON` |
| `POST /tasks/:taskId/schedule/resume` | — | `200 task` | recomputes `runAt` from now; `400` with the parse error if the cron is invalid |
| `GET /tasks/:taskId/recurring-fires?take=5` | — | `200 [{ taskId, name, createdAt, status, latestRun }]` | copies of a recurring task, newest first |
| `GET /projects/:projectId/triggers` | — | `200 [{ id, name, description, repo, stepCount, paused, secretDisabled, lastFiredAt, fireCount }]` | webhook-configured templates only |
| `GET /triggers/:templateId` | — | `200 { ...template, paused, replayWindowSec, variables[], mapping, defaults, endpointPath, secretName, fireCount, lastFiredAt }` | never includes a secret value |
| `GET /triggers/:templateId/fires?take=20` | — | `200 [{ id, createdAt, source, chainId, firstTask {id,name}|null, progress {done,total,activeStepName,activeStatus}|null }]` | |
| `POST /triggers/:templateId/pause` \| `/enable` | — | `200 { paused }` | sets/clears `webhookPausedAt` |
| `POST /task-templates/:templateId/fire` | `{ variables?: Record<string,string> }` | `201 { chainId, taskIds, fireId }` | operator-authenticated; merges body variables over `mapping.defaults`; `400` listing unresolved variables; records `TriggerFire { source: MANUAL }` |

Changed:

| Endpoint | Change | Compatibility |
|---|---|---|
| `GET /tasks` | new query param `archived=false\|true\|all` (**default `false`**); each task gains `source`, `archivedAt`, `chainId`, `chainIndex`, `templateStep {name}`, and a computed `chainProgress {chainId, position, total, done, activeStepName, activeStatus} \| null` | The default flips behaviour for any caller that wants archived rows; the only caller is our web app. Documented as a deliberate break in the runbook |
| `GET /tasks/:taskId` | gains `source`, `archivedAt`, `schedulePausedAt`, `recurringSourceTaskId` (Prisma returns new columns automatically) | additive |
| `PATCH /tasks/:taskId` | `status` now accepts `BACKLOG`; rejects `BACKLOG` with `409` when an active run exists (B1) | additive |
| `PATCH /task-templates/:templateId` | `webhookConfigPatch` gains `webhookReplayWindowSec: number().int().min(0).max(86400).nullable().optional()` | additive |
| `POST /hooks/templates/:templateId` | (a) a paused template authenticates as `null` → `401` (T4); (b) when `webhookReplayWindowSec > 0`, compute `dedupeKey = header X-AgentOS-Delivery-Id ?? sha256(raw body)` and look for a `TriggerFire` with the same `(templateId, dedupeKey)` newer than `now - window`; on hit return `200 { duplicate: true, chainId }` and create nothing; (c) on a real fire, write one `TriggerFire { source: WEBHOOK, dedupeKey, chainId }` in the same transaction as the instantiation | The `200` duplicate response is new; `201` on a real fire is unchanged |
| `instantiateTemplate(...)` | `options` gains `source?: TaskSource` (default `MANUAL`), stamped onto every created task | additive |
| `fireCronTask(...)` | the copy gets `source: CRON` and `recurringSourceTaskId: task.id` | additive |
| `schedulerTick` | cron query gains `schedulePausedAt: null`; both queries gain `archivedAt: null` | behavioural: paused and archived recurring tasks stop firing |

### 5.3 The one `workflow.ts` change — parked successors

`activateChainSuccessor` must, **before** entering the CAS retry loop, check the
successor and return early when it is not eligible:

- `successor.archivedAt != null` → activity row `Predecessor <name> completed;
  successor is archived and was not queued`, return `{ nextTaskId, gated:false }`.
- `successor.status === BACKLOG` → activity row `Predecessor <name> completed;
  successor is parked in Backlog — use Start now`, return the same shape.

Without this the new enum value makes the existing
`status: { in: [TODO, DOING, REVIEW] }` CAS fail, the loop re-read finds a
non-DONE task with no active run, and it loops forever *inside a database
transaction* — an unkillable hang on run completion. This is the single highest-risk
line of the batch and the code review must verify it explicitly.

No other `workflow.ts` behaviour changes. No scheduling, no parallel peers.

### 5.4 Frontend modules

New files (names indicative, not binding):

- `apps/web/src/lib/chain.ts` — pure: `chainProgress(rows)` → `{done,total,activeStepName,activeStatus}`, `positions(rows)`, `startable(row)`. Unit-tested without a DOM.
- `apps/web/src/lib/schedule.ts` — pure: `cronProse(expr, timezone)` wrapping `cronstrue` with the fallback, `nextRunLabel(runAt)`, `automationState(task)` → `active|paused|quarantined`.
- `apps/web/src/components/chain-list.tsx` — the vertical step list (§4.1).
- `apps/web/src/pages/Automations.tsx`, `pages/Triggers.tsx` (list + detail), `pages/Archived.tsx`.
- `apps/web/src/components/tasks-tabs.tsx` — the shared page head + four-tab bar.

Changed: `pages/Tasks.tsx` (5 columns, marker line, source pills, `Archive All`,
row-menu `Archive`), `pages/TaskDetail.tsx` (chain card, archived pill,
archive/unarchive), `components/ui.tsx` (`taskTones.BACKLOG = "grey"`),
`lib/types.ts` (`TaskStatus` union gains `"BACKLOG"`; `Task` gains `chainId`,
`chainIndex`, `source`, `archivedAt`, `schedulePausedAt`, `chainProgress`;
new `ChainStep`, `Trigger`, `TriggerFire` types), `App.tsx` (four new routes).

New dependency: **`cronstrue`** (~30 kB, zero runtime deps, MIT) in
`apps/web/package.json`. If the plan step finds the bundle-size or supply-chain
cost unacceptable, the fallback is a hand-written formatter for the handful of
expression shapes we use — but then `cronProse` must degrade to the raw
expression rather than mis-describe one (**[A9]**).

### 5.5 What must not change

- Run claiming, lease/fencing, reconciliation, workspace GC.
- Gate semantics: `approvalGate` steps are still decided in the Inbox; neither
  `Start now` nor `Archive` may close a gate. `PATCH /tasks/:id {status: DONE}`
  on a gated template task keeps returning `409`.
- The webhook's 401-for-everything failure surface (batch 2 AC-W4) — a paused
  trigger must not become distinguishable from a wrong secret.
- Secret values: no new route or response field exposes one. `OPERATOR_TOKEN`
  appears in no artifact, fixture, screenshot, or test.
- Batch 4's session pages and task-detail outputs card.

---

## 6. Edge cases and failure behaviour

| # | Case | Required behaviour |
|---|---|---|
| E1 | `GET /tasks/:id/chain` for a task whose `chainId` is set but `chainIndex` is null | Treat as a one-row chain (`1/1`); do not crash. `activateChainSuccessor` already logs this state |
| E2 | Two chains accidentally share a `chainId` across projects | The chain query is scoped by `projectId` as well as `chainId`, matching `activateChainSuccessor` |
| E3 | 200-step chain (pathological template) | The chain card renders the first 50 rows and a `Show all` control; the marker maths is unaffected |
| E4 | `chainProgress` on a list of 500 tasks | Computed once per request from a single grouped query, not N+1 |
| E5 | Trigger with 601 fires | `Fires` is a count query; `Recent fires` is `take: 20` with an index on `(templateId, createdAt)` |
| E6 | `Fire now` while the same trigger is being fired by a webhook | Both succeed; two chains; two ledger rows. `instantiateTemplate` already retries serialization conflicts |
| E7 | Duplicate webhook deliveries arriving in the same millisecond with a replay window set | Both may pass the window check and create two chains — the check is best-effort inside a read-committed transaction, not a distributed lock. Documented, accepted at dogfood scale (**[A10]**) |
| E8 | `Archive All` while a Done task is being retried by someone else | The archive query skips tasks with an active run and returns `{ archived, skipped }`; the UI reports `Archived 6, skipped 1 (running)` |
| E9 | Archived task is a chain gate awaiting an Inbox decision | Archiving a task in `REVIEW` with an open gate is refused: `409 "Decide the approval gate in the Inbox first"` |
| E10 | `cronstrue` throws on a valid-to-`cron-parser` expression | Render the raw expression; never render the exception |
| E11 | Automation whose fired copies were all deleted | `Last run: Never`; expanded row shows `No sessions yet` |
| E12 | API is down / 500 on any new endpoint | Existing `ErrorNotice` + `onRetry` pattern; the board still renders from its own poll |
| E13 | A trigger's template has zero steps | It cannot be fired (`instantiateTemplate` throws `Template has no steps`); the detail page shows the reason inline and `Fire now` returns `400` |
| E14 | Task deleted while its chain card is open | The next poll drops the row; a `404` on `GET /tasks/:id` shows the existing error page |
| E15 | Board drag onto the same column | No PATCH (existing guard, line 279) |
| E16 | `Backlog` count when every task is archived | `0`, empty-state `Drop tasks here` |

---

## 7. Test expectations

Green means: `npm run build` at the repo root, then the full suite
(`npm test --workspaces` / the per-package `node --import tsx --test` commands
already wired up), including the real-Postgres `*.dbtest.ts` set.

**Pure unit (web, no DOM):**
1. `chainProgress` — nine-step chain at various completion points; sparse
   `stepIndex`; all-done; single row; empty.
2. `positions` — sparse indices map to 1..m in `chainIndex` order.
3. `startable` — the seven conditions of §4.3, one test each.
4. `cronProse` — a valid expression, an expression `cronstrue` rejects
   (fallback), and a null timezone.
5. `automationState` — active / paused / quarantined.
6. Marker formatting — `4/9 · Implementation · doing`, and no marker for a
   chain-less task.

**Render (web, jsdom, existing `src/tests` harness):**
7. Chain card renders m rows, one lock icon per gated step, the `title`
   attribute text verbatim, and `You are here` on exactly one row.
8. Board renders five columns in order; a `BACKLOG` task lands in the first.
9. Source pills: `cron` and `webhook` render, `manual` renders nothing.
10. `Archive All` is absent when `Done` is empty, present when it is not.
11. Triggers detail shows a `required` badge only for variables lacking both a
    mapping and a default, and renders no secret value anywhere in the DOM.

**API unit:**
12. Chain assembly from a fixture row set: ordering, position numbering,
    `startable` flags, human steps.
13. `archive-done` selection logic: only DONE, only unarchived, skips active runs.

**API dbtest (real Postgres):**
14. `GET /tasks/:id/chain` over a seeded nine-step instantiation.
15. `POST /tasks/:id/start` — happy path, double-press, human step, archived
    assignee, exhausted budget, `BACKLOG` → `TODO`.
16. `POST /tasks/:id/archive` / `unarchive` / `archive-done`, and `GET /tasks`
    default-excludes archived.
17. **`activateChainSuccessor` with a `BACKLOG` successor terminates** and parks
    with the activity row — a regression test with a timeout, because the failure
    mode is an infinite loop (§5.3).
18. Same with an archived successor.
19. Webhook replay: two identical deliveries inside the window → one chain, one
    ledger row, second response `200 {duplicate:true}`; outside the window → two.
20. Paused trigger → `401`, no ledger row, byte-identical body to a wrong-secret
    response.
21. `POST /task-templates/:id/fire` — exactly one `QUEUED` run across the whole
    new chain, one `MANUAL` ledger row; unresolved variables → `400`.
22. Schedule pause/resume: paused cron task is not fired by `schedulerTick`
    across a simulated due time; resume recomputes `runAt` into the future.
23. Migration test (`migration.dbtest.ts` precedent): after migrate, a task with
    only scheduler activity has `source = 'cron'` and a resolved
    `recurringSourceTaskId`; a webhook-created task has `source = 'webhook'`;
    everything else is `manual`.

**Not required:** visual regression, screenshot harnesses, load tests.

---

## 8. Reviewer verification (how a human checks this works)

> **Hard rule, restated because this batch touches task state:** never start a
> second control plane against the live database or a copy of it — the second
> reconciler classifies the live runs as orphans and deletes their workspaces.
> Browse the live API on `:3000`, or build a scratch database from migrations
> with fixture rows only.

1. `npm run build` at the root; then the full test suite. Both green, output
   pasted into the review.
2. **Chain view** — open a real nine-step chain task. Nine rows, correct step
   names and agents, lock on the gated steps, the open task highlighted,
   `Start now` only on unstarted agent steps. Hover a lock: the tooltip reads
   `requires approval before unblocking dependents`.
3. **`n/m` under skipping** — instantiate a template with 3 steps (sparse
   `stepIndex`), complete one, and confirm the board card reads `1/3`, not
   `1/9` and not `1/max(index)`.
4. **`Start now`** — press it on step 6 of a stalled chain; exactly one run
   appears in that task's Runs table; press again immediately and get the 409
   error surface, not a second run.
5. **Fire now** — on the Triggers detail page, press it. Exactly one new chain;
   `SELECT count(*) FROM "Run" WHERE "taskId" IN (chain)` = 1; the fire is the
   first row of `Recent fires` within one poll.
6. **Replay window** — set 300, `curl` the same payload twice; the second
   response is `200 {"duplicate":true,...}` and no second chain exists.
7. **Pause** — pause the trigger, `curl` with the correct secret, get `401`;
   confirm the body is identical to a wrong-secret call. Enable, `curl` again,
   get `201`.
8. **Automations** — the cron prose matches the expression; pause, confirm no
   fire across at least one scheduled occurrence; resume, confirm `runAt` is in
   the future; expand a row and see recent copies with run statuses.
9. **Archiving** — press `Archive All` on `Done`: the column empties, the
   `Archived` tab lists exactly those tasks, and `GET /tasks?projectId=…` no
   longer returns them. Unarchive one and watch it return to `Done`.
10. **Backlog safety** — drag a running task to `Backlog` (refused with a
    message); drag a never-run chain step there, complete its predecessor, and
    confirm the API process stays responsive (the parked-successor path, not a
    hang) and the activity row explains the park.
11. **Secret hygiene** — grep the built bundle and every new test fixture for the
    webhook secret value and for `OPERATOR_TOKEN`: zero hits.

---

## 9. Rollback notes

Deploy order: migrate, then API, then web. The API is additive except the
`GET /tasks` archived default, so an old web bundle against the new API keeps
working (it simply never sees archived tasks — which it also never showed).

**Rolling back code only** (no schema revert) is the recommended path and is
safe: the new columns are all nullable or defaulted, `TriggerFire` is an
append-only ledger nothing else reads, and the old code ignores every one of
them. The single exception is `TaskStatus.BACKLOG`: old code has no such enum
member, so **before** rolling the API back, run

```sql
UPDATE "Task" SET status = 'todo' WHERE status = 'backlog';
```

otherwise Prisma throws on deserializing those rows. The plan step must ship
this statement as a documented runbook line, not as folklore.

**Rolling back the schema** — in reverse order:

1. `DROP TABLE "TriggerFire"; DROP TYPE "TriggerFireSource";`
2. `ALTER TABLE "TaskTemplate" DROP COLUMN "webhookPausedAt", DROP COLUMN "webhookReplayWindowSec";`
3. `ALTER TABLE "Task" DROP COLUMN "source", DROP COLUMN "archivedAt", DROP COLUMN "schedulePausedAt", DROP COLUMN "recurringSourceTaskId";` then `DROP TYPE "TaskSource";`
4. `TaskStatus`'s `backlog` value **cannot be dropped** by `ALTER TYPE` in
   Postgres. Removing it requires recreating the type
   (`CREATE TYPE "TaskStatus_old"` → `ALTER TABLE ... USING` → `DROP TYPE`) with
   the `UPDATE` above run first. Because that is a rewrite of a hot table, the
   accepted rollback is to **leave the enum value in place** and revert only the
   code; a stray unused enum value is harmless.

Data loss on rollback: archive state, source attribution, pause flags, and the
fire ledger. All are observability, none is required to run a chain — the
chains themselves and their runs are untouched by every rollback path.

---

## 10. Assumptions

Each is the simplest reading of an ambiguous point; each is cheap to reverse in
the plan step if Leo disagrees. Roughly by weight.

- **[A1] Displayed step index is the 1-based ordinal within the chain, not
  `chainIndex`.** The seeded template uses `stepIndex` 1..9, but a skipped-step
  template may use 1/5/9, and showing "step 9 of 3" is worse than renumbering.
  `chainIndex` is still available on the row for debugging.
- **[A2] "Status" in the kanban marker is the `TaskStatus`**, not the active
  run's status. `4/9 · Implementation · doing` says the step is executing;
  whether its run is `RUNNING` or `QUEUED` is one click away.
- **[A3] "Current step highlighted" = the task you are looking at.** On task
  detail, the useful highlight is "you are here"; the chain's own active step is
  legible from the status pills.
- **[A4] Triggers table `Target` = the webhook repo name + step count.** The
  original's `Target` column is a template pointer, and our trigger *is* a
  template, so the name column already carries that; the repo is the missing
  information.
- **[A5] `Fire now` works on a paused trigger.** Pause means "stop trusting the
  outside world", not "stop the operator". If Leo wants pause to be absolute,
  it is a two-line guard.
- **[A6] Dragging a task out of `Backlog` into `Todo` does not enqueue a run.**
  Column moves have never started work; `Start now` is the explicit verb.
- **[A7] The `Archived` tab caps at 200 rows** with a footer saying so, rather
  than paginating. Dogfood volume does not justify a pager yet.
- **[A8] `MANUAL` tasks get no source badge.** Most tasks are manual; a badge on
  every card is noise. Only `cron` and `webhook` are marked.
- **[A9] `cronstrue` is added as a web dependency.** One small MIT package
  against hand-rolling English cron prose; the fallback path (raw expression) is
  specified either way.
- **[A10] The replay window is a best-effort check, not a lock.** Two byte-identical
  deliveries in the same millisecond can both create chains. Real webhook
  retries are seconds apart.
- **[A11] `Recent fires` and `Recent sessions` are capped at 20 and 5** rows
  respectively, newest first, with no "load more".
- **[A12] Archiving is refused for tasks with an active run and for `REVIEW`
  tasks with an open gate** — archiving must never be a way to lose a decision.

## 11. Open questions (recorded, not blocking — this step never calls `inbox_ask`)

- **O1** — Should the `Archived` tab also list archived *chains* as a unit (one
  row per chain) rather than one row per task? With nine-step chains, archiving a
  finished chain produces nine rows. This spec keeps one row per task (simplest);
  a chain-grouped Archived view is a natural follow-up if it reads badly.
- **O2** — `+ New Trigger` has nowhere to go until template creation exists in
  the UI (long-tail Templates batch). Until then the Triggers tab configures
  existing templates only. Confirm that is acceptable for dogfood.
- **O3** — A `CRON` task dragged into `Backlog` stops firing (the scheduler
  filters `status: TODO`), but the Automations tab would still call it `Active`.
  This spec renders it as `Active` with a muted `in Backlog` note. The alternative
  — treating `Backlog` as a third pause mechanism — was rejected as two ways to
  say one thing.
- **O4** — Whether `Fires` should count manual fires. This spec counts them (they
  are fires and they appear in `Recent fires` with a `manual` pill). If the
  number is meant to be "external traffic", the query gains one predicate.

## 12. Deliberately not done here (follow-ups)

- Chain-grouped board cards (one card per chain instead of nine) — contradicts
  the flat-chain ruling and the brief's card marker decision.
- A cron expression builder, `Available in all projects`, due dates.
- Fire payload inspection (storing the request body on `TriggerFire`) — useful
  for debugging webhooks, but it stores third-party data we have no retention
  policy for.
- Notifications on trigger failure (an inbound fire that 400s is invisible
  outside logs). Worth a backlog line once a real external source exists.
