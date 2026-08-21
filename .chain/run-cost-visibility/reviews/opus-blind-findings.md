# Blind review — run cost visibility (Opus)

Reviewer: review-coordinator-opus, AgentOS run `cmt2gwwuz0az2mp45yl81zd4s`.
Written and committed before the first reviewer's report was opened.

## Range

- base `00b94f9861861d19c5bdc78b57cb5949d82bd730`
- head `047818c63e87177894ccb547679c5e18f80b2655`
- Both resolve; base is an ancestor of head. Reviewed as one integrated diff
  (`git diff 00b94f98 047818c6 -- . ':!.chain'`, 675 lines over 16 source files)
  plus the resulting tree. Direct chain: no `slices/`, so `spec.md` is the whole
  approved authority the chain carries, and it is reachable at head.
- Worktree clean at `ebbc3f4`, which adds only `.chain/` records on top of head.

## Tooling run

- `npm run typecheck` — exit 0.
- `npm run lint` (biome + eslint) — exit 0, 381 files.
- `npm test -w @agentos/db` — exit 0.
- `npm test -w @agentos/api` — exit 0.
- `npm test -w @agentos/web` — exit 0, 371 pass / 0 fail, after
  `npm run build -w @agentos/web`. Without that build,
  `src/tests/bundle-secrets.test.ts` and `src/tests/styles.test.tsx` abort at
  import time with "Build apps/web before running…". That is a pre-existing
  ordering requirement of those two files, not a consequence of this diff, and
  not a finding.
- `RUNNER_WORKSPACE_ROOT` pointed at a fresh `mktemp -d` for every run.
- The `*.dbtest.ts` suites were NOT run. The only reachable PostgreSQL is the
  local server on 5432, and `npm run test:db` drops and recreates what it is
  given; no scratch server was available. Exposure is low: no `*.dbtest.ts`
  exercises `?view=board`, `taskCost`, or the task-detail cost projection
  (`packages/api/src/chain.dbtest.ts:844` reads the chain-steps `latestRun`,
  a different projection this diff does not touch).
- Checks a required tool already ran and passed are not duplicated below.
  No lint, type, or format failure was observed.

## Severity

P0/P1 must-fix. P2 recorded, non-blocking. Every smell finding is labelled a
judgement call and carries a named fix direction.

---

## Standards axis

### OP-1 — P1 — Untranslated user-facing copy in the new cost label

`apps/web/src/lib/format.ts:132` and `:136-138`.

`" est."`, `" input"`, `" cached"` and `" output"` are hardcoded English inside
`usageCostLabel`, which renders on every board card
(`apps/web/src/components/task-card.tsx:188`), every task-detail run row
(`apps/web/src/pages/TaskDetail.tsx:100`) and the task-detail spend pill
(`TaskDetail.tsx:336`).

This is a documented repository standard, not a smell judgement, so it overrides
the smell baseline. The repository ships two full catalogues
(`apps/web/src/locales/en.ts`, `apps/web/src/locales/zh.ts`) and enforces
"the translated UI source has no unapproved user-facing English literals" at
`apps/web/src/tests/i18n-sweep.test.tsx:125`, with the allowlist hard-capped at
31 entries.

Evidence that the enforcer does not reach this code, so its green result is not
a defence: the sweep's `return-copy` rule collects a `TemplateExpression`'s head
and its spans' *literal* parts only (`literalParts`,
`apps/web/src/tests/i18n-sweep.test.tsx:38-41`). `" est."` sits inside a
conditional in a template *span expression*, which that function never
descends into; and the `parts` array at `format.ts:135-140` is a variable
initialiser, which no rule scans at all. `usageCostLabel` matches the rule's
`/Label$/` name test, so the intent was clearly to cover it.

Consequence: a zh-locale operator sees `$1.45 est.` and
`1K input · 100 cached · 50 output` in English on every card and every run row.
The `est.` marker is a hard constraint of this specification ("the 'est.' marker
must appear wherever an estimated figure renders, board and detail alike"), and
it is the one piece of the feature that must be legible.

Fix direction: add `format.usage.estimated`, `format.usage.input`,
`format.usage.cached`, `format.usage.output` to both catalogues and compose the
label through `formatT`, which `format.ts` already uses at `:79` and which is on
the sweep's translation-call list (`i18n-sweep.test.tsx:29`) — so the fix also
restores the enforcer's reach over this function.

### OP-2 — P2 — Silent partial estimate when a priced model reports only some token columns

`packages/db/src/cost.ts:70-77`.

`const cached = session.cachedInputTokens ?? 0` and
`const output = session.outputTokens ?? 0` coerce a *missing* column to zero.
The guard immediately above (`:65-68`) only rejects `cached > input`; it does not
reject an incomplete row. So for a model that IS in the table:

- `outputTokens === null` prices output at zero — the estimate understates.
- `cachedInputTokens === null` prices the entire input at the uncached rate — the
  estimate overstates (10x on the input component, given the table's rates).

Either renders as an ordinary `$X est.`, indistinguishable from a complete one.
`packages/db/src/usage.ts:9-13` is explicit that an absent field means "this
payload said nothing about it — never zero", and the sibling code honours that;
this function is the one place that does not.

Judgement call. Fix direction: treat a null token component on a priced model
exactly as an unpriced model is treated — return `{ costUsd: null }` so the UI
falls back to token counts, which is what the specification already prescribes
for the other incompleteness (Changes §3).

### OP-3 — P2 — The price table's arithmetic hard-codes a Codex-only token model with nothing guarding it

`packages/db/src/cost.ts:18-22` and `:71`.

`uncached = inputTokens - cached` is correct for Codex, where
`usage.cached_input_tokens` is a subset of `usage.input_tokens`. It is wrong for
Claude: `packages/db/src/usage.ts:110-118` builds `cachedInputTokens` as
`cacheReadInputTokens + cacheCreationInputTokens` while `inputTokens` is the
uncached figure — the two are disjoint, so subtracting one from the other is
meaningless. Cache *creation* is also billed above the uncached input rate, not
at a discount, so a single `cachedInputTokensPerMillionUsd` cannot express it.

Currently unreachable: `MODEL_TOKEN_PRICES` holds only the three Codex models,
and Claude sessions always carry `total_cost_usd`, which wins at `cost.ts:57`.
But `MODEL_TOKEN_PRICES` is an open `Record<string, TokenPrices>` and the
specification's opening line is "visible for Claude and Codex alike" — the first
person to add `claude-opus-5` gets silently wrong numbers with no test and no
comment stopping them. The comment at `:63-64` states the Codex subset fact but
does not draw the conclusion that the table is therefore Codex-only.

Judgement call. Fix direction: state the invariant on `MODEL_TOKEN_PRICES` — an
entry is admissible only for a provider whose `cachedInputTokens` is a subset of
`inputTokens` — or give each entry an explicit token model with a separate
cache-creation rate.

### OP-4 — P2 — The task-cost fold is written twice, in two idioms

`packages/api/src/board.ts:100-102` and `packages/api/src/app.ts:2327-2332`.

Both spell the same three-step fold (runs → per-session `sessionUsageCost` →
`sumUsageCosts`), one with `flatMap` and one with `map` + `filter`. Fowler
dispensables / duplicated code: the board and the detail page must never disagree
about a task's total, and nothing but discipline currently keeps them aligned.

Judgement call. Fix direction: export one
`taskUsageCost(runs: Array<{ model: string; session: CostableSession | null }>)`
from `packages/db/src/cost.ts` and call it from both sites.

### OP-5 — P2 — The effort-suffix rule is implemented twice, in two packages

`packages/db/src/cost.ts:41-44` (`modelNameForPricing`) restates
`packages/runner/src/adapters.ts:425-428` (`modelSpec`) — same `lastIndexOf(":")`
split of the same `"<model>[:<effort>]"` grammar, in two packages, with no link
between them. Fowler dispensables / duplicated code, and a live drift risk: if
the suffix grammar changes, pricing silently diverges from what was executed.
The two already differ in a degenerate case (`modelSpec` requires `at > 0`,
`modelNameForPricing` accepts index 0).

Judgement call. Fix direction: keep one implementation — `@agentos/db`'s
`cost.ts` is already a dependency of the API and can be one of the runner — and
have `adapters.ts` consume it.

### OP-6 — P2 — `serializeUsageCost` lives in the board module but serves the task-detail route

`packages/api/src/board.ts:90-93`, imported at `packages/api/src/app.ts:84` and
used at `app.ts:2332` and `:2337` — the `GET /tasks/:taskId` route, which has
nothing to do with the board projection. Fowler couplers / feature envy: the
board module's stated purpose (`board.ts:7-19`) is the board's own wire shape.

Judgement call. Fix direction: move `SerializedUsageCost` and
`serializeUsageCost` next to `UsageCost` in `packages/db/src/cost.ts`, or into a
new api-level `usage-wire.ts` that both routes import.

### OP-7 — P2 — An obscure structural type where a named one already exists

`packages/api/src/board.ts:76`:
`costUsd: Parameters<typeof sessionUsageCost>[1]["costUsd"]`.

`@agentos/db` already exports the exact shape under a name — `CostableSession`
(`packages/db/src/cost.ts:24-29`), whose four fields are precisely the four this
`session` object declares. The indirection cost is visible: it forced
`packages/api/src/board.test.ts:6-8` to add a `session()` builder whose only job
is to satisfy a type that could have been spelled directly.

Judgement call. Fix direction: `session: CostableSession | null`.

### OP-8 — P2 — The board query's governing comments now misdescribe it

`packages/api/src/app.ts:2177-2183` dropped `take: 1`, so the board's poll now
loads every run of every task with four session columns each, instead of one run
per task. That widening is required by Changes §2 and is bounded by
`Run.maxRunsPerTask` plus granted refunds, so the row count is not the finding.

The finding is that both comments that govern this query still describe the
narrow shape and now read as false: `app.ts:2165-2167` ("The projection narrows
the *query* too, not only the response") and `board.ts:9-12` ("returns the whole
Task row plus `assigneeAgent`, `repo` and the latest `Run` *with its Session* —
1.58 MB for 112 cards"). A future reader will size this query from a rationale
that no longer holds.

Judgement call. Fix direction: restate both — the query now fetches every run's
four cost columns because the card total is cumulative — and name the bound.

### OP-9 — P2 — Sole inline `import()` type in the web source

`apps/web/src/lib/format.ts:130` writes
`value: import("./types").UsageCost | null | undefined`. It is the only inline
`import(...)` type in `apps/web/src/{lib,components,pages}`; every other module
uses a top-level `import type`. `types.ts` imports nothing, so there is no cycle
being dodged.

Judgement call. Fix direction:
`import type { UsageCost } from "./types";` at the top of the file.

### OP-10 — P2 — The browser UX fixture was not given `taskCost`

`apps/web/src/tests/fixtures/tc-ux-browser-server.mjs:29` and `:43` build board
rows without `taskCost`, so the manual harness serves `undefined` where the wire
shape is `UsageCost | null`. `task-card.tsx:188` tests `=== null`, so `undefined`
falls through to `usageCostLabel(undefined)` and every card in that harness
renders `—` where it previously rendered nothing. The fixture is untyped `.mjs`,
so neither `tsc` nor the suites catch it — this is why the diff touched seven
other fixtures and missed this one.

Judgement call. Fix direction: add `taskCost: null` to the fixture's row builder.

---

## Spec axis

### OP-11 — P2 — A token list is interpolated into the "spend" sentence

`apps/web/src/pages/TaskDetail.tsx:336`.

Governing text (Changes §3): "When a session has tokens but its model has no
entry in the price table, the UI shows the token counts instead of a dollar
figure - never an unlabeled or partial amount."

Governing text (Changes §2 and §4) places the cumulative figure on the board card
and the per-run figure on the detail run rows. Neither asks for the token
fallback to be fed into the detail page's header stat pill, whose catalogue
entries are sentence templates: `"{amount} spend"`
(`apps/web/src/locales/en.ts:751`) and `"花费 {amount}"`
(`apps/web/src/locales/zh.ts:744`). With an unpriced summand the pill renders
`1K input · 100 cached · 50 output spend` / `花费 1K input · 100 cached · 50 output`.

This is behaviour the diff introduces that the specification did not ask for, and
it is redundant on its own terms: the adjacent pill at `TaskDetail.tsx:337`
already shows the task's token total.

Fix direction: give the header pill its own catalogue key with a distinct
no-dollar-figure case, or keep the pill on dollars only and let the existing
tokens pill carry the counts.

### OP-12 — P2 — The Sessions and Automations views still hide a Codex run's cost

`apps/web/src/pages/Sessions.tsx:458` and
`apps/web/src/pages/Automations.tsx:51`.

Governing text (`spec.md`, opening line): "Every run's money cost is visible for
Claude and Codex alike, and each board card shows its task's cumulative cost
including retries."

Both sites still render the raw provider column —
`session.costUsd === null ? null : money(session.costUsd)` — and neither
`GET /sessions` nor `GET /sessions/:id` was given `usageCost`. For every Codex
session `Session.costUsd` is null, which is the exact condition the Background
section names, so on the session page a Codex run's cost remains as invisible as
it was before this diff.

Recorded rather than adopted as must-fix: the enumerated Changes reach only the
board card (§2) and the task-detail run rows (§4), and a reviewer must not invent
scope. But "Out of scope" does not exclude these two views, and the opening line
is the specification's own governing text — so whether the enumeration or the
headline binds here is a human call, not a mechanical one.

Fix direction, if adopted: expose `usageCost` on the session wire shape the same
way `app.ts:2334-2338` already does for the task-detail nesting, and render both
sites through `usageCostLabel`.

---

## Verified as satisfied, not findings

- Acceptance 1: `packages/db/src/cost.test.ts:8-17`. Arithmetic checks out —
  600k uncached x $5/M + 400k cached x $0.5/M + 100k output x $30/M = $6.2, and
  the effort suffix `:xhigh` is stripped.
- Acceptance 2: `packages/db/src/cost.test.ts:19-32`.
- Acceptance 3: `packages/db/src/cost.test.ts:34-44`. The test name says "Claude"
  while the model is `gpt-5.6-sol:high`; that is the stronger assertion, because
  a Claude model is absent from the table and would pass trivially. Not a finding,
  but the name misdescribes what it proves.
- Acceptance 4: `packages/api/src/board.test.ts:88-97` (sum across a SUCCEEDED
  and a FAILED run, `estimated: true` from one summand) and
  `apps/web/src/tests/tasks-board.test.tsx:33-43` (the `est.` marker and the
  token fallback render).
- Acceptance 5: see Tooling run above.
- Constraint "a provider-reported cost always wins over an estimate ... and is
  never overwritten by one": `cost.ts:57-59` returns before the table is read,
  and nothing in the diff writes `Session.costUsd` — estimation is a read-time
  projection only. Confirmed by grep over the diff: no `session.update`.
- Constraint "editing the price table must never alter provider-reported
  figures": same mechanism.
- Constraint "effort suffixes ... do not change unit price": `cost.ts:41-44`,
  covered by the acceptance-1 test. See OP-5 for the duplication, not the rule.
