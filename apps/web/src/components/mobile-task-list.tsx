import { type ReactNode, useEffect, useState } from "react";

import { COLUMNS, type BoardEntry, type Counts, normalizeBoardEntries } from "../lib/board";
import { useT } from "../lib/i18n";
import type { BoardTask, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { type ChainAggregateActions } from "./chain-aggregate-card";
import { PaginatedBoardEntries } from "./paginated-board-entries";
import { type CardActions } from "./task-card";
import { COUNT } from "./ui";
import { Button } from "./ui/button";

/**
 * The board below 901px: status tabs and one column of cards.
 *
 * Not the desktop grid made narrow. Measured at 800x800, the five-column board
 * kept a ~72dvh surface while its columns grew to 22,543px and it clipped its
 * own vertical overflow, so roughly 22,000px of cards — most of the board — were
 * unreachable by any gesture: the columns had no scrollbar left, the board took
 * only horizontal travel, and the document was 1,112px tall. At 390x844 the same
 * arithmetic held.
 *
 * So: one status at a time, no nested scroller, no fixed height. The document
 * scrolls, which is the only scroll a phone reliably has, and every card in the
 * selected status is reachable by scrolling to it.
 */
const TABS = "sticky top-0 z-[3] -mx-[16px] flex gap-[6px] overflow-x-auto border-b border-[color:var(--border-soft)] bg-popover px-[16px] py-[10px]";
const TAB = "flex flex-none items-center gap-[6px] rounded-lg border border-transparent px-[11px] py-[6px] text-[12.5px] whitespace-nowrap text-muted-foreground";
const TAB_ON = "border-border bg-accent text-foreground";
const LIST = "mt-[14px] grid grid-cols-[minmax(0,1fr)] gap-[10px]";
const LIST_EMPTY = "px-0 py-[40px] text-center text-[12.5px] text-[color:var(--faint)]";
const LIST_TOOLBAR = "mt-[14px] flex items-center gap-[10px]";

export const MobileTaskList = ({ tab, counts, tasks, loading, onSelectTab, onArchiveDone, actions, aggregateActions, listRef }: {
  tab: TaskStatus;
  counts: Counts;
  tasks: readonly (BoardEntry | BoardTask)[];
  loading: boolean;
  onSelectTab: (status: TaskStatus) => void;
  onArchiveDone: () => void;
  actions: CardActions;
  aggregateActions?: ChainAggregateActions | undefined;
  listRef: React.RefObject<HTMLDivElement | null>;
}): ReactNode => {
  const t = useT();
  const entries = normalizeBoardEntries(tasks);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [tab]);
  return <>
    {/* A tablist, not five buttons: it is the page's primary navigation and the
        arrow keys are what a screen reader user reaches for. */}
    <div className={TABS} role="tablist" aria-label={t("tasks.mobile.statusTabs")}>
      {COLUMNS.map((column) => (
        <button
          key={column.status}
          type="button"
          role="tab"
          id={`tab-${column.status}`}
          aria-selected={tab === column.status}
          aria-controls="mobile-task-list"
          tabIndex={tab === column.status ? 0 : -1}
          className={cn(TAB, tab === column.status && TAB_ON)}
          onClick={() => onSelectTab(column.status)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (step === 0) return;
            event.preventDefault();
            const index = COLUMNS.findIndex((candidate) => candidate.status === tab);
            const next = COLUMNS[(index + step + COLUMNS.length) % COLUMNS.length]!;
            onSelectTab(next.status);
            document.getElementById(`tab-${next.status}`)?.focus();
          }}
        >
          {t(column.labelKey)}<span className={COUNT}>{counts[column.status]}</span>
        </button>
      ))}
    </div>

    {/* Archive All lives here on a phone rather than in a column head there is
        no room for, and only on the tab it acts on (K7). */}
    {tab === "DONE" && entries.length > 0 ? (
      <div className={LIST_TOOLBAR}>
        <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={onArchiveDone}>
          {t("tasks.archiveAll")}
        </Button>
      </div>
    ) : null}

    <div
      id="mobile-task-list"
      ref={listRef}
      role="tabpanel"
      aria-labelledby={`tab-${tab}`}
      tabIndex={-1}
      className={cn(LIST, "focus-visible:outline-none")}
    >
      {/* No `draggable`: HTML5 drag does not fire on touch, and a card that
          looks draggable and is not is worse than one that does not (K15). */}
      <PaginatedBoardEntries entries={entries} page={page} onPageChange={setPage} actions={actions} aggregateActions={aggregateActions} />
      {entries.length === 0 ? <div className={LIST_EMPTY}>{t(loading ? "common.loading" : "tasks.column.nothing")}</div> : null}
    </div>
  </>;
};
