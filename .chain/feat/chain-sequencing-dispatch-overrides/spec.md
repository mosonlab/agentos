# Cross-chain activation: dispatch-on-completion and per-instantiation step overrides

Feature branch: feat/chain-sequencing-dispatch-overrides
Baseline workspace HEAD: ace93d87ab6760d0726a7484c7d3590a6353297d
Reference production main named by the brief: f646c674fc90e6f8e6fd3db5ee7de957f170b8ad

This document is the specification of record for the feature. It states required
behaviour and the interfaces that behaviour is observed through. It does not
sequence implementation work; the plan step owns that.

## 1. Problem and who it is for

The operator is a human running AgentOS through the web board and the HTTP API.
The second consumer is the control plane itself, which owns chain progression.

Today POST /projects/:projectId/task-templates/:templateId/instantiate accepts
repoId, variables, autoStart, name and description. It materialises one Task row
per template step, stamps chainId, chainIndex and chainLayer on them, copies each
template step assignee onto its Task row, and either queues the first step
immediately (autoStart true) or leaves the whole chain sitting in TODO
(autoStart false). Progression from there is server-owned: activateChainSuccessor
advances one execution layer at a time under a full-chain row mutex.

Two gaps follow from that shape.

1. There is no supported way to say: run this new chain when that existing chain
   finishes. An operator who wants chain B to follow chain A must watch A's last
   step and press Start on B by hand. The intent is recorded nowhere, so nothing
   in the product can show it, and nothing enforces it. Waiting operators either
   poll the board or start B early against an unfinished branch.

2. There is no safe way to run one instantiation with a different assignee for
   one step. The two available moves are both wrong. Editing the canonical
   TaskTemplateStep changes every future chain and is forbidden by the repository
   rules that make agents/README.md the owner of canonical defaults. PATCHing the
   Task row after instantiation is a race against autoStart, is invisible at
   instantiation time, and produces no record that the deviation was intentional.

The feature closes both gaps with the smallest addition that fully meets them:
one optional predecessor binding on the instantiate call, and one optional
per-instantiation assignee override map on the same call. Canonical templates and
already-materialised chains are untouched.

## 2. Definitions used throughout

- Chain: the set of Task rows sharing one projectId and chainId.
- Execution layer: Task.chainLayer, with Task.chainIndex as the historical
  fallback the current code already applies for legacy rows.
- Terminal layer of a chain: the greatest execution layer present among the
  chain rows.
- Terminal task: the single Task row occupying a chain terminal layer. For the
  canonical thirteen-step Full Assurance template (compound-engineer-workflow)
  that is stepIndex 13, layer 12, the mechanical merge-execution step.
- First task of a chain: the row with the lowest execution layer, which for a
  template instantiation is the row created from the lowest template stepIndex.
- Binding: the recorded one-to-one pointer from a bound chain first task to the
  predecessor terminal task whose completion may queue it.
- Bound chain: a chain whose first task carries a binding.
- Unresolved binding: a binding whose predecessor task is not DONE.
- Inert: a bound chain whose first task has no Run at all, has status TODO, and
  whose binding is unresolved. Inert is a computed condition, not a stored state.
- Dispatch: the server-owned act of queueing the first Run of a bound chain when
  its binding resolves.

## 3. Scope summary

In scope, and nothing else:

1. Optional afterTaskId on the instantiate input, validated and persisted as one
   binding inside the existing serializable instantiation transaction.
2. Optional stepOverrides on the same input, keyed by template stepIndex and
   carrying assigneeAgentId only, copied onto instantiated Task rows.
3. Dispatch of a bound chain from the server-owned terminal-completion path.
4. A computed blocked-on marker on the board card and in chain detail for a
   chain whose binding is unresolved, plus refusal to start such a chain by hand.
5. The minimal migration for the binding, and the test coverage named in
   section 12.

## 4. Behaviour in concrete scenarios

Each scenario is Given / When / Then. The project is P, the repository R, the
canonical template T is compound-engineer-workflow with thirteen steps, chain A
is an existing instantiation of T whose terminal task is A13, and chain B is the
new instantiation.

### S1 Bind a new chain to a running chain

Given chain A exists in project P and A13 is its terminal task with status TODO
or DOING, and no other chain first task is bound to A13.

When the operator POSTs instantiate for T with repoId R, valid variables, and
afterTaskId set to A13, and autoStart absent or false.

Then the response is 201. Thirteen Task rows for chain B are created in one
transaction. B1 carries dispatchAfterTaskId equal to A13. No Run row exists for
any task of chain B. B1 status is TODO. B1 activity records that the chain was
instantiated and is waiting for its bound predecessor, naming A13 and carrying
the predecessor task id in metadata. Chain A is byte-unchanged apart from an
activity row on A13 recording that a chain was bound to it.

### S2 Dispatch on terminal completion

Given S1 has happened and chain B is inert.

When A13 reaches DONE through any server-owned completion path - the run
completion path that calls advanceTemplateTask, an approval-gate approval that
marks the gate task DONE and activates the successor, or an operator PATCH of the
task status to DONE - and no unfinished execution layer remains in chain A.

Then exactly one Run is created for B1, run number 1, with the same run
configuration B1 would have received from a plain autoStart instantiation. B1
activity records that the bound predecessor completed and the first step was
queued, with the predecessor task id and chain id in metadata. A13 activity
records that the bound chain was dispatched, with chain B chainId in metadata.
The binding row is not cleared; it stays as history.

### S3 No queue before terminal DONE

Given S1 has happened.

When any non-terminal task of chain A completes, or A13 enters DOING, REVIEW or a
failed run state, or A13 is retried.

Then chain B still has zero Run rows and B1 is still TODO. Nothing about chain B
changes.

### S4 Unbound instantiation is unchanged

Given an instantiate call with no afterTaskId.

When it is executed with autoStart true, and separately with autoStart false or
absent.

Then behaviour is byte-identical to today: autoStart true queues the first step
inside the transaction and writes the activity line Template instantiated; first
step queued; autoStart false writes Template instantiated; ready to start and
queues nothing. No dispatchAfterTaskId is written on any row.

### S5 Missing predecessor

Given afterTaskId names an id that does not exist, or exists in another project.

When instantiate runs.

Then the response is 400 with code after_task_not_found, and no Task, activity,
Run or TriggerFire row for chain B exists. The transaction leaves no partial
chain.

### S6 Predecessor is not a chain task

Given afterTaskId names a Task in project P whose chainId is null - a manual
task, a cron copy, or a Goal-linked task.

When instantiate runs.

Then 400 with code after_task_not_chained, and no partial chain.

### S7 Predecessor is not terminal

Given afterTaskId names A5, which is not in chain A terminal layer, or names a
task in a terminal layer that holds more than one row.

When instantiate runs.

Then 400 with code after_task_not_terminal, and no partial chain.

### S8 Predecessor pointer already occupied

Given chain B is already bound to A13.

When a second instantiate call names afterTaskId A13.

Then 400 with code after_task_already_bound. The second chain is not created, and
chain B binding is untouched. The refusal is produced by the binding uniqueness
constraint being reported explicitly, never by swallowing the unique conflict and
never by silently reusing the existing binding.

### S9 Predecessor already finished

Given A13 status is already DONE, or A13 is archived.

When instantiate names it as afterTaskId.

Then 400 with code after_task_already_done or after_task_archived respectively,
and no partial chain. A binding that could never resolve is refused at creation
rather than created inert forever.

### S10 autoStart conflicts with a binding

Given an instantiate call carrying both afterTaskId and autoStart true.

Then 400 with code dispatch_conflicts_with_auto_start, before any row is created.
A bound chain is inert by definition; the two inputs express opposite intents and
the request is refused rather than one input being ignored.

### S11 Valid assignee override

Given the canonical template step 9 has assignee senior-dev, and agent X is an
active agent in project P with a grant for repository R, and step 9 is neither
the compound-implementation step nor a merge-execution step.

When instantiate is called with stepOverrides { 9: { assigneeAgentId: X } }.

Then the created Task row for step 9 carries assigneeAgentId X and the template
step assigneeType unchanged. Every other created Task row carries its canonical
template assignee. TaskTemplate and TaskTemplateStep rows for T are unchanged,
including updatedAt. Prompt, outputKind, approvalGate, opensPullRequest,
attachmentsFromPrevious, layer, chainIndex and targetBranch of every step are
exactly what an un-overridden instantiation would have produced.

### S12 Overrides do not touch unspecified steps

Given stepOverrides names only step 9.

Then steps 1 to 8 and 10 to 13 carry the canonical template assignee, and the
chain runs exactly as an un-overridden chain would.

### S13 Unknown step index

Given stepOverrides names step 14, or step 0, or a key that is not a positive
decimal integer without leading zeros.

Then 400 with code step_override_unknown_step or step_override_invalid_key, and
no partial chain.

### S14 Archived or foreign or missing agent

Given the override names an agent id that does not exist in project P, or names
an agent whose archivedAt is set.

Then 400 with code step_override_agent_not_found or step_override_agent_archived
respectively, and no partial chain. The same refusal is produced when the agent
is archived between the pre-transaction read and the commit, because the override
agent rows are re-read under the same Agent-row mutex the canonical assignees
already use.

### S15 Missing repository grant

Given the override names an active agent with no AgentRepoAccess row for
repository R in project P.

Then 400 with code step_override_missing_repo_grant, and no partial chain. An
override is held to exactly the grant requirement a canonical assignee is held
to, and the grant is locked inside the transaction the same way.

### S16 Integrator misbinding through an override

Given the override names the merge-integrator sentinel agent for an ordinary
step, or names an ordinary model agent for the canonical merge-execution step 13.

Then 400 with code step_override_integrator_binding, carrying the refusal
sentence the shared canonical binding validator produces, and no partial chain.
The bidirectional binding invariant is evaluated against the effective assignee
after overrides are applied, not against the template assignee.

### S17 Pinned compound-implementation step

Given the override targets canonical step 5 - the compound implementation step -
with an agent other than the pinned implementation agent, or targets a step whose
template assigneeType is HUMAN.

Then 400 with code step_override_compound_implementation or
step_override_step_not_agent respectively, and no partial chain. An override
never changes assigneeType, so a human step cannot acquire an agent.

### S18 Blocked-on is visible and starting by hand is refused

Given chain B is bound and its binding is unresolved.

When the operator loads the tasks board and the chain detail for any task of
chain B.

Then the B1 board card shows a blocked-on marker naming the predecessor task, and
the chain detail step row for B1 shows the same marker, reports startable false
and startAction null. When the operator nevertheless POSTs /tasks/B1/start, the
response is 409 naming the bound predecessor, and no Run is created.

When the binding later resolves, the marker disappears on the next poll and the
card shows the queued run exactly as any other queued first step does.

### S19 Historical chains are untouched

Given a chain instantiated before this feature, including a legacy template with
a historical DONE gap, and a chain currently in flight.

Then its board card, chain detail, stored prompts, progression and merge tail are
exactly what they are today. No migration rewrites any of its rows, and its
dispatchAfterTaskId is null.

## 5. Data and schema changes

One nullable self-reference on Task and nothing else.

Prisma model Task gains:

- dispatchAfterTaskId String? @unique
- dispatchAfter Task? @relation(name TaskDispatchBinding, fields
  [dispatchAfterTaskId, projectId], references [id, projectId], onDelete Restrict)
- dispatchedChainFirstTask Task? @relation(name TaskDispatchBinding)

Required properties of the column:

1. Nullable, defaulting to null. Every existing row is null after the migration
   and no backfill runs.
2. Unique. Uniqueness is what makes the binding one-to-one and is the mechanism
   behind the occupied-pointer refusal in S8.
3. The foreign key is composite over (dispatchAfterTaskId, projectId) referencing
   the existing Task unique pair (id, projectId). This is what makes a
   cross-project binding unrepresentable in the database rather than only refused
   in code. The composite key is not enforced when dispatchAfterTaskId is null,
   which is the intended behaviour for every unbound row.
4. onDelete Restrict, matching the treatment of goalPredecessorTaskId: a bound
   predecessor cannot be deleted out from under a chain that is waiting on it.

A migration check constraint named Task_dispatch_binding_shape_check enforces:

  dispatchAfterTaskId IS NULL
  OR (chainId IS NOT NULL AND goalId IS NULL AND dispatchAfterTaskId <> id)

which states three invariants at the storage layer: only a chain task may be
bound, a Goal-linked task may never be bound, and a task may not be bound to
itself.

The migration is additive only: add column, add unique index, add foreign key,
add check constraint. It rewrites no table content, backfills nothing, and
changes no existing constraint. In particular Task_goal_runtime_shape_check and
Task_chain_identity_all_or_none_check are left exactly as they are; the new check
is written so that the Goal invariant needs no amendment - a Goal-linked task has
chainId null and goalId non-null, so both of the first two clauses already forbid
a binding on it. goalPredecessorTaskId keeps its own column, its own uniqueness
and its own semantics, and no code path treats the two pointers as
interchangeable.

The binding is not stored on the predecessor. Storing it on the successor first
task is what gives the unique index its one-to-one meaning, keeps chain A rows
untouched by the instantiation of chain B, and makes the blocked-on projection a
property of the row that is blocked.

No new table, no new enum value, no new TaskStatus, no new Task column beyond
this one, and no column on TaskTemplate or TaskTemplateStep.

## 6. Interface changes

### 6.1 Instantiate input

POST /projects/:projectId/task-templates/:templateId/instantiate gains two
optional properties. The existing four are unchanged in name, type and default.

- afterTaskId: optional task id string, validated by the same id schema the route
  already uses for path parameters.
- stepOverrides: optional object keyed by template stepIndex rendered as a
  decimal integer string with no leading zeros and no sign, whose value is an
  object with exactly one required property assigneeAgentId, an agent id string.
  Unknown properties inside an override value are rejected by the schema. At most
  64 entries are accepted; a larger map is a 400 with code
  step_override_too_many.

Schema-level refusals - wrong type, malformed key, unknown property inside an
override, autoStart true together with afterTaskId - are 400 responses produced
before any database work.

### 6.2 Instantiate output

The response body keeps its current shape: chainId, branchName, tasks and
fireId. The Task rows in tasks now carry the new dispatchAfterTaskId column,
which is null for every row except the first task of a bound chain. No other
field is added, renamed or removed.

### 6.3 Refusal contract

Every refusal introduced by this feature is an HTTP 400 from the instantiate
route, except the manual-start refusal in 6.6 which is 409. Each refusal carries
a stable machine-readable code and a human-readable message that names the
offending id or step index.

  after_task_not_found                  no task with that id in this project
  after_task_not_chained                predecessor has no chain identity
  after_task_not_terminal               predecessor is not the sole task in its
                                        chain terminal layer
  after_task_already_bound              another chain first task already points
                                        at this predecessor
  after_task_already_done               predecessor is already DONE
  after_task_archived                   predecessor is archived
  dispatch_conflicts_with_auto_start    afterTaskId sent with autoStart true
  step_override_invalid_key             override key is not a positive decimal
                                        integer without leading zeros
  step_override_unknown_step            no template step with that stepIndex
  step_override_too_many                more than 64 override entries
  step_override_agent_not_found         agent id absent from this project
  step_override_agent_archived          agent is archived
  step_override_missing_repo_grant      agent has no grant for the target repo
  step_override_step_not_agent          target step assigneeType is not AGENT
  step_override_integrator_binding      effective assignee violates the canonical
                                        merge-integrator binding invariant
  step_override_compound_implementation effective assignee violates the pinned
                                        compound-implementation assignee rule

The route today recognises an input-shaped failure by matching the thrown error
message against a fixed regular expression and otherwise answers 500. Every code
above must be recognised as a 400 by construction rather than by a message that
happens to match; a new refusal that reaches the client as a 500, or as an
unhandled exception, is a defect of this feature. The existing refusals for
missing repo, unknown variables, archived canonical assignee and invalid branch
name keep their current messages and status.

### 6.4 Instantiation semantics with a binding

Inside the one serializable transaction that already creates the chain:

1. The predecessor chain rows are locked with the same full-chain row mutex the
   completion path takes, before the predecessor is validated. This is what makes
   the create-binding and resolve-binding paths mutually exclusive rather than
   racing.
2. The predecessor is re-read under that lock and re-validated against every
   condition in 6.3: same project, chain identity present, sole occupant of its
   chain terminal layer, not archived, not DONE.
3. The chain rows are created exactly as today, with the binding written on the
   first task in the same statement that creates it or in one immediately
   following update inside the same transaction.
4. No Run is enqueued. The autoStart branch is not reached, because autoStart
   true is already refused in combination with afterTaskId.
5. The first task activity line records the waiting state and names the
   predecessor. The other steps keep their current Template instantiated; waiting
   for predecessor line.
6. One activity row is written on the predecessor task recording that a chain was
   bound to it, with the new chainId in metadata. This is the audit record that
   makes the binding discoverable from the predecessor side without a column
   there.

Any refusal rolls the whole transaction back. There is never a partially created
chain, never a chain without its binding, and never a binding without its chain.
The existing bounded retry on serialization and unique conflicts still applies;
an occupied-pointer unique conflict is classified as the S8 refusal and is not
retried as if it were a transient serialization conflict.

### 6.5 Instantiation semantics with overrides

1. The effective assignee of each template step is the override for that
   stepIndex when present, and the template step assignee otherwise.
2. assigneeType always comes from the template step and is never changed by an
   override.
3. Every validation the instantiate path already performs on canonical assignees
   is performed on effective assignees instead: agent exists in project, not
   archived, holds a grant for the target repository, satisfies the canonical
   merge-integrator binding invariant for that step, and satisfies the pinned
   compound-implementation assignee rule for that step.
4. Inside the transaction, the Agent-row mutex is taken over the union of
   canonical and override assignee ids in one id-ordered statement, and the
   repository grant lock is taken for every distinct effective assignee. The
   existing deadlock-avoidance property - one id-ordered lock statement - is
   preserved.
5. Overrides are copied only onto Task rows. No write to TaskTemplate or
   TaskTemplateStep occurs anywhere on this path.
6. An override that names exactly the canonical assignee is accepted and is a
   no-op on the created row.
7. Overrides and afterTaskId are independent. Either may be sent without the
   other, and both together are valid.

### 6.6 Manual start of a bound chain

POST /tasks/:taskId/start refuses a task whose binding is unresolved, with 409
and a message naming the bound predecessor, in the same reason ladder that
already refuses a task whose in-chain predecessor is not done. The refusal is
evaluated under the chain row lock the route already takes, so it cannot race a
dispatch. Once the binding is resolved - the predecessor is DONE - the route
behaves exactly as it does today for any chain first task, including the Backlog
recover path.

POST /tasks/:taskId/retry is unchanged. A retry presupposes a prior Run, which
only exists after dispatch, so the binding never gates it.

### 6.7 Board projection

The board card gains one field:

  blockedOn: { taskId: string; taskName: string } or null

It is non-null only for a task whose dispatchAfterTaskId is set and whose
predecessor status is not DONE. It is computed, never stored. It is null for
every task in every chain that has no binding, which is every historical chain.

The board projection is explicitly cost-sensitive. Resolving blockedOn must not
add a per-row query: the route collects the distinct non-null
dispatchAfterTaskId values present in the page of rows it already selected and
resolves them in at most one additional query selecting id, name and status. A
page with no bound rows - the overwhelmingly common case - issues no additional
query at all. The board ETag continues to be computed over the serialised body,
so a change in blockedOn correctly invalidates a cached board.

### 6.8 Chain detail projection

GET /tasks/:taskId/chain gains the same field on each step entry:

  blockedOn: { taskId: string; name: string; status: TaskStatus } or null

with the same computed definition, non-null only on the bound first task of a
chain with an unresolved binding. In addition, a step with an unresolved binding
reports startable false and startAction null, so the button state and the route
guard in 6.6 cannot disagree - the existing rule that the API answer is the sole
authority for the button is preserved. The predecessor is resolved in one
additional query for the chain being displayed, and only when the chain first
task carries a binding.

Nothing else in the chain response changes. total, done, layer, position,
executionOwner, mergeRecovery and the per-step start decisions keep their current
meaning for every chain.

### 6.9 Web UI

Board card: when blockedOn is non-null the card renders one additional meta line
with the blocked-on marker naming the predecessor task, alongside the existing
chain and schedule lines. No new column, no new lane, no new status pill, and no
change to card layout for any card whose blockedOn is null.

Chain detail: the bound first task row renders the same marker and its Start
control is disabled, driven by startable from the API.

Both strings are added to the locale dictionaries for every supported locale, so
the existing i18n parity and sweep tests continue to pass. Suggested keys:
tasks.card.blockedOn and chain.blockedOnPredecessor, both taking a name
parameter. No literal user-facing sentence is introduced in a component.

## 7. Server-owned activation

Dispatch is resolved by the same server-owned code path that owns chain
progression, so every route that completes a task inherits it: the run-completion
path, the approval-gate decision path, and the operator PATCH that sets a chain
task to DONE.

Required behaviour of the terminal-completion path:

1. It runs while the completing task chain row mutex is held, after the
   completing task has been re-read under that lock, and only when that task
   status is DONE.
2. It resolves at most one bound successor: the unique Task whose
   dispatchAfterTaskId equals the completing task id.
3. It queues that successor first Run only when the completing task chain has no
   remaining unfinished execution layer - that is, at the same point the existing
   code concludes the chain is complete. If a bound successor exists while the
   predecessor chain still has unfinished work above the completing task, the
   successor is not queued and is parked with an explicit failure reason stating
   that its bound predecessor is no longer terminal. This state is unreachable
   through the validated instantiate path and exists so the impossible case fails
   loudly instead of stalling silently.
4. Before queueing, it takes the successor chain row mutex. Lock order is always
   predecessor chain then successor chain. The binding graph cannot contain a
   cycle, because a binding may only point at a chain that already existed when
   the bound chain was created; this ordering is therefore total and no
   dispatch-induced deadlock is possible.
5. It re-reads the successor first task under that lock and refuses to queue when
   the row is no longer queueable: not TODO, archived, already holding an active
   Run, assigneeType not AGENT, missing repo, assignee archived, or missing
   repository grant. Each refusal parks the successor in REVIEW with a specific
   failureReason naming the cause and writes an activity row on both tasks. The
   predecessor completion is preserved and committed - this mirrors the existing
   treatment of a stopped merge-integrator successor, where predecessor success is
   never rolled back by a successor that cannot start.
6. It queues through the single shared enqueue path, so every existing guard on
   Run creation - archived task, archived assignee, integrator stop exclusivity,
   integrator binding, compound implementation assignee, budget derivation,
   branch resolution - applies unchanged to a dispatched first Run.
7. A unique conflict raised by concurrent Run creation is caught at a savepoint,
   treated as already queued, recorded in activity, and never allowed to roll back
   the predecessor completion. Any other error propagates.
8. When no binding exists for the completing task, the path is byte-identical to
   today, including the Chain complete activity line.

Exactly-once is guaranteed by four independent facts, and the tests in section 12
must exercise the combination, not just one of them: the predecessor chain row
mutex serialises every completion path; the successor chain row mutex serialises
every queue attempt; the successor status and active-run re-read under that mutex
rejects a second attempt; and Run carries a unique constraint on (taskId,
runNumber) plus a unique dedupeKey.

Fail-closed remains the rule. No path introduced here converts a refusal into a
silent no-op, retries a business refusal as if it were a transient conflict, or
queues work whose preconditions were not proved under the lock that protects
them.

## 8. Edge cases and failure behaviour

1. Predecessor deleted while a chain is bound to it. The Restrict foreign key
   refuses the delete. The operator must archive or complete the predecessor
   instead. No cascade, no orphaned binding.
2. Predecessor archived after binding. Archiving does not resolve the binding.
   The bound chain stays inert and keeps showing the marker. The operator either
   unarchives and completes the predecessor, or abandons chain B. This is a
   visible stalled state, not a silent one, because the marker names the archived
   task.
3. Predecessor chain fails or its merge integrator stops. The predecessor never
   reaches DONE, so nothing is queued. Chain B stays inert. No webhook, no merge
   evidence, no PR state is consulted; only task status matters.
4. Predecessor is retried after a failure and then succeeds. Dispatch happens on
   the completion that actually reaches DONE, once.
5. Predecessor gate is rejected. The gate task returns to TODO and is queued
   again; the binding is untouched and unresolved.
6. Bound successor chain archived before dispatch. The archived-task guard in the
   shared enqueue path refuses, and the successor is parked with a failure reason
   naming the archived task. Predecessor completion is preserved.
7. Bound successor assignee archived between instantiation and dispatch.
   Dispatch parks the successor in REVIEW with the failure reason that names the
   agent, exactly as the existing successor-activation path already does for an
   archived assignee inside one chain.
8. Repository grant revoked between instantiation and dispatch. Same treatment as
   7, with a failure reason naming the repository.
9. Two instantiate calls race for the same free predecessor. Both take the
   predecessor chain mutex; the second observes the binding or the unique index
   and returns after_task_already_bound. Exactly one chain is created.
10. An instantiate call races the predecessor completion. Both serialise on the
    predecessor chain mutex. If instantiation wins, the completion that follows
    resolves the binding and dispatches. If completion wins, the instantiation
    observes the predecessor already DONE and returns after_task_already_done. A
    binding is never created that no completion will ever see.
11. Override agent archived between validation and commit. The in-transaction
    Agent-row mutex re-read produces step_override_agent_archived and rolls the
    chain back.
12. Trigger-fired and webhook-fired instantiations. They call the same
    instantiation routine with neither afterTaskId nor stepOverrides, and their
    behaviour, including the TriggerFire ledger row written in the same
    transaction, is unchanged.
13. A chain whose first task is a human step. Instantiation already refuses a
    chain whose first step is not agent-executable, and that refusal is
    unchanged; a binding cannot be attached to such a chain because the chain
    cannot be created.
14. Legacy chains with a historical DONE gap. The terminal-layer computation and
    the chain-complete conclusion keep their current fallback to chainIndex, so a
    legacy predecessor remains bindable if and only if its terminal layer holds
    exactly one row.

## 9. Compatibility guarantees

1. Canonical templates and template steps are never written by this feature. The
   deployed thirteen-step Full Assurance contract - step indexes, layers,
   assignees, prompts, output kinds, approval gates, merge readiness at step 12
   and merge execution at step 13 - is unchanged.
2. Stored prompts on existing Task rows are never rewritten.
3. Every existing chain, in flight or historical, keeps its current progression,
   display and merge tail.
4. goalPredecessorTaskId semantics, the Goal execution safety kernel constraints
   and Goal lineage export are unchanged.
5. The unbound instantiate contract, including autoStart, is unchanged.
6. No new orchestrator table, no chain profile concept, and no generic override
   system is introduced. The only override key is assigneeAgentId.

## 10. Out of scope

Generic chain profiles. Per-step overrides beyond assigneeAgentId. Model, runner,
tier, stall, session and retry overrides. Webhook triggers for dispatch. Pull
request merge callbacks. External merge-evidence integration. New generic chain
orchestrator tables. Canonical template reordering or role-prompt changes.
Migration of historical or in-flight chains. Goal execution, cancellation, merge
recovery, release authority, credentials, permissions and destructive data
changes. Any UI for composing a binding or an override - this release exposes both
through the API only. Chains bound to more than one predecessor, predecessors
bound to more than one chain, and dispatch from a non-terminal task.

## 11. Assumptions

These are the simplest readings of an ambiguous brief. Each is a decision, not a
question; none of them changes the objective, scope, acceptance criteria,
evidence, authority or risk boundary the Product Contract records.

A1. Terminal task means the sole occupant of the chain greatest execution layer.
    A terminal layer holding more than one row is not bindable, and the refusal
    is after_task_not_terminal. Binding to one of several parallel terminal
    siblings would fire while the chain is still running, which contradicts
    dispatch on chain completion.
A2. Binding to a predecessor that is already DONE is refused rather than
    dispatched immediately. Immediate dispatch would contradict the rule that
    only terminal completion may queue a bound chain, and an inert binding that
    can never resolve would be a silent stall.
A3. afterTaskId together with autoStart true is refused rather than one input
    silently winning.
A4. The binding lives on the successor first task as a unique nullable
    self-reference. Uniqueness is the occupied-pointer mechanism.
A5. Cross-project predecessors are reported as after_task_not_found rather than a
    distinct code, so the API does not disclose the existence of a task in a
    project the caller did not name.
A6. stepOverrides is an object keyed by decimal stepIndex strings, matching the
    brief phrase keyed by template stepIndex.
A7. An override never changes assigneeType; targeting a HUMAN step is refused.
A8. An override that names the canonical assignee is accepted as a no-op rather
    than refused as redundant.
A9. Steps pinned by an existing invariant - canonical merge execution and
    compound implementation - are not special-cased away. The same validators run
    against the effective assignee, so only a deviation is refused.
A10. A bound chain cannot be started by hand while its binding is unresolved;
     the start route refuses with 409.
A11. When a dispatched first Run cannot be created because the successor is no
     longer queueable, the successor is parked in REVIEW with an explicit failure
     reason and the predecessor completion is preserved, following the existing
     stopped-integrator precedent. Rolling back a successful predecessor
     completion because a downstream chain is unstartable would lose proven work.
A12. The binding row is retained after it resolves, as history and as the
     evidence a reviewer reads. It is never cleared or reused.
A13. No user interface is added for creating a binding or an override in this
     release; the board and chain detail only display the blocked-on state.
A14. Overrides are capped at 64 entries, comfortably above the thirteen-step
     canonical template, so a malformed client cannot force unbounded validation
     work.

## 12. How a reviewer verifies the feature

### 12.1 API tests, packages/api

1. Valid afterTaskId creates thirteen tasks, writes the binding on the first
   task only, creates no Run, and returns 201.
2. Each refusal in 6.3 returns 400 with its code, and a follow-up query proves
   zero Task, TaskActivity, Run and TriggerFire rows were created for the
   attempted chain - the atomic rollback assertion.
3. Occupied pointer: two sequential binds to one predecessor, second is 400
   after_task_already_bound, first binding unchanged.
4. autoStart true with no afterTaskId still queues run 1 inside the transaction,
   and autoStart false still queues nothing - the unchanged-unbound assertions,
   asserted against the same activity strings the code writes today.
5. afterTaskId with autoStart true is refused before any write.
6. Override tests: valid assignee-only copy onto the Task row; template rows
   unchanged including updatedAt; canonical defaults on every unspecified step;
   loud rejection of unknown step index, malformed key, archived agent, foreign
   agent, missing grant, human step, integrator misbinding in both directions,
   and compound-implementation misassignment.
7. Manual start of a bound chain is 409 and creates no Run; the same call after
   the predecessor is DONE behaves as it does for any chain first step.

### 12.2 Database and concurrency tests, packages/api dbtest suite

1. Terminal completion queues exactly one Run for the bound first task, and the
   predecessor and successor activity rows carry the binding metadata.
2. Concurrent completion: two transactions attempting to complete or advance the
   same predecessor concurrently produce exactly one Run for the bound chain,
   asserted by counting Run rows for the successor first task.
3. No queue before terminal DONE: completion of every non-terminal step of the
   predecessor chain, plus a failed and retried terminal run, leaves the bound
   chain with zero Runs.
4. Dispatch through each of the three completion entry points - run completion,
   approval-gate approval, operator PATCH to DONE - produces exactly one Run in
   total across all three when applied to the same chain in sequence.
5. Unstartable successor at dispatch time - archived task, archived assignee,
   revoked grant - parks the successor with the specific failure reason and
   leaves the predecessor DONE.
6. Unbound chains complete with the Chain complete activity line and no
   additional row, proving the legacy path is untouched.
7. Legacy-chain regression: an existing chain fixture with a DONE gap and null
   chainLayer advances exactly as before.
8. Goal lineage regression: the Goal safety kernel constraints still reject the
   rows they reject today, and no Goal-linked task can carry a binding.

### 12.3 Focused UI tests, apps/web

1. A board card whose blockedOn is non-null renders the marker naming the
   predecessor; a card whose blockedOn is null renders exactly what it renders
   today, asserted against the existing board expectations.
2. A chain detail first step with an unresolved binding renders the marker and a
   disabled Start control; the same step with a resolved binding renders the
   normal control.
3. No new status value, lane or column appears in either view.
4. The i18n parity and sweep tests pass with the two new keys present in every
   locale.

### 12.4 Commands

  npm run typecheck
  npm run test -w @agentos/api
  npm run test:db -w @agentos/api -- src/<touched files>.dbtest.ts
  npm run test -w @agentos/web
  npm run test -w @agentos/db

with RUNNER_WORKSPACE_ROOT pointed at a fresh temporary directory and
TEST_DATABASE_URL and TEST_DATABASE_MAINTENANCE_URL pointed at a throwaway
PostgreSQL server with a per-worktree schema, as CONTRIBUTING requires. The
migration must apply cleanly forward on a database restored from a pre-feature
dump, and applying it must not change any existing row.

### 12.5 Gate

  scripts/merge-gate.sh --expect-head <oid>

must print MERGE GATE: PASS for the exact candidate commit, under the full proof
profile - this change touches migrations and the merge-tail defense list, so the
docs-only profile is not available and must not be requested. Delivery follows
the repository merge-lease procedure.

### 12.6 Manual acceptance walkthrough

1. Instantiate chain A from the canonical template with autoStart true.
2. Instantiate chain B with afterTaskId set to the chain A terminal task and one
   stepOverrides entry on an ordinary step. Observe 201, the blocked-on marker on
   the chain B first card, and no run.
3. Attempt to start chain B by hand. Observe the 409 naming the predecessor.
4. Complete chain A to DONE. Observe exactly one queued run on chain B first
   step, the marker gone, and the overridden step carrying the overridden
   assignee while every other step carries the canonical one.
5. Confirm the canonical template rows are unchanged and a fresh unbound
   instantiation behaves exactly as before.
