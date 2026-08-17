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
  costUsd?: number;
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
const render = (value: unknown): string =>
  typeof value === "number" ? String(value) : JSON.stringify(value) ?? String(value);

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
 * Returns the raw number rather than the rounded one: `sumUsage` must keep
 * adding exact values and round once at the end, as it does today.
 */
const costAmount = (value: unknown): number | null => {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    console.warn(`[usage] ignoring total_cost_usd=${render(value)}: not a storable cost`);
    return null;
  }
  if (new Prisma.Decimal(value).toDecimalPlaces(COST_SCALE).greaterThanOrEqualTo(MAX_COST)) {
    console.warn(`[usage] ignoring total_cost_usd=${render(value)}: exceeds Decimal(12, 4)`);
    return null;
  }
  return value;
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
 * - PI `agent_settled`: literally `{"type":"agent_settled"}` — no usage, no cost.
 *   PI reports usage per message instead, which this batch does not harvest.
 */
export const extractUsage = (payload: unknown): SessionUsage => {
  const event = asRecord(payload);
  if (!event) return {};
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
    if (usage.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
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
const costColumn = (value: number | undefined): Prisma.Decimal | null => {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    console.warn(`[usage] costUsd=${render(value)} is not storable after summing; storing null`);
    return null;
  }
  const rounded = new Prisma.Decimal(value).toDecimalPlaces(COST_SCALE);
  if (rounded.greaterThanOrEqualTo(MAX_COST)) {
    console.warn(`[usage] costUsd=${render(value)} exceeds Decimal(12, 4) after summing; storing null`);
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
 * Concurrency: a session has exactly one runner process posting events
 * sequentially, so this is single-writer in practice; two concurrent callers
 * would still converge because both compute from the same table.
 */
export const recomputeSessionUsage = async (db: PrismaClient, sessionId: string): Promise<boolean> => {
  const rows = await db.sessionEvent.findMany({
    where: { sessionId, type: "FINAL_OUTPUT" },
    orderBy: { seq: "asc" },
    select: { payload: true },
  });
  const derived = deriveUsageColumns(sumUsage(rows.map((row) => extractUsage(row.payload))));
  const current = await db.session.findUnique({
    where: { id: sessionId },
    select: { inputTokens: true, outputTokens: true, cachedInputTokens: true, totalTokens: true, costUsd: true },
  });
  if (!current || sameColumns(current, derived)) return false;
  await db.session.update({ where: { id: sessionId }, data: derived });
  return true;
};
