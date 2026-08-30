Implement this task on fix/board-active-repair-line directly from the feature brief below — a direct chain carries no spec or plan phase, so the brief is the specification of record. The platform materializes `.chain/fix/board-active-repair-line/spec.md` as the specification of record; leave it untouched. The platform pins native child threads to Luna max and limits the session to eight concurrent children. Use them only when the brief contains independent, safely parallel work; group related change points instead of creating one child per item. In the controlled resource limit, fill as many slots as can execute safely in parallel. Give every concurrent writer its own branch and git worktree, and keep coupled work in your own context. When at least two child-writer branches need integration, start one long-lived merger after the first result is ready; integrate a sole child-writer branch yourself. The merger integrates completed branches in dependency-safe order, resolves only mechanical conflicts, reruns affected narrow tests, and reports semantic conflicts to you. Follow the platform-pinned Implementation proof boundary after integration. Give a failed child one bounded correction in the same thread, then take over its assignment yourself. A child must not perform irreversible external actions. Commit the result and persist exactly one JSON object as the task output: `{"schemaVersion":1,"headSha":"<final HEAD>","baseSha":"<starting HEAD>","summary":"<what changed>","testsRun":["<command>"]}`. Leave publication and pull-request creation to the platform. Complete when the brief's behavior is demonstrably delivered and tests are green at the recorded head.
<!-- agentos:task-brief:v1 length=2942 -->
Two defects on the board's chain aggregate card, same component and same projection, fixed together.

## 1. A running merge-tail repair is invisible on the card

When Regression verification (step 10) fails, the merge tail spawns a detached repair task of one of three kinds: `review-fix`, `refresh-conflict`, `gate-fix` (`packages/db/src/merge-tail.ts:163`). While the repair runs, the regression step itself sits in REVIEW waiting for it.

`packages/api/src/board.ts` (`frontierMember`, near line 270) deliberately keeps the lowest unfinished primary step as the frontier until all primary steps settle; repairs only become the frontier afterwards. So during a repair the aggregate card shows the regression step and its already-ended run, and nothing about the repair: not its kind, not that it is running, not how long it has been running. The operator sees a card that looks stalled.

Required: while a repair task attached to the chain is active, the card shows one extra line with the repair kind, its run status, and elapsed time (same `duration(startedAt, null)` treatment the frontier run already gets), for example `gate-fix · run 3 · running 4m`. Keep the frontier rule as is; do not make the repair the frontier. Add the field to the aggregate contract (`ChainAggregate` in `packages/db/src/board-contract.ts`) and project it from the repair members that `assembleChainAggregate` already receives (`repairMembers`); the repair kind is available through `repairBinding` / `RepairBinding.repairKind`. Render it in `apps/web/src/components/chain-aggregate-card.tsx` next to the existing frontier run line. When no repair is active the line is absent.

## 2. "Running" printed twice on an active card

For an active chain the card renders the state pill `tasks.aggregate.state.running` ("Running" / "运行中") and, on the run line (`runLine` in `chain-aggregate-card.tsx`), `status.run.RUNNING` ("running" / "运行中") followed by `tasks.card.runningDuration` ("running {duration}" / "已运行 {duration}"). Result in English: `Running` pill plus `run 8 · running · running 12m`; in Chinese: `运行中` plus `第 8 次运行 · 运行中 · 已运行 12m`.

Required: on the run line, when the run is active and elapsed time is shown, drop the redundant status word so it reads `run 8 · running 12m` / `第 8 次运行 · 已运行 12m`. The state pill stays; it is the chain state, not the run state. Do the same on the single-task card (`task-card.tsx`) if it has the same pattern.

## 3. Model, reasoning effort and fast tier on the chain card

The single-task card already prints a model line (`cardModel` in `task-card.tsx`: `latestRun.model ?? assigneeAgent.model`, a `model:effort` string per `splitModel` in `packages/db/src/model-routing.ts`). The chain aggregate card prints none, so an operator cannot see which model or effort a running step is on, nor whether it runs on the Codex fast tier.

The data already exists on the Run row: `Run.model` (claimed snapshot, `model:effort`) and `Run.codexServiceTier` (`DEFAULT` | `FAST`). Only the projection is missing: `BoardLatestRun` in `packages/db/src/board-contract.ts` carries `model` but not the tier, and `latestRunProjection` in `packages/api/src/board.ts` does not select it.

Required:
- Add `codexServiceTier` to `BoardLatestRun` and project it from the Run row.
- On the aggregate card, extend the existing frontier run line (and the new repair line from section 1) with the model, effort and, only when the tier is `FAST`, a `fast` marker. Split `model:effort` with `splitModel`; do not re-parse by hand. Example: `run 3 · gpt-5.6-sol · high · fast · running 4m` / `第 3 次运行 · gpt-5.6-sol · high · fast · 已运行 4m`. When the tier is DEFAULT nothing extra is printed. The same line, without elapsed time, applies to a finished run.
- The single-task card keeps its model line; add the `fast` marker there too so the two cards agree.
- Done means: board projection test covers the tier field; card tests cover the fast marker present for FAST and absent for DEFAULT, and the model/effort split on the run line.

## Done means

- Web tests in `apps/web/src/tests/tasks-board.test.tsx` (or the aggregate card tests) cover: repair line present with kind and elapsed while a repair run is active; absent when no repair is active; run line text contains "running" once for an active run, in both locales.
- Board projection test in `packages/api/src/board.test.ts` covers the active-repair field.
- `npm run lint` and typecheck pass.

Route: implementation=senior-dev-luna (contract + projection + UI; UI part is small)

<!-- /agentos:task-brief:v1 -->
Persist the final implementation output for this step through the Anneal task output endpoint.