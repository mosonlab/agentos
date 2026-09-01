import { extractCacheSplit, type ExtractedCacheSplit } from "./usage.js";

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
  /** Malformed rows. A non-zero value is reported only on the fail-closed path. */
  failed: number;
};

type CachePair = {
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
};

const MAX_INT4 = 2_147_483_647;

const add = (
  current: number,
  value: number,
): number | null => {
  if (value > MAX_INT4 - current) return null;
  return current + value;
};

const summarize = (result: SessionCacheBackfillResult): string => (
  `scanned ${result.scanned}, updated ${result.updated}, failed ${result.failed}, unknown ${result.unknown}`
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
    let parsed: ExtractedCacheSplit;
    try {
      parsed = extractCacheSplit(payload, { strict: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionCacheBackfillError(
        sessionId,
        `retained terminal payload is malformed: ${reason}`,
        { ...summary, failed: summary.failed + 1 },
      );
    }
    // `none` is a usage-bearing event with no input evidence (for example an
    // output-only terminal or a cost-only breakdown), so it must not poison a
    // complete split established by another retained event. Only the shared
    // decoder's input-bearing `unknown` result makes the session unpriceable.
    if (parsed.kind === "unknown") unknown = true;
    if (parsed.kind === "known") {
      pair = pair ?? { cachedInputTokens: 0, cacheCreationInputTokens: 0 };
      const cachedInputTokens = add(pair.cachedInputTokens, parsed.cachedInputTokens);
      const cacheCreationInputTokens = add(pair.cacheCreationInputTokens, parsed.cacheCreationInputTokens);
      if (cachedInputTokens === null || cacheCreationInputTokens === null) {
        // Every payload was valid, but the aggregate cannot fit the persisted
        // INTEGER columns. Live recomputation stores NULL for the same case;
        // the cache-only backfill therefore leaves the row unknown and keeps
        // scanning instead of misreporting a malformed retained payload.
        unknown = true;
      } else {
        pair = { cachedInputTokens, cacheCreationInputTokens };
      }
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
  const result: SessionCacheBackfillResult = { scanned: 0, updated: 0, unknown: 0, failed: 0 };
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

    const events = await db.sessionEvent.findMany({
      where: { sessionId: session.id, type: "FINAL_OUTPUT" },
      orderBy: { seq: "asc" },
      select: { payload: true },
    });
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
    log(summarize(failure.summary));
    error(failure.message);
    return 1;
  }
};
