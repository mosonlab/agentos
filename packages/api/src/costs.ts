import { Prisma, type PrismaClient, sessionUsageCost, type UsageCost } from "@agentos/db";

import { terminalRunStatuses } from "./workspace-reclaim.js";

/**
 * Spend aggregation for the Costs dashboard.
 *
 * WHY NOT `groupBy`. Prisma's `groupBy` can only sum a stored column, and
 * `Session.costUsd` is not a complete record of spend: it is NULL for every
 * codex session, because that CLI reports usage without an amount. Summing the
 * column would silently read those runs as zero. Cost per session is therefore
 * derived row by row through `sessionUsageCost` (packages/db/src/cost.ts), the
 * repository's one source of truth for "what did this session cost" — provider
 * amount when it exists, a repository-priced estimate when the token columns
 * are complete, and *nothing at all* when neither holds. A run in that last
 * group is counted in `costUnavailableRuns` and left out of every total.
 *
 * TOKEN NORMALIZATION. `Session.totalTokens` is never read here, and must not
 * be: its meaning differs per runner. A claude session stores
 * `inputTokens + outputTokens` with `cachedInputTokens` excluded, while a codex
 * session stores `inputTokens` with cached input already counted inside it, so
 * the same column means two different things and summing it across runners is
 * meaningless. The normalized basis both runners agree on is the raw triple
 * (`inputTokens`, `cachedInputTokens`, `outputTokens`), which is what
 * `sessionUsageCost` prices: it charges `inputTokens - cachedInputTokens` at the
 * uncached rate and `cachedInputTokens` at the cached one, and refuses to price
 * a row where `cachedInputTokens > inputTokens` rather than invent a number.
 */

export const COSTS_DEFAULT_DAYS = 30;
/** The ranges the dashboard offers. Anything else is refused rather than
 *  silently clamped, so a mistyped URL cannot be read as a real window. */
export const COSTS_RANGE_DAYS: readonly number[] = [7, 30, 90];
export const COSTS_TOP_RUNS = 10;

/** Aggregate amounts are rounded here before serialization. `Session.costUsd`
 *  is `Decimal(12, 4)`, so this keeps provider-reported sums exact while still
 *  bounding the tail an estimate's division produces. */
const AMOUNT_DECIMALS = 6;

export type CostsRunRow = {
  id: string;
  model: string;
  subagentModel: string | null;
  startedAt: Date;
  agent: { title: string };
  task: { name: string } | null;
  session: {
    costUsd: Prisma.Decimal | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
  } | null;
};

export type CostsDailyBucket = { date: string; byAgent: Record<string, string> };
export type CostsAgentTotal = { agent: string; usd: string; runs: number; avgUsd: string };
export type CostsTopRun = {
  runId: string;
  taskName: string | null;
  agent: string;
  model: string;
  usd: string;
  estimated: boolean;
  startedAt: string;
};

export type CostsReport = {
  days: number;
  /** Inclusive lower bound of the window, as an ISO instant, so a reader can
   *  reconcile the totals with a `WHERE "startedAt" >= …` sum by hand. */
  since: string;
  totalUsd: string;
  /** The part of `totalUsd` that came from repository pricing rather than from
   *  a provider-reported amount. */
  estimatedUsd: string;
  /** Settled runs that started inside the window, priced or not. */
  runCount: number;
  /** Runs inside `runCount` whose cost could not be established at all. They
   *  contribute to no total; the page states the count instead of hiding it. */
  costUnavailableRuns: number;
  /** Mean over the runs that *have* a cost, not over `runCount`: dividing by
   *  runs known to be unpriced would report an average nobody spent. */
  avgUsd: string;
  daily: CostsDailyBucket[];
  byAgent: CostsAgentTotal[];
  topRuns: CostsTopRun[];
};

const ZERO = new Prisma.Decimal(0);

const amount = (value: Prisma.Decimal): string => value.toDecimalPlaces(AMOUNT_DECIMALS).toString();

const utcDay = (value: Date): string => value.toISOString().slice(0, 10);

/** Midnight UTC, `days - 1` days back, so the window is exactly `days` whole
 *  UTC buckets ending with today and every bucket is a full day. */
export const costsWindowStart = (now: Date, days: number): Date => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
};

/** Every UTC day in the window, oldest first, including the ones nothing ran
 *  on: a chart that skips empty days misreports the shape of the spend. */
const windowDays = (since: Date, days: number): string[] => {
  const dates: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(since);
    day.setUTCDate(day.getUTCDate() + offset);
    dates.push(utcDay(day));
  }
  return dates;
};

const runCost = (run: CostsRunRow): UsageCost | null =>
  run.session === null
    ? null
    // A run that dispatched native children reports one aggregate token total
    // for a mix of models. `mixedModels` keeps those tokens visible while
    // refusing to price them at the root model's rate.
    : sessionUsageCost(run.model, run.session, { mixedModels: run.subagentModel !== null });

export const aggregateCosts = (runs: readonly CostsRunRow[], since: Date, days: number): CostsReport => {
  const daily = new Map<string, Map<string, Prisma.Decimal>>(
    windowDays(since, days).map((date) => [date, new Map<string, Prisma.Decimal>()]),
  );
  const perAgent = new Map<string, { usd: Prisma.Decimal; runs: number }>();
  const priced: Array<{ run: CostsRunRow; cost: UsageCost & { costUsd: Prisma.Decimal } }> = [];
  let total = ZERO;
  let estimated = ZERO;
  let unavailable = 0;

  for (const run of runs) {
    const agent = run.agent.title;
    const cost = runCost(run);
    // `perAgent.runs` counts what the agent ran, priced or not, so the by-agent
    // table's run column reconciles with the Runs tile.
    const held = perAgent.get(agent) ?? { usd: ZERO, runs: 0 };
    const usd = cost?.costUsd ?? null;
    perAgent.set(agent, { usd: usd === null ? held.usd : held.usd.plus(usd), runs: held.runs + 1 });
    if (cost === null || usd === null) {
      unavailable += 1;
      continue;
    }
    total = total.plus(usd);
    if (cost.estimated) estimated = estimated.plus(usd);
    const bucket = daily.get(utcDay(run.startedAt));
    // A run outside the buckets cannot happen for rows the query returned, but
    // dropping one silently would make the chart disagree with the tiles.
    if (bucket === undefined) throw new Error(`Run ${run.id} started outside the ${days}-day window`);
    bucket.set(agent, (bucket.get(agent) ?? ZERO).plus(usd));
    priced.push({ run, cost: { ...cost, costUsd: usd } });
  }

  const pricedRuns = runs.length - unavailable;
  return {
    days,
    since: since.toISOString(),
    totalUsd: amount(total),
    estimatedUsd: amount(estimated),
    runCount: runs.length,
    costUnavailableRuns: unavailable,
    avgUsd: amount(pricedRuns === 0 ? ZERO : total.dividedBy(pricedRuns)),
    daily: [...daily].map(([date, byAgent]) => ({
      date,
      byAgent: Object.fromEntries([...byAgent].map(([agent, usd]) => [agent, amount(usd)])),
    })),
    byAgent: [...perAgent]
      .map(([agent, held]) => ({
        agent,
        usd: amount(held.usd),
        runs: held.runs,
        avgUsd: amount(held.runs === 0 ? ZERO : held.usd.dividedBy(held.runs)),
      }))
      .sort((left, right) => Number(right.usd) - Number(left.usd) || left.agent.localeCompare(right.agent)),
    topRuns: priced
      .sort((left, right) => right.cost.costUsd.comparedTo(left.cost.costUsd)
        || right.run.startedAt.getTime() - left.run.startedAt.getTime())
      .slice(0, COSTS_TOP_RUNS)
      .map(({ run, cost }) => ({
        runId: run.id,
        taskName: run.task?.name ?? null,
        agent: run.agent.title,
        model: run.model,
        usd: amount(cost.costUsd),
        estimated: cost.estimated,
        startedAt: run.startedAt.toISOString(),
      })),
  };
};

export const readProjectCosts = async (
  db: PrismaClient,
  projectId: string,
  days: number,
  now: Date = new Date(),
): Promise<CostsReport> => {
  const since = costsWindowStart(now, days);
  const runs = await db.run.findMany({
    where: {
      projectId,
      // Settled runs only: an in-flight run's usage is still being written, so
      // including it would make the same window answer differently each poll.
      status: { in: [...terminalRunStatuses] },
      startedAt: { gte: since },
    },
    select: {
      id: true,
      model: true,
      subagentModel: true,
      startedAt: true,
      agent: { select: { title: true } },
      task: { select: { name: true } },
      // Deliberately not `totalTokens` — see the module comment.
      session: { select: { costUsd: true, inputTokens: true, cachedInputTokens: true, outputTokens: true } },
    },
    orderBy: { startedAt: "asc" },
  });
  return aggregateCosts(
    // `startedAt` is non-null by the filter above; the select cannot say so.
    runs.map((run) => ({ ...run, startedAt: run.startedAt as Date })),
    since,
    days,
  );
};
