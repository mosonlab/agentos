Route: implementation=frontend-dev

Board UX queue. Independent card; can land before or after chain aggregation. Route: frontend-dev.

### Goal

Board cards show only rows that carry information for that card's state, so titles get the space now spent on constant filler like "Once", "no runs", and "Unassigned".

### Background

`task-card.tsx` renders one fixed row schema for every card regardless of status. On the live board a Backlog card reads: truncated title, "Once", "no runs", "Unassigned", age — three of five rows are constants. `scheduleLabel` in `lib/board.ts` returns "Once" for `scheduleKind === "NOW"`, which is the default and true of nearly every card; `runLabel` prints "no runs" when `latestRun` is null; the assignee row prints "Unassigned" with a robot icon for HUMAN tasks that by definition have no agent. The card already applies the right principle elsewhere ("MANUAL renders nothing: most tasks are manual, and a pill on every card would be noise"); extend it. The title is `line-clamp-3` and truncates while dead rows sit below it.

### Changes

1. `scheduleLabel` (card context): `NOW` renders nothing on the board card. Informative values keep rendering: cron prose, "At {time}", "Waiting for previous step", "Started by chain". The task detail page keeps showing "Run once".
2. Run line: render nothing when `latestRun` is null instead of "no runs".
3. Assignee foot row: a HUMAN task renders a person indicator (the existing IconUser) with no "Unassigned" text, or nothing; only AGENT tasks with a missing assignee keep the explicit "Unassigned" warning, since for them it means misconfiguration.
4. Chain position marker on the board card shows only `step X/Y`; the execution-layer coordinate (`layer N/M`) stops rendering on board cards. The chain detail page keeps its layer-grouped rendering unchanged — layer is a scheduling concept and belongs there.
5. Backlog column ordering: oldest first (creation ascending), so a numbered queue of cards reads top-to-bottom in dispatch order instead of reversed. Other columns keep their current ordering.
6. Do not change card geometry constants or add rows; the freed rows simply let short cards be shorter and long titles use their three clamp lines.

### Out of scope

- No new information rows, no chain aggregation, no column changes.
- No change to the task detail page except none required.

### Constraints

- The empty-row principle must not hide genuinely informative states: any schedule, run, or assignee value that is not the default constant continues to render exactly as today.

### Acceptance

1. Board component tests assert: a NOW-scheduled card shows no schedule row; a CRON card still shows cron prose; a chain-parked card still shows "Waiting for previous step".
2. Tests assert a card with no runs shows no run row, and a card with a run shows the run line unchanged.
3. Tests assert a HUMAN card shows no "Unassigned" text and an AGENT card with an assignee shows the assignee unchanged.
4. Tests assert the board card position marker contains no layer text while the chain detail layer groups render unchanged.
5. A board test asserts Backlog renders oldest-first while another column's ordering is unchanged.
6. Existing board tests updated where they asserted the removed constants; suite green; `npm run lint` passes.


---
Routing Contract: v1.4
Tier: Direct
Implementation Agent: frontend-dev
Critical: no
Reason: UI surface work per routing rule; no persisted data.