Verdict: FAIL — 3 must-fix, 1 should-fix

Operator action: run the migration only with modifications. Keep the four nullable columns, apply them with a bounded `lock_timeout`, and create the two indexes out of band with `CREATE INDEX CONCURRENTLY` as already established for batch 2.5. Do not run the backfill until recomputes are serialized and Claude totals use the complete terminal payload; first publish and rehearse the complete database rollback procedure described in MF-3.

The exact range `3c1f186..2737113` builds, its full test suite and typecheck pass, Prisma validates the schema, and `git diff --check` passes. The focused runner/delivery pass found no additional defect: all 25 runner tests pass, including failed-workspace salvage and structured-provider-error classification. Those green checks do not exercise the production interleavings or the full Claude payload that fail below.

## Must-fix

1. **MF-1 — concurrent backfill and live ingest can overwrite a newer usage total with a stale one.** Severity: **must-fix**. Origin lens: **feasibility (concurrency), also coherence**.

   **Diff evidence.** The added implementation reads events, then separately reads and unconditionally updates the cache (`packages/db/src/usage.ts:134-150`):

   ```diff
   + * Concurrency: a session has exactly one runner process posting events
   + * sequentially, so this is single-writer in practice; two concurrent callers
   + * would still converge because both compute from the same table.
   +export const recomputeSessionUsage = async (...) => {
   +  const rows = await db.sessionEvent.findMany(...);
   +  const derived = deriveUsageColumns(...);
   +  const current = await db.session.findUnique(...);
   +  if (!current || sameColumns(current, derived)) return false;
   +  await db.session.update({ where: { id: sessionId }, data: derived });
   +  return true;
   +};
   ```

   The second caller is real: the backfill invokes the same function for every candidate (`packages/db/prisma/backfill-session-usage.ts:21-24`), while the live request invokes it after inserting a terminal batch (`packages/api/src/app.ts:1785-1801`). There is no transaction, lock, compare-and-set, event watermark, or retry.

   **Concrete failure scenario.** Session `S` initially has one `FINAL_OUTPUT` worth 10 input tokens. Backfill A reads that row and derives 10, then pauses. The runner inserts a second `FINAL_OUTPUT` worth 20; ingest B reads both rows and writes 30. A resumes, observes that current 30 differs from its stale derived 10, and writes 10. No later terminal event is required, so the wrong value can persist indefinitely. A controlled interleaving against the merged function reproduced exactly this outcome:

   ```text
   {"expectedInputTokens":30,"storedInputTokens":10,"eventReads":2}
   ```

   This also disproves the authoritative plan's claim that “last writer wins and both writers compute from the same table, so they converge” (`docs/plans/batch-4-sessions-viewer-plan.md:478-482`). Idempotence when calls are serial does not make the read/compare/write sequence concurrency-safe.

   **Prescription.** Serialize all recomputes for a session. I would put the event read, cache read, and cache update in one short transaction that first takes a transaction-scoped PostgreSQL advisory lock keyed by `sessionId`. Every live and backfill recompute then uses the same lock; under `READ COMMITTED`, a waiter reads events only after the preceding writer finishes. This is simpler than adding a cache-version column and avoids serializable-transaction retry machinery. Add the reproduced interleaving as a regression test and do not run the backfill until it passes.

2. **MF-2 — Claude token totals silently omit auxiliary-model usage present in every successful real capture.** Severity: **must-fix**. Origin lens: **feasibility (event/usage extraction), also coherence**.

   **Diff evidence.** The extractor reads only snake-case fields under top-level `usage` (`packages/db/src/usage.ts:45-63`):

   ```diff
   +  if (usage) {
   +    const input = finite(usage.input_tokens);
   +    if (input !== null) result.inputTokens = input;
   +    const output = finite(usage.output_tokens);
   +    if (output !== null) result.outputTokens = output;
   +    ...
   +  }
   +  const cost = finite(event.total_cost_usd);
   ```

   The test says its fixture is pasted from a real capture but trims away `modelUsage` (`packages/api/src/usage.test.ts:6-20`), so it locks in the incomplete result. The untrimmed terminal event at `spikes/cli-capabilities/samples/claude-tool-event.stdout:6` contains top-level `usage` of input 4/output 77 **and** `modelUsage` containing Claude Opus input 4/output 77 plus Claude Haiku input 541/output 21. The second successful capture at `spikes/cli-capabilities/samples/claude-start-safe-mode.stdout:4` has the same shape. A pass over all successful captures produced:

   ```text
   claude-start-safe-mode.stdout: top input/output 2/3; model totals 535/20
   claude-tool-event.stdout:      top input/output 4/77; model totals 545/98
   ```

   In both events, `total_cost_usd` includes both model entries (their `costUSD` values sum to it), while the stored token count includes only the primary model. Cost and tokens therefore describe different billing envelopes.

   **Concrete failure scenario.** Backfilling the captured tool session writes `inputTokens=4`, `outputTokens=77`, and `totalTokens=81`. The terminal event proves the session actually reports 545 input and 98 output tokens across its two billed models, so the correct non-cache total is 643. The UI silently under-reports by 562 tokens (87%) while showing the full $0.049117 cost. This affects both successful Claude captures, not a hypothetical malformed payload.

   **Prescription.** When a Claude-style `modelUsage` object contains valid entries, derive input, output, cache-read, and cache-creation totals from its values exclusively; do not add top-level `usage`, because the primary model appears in both. Retain top-level `usage` as the fallback for payloads without usable `modelUsage`, and retain top-level `total_cost_usd` for cost. Paste the complete captured terminal object into tests and assert 545/98/643 for the tool capture. If product intent is deliberately “primary model only,” rename and document the metric and stop pairing it with all-model cost; I would not choose that because the feature is presented as session usage.

3. **MF-3 — the documented physical rollback is incomplete and cannot be cleanly redeployed.** Severity: **must-fix**. Origin lens: **scope (required rollback was partially dropped), also coherence and feasibility**.

   **Diff evidence.** The migration adds four columns **and two indexes** (`packages/db/prisma/migrations/20260816165548_batch4_session_usage/migration.sql:1-11`):

   ```diff
   +ALTER TABLE "Session" ADD COLUMN ...;
   +CREATE INDEX "Session_projectId_requestedAt_idx" ON "Session"("projectId", "requestedAt");
   +CREATE INDEX "SessionEvent_runId_seq_idx" ON "SessionEvent"("runId", "seq");
   ```

   The added rollback note names only dropping the four columns and calls the backfill “write-only-to-null” (`docs/specs/batch-4-sessions-viewer.md:659-665`):

   ```diff
   +If the migration must be reverted, `ALTER TABLE "Session" DROP COLUMN` on the
   +four columns loses only derived data ...
   +The backfill script is idempotent and write-only-to-null.
   ```

   That description conflicts with the implementation, which intentionally scans every session with a terminal event and rewrites any differing populated cache (`packages/db/prisma/backfill-session-usage.ts:10-24`). It also omits both index removals and all `_prisma_migrations` reconciliation. Local `prisma migrate resolve --help` explicitly provides `--rolled-back` for reconciling manual rollback with migration history.

   **Concrete failure scenario.** After a successful deploy, an operator follows the note and drops only the four columns. If the successful migration remains recorded, the next `prisma migrate deploy` skips it and the new API queries missing columns. If the operator records it rolled back, the next deploy re-executes the file but encounters the two still-existing index names; PostgreSQL aborts the transactional migration and rolls back the re-added columns. Either migration-history choice leaves the application undeployable as documented. The omitted index cleanup is especially material because the known safe production procedure must create those indexes outside Prisma's per-file transaction.

   **Prescription.** Prefer code rollback while leaving this additive database change applied; say that first. For the exceptional physical rollback, provide and rehearse a versioned runbook that removes both named indexes and all four columns in the safe order, uses bounded lock waits, reconciles migration history, verifies drift, and proves a forward redeploy. The runbook must reflect the final split deployment in which indexes are created concurrently out of band. Correct the backfill description to “absolute recompute of all terminal sessions,” not “write-only-to-null.”

## Should-fix

1. **SF-1 — malformed numeric usage can either persist impossible negative totals or make the backfill stop permanently at one session.** Severity: **should-fix**. Origin lens: **risk-focused feasibility (honest degradation)**.

   **Diff evidence.** `finite` accepts every finite JavaScript number, including negatives, fractions, and values outside PostgreSQL `INTEGER` range (`packages/db/src/usage.ts:23-24`), and `deriveUsageColumns` passes those numbers straight to the four Prisma `Int?` fields (`packages/db/src/usage.ts:93-102`). The backfill awaits each recompute without a per-session catch (`packages/db/prisma/backfill-session-usage.ts:21-24`). Against the merged functions:

   ```text
   input -7         -> inputTokens -7, totalTokens -7
   input 1.5        -> inputTokens 1.5, totalTokens 1.5
   input 2147483648 -> inputTokens 2147483648, totalTokens 2147483648
   ```

   **Concrete failure scenario.** One historical `FINAL_OUTPUT` contains `usage.input_tokens=2147483648` because of provider drift or corrupt stored JSON. Prisma attempts to write it to an `Int` column, PostgreSQL rejects the update, the top-level `finally` disconnects, and every later session is skipped. Re-running reaches the same session and aborts again. With `-7`, PostgreSQL accepts the integer and the UI reports a negative session total instead of the required honest fallback.

   **Prescription.** Accept token fields only when they are non-negative integers and validate the post-sum value against the chosen database range. If legitimate lifetime totals may exceed 32-bit range, change the storage type deliberately rather than relying on an eventual exception. Otherwise omit the invalid field, emit a diagnostic, and continue. Catch and summarize per-session backfill failures so one corrupt payload cannot starve all later sessions, then exit nonzero after the scan if any failed. I would combine strict validation with continue-and-report: it preserves honest display semantics and makes the one-shot operational tool finish useful work without hiding bad rows.
