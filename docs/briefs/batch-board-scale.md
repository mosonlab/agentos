# Task brief — Tasks board at real data volume (spec step ①)

You are step ① (spec) of the nine-step chain. Write a requirements spec; no implementation. Deliver to `docs/specs/batch-board-scale.md`, push, then continue — this step has no approval gate. Do not call `inbox_ask`.

## Why this batch exists

The operator reported two problems on `/tasks` while using the app for real work: the right-hand column is cut off, and scrolling stutters. Both were reproduced and measured in a real browser against the live control plane at `f5c77ae`. Neither is a rendering glitch; both are the board meeting real data volume for the first time.

**Measurements — these are the baseline you must beat, not context.** Viewport 972 CSS px, 111 tasks in the project (23 Todo, 3 Doing, 85 Done):

```
board content width needed      1380 px
board content box available      680 px
horizontal overflow              700 px      <- the cut-off the operator sees

board height                  20,322 px      <- Done column renders all 85 cards
horizontal scrollbar sits at page y = 20,474
distance you must scroll down to reach it   19,609 px

main-thread long tasks in 12 s     4  (68 / 78 / 119 / 88 ms, 353 ms total blocked)
poll cadence                   2,500 ms  (POLL_MS, apps/web/src/lib/hooks.ts:7)
```

The board is `overflow-x-auto`, so the 700 px is nominally scrollable. It is not reachable in practice: the scrollbar lives at the bottom of a 20,322 px box. **A scrollbar 19,609 px below the fold is not an affordance.**

The long-task cadence matches the poll exactly: `usePoll` replaces the whole array every 2.5 s (`apps/web/src/pages/Tasks.tsx:173`) and all 111 cards re-render, with no memoization and no virtualization. A 119 ms block landing mid-scroll is the stutter.

## The part worth reading twice

Batch 2.5 added the Backlog column, taking the board from four columns to five, and **its browser verification passed**. That verification ran against an 11-task fixture stub. At 11 tasks the board is a few hundred pixels tall, the horizontal scrollbar is on screen, and nothing re-renders slowly. The report said "5 columns, 250px grid, gap 14px, counts 2/5/1/1/2" and it was accurate — and it could not have found this.

**Verification at fixture volume cannot find volume-dependent defects.** This batch must not repeat that mistake, so its acceptance is stated in measured numbers at realistic volume, below. Treat "it looked fine in the browser" as a non-answer.

## Sources of authority

- `apps/web/src/pages/Tasks.tsx` — `BOARD`, `COLUMN_BODY` (lines ~19-24), `TasksPage` (~170).
- `apps/web/src/lib/hooks.ts` — `POLL_MS`, `usePoll`.
- `apps/web/src/tests/tasks-board.test.tsx` — existing board tests; they must keep passing.
- `docs/wiki/batch-2.5-tasks-visibility.md` — what batch 2.5 established about the board. Do not undo it.

## In scope

### 1. Bound the board's height so horizontal scrolling is reachable

Five columns need 1306 px minimum (5 × 250 + 4 × 14) and will not fit a narrow viewport, so horizontal scrolling has to stay. Make it usable. The conventional kanban answer is that each column scrolls vertically and the board occupies the viewport, which bounds board height regardless of card count and puts the horizontal scrollbar back on screen. Evaluate that against alternatives (a sticky horizontal scrollbar, capping the Done column with a "show all" affordance, paginating Done) and justify the choice.

Constraints on whatever you choose:

- Drag-and-drop between columns must still work, including dragging to a column whose drop area is scrolled out of view. This is the main risk of per-column scrolling — spec the behaviour, do not discover it.
- The Done column's `Archive All` and the per-card menus must remain reachable.
- The page must not become a scroll trap: state exactly which element takes the wheel when the pointer is over a column versus the page.

### 2. Stop re-rendering 111 cards every 2.5 seconds

The poll replacing the array is what forces the full re-render. Fix the render cost, not the polling interval — a slower poll trades one defect for a staler board. Memoized cards keyed by identity, a change-aware poll that keeps object identity for unchanged rows, or rendering only what is visible are all legitimate; pick with reasons.

Note that batch 2.5 added `?enrich=false` to `/tasks` for the Projects page's hot poll. Determine whether the board needs the enriched fields it is currently paying for on every poll, and say so either way.

### 3. Do not paper over it with the product

`Archive All` clears the Done column and makes the symptom disappear. That is a workaround the operator already has. **A board that only works when someone remembers to archive is not fixed.** The acceptance numbers below are measured with the Done column full.

## Explicitly out

- Any visual redesign of the board, cards, columns, or badges. Batch 2.5's appearance is settled. This batch changes layout mechanics and render cost only; if a card's pixels move, say why in the output.
- Changing what the columns are, drag-and-drop semantics between statuses, or the archive API.
- Settings, sidebar, Agents page, i18n — batch 1 is in flight there right now.
- Server-side pagination of `/tasks`. If you conclude the real fix needs it, write that as a finding with the mechanism; do not build it here.

## Acceptance shape — measured, at volume

The spec must require, and the implementation must demonstrate with numbers taken in a real browser at **at least 85 Done tasks and 110 total**:

- Board height stays within a small multiple of the viewport, not tens of thousands of pixels, and the horizontal scrollbar is reachable without leaving the viewport. State the measured board height.
- The horizontal overflow is either eliminated at common viewport widths or reachable. State measured content width vs available width.
- Main-thread long tasks over a 12-second idle window drop materially from the 4 × (68–119 ms) baseline. State the measured count and durations, taken the same way (`PerformanceObserver`, `entryTypes: ['longtask']`).
- Drag-and-drop still moves a card between two columns, verified by driving the browser, not by reading the handler.
- Both themes.
- `npm run build`, full test suite, `npm run typecheck` green. Build before running tests — `apps/web/src/tests/styles.test.tsx` reads `dist/assets/*.css` and asserts against stale output otherwise.

**How to get the volume without touching the live database:** seed a scratch database from migrations with fixture rows, or serve the page from a fixture stub that returns 110+ tasks. Never dump or copy the live database, and never point a second control plane at it — that destroyed a workspace including its `.git` on 2026-08-16.

## Concurrency with other chains

Three chains are in flight. Batch 1 (Settings + i18n) touches `apps/web` broadly — sidebar, Settings, Agents — and will eventually extract strings across the app; keep your diff inside the board's files and expect to rebase. The batch 4 fixes chain and the platform repair chain are backend-only. At the fixes step, rebase onto the latest `origin/master` before the final push and re-run the gates after rebasing.

## Standing clauses

- Task-creation field is `name`, not `title`. Implementation steps set `maxDurationMin: 240`. Model, runner, and reasoning tier come from the assigned agent configuration and are never copied into task prompts. Never write OPERATOR_TOKEN into any artifact.
