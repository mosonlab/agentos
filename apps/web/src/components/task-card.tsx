import { type DragEvent, type MouseEvent, type ReactNode, memo, useState } from "react";

import { chainMarker } from "../lib/chain";
import { money, timeAgo } from "../lib/format";
import { moveTargets, retryable, scheduleLabel, statusLabel } from "../lib/board";
import { navigate } from "../lib/router";
import type { BoardTask, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { IconRobot } from "./icons";
import { DOT, DOT_TONE, Pill, ROW, RowMenu, type RowMenuEntry } from "./ui";

/* The card's geometry, stated once for both layout shells.
 *
 * Every free-text field on this card is bounded. Measured before that was true:
 * one 2,228-character `failureReason` produced a 1,792px card, a long path in
 * another overflowed its card by 193px sideways and was clipped by the column,
 * and 21 of 112 cards carried one. A board card answers "which task, how is it
 * doing"; the full text belongs to the task page, and `Copy error` in the menu
 * hands over the exact string.
 *
 * The card is deliberately *not* a fixed height (K10): a chain-less card with a
 * short title has no business reserving space for rows it does not have. */
const TASK_CARD = "relative cursor-pointer rounded-xl border border-border bg-card px-[14px] py-[13px] hover:border-[color:var(--border-hover)] has-[a:focus-visible]:border-[color:var(--primary)]";
const TASK_TITLE = "line-clamp-3 text-foreground [overflow-wrap:anywhere] hover:underline focus-visible:underline";
/** `grid-cols-[minmax(0,1fr)]` is the whole reason this is bounded. A grid with
 *  no declared columns sizes its implicit one by `auto`, whose *minimum* is the
 *  widest item's min-content — and a `whitespace-nowrap` schedule line has no
 *  min-content smaller than itself. Measured, "At 09:00 AM, only on Monday
 *  (Asia/Shanghai)" made a 196px card 312px wide and the column clipped it. */
const TASK_META = "mt-[9px] grid grid-cols-[minmax(0,1fr)] gap-[6px] text-[11.5px] text-muted-foreground";
/** `min-h-[20px]`: the first meta row is plain text on most cards and text plus
 *  a pill on some, and a pill is 20px against text's 17.25px. Left alone, the
 *  same row changes height by 6.75px depending on whether a task happens to
 *  carry an approval gate, and the board's vertical rhythm stutters card by
 *  card. The pills are pulled down to that same 20px rather than the rows being
 *  pushed up to 24px — 112 cards is the wrong place to spend 4px each. */
const TASK_META_ROW = "flex min-h-[20px] flex-wrap items-center gap-[8px]";
const TASK_PILL = "py-0";
/** Three lines, then stop. Any character may break, because these strings are
 *  mostly paths and URLs and `word-break: normal` cannot break them at all. */
const TASK_FAILURE = "line-clamp-3 text-[var(--destructive-fg)] [overflow-wrap:anywhere]";
/** `size-[13px]`, not the button base's `[&_svg]:size-4`. */
const TASK_FOOT = "mt-[10px] flex items-center gap-[10px] text-[11.5px] text-muted-foreground [&_svg]:size-[13px] [&_svg]:flex-none [&_svg]:opacity-85";

// The board card keeps the run line light — a status dot plus text, as in
// kanban-tasks-board-t1560.jpg; pills are reserved for the task detail header.
const runLabel = (task: BoardTask): ReactNode => {
  const run = task.latestRun;
  if (!run) return <span className="text-[color:var(--faint)]">no runs</span>;
  const tone = run.status === "SUCCEEDED" ? "green" : run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "LOST" ? "red" : "amber";
  return (
    <span className="inline-flex items-center gap-[6px] whitespace-nowrap">
      <span className={cn(DOT, DOT_TONE[tone])} />
      <span className="text-primary">run {run.runNumber}</span>
      <span className="text-[color:var(--faint)]"> · {run.status.toLowerCase().replace("_", " ")}</span>
    </span>
  );
};

/**
 * The assignee, one line, with the rest of the name a keypress away.
 *
 * 59 of the live board's 112 cards truncated this name with no way to see the
 * whole of it — `title` alone is a hover affordance, which is no affordance at
 * all on a touch screen or from the keyboard. A button is the honest element:
 * it is what says "there is more here, and you can ask for it".
 */
const Assignee = ({ name }: { name: string }): ReactNode => {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      title={name}
      aria-expanded={open}
      aria-label={`Assignee ${name}`}
      className={cn(
        "min-w-0 rounded-sm border-0 bg-transparent p-0 text-left text-inherit hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-[color:var(--ring)]",
        open ? "[overflow-wrap:anywhere] whitespace-normal" : "overflow-hidden text-ellipsis whitespace-nowrap",
      )}
      onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
    >
      {name}
    </button>
  );
};

export type CardActions = {
  onMove: (task: BoardTask, status: TaskStatus) => void;
  onRetry: (task: BoardTask) => void;
  onArchive: (task: BoardTask) => void;
  onDelete: (task: BoardTask) => void;
  onCopyError: (task: BoardTask) => void;
};

export type CardProps = {
  task: BoardTask;
  actions: CardActions;
  /** Desktop only. Touch has the menu's `Move to` instead: HTML5 drag does not
   *  exist on touch, and a card that looks draggable and is not is worse than
   *  one that does not. */
  draggable?: boolean;
};

/**
 * Should a click on the card body open the task?
 *
 * The card stays clickable anywhere (K12) but must not steal the three gestures
 * that live inside it: following the title link, working the menu, and selecting
 * text. A drag that ends inside the card also arrives here as a click.
 */
const opensTask = (event: MouseEvent<HTMLElement>): boolean => {
  if (event.defaultPrevented) return false;
  const target = event.target;
  if (target instanceof Element && target.closest("a, button, [role='menuitem'], [role='menu']") !== null) return false;
  return (window.getSelection()?.toString() ?? "") === "";
};

const menu = (task: BoardTask, actions: CardActions): RowMenuEntry[] => [
  ...(retryable(task, task.latestRun) ? [{ label: "Retry", onSelect: () => actions.onRetry(task) }] : []),
  // Only where there is an error to copy, and it copies the whole of it — the
  // card shows three lines and hover-to-expand a 2KB log is not an answer.
  ...(task.failureReason === null ? [] : [{ label: "Copy error", onSelect: () => actions.onCopyError(task) }]),
  { label: "Archive", onSelect: () => actions.onArchive(task) },
  { label: "Delete", danger: true, onSelect: () => actions.onDelete(task) },
  // The keyboard's and touch's replacement for the drag (K15/K16).
  { kind: "heading" as const, label: "Move to" },
  ...moveTargets(task.status).map((status) => ({
    label: statusLabel(status),
    onSelect: () => actions.onMove(task, status),
  })),
];

const TaskCardBody = ({ task, actions, draggable = false }: CardProps): ReactNode => (
  <article
    data-card={task.id}
    className={TASK_CARD}
    draggable={draggable}
    onDragStart={(event: DragEvent<HTMLElement>) => event.dataTransfer.setData("text/plain", task.id)}
    onClick={(event) => { if (opensTask(event)) navigate(`/tasks/${task.id}`); }}
  >
    <div className={cn(ROW, "items-start")}>
      {/* A real link, not an onClick: it is what makes the card reachable by
          keyboard, opens in a new tab on the modifier click every operator
          tries, and gives the card an accessible name it did not have. */}
      <h3 className="min-w-0 flex-1 text-[13px] leading-[1.45]">
        <a data-card-title="" href={`#/tasks/${task.id}`} className={TASK_TITLE}>{task.name}</a>
      </h3>
      <RowMenu items={menu(task, actions)} label={`Actions for ${task.name}`} />
    </div>
    <div className={TASK_META}>
      <div className={TASK_META_ROW}>
        {/* Two lines, not one ellipsized one. Measured in a 170px content box:
            "Waiting for previous step" came out as "Waiting for previous st…"
            and a cron's prose as "At 09:00 AM, only on M…". This line is the
            answer to "what starts this task" — an answer cut off two characters
            from the end is not a shorter answer, it is no answer. */}
        <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{scheduleLabel(task)}</span>
        {task.approvalGate ? <Pill tone="amber" className={TASK_PILL}>Approval</Pill> : null}
        {task.templateId ? <Pill tone="violet" className={TASK_PILL}>Template</Pill> : null}
        {/* MANUAL renders nothing: most tasks are manual, and a pill on every
            card would be noise rather than provenance ([A8]). */}
        {task.source === "CRON" ? <Pill tone="grey" className={TASK_PILL}>cron</Pill> : task.source === "WEBHOOK" ? <Pill tone="accent" className={TASK_PILL}>webhook</Pill> : null}
      </div>
      {/* No placeholder for a chain-less card (K4). */}
      {task.chainProgress ? (
        <div className={cn(TASK_META_ROW, "overflow-hidden text-ellipsis whitespace-nowrap")}>
          {chainMarker(task.chainProgress)}
        </div>
      ) : null}
      <div className={TASK_META_ROW}>{runLabel(task)}</div>
      {task.failureReason === null ? null : <div className={cn(TASK_META_ROW, TASK_FAILURE)}>{task.failureReason}</div>}
    </div>
    <div className={TASK_FOOT}>
      <span className={cn(ROW, "min-w-0 gap-[6px]")}>
        <IconRobot />
        <Assignee name={task.assigneeAgent?.title ?? "Unassigned"} />
      </span>
      <span className="flex-1" />
      {task.latestRun?.costUsd ? <span className="whitespace-nowrap">{money(task.latestRun.costUsd)}</span> : null}
      <span className="whitespace-nowrap">{timeAgo(task.updatedAt)}</span>
    </div>
  </article>
);

/** A card re-renders only when its own row changed.
 *
 *  This is half of the fix; it is inert without the other half. `usePoll` drops
 *  an unchanged response — by validator now, and by body text as a fallback —
 *  and `TasksPage` keeps the previous object for a row whose serialization did
 *  not change, so an unchanged card's `task` prop keeps its identity across a
 *  poll and this comparison short-circuits. The actions object is memoized at
 *  the page for the same reason. */
export const TaskCard = memo(TaskCardBody);
TaskCard.displayName = "TaskCard";
