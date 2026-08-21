The Tasks board orders every column newest-activity-first, and each card shows
its own chain step, its run duration, and its agent's model spec instead of the
chain-wide current step.

Background: The tasks API orders board and full views with a single
`orderBy { createdAt: "asc" }` (packages/api/src/app.ts, board query), and the
web board (apps/web/src/pages/Tasks.tsx) groups rows by status preserving that
order, so every column - including Done - lists oldest first. The card
(apps/web/src/components/task-card.tsx) renders `chainMarker`
(apps/web/src/lib/chain.ts) from `task.chainProgress`, which the API computes
once per chain (packages/api/src/chain.ts `chainProgress()`, app.ts
`chainProgressLookup`) and shares across the chain's tasks, so every card of a
chain shows the identical "done/total · active step · status" line; the
per-task `position` computed by `positions()` (chain.ts) is never read by the
card. Cards show only `timeAgo(task.updatedAt)`, while `Session.startedAt` /
`Session.endedAt` are recorded and `duration()` (apps/web/src/lib/format.ts)
already renders per-run durations on the task detail page.

Changes:
1. Board ordering: every column lists tasks by last activity, newest first.
   Last activity is the task's most recent run event timestamp when it has
   runs, otherwise the task's `updatedAt`; Done thereby shows the most
   recently completed task on top. Applies to board and full task views.
2. Card chain line: replace the chain-wide progress line with the task's own
   position ("step i/N") from the existing per-task position data. Two cards
   of the same chain must render different chain lines, and the chain-wide
   active-step name no longer appears on cards. The `chainProgress`
   computation may remain for its other consumers.
3. Card duration: a card whose latest run is running shows elapsed time since
   that run's start (e.g. "running 12m"); a card whose latest run has ended
   shows that run's start-to-end duration alongside the existing time-ago
   (e.g. "8m · 3h ago"); a card with no runs keeps time-ago only.
4. Chain badge and filter: chained cards carry a compact badge identifying the
   chain; activating it filters the board to that chain's tasks, with a
   visible control to clear the filter.
5. Title de-duplication: a chained card's title renders without the
   chain-name prefix shared by the chain's tasks; the stored task name is
   unchanged (display only).
6. Agent model spec: agent-assigned cards show the assignee agent's model
   string (e.g. "gpt-5.6-sol:medium") with the assignee.

Out of scope: cost display of any kind (task cumulative cost, Codex price
estimation - a planned follow-up chain); chain-level aggregate views (total
chain duration or cost); Review-column semantics, statuses, or transition
logic; task detail page redesign; swimlanes or board layout restructuring;
archive behavior.

Constraints: no database migration - ordering derives from timestamps already
recorded on tasks, runs, and sessions; a task with no runs must sort
deterministically by `updatedAt`, never crash or drop out of the board; never
fabricate a duration - if a run lacks the timestamps a rendering needs, omit
that rendering rather than showing a wrong value; non-chained cards change
only by gaining the duration rendering.

Acceptance:
1. Automated test: the board view yields each column newest-activity-first; a
   Done task that finished later than another appears above it even when
   created earlier.
2. Automated test: two tasks of the same chain render different own-position
   chain lines, and the chain-wide active-step name is absent from card
   rendering.
3. Automated test: a card with a running latest run renders elapsed duration;
   with an ended latest run renders its start-to-end duration plus time-ago;
   with no runs renders time-ago only.
4. Automated test: the chain badge filter shows only that chain's tasks and
   can be cleared; chained titles render without the shared prefix.
5. Existing api and web suites are green (scratch RUNNER_WORKSPACE_ROOT and
   scratch TEST_DATABASE_URL per repository testing rules).
