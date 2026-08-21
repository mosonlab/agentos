# Sol code review findings

## Authority

- implementation base: `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- delivered head: `047818c63e87177894ccb547679c5e18f80b2655`
- reviewed range: `00b94f9861861d19c5bdc78b57cb5949d82bd730...047818c63e87177894ccb547679c5e18f80b2655`
- specification: `.chain/run-cost-visibility/spec.md`
- revised plan: none; this is a direct chain
- range verification: both commits resolve, base is an ancestor of head, and checkout `HEAD` equalled delivered head before and after review

## Finding counts

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 3 |
| P2 | 1 |

## Findings

### SOL-SPEC-001 — P1 — Missing token components are silently priced as zero

- Location: `packages/db/src/cost.ts:70-75`; governing persistence contract at `packages/db/src/usage.ts:3-7`, `packages/db/src/usage.ts:151-173`
- Governing specification: “Estimation applies to already-recorded sessions as well as new ones” and “the UI shows the token counts instead of a dollar figure - never an unlabeled or partial amount.”
- Problem: a priced model with any token column present receives a dollar estimate even when one or two billing components are unknown. The result is rendered as a complete `$… est.` total although it is only a known-component subtotal.
- Evidence: persisted absence deliberately remains `null` and means that the provider said nothing about the component. `sessionUsageCost` nevertheless maps missing cached input to `0`, missing input to `0`, and missing output to `0` before doing the arithmetic. The existing extractor and tests admit input-only and output-only payloads, and aggregate overflow can also null one column while preserving its siblings. For example, an output-only priced row is charged only for the known output and presented as the session estimate; no marker says that input is unknown. `packages/db/src/cost.test.ts` covers a complete tuple and an unpriced model, but no incomplete priced tuple.
- Required direction: fail closed to `costUsd: null` whenever a priced session lacks any component needed for a complete total, preserving the reported token columns for fallback. Add negative tests for input-only, cached-only, output-only, and one-column-null persisted rows, plus an aggregate test proving no partial dollar survives.

### SOL-SPEC-002 — P1 — Non-zero estimates below half a cent render as zero

- Location: `apps/web/src/lib/format.ts:83-84`, `apps/web/src/lib/format.ts:130-132`; rendered by `apps/web/src/components/task-card.tsx:188` and `apps/web/src/pages/TaskDetail.tsx:100`
- Governing specification: “Every run's money cost is visible for Claude and Codex alike” and “Task detail run rows show per-run cost with the same ‘est.’ marking rule.”
- Problem: valid non-zero estimates smaller than `$0.005` are displayed as `$0.00 est.` on both the board and task detail. The UI therefore states that a run/task cost zero when the new projection computed a non-zero amount.
- Evidence: `usageCostLabel` routes every dollar through `money`, which unconditionally calls `toFixed(2)`. The versioned Luna rate makes this reachable without malformed data: 1,000 uncached input tokens cost `$0.0002`, and many other small token totals remain below the rounding threshold. The formatter test exercises only `$0.42`, so it cannot detect the false-zero rendering.
- Required direction: give usage costs an adaptive small-dollar representation that never renders a positive value as zero, while retaining the `est.` marker. Add formatter and board/detail rendering cases for positive values below `$0.005`, exact zero, and ordinary cent-scale values.

### SOL-SPEC-003 — P1 — The required token fallback can overflow a board card

- Location: `apps/web/src/components/task-card.tsx:182-190`; fixed board geometry at `apps/web/src/components/desktop-board.tsx:32-44`
- Governing specification: “When a session has tokens but its model has no entry in the price table, the UI shows the token counts instead of a dollar figure” and the out-of-scope clause leaves other card geometry unchanged.
- Problem: the new multi-part token fallback is placed in the existing single-line footer with `whitespace-nowrap`, beside a second nowrap timestamp. It cannot shrink or wrap, so ordinary fallback text can extend beyond the card's fixed column instead of remaining legible inside it.
- Evidence: desktop columns are fixed at 250px below 1440px and about 222px at 1440px; column and card padding reduce the content width further. The cost string used by the new test (`1K input · 100 cached · 50 output`) plus the timestamp and footer gaps exceeds that width even after the assignee collapses. The board is `overflow-auto` and the column intentionally supplies no containing overflow, so the cost can widen the scroll content or overlap adjacent presentation. The new web test verifies that the tokens exist in markup but does not verify card bounds.
- Required direction: put token fallback in a bounded wrapping row, or otherwise give it a layout that shows all three counts without widening the card; keep compact dollar totals in the footer if desired. Add a fixed-width DOM/browser regression that asserts the fallback remains within the card at both 250px and the 1440px column width.

### SOL-STD-001 — P2 — Usage labels bypass the formatter locale contract

- Location: `apps/web/src/lib/format.ts:4-15`, `apps/web/src/lib/format.ts:130-140`
- Documented standard: `format.ts` states that provider-free formatting goes through the dictionaries so “`format.ts` holds no English fragments of its own.”
- Problem: the new formatter hard-codes `est.`, `input`, `cached`, and `output`; switching the application to `zh` leaves these user-visible labels in English. This is a hard local documented-standard violation, not a Fowler judgement call.
- Evidence: the function never calls `formatT`, and the dictionaries contain no corresponding usage-cost keys. `apps/web/src/tests/format-locale.test.tsx:117-124` tests the English strings only and does not compare locale output.
- Required direction: add paired dictionary entries and generate the estimate marker and token labels through the registered formatter translation seam. Add explicit `en` and `zh` assertions with placeholder parity.

## Standards-axis dispositions

- Correctness and repository conventions produced `SOL-SPEC-001`, `SOL-SPEC-002`, `SOL-SPEC-003`, and `SOL-STD-001`; no security finding was confirmed.
- No Fowler smell finding survived verification. The harness candidate about polling all historical runs was rejected: the query selects only five small usage fields, task history is bounded by the documented maximum of 100 runs, and no concrete latency or resource failure was demonstrated. The cumulative-all-runs requirement itself necessitates access to that history; a different aggregate design is an optimization question without failure evidence here.
- Exact-head lint, typecheck, format, build, unit, database preflight, and API database results were not converted into duplicate findings. The implementation output reported `MERGE GATE: PASS 047818c63e87177894ccb547679c5e18f80b2655`; the specification harness redundantly reconfirmed the same verdict after its first credential-guarded attempt, but this review does not treat that duplicate as new acceptance evidence.

## Harness and focused verification

Both required candidate-finding passes completed from delivered `HEAD` with exit status 0:

```text
codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from 00b94f9861861d19c5bdc78b57cb5949d82bd730 to 047818c63e87177894ccb547679c5e18f80b2655. Standards axis only. [standards and Fowler rules]" </dev/null > /tmp/run-cost-visibility-standards.log 2>&1 &
codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from 00b94f9861861d19c5bdc78b57cb5949d82bd730 to 047818c63e87177894ccb547679c5e18f80b2655. Specification axis only. [full approved specification text]" </dev/null > /tmp/run-cost-visibility-spec.log 2>&1 &
```

Coordinator-run narrow regressions used an isolated `RUNNER_WORKSPACE_ROOT`:

```text
node --import tsx --test packages/db/src/cost.test.ts packages/api/src/board.test.ts
# 17 passed, 0 failed

TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --import tsx --test apps/web/src/tests/format-locale.test.tsx apps/web/src/tests/task-detail.test.tsx apps/web/src/tests/tasks-board.test.tsx
# 60 passed, 0 failed
```

The first narrow-test attempt did not enter test bodies because this fresh checkout lacked `tsx`. After the repository-required `npm ci && npm run db:generate && npm run build -w @agentos/db` bootstrap, the same commands passed. `git diff --check` passed. Official model pages matched the repository's Sol, Terra, and Luna base input/cached-input/output rates; no price-table value finding was confirmed.
