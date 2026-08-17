# Goal 5a0 specification — single-flight and lineage safety kernel

Status: specification for human review; no implementation is authorized by this document

Product Contract: Goal 5a0 v1.1

Contract-version note (round 6, 2026-08-17): the contract moved from v1.0 to v1.1 to carry the merge-authorization and dependency-handoff **evidence and authority mechanics** recorded in `docs/plans/goal-5a0-idempotent-execution-kernel-plan.md` §"Product Contract v1.1 decision" — typed, schema-versioned handoff records; a fail-closed server-bound authorization half; and named implementation dependency D1, which is outside this contract's implementation scope. **No invariant, data contract, transition, acceptance proof, reviewer checklist item, or scope boundary in this specification is changed by that bump**; every section below is carried forward verbatim from v1.0.

Routing Contract: v1.0, Planned Critical, future implementation role `senior-dev`

Author: spec agent, 2026-08-17

This document is the authoritative English behavior and data contract for Goal
5a0. A later plan may choose work-item order, but it must not weaken any
invariant or acceptance proof here. Implementation must not begin until
Control-plane A is merged and this specification is revalidated against the
then-current `master`.

## 1. Problem and audience

AgentOS can persist Goals, Tasks, Runs, Sessions, Definition-of-Done items, and
progress entries, but it does not yet have a durable execution relationship
from Goal to Task. `Run.goalId` and `Session.goalId` are nullable snapshots;
`Task` has no `goalId`; the Goal API does not create Tasks or Runs; and Goal
pause only changes `Goal.status`. The existing Task row lock, `(taskId,
runNumber)` uniqueness, Run lease generation, and fencing token protect one
Task or one claimed Run. They cannot prove that two concurrent Goal routing
attempts create at most one next Task, or that a completion from an earlier
Goal execution cannot advance a restarted Goal.

The feature is for:

- the operator, who must be able to pause, cancel, retry, and restart a Goal
  without hidden duplicate work or ambiguous history;
- the future Goal coordinator, which needs one safe atomic primitive for
  dispatch and terminal decisions;
- runners and the existing Task/Run scheduler, which must continue using their
  current queue, lease, retry, and completion protocol;
- reviewers and operators, who need durable evidence of which Goal generation,
  iteration, Task, and Run caused every transition.

The kernel succeeds when correctness follows from committed PostgreSQL state,
row locks, uniqueness constraints, and fencing predicates. It must not depend
on a process-local `busy` flag, poll ordering, request timing, or an agent
remembering a prior response.

## 2. Scope and authority

### 2.1 In scope

1. At most one open Goal dispatch for a Goal, including while it awaits a
   terminal routing decision.
2. Durable Goal → Task → Run lineage, Goal generation and iteration identity,
   Run retry ancestry, and idempotent request replay.
3. Fencing of late Run completions and late Goal decisions.
4. Atomic initial dispatch, retry creation, successor dispatch, Goal terminal
   decisions, pause, resume, cancel, and restart state changes.
5. Compatibility with current Task creation defaults, Run claiming, lease-loss
   reconciliation, automatic retry, Task status, and runner completion.
6. Additive migration, preflight/backfill, staged rollout, rollback, durable
   audit events, structured operational signals, and executable PostgreSQL
   concurrency tests.
7. Evidence-scoped spend reporting when `Session.costUsd` is unavailable.

### 2.2 Explicitly out of scope

- Implementing this specification or writing the implementation plan in this
  step.
- Inbox messages, Inbox approval integration, waiver UX, and waiver authority.
- Full stuck detection, lifecycle notifications, ready-for-approval messages,
  and completion notifications; those belong to Goal 5a1.
- Selecting the next specialist, evaluating progress, generating DoD content,
  or defining router prompting/model policy.
- Public release work, production data migration, service restart, or enabling
  the feature in production.
- A process-kill transport or runner control channel. Cancellation must fence
  database authority immediately; best-effort process termination may be added
  later without changing that rule.
- Changes to template chains, follow-up chains, CRON/AT scheduling semantics,
  Task approval gates, public APIs unrelated to Goal execution, or provider
  billing estimation.

## 3. Audited current behavior

The implementation plan must refresh these facts after Control-plane A merges.
They describe the tree audited on 2026-08-17.

1. `packages/db/prisma/schema.prisma` has `Goal`, `Task`, `Run`, and `Session`.
   `Run` and `Session` have nullable `goalId`; `Task` does not. `Goal` has no
   generation, iteration cursor, active Task pointer, or execution event ledger.
2. `packages/api/src/app.ts` exposes Goal CRUD, DoD approval, pause, DoD item,
   and progress-log routes. None dispatches a Task or Run. There is no Goal
   resume, cancel, restart, or terminal-decision route.
3. `packages/db/src/workflow.ts::lockTaskRow` serializes Task start/retry/archive
   writers. `enqueueTaskRun` derives `runNumber` from the newest Run and inserts
   a Run with unique `(taskId, runNumber)` and `dedupeKey`.
4. `POST /runner/tasks/claim` uses a serializable transaction and a CAS on
   `(Run.id, status=QUEUED, leaseGeneration)`. It creates a random fencing token.
   Heartbeat, events, publication, start, and completion require the current
   runner ID, fencing token, unexpired lease, and active Run status.
5. Runner completion atomically terminalizes Run and Session, may create an
   automatic retry, and updates Task/chain state. Retry creation and
   lease-loss reconciliation copy `Run.goalId`, but no Goal-level identity or
   single-flight constraint exists.
6. `reconcileDatabaseRuns` marks orphaned leases LOST and may enqueue a new Run.
   It locks the Task row, not a Goal row. API startup runs reconciliation before
   starting the existing CRON/AT scheduler.
7. Existing database tests prove Task-level double-start exclusion, scheduler
   single fire, lease fencing, and several completion/chain CAS races. They do
   not race two Goal dispatches, a Goal restart against an old completion, or
   two retries of the same source Run.
8. `Session.costUsd` is nullable. Therefore `Goal.spendUsd` can at most be a
   subtotal of provider-priced sessions unless coverage is separately shown.

## 4. Canonical domain language

The terms below are normative.

**Goal generation (`goalGeneration`).** A 1-based execution epoch of one Goal.
The first governed execution is generation 1. A Goal restart creates the next
generation. Pause/resume and Run retry do not change it.

**Goal iteration (`goalIteration`).** A 1-based specialist Task position inside
one Goal generation. Exactly one Task owns each `(goalId, goalGeneration,
goalIteration)` tuple. Dispatching a successor increments the iteration.

**Goal dispatch.** The creation of that iteration's Task and first queued Run.
It is one atomic database transition. An open dispatch is either executing or
awaiting a routing decision.

**Run attempt (`runNumber`).** An execution attempt of one Task. A retry creates
a new Run with `runNumber + 1` but retains the same Goal generation and
iteration.

**Run retry parent (`retryOfRunId`).** The terminal Run whose retry produced a
new Run. One source Run may have at most one retry child.

**Lease generation (`Run.leaseGeneration`).** The existing claim-attempt
counter for one Run. It is not a Goal generation or Goal iteration and must not
be renamed or reused for either.

**Terminal Run evidence.** A terminal Run row and its Session evidence accepted
under the current fencing token. A terminal Run does not by itself authorize a
Goal successor; a separate atomic Goal decision does.

**Stale operation.** A completion, retry, decision, or control request whose
expected generation, iteration, source Run, Goal state, dispatch state, or
fencing token is no longer current. A stale operation makes no lineage or
terminal-state mutation.

**Idempotent replay.** Repeating the same logical request returns the already
committed resource and does not create a second Task, Run, event, generation,
or iteration. It is distinct from a conflicting new request, which returns
HTTP 409.

## 5. Safety invariants

All implementation and review choices are subordinate to these invariants.

### I1 — one open dispatch per Goal

Across all generations, a Goal has at most one Task whose
`goalDispatchState` is `EXECUTING` or `AWAITING_DECISION`. This remains true
when the Goal is paused. A PostgreSQL partial unique index is the final
backstop; application checks alone do not satisfy this invariant.

### I2 — immutable identity and complete lineage

For a Goal-linked Task, `(goalId, goalGeneration, goalIteration)` is non-null,
immutable, and unique. Every Run of that Task repeats the identical tuple. A
Goal-linked Run must have a Task, and the database must reject a mismatched
Goal/Task tuple. Manual Tasks and their Runs keep all three Goal lineage fields
null.

### I3 — retry is not a new iteration

Every retry remains on the same Task and Goal tuple. It has the next
`runNumber` and `retryOfRunId` set to the source Run. A unique constraint on
`retryOfRunId` proves that simultaneous retry attempts create at most one
child. Retry never increments `Goal.goalGeneration` or `Goal.nextGoalIteration`.

### I4 — restart is a new generation

Restart is permitted only from a terminal non-completed Goal state. It
atomically increments `goalGeneration`, resets iteration allocation, and
creates generation N+1 iteration 1 with its Task and Run. It never reuses or
edits old lineage. A repeated restart request key returns the same generation,
Task, and Run.

### I5 — current authority is fenced twice

Runner writes retain the existing Run lease/fencing predicate. Goal decisions
also require the expected `(goalId, goalGeneration, goalIteration,
sourceRunId)` and an open Task in `AWAITING_DECISION`. Passing one fence cannot
compensate for failing the other.

### I6 — decision and successor are atomic

A decision that advances an iteration closes the predecessor dispatch and
creates the successor Task and first Run in the same transaction. A terminal
decision closes the dispatch and changes the Goal terminal state in that same
transaction. No committed state may contain a closed decision that claims a
successor was dispatched when the successor Task/Run is absent.

### I7 — committed state is restart-safe

After API or scheduler restart, the database alone identifies the one current
dispatch and every retry ancestor. Startup reconciliation may repair a stale
lease; it must not infer or create a successor Goal iteration. Replaying a
request after a lost HTTP response returns the committed resource.

### I8 — pause and cancel do not leak authority

Pause prevents new Goal-linked Run claims, retries, and decisions, but does not
invalidate an already claimed Run. Cancel terminalizes the Goal's open dispatch,
cancels any queued/active Run, revokes session/fencing authority, and prevents
all later completion or decision side effects.

### I9 — lock order is global

Every transaction that can mutate Goal execution takes locks in this order:
Goal row, then Task row, then Run row(s). It does not acquire them in a different
order on retry, completion, cancellation, reconciliation, or decision paths.

### I10 — audit claims match evidence

Every successful state transition has one durable execution event committed in
the same transaction. Dollar fields are described as known provider-reported
cost, not total spend, whenever any linked Session has `costUsd = null`.

## 6. Exact data contract

The names below are required. A later plan may add Prisma relation field names
needed for compilation, but may not rename persisted columns or weaken their
constraints without revising this Product Contract.

### 6.1 Enum additions

```prisma
enum GoalStatus {
  ACTIVE
  PAUSED
  COMPLETED
  STOPPED_SPEND
  STOPPED_TIME
  STOPPED_STUCK
  FAILED       @map("failed")
  CANCELLED    @map("cancelled")
}

enum GoalDispatchState {
  EXECUTING         @map("executing")
  AWAITING_DECISION @map("awaiting-decision")
  ADVANCED          @map("advanced")
  GOAL_COMPLETED    @map("goal-completed")
  GOAL_FAILED       @map("goal-failed")
  CANCELLED         @map("cancelled")
  MIGRATED_CLOSED   @map("migrated-closed")
}
```

`MIGRATED_CLOSED` is only for pre-kernel history. New runtime code never writes
it.

### 6.2 Goal fields

Add to `Goal`:

```prisma
goalGeneration   Int @default(1)
nextGoalIteration Int @default(1)
tasks            Task[]
executionEvents  GoalExecutionEvent[]
```

Both counters are mutated only while the Goal row is locked. Generation starts
at 1. `nextGoalIteration` is the next value to allocate in the current
generation; after creating iteration 1 it is 2.

### 6.3 Task fields

Add to `Task`:

```prisma
goalId                String?
goalGeneration        Int?
goalIteration         Int?
goalDispatchKey       String?
goalDispatchRequestHash String?
goalDispatchState     GoalDispatchState?
goalDecisionKey       String?
goalDecisionRequestHash String?
goalDecisionRunId     String?
goalDecisionAt        DateTime?
goalPredecessorTaskId String? @unique

@@unique([goalId, goalGeneration, goalIteration])
@@unique([goalId, goalDispatchKey])
@@unique([goalId, goalDecisionKey])
@@unique([id, goalId, goalGeneration, goalIteration])
@@index([goalId, goalDispatchState])
@@index([goalPredecessorTaskId])
```

Relations are `Task.goalId → Goal.id` with `onDelete: Restrict`,
`goalDecisionRunId → Run.id` with `onDelete: Restrict`, and a self-relation from
`goalPredecessorTaskId → Task.id` with `onDelete: Restrict`. A Goal-linked Task
cannot be hard-deleted.

The migration must add these database checks:

1. The Goal tuple and `goalDispatchState` are all null or all non-null.
2. `goalDispatchKey` and `goalDispatchRequestHash` are non-null for every
   Goal-linked Task.
3. `goalDecisionKey`, `goalDecisionRequestHash`, `goalDecisionRunId`, and
   `goalDecisionAt` are all null while state is `EXECUTING` or
   `AWAITING_DECISION`; terminal states require all four, except
   `MIGRATED_CLOSED`, which requires all four null.
4. `goalGeneration >= 0` and `goalIteration >= 1`; generation 0 additionally
   requires `MIGRATED_CLOSED`. Runtime services require generation >= 1 and
   never create generation-0 rows.
5. A predecessor is null for iteration 1 and non-null for iteration > 1.

The database-enforced single-flight index is raw migration SQL because Prisma
cannot express a partial unique index:

```sql
CREATE UNIQUE INDEX "Task_one_open_goal_dispatch_key"
ON "Task" ("goalId")
WHERE "goalId" IS NOT NULL
  AND "goalDispatchState" IN ('executing', 'awaiting-decision');
```

### 6.4 Run fields

Keep existing `Run.goalId` and add:

```prisma
goalGeneration Int?
goalIteration  Int?
retryOfRunId   String? @unique

@@index([goalId, goalGeneration, goalIteration])
@@index([retryOfRunId])
```

`retryOfRunId` is a self-relation with `onDelete: Restrict`. The migration adds
an all-null/all-non-null Goal tuple check and a composite foreign key:

```sql
FOREIGN KEY ("taskId", "goalId", "goalGeneration", "goalIteration")
REFERENCES "Task" ("id", "goalId", "goalGeneration", "goalIteration")
ON DELETE RESTRICT;
```

For a Goal-linked Run, `taskId` is required. Existing unique `(taskId,
runNumber)`, unique `dedupeKey`, `leaseGeneration`, and `fencingToken` remain.
The first Run has `retryOfRunId = null`; every later Run created as a retry has
the immediate source Run ID.

### 6.5 Durable execution events

Add:

```prisma
model GoalExecutionEvent {
  id             String   @id @default(cuid())
  goalId         String
  goalGeneration Int
  goalIteration  Int?
  taskId         String?
  runId          String?
  type           String
  dedupeKey      String   @unique
  metadata       Json?
  createdAt      DateTime @default(now())
  goal           Goal     @relation(fields: [goalId], references: [id], onDelete: Restrict)
  task           Task?    @relation(fields: [taskId], references: [id], onDelete: Restrict)
  run            Run?     @relation(fields: [runId], references: [id], onDelete: Restrict)

  @@index([goalId, createdAt])
  @@index([goalId, goalGeneration, goalIteration])
  @@index([taskId])
  @@index([runId])
}
```

Required event types are `DISPATCH_CREATED`, `RUN_RETRY_CREATED`,
`RUN_AWAITING_DECISION`, `ITERATION_ADVANCED`, `GOAL_COMPLETED`, `GOAL_FAILED`,
`GOAL_PAUSED`, `GOAL_RESUMED`, `GOAL_CANCELLED`, and `GOAL_RESTARTED`.
`dedupeKey` is deterministic from the transitioned resource, for example
`goal:<goalId>:g:<generation>:i:<iteration>:dispatch` and
`run:<sourceRunId>:retry:<childRunId>`. Replays create no second event.
Metadata may contain IDs, statuses, failure class/reason, and request keys; it
must not contain prompts, outputs, access tokens, fencing tokens, secrets, or
provider credentials.

Request hashes are SHA-256 over canonical JSON after validation/defaulting and
before persistence. Object keys are sorted; absent optional fields and their
materialized defaults hash identically. Hashes detect reuse of one idempotency
key for a different operation without storing or echoing prompt bodies.

### 6.6 Spend evidence

No synthetic dollar estimate is added. Goal reads expose this computed shape:

```json
{
  "spendEvidence": {
    "knownProviderCostUsd": "12.3400",
    "pricedSessionCount": 2,
    "unpricedSessionCount": 1,
    "coverage": "partial"
  }
}
```

`coverage` is `complete` only when every linked terminal Session has non-null
`costUsd`; it is `partial` otherwise. `Goal.spendUsd` remains the sum of known
provider-reported dollar values for compatibility. API/UI/log text may call it
“known provider cost” or “known subtotal.” It must not call it “total spend”
when coverage is partial. Token counts may be reported separately and must not
be converted to dollars without provider evidence.

## 7. Transaction and service contract

One shared safety-kernel module owns all Goal-linked Task/Run creation. Existing
routes call it; no route reimplements identity allocation or Run creation
inline.

### 7.1 Initial dispatch

`createInitialGoalDispatch(tx, input)` performs, in one transaction:

1. Lock Goal.
2. If `(goalId, goalDispatchKey)` already exists, return its Task and first Run
   as an idempotent replay before evaluating current state, but only when the
   canonical request hash matches; otherwise return `IDEMPOTENCY_KEY_REUSED`.
3. Require Goal `ACTIVE`, `goalGeneration == expectedGeneration`,
   `nextGoalIteration == 1`, no Task in the current generation, and no open
   dispatch.
4. Validate the assignee, repo grant, and Task configuration exactly as current
   Task creation does.
5. Create an ordinary NOW, AGENT Task with iteration 1, state `EXECUTING`, no
   chain/template/follow-up/recurring identity, and no Task approval gate.
6. Create Run 1 using the existing run-config and branch derivation helpers and
   copy the Goal tuple.
7. Set `nextGoalIteration = 2` and append `DISPATCH_CREATED`.

Any failure rolls back Goal counter, Task, Run, and event together.

### 7.2 Run completion and automatic retry

The current runner completion route retains its Run fencing predicate. For a
Goal-linked Run it additionally locks Goal, then Task, before a terminal write.

- Success, or failure for which no automatic retry is created: terminalize Run
  and Session, update Task to `REVIEW`, set Task dispatch state to
  `AWAITING_DECISION`, and append `RUN_AWAITING_DECISION` in the existing
  completion transaction.
- Retryable failure below the attempt ceiling: terminalize source Run, create
  exactly one child Run with `retryOfRunId = source.id`, keep Task dispatch state
  `EXECUTING`, set Task `DOING`, and append `RUN_RETRY_CREATED` in the same
  transaction. This branch requires the freshly locked Goal to remain `ACTIVE`;
  a paused Goal follows the no-retry branch and awaits a later decision.
- A unique conflict on `retryOfRunId` is resolved by reading and returning the
  existing child. It is not surfaced as HTTP 500.
- Completion of a Run already terminalized, cancelled, or fenced returns the
  existing 409 stale-fencing response and changes no Task, Goal, event, or Run.

### 7.3 Atomic Goal decision

`applyGoalDecision(tx, input)` locks Goal then the iteration Task. It requires:

- Goal is `ACTIVE`;
- expected generation equals `Goal.goalGeneration`;
- Task identity equals expected generation/iteration and state is
  `AWAITING_DECISION`;
- `sourceRunId` belongs to that Task, is its highest `runNumber`, is terminal,
  and has no retry child;
- `goalDecisionKey` is new, unless this is an exact replay.

Before checking current state, an exact `(goalId, goalDecisionKey)` replay
returns the already stored terminal result and, for `dispatch`, the successor
identified by `goalPredecessorTaskId`. If the same key is presented with a
different body digest, it returns `IDEMPOTENCY_KEY_REUSED`.

Actions:

**`dispatch`.** Store decision fields on the current Task, set it `ADVANCED`,
and create iteration N+1 Task plus Run 1 with `goalPredecessorTaskId` pointing
to the current Task. Increment `nextGoalIteration`. If the source Run succeeded,
set the old Task `DONE`; if it failed, keep it `REVIEW` with failure evidence.
Append `ITERATION_ADVANCED`. All writes are one transaction.

**`complete`.** Require the source Run succeeded, `dodApproved = true`, at
least one DoD item exists, and every current DoD item is satisfied under the
then-current DoD schema. Store decision fields, set Task state
`GOAL_COMPLETED`, Task `DONE`, Goal `COMPLETED`, and `Goal.endedAt`. Append
`GOAL_COMPLETED` in one transaction.

**`fail`.** Require a non-empty reason. Store decision fields, set Task state
`GOAL_FAILED`, leave Task `REVIEW`, set Goal `FAILED`, set `endedAt`, and append
`GOAL_FAILED` in one transaction. Failure may be chosen after a successful Run
when the Goal cannot safely continue; the reason makes that judgment explicit.

An exact replay of a decision key returns its prior result. A different key,
source Run, generation, or iteration after a decision returns 409 and creates
nothing.

### 7.4 Manual retry

The canonical retry operation addresses its source explicitly:

`retryGoalTaskRun(tx, { taskId, sourceRunId })`.

It locks Goal then Task, returns an existing `retryOfRunId = sourceRunId` child
as replay, and otherwise requires Goal `ACTIVE`, Task `AWAITING_DECISION`, the
source is the latest terminal failed/timed-out/lost/cancelled Run, no child
exists, and the attempt ceiling permits another Run. It creates the child with
the same Goal tuple, moves Task to `TODO` and `EXECUTING`, and writes one retry
event atomically.

The existing manual-Task retry behavior remains unchanged. Goal-linked retry
must use the canonical source-based operation.

### 7.5 Pause and resume

Pause is quiescing, not cancellation.

- `ACTIVE → PAUSED` is one Goal-row-locked update and event.
- Repeating pause on `PAUSED` is a successful no-op replay.
- A queued Goal Run remains queued. Claim filters exclude it while paused.
- A claimed/provisioning/running Run may finish. Its terminal evidence is
  recorded, but no retry or Goal decision is created while paused. A failure
  that would normally auto-retry instead leaves the Task
  `AWAITING_DECISION`; resume followed by explicit retry/decision is required.
- Resume is `PAUSED → ACTIVE`, preserves generation/iteration, and writes one
  event. Repeating resume on `ACTIVE` is a successful no-op.

### 7.6 Cancel

Cancel locks Goal then the open Task and active Run. It is permitted from
`ACTIVE` or `PAUSED` and atomically:

- sets Goal `CANCELLED` and `endedAt`;
- sets the open Task dispatch state `CANCELLED` and Task status `REVIEW`;
- changes QUEUED/CLAIMED/PROVISIONING/RUNNING/WAITING_INBOX Runs of that Task to
  `CANCELLED`, sets `endedAt`, clears leases, and revokes session tokens;
- changes matching Sessions to `CANCELLED` and records the operator reason;
- appends `GOAL_CANCELLED`.

When an open Task exists, cancellation fills its decision fields with the
deterministic key `cancel:<goalId>:g:<generation>:i:<iteration>`, the canonical
cancel-request hash, and the latest Run ID. This satisfies the same immutable
terminal-decision audit contract as router decisions without accepting a
runner fencing token from the operator.

Repeated cancel on `CANCELLED` returns the existing terminal state without a
second event. If there is no open Task, cancelling an active Goal still
terminalizes the Goal and writes the event. A runner process may continue
briefly, but every later heartbeat/event/publication/completion loses its fence
and returns 409. No cancelled Task or Run is deleted.

### 7.7 Restart

Restart is one atomic “new generation + first dispatch” operation. It is
allowed from `FAILED`, `CANCELLED`, `STOPPED_SPEND`, `STOPPED_TIME`, or
`STOPPED_STUCK`; `PAUSED` must use resume, and `COMPLETED` cannot be restarted.

The route body includes `expectedGeneration`, a globally stable
`goalDispatchKey` scoped to the Goal, and the first Task definition. Under the
Goal lock it:

1. returns the Task/Run already carrying that dispatch key if this is a replay;
2. otherwise requires the expected current generation and allowed status;
3. increments Goal generation, sets it `ACTIVE`, clears `endedAt`, creates
   iteration 1 Task/Run in `EXECUTING`, sets `nextGoalIteration = 2`, and appends
   `GOAL_RESTARTED` plus `DISPATCH_CREATED` in the same transaction.

Old Tasks and Runs remain immutable history. Their completions and decisions
fail the generation/state fences.

`goalDispatchKey` and `goalDecisionKey` are trimmed opaque strings of 1–200
characters. Clients generate stable, high-entropy values and reuse them until
they receive a definitive response. A matching key with a different canonical
request hash is never treated as replay.

## 8. HTTP API contract

All routes remain operator-authenticated unless the existing principal policy
requires a stricter internal principal. No route accepts a fencing token in a
Goal control body.

### 8.1 Create initial dispatch

`POST /goals/:goalId/dispatches`

```json
{
  "expectedGeneration": 1,
  "goalDispatchKey": "client-stable-key",
  "task": {
    "name": "Implement phase 1",
    "description": "Self-contained agent brief",
    "assigneeAgentId": "...",
    "repoId": "...",
    "workingDirectory": null,
    "targetBranch": null,
    "opensPullRequest": true
  }
}
```

Task limits omitted from the body copy the Goal's `maxDurationMin`,
`stallTimeoutMin`, and `maxSessionsPerTask`. Response is 201 with
`{goalId, goalGeneration, goalIteration, taskId, runId, runNumber}`; exact
replay is 200 with the same IDs and `replayed: true`.

### 8.2 Atomic decision

`POST /goals/:goalId/iterations/:goalIteration/decision`

```json
{
  "expectedGeneration": 1,
  "sourceRunId": "...",
  "goalDecisionKey": "client-stable-key",
  "action": "dispatch",
  "reason": "Run succeeded; the next DoD phase is now unblocked",
  "nextTask": { "name": "Review phase 1", "description": "...", "assigneeAgentId": "...", "repoId": "..." }
}
```

`nextTask` is required only for `dispatch`; `reason` is required for `fail` and
stored for every action when supplied. Created successor returns 201; complete
or fail returns 200; exact replay returns 200 with the original result.

### 8.3 Controls

- Existing `POST /goals/:goalId/pause` adopts §7.5 idempotent semantics.
- Add `POST /goals/:goalId/resume`.
- Add `POST /goals/:goalId/cancel` with
  `{expectedGeneration, reason}`.
- Add `POST /goals/:goalId/restart` with the same Task payload and dispatch-key
  semantics as initial dispatch.
- Add canonical `POST /tasks/:taskId/runs/:sourceRunId/retry` for explicit,
  idempotent retry. Preserve `POST /tasks/:taskId/retry` for manual Tasks. For a
  Goal-linked Task, the compatibility route resolves the latest terminal Run
  and delegates; if its retry child is already active, it returns that child as
  replay rather than creating another.

### 8.4 Reads

- Goal list/detail responses add `goalGeneration`, `nextGoalIteration`, the
  open dispatch summary, and `spendEvidence`.
- `GET /goals/:goalId/lineage` returns generations and iterations ordered
  ascending, each with Task identity, dispatch/decision fields, and Runs ordered
  by `runNumber` including `retryOfRunId`. It never infers lineage from event
  timestamps.
- `GET /goals/:goalId/execution-events?after=<eventId>&limit=<1..500>` returns
  durable events in `(createdAt,id)` order.

### 8.5 Errors

Expected conflicts never surface as 500. Use:

```json
{
  "error": "Goal decision is stale",
  "code": "STALE_GOAL_DECISION",
  "current": {
    "goalGeneration": 2,
    "goalIteration": 1,
    "goalStatus": "active",
    "goalDispatchState": "executing"
  }
}
```

Required 409 codes are `GOAL_NOT_ACTIVE`, `GOAL_ALREADY_COMPLETED`,
`GOAL_DISPATCH_IN_FLIGHT`, `STALE_GOAL_GENERATION`, `STALE_GOAL_ITERATION`,
`STALE_GOAL_DECISION`, `RUN_NOT_RETRYABLE`, and `RUN_RETRY_IN_FLIGHT`.
`IDEMPOTENCY_KEY_REUSED` is also 409.
Validation/project/assignee/repo-grant failures retain current 400/404 behavior.
Database P2002 errors are classified by constraint name into replay or one of
these conflicts.

## 9. Scheduler, runner, and existing Task compatibility

1. A Goal dispatch creates a normal NOW Task and QUEUED Run. The existing runner
   daemon claims and executes it; there is no second Goal-only queue.
2. `POST /runner/tasks/claim` adds this condition: a manual Run (`goalId IS
   NULL`) follows current behavior; a Goal Run is claimable only when its Goal
   is `ACTIVE`, its Task state is `EXECUTING`, and its stored Goal tuple matches
   the Task.
3. The CRON/AT scheduler never creates Goal-linked Tasks. Public Task creation,
   templates, recurring copies, and chain activation cannot set Goal lineage
   fields. Only the safety-kernel module can.
4. Every existing Run-creation path must preserve the all-null/manual or exact
   Goal tuple rule. Goal-linked paths are initial dispatch, decision successor,
   manual retry, automatic completion retry, and lease-loss requeue.
5. Lease-loss reconciliation locks Goal before Task for Goal-linked Runs,
   terminalizes the lost Run, and creates at most one retry child using
   `retryOfRunId`. Re-running reconciliation or starting two API processes
   returns the same child. It never increments Goal iteration.
6. Startup reconciliation must report, but not auto-repair, impossible lineage,
   more than one open dispatch, or an open dispatch with no Task/Run. Creating a
   guessed successor is forbidden.
7. Goal-linked Tasks cannot be moved to Backlog, scheduled, chained, archived,
   hard-deleted, or manually marked DONE through generic Task routes. The Goal
   control/decision routes own those transitions. Manual Tasks keep current
   behavior.
8. Hard deletion of a Goal with any Task/Run/event lineage returns 409. Empty
   Goals retain current delete behavior. Historical execution is never cascaded
   away.
9. Current Run lease generation, fencing token, event dedupe, branch routing,
   delivery, Task output, and Session usage behavior remain unchanged except
   where this specification explicitly adds Goal predicates and lineage copies.

## 10. Concrete scenarios

### S1 — two concurrent initial dispatches

Goal G is active at generation 1 with no Task. Requests A and B use different
dispatch keys and reach the Goal lock together. One creates Task T1 and Run R1.
The other re-reads the committed state and receives
`GOAL_DISPATCH_IN_FLIGHT`. The partial unique index makes a second open Task
uncommittable even if a caller omits the check. Final counts are one Goal Task,
one Run, one dispatch event.

### S2 — response lost after commit

A dispatch commits, but the HTTP connection closes before the caller reads the
201. After API restart, the caller repeats the same key. The kernel reads T1 and
R1 by `(goalId, goalDispatchKey)` and returns them with `replayed: true`. No
process memory or retry timer is involved.

### S3 — two successor decisions

Iteration 1 awaits decision after Run R1. Two callers propose different next
Tasks. Both lock G; one stores its decision and atomically creates iteration 2.
The other observes iteration 1 `ADVANCED` and returns
`STALE_GOAL_DECISION`. Exactly one successor Task and Run exist.

### S4 — duplicate retry and restart

Two retry requests for failed R1 create/read the one Run whose
`retryOfRunId=R1.id`. Two restart requests with the same dispatch key create/read
one new generation-Task-Run tuple. A concurrent restart with a different key
loses the Goal state/generation check and returns 409.

### S5 — pause during execution

If pause commits before a queued Run claim, claim skips it. If claim commits
first, pause does not revoke that Run; it may finish and move the Task to
`AWAITING_DECISION`. No automatic retry or successor is created until resume.
There is never a second open dispatch.

### S6 — cancel races completion

Both paths take the Goal lock. If cancel wins, it cancels/fences the Run and the
completion returns 409. If completion wins, it records terminal evidence and
releases the lock; cancel then terminalizes the Goal and open dispatch. In both
orders final Goal state is `CANCELLED`, no successor exists, and a late Goal
decision is stale.

### S7 — old completion after restart

Generation 1 was cancelled and generation 2 iteration 1 was restarted. A late
generation-1 runner completion has a revoked/terminal Run fence and returns 409.
Even a malformed internal decision carrying that old Run fails the expected
generation and Task-state checks. Generation 2 remains unchanged.

### S8 — automatic retry then API restart

R1 fails retryably. Its completion transaction creates R2 with
`retryOfRunId=R1.id` and commits. The API exits before responding. Startup
reconciliation sees R2 queued and does not create R3. Replaying R1 completion
is fenced; an explicit R1 retry returns R2 as replay.

### S9 — provider cost missing

Three terminal Sessions belong to a Goal; two report $4 and $6, one has null
cost with token counts. Goal detail says known provider cost $10, 2 priced, 1
unpriced, coverage partial. It does not say total spend $10 and does not invent
a price from tokens.

## 11. Edge cases and failure behavior

- A database timeout/deadlock/serialization failure returns a retryable service
  error only after the transaction rolls back completely. The client reuses the
  same dispatch/decision key.
- Two different requests accidentally reuse one dispatch or decision key with
  different bodies. The first committed body is authoritative; replay returns
  409 `IDEMPOTENCY_KEY_REUSED` and includes no prompt/body echo.
- A Task's latest Run is terminal but has a retry child. A decision against the
  parent is stale; only the child can become decision evidence.
- A Goal is paused after a retryable failure but before retry creation. Goal
  status is re-read under lock, so no automatic retry is created; the failed
  iteration awaits decision.
- A Goal has no open Task. Pause/resume work. Cancel terminalizes the Goal.
  Initial dispatch is allowed only in an active generation with no prior Task;
  later successors require a decision, so callers cannot skip iteration
  history.
- A Goal's Task assignee is archived or lacks repo access at dispatch time. The
  whole dispatch/decision rolls back with current 409/400 semantics; the
  predecessor remains awaiting decision and no iteration number is consumed.
- Attempt budget is exhausted. The Task becomes `AWAITING_DECISION`; no retry
  is created. The later coordinator may dispatch remediation or fail the Goal.
- A direct SQL/manual corruption violates a check, FK, or partial unique index.
  The write fails. Startup reports existing impossible rows and refuses to
  enable Goal dispatch; it does not delete or reinterpret them.
- Deleting a source Run with a retry child, a decision Run, or event reference
  is restricted. Retention may delete workspace files but not lineage rows.
- `WAITING_INBOX` remains an active Task Run for generic Task guards. Goal 5a0
  adds no Inbox behavior; cancel may terminalize such a Run, while pause leaves
  it suspended.

## 12. Migration and backfill contract

Implementation uses one additive forward migration plus an explicit preflight.
Production execution is not part of Goal 5a0.

### 12.1 Preflight

Before migration, record counts and fail closed if any condition is true:

1. A Task's Runs contain more than one distinct non-null `goalId`.
2. A Run has non-null `goalId` and null `taskId`.
3. A Task inferred as Goal-linked has an active Run. Production rollout must
   drain or explicitly cancel it before backfill.
4. A Goal has deletion/orphan inconsistencies or project IDs disagree across
   Goal, Task, Run, or Session.
5. Control-plane A has not merged or current-master revalidation has not been
   recorded.

The preflight emits only IDs/counts, not prompts or secrets.

### 12.2 Expand and backfill

1. Add enum values, nullable lineage/decision columns, event table, indexes not
   requiring backfilled values, and relations.
2. For each Task whose Runs have exactly one non-null `goalId`, set
   `Task.goalId` to it. Order that Goal's inferred historical Tasks by
   `(Task.createdAt, Task.id)` and assign migration-only generation 0,
   1-based iterations. Set `goalDispatchKey = 'migration:' || Task.id` and
   `goalDispatchRequestHash = sha256('migration:' || Task.id)`, and
   `goalDispatchState = MIGRATED_CLOSED`. Copy the tuple to every Run.
3. Existing Goals receive `goalGeneration = 1` and `nextGoalIteration = 1`.
   Historical generation-0 rows remain read-only ancestry; the first governed
   dispatch is generation 1 iteration 1. Because all backfilled Tasks are
   closed and preflight forbids active linked Runs, no open dispatch is
   invented.
4. Validate all-null/all-non-null checks, composite FKs, retry self-FK, decision
   FK, and the partial unique index after backfill.
5. Regenerate Prisma client and run drift validation. A migration verification
   script queries zero tuple mismatches, zero duplicate iteration tuples, zero
   duplicate retry parents, and zero Goals with more than one open dispatch.

If current-master inspection finds no historical non-null `Run.goalId`, the
backfill still executes and records zero rows; it is not deleted from the
migration because rollback/rehearsal needs the same code path.

### 12.3 Migration rehearsal evidence

Rehearse on a disposable schema with fixtures for: no Goal history; multiple
closed iterations; null manual lineage; inconsistent Run Goal IDs (preflight
must abort); and an active linked Run (preflight must abort). Apply migration
twice only through normal migration tooling: second deploy is a no-op. Record
row counts and invariant-query output.

## 13. Rollout and rollback contract

### 13.1 Rollout gates

1. Control-plane A merged; rebase/revalidate on then-current `master`.
2. Migration rehearsal and every test in §15 green on a private PostgreSQL
   schema.
3. Deploy additive schema/client code with Goal dispatch disabled by a default-
   off `GOAL_SAFETY_KERNEL_ENABLED` flag. Existing manual Task/Run behavior must
   pass unchanged.
4. Run production preflight/read-only invariant queries and capture results.
5. Apply migration during an approved window with no Goal-linked active Run.
6. Enable the kernel for one seeded non-production/canary Goal. Prove dispatch,
   retry replay, pause/resume, terminal decision, lineage read, and spend
   coverage.
7. Enable ordinary Goal dispatch only after canary evidence is reviewed. No
   public release or service restart is authorized by this specification.

### 13.2 Rollback

The first response to a defect is to disable `GOAL_SAFETY_KERNEL_ENABLED`.
Existing Goal-linked Runs may finish, but no successor, retry, or restart is
created. Preserve all rows for diagnosis.

Code rollback to a client that does not know the new Goal enum values is unsafe
while `failed` or `cancelled` rows exist. The runbook must therefore:

1. disable dispatch and drain/fence active Goal Runs;
2. snapshot/export Goal, Task, Run, and GoalExecutionEvent lineage rows;
3. translate `FAILED → STOPPED_STUCK` and `CANCELLED → PAUSED` only with explicit
   operator approval, recording original values in the export;
4. convert Goal-linked Task/Run lineage to an operator-readable archival export
   before dropping constraints/columns; never silently relabel them as manual
   execution;
5. drop partial/composite constraints, event table, added columns, and enum
   values in dependency order, verify Prisma drift, then deploy old code.

If preserving live lineage is required, do not perform a destructive database
down-migration; roll forward with the feature flag off. Rollback evidence must
state which path was chosen and whether the archived export is the only place
the removed lineage remains.

## 14. Observability

Every successful transition writes the durable event in §6.5 and emits one
structured log with `goalId`, `goalGeneration`, `goalIteration`, `taskId`,
`runId`, operation, outcome, and latency. Rejected/stale attempts emit a log but
not a durable event.

Required counters/gauges, using the repository's then-current metrics mechanism
or structured-log aggregation if no metrics library exists, are:

- `goal_dispatch_total{outcome=created|replayed|conflict|error}`;
- `goal_decision_total{action, outcome}`;
- `goal_retry_total{source=automatic|operator|reconcile, outcome}`;
- `goal_stale_operation_total{operation}`;
- `goal_open_dispatches`;
- `goal_lineage_invariant_violations`;
- `goal_spend_sessions{coverage=priced|unpriced}`.

Alerts/notifications are Goal 5a1. Goal 5a0 only makes the signals queryable.
The invariant health query is:

```sql
SELECT "goalId", count(*)
FROM "Task"
WHERE "goalDispatchState" IN ('executing', 'awaiting-decision')
GROUP BY "goalId"
HAVING count(*) > 1;
```

It must always return zero rows.

## 15. Executable verification contract

Tests that assert concurrency must use the real PostgreSQL harness and two
independent Prisma clients. Sequential calls, mocks, sleep-only races, or
accepting either an arbitrary error or success do not prove the contract.
Rendezvous barriers must place both operations before the contended lock/CAS.

### 15.1 Required database concurrency tests

1. Two simultaneous initial dispatches with different keys: statuses 201/409,
   exactly one Goal Task, one Run, one open dispatch, one event.
2. Two simultaneous initial dispatches with the same key: one creation and one
   replay, identical Task/Run IDs, counts remain one.
3. A committed dispatch replayed through a newly constructed app/Prisma client:
   identical IDs, proving process restart safety.
4. Two simultaneous `dispatch` decisions on one source Run: at most one
   successor Task/Run and one `ITERATION_ADVANCED` event.
5. Same decision key replay after app restart: returns the original successor.
6. Two simultaneous retries of one failed Run: exactly one child with
   `retryOfRunId`, next run number, and same Goal tuple.
7. Automatic completion retry raced with operator retry and with lease-loss
   reconciliation: each interleaving produces at most one retry child.
8. Two reconciliation passes on one lost Run from independent clients: one LOST
   transition and one retry child.
9. Concurrent restart with the same key: generation increments once and exactly
   one iteration-1 Task/Run exists. Different keys have one winner and one 409.
10. Old generation completion and decision after cancel/restart: both 409, new
    generation counts/state unchanged.
11. Pause versus claim: either claim wins before pause and that Run alone may
    finish, or pause wins and the Run remains queued; no duplicate Run.
12. Pause versus automatic retry: paused final state has no retry child and
    awaits decision.
13. Cancel versus runner completion and cancel versus Goal completion decision:
    one serialized terminal outcome per §10-S6, no successor after cancellation.
14. Direct concurrent inserts that bypass services: the partial unique index
    rejects the second open Goal Task.
15. Composite lineage FK rejects a Run whose Goal tuple differs from its Task;
    check constraints reject partially-null lineage.
16. Generic manual Task start/retry, API chain successor, CRON, AT, claim,
    fencing, and completion regression tests remain green.
17. Spend evidence tests cover complete, partial, no-priced-session, and zero
    terminal-session cases without making an unsupported total-dollar claim.

### 15.2 Static and migration gates

Run on the final implementation tree, in this order where build artifacts are
consumed by tests:

```text
npm run db:generate
npm run db:validate
npm run db:drift-check
npm run build
npm run typecheck
npm test
npm run test:db
```

Also run the migration preflight, disposable-schema migration rehearsal,
post-migration invariant verifier, and rollback rehearsal. A rerun after a
failure is not evidence that the stated gate passed unless the first failure is
explained and dispositioned.

### 15.3 Reviewer evidence packet

The final reviewer receives:

1. current-master SHA and Control-plane A merge/revalidation evidence;
2. schema diff and raw SQL for checks, composite FKs, and partial unique index;
3. migration preflight/backfill/rehearsal output and row counts;
4. test names plus command output for every gate above;
5. controlled-interleaving evidence for the two-dispatch, two-decision,
   retry/reconcile, pause/claim, cancel/complete, and stale-generation races;
6. post-test invariant query results, all zero violations;
7. canary lineage JSON showing Goal → generations → Tasks → Runs and retry
   parents;
8. spend evidence with at least one null-cost Session proving partial wording;
9. rollout/feature-flag state and rollback rehearsal result;
10. a review disposition table containing every finding, its severity,
    accepted/rejected/deferred decision, rationale, exact change or contract
    revision, and verification evidence. No finding may disappear between
    review revisions.

## 16. Reviewer acceptance checklist

The feature is accepted only when a reviewer can answer yes to all items:

- Does the database, independent of application timing, reject two open Goal
  dispatches?
- Do two concurrent dispatch attempts create at most one successor Task and
  first Run?
- Does request replay after process restart return the same lineage rather than
  duplicate it?
- Does each retry have exactly one source parent and remain in the same Goal
  generation/iteration?
- Does restart create a new generation without rewriting old history?
- Can no old fencing token, Run completion, or Goal decision advance a cancelled
  or restarted Goal?
- Are dispatch, decision, retry, cancel, and restart transitions atomic with
  their events?
- Does pause stop new work without pretending to cancel a claimed Run?
- Do the current Task/Run scheduler, manual Tasks, chains, CRON/AT, claim, lease,
  and completion tests remain green?
- Does migration fail closed on ambiguous history and does rollback preserve or
  explicitly export lineage?
- Are provider dollar claims explicitly partial whenever cost coverage is
  incomplete?
- Is every review finding present in the final disposition ledger with evidence?

## 17. Assumptions requiring human review

**A1 — “in flight” includes awaiting decision.** The one-open-dispatch invariant
covers `EXECUTING` and `AWAITING_DECISION`, not only a live runner. This prevents
a successor from being created before terminal evidence is authoritatively
consumed.

**A2 — pause is quiescing.** Pause blocks claim, retry, and decision but lets an
already claimed Run finish. Cancel is the command that revokes authority.

**A3 — retry and restart are distinct.** Retry creates a Run in the same Task
and iteration. Restart is allowed only from terminal non-completed Goal states
and atomically creates a new generation's first Task/Run. Completed Goals cannot
restart.

**A4 — Goal work reuses ordinary NOW Tasks.** A Goal-directed Task cannot also
be scheduled, recurring, templated, chained, follow-up-linked, approval-gated,
archived, or generically status-edited. This keeps one scheduler and one source
of Goal succession authority.

**A5 — terminal failure awaits an explicit decision.** Exhausting retries does
not silently fail or advance the Goal. It leaves one open dispatch awaiting the
future coordinator's atomic dispatch/fail decision.

**A6 — cancellation is database-authoritative.** Goal 5a0 fences and records
cancellation immediately but does not add a process-kill channel. A stale
process can run briefly but cannot commit through AgentOS.

**A7 — known dollar cost is a subtotal.** Null provider costs remain unpriced;
tokens are not converted to dollars. This specification does not add spend-cap
enforcement or lifecycle notification behavior.

**A8 — historical lineage is closed, not invented as active.** Migration assigns
deterministic identity only when one Goal can be inferred unambiguously and
marks it `MIGRATED_CLOSED`; ambiguous or active history stops preflight for
manual disposition.

## 18. Dependency and stopping condition

Planning may proceed from this specification. Implementation must stop before
any code or migration change until Control-plane A is merged and the audited
facts, file/function locations, schema conflicts, API conflicts, and migration
assumptions are revalidated on then-current `master`. Any change to objective,
scope, acceptance, evidence, authority, risk boundary, or the Planned Critical
route requires a new Product Contract version and product-owner approval.
