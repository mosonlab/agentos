import type { ReactNode } from "react";

import { navigate } from "../lib/router";
import { cn } from "../lib/utils";
import { ROW, RowMenu, type RowMenuEntry } from "./ui";

/* The shell is deliberately not fixed-height: cards with fewer facts should
 * not reserve rows. Free text is bounded here because a 2KB failure once made
 * one card 1,792px tall and a long path widened another past its column. */
const CARD = "relative cursor-pointer rounded-xl border border-border bg-card px-[14px] py-[13px] hover:border-[color:var(--border-hover)] has-[a:focus-visible]:border-[color:var(--primary)]";
const TITLE = "line-clamp-3 text-foreground [overflow-wrap:anywhere] hover:underline focus-visible:underline";
/** An explicit minmax column prevents a nowrap row from setting the card's
 * min-content width; this is what keeps schedule prose inside narrow columns. */
const META = "mt-[9px] grid grid-cols-[minmax(0,1fr)] gap-[6px] text-[11.5px] text-muted-foreground";
/** Plain text and a 20px pill share a stable row height. */
const META_ROW = "flex min-h-[20px] flex-wrap items-center gap-[8px]";
const FAILURE = "line-clamp-3 text-[var(--destructive-fg)] [overflow-wrap:anywhere]";
/** Board icons are 13px; the generic button rule would otherwise make them 16px. */
const FOOT = "mt-[10px] flex items-center gap-[10px] text-[11.5px] text-muted-foreground [&_svg]:size-[13px] [&_svg]:flex-none [&_svg]:opacity-85";

const opensCard = (event: React.MouseEvent<HTMLElement>): boolean => {
  if (event.defaultPrevented) return false;
  const target = event.target;
  if (target instanceof Element && target.closest("a, button, [role='menuitem'], [role='menu']") !== null) return false;
  return (window.getSelection()?.toString() ?? "") === "";
};

/**
 * The board card's chrome and click delegation.
 *
 * Callers supply content slots; the module owns the geometry, link/menu header,
 * drag handoff, and the rule that selecting card text must never navigate.
 */
export const BoardCardShell = ({
  cardId,
  chainId,
  route,
  title,
  menuItems,
  menuLabel,
  metaRows,
  failure,
  footer,
  after,
  dragId,
}: {
  cardId: string;
  chainId?: string | undefined;
  route: string;
  title: string;
  menuItems: RowMenuEntry[];
  menuLabel: string;
  metaRows: readonly ReactNode[];
  failure?: ReactNode;
  footer: ReactNode;
  after?: ReactNode;
  dragId?: string | undefined;
}): ReactNode => (
  <article
    data-card={cardId}
    data-chain-card={chainId === undefined ? undefined : ""}
    data-chain-id={chainId}
    className={CARD}
    draggable={dragId === undefined ? undefined : true}
    onDragStart={dragId === undefined ? undefined : (event) => event.dataTransfer.setData("text/plain", dragId)}
    onClick={(event) => { if (opensCard(event)) navigate(route); }}
  >
    <div className={cn(ROW, "items-start")}>
      <h3 className="min-w-0 flex-1 text-[13px] leading-[1.45]">
        <a data-card-title="" href={`#${route}`} className={TITLE}>{title}</a>
      </h3>
      <RowMenu items={menuItems} label={menuLabel} />
    </div>
    <div className={META}>
      {metaRows.map((row, index) => <div className={META_ROW} key={index}>{row}</div>)}
      {failure === undefined ? null : <div className={cn(META_ROW, FAILURE)}>{failure}</div>}
    </div>
    <div className={FOOT}>{footer}</div>
    {after}
  </article>
);
