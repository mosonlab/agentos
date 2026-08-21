# Adjudicated review — run cost visibility

Closed. Every finding from both reports has a disposition below; nothing here is
an open-ended instruction to review further.

## Range and identities

- implementation base: `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- delivered head: `047818c63e87177894ccb547679c5e18f80b2655` (one commit,
  `feat: show estimated cumulative run costs`)
- Both resolve; base is an ancestor of head. Direct chain — no `slices/`
  directory, so `.chain/run-cost-visibility/spec.md` at head is the sole
  authority, and it is reachable in the tree at head.
- Report A (first reviewer): `.chain/run-cost-visibility/reviews/sol-findings.md`,
  Sol / `codex exec review -m gpt-5.6-sol`, committed `ebbc3f4`.
  0 P0, 3 P1, 1 P2.
- Report B (blind, independent):
  `.chain/run-cost-visibility/reviews/opus-blind-findings.md`,
  review-coordinator-opus, session `cmt2gwwuz0az2mp45yl81zd4s`, committed
  `d02e10c` **before** `sol-findings.md` was opened. 0 P0, 1 P1, 11 P2.
- Contradictions requiring a human ruling: **none**. See "Near-miss checked"
  below for the one place the two reports touch the same code with opposite
  conclusions, and why it is not a contradiction.

## Merge matrix applied

| Final ID | Report A | Report B | Rule | Severity |
| --- | --- | --- | --- | --- |
| MFX-01 | SOL-SPEC-001 (P1) | OP-2 (P2) | both → higher severity | **P1** |
| MFX-02 | SOL-STD-001 (P2) | OP-1 (P1) | both → higher severity | **P1** |
| MFX-03 | SOL-SPEC-002 (P1) | — | A only → verified, adopted | **P1** |
| MFX-04 | SOL-SPEC-003 (P1) | — | A only → verified, adopted | **P1** |
| REC-01 | — | OP-3 (P2) | B retained by default | P2 |
| REC-02 | — | OP-4 (P2) | B retained by default | P2 |
| REC-03 | — | OP-5 (P2) | B retained by default | P2 |
| REC-04 | — | OP-6 (P2) | B retained by default | P2 |
| REC-05 | — | OP-7 (P2) | B retained by default | P2 |
| REC-06 | — | OP-8 (P2) | B retained by default | P2 |
| REC-07 | — | OP-9 (P2) | B retained by default | P2 |
| REC-08 | — | OP-10 (P2) | B retained by default | P2 |
| REC-09 | — | OP-11 (P2) | B retained by default | P2 |
| REC-10 | — | OP-12 (P2) | B retained by default | P2 |

Every finding in both reports appears exactly once above. Report A: 4 of 4.
Report B: 12 of 12.

## Near-miss checked, not a contradiction

Report A explicitly rejects a candidate about the board query: "The harness
candidate about polling all historical runs was rejected: the query selects only
five small usage fields, task history is bounded by the documented maximum of 100
runs, and no concrete latency or resource failure was demonstrated."

Report B's OP-8 touches the same code (`packages/api/src/app.ts:2177-2183`, the
removal of `take: 1`) but does not assert the defect Report A rejected. OP-8
states in terms: "The widening is required by Changes §2 and is bounded by
`Run.maxRunsPerTask` plus granted refunds, so the row count is not the finding."
Its defect is that the two comments governing that query — `app.ts:2165-2167`
and `board.ts:9-12` — still describe the narrow one-run shape and now read as
false. The two reports agree on the performance question and were never in
conflict, so the contradiction rule does not fire and no human ruling is needed.

---

# Must-fix list

Four items, all P1. No P0. Fix all four on top of `047818c6`; the fixed head is
then the subject of regression verification.

## MFX-01 — P1 — Missing token components are silently priced as zero

Sources: SOL-SPEC-001 (P1) and OP-2 (P2). Same defect, same location; adopted at
the higher severity.

- Location: `packages/db/src/cost.ts:70-77`.
- Governing text: "When a session has tokens but its model has no entry in the
  price table, the UI shows the token counts instead of a dollar figure - never
  an unlabeled or partial amount." (spec.md, Changes §3.)
- Defect: `const cached = session.cachedInputTokens ?? 0` and
  `const output = session.outputTokens ?? 0` coerce an *absent* column to zero,
  and `session.inputTokens === null ? 0 : …` does the same for input. The guard
  above at `:65-68` rejects only `cached > input`, never an incomplete row. A
  priced model with any one token column present therefore receives a dollar
  estimate built from a subset of its billing components, rendered as an ordinary
  `$X est.` with nothing marking it incomplete.
- Direction of error, both ways: a null `outputTokens` understates; a null
  `cachedInputTokens` prices the whole input at the uncached rate, which
  overstates the input component tenfold at this table's rates.
- Evidence: `packages/db/src/usage.ts:3-7` is explicit that absence means "this
  payload said nothing about it — never zero", and `extractUsage`
  (`usage.ts:144-178`) guards each of the three fields independently, so
  input-only, cached-only and output-only rows are admissible by construction.
  `packages/db/src/cost.test.ts` covers a complete tuple and an unpriced model
  and has no incomplete-priced case.
- Required fix: fail closed — return `costUsd: null` whenever a priced session
  lacks any component needed for a complete total, keeping the reported token
  columns so the UI falls back to counts, which is what Changes §3 already
  prescribes for the other kind of incompleteness.
- Required tests: negative cases for input-only, cached-only and output-only
  priced rows, plus an aggregate case proving no partial dollar survives
  `sumUsageCosts`.

## MFX-02 — P1 — Untranslated `est.`, `input`, `cached` and `output` labels

Sources: OP-1 (P1) and SOL-STD-001 (P2). Same defect; adopted at the higher
severity. Two independent documented standards are violated, one cited by each
report, and both are recorded here.

- Location: `apps/web/src/lib/format.ts:132` and `:136-138`. Rendered by
  `apps/web/src/components/task-card.tsx:188`,
  `apps/web/src/pages/TaskDetail.tsx:100` and `TaskDetail.tsx:336`.
- Standard 1, local and explicit (Report A): `apps/web/src/lib/format.ts:14-15`
  states of its own module — "Provider-free, the module answers in English
  through the same dictionaries, so `format.ts` holds no English fragments of its
  own." `usageCostLabel` hard-codes four of them and never calls `formatT`.
- Standard 2, repository-wide (Report B):
  `apps/web/src/tests/i18n-sweep.test.tsx:125`, "the translated UI source has no
  unapproved user-facing English literals", against two full catalogues
  (`apps/web/src/locales/en.ts`, `zh.ts`) and an allowlist capped at 31 entries.
- Why the green sweep is not a defence: its `return-copy` rule collects a
  `TemplateExpression`'s head and its spans' *literal* parts only
  (`i18n-sweep.test.tsx:38-41`). `" est."` sits inside a conditional in a template
  *span expression*, which that function never descends into, and the `parts`
  array at `format.ts:135-140` is a variable initialiser that no rule scans.
  `usageCostLabel` matches the rule's `/Label$/` name test, so coverage was
  clearly intended.
- Consequence: a zh-locale operator sees `$1.45 est.` and
  `1K input · 100 cached · 50 output` in English on every board card and every
  task-detail run row. The `est.` marker is a hard constraint of this
  specification and is the one part of the feature that must be legible.
- Required fix: add paired `en`/`zh` catalogue entries for the estimate marker
  and the three token labels, and compose the label through `formatT` — already
  used in this module at `:79` and on the sweep's translation-call list
  (`i18n-sweep.test.tsx:29`), so the fix also restores the enforcer's reach over
  this function.
- Required tests: explicit `en` and `zh` assertions with placeholder parity;
  `apps/web/src/tests/format-locale.test.tsx:117-124` currently asserts the
  English strings only.

## MFX-03 — P1 — Non-zero estimates below half a cent render as `$0.00`

Source: SOL-SPEC-002 (P1), Report A only. Verified against the code and the
authority before adoption.

- Location: `apps/web/src/lib/format.ts:83-84` and `:130-132`; rendered by
  `apps/web/src/components/task-card.tsx:188` and
  `apps/web/src/pages/TaskDetail.tsx:100`.
- Governing text: "Every run's money cost is visible for Claude and Codex alike"
  and "Task detail run rows show per-run cost with the same 'est.' marking rule."
- Verification: `money` is
  `` value === null || value === undefined ? "—" : `$${Number(value).toFixed(2)}` ``
  — an unconditional `toFixed(2)`. `usageCostLabel:132` routes every dollar figure
  through it. Reachability confirmed against the shipped table: `gpt-5.6-luna` at
  `$0.2` per million uncached input tokens makes a 1,000-token session cost
  `$0.0002`, which renders `$0.00 est.` The UI then asserts a run cost nothing
  when the new projection computed a positive amount.
- Scope note added in adjudication: the `toFixed(2)` behaviour predates this diff,
  but this diff is what makes sub-cent amounts routine, because provider-reported
  Claude costs are cent-scale while Codex estimates on the cheap models are not.
  The fix is in scope; `money`'s two other call sites
  (`apps/web/src/pages/Sessions.tsx:458`, `Automations.tsx:51`) must keep
  rendering correctly whichever way it is implemented.
- Required fix: give usage costs a small-dollar representation that never renders
  a positive value as zero, while retaining the `est.` marker.
- Required tests: formatter and board/detail rendering cases for a positive value
  below `$0.005`, for exact zero, and for an ordinary cent-scale value.

## MFX-04 — P1 — The required token fallback overflows the board card footer

Source: SOL-SPEC-003 (P1), Report A only. Verified against the code and the
authority before adoption.

- Location: `apps/web/src/components/task-card.tsx:182-190`; geometry at
  `apps/web/src/components/desktop-board.tsx:43`.
- Governing text: "When a session has tokens but its model has no entry in the
  price table, the UI shows the token counts instead of a dollar figure", and the
  out-of-scope clause, which leaves the preceding chain's card geometry
  unchanged.
- Verification: `TASK_FOOT` (`task-card.tsx:45`) is
  `flex items-center gap-[10px] text-[11.5px]` with **no** `flex-wrap`. Its
  children are the assignee group, a `flex-1` spacer, the new cost span with
  `whitespace-nowrap`, and the timestamp span with `whitespace-nowrap`.
  `BOARD_GRID` fixes columns at 250px below 1440px and about 222px at and above
  it; `TASK_CARD` (`:25`) adds `px-[14px]`, leaving roughly 222px and 194px of
  content width. The assignee button collapses (`min-w-0` plus
  `overflow-hidden text-ellipsis`, `:83-85`) and the spacer collapses to zero,
  but the 13px robot icon, three 10px gaps, and the two nowrap spans are
  irreducible. The string the new test itself uses,
  `1K input · 100 cached · 50 output`, is 33 characters at 11.5px; even at a
  conservative 5px per character that is ~165px, and with the timestamp and the
  fixed 43px of icon and gaps the row cannot fit either column width. Realistic
  counts (`1.3M input · 450K cached · 120K output`) are wider still. `TASK_CARD`
  sets no `overflow-hidden`, and `BOARD` is `overflow-auto`, so the row spills
  past the card border into the scroller.
- The new test `apps/web/src/tests/tasks-board.test.tsx:36-42` asserts the three
  substrings are present in the markup and asserts nothing about bounds, which is
  why this reached the delivered head.
- Required fix: give the token fallback a bounded, wrapping layout that shows all
  three counts inside the card, or another layout that does not widen the card.
  Compact dollar totals may stay on the footer line.
- Required tests: a fixed-width regression asserting the fallback stays within
  the card at both the 250px and the 1440px column widths.

---

# Recorded, non-blocking (P2)

These do not block the fix phase or human review. Full text, evidence and fix
directions are in `.chain/run-cost-visibility/reviews/opus-blind-findings.md`
under the cited IDs.

- **REC-01 (OP-3)** — `packages/db/src/cost.ts:18-22,71`. The price table's
  arithmetic hard-codes the Codex token model (`uncached = input - cached`) with
  nothing preventing a Claude entry, for which `usage.ts:110-118` builds
  `cachedInputTokens` as a value *disjoint* from `inputTokens`. Unreachable today;
  a trap for whoever acts on the specification's "Claude and Codex alike".
  Note: fixing MFX-01 does not close this — a Claude row has all three columns
  present and would still be mispriced.
- **REC-02 (OP-4)** — the task-cost fold is written twice, in two idioms
  (`packages/api/src/board.ts:100-102`, `packages/api/src/app.ts:2327-2332`).
  Board and detail must never disagree about a task's total.
- **REC-03 (OP-5)** — the effort-suffix rule is implemented twice, in two
  packages (`packages/db/src/cost.ts:41-44`,
  `packages/runner/src/adapters.ts:425-428`), already differing in a degenerate
  case. Drift here silently decouples pricing from what was executed.
- **REC-04 (OP-6)** — `serializeUsageCost` lives in the board module
  (`packages/api/src/board.ts:90-93`) but serves the task-detail route
  (`app.ts:2332,2337`).
- **REC-05 (OP-7)** — `packages/api/src/board.ts:76` spells
  `Parameters<typeof sessionUsageCost>[1]["costUsd"]` where `@agentos/db` already
  exports `CostableSession`; the indirection forced a builder into
  `board.test.ts:6-8`.
- **REC-06 (OP-8)** — the two comments governing the board query
  (`packages/api/src/app.ts:2165-2167`, `packages/api/src/board.ts:9-12`) still
  describe the pre-`take: 1`-removal shape and now read as false.
- **REC-07 (OP-9)** — `apps/web/src/lib/format.ts:130` holds the only inline
  `import(...)` type in the web source; there is no cycle to dodge.
- **REC-08 (OP-10)** — `apps/web/src/tests/fixtures/tc-ux-browser-server.mjs:29,43`
  was not given `taskCost`, so the manual browser harness renders `—` on every
  card. Untyped `.mjs`, so no tool catches it.
- **REC-09 (OP-11)** — `apps/web/src/pages/TaskDetail.tsx:336` interpolates the
  token fallback into the sentence templates `"{amount} spend"` /
  `"花费 {amount}"`, and the adjacent pill at `:337` already shows the token
  total. Behaviour the specification did not ask for.
- **REC-10 (OP-12)** — `apps/web/src/pages/Sessions.tsx:458` and
  `apps/web/src/pages/Automations.tsx:51` still render the raw provider column, so
  a Codex run's cost stays invisible there. Recorded rather than adopted: the
  enumerated Changes reach only the board card (§2) and the task-detail run rows
  (§4), and a reviewer must not invent scope — but "Out of scope" does not exclude
  these views and the specification's opening line does cover them, so whether the
  enumeration or the headline binds is a human call.

---

# Verification state at the delivered head

Established by Report B before the reports were merged, and not re-derived from
either report's claims.

- `npm run typecheck` — exit 0.
- `npm run lint` (biome + eslint) — exit 0, 381 files.
- `npm test -w @agentos/db` — exit 0.
- `npm test -w @agentos/api` — exit 0.
- `npm test -w @agentos/web` — exit 0, 371 pass / 0 fail, after
  `npm run build -w @agentos/web`. Without that build,
  `src/tests/bundle-secrets.test.ts` and `src/tests/styles.test.tsx` abort at
  import time by design; pre-existing, not a finding.
- `RUNNER_WORKSPACE_ROOT` was a fresh `mktemp -d` for every run.
- The `*.dbtest.ts` suites were **not** run. The only reachable PostgreSQL was the
  local server on 5432; `npm run test:db` drops and recreates what it is given and
  the repository's testing red line forbids pointing it there. Exposure is low:
  no `*.dbtest.ts` exercises `?view=board`, `taskCost`, or the task-detail cost
  projection. This gap is stated rather than papered over, and remains open going
  into regression verification.
- Acceptance items 1-4 have passing automated tests at the delivered head
  (`packages/db/src/cost.test.ts:8-17`, `:19-32`, `:34-44`;
  `packages/api/src/board.test.ts:88-97`;
  `apps/web/src/tests/tasks-board.test.tsx:33-43`). MFX-01 and MFX-04 are defects
  those tests do not reach, not failures of them.
- The constraints "a provider-reported cost always wins over an estimate and is
  never overwritten by one" and "editing the price table must never alter
  provider-reported figures" hold: `cost.ts:57-59` returns before the table is
  read, and nothing in the diff writes `Session.costUsd` — estimation is a
  read-time projection only.
