import type { ReactNode } from "react";

import { timeAgo, usageCostLabel } from "../lib/format";
import type { BoardTask, ChainAggregate, ChainAggregateState } from "../lib/types";
import { navigate } from "../lib/router";
import { BoardCardShell } from "./board-card-shell";
import { IconLock } from "./icons";
import { RunLine } from "./run-line";
import { Pill, type RowMenuEntry } from "./ui";
import { Button } from "./ui/button";
import { useT, type Translate } from "../lib/i18n";

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

const chainName = (aggregate: ChainAggregate): string => aggregate.chainName ?? aggregate.chainId.slice(0, 8);

const memberPosition = (aggregate: ChainAggregate, members: readonly BoardTask[]): number => {
  const fromFrontier = aggregate.frontier.position;
  if (fromFrontier !== null && fromFrontier !== undefined) return fromFrontier;
  const frontier = members.find((member) => member.id === aggregate.frontier.taskId);
  const fromMember = frontier === undefined
    ? null
    : frontier.chainProgress?.position ?? (frontier.chainIndex === null ? null : frontier.chainIndex + 1);
  if (fromMember !== null && fromMember !== undefined) return fromMember;
  const done = aggregate.statusCounts.DONE;
  return aggregate.stepCount === 0 ? 0 : Math.min(aggregate.stepCount, done + 1);
};

const aggregateCost = (value: ChainAggregate["totalCost"]): string =>
  value === null ? "—" : usageCostLabel(value);

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
  const representative = representativeTaskId ?? aggregate.frontier.taskId;
  const title = chainName(aggregate);
  const position = memberPosition(aggregate, members);
  const state = aggregate.activation.state;
  const predecessor = aggregate.activation.predecessor;
  const memberTaskIds = members.map((member) => member.id);
  const activeRepair = aggregate.activeRepair;
  const handlers: ChainAggregateActions = actions ?? { onActivate: () => undefined, onFilter: () => undefined, onArchive: () => undefined };
  const metaRows: ReactNode[] = [
      <span data-chain-progress="" className="contents">
        <span>{t("tasks.aggregate.progress", { current: position, total: aggregate.stepCount })}</span>
        <Pill tone={STATE_TONE[state]}>{t(`tasks.aggregate.state.${state}`)}</Pill>
      </span>,
      <span data-chain-frontier="" className="contents">
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
      </span>,
      ...(aggregate.frontier.latestRun === null ? [] : [
        <RunLine run={aggregate.frontier.latestRun} mergeOutcome={aggregate.frontier.mergeOutcome} showElapsed showModel />,
      ]),
      ...(activeRepair?.latestRun === null || activeRepair?.latestRun === undefined ? [] : [
        <span data-chain-repair="" className="contents">
          <span>{activeRepair.repairKind}</span>
          <span aria-hidden="true"> · </span>
          <RunLine run={activeRepair.latestRun} showElapsed showModel />
        </span>,
      ]),
      ...(state === "parked-unactivated" && aggregate.activation.taskId !== null ? [
          <Button type="button" variant="legacyPrimary" size="legacySmall" onClick={(event) => { event.stopPropagation(); handlers.onActivate(aggregate.activation.taskId!); }}>
            {t("tasks.aggregate.activate")}
          </Button>,
      ] : state === "waiting-on-predecessor" && predecessor !== null ? [
        <span data-chain-locked="" className="contents text-[color:var(--status-amber-fg)]">
          <IconLock /> <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{t("tasks.aggregate.waitingOn", { name: predecessor.taskName })}</span>
        </span>,
      ] : []),
  ];
  return <BoardCardShell
    cardId={`chain:${aggregate.chainId}`}
    chainId={aggregate.chainId}
    route={routeFor(representative)}
    title={title}
    menuItems={menu(aggregate, representative, memberTaskIds, handlers, t)}
    menuLabel={t("tasks.aggregate.actionsFor", { name: title })}
    metaRows={metaRows}
    failure={aggregate.frontier.failureReason === null
      ? undefined
      : <span data-chain-failure="">{aggregate.frontier.failureReason}</span>}
    footer={<>
      <span>{t("tasks.aggregate.cost", { amount: aggregateCost(aggregate.totalCost) })}</span>
      <span className="flex-1" />
      <span>{timeAgo(aggregate.createdAt)}</span>
    </>}
  />;
};
