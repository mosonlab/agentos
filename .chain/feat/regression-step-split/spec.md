Approved by Leo 2026-08-27 (chain IPO audit round 1, optimizations 2+3).

Problem: the regression-verification template step is 62 lines, mostly mechanical procedure (pinned fetch with retries, merge, gate-dispatch.sh invocation, verbatim verdict transcription, one-of-four JSON output), with only a short semantic recheck in the middle. It runs whole on claude-opus-5:medium (historical mean 1349s, USD 1.81-5.10 per run) and is the only long step holding the merge lease, so it serializes other chains at merge time.

Scope:
1. Split the step: move the mechanical shell (fetch/merge/gate dispatch/verdict transcription/JSON emission) to platform code or a script path that consumes no model tokens; keep the semantic recheck as a model step with a much shorter prompt.
2. Shorten the wall-clock spent inside the merge-lease window; hold the lease only for the mechanical merge+gate portion if feasible.
3. Fold-in: merge-authorization and merge-execution tasks build no Run (server-owned, merge-readiness-worker.ts), yet templates.ts:504 still assembles a full brief plus a "Persist the final merge-authorization output" instruction into their cards. Remove that contradictory assembly for stepless mechanical tasks.

Non-goals: changing merge-lease semantics or gate ordering (already adjudicated); changing the verdict schema.

Acceptance: a chain run demonstrates the regression step at materially lower cost and shorter lease hold; mechanical task cards no longer instruct persisting outputs; lint and tests green; gate verdict fidelity unchanged.
