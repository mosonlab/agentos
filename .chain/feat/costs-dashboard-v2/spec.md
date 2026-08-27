# Costs dashboard page — feature brief (specification of record)

Copied verbatim from the task brief. A direct chain carries no spec or plan
phase, so this brief is the authority every later reviewer reads.

---

Build a Costs page for this local single-user AgentOS deployment.

Context: every run already persists cost data (costUsd / token fields on Run and Session records), but there is no page to see spend. Decision record: records/AUDIT-danny-parity-refresh-20260826.md item R8 (approved by Leo 2026-08-26).

Scope:
1. Aggregation API: GET /projects/:projectId/costs?days=N (default 30). Response: { totalUsd, runCount, avgUsd, daily: [{ date, byAgent: { [agentName]: usd } }], byAgent: [{ agent, usd, runs, avgUsd }], topRuns: [{ taskName, agent, model, usd, startedAt }] (top 10) }. Aggregate with Prisma groupBy over settled runs; locate the exact cost/token columns in the schema and use them as source of truth.
2. Web page at /costs plus a sidebar nav item: a time-range select (7/30/90 days), three stat tiles (total spend, runs, avg per run), a daily stacked bar chart grouped by agent, a by-agent table, and a top-runs table.
3. Chart must be plain SVG/CSS rendered from the API data. Do not add a charting dependency.
4. Follow existing page idioms (Shell nav, ui.tsx primitives, locales dictionaries for en/zh strings).

Non-goals: cache-hit metrics, per-model ratio bars, budget editing, cost alerts. Keep it a read-only dashboard.

Acceptance: page loads with real production data; totals reconcile with a manual SQL sum over the same window; API covered by a dbtest; lint and tests green.

Token accounting caveats (verified 2026-08-27, treat as requirements):
- Session.totalTokens has different semantics per runner. On claude runs totalTokens = inputTokens + outputTokens and EXCLUDES cachedInputTokens; on codex runs inputTokens already INCLUDES cached input. Never sum these columns naively across runners; normalize per runner before aggregating, and state the normalization in a code comment on the aggregation query.
- Run.costUsd is NULL on all codex runs. The API must not coerce NULL to zero silently: either compute an estimate clearly labeled as such, or expose runs with unknown cost as a separate "cost unavailable" count surfaced in the UI.

Persist the final implementation output for this step through the AgentOS task output endpoint.
