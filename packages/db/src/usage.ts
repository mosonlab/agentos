import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Usage a single provider payload reports. Every field is optional and absent
 * means "this payload said nothing about it" — never zero. A session that spent
 * money but reported no token counts stores its cost and leaves the token
 * columns null.
 */
export type SessionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: Prisma.Decimal;
};

/** Cost is stored as Decimal(12, 4); derive at that precision so a recompute of
 * unchanged events compares equal to what the previous write stored. */
const COST_SCALE = 4;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** PostgreSQL INTEGER, the type of all four token columns. */
const MAX_INT4 = 2_147_483_647;
/** Decimal(12, 4) holds eight integer digits: 99999999.9999 is the ceiling. */
const MAX_COST = 100_000_000;

/** Diagnostics only. Numbers go through String so NaN and Infinity are legible
 * (JSON.stringify renders both as `null`, which is the one thing the reader of
 * the diagnostic must not be told). */
const render = (value: unknown): string => {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  try {
    const rendered = JSON.stringify(value) ?? String(value);
    return rendered.length > 200 ? `${rendered.slice(0, 197)}...` : rendered;
  } catch {
    // Diagnostics are deliberately weaker than ingestion. BigInt, cycles, and
    // hostile toJSON/valueOf implementations must not turn a rejected field
    // into a failed FINAL_OUTPUT request.
    return `[unrenderable ${typeof value}]`;
  }
};

/**
 * A value only counts as tokens if PostgreSQL can store it in INTEGER. Absent is
 * silent — absent is normal and means "this payload said nothing about it".
 * Present-but-impossible is dropped with a one-line diagnostic, and never throws:
 * a payload must not be able to fail the ingest that carries it.
 */
const tokenCount = (value: unknown, field: string): number | null => {
  if (value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INT4) return value;
  console.warn(`[usage] ignoring ${field}=${render(value)}: not a storable token count`);
  return null;
};

/**
 * Cost is stored as Decimal(12, 4). A value the column cannot hold is dropped
 * HERE, per event, rather than after summation: `sumUsage` folds every surviving
 * cost into one number, so a single absurd event would otherwise poison the sum
 * and erase every valid sibling's cost. The range test is applied to the ROUNDED
 * value because that is what is actually written — 99999999.99999 is below 10^8
 * and still fails the write.
 *
 * Returns an unrounded Decimal: `sumUsage` adds exact decimal values and rounds
 * once at the column boundary. Adding binary JS numbers first is not exact —
 * 0.000001 + 0.000049 lands just below the half-unit and rounds to 0.0000.
 */
const costAmount = (value: unknown): Prisma.Decimal | null => {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    console.warn(`[usage] ignoring total_cost_usd=${render(value)}: not a storable cost`);
    return null;
  }
  const decimal = new Prisma.Decimal(String(value));
  if (decimal.toDecimalPlaces(COST_SCALE).greaterThanOrEqualTo(MAX_COST)) {
    console.warn(`[usage] ignoring total_cost_usd=${render(value)}: exceeds Decimal(12, 4)`);
    return null;
  }
  return decimal;
};

type ModelTotals = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};

/**
 * CLAUDE's terminal `result` carries a per-model breakdown under `modelUsage`,
 * keyed by model id, whose entries are camelCase — while the top-level `usage`
 * object is snake_case and describes ONE model, the primary one, repeated.
 *
 * Verified against both captures in `spikes/cli-capabilities/samples/`: the
 * top-level `usage` equals `modelUsage["claude-opus-5"]` field for field, so
 * adding the two sources double-counts the primary model and reading only the
 * top-level one drops every secondary model. This branch is therefore
 * EXCLUSIVE, and the two vocabularies never share a key list.
 *
 * Returns null when nothing usable was found, which is what routes an absent,
 * malformed or empty `modelUsage` back to the top-level branch.
 */
const extractModelUsage = (value: unknown): ModelTotals | null => {
  const models = asRecord(value);
  if (!models) return null;
  const totals: ModelTotals = { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  for (const entry of Object.values(models)) {
    const model = asRecord(entry);
    if (!model) continue;                       // one malformed entry must not discard the others
    const input = tokenCount(model.inputTokens, "modelUsage.inputTokens");
    if (input !== null) totals.inputTokens = (totals.inputTokens ?? 0) + input;
    const output = tokenCount(model.outputTokens, "modelUsage.outputTokens");
    if (output !== null) totals.outputTokens = (totals.outputTokens ?? 0) + output;
    const cacheRead = tokenCount(model.cacheReadInputTokens, "modelUsage.cacheReadInputTokens");
    const cacheCreation = tokenCount(model.cacheCreationInputTokens, "modelUsage.cacheCreationInputTokens");
    if (cacheRead !== null || cacheCreation !== null) {
      totals.cachedInputTokens = (totals.cachedInputTokens ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
    }
  }
  // Usability is not a separate probe: `modelUsage` was usable iff this one pass
  // produced something. Two traversals would be free to diverge.
  return totals.inputTokens === null && totals.outputTokens === null && totals.cachedInputTokens === null
    ? null
    : totals;
};

/**
 * PI's totals, aggregated by the runner's PI parser and attached to the
 * FINAL_OUTPUT payload as `agentosPiUsage`. The name is deliberate: unlike
 * `usage` and `modelUsage`, which are the providers' own vocabularies, this
 * object is AgentOS-computed, and reading it as a provider payload would hide
 * that.
 *
 * CALIBER, which is not the same as the other two runners':
 * - `input` is uncached input only — PI reports `cacheRead` DISJOINT from it,
 *   so the stored `totalTokens` (input + output) excludes cache reads. That
 *   matches CLAUDE and deliberately differs from CODEX, whose `input_tokens`
 *   already contains `cached_input_tokens` and whose stored `totalTokens`
 *   therefore includes them.
 * - `output` already contains PI's reasoning tokens, so there is no reasoning
 *   field to fold in here.
 * - `costNanoUsd` is PI's own per-message `cost.total` summed, not derived from
 *   the pricing table — PI is the only one of the three that prices itself per
 *   message. It arrives as an INTEGER count of nano-USD because the runner
 *   cannot reach Prisma.Decimal and summing the raw doubles would hit the very
 *   half-unit error `costAmount` exists to avoid. Dividing by a power of ten in
 *   decimal is exact, so nothing is lost on the way to the column.
 *
 * `messages` and `reported` are the runner's diagnostics and are read by nobody
 * here; they exist so a stored event can answer "was the cost missing, or was
 * it genuinely nothing".
 */
const NANOS_PER_USD = 1_000_000_000;

/** The PI aggregate's integer nano-USD as an exact Decimal. Same drop-with-a-
 * diagnostic discipline as `costAmount`, against the integer domain the runner
 * actually sends: a non-integer here means the payload was not written by the
 * PI parser and its value cannot be trusted to be exact. */
const piCostAmount = (value: unknown): Prisma.Decimal | null => {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    console.warn(`[usage] ignoring agentosPiUsage.costNanoUsd=${render(value)}: not a storable cost`);
    return null;
  }
  const decimal = new Prisma.Decimal(value).dividedBy(NANOS_PER_USD);
  if (decimal.toDecimalPlaces(COST_SCALE).greaterThanOrEqualTo(MAX_COST)) {
    console.warn(`[usage] ignoring agentosPiUsage.costNanoUsd=${render(value)}: exceeds Decimal(12, 4)`);
    return null;
  }
  return decimal;
};

const extractPiUsage = (value: unknown): SessionUsage | null => {
  const totals = asRecord(value);
  if (!totals) return null;
  const result: SessionUsage = {};
  const input = tokenCount(totals.input, "agentosPiUsage.input");
  if (input !== null) result.inputTokens = input;
  const output = tokenCount(totals.output, "agentosPiUsage.output");
  if (output !== null) result.outputTokens = output;
  const cacheRead = tokenCount(totals.cacheRead, "agentosPiUsage.cacheRead");
  const cacheWrite = tokenCount(totals.cacheWrite, "agentosPiUsage.cacheWrite");
  if (cacheRead !== null || cacheWrite !== null) result.cachedInputTokens = (cacheRead ?? 0) + (cacheWrite ?? 0);
  const cost = piCostAmount(totals.costNanoUsd);
  if (cost !== null) result.costUsd = cost;
  // Nothing usable routes back to the other branches rather than claiming the
  // payload, exactly as an unusable `modelUsage` does.
  return Object.keys(result).length === 0 ? null : result;
};

/**
 * One event payload → whatever usage it carries. Shape-driven rather than
 * runner-driven, and total over `unknown`: any payload that does not match
 * yields `{}` and nothing throws.
 *
 * Verified against `spikes/cli-capabilities/samples/`:
 * - CLAUDE `result`: `modelUsage`, a per-model breakdown in camelCase, is the
 *   primary source — it is the only one that sees every model the session used.
 *   The snake_case top-level `usage.{input_tokens,output_tokens,
 *   cache_read_input_tokens,cache_creation_input_tokens}` describes the primary
 *   model alone and is the fallback for payloads carrying no usable
 *   `modelUsage`. Cost comes from the top-level `total_cost_usd` in both cases:
 *   it already equals the sum of the per-model `costUSD` values.
 * - CODEX `turn.completed`: `usage.{input_tokens,cached_input_tokens,output_tokens}`,
 *   no `modelUsage`, no cost anywhere — the fallback branch, unchanged.
 * - PI `agent_settled`: literally `{"type":"agent_settled"}` — no usage, no
 *   cost. PI prices itself per message instead, so the runner's PI parser sums
 *   those messages and attaches `agentosPiUsage`, which is EXCLUSIVE of the two
 *   provider vocabularies above and carries its own caliber. See
 *   `extractPiUsage`.
 */
export const extractUsage = (payload: unknown): SessionUsage => {
  const event = asRecord(payload);
  if (!event) return {};
  // Exclusive and first: an `agentosPiUsage` payload is already a whole
  // session's totals, cost included, and PI's terminal event carries no other
  // usage vocabulary for the branches below to add to it.
  const pi = extractPiUsage(event.agentosPiUsage);
  if (pi) return pi;
  const usage = asRecord(event.usage);
  const result: SessionUsage = {};

  const models = extractModelUsage(event.modelUsage);
  if (models) {
    // Absence survives the branch: a breakdown that reports only input leaves
    // outputTokens absent, never 0. `exactOptionalPropertyTypes` is what keeps
    // that mechanical — guard and skip, never assign undefined.
    if (models.inputTokens !== null) result.inputTokens = models.inputTokens;
    if (models.outputTokens !== null) result.outputTokens = models.outputTokens;
    if (models.cachedInputTokens !== null) result.cachedInputTokens = models.cachedInputTokens;
  } else if (usage) {
    const input = tokenCount(usage.input_tokens, "usage.input_tokens");
    if (input !== null) result.inputTokens = input;
    const output = tokenCount(usage.output_tokens, "usage.output_tokens");
    if (output !== null) result.outputTokens = output;

    // CODEX reports one cached figure; CLAUDE reports a read/creation pair.
    // `reasoning_output_tokens` (CODEX) is deliberately not folded into output.
    const cached = tokenCount(usage.cached_input_tokens, "usage.cached_input_tokens");
    const cacheRead = tokenCount(usage.cache_read_input_tokens, "usage.cache_read_input_tokens");
    const cacheCreation = tokenCount(usage.cache_creation_input_tokens, "usage.cache_creation_input_tokens");
    if (cached !== null) result.cachedInputTokens = cached;
    else if (cacheRead !== null || cacheCreation !== null) {
      result.cachedInputTokens = (cacheRead ?? 0) + (cacheCreation ?? 0);
    }
  }

  const cost = costAmount(event.total_cost_usd);
  if (cost !== null) result.costUsd = cost;
  return result;
};

/**
 * Fold many payloads' usage into one absolute total. A field stays absent
 * unless at least one input carried it, so a run of cost-only payloads yields
 * `{costUsd}` with no token fields rather than three zeroes.
 */
export const sumUsage = (usages: SessionUsage[]): SessionUsage => {
  const total: SessionUsage = {};
  for (const usage of usages) {
    if (usage.inputTokens !== undefined) total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
    if (usage.outputTokens !== undefined) total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
    if (usage.cachedInputTokens !== undefined) total.cachedInputTokens = (total.cachedInputTokens ?? 0) + usage.cachedInputTokens;
    if (usage.costUsd !== undefined) {
      total.costUsd = (total.costUsd ?? new Prisma.Decimal(0)).plus(usage.costUsd);
    }
  }
  return total;
};

type DerivedUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  costUsd: Prisma.Decimal | null;
};

/**
 * The AGGREGATE token guard. Per-event rejection already happened in
 * `tokenCount`, so this catches only the case that one cannot see: a sum that
 * leaves INTEGER range even though every contributing event was individually
 * storable. Each column is judged on its own, so an overflowing `totalTokens`
 * becomes null while `inputTokens` and `outputTokens` keep their real values.
 */
const columnValue = (value: number | undefined, field: string): number | null => {
  if (value === undefined) return null;
  if (Number.isInteger(value) && value >= 0 && value <= MAX_INT4) return value;
  console.warn(`[usage] ${field}=${render(value)} is out of INTEGER range after summing; storing null`);
  return null;
};

/** The aggregate cost guard, for the same reason: two individually storable
 * events of 6e7 sum to 1.2e8, which Decimal(12, 4) cannot hold. Rounds first,
 * because the rounded value is what is written. */
const costColumn = (value: Prisma.Decimal | undefined): Prisma.Decimal | null => {
  if (value === undefined) return null;
  if (!value.isFinite() || value.isNegative()) {
    console.warn(`[usage] costUsd=${value.toString()} is not storable after summing; storing null`);
    return null;
  }
  const rounded = value.toDecimalPlaces(COST_SCALE);
  if (rounded.greaterThanOrEqualTo(MAX_COST)) {
    console.warn(`[usage] costUsd=${value.toString()} exceeds Decimal(12, 4) after summing; storing null`);
    return null;
  }
  return rounded;
};

/** Absolute column values implied by a session's summed usage. Exported for the
 * unit test; the write path goes through `recomputeSessionUsage`. */
export const deriveUsageColumns = (usage: SessionUsage): DerivedUsage => ({
  inputTokens: columnValue(usage.inputTokens, "inputTokens"),
  outputTokens: columnValue(usage.outputTokens, "outputTokens"),
  cachedInputTokens: columnValue(usage.cachedInputTokens, "cachedInputTokens"),
  // Never 0 and never an estimate: null unless the provider reported at least
  // one of the two halves. Cache is excluded to avoid double counting.
  totalTokens: usage.inputTokens === undefined && usage.outputTokens === undefined
    ? null
    : columnValue((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), "totalTokens"),
  costUsd: costColumn(usage.costUsd),
});

const sameColumns = (
  current: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    totalTokens: number | null;
    costUsd: Prisma.Decimal | null;
  },
  derived: DerivedUsage,
): boolean =>
  current.inputTokens === derived.inputTokens
  && current.outputTokens === derived.outputTokens
  && current.cachedInputTokens === derived.cachedInputTokens
  && current.totalTokens === derived.totalTokens
  && (current.costUsd === null
    ? derived.costUsd === null
    : derived.costUsd !== null && current.costUsd.equals(derived.costUsd));

/**
 * Advisory-lock class reserved for session usage recomputes. Registry of the
 * classes used anywhere in this repo — keep this list, pick a fresh number, do
 * not reuse:
 *   20260816 — session usage recompute (this module).
 * Batch 2.5's task exclusion uses a `SELECT … FOR UPDATE` on the Task row
 * (`workflow.ts:82`), not an advisory lock, so the two schemes cannot collide.
 */
export const SESSION_USAGE_LOCK_CLASS = 20260816;

/**
 * Deterministic 32-bit FNV-1a of a session id, in signed int4 range so it can be
 * the second argument of `pg_advisory_xact_lock(int4, int4)`. Hashed here rather
 * than by PostgreSQL's `hashtext()`, which is undocumented, is not promised
 * stable across major versions, and could not be unit-tested.
 *
 * Collisions are harmless: two unrelated sessions serialise against each other
 * for the length of one recompute. Correctness is unaffected; only concurrency
 * is, and the contended population is tiny — one runner per session.
 */
export const sessionUsageLockKey = (sessionId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = Math.imul(hash ^ sessionId.charCodeAt(index), 0x01000193);
  }
  return hash | 0;
};

/**
 * Recompute a session's derived usage columns from its stored `FINAL_OUTPUT`
 * events and write absolute values. Returns true when it actually wrote.
 *
 * `SessionEvent` is the source of truth and the five columns are a derived
 * cache, which is what makes this idempotent: replaying an already-ingested
 * batch converges instead of drifting, a resumed session accumulates for free
 * (each attempt's `FINAL_OUTPUT` is its own row), a write lost to a crash
 * between `createMany` and here is repaired by the next ingest or by the
 * backfill, and no NULL column is ever used in arithmetic.
 *
 * Concurrency: concurrent callers are serialised by a transaction-scoped
 * advisory lock keyed by session id. They do NOT converge on their own — that
 * claim, which this comment used to make, is false. Each caller writes an
 * ABSOLUTE value computed from the snapshot it read, so a caller that read at
 * T1 can commit after a caller that read at T2 > T1 and leave the older total
 * stored; `sameColumns` then sees a self-consistent row and suppresses every
 * later repair, making the stale value permanent. Serialising the read, the
 * compare and the write is a correctness requirement, not a performance note.
 */
const lockWaitTimedOut = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  const detail = `${error.message} ${"meta" in error ? render(error.meta) : ""}`;
  return (code === "P2010" && /55P03|lock timeout/i.test(detail))
    || (code === "P2028" && /timeout|expired/i.test(detail));
};

const recomputeSessionUsageOnce = async (db: PrismaClient, sessionId: string): Promise<boolean> =>
  db.$transaction(async (tx) => {
    // The timeout must be installed BEFORE the wait it is meant to bound.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
    // The `::text AS locked` cast is LOAD-BEARING, not style. pg_advisory_xact_lock
    // returns `void`, and Prisma cannot deserialize a void column: the bare form
    // fails with P2010 "Failed to deserialize column of type 'void'" on EVERY call,
    // and the ingest path swallows that throw, so nothing would ever be cached.
    // Do not "simplify" it away — usage.dbtest.ts test 0 is what catches it.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SESSION_USAGE_LOCK_CLASS}::int, ${sessionUsageLockKey(sessionId)}::int)::text AS locked`;

    const rows = await tx.sessionEvent.findMany({
      where: { sessionId, type: "FINAL_OUTPUT" },
      orderBy: { seq: "asc" },
      select: { payload: true },
    });
    const derived = deriveUsageColumns(sumUsage(rows.map((row) => extractUsage(row.payload))));
    const current = await tx.session.findUnique({
      where: { id: sessionId },
      select: { inputTokens: true, outputTokens: true, cachedInputTokens: true, totalTokens: true, costUsd: true },
    });
    if (!current || sameColumns(current, derived)) return false;
    await tx.session.update({ where: { id: sessionId }, data: derived });
    return true;
  }, {
    // Load-bearing, not decoration. Under RepeatableRead the snapshot is taken by
    // the first data-reading statement — which is the SELECT that ACQUIRES the
    // lock, i.e. before it is granted. A queued caller would then read the
    // pre-lock snapshot and write a stale absolute value with the lock held: the
    // fix defeated by its own lock.
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: 15_000,   // backstop above lock_timeout + the work, so a contended
    maxWait: 5_000,    // caller fails as 55P03 rather than as an opaque P2028
  });

/**
 * A 55P03 is not a clean outcome: the FINAL_OUTPUT event is already durable,
 * and the caller in app.ts intentionally suppresses recompute failures. If the
 * older lock holder then commits a snapshot that predates that event, no later
 * event need arrive to repair the cache. Keep this invocation alive across
 * bounded lock waits instead of acknowledging an unperformed recompute.
 *
 * The retry count is deliberately unbounded. A fixed count merely moves the
 * stale-cache window. Each attempt is still bounded by PostgreSQL and Prisma,
 * rolls back before retrying, and holds no application resource between tries.
 */
export const recomputeSessionUsage = async (db: PrismaClient, sessionId: string): Promise<boolean> => {
  for (;;) {
    try {
      return await recomputeSessionUsageOnce(db, sessionId);
    } catch (error) {
      if (!lockWaitTimedOut(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};

export type BackfillSessionUsageResult = {
  scanned: number;
  updated: number;
  failedCount: number;
  failed: Array<{ sessionId: string; message: string }>;
};

const BACKFILL_PAGE_SIZE = 100;
const BACKFILL_DIAGNOSTIC_LIMIT = 20;

/**
 * Absolute recompute of every session that has a `FINAL_OUTPUT` event. It
 * overwrites any populated cache that differs from the recomputed value and
 * writes nothing when the two match — it is NOT write-only-to-null. That
 * property is what repairs a lost write, and it is what lets a corrected
 * extractor fix rows that were already populated. Safe to re-run, and safe to
 * run while sessions are ingesting because `recomputeSessionUsage` serialises.
 *
 * One session's failure must never starve the rest of the scan: before this,
 * the first throwing row aborted the run permanently, because a re-run sorts
 * the same way and dies at the same row. Sequential by choice — the population
 * is small and a parallel scan would only contend on the new lock.
 */
export const backfillSessionUsage = async (db: PrismaClient): Promise<BackfillSessionUsageResult> => {
  // Every session with a terminal event, not just those whose totalTokens is
  // null: a cost-only session never gets a totalTokens, and a session whose
  // first attempt wrote columns but whose second attempt's write was lost to a
  // crash is exactly the case a backfill exists to repair. The no-write
  // comparison inside recomputeSessionUsage is what keeps a second pass honest.
  const result: BackfillSessionUsageResult = { scanned: 0, updated: 0, failedCount: 0, failed: [] };
  let cursor: string | undefined;
  for (;;) {
    const sessions = await db.session.findMany({
      where: { events: { some: { type: "FINAL_OUTPUT" } } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: BACKFILL_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (sessions.length === 0) break;
    for (const session of sessions) {
      result.scanned += 1;
      try {
        if (await recomputeSessionUsage(db, session.id)) result.updated += 1;
      } catch (error) {
        result.failedCount += 1;
        if (result.failed.length < BACKFILL_DIAGNOSTIC_LIMIT) {
          result.failed.push({ sessionId: session.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    cursor = sessions.at(-1)?.id;
    if (sessions.length < BACKFILL_PAGE_SIZE) break;
  }
  return result;
};

export type BackfillSessionUsageCliDeps = {
  db: PrismaClient;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

/**
 * The CLI's whole body, minus the two lines a test cannot execute: constructing
 * the client and assigning `process.exitCode`. Returns the exit code rather than
 * setting it, so a `.dbtest` can execute the real reporting path and assert on
 * the code instead of reading it out of the source. Injectable log/error so the
 * test reads the summary it asserts on rather than trusting it.
 *
 * The 20-id cap exists so a corrupt-payload *class* failure does not print one
 * line per session; `scanned` and `updated` are printed on the failing path too,
 * because "how much of the scan survived" is the first thing an operator needs.
 */
export const runBackfillSessionUsageCli = async (
  { db, log = console.log, error = console.error }: BackfillSessionUsageCliDeps,
): Promise<number> => {
  const result = await backfillSessionUsage(db);
  log(`scanned ${result.scanned}, updated ${result.updated}, failed ${result.failedCount}`);
  if (result.failedCount === 0) return 0;
  for (const failure of result.failed) error(`  ${failure.sessionId}: ${failure.message}`);
  if (result.failedCount > result.failed.length) error(`  … and ${result.failedCount - result.failed.length} more`);
  return 1;
};
