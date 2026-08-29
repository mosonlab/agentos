Route: implementation=senior-dev

Board UX queue: the main card. Route: senior-dev — the aggregate projection spans API and web, and the column-derivation and activation semantics have concurrency edges (steps moving while the operator looks at the aggregate) the component tests cannot fully witness. Frontend portions may be split to frontend-dev at implementation discretion if the chain template supports it.

### Goal

A chain occupies one aggregate card on the board instead of one card per step, with an activate control for parked chains, so the board shows work items rather than chain internals.

### Background

Template instantiation creates every step as a TODO task up front, so a 12-step chain puts 12 cards in Todo on day one; the live board's Done column is likewise dominated by step cards. The board already has chain awareness — `chainBinding`, chain filter, `chainPositionMarker`, and the chain detail page with `chain-list.tsx` layer groups — but no aggregation: every step renders as a full card. Activation primitives already exist: instantiate with `autoStart=false` leaves step 0 unstarted, `POST /tasks/:taskId/start` starts it, `afterTaskId` parks a chain until its predecessor settles, and `activateChainSuccessor` advances steps. This card is presentation plus one aggregate projection; it must not change chain execution mechanics.

### Changes

1. API: a board-scoped aggregate for each chain, either as a new projection endpoint or fields on the existing board payload: chain id, name, step count, per-status step counts, frontier step (the lowest-layer step that is not DONE) with its title, run state and failure reason, activation state (parked-unactivated, waiting-on-predecessor with predecessor task name, running, settled), and total cost when available.
2. Web board: tasks belonging to a chain render as one aggregate card; standalone tasks render as today. The aggregate card shows: chain name, progress (for example "step 3/12"), frontier step title and its run line, state badge, cost and age. Clicking opens the chain detail page.
3. Column placement: the aggregate card sits in the column of its frontier step (all steps TODO: Todo; any step DOING or in an active run: Doing; frontier in REVIEW: Review; all DONE: Done). Merge-tail repair tasks bound to the chain count as chain members, as `tasksForChain` already does.
4. Activation control: an aggregate card whose chain is instantiated but unstarted (step 0 TODO, no run, not predecessor-bound) shows an Activate button that starts step 0 via the existing start endpoint. A predecessor-bound chain shows a locked indicator naming the predecessor instead of the button.
5. The chain filter (click chain name to see member cards) remains available from the chain detail page or via an expand affordance on the aggregate card, so per-step cards are reachable but not the default.
6. Board column counts count aggregate cards plus standalone tasks, not raw steps.
7. Menu and drag rationalization (ruling 2026-08-28): status columns split into operator-owned and machine-owned. Operator-owned transitions: Backlog and Todo in both directions, and marking a HUMAN task Done (which settles its approval gate). Machine-owned: DOING, REVIEW, DONE for AGENT tasks and all chain-derived statuses. The card menu's "Move to" lists only transitions the server would accept for that card's current state; machine-owned targets do not appear for AGENT cards. Dragging an AGENT card to Doing invokes the existing confirm-start dialog (the drag form of Activate) instead of a bare status PATCH; the menu's bare "Move to Doing" for startable AGENT tasks goes through the same confirm-start path, removing the current drop-versus-menu asymmetry.
8. The mobile task list (`mobile-task-list.tsx`) groups chain members into the same one-entry-per-chain aggregate with the same content rules; desktop and mobile must not disagree about what a chain looks like.
9. Aggregate chain cards are not draggable and offer no "Move to"; their menu offers open chain, activate (when eligible per change 4), filter steps, and archive-when-terminal.

### Out of scope

- No changes to chain execution: instantiation, step statuses, `activateChainSuccessor`, afterTaskId semantics, and the chain detail page's step rendering all stay as they are.
- No drag-and-drop of aggregate cards between columns (status is derived, not operator-set).
- No new TaskStatus values and no schema migration of Task rows; the aggregate is a projection.
- Done-column archiving policy is a separate card.

### Constraints

- The aggregate must degrade honestly: a chain whose steps are in inconsistent transient states (mid-poll) may briefly show a stale frontier but must never show a state that was never true (no invented statuses).
- Activate is idempotent-safe: double-click or stale-view activation of an already-started chain surfaces the API refusal, not a silent success.

### Acceptance

1. Board tests: a chain with N steps renders exactly one card; its column follows the frontier rules in change 3 across fixtures for all-TODO, one-DOING, frontier-REVIEW, and all-DONE.
2. Tests: parked-unactivated chain shows Activate and clicking it calls the start endpoint; predecessor-bound chain shows the locked indicator with the predecessor name and no Activate.
3. Tests: standalone tasks render unchanged; a merge-tail repair task groups into its chain's aggregate.
4. Tests: column header counts reflect aggregates, not steps.
5. Activation of an already-started chain surfaces the refusal in the UI (test with mocked 4xx).
6. Menu tests: an AGENT card in TODO offers no bare move to DOING/REVIEW/DONE; a predecessor-bound card offers no status moves; a HUMAN card offers Done; menu move-to-Doing on a startable task opens the confirm-start dialog.
7. Aggregate card exposes no drag handle and no "Move to" entries.
8. Mobile list tests assert one aggregate entry per chain matching the desktop grouping.
8. Existing chain detail and chain-list tests remain green; `npm run lint` passes.


---
Routing Contract: v1.4
Tier: Direct
Implementation Agent: senior-dev
Critical: no
Reason: Cross API/web projection with concurrency edges in column derivation and activation; no schema migration.
Depends on: diet chain - Heavy overlap - both rewrite task-card.tsx and board components; serialized per ruling Q5