import { Prisma } from "@prisma/client";

export type TokenPrices = {
  inputPerMillionUsd: string;
  cachedInputPerMillionUsd: string;
  outputPerMillionUsd: string;
};

/**
 * Repository-versioned base API prices. Values are USD per one million tokens;
 * the UI marks the result estimated because session totals cannot reconstruct
 * request-level pricing tiers or non-token fees. Source model pages (checked
 * 2026-08-20):
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * https://developers.openai.com/api/docs/models/gpt-5.6-luna
 */
export const MODEL_TOKEN_PRICES: Readonly<Record<string, TokenPrices>> = {
  "gpt-5.6-sol": { inputPerMillionUsd: "5", cachedInputPerMillionUsd: "0.5", outputPerMillionUsd: "30" },
  "gpt-5.6-terra": { inputPerMillionUsd: "2", cachedInputPerMillionUsd: "0.2", outputPerMillionUsd: "12" },
  "gpt-5.6-luna": { inputPerMillionUsd: "0.2", cachedInputPerMillionUsd: "0.02", outputPerMillionUsd: "1.2" },
};

export type CostableSession = {
  costUsd: Prisma.Decimal | string | number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

export type UsageCost = {
  costUsd: Prisma.Decimal | null;
  estimated: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
};

const MILLION = new Prisma.Decimal(1_000_000);

export const modelNameForPricing = (model: string): string => {
  const suffix = model.lastIndexOf(":");
  return suffix === -1 ? model : model.slice(0, suffix);
};

const hasTokens = (session: CostableSession): boolean =>
  session.inputTokens !== null || session.cachedInputTokens !== null || session.outputTokens !== null;

/** Provider cost is authoritative. Estimation is a read-time projection so it
 * applies to historical rows without ever overwriting their reported amount. */
export const sessionUsageCost = (model: string, session: CostableSession): UsageCost => {
  const tokens = {
    inputTokens: session.inputTokens,
    cachedInputTokens: session.cachedInputTokens,
    outputTokens: session.outputTokens,
  };
  if (session.costUsd !== null) {
    return { costUsd: new Prisma.Decimal(session.costUsd), estimated: false, ...tokens };
  }
  if (!hasTokens(session)) return { costUsd: null, estimated: false, ...tokens };

  const prices = MODEL_TOKEN_PRICES[modelNameForPricing(model)];
  // Every component is required for a complete estimate. Persisted null means
  // the provider did not report that component, not that it was zero. Codex
  // reports cached input as a subset of input, so inconsistent rows also fall
  // back to their token columns instead of manufacturing a partial amount.
  if (!prices || session.inputTokens === null || session.cachedInputTokens === null
    || session.outputTokens === null || session.cachedInputTokens > session.inputTokens) {
    return { costUsd: null, estimated: false, ...tokens };
  }

  const cached = session.cachedInputTokens;
  const uncached = session.inputTokens - cached;
  const output = session.outputTokens;
  const costUsd = new Prisma.Decimal(uncached).times(prices.inputPerMillionUsd)
    .plus(new Prisma.Decimal(cached).times(prices.cachedInputPerMillionUsd))
    .plus(new Prisma.Decimal(output).times(prices.outputPerMillionUsd))
    .dividedBy(MILLION);
  return { costUsd, estimated: true, ...tokens };
};

export const sumUsageCosts = (items: UsageCost[]): UsageCost | null => {
  if (items.length === 0) return null;
  let costUsd = new Prisma.Decimal(0);
  let hasCost = false;
  let estimated = false;
  let unpriced = false;
  let inputTokens: number | null = null;
  let cachedInputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (const item of items) {
    const itemHasTokens = item.inputTokens !== null || item.cachedInputTokens !== null || item.outputTokens !== null;
    if (item.costUsd === null) unpriced ||= itemHasTokens;
    else {
      costUsd = costUsd.plus(item.costUsd);
      hasCost = true;
      estimated ||= item.estimated;
    }
    if (item.inputTokens !== null) inputTokens = (inputTokens ?? 0) + item.inputTokens;
    if (item.cachedInputTokens !== null) cachedInputTokens = (cachedInputTokens ?? 0) + item.cachedInputTokens;
    if (item.outputTokens !== null) outputTokens = (outputTokens ?? 0) + item.outputTokens;
  }

  if (!hasCost && inputTokens === null && cachedInputTokens === null && outputTokens === null) return null;
  return {
    costUsd: unpriced || !hasCost ? null : costUsd,
    estimated,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
};
