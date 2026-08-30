import { type ReactNode, useEffect } from "react";

import { CARD_PAGE_SIZE, type BoardEntry } from "../lib/board";
import { useT } from "../lib/i18n";
import { ChainAggregateCard, type ChainAggregateActions } from "./chain-aggregate-card";
import { type CardActions, TaskCard } from "./task-card";
import { Button } from "./ui/button";

const PAGER = "flex items-center justify-center gap-[8px] pt-[2px]";

export const boardEntryPage = (entries: readonly BoardEntry[], page: number): {
  lastPage: number;
  visiblePage: number;
  visibleEntries: BoardEntry[];
  nextCount: number;
  previousCount: number;
} => {
  const lastPage = Math.max(0, Math.ceil(entries.length / CARD_PAGE_SIZE) - 1);
  const visiblePage = Math.min(page, lastPage);
  const start = visiblePage * CARD_PAGE_SIZE;
  return {
    lastPage,
    visiblePage,
    visibleEntries: entries.slice(start, start + CARD_PAGE_SIZE),
    nextCount: Math.min(CARD_PAGE_SIZE, Math.max(0, entries.length - start - CARD_PAGE_SIZE)),
    previousCount: Math.min(CARD_PAGE_SIZE, start),
  };
};

/** One bounded board-entry list. Its owner holds the page so column-head actions
 *  and the rendered cards always make decisions against the same visible set. */
export const PaginatedBoardEntries = ({ entries, page, onPageChange, actions, aggregateActions, draggable = false }: {
  entries: readonly BoardEntry[];
  page: number;
  onPageChange: (page: number) => void;
  actions: CardActions;
  aggregateActions?: ChainAggregateActions | undefined;
  draggable?: boolean;
}): ReactNode => {
  const t = useT();
  const { lastPage, visiblePage, visibleEntries, nextCount, previousCount } = boardEntryPage(entries, page);

  useEffect(() => {
    if (page > lastPage) onPageChange(lastPage);
  }, [lastPage, onPageChange, page]);

  return <>
    {visibleEntries.map((entry) => entry.kind === "chain"
      ? <ChainAggregateCard key={entry.id} aggregate={entry.aggregate} members={entry.members} representativeTaskId={entry.representativeTaskId} actions={aggregateActions} />
      : <TaskCard key={entry.id} task={entry.task} actions={actions} draggable={draggable && entry.task.moveTargets.length > 0} />)}
    {previousCount > 0 || nextCount > 0 ? (
      <div className={PAGER}>
        {previousCount > 0 ? (
          <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => onPageChange(visiblePage - 1)}>
            {t("tasks.column.previous", { n: previousCount })}
          </Button>
        ) : null}
        {nextCount > 0 ? (
          <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => onPageChange(visiblePage + 1)}>
            {t("tasks.column.more", { n: nextCount })}
          </Button>
        ) : null}
      </div>
    ) : null}
  </>;
};
