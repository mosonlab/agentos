import { type ReactNode, useMemo } from "react";

import { formatDateTime, formatT, usageMoney } from "../lib/format";
import { useLocalStorage, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import type { CostsReport } from "../lib/types";
import { IconRefresh } from "../components/icons";
import {
  HINT, METRICS, PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW_WRAP,
  STACK, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  Card, EmptyState, ErrorNotice, GapNotice, Metric, Page, Segmented,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/** The windows `GET /projects/:projectId/costs` accepts. The control plane
 *  refuses anything else, so the page offers exactly these. */
export const COSTS_RANGES = [7, 30, 90] as const;
export type CostsRange = typeof COSTS_RANGES[number];

/** A cost dashboard is a page an operator returns to; the window they chose last
 *  time is the one they meant. */
const RANGE_KEY = "agentos.costs.days";

/** Hand-tuned categorical slots defined in `styles.css`. Further series use
 *  deterministic golden-angle hues instead of folding or cycling identity. */
export const SERIES_SLOTS = 6;

export const seriesColor = (rank: number): string =>
  rank < SERIES_SLOTS
    ? `var(--series-${rank + 1})`
    : `hsl(${((rank * 137.45) % 360).toFixed(1)} 64% 43%)`;

/**
 * The series the chart draws, in stacking order.
 *
 * Every agent remains its own series. `byAgent` is already sorted by total
 * spend, giving both stacking and deterministic styling one stable order.
 */
export const chartSeries = (byAgent: CostsReport["byAgent"]): string[] =>
  byAgent.map((entry) => entry.agent);

/* ------------------------------------------------------------------- chart */

/* Geometry is in viewBox units and the SVG scales uniformly, so these are
 * proportions rather than pixels. 1200x240 is close to the rendered box on a
 * full-width page, which keeps the type in the chart near the type around it. */
const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 240;
const PAD_LEFT = 62;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
const PLOT_WIDTH = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;
/** A surface-coloured gap between stacked fills, so two adjacent segments read
 *  as two values and not one. */
const SEGMENT_GAP = 2;
const CORNER = 4;
/** At a seven-day window a column would otherwise be 160 units wide, which reads
 *  as a block diagram rather than a bar chart. */
const MAX_BAR = 52;

export type ChartSegment = {
  key: string;
  agent: string;
  date: string;
  usd: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The top of its column, and so the end that carries the rounded corners. */
  capped: boolean;
};

/** Turns the daily buckets into positioned segments. Pure, so the geometry is
 *  testable without a DOM. */
export const chartSegments = (
  daily: CostsReport["daily"],
  order: readonly string[],
  max: number,
): ChartSegment[] => {
  if (daily.length === 0 || max <= 0) return [];
  const column = PLOT_WIDTH / daily.length;
  const barWidth = Math.min(MAX_BAR, column * 0.72);
  const segments: ChartSegment[] = [];
  daily.forEach((bucket, index) => {
    const x = PAD_LEFT + column * index + (column - barWidth) / 2;
    // Stacked from the baseline up, in the legend's order, so a given agent sits
    // at the same height in every column and the shape is comparable across days.
    const stacked = order
      .map((agent) => ({ agent, usd: Number(bucket.byAgent[agent] ?? 0) }))
      .filter((entry) => entry.usd > 0);
    let baseline = PAD_TOP + PLOT_HEIGHT;
    stacked.forEach((entry, position) => {
      const full = (entry.usd / max) * PLOT_HEIGHT;
      // The gap comes out of the segment, never out of the value it encodes: a
      // sliver thinner than the gap keeps its full height instead of vanishing.
      const hasSegmentAbove = position < stacked.length - 1;
      const height = hasSegmentAbove && full > SEGMENT_GAP * 2 ? full - SEGMENT_GAP : full;
      segments.push({
        key: `${bucket.date}:${entry.agent}`,
        agent: entry.agent,
        date: bucket.date,
        usd: entry.usd,
        x,
        y: baseline - height,
        width: barWidth,
        height,
        capped: position === stacked.length - 1,
      });
      baseline -= full;
    });
  });
  return segments;
};

/** A rounded-top, square-bottom bar. Rounding both ends would lift the fill off
 *  the baseline it is measured from. */
const segmentPath = (segment: ChartSegment): string => {
  const radius = Math.min(CORNER, segment.width / 2, segment.height);
  const { x, y, width, height } = segment;
  if (!segment.capped || radius <= 0) return `M${x} ${y}h${width}v${height}h${-width}Z`;
  return `M${x} ${y + radius}a${radius} ${radius} 0 0 1 ${radius} ${-radius}`
    + `h${width - radius * 2}a${radius} ${radius} 0 0 1 ${radius} ${radius}`
    + `v${height - radius}h${-width}Z`;
};

/** First, middle and last only: ninety dates along this axis collide into a
 *  grey smear that says less than three legible ones. */
export const axisDates = (daily: CostsReport["daily"]): number[] => {
  if (daily.length === 0) return [];
  if (daily.length <= 2) return daily.map((_, index) => index);
  return [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
};

export const DailySpendChart = ({ daily, order, colors }: {
  daily: CostsReport["daily"];
  order: readonly string[];
  colors: (agent: string) => string;
}): ReactNode => {
  const t = useT();
  const totals = daily.map((bucket) => Object.values(bucket.byAgent).reduce((sum, usd) => sum + Number(usd), 0));
  const max = Math.max(0, ...totals);
  const segments = chartSegments(daily, order, max);
  const column = daily.length === 0 ? 0 : PLOT_WIDTH / daily.length;
  const baseline = PAD_TOP + PLOT_HEIGHT;
  if (segments.length === 0) return <EmptyState>{t("costs.chart.empty")}</EmptyState>;
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-label={t("costs.chart.aria", { amount: usageMoney(max), n: daily.length })}
    >
      {/* Recessive: the grid states the scale and then gets out of the way.
          `--border-soft` is very nearly `--card` in the dark theme, so a scale
          line drawn in it would simply not exist there; `--border` is the
          quietest token still visible against both surfaces. */}
      <line x1={PAD_LEFT} y1={PAD_TOP} x2={VIEW_WIDTH - PAD_RIGHT} y2={PAD_TOP}
        stroke="var(--border)" strokeWidth="1" />
      <line x1={PAD_LEFT} y1={baseline} x2={VIEW_WIDTH - PAD_RIGHT} y2={baseline}
        stroke="var(--border)" strokeWidth="1.5" />
      <text x={PAD_LEFT - 8} y={PAD_TOP + 4} textAnchor="end" fontSize="13" fill="var(--faint)">
        {usageMoney(max)}
      </text>
      <text x={PAD_LEFT - 8} y={baseline} textAnchor="end" fontSize="13" fill="var(--faint)">0</text>
      {segments.map((segment) => (
        <path key={segment.key} d={segmentPath(segment)} fill={colors(segment.agent)}>
          <title>{t("costs.chart.tooltip", {
            agent: segment.agent,
            date: segment.date,
            amount: usageMoney(segment.usd),
          })}</title>
        </path>
      ))}
      {axisDates(daily).map((index) => (
        <text
          key={daily[index]?.date ?? index}
          x={PAD_LEFT + column * (index + 0.5)}
          y={VIEW_HEIGHT - 6}
          textAnchor={index === 0 ? "start" : index === daily.length - 1 ? "end" : "middle"}
          fontSize="13"
          fill="var(--faint)"
        >
          {daily[index]?.date ?? ""}
        </text>
      ))}
    </svg>
  );
};

export const ChartLegend = ({ order, colors }: {
  order: readonly string[];
  colors: (agent: string) => string;
}): ReactNode => {
  return (
    <div className={`${ROW_WRAP} mt-[12px]`}>
      {order.map((agent) => (
        <span key={agent} className="inline-flex items-center gap-[6px] text-[11.5px] text-muted-foreground">
          <span className="size-[9px] rounded-[2px]" style={{ background: colors(agent) }} aria-hidden="true" />
          {agent}
        </span>
      ))}
    </div>
  );
};

/* -------------------------------------------------------------------- page */

const parseRange = (value: string): CostsRange =>
  COSTS_RANGES.find((days) => String(days) === value) ?? 30;

export const CostsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const [stored, setStored] = useLocalStorage(RANGE_KEY, "30");
  const days = parseRange(stored);
  const t = useT();
  const path = projectId === ""
    ? null
    : `/projects/${encodeURIComponent(projectId)}/costs?days=${days}`;
  // Settled spend over whole days does not move at the board's cadence, and a
  // 30-day aggregate is not free to compute. A minute is well inside the time an
  // operator would take to notice a run finished.
  const costs = usePoll<CostsReport>(path, 60_000);

  const report = costs.data;
  /* Identity is assigned once, by total spend across the window, and every
   * surface on the page reads the same map — so narrowing the range repaints
   * nothing that survived it for a reason other than its own rank changing. */
  const order = useMemo(() => chartSeries(report?.byAgent ?? []), [report]);
  const colors = useMemo(() => {
    const assigned = new Map(order.map((agent, rank) => [agent, seriesColor(rank)]));
    return (agent: string): string => assigned.get(agent) ?? "var(--series-other)";
  }, [order]);
  const daily = report?.daily ?? [];

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("costs.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>
            {t("costs.head.subtitle", { project: project?.name ?? t("tasks.head.thisProject") })}
          </div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Segmented
            options={COSTS_RANGES.map((value) => ({ value: String(value), label: t("costs.range", { n: value }) }))}
            value={String(days)}
            onChange={setStored}
          />
          <Button type="button" variant="legacy" size="legacy" onClick={costs.reload}>
            <IconRefresh />{t("common.refresh")}
          </Button>
        </div>
      </div>

      <div className={STACK}>
        {costs.missing ? <GapNotice endpoint="GET /projects/:projectId/costs" what={t("costs.gap.what")} /> : null}
        {costs.error === null || costs.missing
          ? null
          : <ErrorNotice message={`${costs.error.status} ${costs.error.message}`} onRetry={costs.reload} />}

        {report === null ? null : (
          <>
            <div className={METRICS}>
              <Metric label={t("costs.metric.total")} value={usageMoney(report.totalUsd)} />
              <Metric label={t("costs.metric.runs")} value={report.runCount} />
              <Metric
                label={t("costs.metric.avg")}
                value={report.runCount === report.costUnavailableRuns ? "—" : usageMoney(report.avgUsd)}
              />
            </div>
            {/* Neither number is decoration. An estimated share says part of the
                total is the control plane's own pricing, and an unavailable
                count says the total is missing runs outright — without them the
                tiles read as a complete ledger. */}
            <div className={HINT}>
              {Number(report.estimatedUsd) > 0
                ? `${t("costs.hint.estimated", { amount: usageMoney(report.estimatedUsd) })} `
                : ""}
              {report.costUnavailableRuns > 0
                ? t("costs.hint.unavailable", { n: report.costUnavailableRuns })
                : t("costs.hint.complete")}
            </div>

            <Card title={t("costs.chart.title")}>
              <DailySpendChart daily={daily} order={order} colors={colors} />
              {order.length > 1 ? <ChartLegend order={order} colors={colors} /> : null}
            </Card>

            <Card title={t("costs.byAgent.title")} flush>
              {report.byAgent.length === 0
                ? <EmptyState>{t("costs.byAgent.empty")}</EmptyState>
                : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("costs.byAgent.agent")}</TableHead>
                          <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.spend")}</TableHead>
                          <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.runs")}</TableHead>
                          <TableHead className={TABLE_TIGHT}>{t("costs.byAgent.avg")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.byAgent.map((entry) => (
                          <TableRow key={entry.agent}>
                            <TableCell className={TABLE_NAME}>
                              <span className="inline-flex items-center gap-[7px]">
                                <span className="size-[9px] rounded-[2px]" style={{ background: colors(entry.agent) }} aria-hidden="true" />
                                {entry.agent}
                              </span>
                              {entry.costUnavailableRuns > 0
                                ? <span className={TABLE_SUB}>{t("costs.byAgent.unavailable", { n: entry.costUnavailableRuns })}</span>
                                : null}
                            </TableCell>
                            <TableCell className={TABLE_TIGHT}>
                              {entry.runs === entry.costUnavailableRuns ? "—" : usageMoney(entry.usd)}
                            </TableCell>
                            <TableCell className={TABLE_TIGHT}>{entry.runs}</TableCell>
                            <TableCell className={TABLE_TIGHT}>
                              {entry.runs === entry.costUnavailableRuns ? "—" : usageMoney(entry.avgUsd)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
            </Card>

            <Card title={t("costs.topRuns.title")} flush>
              {report.topRuns.length === 0
                ? <EmptyState>{t("costs.topRuns.empty")}</EmptyState>
                : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("costs.topRuns.task")}</TableHead>
                          <TableHead>{t("costs.topRuns.agent")}</TableHead>
                          <TableHead>{t("costs.topRuns.model")}</TableHead>
                          <TableHead className={TABLE_TIGHT}>{t("costs.topRuns.started")}</TableHead>
                          <TableHead className={TABLE_TIGHT}>{t("costs.topRuns.cost")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.topRuns.map((run) => (
                          <TableRow key={run.runId}>
                            <TableCell className={TABLE_NAME}>
                              {/* Task names run long enough to push the four
                                  columns after them past the table's width. The
                                  bound goes on a block inside the cell, not the
                                  cell: an auto-layout table treats a `<td>`
                                  max-width as advice and widens the column
                                  anyway. `TableCell` is `whitespace-nowrap`, so
                                  the block has to re-enable wrapping or the
                                  bound clips nothing. */}
                              <div className="max-w-[420px] whitespace-normal">
                                {run.taskName ?? t("costs.topRuns.noTask")}
                                <span className={TABLE_SUB}>{run.runId}</span>
                              </div>
                            </TableCell>
                            <TableCell>{run.agent}</TableCell>
                            <TableCell>{run.model}</TableCell>
                            <TableCell className={TABLE_TIGHT}>{formatDateTime(run.startedAt)}</TableCell>
                            <TableCell className={TABLE_TIGHT}>
                              {run.estimated
                                ? formatT("format.usageCost.estimated", { amount: usageMoney(run.usd) })
                                : usageMoney(run.usd)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
            </Card>
          </>
        )}
      </div>
    </Page>
  );
};
