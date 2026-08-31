### Goal
Chain aggregate cards on the board show the frontier run's full metadata (model, effort, status, elapsed) without truncation, wrapping onto a following line when the card is too narrow.

### Background
`apps/web/src/components/run-line.tsx` (`RunLine`) renders the run row for both task cards and chain aggregate cards. Aggregate cards pass `showModel`, so `runDetails` becomes `model · effort [· fast] · status · elapsed` (built via `splitModel(run.model)` from stored strings such as `claude-opus-5:high`). The details sit in a span carrying `overflow-hidden text-ellipsis` inside a container carrying `whitespace-nowrap`. At board column width the row truncates right after the effort, e.g. `run 1 · claude-opus-5 · high · runn…` (production screenshot, 2026-08-31), hiding the status and the elapsed time - the two live values the row exists to show. Task cards are unaffected: they render the model on their own wrapping row and call `RunLine` without `showModel`.

### Changes
1. In `RunLine`, the details text wraps instead of truncating: the status dot and `run N` stay together as the leading token on the first line; the details continue onto following lines, breaking preferentially at the ` · ` separators, with `[overflow-wrap:anywhere]` as the fallback for a single over-long token such as a long model id.
2. No ellipsis on the run row: the complete string is always rendered and visible.
3. Call sites without `showModel` (task cards) render exactly as before; the aggregate card's row container keeps its existing flex-wrap behavior.

### Out of scope
- No change to what the row says: `runDetails` composition, the running-status dedupe (`hideStatus`), badge and tone logic.
- No change to `RunPill`, the task-card model row, card footers, or card geometry constants.
- No i18n key changes.

### Constraints
- Both locales (en, zh) stay fully visible under the same layout rules.
- Wrapping must not widen the card: the column-bounded `grid-cols-[minmax(0,1fr)]` reasoning documented in `task-card.tsx` still applies.

### Acceptance
- A component test renders `RunLine` with `showModel` and a long model/effort/status/elapsed combination and asserts the complete details text is present, the details span carries neither `text-ellipsis` nor `overflow-hidden`, the nowrap constraint no longer applies to the details path, and `run N` remains the first text node after the dot.
- Existing `run-line`, `task-card`, and `chain-aggregate-card` tests stay green.
- `npm run lint` green; the web test suite green.