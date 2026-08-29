import { type MouseEvent, type ReactNode } from "react";

import { duration, timeAgo, usageCostLabel } from "../lib/format";
import type { BoardTask, ChainAggregate, ChainAggregateState } from "../lib/types";
import { cn } from "../lib/utils";
import { navigate } from "../lib/router";
import { IconLock } from "./icons";
import { DOT, DOT_TONE, Pill, ROW, RowMenu, type RowMenuEntry } from "./ui";
import { Button } from "./ui/button";
import { useT, type Translate } from "../lib/i18n";

const CARD = "relative cursor-pointer rounded-xl border border-border bg-card px-[14px] py-[13px] hover:border-[color:var(--border-hover)] has-[a:focus-visible]:border-[color:var(--primary)]";
const TITLE = "line-clamp-2 text-foreground [overflow-wrap:anywhere] hover:underline focus-visible:underline";
const META = "mt-[9px] grid grid-cols-[minmax(0,1fr)] gap-[6px] text-[11.5px] text-muted-foreground";
const META_ROW = "flex min-h-[20px] flex-wrap items-center gap-[8px]";
const FOOT = "mt-[10px] flex items-center gap-[10px] text-[11.5px] text-muted-foreground";
const FAILURE = "line-clamp-3 text-[var(--destructive-fg)] [overflow-wrap:anywhere]";

export type ChainAggregateActions = {
  onActivate: (taskId: string) => void;
  onFilter: (aggregate: ChainAggregate) => void;
  onArchive: (aggregate: ChainAggregate, memberTaskIds: readonly string[]) => void;
};

const STATE_TONE: Record<ChainAggregateState, "green" | "amber" | "grey"> = {
  "parked-unactivated": "grey",
  "waiting-on-predecessor": "amber",
  running: "amber",
  idle: "grey",
  settled: "green",
};

const ACTIVE_RUNS = new Set(["QUEUED", "CLAIMED", "PROVISIONING", "RUNNING"]);

const chainName = (aggregate: ChainAggregate): string => aggregate.chainName ?? aggregate.chainId.slice(0, 8);

const memberPosition = (aggregate: ChainAggregate, members: readonly BoardTask[]): number => {
  const fromFrontier = aggregate.frontier?.position;
  if (fromFrontier !== null && fromFrontier !== undefined) return fromFrontier;
  const frontier = aggregate.frontier === null ? null : members.find((member) => member.id === aggregate.frontier?.taskId);
  const fromMember = frontier?.chainProgress?.position ?? (frontier?.chainIndex === null || frontier?.chainIndex === undefined ? null : frontier.chainIndex + 1);
  if (fromMember !== null && fromMember !== undefined) return fromMember;
  const done = aggregate.statusCounts.DONE ?? 0;
  return aggregate.stepCount === 0 ? 0 : Math.min(aggregate.stepCount, done + 1);
};

const aggregateCost = (value: ChainAggregate["totalCost"]): string =>
  value === null ? "—" : usageCostLabel(value);

const runLine = (aggregate: ChainAggregate, t: Translate): ReactNode => {
  const run = aggregate.frontier?.latestRun;
  if (run === null || run === undefined) return null;
  const active = ACTIVE_RUNS.has(run.status);
  const tone = run.status === "SUCCEEDED" ? "green" : run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "LOST" ? "red" : "amber";
  const elapsed = active && run.startedAt !== null ? t("tasks.card.runningDuration", { duration: duration(run.startedAt, null) }) : null;
  return <span data-chain-frontier-run="" className="inline-flex min-w-0 items-center gap-[6px] whitespace-nowrap">
    <span className={cn(DOT, DOT_TONE[tone])} />
    <span className="text-primary">{t("tasks.card.run", { n: run.runNumber })}</span>
    <span className="overflow-hidden text-ellipsis text-[color:var(--faint)]"> · {t(`status.run.${run.status}`)}{elapsed === null ? "" : ` · ${elapsed}`}</span>
  </span>;
};

const routeFor = (representativeTaskId: string): string => `/tasks/${representativeTaskId}`;

const menu = (
  aggregate: ChainAggregate,
  representativeTaskId: string,
  memberTaskIds: readonly string[],
  actions: ChainAggregateActions,
  t: Translate,
): RowMenuEntry[] => [
  { label: t("tasks.aggregate.menu.open"), onSelect: () => navigate(routeFor(representativeTaskId)) },
  ...(aggregate.activation.state === "parked-unactivated" && aggregate.activation.taskId !== null
    ? [{ label: t("tasks.aggregate.menu.activate"), onSelect: () => actions.onActivate(aggregate.activation.taskId!) }]
    : []),
  { label: t("tasks.aggregate.menu.filter"), onSelect: () => actions.onFilter(aggregate) },
  ...(aggregate.activation.state === "settled"
    ? [{ label: t("tasks.aggregate.menu.archive"), onSelect: () => actions.onArchive(aggregate, memberTaskIds) }]
    : []),
];

export const ChainAggregateCard = ({ aggregate, members = [], representativeTaskId, actions }: {
  aggregate: ChainAggregate;
  members?: readonly BoardTask[];
  representativeTaskId?: string;
  actions?: ChainAggregateActions | undefined;
}): ReactNode => {
  const t = useT();
  const representative = representativeTaskId ?? aggregate.frontier?.taskId ?? members[0]?.id ?? aggregate.chainId;
  const title = chainName(aggregate);
  const position = memberPosition(aggregate, members);
  const state = aggregate.activation.state;
  const predecessor = aggregate.activation.predecessor ?? null;
  const memberTaskIds = members.map((member) => member.id);
  const handlers: ChainAggregateActions = actions ?? { onActivate: () => undefined, onFilter: () => undefined, onArchive: () => undefined };
  const frontierRun = runLine(aggregate, t);
  const onBodyClick = (event: MouseEvent<HTMLElement>): void => {
    const target = event.target;
    if (target instanceof Element && target.closest("a, button, [role='menuitem'], [role='menu']") !== null) return;
    navigate(routeFor(representative));
  };
  return <article
    data-card={`chain:${aggregate.chainId}`}
    data-chain-card=""
    data-chain-id={aggregate.chainId}
    className={CARD}
    onClick={onBodyClick}
  >
    <div className={cn(ROW, "items-start")}>
      <h3 className="min-w-0 flex-1 text-[13px] leading-[1.45]">
        <a data-card-title="" href={`#${routeFor(representative)}`} className={TITLE}>{title}</a>
      </h3>
      <RowMenu items={menu(aggregate, representative, memberTaskIds, handlers, t)} label={t("tasks.aggregate.actionsFor", { name: title })} />
    </div>
    <div className={META}>
      <div data-chain-progress="" className={META_ROW}>
        <span>{t("tasks.aggregate.progress", { current: position, total: aggregate.stepCount })}</span>
        <Pill tone={STATE_TONE[state]}>{t(`tasks.aggregate.state.${state}`)}</Pill>
      </div>
      {aggregate.frontier === null ? null : (
        <div data-chain-frontier="" className={META_ROW}>
          <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{aggregate.frontier.title}</span>
          <button
            type="button"
            className="ml-auto flex-none rounded-full border border-border bg-secondary px-[7px] py-[1px] text-secondary-foreground hover:text-foreground"
            title={t("tasks.aggregate.filter")}
            aria-label={t("tasks.card.filterChain", { name: title })}
            onClick={(event) => { event.stopPropagation(); handlers.onFilter(aggregate); }}
          >
            {t("tasks.aggregate.filter")}
          </button>
        </div>
      )}
      {frontierRun === null ? null : <div className={META_ROW}>{frontierRun}</div>}
      {aggregate.frontier?.failureReason === null || aggregate.frontier?.failureReason === undefined ? null : (
        <div data-chain-failure="" className={cn(META_ROW, FAILURE)}>{aggregate.frontier.failureReason}</div>
      )}
      {state === "parked-unactivated" && aggregate.activation.taskId !== null ? (
        <div className={META_ROW}>
          <Button type="button" variant="legacyPrimary" size="legacySmall" onClick={(event) => { event.stopPropagation(); handlers.onActivate(aggregate.activation.taskId!); }}>
            {t("tasks.aggregate.activate")}
          </Button>
        </div>
      ) : state === "waiting-on-predecessor" && predecessor !== null ? (
        <div data-chain-locked="" className={cn(META_ROW, "text-[color:var(--status-amber-fg)]")}>
          <IconLock /> <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{t("tasks.aggregate.waitingOn", { name: predecessor.taskName })}</span>
        </div>
      ) : null}
    </div>
    <div className={FOOT}>
      <span>{t("tasks.aggregate.cost", { amount: aggregateCost(aggregate.totalCost) })}</span>
      <span className="flex-1" />
      <span>{timeAgo(aggregate.createdAt)}</span>
    </div>
  </article>;
};
