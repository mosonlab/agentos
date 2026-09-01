Make the task detail page land on the chain's frontier step and cut the Details card down to the fields an operator reads every visit.

Background: Opening a chain aggregate card on the board routes to `detailTaskId`, which `packages/api/src/board.ts` sets to the first primary step (`firstPrimary?.id ?? frontierMember.id`) even though the same payload already carries `frontier.taskId` (the step that is running or next to run). So every click lands on step 1 and the operator has to walk the chain list by hand. On the task page itself, the Runs table (`apps/web/src/pages/TaskDetail.tsx`, `RunRow`) hides the `Open session` link inside the expanded panel, so reaching a session always costs an extra click, while Branch, the widest column, sits in the middle of ten columns. The Details card renders nine key-value fields plus a six-item "Ready to start" checklist unconditionally; only Execution owner, Branch and Pull request change while a task runs, the rest is configuration fixed at creation, and the checklist is pure noise once every item is satisfied and the task has already run.

Changes:
1. `packages/api/src/board.ts`: `detailTaskId` becomes `frontierMember.id`. `frontier.taskId` and every other aggregate field stay as they are. Update the board contract assertions and fixtures that pin `detailTaskId` to the first step.
2. Runs table in `apps/web/src/pages/TaskDetail.tsx`: add a session column directly after the status column that renders the existing `taskDetail.run.openSession` link when `run.session` exists and `—` otherwise; move the Branch column to be the last column; remove the `taskDetail.run.session` entry from the expanded panel so the link is not rendered twice. Keep the `colSpan` of the expanded row equal to the new column count.
3. Details card in `TaskDetail.tsx`: split the `KeyValue` items into an always-visible group (Execution owner, Branch, Pull request) and a collapsed group (Repo, Target branch, Schedule, Working directory, Approval, Created) behind a toggle button labelled with a new locale key `taskDetail.details.showConfiguration` / `taskDetail.details.hideConfiguration`. Default collapsed. The Approval toggle keeps its current interactive behaviour inside the collapsed group.
4. Readiness checklist (`StartabilityChecklist`): render it only when at least one item is unsatisfied, or when the task has no runs yet. When every item is satisfied and `task.runs.length > 0`, render nothing.
5. Locale: add the new keys to every locale file under `apps/web/src/locales` and register them wherever the i18n sweep test requires.

Out of scope: any change to the chain list component, the session page, the board card layout, the latest-agent-message feature, or the ordering of board columns. No new API fields beyond the `detailTaskId` value change.

Constraints: use the existing `Card`, `KeyValue`, `Button` and `Link` primitives and the design tokens; no new styling mechanism. Do not persist the collapsed state. Run `npm run lint` (not `npx biome`) before handing off; if any file under `docs/` changes, also run `npm run test:snapshot-scan`.

Acceptance:
- `apps/web/src/tests/chain-aggregate-board.test.tsx` (or the board test that covers aggregate routing) asserts that clicking an aggregate card whose frontier is step 3 navigates to step 3's task id, not step 1's.
- A unit test in `packages/api` asserts `detailTaskId === frontier.taskId` for an aggregate whose frontier is not the first step.
- A TaskDetail test renders a run with a session and asserts the `Open session` link is present in the collapsed table row and absent from the expanded panel; the Branch cell is the last cell of the row.
- A TaskDetail test asserts Repo, Schedule and Created are not in the DOM until the configuration toggle is clicked, and Execution owner, Branch and Pull request are visible without clicking.
- A TaskDetail test asserts the readiness checklist is absent for a task with one run and all items satisfied, and present for a task with zero runs.
- `npm run lint`, `npm run build` for `apps/web`, and the full `apps/web` test suite pass.

Route: implementation=frontend-dev - task page layout and board routing are frontend work with a one-line API projection change
