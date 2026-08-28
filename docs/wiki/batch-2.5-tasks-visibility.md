# Batch 2.5 — tasks visibility

Status: current.

This page describes the current task-visibility surface: chain inspection and
manual release, computed cross-chain blocking, the five-column board, task
archiving, recurring automations, and webhook triggers. The main implementation
is in [`packages/db/prisma/schema.prisma`](../../packages/db/prisma/schema.prisma),
[`packages/db/src/workflow.ts`](../../packages/db/src/workflow.ts),
[`packages/api/src/chain.ts`](../../packages/api/src/chain.ts),
[`packages/api/src/board.ts`](../../packages/api/src/board.ts),
[`packages/api/src/app.ts`](../../packages/api/src/app.ts),
[`packages/api/src/scheduler.ts`](../../packages/api/src/scheduler.ts), and the
pages and pure modules under [`apps/web/src`](../../apps/web/src).

## The task model

`TaskStatus` now includes `BACKLOG`, ordered on the board as
`BACKLOG → TODO → DOING → REVIEW → DONE`. Backlog means that the runner must
not claim the task. Moving a task into or out of Backlog changes status only;
it never queues work. `Start now` is the explicit release operation.

Tasks also carry four pieces of provenance/lifecycle state:

- `source` is `MANUAL`, `CRON`, or `WEBHOOK`. Ordinary tasks and recurring
  definitions are `MANUAL`; scheduler-created copies are `CRON`; tasks from an
  inbound template fire are `WEBHOOK`.
- `archivedAt` hides finished work from the normal task list while retaining
  the task, chain, runs, activity, and outputs.
- `recurringSourceTaskId` links a CRON copy to its definition. `schedulePausedAt`
  pauses future CRON occurrences without changing copies that already fired.
- `dispatchAfterTaskId` is a nullable, one-to-one pointer on a bound chain's
  first Task. It names the predecessor terminal task whose server-owned
  completion may dispatch the chain; it is a dependency pointer, not a new task
  status or source value. Existing rows remain null unless explicitly bound.

The schema also contains `TaskTemplate.webhookPausedAt` and
`webhookReplayWindowSec`, and the append-only `TriggerFire` ledger. The Batch 2.5 source/webhook schema
change is applied in two migrations: the PostgreSQL enum value is added first,
then the remaining columns, indexes, relation, and ledger are added. Historical
rows are attributed by the idempotent
[`backfillTaskSource`](../../packages/db/src/task-source.ts) operation and its
[`db:backfill-task-source`](../../packages/db/prisma/backfill-task-source.ts)
runner. Backfilled fire ids carry a durable `backfill:` prefix, so a selective
observability rollback cannot delete live webhook ledger rows.

Deploy and rollback ordering, including the Backlog enum trap and webhook
ingress precautions, lives in
[`docs/runbooks/batch-2.5-rollback.md`](../runbooks/batch-2.5-rollback.md).

## Chains and the task detail view

### Assembly rules

The API treats a chain as `(projectId, chainId)`, not just `chainId`. This is
important because the database does not enforce a globally unique chain id.
`packages/api/src/chain.ts` is the shared, plain-row implementation used by
the task list, the detail endpoint, and trigger-fire history:

- `chainProgress` counts rows and DONE rows. Archived rows remain in both
  counts, so archiving a completed step does not make a chain appear shorter.
  The active step is the lowest-index non-DONE row, or the last row when all
  rows are DONE. Its displayed status is the `TaskStatus`, lowercased.
- `positions` assigns 1-based ordinals after sorting by `chainIndex`. The raw
  index is not displayed, so sparse template indices still read `1/3`, not
  `1/9`.
- A row with a chain id and a null `chainIndex` is treated as a one-row chain.
  The detail endpoint returns `1/1`; the list response uses the same singleton
  rule. It is not allowed to shift the positions of valid sibling rows.
- Progress maps are keyed by `(projectId, chainId)`. The global task-list poll
  therefore cannot borrow progress from a project that happens to reuse the
  same chain id.

`GET /tasks` excludes archived tasks by default. It accepts `archived=false`,
`archived=true`, or `archived=all`. With enrichment enabled it computes chain
progress from the returned chains plus one scoped chain-row query and computes
recurring last-fire summaries with one grouped query; it does not issue one
query per task. The Projects page passes `enrich=false` because it only needs
task counts. `GET /tasks/:taskId/chain` assembles the complete surviving chain,
including archived rows, and uses one grouped run query to calculate the facts
needed by `startable`.

A bound chain's first task also exposes a computed `blockedOn` object while its
predecessor is not `DONE`. Chain detail returns `{ taskId, name, status }` on that
step only; the value is null for unbound chains and disappears after the
predecessor reaches `DONE`. The route resolves the pointer with one additional
lookup only when the first task carries a binding. The marker is derived from
current predecessor status and is never stored as a task status or a new chain
column.

### Start now and parked successors

The chain response includes the API's `startable` decision. A step is startable
only when it is an agent step with a non-archived agent and a repository, is
unarchived, is `TODO` or `BACKLOG`, has no active run, is below its run budget,
and has both its in-chain predecessors and any dispatch predecessor resolved.
For the new task-visibility guards, an active run means `QUEUED`, `CLAIMED`,
`PROVISIONING`, `RUNNING`, or `WAITING_INBOX`; a waiting Inbox decision is still
live work.

A bound first task is inert while `blockedOn` is non-null: it has status `TODO`
and no Run. `POST /tasks/:taskId/start` takes the chain-row lock and returns
409 naming the bound predecessor instead of releasing it manually. The generic
status PATCH uses the same locked fact and refuses moving an unresolved bound
first task from `TODO` to `DOING`, `DONE`, or another status, so a status write
cannot bypass dispatch. After the predecessor is `DONE`, the marker clears and
the normal start/dispatch rules apply.

`POST /tasks/:taskId/start` rechecks the remaining startability facts and creates
the next run in the same transaction. A successful Backlog start changes the
task to `TODO`. A stale or invalid click receives the specific `409`/`400`
reason instead of creating an out-of-order run or leaking a server error.
Double-presses are serialized by the row lock and leave one run.

`activateChainSuccessor` in `packages/db/src/workflow.ts` refuses to enter its
compare-and-set loop when the successor is archived or in Backlog. It records
an explanatory activity and returns, leaving the successor parked. A parked
ordinary successor can later be released with `Start now`; a successor with an
archived assignee is parked in `REVIEW` with a failure reason. A bound successor
is different while its predecessor is unresolved: it cannot be manually
released. Automatic dispatch is performed only by terminal completion of the
predecessor chain; after the predecessor is `DONE`, a still-TODO successor can
also use the normal manual-start path. If bound dispatch finds a successor
that is no longer queueable, it parks that successor with an explicit reason;
after fixing the condition, an operator must set it back to `TODO` and use
`Start now`. Human successors reached
from a successful run still use the Inbox approval gate, and gate decisions
remain the only way to advance a gate task.

The chain card in
[`components/chain-list.tsx`](../../apps/web/src/components/chain-list.tsx)
shows the API's rows and `n/m` count, highlights exactly the open task with
`You are here`, shows one lock per approval-gated row, and renders the gate
tooltip `requires approval before unblocking dependents`. It renders the first
50 rows of a pathological chain and then offers `Show all`. It shows parked,
archive, and bound-predecessor reasons beneath the step name. A bound first step
renders the blocked-on marker and a disabled Start control while the API reports
it unresolved; ordinary rows with no marker retain their existing controls. The
component never recomputes the API's startability decision in the browser.

## Board, tabs, and archiving

The Tasks navigation owns four sibling routes: `/tasks`, `/automations`,
`/triggers`, and `/archived`; `/triggers/:templateId` is the trigger detail
route. All four tab pages use `TasksPageHead`, which owns the project subtitle,
`Create Task` action, and the tab bar. The sidebar highlights one Tasks item
for all of these routes.

The board in [`pages/Tasks.tsx`](../../apps/web/src/pages/Tasks.tsx) renders
`Backlog`, `Todo`, `Doing`, `Review`, and `Done` in that order. Cards show one
API-provided chain marker (`n/m · active step · task status`), a computed
`Blocked on: <predecessor>` line when a bound first task is waiting, a `cron`
pill for CRON copies, and a `webhook` pill for webhook-created tasks. Manual
tasks have no source pill. Same-column drops are ignored; all other drops are
status PATCHes and do not enqueue a run. The board projection deduplicates the
binding ids on the current page and performs no predecessor lookup for an
unbound page, or one lookup for a page containing bindings.

`Archive` is available from a card and task detail. The API locks the task,
refuses archiving when any active run exists, and refuses a `REVIEW` task with
an open approval gate. `Archive All` locks the candidate DONE rows in id order,
rechecks project/status/archive state, excludes rows with active runs, and
returns `{ archived, skipped }`. The board reports a skip as
`Archived n, skipped m (running)`. This makes archive-vs-retry and concurrent
Archive All operations deterministic rather than a stale read followed by a
blind update.

Status writes, `Start now`, retry, archive, and scheduler AT firing share the
Task-row mutex. An archived task's status is frozen until it is unarchived, and
retrying an archived task returns `409`. CRON uses a row compare-and-set for
the same exclusion boundary. The result is that no new run can be left queued
under a task the runner is forbidden to claim.

The Archived page requests `archived=true`, sorts newest first, shows the
chain marker and an Unarchive action, and caps the visible window at 200 rows.
Unarchive restores the task to its saved status column. A 404 after a task was
previously loaded is authoritative on task detail: `fatal()` drops stale data
for deletion, while transient non-404 errors retain the last good page and
use the existing retry notice.

## Automations

An automation is a non-archived task with `scheduleKind=CRON`. The scheduler
accepts exactly five cron fields and an optional IANA timezone. It stores the
next `runAt`; macros, six-field expressions, invalid timezones, and malformed
expressions are rejected. A malformed stored expression is quarantined by
clearing `runAt` and writing a scheduler activity, rather than deleting the
definition.

The scheduler's poll is only a hint. The CRON fire is a Task-row compare-and-set
that checks `status=TODO`, `schedulePausedAt IS NULL`, `archivedAt IS NULL`,
and the observed `runAt`. An AT fire locks and re-reads the task, requires
`TODO`, unarchived state, and zero existing runs, then enqueues exactly one
run. This closes the race where an archived or already-fired task was present
in a stale poll result.

Each CRON occurrence creates an independent one-shot task. The copy has
`source=CRON`, points to the definition with `recurringSourceTaskId`, clears
schedule/chain/template fields, and queues one run when it has an agent and
repository. The recurring definition remains `MANUAL`; human copies remain
without a run. The definition and copy receive activity metadata identifying
the definition and fire time.

`POST /tasks/:taskId/schedule/pause` stops future occurrences but leaves
in-flight copies alone. Resume validates the expression and recomputes the
next `runAt` from the current time, so a long pause does not create a catch-up
burst. A CRON task moved to Backlog also stops firing because the scheduler
only selects TODO definitions; the Automations page continues to show its
schedule as Active and adds `in Backlog` so this deliberate distinction is
visible.

`GET /tasks/:taskId/recurring-fires?take=5` returns the newest five copies and
their latest run/session summary. If all copies were deleted, it returns an
empty list and the expanded row says `No sessions yet`. The task-list response
also carries `recurringLastFiredAt` and `recurringFireCount`, so collapsed
automation rows can show Last run without an N+1 poll.

The Automations page has an inline plain-text cron/timezone editor. It relies
on the API for validation and displays a live prose preview. A quarantined row
renders the raw cron expression, not potentially misleading prose from a
formatter that accepts a different grammar. The three visible states are
Active, Paused, and Quarantined.

## Triggers and fire history

Triggers are existing templates with a configured webhook secret. The list
route is `GET /projects/:projectId/triggers`; detail and fire history use
`GET /triggers/:templateId` and `GET /triggers/:templateId/fires?take=20`.
Pause/enable use `/triggers/:templateId/pause` and `/enable`; operator firing
intentionally remains at `POST /task-templates/:templateId/fire`.

The list and detail queries use explicit public field selections. They return
secret names, disabled state, repository metadata, variable mappings, fire
counts, and last-fire time, but never a secret value or ciphertext. The fires
query uses the `(templateId, createdAt)` index and a bounded newest-20 read.
Chain lookup for fire history is scoped to the template's project and keyed by
the same `(projectId, chainId)` identity. A deleted chain is represented as
`chain deleted` rather than causing the history request to fail. Fire counts
include both webhook and manual fires.

### Inbound webhook

`POST /hooks/templates/:templateId` accepts a JSON object up to 1 MiB and the
`X-AgentOS-Webhook-Secret` header. Wrong, missing, disabled, unconfigured, and
paused credentials all return the same `401` response and create no rows.
Variable mapping resolves scalar payload values through dotted paths; scalar
defaults are supported, but an empty-string default is treated as absent. An
empty string supplied by the payload itself is still a scalar value. Invalid
JSON, a non-object body, an unresolved variable, and an over-limit body return
client errors.

When `webhookReplayWindowSec` is positive, the dedupe key is
`X-AgentOS-Delivery-Id`, falling back to the SHA-256 of the raw request body.
A matching fire for the same template inside the window returns
`200 { duplicate: true, chainId }`. A real fire instantiates the chain and
writes one `TriggerFire` row in the same Serializable transaction, so a chain
that is rolled back has no corresponding ledger row. The transaction retries
bounded serialization/unique conflicts with a fresh chain id.

The replay check is deliberately best effort, not a distributed lock. Two
identical deliveries arriving in the same millisecond can both pass the read
and create two chains. Disable the window to retain the prior behavior where
every authenticated delivery is a new fire.

### Fire now

`Fire now` is an operator action and works even while the trigger is paused.
It resolves body variables over configured defaults and creates a `MANUAL`
fire ledger row in the same chain transaction. A template with no steps, or a
trigger without a configured repository, is shown as un-fireable and returns
`400` to direct callers. Unresolved variable names are included in the error
prose because the web error parser retains that top-level message.

The webhook repository relation is `onDelete=Restrict`; a referenced
repository cannot be deleted. Clearing the configuration is the reachable
missing-repository state, and it is listed with `canFire=false` rather than
silently omitted.

The trigger detail page displays a short endpoint form, but its Copy action
resolves a relative API base against the page origin so an external system gets
an absolute URL. Variable rows show `required` only when both mapping and
default are absent. The recent-fire table shows source pills, first task,
chain progress, and the bounded history; no secret value is present in the
DOM.

## Non-obvious constraints

- The Task row is the mutex for lifecycle decisions. Poll results are stale;
  only the lock/CAS inside the writer transaction is authoritative.
- `WAITING_INBOX` is included in the new active-run set even though older retry
  logic has a narrower historical check. Do not use the lease-holding set as a
  substitute: it answers a different question.
- The Backlog successor check must run both before the CAS loop and after every
  failed CAS re-read. The second check is what handles an operator parking a
  successor between the first read and claim.
- Chain progress and `blockedOn` are intentionally API-owned. The web marker
  only formats the API's values; adding a second arithmetic or predecessor-state
  implementation risks disagreeing with archived-row and sparse-index
  semantics. `blockedOn` is computed state, not a status, board column, or lane.
- The two trigger base paths are intentional for this surface. A future route
  cleanup must preserve clients of both the public webhook endpoint and the
  operator fire action.
- The current task list's archived default also affects project task counts,
  because both project pages use the same endpoint. Use `archived=all` only
  when archived work is explicitly needed.

## Deliberate boundaries and deferred work

The following are current decisions, not missing implementation:

- Archived is one row per task, not one row per chain, and is capped at 200.
- `Create Task` exists on all four task tabs, but there is no template-creation
  or `+ New Trigger` workflow; Triggers configures existing templates.
- Pause means “stop external webhook traffic”; an operator may still use Fire
  now. A CRON task in Backlog is still labelled Active with an explicit note.
- Manual fires are included in Fires and Recent fires. Only CRON and WEBHOOK
  sources receive board pills.
- Cross-chain bindings and per-instantiation assignee overrides are API-only;
  the web app displays the resulting blocked-on state but does not compose either
  `afterTaskId` or `stepOverrides`.
- No cron builder, cross-project template availability, due-date surface,
  request-payload retention, or failure notification exists here.
- A successor parked in REVIEW because its assignee is archived has no dedicated
  release button yet; unarchive the agent, set the task back to `TODO`, and use
  `Start now`. Bound dispatch has no separate retry endpoint, and an unresolved
  binding remains blocked until its predecessor is `DONE`.
- Same-millisecond replay duplicates remain accepted. A future distributed
  idempotency design would need a stronger database contract than this window
  check.

## Verification boundary

The final code and schema were verified with:

```text
npm run typecheck
npm run build
npm test
npm run test:db -w @agentos/api
npm run db:drift-check
```

The real-Postgres DB suite covers chain assembly, null-index and cross-project
scoping, bound predecessor blocking and start/status guards, terminal dispatch,
parked successors, start/archive races, archive-vs-scheduler races,
replay-window behavior, paused triggers, manual fire ledger atomicity, and source
backfill. The focused binding/dispatch suites are
`packages/api/src/template-dispatch-binding.dbtest.ts`,
`packages/api/src/dispatch-activation.dbtest.ts`,
`packages/api/src/dispatch-lifecycle.dbtest.ts`, and
`packages/api/src/board-blocked-on.dbtest.ts`; the web suites cover the blocked-on
card and chain-row marker in addition to the chain marker/card, five board
columns, Backlog placement, archive notice, schedule states, endpoint URL,
trigger variable badges, and deletion error handling. The browser pass covers
the board, Archived, Automations, Triggers, trigger detail, task detail, and both
themes.

Start with [`packages/api/src/chain.ts`](../../packages/api/src/chain.ts) when
changing a chain count, position, or startability rule; then check the route
that assembles its input and the corresponding web type. For lifecycle races,
read the Task-row lock helpers in `app.ts`, `workflow.ts`, and `scheduler.ts`
together. For trigger behavior, read `hooks.ts` and `templates.ts` before
changing either the public webhook route or `Fire now`.
