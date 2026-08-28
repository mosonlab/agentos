import { Prisma, type PrismaClient, runSessionUsageCost, type UsageCost } from "@anneal/db";

import { terminalRunStatuses } from "./workspace-reclaim.js";

/**
 * Spend aggregation for the Costs dashboard.
 *
 * Prisma `groupBy` owns the settled run counts by stable agent id. Amounts still
 * require the detailed rows because `Session.costUsd` is NULL for every codex
 * session, and `groupBy` cannot combine stored provider amounts with estimates
 * derived from token columns. `aggregateCosts` reconciles the grouped counts
 * with those detail rows before returning either result.
 *
 * TOKEN NORMALIZATION. `Session.totalTokens` is never read here: it is a
 * display projection, not the pricing basis. New persisted rows use the
 * canonical raw triple (`inputTokens`, `cachedInputTokens`, `outputTokens`),
 * where `inputTokens` includes its cached subset. `runSessionUsageCost` prices
 * that triple directly; rows missing any pricing input remain explicitly
 * unavailable.
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
  agent: { id: string; name: string };
  task: { name: string } | null;
  session: {
    nativeChildUsed: boolean;
    costUsd: Prisma.Decimal | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
  } | null;
};

export type CostsDailyBucket = { date: string; byAgent: Record<string, string> };
export type CostsAgentTotal = {
  agent: string;
  usd: string;
  runs: number;
  costUnavailableRuns: number;
  avgUsd: string;
};
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
  /** Inclusive lower bound of the whole-day window, as an ISO instant. Together
   *  with `days`, it gives a reader both bounds needed for reconciliation. */
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

/** Exclusive upper bound paired with `costsWindowStart`: runner clock skew or
 *  a row committed across UTC midnight cannot escape the chart's buckets. */
export const costsWindowEnd = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

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

const runCost = (run: CostsRunRow): UsageCost | null => {
  return runSessionUsageCost(run);
};

export type CostsRunGroup = { agentId: string; _count: { _all: number } };

export const aggregateCosts = (
  runs: readonly CostsRunRow[],
  groupedRuns: readonly CostsRunGroup[],
  since: Date,
  days: number,
): CostsReport => {
  const daily = new Map<string, Map<string, Prisma.Decimal>>(
    windowDays(since, days).map((date) => [date, new Map<string, Prisma.Decimal>()]),
  );
  const groupedCountByAgent = new Map(groupedRuns.map((group) => [group.agentId, group._count._all]));
  const observedCountByAgent = new Map<string, number>();
  const perAgent = new Map<string, {
    agent: string;
    usd: Prisma.Decimal;
    pricedRuns: number;
    costUnavailableRuns: number;
  }>();
  const priced: Array<{ run: CostsRunRow; cost: UsageCost & { costUsd: Prisma.Decimal } }> = [];
  let total = ZERO;
  let estimated = ZERO;
  let unavailable = 0;

  for (const run of runs) {
    const agentId = run.agent.id;
    const agent = run.agent.name;
    observedCountByAgent.set(agentId, (observedCountByAgent.get(agentId) ?? 0) + 1);
    const cost = runCost(run);
    const agentTotal = perAgent.get(agentId) ?? {
      agent, usd: ZERO, pricedRuns: 0, costUnavailableRuns: 0,
    };
    const usd = cost?.costUsd ?? null;
    if (cost === null || usd === null) {
      unavailable += 1;
      perAgent.set(agentId, { ...agentTotal, costUnavailableRuns: agentTotal.costUnavailableRuns + 1 });
      continue;
    }
    perAgent.set(agentId, {
      ...agentTotal,
      usd: agentTotal.usd.plus(usd),
      pricedRuns: agentTotal.pricedRuns + 1,
    });
    total = total.plus(usd);
    if (cost.estimated) estimated = estimated.plus(usd);
    const bucket = daily.get(utcDay(run.startedAt));
    // A run outside the buckets cannot happen for rows the query returned, but
    // dropping one silently would make the chart disagree with the tiles.
    if (bucket === undefined) throw new Error(`Run ${run.id} started outside the ${days}-day window`);
    bucket.set(agent, (bucket.get(agent) ?? ZERO).plus(usd));
    priced.push({ run, cost: { ...cost, costUsd: usd } });
  }

  for (const [agentId, count] of observedCountByAgent) {
    if (groupedCountByAgent.get(agentId) !== count) {
      throw new Error(`Grouped and detailed cost run counts disagree for agent ${agentId}`);
    }
  }
  if (groupedCountByAgent.size !== observedCountByAgent.size) {
    throw new Error("Grouped and detailed cost run agents disagree");
  }
  const runCount = groupedRuns.reduce((sum, group) => sum + group._count._all, 0);
  const pricedRuns = runCount - unavailable;
  return {
    days,
    since: since.toISOString(),
    totalUsd: amount(total),
    estimatedUsd: amount(estimated),
    runCount,
    costUnavailableRuns: unavailable,
    avgUsd: amount(pricedRuns === 0 ? ZERO : total.dividedBy(pricedRuns)),
    daily: [...daily].map(([date, byAgent]) => ({
      date,
      byAgent: Object.fromEntries([...byAgent].map(([agent, usd]) => [agent, amount(usd)])),
    })),
    byAgent: [...perAgent]
      .map(([agentId, agentTotal]) => ({
        agent: agentTotal.agent,
        usd: amount(agentTotal.usd),
        runs: groupedCountByAgent.get(agentId) ?? 0,
        costUnavailableRuns: agentTotal.costUnavailableRuns,
        avgUsd: amount(agentTotal.pricedRuns === 0 ? ZERO : agentTotal.usd.dividedBy(agentTotal.pricedRuns)),
      }))
      .sort((left, right) => Number(right.usd) - Number(left.usd) || left.agent.localeCompare(right.agent)),
    topRuns: priced
      .sort((left, right) => right.cost.costUsd.comparedTo(left.cost.costUsd)
        || right.run.startedAt.getTime() - left.run.startedAt.getTime())
      .slice(0, COSTS_TOP_RUNS)
      .map(({ run, cost }) => ({
        runId: run.id,
        taskName: run.task?.name ?? null,
        agent: run.agent.name,
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
  const until = costsWindowEnd(now);
  const where: Prisma.RunWhereInput = {
    projectId,
    // Settled runs only: an in-flight run's usage is still being written, so
    // including it would make the same window answer differently each poll.
    status: { in: [...terminalRunStatuses] },
    startedAt: { gte: since, lt: until },
  };
  // Count aggregation stays in PostgreSQL. The detail query reads the
  // canonical token triple directly; it neither needs runner identity nor reads
  // or sums the display-only `totalTokens` column.
  return db.$transaction(async (tx) => {
    const groupedRuns = await tx.run.groupBy({
      by: ["agentId"],
      where,
      orderBy: { agentId: "asc" },
      _count: { _all: true },
    });
    const runs = await tx.run.findMany({
      where,
      select: {
        id: true,
        model: true,
        subagentModel: true,
        startedAt: true,
        agent: { select: { id: true, name: true } },
        task: { select: { name: true } },
        // Deliberately not `totalTokens` — see the module comment.
        session: { select: { nativeChildUsed: true, costUsd: true, inputTokens: true, cachedInputTokens: true, outputTokens: true } },
      },
      orderBy: { startedAt: "asc" },
    });
    return aggregateCosts(
      // `startedAt` is non-null by the filter above; the select cannot say so.
      runs.map((run) => ({ ...run, startedAt: run.startedAt as Date })),
      groupedRuns,
      since,
      days,
    );
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
};
