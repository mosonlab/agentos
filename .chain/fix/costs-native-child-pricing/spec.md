Goal: the cost of an implementation Run whose root model is gpt-6-astra is not under-reported because its native children run gpt-5.6-luna.

Background: `packages/db/src/cost.ts` prices an aggregate session with native children at `NATIVE_CHILD_PRICING_MODEL` (luna) rates for the whole session, and `packages/api/src/costs.ts` mirrors that. That was tolerable when the root was gpt-5.6-sol; with the executioner on gpt-6-astra (10 / 1 / 50 USD per 1M) the projection understates spend several-fold, and the Costs dashboard's efficiency view is what the operator uses to compare tiers.

Changes:
1. Establish from the Codex usage provenance whether root and child token counts are reported separately; record the answer in the cost.ts comment block.
2. If they are separable, price root tokens at the root model and child tokens at the child model.
3. If they are not, price the whole session at the root model and mark the row `estimated: true`; never price a session at a model that did not run its root.

Out of scope: historical rows and backfills; changing the price table; the console layout.

Acceptance: unit tests in cost.test.ts cover both branches with hand-computed totals; a Run row for an astra executioner session with native children shows a non-null cost whose value is consistent with the chosen branch; existing cost tests stay green.

Route: implementation=senior-dev-opus-high - operator spends Claude capacity at high effort; the provenance question in Change 1 decides which pricing branch exists and is investigative, not mechanical