# Feature brief: Costs dashboard v2 (layout, Today window, by-model, cache and waste rates)

The Costs page presents spend as a two-column dashboard with a Today window, a
by-model breakdown, per-agent cache and waste rates, and a wasted-spend headline
figure.

Background: `GET /projects/:projectId/costs` (`packages/api/src/app.ts`, handler
around the `readProjectCosts` call) accepts only `days` from
`COSTS_RANGE_DAYS = [7, 30, 90]` and refuses anything else with 400.
`packages/api/src/costs.ts` builds the window with `costsWindowStart` /
`costsWindowEnd` — both pure UTC — buckets every settled run by
`startedAt.toISOString().slice(0, 10)`, and returns `CostsReport`: `totalUsd`,
`estimatedUsd`, `runCount`, `costUnavailableRuns`, `avgUsd`, `daily`
(`{ date, byAgent }`), `byAgent` (`agent`, `usd`, `runs`,
`costUnavailableRuns`, `avgUsd`) and `topRuns`. The detail query selects
`id, model, subagentModel, startedAt, agent, task, session{ nativeChildUsed,
costUsd, inputTokens, cachedInputTokens, outputTokens }`; `Run.status` is used
only in the `where` filter (`terminalRunStatuses` =
SUCCEEDED, FAILED, TIMED_OUT, CANCELLED, LOST) and never reaches the aggregate.
`apps/web/src/pages/Costs.tsx` renders one vertical `STACK`: three `Metric`
tiles, an estimated/unavailable hint line, the stacked-by-agent
`DailySpendChart`, a by-agent table, and a top-runs table.

Pricing and capture are settled upstream and are not this chain's work.
`packages/db/src/cost.ts` prices from the canonical token triple; provider cost
is authoritative when present. `packages/db/src/usage.ts` extracts cost from
Claude (`total_cost_usd`, falling back to the `modelUsage` per-model sum) and
from PI (`agentosPiUsage.costNanoUsd`); Codex reports no cost anywhere, so Codex
runs are priced from `MODEL_TOKEN_PRICES` and flagged `estimated`. Sessions whose
run used native implementation children carry `Session.nativeChildUsed`, and
`sessionUsageCost` prices such an unsplit aggregate at the pinned child model
rate. Consequently: no pricing-table entries are needed for Claude or PI, and
mixed-model pricing already exists. The residual unpriced population is runs
that reported neither cost nor tokens; they are already surfaced as
`costUnavailableRuns` and must stay visible.

What is missing is entirely read-side and presentational: no Today window, no
timezone-aware bucketing, no by-model grouping, no cache metric, no distinction
between spend on runs that succeeded and spend on runs that did not, and a
single-column layout whose three tiles occupy the space the new breakdowns need.

Changes:
1. The range control gains Today alongside 7/30/90 days: `COSTS_RANGE_DAYS`
   becomes `[1, 7, 30, 90]` and `COSTS_RANGES` in `Costs.tsx` matches, with the
   1-day option labelled Today through the existing localization keys.
2. The endpoint requires an IANA timezone query parameter. Window bounds and
   every daily bucket key are computed in that timezone rather than in UTC:
   `costsWindowStart` returns the local midnight `days - 1` days back,
   `costsWindowEnd` returns the next local midnight, and a bucket key is the
   local calendar date of `startedAt`. A missing, empty, or unrecognized
   timezone is rejected with 400 and a message naming the parameter; there is no
   UTC fallback and no clamping. The web client always sends the browser
   timezone resolved from `Intl`.
3. `CostsReport` gains `byModel`: one entry per distinct `Run.model` string,
   used verbatim including any provider prefix and effort suffix (for example
   `openai-codex/gpt-5.6-luna:max`), with `usd`, `runs`, and
   `costUnavailableRuns`. Runs whose session has `nativeChildUsed` true do not
   go under their root model — their tokens are a blend of root and pinned child
   model — but into one explicit `mixed` bucket, emitted only when at least one
   such run is in the window. No run is silently dropped from `byModel`, and the
   sum of `byModel[].usd` equals `totalUsd`.
4. `CostsReport` gains cache and waste figures, derived by adding `status` to
   the detail select (the aggregate currently never sees it):
   - `cachePct` per `byAgent` entry: summed `cachedInputTokens` over summed
     `inputTokens` across that agent's runs whose session reports both columns
     non-null, `inputTokens` being cache-inclusive. Runs missing either column
     enter neither numerator nor denominator; an agent with no such run reports
     null, never 0.
   - `wastedUsd` per `byAgent` entry and `wastedUsd` at the report top level:
     the priced spend of runs whose terminal status is not SUCCEEDED, that is
     FAILED, TIMED_OUT, CANCELLED, or LOST. Per-agent waste percentage is
     derived on the client from `wastedUsd` over `usd`.
5. The page becomes two columns: the left column holds the daily chart then the
   top-runs table; the right column holds the by-agent card then a new by-model
   card. The layout collapses to one column at narrow widths using the existing
   responsive utilities rather than a new breakpoint system.
6. The three `Metric` tiles are replaced by one summary row carrying total
   spend, run count, average per priced run, and wasted spend. The existing
   estimated-share and cost-unavailable hint line stays.
7. The by-agent table gains a Cache % column and a Waste % column, each showing
   an em dash where the underlying figure is null rather than 0%.
8. The by-model card renders one horizontal stacked bar over the model keys plus
   one row per key with spend and share of `totalUsd`, using the existing series
   colour assignment helpers so identity is stable within a render.

Out of scope: pricing-table entries and any change to `MODEL_TOKEN_PRICES`;
runner adapters, usage ingest, `packages/db/src/usage.ts`, and every write path;
splitting cache read from cache write into separate columns; per-chain,
per-task, or per-repo cost views; spend threshold notifications; backfills or
migrations of historical rows; adding new schema columns; response caching or
ETag work on the costs endpoint; changing the 60-second poll interval.

Constraints:
- No silent degradation anywhere: an invalid timezone is a 400, not UTC; a
  missing token column is null, not 0; a run outside the computed buckets keeps
  the existing loud failure rather than being dropped.
- The existing reconciliation invariants in `aggregateCosts` — grouped versus
  detailed run counts must agree, and every priced run must land in a bucket —
  survive the timezone change unchanged.
- Estimated-versus-reported signalling and the cost-unavailable count stay
  visible in the new layout; unpriceable spend is never rendered as zero.
- Every user-facing string goes through the existing localization mechanism and
  is added to both `en` and `zh` locale files; the i18n sweep test must stay
  green.
- Amounts remain decimal strings on the wire at the existing precision;
  percentages are computed from those totals, not from rounded display values.

Acceptance:
- `packages/api/src/costs.dbtest.ts`: a request without a timezone parameter and
  a request with an unrecognized one both return 400; two requests differing
  only in timezone place a run seeded near local midnight in different `daily`
  buckets; `days=1` returns exactly one bucket, the current day in the supplied
  timezone; the existing reconciliation test against a raw SQL sum still passes.
- Unit tests over `aggregateCosts`: on a fixture mixing models, `byModel` keys
  are the verbatim model strings including effort suffixes, a `nativeChildUsed`
  run lands in the `mixed` bucket and not under its root model, and the
  `byModel` spend sum equals `totalUsd`.
- Unit tests over `aggregateCosts`: per-agent `cachePct` matches a hand-computed
  fixture value, is null when no run of that agent reports both token columns,
  and per-agent plus top-level `wastedUsd` equal the hand-computed spend of the
  non-SUCCEEDED terminal runs in the fixture.
- `apps/web/src/tests/costs.test.tsx` covers the two-column structure, the
  single summary row, the Today option in the range control, and the Cache %
  and Waste % columns including their em-dash rendering.
- `npm run lint`, the typecheck, the web test suite, and the api test and dbtest
  suites are green.

Route: implementation=frontend-dev - redesigned page; the API additions are read-only aggregation over existing columns.
