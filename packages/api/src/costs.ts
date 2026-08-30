import { Prisma, type PrismaClient, RunStatus, runSessionUsageCost, type UsageCost } from "@anneal/db";
import type {
  CostsAgentTotal as CostsAgentTotalContract,
  CostsDailyBucket as CostsDailyBucketContract,
  CostsModelTotal as CostsModelTotalContract,
  CostsReport as CostsReportContract,
  CostsTopRun as CostsTopRunContract,
} from "@anneal/db/board-contract";

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
export const COSTS_RANGE_DAYS: readonly number[] = [1, 7, 30, 90];
export const COSTS_TOP_RUNS = 10;

/** Aggregate amounts are rounded here before serialization. `Session.costUsd`
 *  is `Decimal(12, 4)`, so this keeps provider-reported sums exact while still
 *  bounding the tail an estimate's division produces. */
const AMOUNT_DECIMALS = 6;

export type CostsRunRow = {
  id: string;
  model: string;
  status: RunStatus;
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

export type CostsDailyBucket<DecimalValue = string> = CostsDailyBucketContract<DecimalValue>;
export type CostsAgentTotal<DecimalValue = string> = CostsAgentTotalContract<DecimalValue>;
export type CostsModelTotal<DecimalValue = string> = CostsModelTotalContract<DecimalValue>;
export type CostsTopRun<DateTime = string, DecimalValue = string> = CostsTopRunContract<DateTime, DecimalValue>;

export type CostsReport<DateTime = string, DecimalValue = string> = CostsReportContract<DateTime, DecimalValue>;

type NativeCostsReport = CostsReport<Date, Prisma.Decimal>;

const ZERO = new Prisma.Decimal(0);

const amount = (value: Prisma.Decimal): Prisma.Decimal => value.toDecimalPlaces(AMOUNT_DECIMALS);

/** Round a partition at wire precision without letting independently rounded
 *  rows disagree with their rounded total. Largest remainders receive the
 *  remaining micro-units, with source order as the deterministic tie-breaker. */
const partitionAmounts = (values: readonly Prisma.Decimal[], total: Prisma.Decimal): Prisma.Decimal[] => {
  const scale = new Prisma.Decimal(10).pow(AMOUNT_DECIMALS);
  const allocations = values.map((value, index) => {
    const scaled = value.times(scale);
    const units = scaled.floor();
    return { index, units, remainder: scaled.minus(units) };
  });
  const targetUnits = total.times(scale).toDecimalPlaces(0);
  let allocatedUnits = allocations.reduce((sum, entry) => sum.plus(entry.units), ZERO);
  const byRemainder = [...allocations]
    .sort((left, right) => right.remainder.comparedTo(left.remainder) || left.index - right.index);
  for (const entry of byRemainder) {
    if (allocatedUnits.greaterThanOrEqualTo(targetUnits)) break;
    entry.units = entry.units.plus(1);
    allocatedUnits = allocatedUnits.plus(1);
  }
  if (!allocatedUnits.equals(targetUnits)) {
    throw new Error("Could not reconcile rounded cost partition");
  }
  return allocations.map((entry) => entry.units.dividedBy(scale).toString());
};

type CalendarParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

const calendarFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const existing = calendarFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  calendarFormatters.set(timeZone, formatter);
  return formatter;
};

export const isValidTimeZone = (timeZone: string): boolean => {
  if (timeZone.trim() === "") return false;
  try {
    calendarFormatter(timeZone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

const calendarParts = (value: Date, timeZone: string): CalendarParts => {
  const values = Object.fromEntries(
    calendarFormatter(timeZone).formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const required = (key: keyof CalendarParts): number => {
    const part = values[key];
    if (part === undefined) throw new Error(`Timezone formatter omitted ${key}`);
    return part;
  };
  return {
    year: required("year"),
    month: required("month"),
    day: required("day"),
    hour: required("hour"),
    minute: required("minute"),
    second: required("second"),
  };
};

const dateKey = ({ year, month, day }: Pick<CalendarParts, "year" | "month" | "day">): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const localDay = (value: Date, timeZone: string): string => dateKey(calendarParts(value, timeZone));

const shiftCalendarDate = (
  parts: Pick<CalendarParts, "year" | "month" | "day">,
  days: number,
): Pick<CalendarParts, "year" | "month" | "day"> => {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

/** Resolve the start of a local calendar date to its UTC instant. Usually this
 *  is midnight; if a DST transition skips midnight, it is the first valid
 *  instant of the requested date instead. */
const localMidnight = (
  parts: Pick<CalendarParts, "year" | "month" | "day">,
  timeZone: string,
): Date => {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const target = dateKey(parts);
  const offsets = new Set<number>();
  // A nonexistent midnight makes offset iteration oscillate across the gap.
  // Probe both sides of any nearby transition and test each actual offset.
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = localAsUtc + (hours * 60 * 60 * 1_000);
    const observed = calendarParts(new Date(instant), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second,
    );
    offsets.add(observedAsUtc - instant);
  }
  const candidates = [...offsets]
    .map((offset) => new Date(localAsUtc - offset))
    .sort((left, right) => left.getTime() - right.getTime());
  for (const candidate of candidates) {
    const observed = calendarParts(candidate, timeZone);
    if (dateKey(observed) === target
      && observed.hour === 0 && observed.minute === 0 && observed.second === 0) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (localDay(candidate, timeZone) === target
      && localDay(new Date(candidate.getTime() - 1), timeZone) < target) {
      return candidate;
    }
  }
  throw new Error(`Could not resolve local date ${target} in ${timeZone}`);
};

/** Local midnight `days - 1` calendar days back in the requested timezone. */
export const costsWindowStart = (now: Date, days: number, timeZone: string): Date =>
  localMidnight(shiftCalendarDate(calendarParts(now, timeZone), -(days - 1)), timeZone);

/** The next local midnight, exclusive. This can be 23 or 25 hours after the
 *  current day's start when daylight saving changes. */
export const costsWindowEnd = (now: Date, timeZone: string): Date =>
  localMidnight(shiftCalendarDate(calendarParts(now, timeZone), 1), timeZone);

/** Every local calendar day in the window, oldest first, including empty days. */
const windowDays = (since: Date, days: number, timeZone: string): string[] => {
  const dates: string[] = [];
  const first = calendarParts(since, timeZone);
  for (let offset = 0; offset < days; offset += 1) {
    dates.push(dateKey(shiftCalendarDate(first, offset)));
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
  timeZone: string,
): NativeCostsReport => {
  const daily = new Map<string, Map<string, Prisma.Decimal>>(
    windowDays(since, days, timeZone).map((date) => [date, new Map<string, Prisma.Decimal>()]),
  );
  const groupedCountByAgent = new Map(groupedRuns.map((group) => [group.agentId, group._count._all]));
  const observedCountByAgent = new Map<string, number>();
  const perAgent = new Map<string, {
    agent: string;
    usd: Prisma.Decimal;
    pricedRuns: number;
    costUnavailableRuns: number;
    cachedInputTokens: number;
    inputTokens: number;
    hasCacheData: boolean;
    wastedUsd: Prisma.Decimal;
  }>();
  const perModel = new Map<string, {
    model: string;
    usd: Prisma.Decimal;
    runs: number;
    costUnavailableRuns: number;
  }>();
  const priced: Array<{ run: CostsRunRow; cost: UsageCost & { costUsd: Prisma.Decimal } }> = [];
  let total = ZERO;
  let estimated = ZERO;
  let wasted = ZERO;
  let unavailable = 0;

  for (const run of runs) {
    const agentId = run.agent.id;
    const agent = run.agent.name;
    observedCountByAgent.set(agentId, (observedCountByAgent.get(agentId) ?? 0) + 1);
    const cost = runCost(run);
    const agentTotal = perAgent.get(agentId) ?? {
      agent, usd: ZERO, pricedRuns: 0, costUnavailableRuns: 0,
      cachedInputTokens: 0, inputTokens: 0, hasCacheData: false, wastedUsd: ZERO,
    };
    const hasCacheData = run.session?.inputTokens !== null && run.session?.inputTokens !== undefined
      && run.session.cachedInputTokens !== null && run.session.cachedInputTokens !== undefined;
    const withCache = hasCacheData
      ? {
          ...agentTotal,
          cachedInputTokens: agentTotal.cachedInputTokens + run.session!.cachedInputTokens!,
          inputTokens: agentTotal.inputTokens + run.session!.inputTokens!,
          hasCacheData: true,
        }
      : agentTotal;
    const model = run.session?.nativeChildUsed === true ? "mixed" : run.model;
    const modelTotal = perModel.get(model) ?? { model, usd: ZERO, runs: 0, costUnavailableRuns: 0 };
    const usd = cost?.costUsd ?? null;
    if (cost === null || usd === null) {
      unavailable += 1;
      perAgent.set(agentId, { ...withCache, costUnavailableRuns: withCache.costUnavailableRuns + 1 });
      perModel.set(model, {
        ...modelTotal, runs: modelTotal.runs + 1, costUnavailableRuns: modelTotal.costUnavailableRuns + 1,
      });
      continue;
    }
    const runWasted = run.status === RunStatus.SUCCEEDED ? ZERO : usd;
    perAgent.set(agentId, {
      ...withCache,
      usd: withCache.usd.plus(usd),
      pricedRuns: withCache.pricedRuns + 1,
      wastedUsd: withCache.wastedUsd.plus(runWasted),
    });
    perModel.set(model, { ...modelTotal, usd: modelTotal.usd.plus(usd), runs: modelTotal.runs + 1 });
    total = total.plus(usd);
    wasted = wasted.plus(runWasted);
    if (cost.estimated) estimated = estimated.plus(usd);
    const bucket = daily.get(localDay(run.startedAt, timeZone));
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
  const modelTotals = [...perModel.values()];
  const modelAmounts = partitionAmounts(modelTotals.map((entry) => entry.usd), total);
  return {
    days,
    since,
    totalUsd: amount(total),
    estimatedUsd: amount(estimated),
    runCount,
    costUnavailableRuns: unavailable,
    avgUsd: amount(pricedRuns === 0 ? ZERO : total.dividedBy(pricedRuns)),
    wastedUsd: amount(wasted),
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
        cachePct: agentTotal.hasCacheData && agentTotal.inputTokens > 0
          ? (agentTotal.cachedInputTokens / agentTotal.inputTokens) * 100
          : null,
        wastedUsd: amount(agentTotal.wastedUsd),
      }))
      .sort((left, right) => Number(right.usd) - Number(left.usd) || left.agent.localeCompare(right.agent)),
    byModel: modelTotals
      .map((modelTotal, index) => ({
        model: modelTotal.model,
        usd: modelAmounts[index]!,
        runs: modelTotal.runs,
        costUnavailableRuns: modelTotal.costUnavailableRuns,
      }))
      .sort((left, right) => Number(right.usd) - Number(left.usd) || left.model.localeCompare(right.model)),
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
        startedAt: run.startedAt,
      })),
  };
};

export const readProjectCosts = async (
  db: PrismaClient,
  projectId: string,
  days: number,
  timeZone: string,
  now: Date = new Date(),
): Promise<NativeCostsReport> => {
  const since = costsWindowStart(now, days, timeZone);
  const until = costsWindowEnd(now, timeZone);
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
        status: true,
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
      timeZone,
    );
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
};
