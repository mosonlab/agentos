Compact the board cards so every card reads top-down as identity, position, live state, and outcome, with nothing shown twice.

Background: A running chain aggregate card today spends ten lines on: a title clamped at three lines with an ellipsis (`board-card-shell.tsx` `TITLE` `line-clamp-3`, which exists to bound 2KB failure text, not one-sentence titles); `Step 5/7` and a `Running` pill on one row and the step name on the next; a `Filter steps` button that duplicates the `Filter steps` entry already in the card's row menu; a run line `run 1 · openai-codex/gpt-5.6-luna · max · running 7m 8s` where `running` repeats the amber dot and the pill, and the `openai-codex/` prefix repeats what the model name already says; and a footer `Cost: $13.74 est.` plus `1h ago`. The card carries no pull request link although the run has `pullRequestUrl`. Member cards (shown after filtering) render the same chain name inside a fully wrapping pill, so the same name is truncated on one card and complete on another. Backlog is the only column sorted oldest-first (`apps/web/src/lib/board.ts` `orderColumn`); the operator wants newest-first everywhere.

Changes:
1. Title: remove `line-clamp-3` from `TITLE` in `apps/web/src/components/board-card-shell.tsx` so titles wrap in full. `FAILURE` keeps its clamp. Applies to aggregate and member cards alike.
2. Aggregate card (`chain-aggregate-card.tsx`): merge the progress row and the frontier row into one line `Step {current}/{total} · {frontier title}` (frontier title wraps, no clamp beyond what the row already has). Render the state `Pill` only when the aggregate state is not `running` (parked-unactivated, waiting-on-predecessor, idle, settled keep it; running drops it because the run line's dot carries the state). Remove the `Filter steps` button; the row-menu entry stays.
3. Run line (`run-line.tsx`): change locale `tasks.card.runningDuration` so an active run shows only the duration (`7m 8s`), never the word `running`; strip a `<provider>/` prefix from the displayed model on cards (`openai-codex/gpt-5.6-luna` renders as `gpt-5.6-luna`). Keep the full model string on the task detail page.
4. Footer (aggregate and member cards): left slot shows the pull request as an external link labelled `#<number>` when the newest run has `pullRequestUrl`, otherwise empty; right slot shows `{amount} · {time ago}` where amount is the bare money value (drop `Cost:` and `est.` from `tasks.aggregate.cost` and the member-card cost label) and time stays the card's existing `createdAt`-based `timeAgo`. Member cards keep their assignee chip in the left slot before the PR link.
5. API projection: add `pullRequestUrl: string | null` to `BoardLatestRun` in `packages/api/src/board.ts` (`latestRunProjectionFromRun`) and to the board contract type and its `ExactKeys` assertions.
6. Column order: `orderColumn` in `apps/web/src/lib/board.ts` returns newest-first for every column including Backlog; delete the Backlog special case and update its comment.
7. Locale: update or add keys in every locale file and the i18n registrations.

Out of scope: the latest-agent-message row (separate card); card widths, column layout, drag and drop; the task detail page; the row menu contents; any change to sorting on the API side.

Constraints: use existing tokens and primitives; do not add ad-hoc sizes. Keep `data-*` hooks used by tests (`data-chain-progress`, `data-chain-frontier`, `data-run-line`) or update the tests that read them in the same change. Run `npm run lint` (not `npx biome`) before handing off.

Acceptance:
- `chain-aggregate-board.test.tsx`: a 60-character title renders without a `line-clamp` class and is fully present in the DOM; a running aggregate renders no state pill and no `Filter steps` button, while a parked aggregate renders the pill; the progress and frontier title are in one row; the footer contains an `a[href]` to the PR URL with text `#<number>` and the bare cost.
- `run-line.test.tsx`: an active run renders `7m 8s`-style text without the substring `running`; the model `openai-codex/gpt-5.6-luna` renders as `gpt-5.6-luna`.
- `board.test.tsx`: Backlog column order is newest-first, ties broken by id ascending.
- `packages/api` board contract test passes with `pullRequestUrl` present on `latestRun`.
- `npm run lint`, `apps/web` build and full test suite, and `packages/api` unit tests pass.

Route: implementation=frontend-dev - board card layout, locale and a two-field projection change are frontend work
