# Operator lifecycle: hold after current layer and resume Chain

## Problem Statement

An operator watching a Chain run has exactly two levers today: let it run to the
end, or cancel individual Runs. Neither is what they actually want when they
notice something mid-Chain — a spec that reads wrong, a review that is about to
be fed a stale base, a merge tail they want to look at before it starts, a
budget they want to reconsider, or simply the end of their working day.

Cancelling the active Run destroys work that is in flight and may already be
minutes into a provider conversation. Doing nothing means the Chain advances to
the next layer the instant the current layer completes, often while the operator
is still reading the output that made them uneasy. Parking a Step by dragging its
card to Backlog looks like it holds the Chain, but it does not: it parks one
Step, and the Chain's other nodes and later layers are unaffected — a trap that
reads as a hold and behaves as something else.

There is also no way to un-do a decision to wait. Once an operator has parked
Steps by hand to stop a Chain, restarting it means reconstructing which Steps
were parked deliberately and which were parked by the control plane, and starting
them one at a time in the right order — which is exactly the bookkeeping the
Chain exists to do for them.

## Solution

Two user-visible Chain actions, backed by one persisted authority.

**Hold after current layer.** The operator presses it from the Chain card and the
Chain stops advancing at the end of the layer that is running. Nothing is
interrupted: every Run in the currently active layer keeps its provider process,
finishes, and records its output and its Step completion exactly as it would
have. What does not happen is the next layer — it is neither enqueued by the
completion that would have activated it, nor claimed by a runner if a Run for it
already happened to be queued. The Chain visibly reports that it is held, and at
which layer, so the operator can see the difference between 'still working' and
'waiting for me'.

In the UI the action reads **Stop after current layer**, because that is what the
operator is deciding. It is the same one backend operation as Hold; there is no
second mechanism behind the second wording.

**Resume Chain.** The operator presses it and the hold is released. If the layer
the Chain was held after has since completed, the Chain activates the currently
eligible layer — once, no matter how many operators press the button or how a
completion happens to interleave with it. If the held layer is still running,
Resume simply removes the barrier and the ordinary completion path activates the
next layer when that layer finishes, as it always did. Resume never revives a
Run the operator cancelled and never reattaches a provider conversation: any work
it starts is a fresh Run under the Step's ordinary budget.

Both actions are idempotent. Holding a held Chain, or resuming a Chain that is
not held, is a success that changes nothing and says so. Every transition is
recorded, so the audit history of a Chain that was held and resumed three times
reads as exactly three holds and three releases.

## User Stories

1. As an operator, I want a Hold action on the Chain card, so that I can stop a
   Chain from advancing without hunting for its individual Steps.
2. As an operator, I want Hold to be labelled 'Stop after current layer', so that
   the button tells me what will actually happen rather than naming an internal
   concept.
3. As an operator, I want Hold to leave every Run in the current layer running,
   so that I never destroy work that is already minutes into a provider
   conversation just to buy myself time to think.
4. As an operator, I want a held Chain's current layer to complete normally —
   outputs persisted, Steps marked done, approval gates opened — so that Hold
   costs me nothing except the next layer.
5. As an operator, I want the next layer to stay un-enqueued while the Chain is
   held, so that the completion of the current layer does not silently start work
   I asked it not to start.
6. As an operator, I want a Run that was already queued for a later layer to stay
   unclaimed while the Chain is held, so that a race between my Hold and an
   earlier activation cannot leak one Run past the barrier.
7. As an operator, I want the Chain card to say that the Chain is held and at
   which layer, so that 'held' is distinguishable at a glance from 'still
   working' and from 'finished'.
8. As an operator, I want the Start buttons on later Steps of a held Chain to be
   disabled, so that the UI cannot offer me an action the API is going to refuse.
9. As an operator, I want a refusal that names the hold when I try to start a
   later Step of a held Chain through the API, so that automation gets the same
   answer the UI shows.
10. As an operator, I want Hold to record who asked, when, at which layer, and
    why, so that I can explain later why a Chain sat still for an hour.
11. As an operator, I want an optional reason on Hold, so that a colleague
    opening the Chain understands the pause without asking me.
12. As an operator, I want pressing Hold twice to be harmless, so that a
    double-click or a retried request does not create a second hold I then have
    to release twice.
13. As an operator, I want a Resume action on the Chain card that appears exactly
    when the Chain is held, so that the control reads as one toggle rather than
    two independent buttons.
14. As an operator, I want Resume to activate the eligible layer when the held
    layer has already completed, so that resuming actually restarts the Chain
    instead of just clearing a flag.
15. As an operator, I want Resume to activate that layer exactly once even if two
    of us press it at the same moment, so that a parallel layer does not get two
    Runs per Step.
16. As an operator, I want Resume to be safe while the held layer is still
    running, so that I can change my mind before the layer finishes and the Chain
    just carries on normally.
17. As an operator, I want Resume on a Chain that is not held to succeed and
    change nothing, so that a stale UI or a retried request cannot cause a
    surprise activation.
18. As an operator, I want Resume never to resurrect a Run I cancelled, so that
    cancellation stays a decision and not a delay.
19. As an operator, I want Resume never to reattach a provider conversation, so
    that resumed work starts from a clean, auditable Run rather than from a
    session whose state nobody can inspect.
20. As an operator, I want Resume to leave a Step parked in Backlog parked, so
    that resuming the Chain does not silently undo a park I performed on purpose.
21. As an operator, I want to see the exact history of holds and releases on a
    Chain, so that repeated pauses across a long-running Chain remain
    reconstructable.
22. As an operator, I want holding a Chain that is already complete to be
    refused with a clear reason, so that I do not think I have stopped something
    that has already finished.
23. As an operator, I want Hold and Resume to be refused on a Task that belongs
    to no Chain, so that a single Task's page cannot pretend to own a Chain
    control.
24. As an operator, I want moving a Task card on the board to park exactly that
    Step and nothing else, so that a drag never quietly holds or fails to hold a
    whole Chain.
25. As an operator, I want the board never to describe a parked Step as a held
    Chain, so that the two very different states are never confused in the one
    place I look at every Chain at once.
26. As an operator dragging a Step of a held Chain, I want the hold to survive
    that move, so that unrelated card management does not release a barrier I set.
27. As an operator, I want Hold to be recorded once per Chain rather than as a
    flag on every Step, so that a Chain's hold state cannot become internally
    inconsistent between its own nodes.
28. As an operator running two Chains in one project, I want a hold on one to
    leave the other completely unaffected, so that a barrier is Chain-scoped.
29. As an operator running Chains in two projects, I want holds keyed by project
    as well as Chain, so that a Chain identifier reused across projects cannot
    hold the wrong work.
30. As an operator, I want a held Chain's parallel layer to finish all of its
    siblings, so that Hold interacts with a fan-out layer the same way it does
    with a single Step.
31. As an operator, I want the join after a parallel layer to stay un-activated
    while held, so that a fan-in does not slip through because it was the second
    sibling that completed.
32. As an operator, I want a Chain held during its merge tail to leave the merge
    lease untouched, so that a hold cannot strand a global lease held by another
    Chain's readiness.
33. As an operator, I want the merge readiness Step that is already running to
    complete under a hold, so that Hold does not invalidate evidence that was
    about to be recorded.
34. As an operator, I want a Chain held before its merge-integrator layer to keep
    that layer un-activated, so that I can inspect authorization evidence before
    a merge is attempted.
35. As an operator, I want Hold to write no Run rows and no cancellation intent,
    so that a hold is provably not a cancellation.
36. As an operator, I want Hold to leave open approval-gate Inbox cards open, so
    that pausing a Chain does not lose a decision I still owe it.
37. As an operator, I want a Chain held while a Step sits at an approval gate to
    behave sensibly, so that answering the gate does not push the Chain past the
    barrier.
38. As an operator using the API directly, I want the Chain read route to report
    the hold state, so that I do not have to infer it from Step statuses.
39. As an operator using the API directly, I want Hold and Resume to take a
    request identifier, so that a network retry cannot record two transitions.
40. As an operator, I want the handbook to document the new routes with their
    inputs and an example, so that I can drive them without reading the server.
41. As an operator on the Chinese UI, I want both actions and the held badge
    translated, so that the control reads the same way in either language.
42. As an operator, I want the held state to keep polling and updating, so that
    the Chain card does not need a manual refresh to show that a layer finished
    under the hold.
43. As an operator, I want a held Chain whose current layer completes to say so,
    so that I can tell that the Chain is now genuinely waiting on me and not on a
    running Step.
44. As an operator, I want Hold placed while nothing is running to still bar the
    next layer, so that the action works before as well as during execution.
45. As a control plane, I want Hold and Resume to serialize against completion
    and successor activation on the Chain's existing mutex, so that a hold cannot
    land in the middle of a partially activated layer.
46. As a control plane, I want the hold authority read at claim time, so that a
    runner polling for work never receives a Run the barrier should have stopped.
47. As a control plane, I want the hold authority read at Step admission, so that
    the Chain read route, the startability route, Start, and Retry all give one
    answer.
48. As a maintainer, I want no new Task status and no new per-Task flag, so that
    every existing status-based query and guard keeps its current meaning.
49. As a maintainer, I want the hold authority to be one persisted row per
    project and Chain, so that there is exactly one place to read and one place
    to change.
50. As a maintainer, I want the audit history to be append-only and separate from
    the current-state authority, so that reading state is cheap and history is
    never rewritten.
51. As a maintainer, I want the enforcement points to reuse the existing
    admission, activation, and claim seams, so that the barrier cannot be
    bypassed by a caller that forgot about it.
52. As a maintainer, I want tests that cover the completion/Hold race in both
    orders, so that the barrier's behaviour is defined rather than incidental.

## Implementation Decisions

### The authority

- **One new persisted model, `ChainControl`**, is the single authority for a
  Chain's hold state. It is keyed by the pair `(projectId, chainId)` with a
  uniqueness constraint on that pair, because `chainId` is unique per project
  only by convention — the same pairing the existing Chain read paths already use
  as their key.
- `ChainControl` carries the current state and the facts a reader needs without a
  second query: the hold state (held / released), the layer the Chain is held
  after, when the hold was requested, its request identifier, its optional
  reason, when it was last released and by which request, and a monotonically
  increasing hold generation used as the compare-and-set token.
- A Chain that has never been held has no `ChainControl` row. Absence means 'not
  held'; readers treat absence and the released state identically.
- **No `PAUSED` `TaskStatus` is added and no per-Task hold column is added.**
  Every existing status query, board column, admission checklist, and activation
  predicate keeps its present meaning.
- **`ChainControlEvent`** is an append-only child of `ChainControl` holding the
  exact audit history: one row per accepted transition, with its kind (held /
  released), the layer, the actor, the request identifier, the optional reason,
  and the resulting hold generation. It is history only and is never read back as
  authority — the same separation `MergeRecoveryAttempt` already uses for its
  canonical aggregate versus its `TaskActivity` projections. A no-op transition
  (Hold while held, Resume while released) writes no event.
- A `TaskActivity` line is additionally projected onto the Steps an operator
  would look at — the Step whose successor activation was withheld, and the Steps
  activated by Resume — because that is where the existing 'Predecessor layer
  completed; step queued' narration lives. Those lines are narration, not
  authority.

### The held layer

- The **held layer** is the lowest execution layer in the Chain containing at
  least one Task that is not `DONE`, evaluated at the moment the hold is accepted
  and under the Chain mutex. It is persisted on `ChainControl`.
- Layers at or below the held layer are unaffected by the hold: their Runs may be
  claimed, started, heartbeat, and completed. Layers strictly above the held
  layer are barred.
- Execution layer is read the way every existing Chain consumer reads it —
  `chainLayer`, falling back to `chainIndex` for rows that predate the expand
  migration — so the barrier's notion of 'layer' is the same one the activation
  routine, the Chain read route, and the board's layer grouping already use.

### Where the barrier is enforced

Three call paths, two of which are already the codebase's single seams for their
concern. No new bypass-able entry point is introduced.

1. **Step admission.** The shared admission read (`readStepAdmissions`) batch-
   loads the `ChainControl` rows for the Chain keys it has already assembled —
   in the same parallel read that fetches run facts, Chain rows, and repo grants,
   so no N+1 appears. `refusalForStepAdmission` gains one refusal, raised when
   the Step's Chain is held and the Step's layer is above the held layer:
   `conflict`, naming the hold. Because the returned verdict already composes
   `startable` with 'no refusal', every consumer of this seam — the Chain read
   route's `startable`/`startAction`, the startability route, `POST
   /tasks/:taskId/start`, and `POST /tasks/:taskId/retry` — refuses and
   de-activates its button with no per-route change. The
   `StartabilityChecklist` is deliberately **not** extended: it is documented as
   the operator-configurable subset, and a Chain hold is a control, not
   configuration.
2. **Chain layer activation.** `activateChainSuccessorInternal` already holds the
   full-Chain mutex and already re-reads every row after taking it. It reads
   `ChainControl` inside that critical section. When the Chain is held and the
   layer it is about to activate is above the held layer, it activates nothing,
   records the withheld narration on the completing Step, and returns the same
   'nothing activated' shape it returns for the other park cases. The completing
   Step is still marked `DONE`, its output is still persisted, and its bound
   successor dispatch is unaffected — Hold withholds activation, it never rewrites
   completion.
3. **Claim candidate selection.** The claim transaction's candidate query — both
   the ranked SQL used by ordinary runners and the Prisma predicate used by the
   merge executor — excludes a queued Run whose Task belongs to a held Chain at a
   layer above that Chain's held layer. This is what makes 'no later layer is
   claimed' true for a Run that was enqueued before the hold landed. It is a live
   read of the authority, which is why releasing the hold makes such a Run
   claimable again with no new enqueue.

### Hold

- `POST /tasks/:taskId/chain/hold`, addressed through a Task the way the existing
  `GET /tasks/:taskId/chain` is, because the operator always has a Task in hand
  when they are looking at a Chain.
- Required body field `requestId`; optional `reason`.
- The handler takes the Chain mutex (`lockChainRows`) — the same lock, in the
  same order, that completion, activation, and stop-and-park take — then computes
  the held layer and upserts `ChainControl` into the held state with an
  incremented hold generation, writing one `ChainControlEvent`.
- Idempotence: a Hold on an already-held Chain is a success that performs no
  transition and writes no event; the response reports the existing hold,
  including the request identifier that created it, so a client can tell its own
  hold from someone else's. A repeated request carrying the request identifier of
  the current hold is the same success.
- Refusals: `404` when the Task does not exist; `409` when the Task has no
  `chainId`; `409` when every Task in the Chain is `DONE` (there is nothing left
  to hold).
- Hold writes **no** `Run` row, **no** cancellation intent, **no** session-token
  revocation, and does not touch `Task.status`. This is the property that makes
  'Hold never interrupts an active model process' checkable rather than asserted.
- Hold does not acquire, release, or inspect the readiness-owned merge lease.

### Resume

- `POST /tasks/:taskId/chain/resume`. Required body field `requestId`.
- The handler takes the Chain mutex, then releases the hold with a
  compare-and-set on the current hold generation. Exactly one caller wins; a
  loser observes the released state and performs no activation. This is what
  makes 'releases one hold idempotently' and 'activates the eligible layer
  exactly once' the same guarantee rather than two.
- After a successful release, and still inside the same transaction and mutex,
  the winner performs activation by **reusing the existing successor-activation
  routine**, anchored at a deterministically chosen Task in the highest layer
  that is entirely `DONE` (lowest `chainIndex`, then id). The routine's existing
  rules then apply unchanged: it selects the lowest higher layer that still has
  work, skips a successor that already has an active Run, skips a parked or
  archived successor with narration, refuses a multi-node layer carrying an
  approval gate, and enqueues each remaining successor under the ordinary Run
  budget. There is no second activation implementation.
- If no layer is entirely `DONE`, Resume activates nothing: the Chain is still
  inside its first or its held layer, and the ordinary completion path will
  activate the next layer when that layer finishes.
- Resume never sets a terminal Run back to a live status and never reuses a
  cancelled Run's session or provider conversation. Any work it starts is a new
  Run created through the ordinary enqueue path, whose per-Task uniqueness key is
  what makes a doubled activation impossible even under a lost race.
- A Step parked in `BACKLOG` stays parked: the activation routine's existing
  parked-successor skip applies, and Resume does not recover it. Recovery stays
  the operator's explicit action.
- Idempotence: Resume on a Chain that is not held is a success that performs no
  transition, writes no event, and activates nothing.
- Refusals: `404` unknown Task; `409` Task with no `chainId`.

### Read contract

- `GET /tasks/:taskId/chain` gains one Chain-level `control` object:
  the state, the held layer, when it was held, the reason, the request
  identifier, and when it was last released. It is `null` for a Chain that has
  never been held. Per-Step fields are unchanged — `startable` and `startAction`
  already carry the barrier's effect through the admission seam, and duplicating
  it per Step would create a second source of truth for the button's state.
- `GET /tasks` and its `chainProgress` marker are unchanged. Hold state is a
  Chain-card concern; the board's per-card marker keeps describing the card's own
  position.

### UI

- The Chain card header carries one control. When the Chain is not held it reads
  **Stop after current layer** and calls Hold. When the Chain is held it reads
  **Resume Chain** and calls Resume. The card shows a held badge naming the layer
  the Chain is held after, and the hold reason when one was given.
- Chain rows in layers above the held layer render their Start control disabled,
  driven by the `startable` the API already returns, with a hint that names the
  hold rather than a generic disabled state.
- Both labels, the badge, and the hint are dictionary entries in the English and
  Chinese locales; no sentence is written inline in a component.
- Moving a Task card on the board continues to do exactly what it does today —
  a status change on that one Task. It does not write `ChainControl`, and no
  board surface describes a parked Step as a held Chain.

### Documentation

- `docs/operator-api.md` gains both routes in the Chain/Tasks section, in the
  handbook's existing shape: path parameters, required and optional JSON fields,
  and a `curl` example — and the `control` field is described on the Chain read
  route.

## Testing Decisions

### What makes a good test here

A good test in this feature asserts only what an operator or a runner could
observe: an HTTP status and response body, a database row an operator could read
(a `Run`'s existence and status, a `Task`'s status, the `ChainControl` row and
its event history), or rendered markup. It never asserts that a particular
internal function was called, never mocks the activation routine, and never
reaches into a transaction to inspect intermediate state. Race tests drive two
real concurrent HTTP requests or two real concurrent transactions against a real
PostgreSQL database and assert the settled outcome, rather than asserting a lock
was taken.

### Seams

**No new seam is introduced.** Every behaviour lands on a seam that already
exists and is already the highest one available for its concern.

1. **The HTTP application, constructed by the API test harness (`createApp` from
   the API test-app module) against a real database.** This is the primary and
   almost exclusive seam. It covers Hold, Resume, their idempotence and refusals,
   the audit history, the withheld activation, the claim exclusion (driven
   through the real claim route rather than through the query), the
   completion/Hold races in both orders, layered and parallel-layer concurrency,
   Resume's exactly-once activation under concurrent callers, cancelled-Run
   non-resurrection, and the merge-lease non-interaction. One new
   `.dbtest.ts` file owns it.
2. **The pure Chain module's step-admission functions**, already unit-tested
   without a database. The new hold refusal and its message, and the
   layer-comparison rule that decides whether a Step is above the held layer, are
   covered there as pure functions — this is the existing seam that lets the
   admission verdict be tested without provisioning anything.
3. **The Chain list component, rendered to static markup**, already the seam for
   every Chain UI assertion. It covers the Hold/Resume control's label and
   presence, the held badge and its layer, and the disabled Start controls with
   their hint.
4. **The board module and its existing tests**, for the story that a card move
   parks one Step and never presents itself as a Chain hold.

Nothing new is added to the runner or merge-executor packages, so those grow no
seams.

### Modules under test

- The Chain-control authority and its transitions, through the HTTP seam.
- Step admission, at both the pure seam and the HTTP seam.
- Chain layer activation, exercised through real Run completions at the HTTP
  seam — never called directly with a hand-built transaction, because its
  contract is 'what the Chain does when a Step finishes'.
- Claim candidate selection, exercised through the claim route.
- The Chain read route's `control` projection.
- The Chain list component and the board module.

### Coverage the acceptance criteria require

- Layered concurrency: a fan-out layer under a hold completes every sibling and
  activates no join; the join activates on Resume, once.
- Completion/Hold races, both orders: Hold committing before a completion (the
  completion activates nothing), and a completion committing before Hold (the
  next layer was legitimately activated, and Hold then applies from the new
  active layer without disturbing the Runs it just created).
- Repeated Hold/Resume: three cycles produce exactly three held events and three
  released events and no extra Runs.
- Exact audit history: the event sequence, its layers, its request identifiers,
  and the absence of events for no-op calls.
- One eligible layer activation: Resume after a completed held layer enqueues
  exactly one Run per Step of exactly one layer.
- Resume exactly-once: two concurrent Resume requests settle to one activation.
- A card move never holds the Chain: a board status change leaves the Chain
  control absent, and the UI does not describe the parked Step as a held Chain.
- The handbook change is covered by the repository's existing documentation
  checks for the operator handbook.

### Prior art

- `active-run-cancellation.dbtest.ts` — the closest analogue: an idempotent,
  `requestId`-keyed operator control, its refusals, its interaction with the
  full-Chain mutex, and concurrent settlement tests written against real
  transactions.
- `parallel-review.dbtest.ts` — layered and parallel-layer concurrency, and the
  'simultaneous completions serialize the join to exactly one run' shape that
  Resume's exactly-once test mirrors.
- `claim-activation-isolation.dbtest.ts` — concurrent claim polls asserting that
  a candidate is handed out exactly once.
- `chain.dbtest.ts` and `chain.test.ts` — Chain seeding helpers and the pure
  admission/progress unit style.
- `chain-list.test.tsx` and `board.test.tsx` — the static-markup and board module
  assertion style, including the dictionary-driven label assertions.

## Out of Scope

- Active Run cancellation, in every form. Hold is not a cancellation and Resume
  is not an un-cancellation.
- Cancelling a whole Chain.
- Process checkpointing, suspension, or any attempt to freeze and thaw a provider
  conversation.
- Skipping an arbitrary Step, rerunning from a Step, or rolling a Chain back.
- Queue priority, fairness, or any change to how claim candidates are ranked
  beyond excluding the Runs the barrier bars.
- Any change to the readiness-owned merge lease introduced by PR #219, to
  ADR-0003's acquisition point, or to merge-tail recovery.
- A new `TaskStatus`, and any per-Task hold column or flag.
- Holding at a granularity other than the Chain: no per-layer, per-Step, or
  per-project hold.
- Scheduled and recurring task pausing, which already has its own control.
- Goal pausing, which already has its own control and its own authority.
- A hold control on the board or on the projects page; the Chain card owns the
  action.
- Automatic expiry of a hold, notifications about a held Chain, or any timer.

## Further Notes

### Assumptions

Each of these is the simplest reading of the brief. None of them changes the
recorded objective, scope, acceptance criteria, evidence, authority, or risk
boundary, so none was escalated.

1. **Route shape.** Hold and Resume are addressed through a Task
   (`POST /tasks/:taskId/chain/hold`, `POST /tasks/:taskId/chain/resume`),
   mirroring the existing `GET /tasks/:taskId/chain`. A project-and-chain path
   was rejected as a second addressing convention for the same object.
2. **The held layer** is the lowest layer containing a non-`DONE` Task at the
   moment the hold is accepted, and layers at or below it remain claimable and
   startable. This is the literal reading of 'every Run in the currently active
   layer may finish, but no later layer is enqueued or claimed'.
3. **Repeated calls are no-op successes**, not conflicts. `requestId` is required
   and recorded so a retry is auditable, but a second Hold does not stack and a
   second Resume does not double-activate.
4. **History lives in an append-only child** of the single `ChainControl`
   authority. The brief forbids duplicating flags on every Task and forbids a
   second status; it does not forbid an audit child, and 'exact audit history' is
   an acceptance criterion that a single mutable row cannot satisfy.
5. **Operator principal only.** Both routes sit under the operator-authenticated
   `/tasks` prefix; runner and session principals cannot reach them, which the
   existing authentication middleware already enforces by prefix.
6. **The board is unchanged.** Hold state surfaces on the Chain card. The board's
   per-card chain marker keeps describing the card's own position.
7. **Resume reuses the existing activation routine** rather than implementing a
   second selection of 'the eligible layer'. Anchoring at the highest fully-`DONE`
   layer is what lets it do so without a new code path.

### Interaction notes worth carrying into the plan

- Hold and Resume must take the full-Chain mutex, in the existing order, before
  reading or writing anything — the same discipline the recovery activation path
  documents. A prefix lock is insufficient for a layered join, and the barrier is
  exactly a layered-join concern.
- The barrier is read live at claim time on purpose. It is what lets Resume make
  an already-queued later-layer Run claimable again without enqueueing anything,
  which in turn is what keeps 'Resume never resurrects a cancelled Run' and
  'Resume activates exactly once' from fighting each other.
- Hold interacts with the merge tail only by withholding activation of a later
  layer. The server-owned readiness and integrator Steps keep their existing
  execution ownership, their stop conditions, and their lease behaviour.
- An approval gate in the held layer still opens its Inbox card when its Step
  completes; answering it marks the Step done and reaches the activation seam,
  where the barrier applies. A gate is not a hold and a hold is not a gate.
