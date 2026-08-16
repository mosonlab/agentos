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

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * One event payload → whatever usage it carries. Shape-driven rather than
 * runner-driven, and total over `unknown`: any payload that does not match
 * yields `{}` and nothing throws.
 *
 * Verified against `spikes/cli-capabilities/samples/`:
 * - CLAUDE `result`: `usage.{input_tokens,output_tokens,cache_read_input_tokens,
 *   cache_creation_input_tokens}` plus a top-level `total_cost_usd`.
 * - CODEX `turn.completed`: `usage.{input_tokens,cached_input_tokens,output_tokens}`,
 *   no cost anywhere.
 * - PI `agent_settled`: literally `{"type":"agent_settled"}` — no usage, no cost.
 *   PI reports usage per message instead, which this batch does not harvest.
 */
export const extractUsage = (payload: unknown): SessionUsage => {
  const event = asRecord(payload);
  if (!event) return {};
  const usage = asRecord(event.usage);
  const result: SessionUsage = {};

  if (usage) {
    const input = finite(usage.input_tokens);
    if (input !== null) result.inputTokens = input;
    const output = finite(usage.output_tokens);
    if (output !== null) result.outputTokens = output;

    // CODEX reports one cached figure; CLAUDE reports a read/creation pair.
    // `reasoning_output_tokens` (CODEX) is deliberately not folded into output.
    const cached = finite(usage.cached_input_tokens);
    const cacheRead = finite(usage.cache_read_input_tokens);
    const cacheCreation = finite(usage.cache_creation_input_tokens);
    if (cached !== null) result.cachedInputTokens = cached;
    else if (cacheRead !== null || cacheCreation !== null) {
      result.cachedInputTokens = (cacheRead ?? 0) + (cacheCreation ?? 0);
    }
  }

  const cost = finite(event.total_cost_usd);
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

/** Absolute column values implied by a session's summed usage. Exported for the
 * unit test; the write path goes through `recomputeSessionUsage`. */
export const deriveUsageColumns = (usage: SessionUsage): DerivedUsage => ({
  inputTokens: usage.inputTokens ?? null,
  outputTokens: usage.outputTokens ?? null,
  cachedInputTokens: usage.cachedInputTokens ?? null,
  // Never 0 and never an estimate: null unless the provider reported at least
  // one of the two halves. Cache is excluded to avoid double counting.
  totalTokens: usage.inputTokens === undefined && usage.outputTokens === undefined
    ? null
    : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  costUsd: usage.costUsd === undefined ? null : new Prisma.Decimal(usage.costUsd).toDecimalPlaces(COST_SCALE),
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
