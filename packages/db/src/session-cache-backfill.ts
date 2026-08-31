import { extractUsage, type SessionUsage } from "./usage.js";

/**
 * The Prisma client generated at the starting commit does not know about the
 * cache-creation column.  Keep this maintenance path behind the smallest
 * compatible interface so the nullable column can be added by the schema
 * change in the sibling implementation without duplicating that migration.
 * The runtime client is still PrismaClient; this is only a type boundary for
 * the script and its tests.
 */
export type SessionCacheBackfillDatabase = {
  session: {
    findMany(args: unknown): Promise<Array<{ id: string; cacheCreationInputTokens: number | null }>>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  sessionEvent: {
    findMany(args: unknown): Promise<Array<{ payload: unknown }>>;
  };
};

export type SessionCacheBackfillResult = {
  /** Every Session row considered, including rows already split. */
  scanned: number;
  /** Rows with a known split after this pass, including rows already split. */
  updated: number;
  /** Rows whose retained terminal payloads did not yield a complete split. */
  unknown: number;
};

type CachePair = {
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
};

type ParsedPayload =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "known"; pair: CachePair };

const MAX_INT4 = 2_147_483_647;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const hasOwn = (value: Record<string, unknown>, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

/**
 * A missing provider component is different from a reported zero.  The
 * provider adapters are deliberately tolerant during ingestion, but this
 * migration-like script must not turn a malformed retained value into a zero.
 * JSON null is treated as absent because older captures occasionally omitted a
 * provider component by serialising it as null.
 */
const token = (
  value: unknown,
  path: string,
  malformed: (reason: string) => never,
): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_INT4) {
    return malformed(`${path} is not a storable non-negative integer`);
  }
  return value;
};

const add = (
  current: number,
  value: number,
  path: string,
  malformed: (reason: string) => never,
): number => {
  if (value > MAX_INT4 - current) return malformed(`${path} exceeds INTEGER range after summing`);
  return current + value;
};

const invalidPayload = (reason: string): never => {
  throw new Error(`retained terminal payload is malformed: ${reason}`);
};

/** Validate only provider fields that the usage extractor understands. */
const validateUsageRecord = (usage: Record<string, unknown>, path: string): void => {
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_write_input_tokens",
  ]) {
    token(usage[key], `${path}.${key}`, invalidPayload);
  }
};

const validatePiRecord = (usage: Record<string, unknown>): void => {
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    token(usage[key], `agentosPiUsage.${key}`, invalidPayload);
  }
};

const validateModelUsage = (models: Record<string, unknown>): void => {
  for (const [modelName, rawModel] of Object.entries(models)) {
    if (!isRecord(rawModel)) invalidPayload(`modelUsage.${modelName} is not an object`);
    const model = rawModel as Record<string, unknown>;
    for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]) {
      token(model[key], `modelUsage.${modelName}.${key}`, invalidPayload);
    }
  }
};

/**
 * Derive a pair from one Claude/Codex/PI payload after validating its shape.
 * The three branches mirror `extractUsage`'s provider precedence:
 * PI aggregate first, then Claude's usable model breakdown, then the top-level
 * usage object.  A provider branch that reports only one half is unknown — it
 * is not silently completed with zero.  Codex is the explicit exception: its
 * protocol has no cache-write component, so a cached-input report is paired
 * with a known creation value of zero.
 */
const parsePayload = (payload: unknown): ParsedPayload => {
  if (!isRecord(payload)) return invalidPayload("payload is not an object");

  const hasProviderUsage = hasOwn(payload, "agentosPiUsage")
    || hasOwn(payload, "modelUsage")
    || hasOwn(payload, "usage");
  if (!hasProviderUsage) return { kind: "none" };

  const piValue = payload.agentosPiUsage;
  if (piValue !== undefined && piValue !== null) {
    if (!isRecord(piValue)) return invalidPayload("agentosPiUsage is not an object");
    validatePiRecord(piValue);
    const hasPiUsage = ["input", "output", "cacheRead", "cacheWrite"].some((key) => (
      token(piValue[key], `agentosPiUsage.${key}`, invalidPayload) !== null
    )) || (piValue.costNanoUsd !== undefined && piValue.costNanoUsd !== null);
    if (hasPiUsage) {
      const read = token(piValue.cacheRead, "agentosPiUsage.cacheRead", invalidPayload);
      const creation = token(piValue.cacheWrite, "agentosPiUsage.cacheWrite", invalidPayload);
      if (read === null && creation === null) return { kind: "unknown" };
      // A PI aggregate with just one component cannot establish the split.
      if (read === null || creation === null) return { kind: "unknown" };
      return { kind: "known", pair: { cachedInputTokens: read, cacheCreationInputTokens: creation } };
    }
  }

  const modelValue = payload.modelUsage;
  if (modelValue !== undefined && modelValue !== null) {
    if (!isRecord(modelValue)) return invalidPayload("modelUsage is not an object");
    validateModelUsage(modelValue);

    let hasModelTokens = false;
    let hasIncompleteSplit = false;
    let hasCompleteSplit = false;
    let cachedInputTokens = 0;
    let cacheCreationInputTokens = 0;
    for (const [modelName, rawModel] of Object.entries(modelValue)) {
      // `validateModelUsage` already checked this; retaining the guard keeps
      // the narrowing local and documents the invariant for future edits.
      if (!isRecord(rawModel)) return invalidPayload(`modelUsage.${modelName} is not an object`);
      const input = token(rawModel.inputTokens, `modelUsage.${modelName}.inputTokens`, invalidPayload);
      const output = token(rawModel.outputTokens, `modelUsage.${modelName}.outputTokens`, invalidPayload);
      const read = token(rawModel.cacheReadInputTokens, `modelUsage.${modelName}.cacheReadInputTokens`, invalidPayload);
      const creation = token(rawModel.cacheCreationInputTokens, `modelUsage.${modelName}.cacheCreationInputTokens`, invalidPayload);
      if (input !== null || output !== null || read !== null || creation !== null) hasModelTokens = true;
      if (read !== null || creation !== null) {
        if (read === null || creation === null) hasIncompleteSplit = true;
        else {
          hasCompleteSplit = true;
          cachedInputTokens = add(cachedInputTokens, read, "modelUsage.cacheReadInputTokens", invalidPayload);
          cacheCreationInputTokens = add(cacheCreationInputTokens, creation, "modelUsage.cacheCreationInputTokens", invalidPayload);
        }
      } else if (input !== null || output !== null) {
        // A model that contributed tokens without either cache component is
        // part of the session total, but its split is not known. Do not let a
        // complete sibling model make the aggregate look complete.
        hasIncompleteSplit = true;
      }
    }
    // An object with only cost fields is not a token branch; the extractor then
    // falls through to top-level `usage`, if one exists.
    if (hasModelTokens) {
      if (hasIncompleteSplit || !hasCompleteSplit) return { kind: "unknown" };
      return { kind: "known", pair: { cachedInputTokens, cacheCreationInputTokens } };
    }
  }

  const usageValue = payload.usage;
  if (usageValue !== undefined && usageValue !== null) {
    if (!isRecord(usageValue)) return invalidPayload("usage is not an object");
    validateUsageRecord(usageValue, "usage");

    // Codex's input_tokens already includes cached_input_tokens. Its adapter
    // also records cache_write_input_tokens, but that field is evidence of the
    // protocol's zero write component, not a value to add to the read count.
    const codexRead = token(usageValue.cached_input_tokens, "usage.cached_input_tokens", invalidPayload);
    if (codexRead !== null) {
      return { kind: "known", pair: { cachedInputTokens: codexRead, cacheCreationInputTokens: 0 } };
    }

    const claudeRead = token(usageValue.cache_read_input_tokens, "usage.cache_read_input_tokens", invalidPayload);
    const claudeCreation = token(usageValue.cache_creation_input_tokens, "usage.cache_creation_input_tokens", invalidPayload);
    if (claudeRead === null && claudeCreation === null) return { kind: "unknown" };
    if (claudeRead === null || claudeCreation === null) return { kind: "unknown" };
    return { kind: "known", pair: { cachedInputTokens: claudeRead, cacheCreationInputTokens: claudeCreation } };
  }

  return hasProviderUsage ? { kind: "unknown" } : { kind: "none" };
};

/**
 * Parse a payload using the current extractor first once the new optional field
 * exists, while retaining a legacy-shape fallback so this module type-checks
 * before Prisma/client generation.  The strict shape validation above is what
 * makes an extractor that intentionally tolerates malformed values safe for a
 * historical rewrite.
 */
const cachePairFromPayload = (payload: unknown): ParsedPayload => {
  const parsed = parsePayload(payload);
  if (parsed.kind !== "known") return parsed;

  const extracted = extractUsage(payload) as SessionUsage & {
    cacheCreationInputTokens?: number | null;
  };
  if (Object.prototype.hasOwnProperty.call(extracted, "cacheCreationInputTokens")) {
    const creation = extracted.cacheCreationInputTokens;
    if (creation === null || creation === undefined) return { kind: "unknown" };
    const read = extracted.cachedInputTokens;
    if (read === undefined) return { kind: "unknown" };
    if (!Number.isSafeInteger(read) || read < 0 || read > MAX_INT4) {
      return invalidPayload("extractor returned an unstorable cached-input count");
    }
    if (!Number.isSafeInteger(creation) || creation < 0 || creation > MAX_INT4) {
      return invalidPayload("extractor returned an unstorable cache-creation count");
    }
    return { kind: "known", pair: { cachedInputTokens: read, cacheCreationInputTokens: creation } };
  }
  // On the release-tail client the field is not generated yet. The validated
  // provider shape above is the same shape the post-migration extractor reads.
  return parsed;
};

const summarize = (result: SessionCacheBackfillResult): string => (
  `scanned ${result.scanned}, updated ${result.updated}, failed 0, unknown ${result.unknown}`
);

export class SessionCacheBackfillError extends Error {
  readonly sessionId: string;
  readonly summary: SessionCacheBackfillResult;

  constructor(sessionId: string, reason: string, summary: SessionCacheBackfillResult) {
    super(`session ${sessionId}: ${reason}`);
    this.name = "SessionCacheBackfillError";
    this.sessionId = sessionId;
    this.summary = { ...summary };
  }
}

const finalPair = (sessionId: string, payloads: unknown[], summary: SessionCacheBackfillResult): CachePair | null => {
  let pair: CachePair | null = null;
  let unknown = false;
  for (const payload of payloads) {
    let parsed: ParsedPayload;
    try {
      parsed = cachePairFromPayload(payload);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionCacheBackfillError(sessionId, reason, summary);
    }
    if (parsed.kind === "unknown") unknown = true;
    if (parsed.kind === "known") {
      pair = pair ?? { cachedInputTokens: 0, cacheCreationInputTokens: 0 };
      pair.cachedInputTokens = add(pair.cachedInputTokens, parsed.pair.cachedInputTokens, "cachedInputTokens", (reason) => {
        throw new SessionCacheBackfillError(sessionId, reason, summary);
      });
      pair.cacheCreationInputTokens = add(pair.cacheCreationInputTokens, parsed.pair.cacheCreationInputTokens, "cacheCreationInputTokens", (reason) => {
        throw new SessionCacheBackfillError(sessionId, reason, summary);
      });
    }
  }
  // A partially understood set cannot safely be rewritten. A no-usage terminal
  // row is represented by `pair === null` and counted in the same unknown bin.
  return unknown || pair === null ? null : pair;
};

/**
 * Rewrite only the still-null rows. The outer scan includes already-known rows
 * so the reported counters describe the final state and are identical on a
 * second invocation. The conditional update is the idempotence guard if an
 * operator accidentally starts two copies at once.
 */
export const backfillSessionCacheUsage = async (
  db: SessionCacheBackfillDatabase,
): Promise<SessionCacheBackfillResult> => {
  const result: SessionCacheBackfillResult = { scanned: 0, updated: 0, unknown: 0 };
  const sessions = await db.session.findMany({
    select: { id: true, cacheCreationInputTokens: true },
    orderBy: { id: "asc" },
  });

  for (const session of sessions) {
    result.scanned += 1;
    if (session.cacheCreationInputTokens !== null) {
      result.updated += 1;
      continue;
    }

    let events: Array<{ payload: unknown }>;
    try {
      events = await db.sessionEvent.findMany({
        where: { sessionId: session.id, type: "FINAL_OUTPUT" },
        orderBy: { seq: "asc" },
        select: { payload: true },
      });
    } catch (error) {
      throw error;
    }
    const pair = finalPair(session.id, events.map((event) => event.payload), result);
    if (pair === null) {
      result.unknown += 1;
      continue;
    }

    await db.session.updateMany({
      where: { id: session.id, cacheCreationInputTokens: null },
      data: pair,
    });
    result.updated += 1;
  }

  return result;
};

export type SessionCacheBackfillCliDeps = {
  db: SessionCacheBackfillDatabase;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

/** Run the script body with stable summary output and a fail-closed payload path. */
export const runBackfillSessionCacheUsageCli = async (
  { db, log = console.log, error = console.error }: SessionCacheBackfillCliDeps,
): Promise<number> => {
  try {
    const result = await backfillSessionCacheUsage(db);
    log(summarize(result));
    return 0;
  } catch (failure) {
    if (!(failure instanceof SessionCacheBackfillError)) throw failure;
    log(`${summarize(failure.summary).replace("failed 0", "failed 1")}`);
    error(failure.message);
    return 1;
  }
};
