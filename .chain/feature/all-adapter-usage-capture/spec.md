Problem
Every pi-runner session stores null token and cost columns, and a 2026-08-26 spot check widened the gap: openai-codex/* prefixed adapter sessions (review coordinators at sol:xhigh, librarian at luna:xhigh) and bare gpt-5.6-luna:max implementation sessions all persist empty usage; claude-opus-5:medium (Regression Verifier) reads $0 and is suspected of the same gap. Only bare gpt-5.6-sol:high and claude-opus-5:high account correctly. Run cost visibility is blind for exactly the fleet's heaviest tiers.

Authority note
This chain is bound behind the chain "Token accounting: normalize runner semantics at write time" (chain 84d2ebe6) and auto-starts only after it delivers; both touch packages/runner adapters and the packages/db usage ingest. This brief was written before that delivery: start by reading the delivered write-boundary semantics in the current tree (packages/db/src/usage.ts and the adapter write paths). Wherever this brief conflicts with the delivered post-normalization behavior, the tree wins; the billing rulings below still stand.

Scope (from records/BRIEF-pi-usage-capture-20260825.md plus Leo's 2026-08-26 expansion to all-adapter usage capture)
- PI reports usage per message, not on agent_settled. The pi adapter harvests per-message usage events and aggregates them into one SessionUsage per session through the existing ingest path. No new columns; absent stays null, never zero.
- Capture fresh real pi per-message usage samples into spikes/cli-capabilities/samples/ first; write harvest logic against that evidence, not documentation.
- Audit and close the same capture gap for the other silent adapter paths found in the 2026-08-26 check (openai-codex/* prefix, bare luna:max, opus:medium), each against captured evidence.
- Child-thread billing (Leo 2026-08-26 ruling): native child threads are pinned to Luna max, so child-thread tokens are billed at Luna pricing as an exact value. When the root session splits cleanly from child threads, bill root at its actual model price and children at Luna price separately. When it cannot be split, bill the whole session's tokens at Luna price with estimated: true. Never skip accounting because the split is unavailable.
- Out of scope: backfilling historical null rows (no harvested events exist to recompute from).

Acceptance
- Aggregation across messages; a session emitting no usage events keeps null columns; malformed values follow the existing drop-with-diagnostic rule in usage.ts.
- After one direct chain completes, every model-run step (mechanical steps excepted) shows a non-empty dollar amount on the task detail page.
- Targeted tests, typecheck, and lint pass.

Route: implementation=senior-dev