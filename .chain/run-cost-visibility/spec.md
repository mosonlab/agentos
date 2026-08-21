Every run's money cost is visible for Claude and Codex alike, and each board
card shows its task's cumulative cost including retries.

Background: Session cost comes from `extractUsage` over FINAL_OUTPUT session
events (packages/db/src/usage.ts). Claude's terminal `result` event carries
`total_cost_usd` and a per-model `modelUsage` breakdown; Codex's
`turn.completed` carries only `usage.{input_tokens, cached_input_tokens,
output_tokens}` and no cost field, so `Session.costUsd` stays null for every
Codex run and the card (apps/web/src/components/task-card.tsx) hides the cost
line when `latestRun.costUsd` is null. The model used is recorded on
`Run.model` as `<model>[:<effort>]` (packages/runner/src/adapters.ts) and the
token counts are persisted on the session, so cost is computable from a price
table.

Changes:
1. A repository-versioned price table (model to USD unit prices for input,
   cached input, and output tokens) used to estimate cost for sessions that
   report tokens without a provider-reported cost. Estimation applies to
   already-recorded sessions as well as new ones, and an estimated cost is
   stored or exposed as distinct from a provider-reported one.
2. Board card cost shows the task's cumulative cost across all its runs,
   retries and failures included, marked "est." whenever any component is
   estimated; the per-run breakdown stays on the task detail page.
3. When a session has tokens but its model has no entry in the price table,
   the UI shows the token counts instead of a dollar figure - never an
   unlabeled or partial amount.
4. Task detail run rows show per-run cost with the same "est." marking rule.

Out of scope: chain-level cost aggregation views; board ordering, chain badge,
duration, or any other card work from the preceding board chain; provider
billing or authentication changes; changes to how tokens are captured from
either CLI.

Constraints: a provider-reported cost always wins over an estimate for the
same session and is never overwritten by one; editing the price table must
never alter provider-reported figures; the "est." marker must appear wherever
an estimated figure renders, board and detail alike; effort suffixes on
`Run.model` do not change unit price - the table is keyed by model, with the
suffix stripped for lookup.

Acceptance:
1. Automated test: a Codex-shaped session with tokens and a model present in
   the price table yields an estimated cost, flagged as estimated, equal to
   the table arithmetic (cached input priced at the cached rate).
2. Automated test: a session whose model is absent from the price table
   yields no dollar figure and surfaces token counts.
3. Automated test: a Claude-shaped session with `total_cost_usd` is unchanged
   by the price table.
4. Automated test: a task's card cost equals the sum across all its runs,
   including failed ones, and carries "est." when any summand is estimated.
5. Existing db, api, and web suites are green (scratch RUNNER_WORKSPACE_ROOT
   and scratch TEST_DATABASE_URL per repository testing rules).
