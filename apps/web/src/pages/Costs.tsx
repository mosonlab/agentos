import { type ReactNode, useMemo, useState } from "react";

import { formatDateTime, money } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { useLocale, useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import type { Locale } from "../lib/i18n";
import { cn } from "../lib/utils";
import {
  Card, EmptyState, ErrorNotice, GapNotice, METRICS, Metric, PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1,
  PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, Page, STACK, TABLE_NAME, TABLE_SUB,
} from "../components/ui";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { IconRobot } from "../components/icons";

/** Amounts are strings when the control plane serialises Prisma Decimal values,
 *  but the dashboard also accepts numbers from clients that normalise the
 *  aggregate response before returning it. */
export type CostAmount = string | number;

export type CostDaily = {
  date: string;
  byAgent: Record<string, CostAmount>;
};

export type CostByAgent = {
  agent: string;
  usd: CostAmount;
  runs: number;
  avgUsd: CostAmount;
};

export type CostTopRun = {
  taskName: string;
  agent: string;
  model: string;
  usd: CostAmount;
  startedAt: string | null;
};

export type CostsResponse = {
  totalUsd: CostAmount;
  runCount: number;
  avgUsd: CostAmount;
  daily: CostDaily[];
  byAgent: CostByAgent[];
  topRuns: CostTopRun[];
};

export const COST_DAYS = [7, 30, 90] as const;
export type CostDays = typeof COST_DAYS[number];

/** Keep malformed or unavailable aggregate fields from turning the chart into
 *  NaN geometry. A missing amount is represented as zero only for geometry;
 *  the API's totals and tables still render their original values. */
export const costNumber = (value: CostAmount | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const CHART_WIDTH = 960;
const CHART_HEIGHT = 268;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 12;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 42;
const PLOT_WIDTH = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT;
const PLOT_HEIGHT = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;

/** A small, fixed palette keeps agent colours stable between polls and does not
 *  pull a charting library into the web bundle. The colours are intentionally
 *  CSS-compatible values so SVG and the legend use the same swatch. */
const CHART_COLORS = [
  "#7d5d00", "#59469a", "#27683a", "#3659b7", "#a24d00", "#b4232a", "#087f8c", "#7a3e9d",
] as const;

const chartColor = (index: number): string => CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];

/** Date-only API values are parsed as local midnight so a western timezone
 *  cannot move a bar label to the previous calendar day. */
export const costDateLabel = (value: string, locale: Locale): string => {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const date = dateOnly === null
    ? new Date(value)
    : new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric" }).format(date);
};

const dateLabelIndexes = (length: number): Set<number> => {
  if (length <= 14) return new Set(Array.from({ length }, (_, index) => index));
  const stride = length <= 45 ? 7 : 14;
  const labels = new Set<number>();
  for (let index = 0; index < length; index += stride) labels.add(index);
  labels.add(length - 1);
  return labels;
};

const dailyAgents = (daily: readonly CostDaily[], byAgent: readonly CostByAgent[]): string[] => {
  const seen = new Set<string>();
  for (const row of byAgent) if (row.agent.length > 0) seen.add(row.agent);
  for (const row of daily) for (const agent of Object.keys(row.byAgent)) if (agent.length > 0) seen.add(agent);
  return [...seen];
};

const DailyLegend = ({ agents }: { agents: readonly string[] }): ReactNode => {
  const t = useT();
  if (agents.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[6px]" aria-label={t("costs.chart.legend")}>
      {agents.map((agent, index) => (
        <span key={agent} className="inline-flex items-center gap-[6px] text-[11.5px] text-muted-foreground">
          <span aria-hidden="true" className="size-[8px] rounded-[2px]" style={{ backgroundColor: chartColor(index) }} />
          {agent}
        </span>
      ))}
    </div>
  );
};

export const DailyCostChart = ({ daily, byAgent }: { daily: readonly CostDaily[]; byAgent: readonly CostByAgent[] }): ReactNode => {
  const t = useT();
  const { locale } = useLocale();
  const agents = useMemo(() => dailyAgents(daily, byAgent), [daily, byAgent]);
  const maxDaily = Math.max(0, ...daily.map((row) => agents.reduce((sum, agent) => sum + Math.max(0, costNumber(row.byAgent[agent])), 0)));
  const barWidth = daily.length === 0 ? 0 : Math.max(2, (PLOT_WIDTH / daily.length) * 0.72);
  const barGap = daily.length === 0 ? 0 : PLOT_WIDTH / daily.length;
  const labels = dateLabelIndexes(daily.length);
  const ticks = maxDaily > 0 ? [maxDaily, maxDaily / 2, 0] : [0];

  if (daily.length === 0 || agents.length === 0) return <EmptyState>{t("costs.chart.empty")}</EmptyState>;

  return (
    <div className="grid gap-[12px]">
      <DailyLegend agents={agents} />
      <div className="overflow-x-auto" data-cost-chart="daily">
        <svg className="h-auto min-w-[560px] w-full" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-labelledby="costs-chart-title">
          <title id="costs-chart-title">{t("costs.chart.aria")}</title>
          {ticks.map((tick) => {
            const y = PLOT_TOP + (maxDaily === 0 ? PLOT_HEIGHT : ((maxDaily - tick) / maxDaily) * PLOT_HEIGHT);
            return (
              <g key={`tick-${tick}`}>
                <line x1={PLOT_LEFT} x2={CHART_WIDTH - PLOT_RIGHT} y1={y} y2={y} className="stroke-[color:var(--border-soft)]" strokeWidth="1" />
                <text x={PLOT_LEFT - 8} y={y + 4} textAnchor="end" className="fill-[color:var(--muted-foreground)] text-[10px]">{money(tick)}</text>
              </g>
            );
          })}
          {daily.map((row, rowIndex) => {
            const x = PLOT_LEFT + rowIndex * barGap + (barGap - barWidth) / 2;
            let offset = 0;
            const total = agents.reduce((sum, agent) => sum + Math.max(0, costNumber(row.byAgent[agent])), 0);
            return (
              <g key={`${row.date}-${rowIndex}`}>
                <title>{`${costDateLabel(row.date, locale)} · ${money(total)}`}</title>
                {agents.map((agent, agentIndex) => {
                  const value = Math.max(0, costNumber(row.byAgent[agent]));
                  const height = maxDaily === 0 ? 0 : (value / maxDaily) * PLOT_HEIGHT;
                  const y = PLOT_TOP + PLOT_HEIGHT - offset - height;
                  offset += height;
                  return height <= 0 ? null : (
                    <rect
                      key={agent}
                      x={x}
                      y={y}
                      width={barWidth}
                      height={height}
                      fill={chartColor(agentIndex)}
                      data-agent={agent}
                    />
                  );
                })}
                {labels.has(rowIndex) ? (
                  <text x={x + barWidth / 2} y={CHART_HEIGHT - 13} textAnchor="middle" className="fill-[color:var(--muted-foreground)] text-[10px]">
                    {costDateLabel(row.date, locale)}
                  </text>
                ) : null}
              </g>
            );
          })}
          <line x1={PLOT_LEFT} x2={CHART_WIDTH - PLOT_RIGHT} y1={PLOT_TOP + PLOT_HEIGHT} y2={PLOT_TOP + PLOT_HEIGHT} className="stroke-[color:var(--border)]" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
};

const amountLabel = (value: CostAmount | null | undefined): string => money(value === null || value === undefined ? null : costNumber(value));
const textOrNone = (value: string, none: string): string => value.length > 0 ? value : none;

const ByAgentTable = ({ rows }: { rows: readonly CostByAgent[] }): ReactNode => {
  const t = useT();
  return (
    <Card title={t("costs.byAgent.title")} flush>
      <Table>
        <TableHeader><TableRow>
          <TableHead>{t("costs.table.agent")}</TableHead>
          <TableHead>{t("costs.table.usd")}</TableHead>
          <TableHead>{t("costs.table.runs")}</TableHead>
          <TableHead>{t("costs.table.avg")}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.agent}>
              <TableCell className={TABLE_NAME}>
                <span className="inline-flex items-center gap-[7px]"><IconRobot />{textOrNone(row.agent, t("common.none"))}</span>
              </TableCell>
              <TableCell>{amountLabel(row.usd)}</TableCell>
              <TableCell>{row.runs}</TableCell>
              <TableCell>{amountLabel(row.avgUsd)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 ? <EmptyState>{t("costs.table.empty")}</EmptyState> : null}
    </Card>
  );
};

const TopRunsTable = ({ rows }: { rows: readonly CostTopRun[] }): ReactNode => {
  const t = useT();
  return (
    <Card title={t("costs.topRuns.title")} flush>
      <Table>
        <TableHeader><TableRow>
          <TableHead>{t("costs.table.task")}</TableHead>
          <TableHead>{t("costs.table.agent")}</TableHead>
          <TableHead>{t("costs.table.model")}</TableHead>
          <TableHead>{t("costs.table.usd")}</TableHead>
          <TableHead>{t("costs.table.started")}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={`${row.startedAt}-${row.taskName}-${index}`}>
              <TableCell className={TABLE_NAME}>{textOrNone(row.taskName, t("common.none"))}</TableCell>
              <TableCell>{textOrNone(row.agent, t("common.none"))}</TableCell>
              <TableCell className={cn(TABLE_SUB, "!inline")}>{textOrNone(row.model, t("common.none"))}</TableCell>
              <TableCell>{amountLabel(row.usd)}</TableCell>
              <TableCell>{formatDateTime(row.startedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 ? <EmptyState>{t("costs.table.empty")}</EmptyState> : null}
    </Card>
  );
};

export const CostsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const [days, setDays] = useState<CostDays>(30);
  const t = useT();
  const path = projectId === "" ? null : `/projects/${encodeURIComponent(projectId)}/costs?days=${days}`;
  const costs = usePoll<CostsResponse>(path, 30_000);
  const data = costs.data;

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("costs.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("costs.head.subtitle", { project: project?.name ?? t("costs.head.thisProject") })}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <label className="grid gap-[6px] text-[12.5px] text-secondary-foreground">
            <span>{t("costs.range.label")}</span>
            <Select value={String(days)} aria-label={t("costs.range.label")} onChange={(event) => {
              const next = Number(event.target.value);
              if ((COST_DAYS as readonly number[]).includes(next)) setDays(next as CostDays);
            }}>
              {COST_DAYS.map((value) => <option key={value} value={value}>{t(`costs.range.${value}`)}</option>)}
            </Select>
          </label>
        </div>
      </div>

      <div className={STACK}>
        {costs.missing ? <GapNotice endpoint="GET /projects/:projectId/costs" what={t("costs.gap")} /> : null}
        {costs.error === null || costs.missing ? null : <ErrorNotice message={`${costs.error.status} ${costs.error.message}`} onRetry={costs.reload} />}
        {data === null ? (
          <Card><EmptyState>{t(costs.loading ? "common.loading" : "costs.empty")}</EmptyState></Card>
        ) : (
          <>
            <div className={METRICS}>
              <Metric label={t("costs.stat.total")} value={amountLabel(data.totalUsd)} />
              <Metric label={t("costs.stat.runs")} value={data.runCount} />
              <Metric label={t("costs.stat.avg")} value={amountLabel(data.avgUsd)} />
            </div>
            <Card title={t("costs.chart.title")}>
              <DailyCostChart daily={data.daily} byAgent={data.byAgent} />
            </Card>
            <ByAgentTable rows={data.byAgent} />
            <TopRunsTable rows={data.topRuns} />
          </>
        )}
      </div>
    </Page>
  );
};
