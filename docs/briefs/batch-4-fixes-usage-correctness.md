# Task brief — Batch 4 FIXES: session usage correctness, migration safety (spec step ①)

You are step ① (spec) of the nine-step chain. Write a requirements spec; no implementation. Deliver to `docs/specs/batch-4-fixes-usage-correctness.md`, push, then continue — this step has no approval gate. Do not call `inbox_ask`.

## Why this batch exists

Batch 4 (Sessions viewer) was merged to master as `2737113` after a code review that used a frontend lens only, from the same vendor as the implementer. A retrospective independent backend review (`docs/reviews/2026-08-16-batch-4-sol-retro-review.md`, task `cmswiyqdi0s9xmpyj6qlwa08f`) returned **FAIL — 3 must-fix, 1 should-fix**. Two of the three were independently re-verified by the operator against the repository's own captured samples before this batch was created.

**The production database migration for batch 4 has not been applied yet, and the platform has not been restarted onto the new code.** Both are blocked on this batch. That is the whole point of it — everything here is on the critical path to a deploy that is currently frozen.

## Sources of authority

- `docs/reviews/2026-08-16-batch-4-sol-retro-review.md` — the findings, verbatim, with prescriptions. Binding as the scope basis; its prescriptions are strong recommendations, not orders. If a prescription is wrong or insufficient, say so with the mechanism and specify the correct one.
- `packages/db/src/usage.ts`, `packages/api/src/app.ts` (session ingest path), `packages/db/prisma/backfill-session-usage.ts`, `packages/db/prisma/migrations/20260816165548_batch4_session_usage/migration.sql`, `docs/specs/batch-4-sessions-viewer.md` §rollback.
- `spikes/cli-capabilities/samples/claude-tool-event.stdout` and `claude-start-safe-mode.stdout` — real captured terminal events. These are evidence, not fixtures to be trimmed.

## In scope

### MF-1 — serialize session usage recomputes

`recomputeSessionUsage` (`packages/db/src/usage.ts:138`) reads events, reads the cache, and writes the cache as three separate awaits with no transaction and no lock. Both the live ingest path (`packages/api/src/app.ts` ~1790) and the backfill script call it. A reproduced interleaving writes a stale total over a newer one and it persists indefinitely:

```
{"expectedInputTokens":30,"storedInputTokens":10,"eventReads":2}
```

The doc comment above the function currently asserts the opposite ("two concurrent callers would still converge because both compute from the same table") and `docs/plans/batch-4-sessions-viewer-plan.md:478-482` repeats the same false claim. **Both must be corrected, not just the code** — a wrong invariant written down is how this shipped in the first place.

The review prescribes one short transaction holding a transaction-scoped PostgreSQL advisory lock keyed by session id, used by every caller. Evaluate that against the alternatives (cache version column, serializable retry, event watermark) and justify the choice mechanically. Whatever you choose, the reproduced interleaving must exist as a regression test that fails without the fix.

### MF-2 — Claude token totals must use the complete terminal payload

The extractor reads only top-level snake_case `usage` (`packages/db/src/usage.ts:45-63`). Real Claude terminal events also carry `modelUsage`, keyed by model, because a session bills against more than one model. Verified against both successful captures in this repository:

| capture | top-level `usage` | `modelUsage` sum | `total_cost_usd` |
|---|---|---|---|
| `claude-tool-event.stdout` | 4 / 77 | **545 / 98** | $0.049117 |
| `claude-start-safe-mode.stdout` | 2 / 3 | **535 / 20** | $0.030393 |

`total_cost_usd` covers **all** model entries; the stored token count covers only the primary one. Cost and tokens therefore describe different billing envelopes, and the UI under-reports tokens by ~87% while showing the full cost.

Prescription: when `modelUsage` has usable entries, derive input, output, cache-read and cache-creation totals from **those exclusively** — do not add top-level `usage`, the primary model appears in both. Keep top-level `usage` as the fallback for payloads without usable `modelUsage`, and keep `total_cost_usd` for cost.

`packages/api/src/usage.test.ts:6-20` claims its fixture is pasted from a real capture but trimmed `modelUsage` away, locking in the wrong result. **Paste the complete captured object** and assert 545/98/643 for the tool capture.

**Operator addition, not in the review:** the review frames this as blocking the backfill. It also affects the live ingest path, which calls the same extractor. So this must be correct **before the platform is restarted onto batch 4's code**, not merely before the backfill runs — otherwise wrong totals start accumulating the moment the new API comes up. Spec it accordingly.

### MF-3 — a rollback procedure that actually works

The migration adds four columns **and two indexes**; the rollback note in `docs/specs/batch-4-sessions-viewer.md:659-665` mentions only dropping the columns and describes the backfill as "write-only-to-null", which contradicts the implementation (it rewrites any differing populated cache — an absolute recompute of every terminal session).

Both documented paths leave the app undeployable: leave the migration recorded as applied and the next `prisma migrate deploy` skips it while the new API queries missing columns; record it rolled back and the next deploy re-runs the file, hits the two still-existing index names, and PostgreSQL aborts the transactional migration, taking the re-added columns with it.

Deliver a versioned runbook at `docs/runbooks/batch-4-rollback.md` that: states **code rollback while leaving this additive change applied** as the preferred path, first; for the exceptional physical rollback removes both named indexes and all four columns in a safe order with bounded lock waits; reconciles `_prisma_migrations` (`prisma migrate resolve --rolled-back` exists locally); verifies drift; and proves a forward redeploy. Correct the backfill's description everywhere it appears.

### MF-3b — split the deployment (this is the operator's blocker)

Live sizes right now: `SessionEvent` **70,672 rows / 122 MB**, `Session` 99 rows, with **six runner processes streaming into `SessionEvent` continuously**. The two `CREATE INDEX` statements are blocking, and `CREATE INDEX CONCURRENTLY` cannot run inside Prisma's per-file transaction — batch 2.5 hit exactly this and documented the `SET lock_timeout` mitigation in its own rollback runbook; reuse that precedent rather than inventing a second convention.

Spec the deployment as a split: the four nullable columns applied through Prisma with a bounded `lock_timeout`, and the two indexes created **out of band** with `CREATE INDEX CONCURRENTLY`. Make the migration file and the runbook agree with each other about which half does what, and make `db:drift-check` still pass afterwards. Say explicitly what the operator types, in order.

### SF-1 — reject impossible usage values, and never let one bad row starve the backfill

`finite` (`packages/db/src/usage.ts:23-24`) accepts negatives, fractions, and values outside PostgreSQL `INTEGER` range, and passes them to `Int?` columns. Observed against the merged functions:

```
input -7          -> inputTokens -7,          totalTokens -7
input 1.5         -> inputTokens 1.5,         totalTokens 1.5
input 2147483648  -> inputTokens 2147483648,  totalTokens 2147483648
```

The backfill (`packages/db/prisma/backfill-session-usage.ts:21-24`) awaits each recompute with no per-session catch, so one corrupt payload aborts the scan and every later session is skipped — permanently, since a re-run dies at the same row.

Accept token fields only as non-negative integers, validate the summed value against the column range, omit invalid fields with a diagnostic rather than writing them, catch and summarize per-session backfill failures so the scan completes, and exit nonzero if any session failed.

## Explicitly out

- Any change to the batch 4 UI. Its rendering was reviewed and merged; this batch is correctness underneath it. If a fix changes what a number means, update the display of that number and nothing else.
- New metrics, a Costs page, or PI/CODEX usage collection. PI's per-message usage shape and the PI/CODEX file-path extraction are separately docketed in `docs/BACKLOG-V2.md` under batch 4 — leave them there.
- Retrofitting the same locking to unrelated write paths. Batch 2.5 already unified task status writes under one row lock; do not re-litigate that.

## Acceptance shape (the spec must make these concrete and checkable)

- The reproduced MF-1 interleaving exists as a test and fails when the serialization is removed.
- `claude-tool-event.stdout` backfills to 545 / 98 / 643, asserted against the untrimmed captured object.
- A stated, rehearsed sequence of operator commands takes the production database from its current state to fully migrated, with the indexes built concurrently and the backfill run afterwards — and a stated sequence that undoes it.
- `npm run build`, full test suite, `npm run typecheck`, and `npm run db:drift-check` all green.

## Concurrency with other chains

Two other chains are in flight and may touch the same files. Batch 1 (Settings + i18n) is mostly `apps/web` but may touch `packages/api/src/app.ts`. The platform repair batch touches `packages/db/src/workflow.ts` and `packages/runner/src/delivery.ts`. Keep your diff surgical and confined to the files named above; at the fixes step, rebase onto the latest `origin/master` before the final push and re-run the gates after rebasing.

## Standing clauses

- Task-creation field is `name`, not `title`. Implementation steps set `maxDurationMin: 240`. Model, runner, and reasoning tier come from the assigned agent configuration and are never copied into task prompts. Never write OPERATOR_TOKEN into any artifact.
- **Do not run the production migration and do not restart the platform.** Those are the operator's actions, deliberately held. Your job is to make them safe, and to write down exactly what they are.
