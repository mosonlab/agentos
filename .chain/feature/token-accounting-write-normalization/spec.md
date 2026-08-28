Status
The Costs dashboard landed in PR #178 and its read-side normalization is live. This card is now unblocked. Use the current @anneal package names and current Claude, Codex, and PI adapter behavior as authority.

Problem
Session token columns still carry runner-dependent semantics. Claude totalTokens excludes cached input, while Codex inputTokens includes cached input; costUsd is not consistently available. The Costs endpoint compensates at read time, but every new consumer would need to rediscover the same rules.

Scope
- Define one canonical persisted meaning for inputTokens, cachedInputTokens, outputTokens, and totalTokens before changing writes.
- Normalize each runner adapter at the write boundary.
- Choose an explicit historical-row policy: a safe backfill or a versioned interpretation marker. Never silently reinterpret old rows.
- Keep unavailable costUsd explicitly null unless it can be derived from authoritative captured usage and model pricing.
- Remove Costs read-side special cases only after historical and new rows share a proven interpretation.

Acceptance
- Schema documentation states one semantic for every usage column.
- Focused adapter tests cover Claude, Codex, and PI including cached input.
- Costs totals for a fixed historical window remain unchanged after migration/backfill.
- New rows aggregate without runner-specific read compensation.
- Targeted DB tests, typecheck, and lint pass.

Route: implementation=senior-dev