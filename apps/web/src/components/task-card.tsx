import { type DragEvent, type MouseEvent, type ReactNode, memo, useEffect, useState } from "react";

import { chainPositionMarker } from "../lib/chain";
import { duration, money, timeAgo, usageCostLabel } from "../lib/format";
import { chainBinding, chainBindingLabel, moveTargets, retryable, scheduleLabel, statusLabel } from "../lib/board";
import { type Translate, useT } from "../lib/i18n";
import { mergeBadge } from "../lib/merge-outcome";
import { navigate } from "../lib/router";
import type { BoardTask, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { IconRobot, IconUser } from "./icons";
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
const runLabel = (task: BoardTask, t: Translate): ReactNode => {
  const run = task.latestRun;
  // A card with no run says nothing about runs. "no runs" is what every fresh
  // card said, and a row that is a constant is a row that is not read.
  if (!run) return null;
  // §SF-1. The card's whole run line is one status word, so a mechanical merge
  // that stopped has nowhere else to say so: SUCCEEDED here reads as a merge
  // that happened. The badge is bound server-side to this very run.
  const badge = mergeBadge(task.mergeOutcome);
  const tone = badge?.tone
    ?? (run.status === "SUCCEEDED" ? "green" : run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "LOST" ? "red" : "amber");
  return (
    <span className="inline-flex items-center gap-[6px] whitespace-nowrap">
      <span className={cn(DOT, DOT_TONE[tone])} />
      <span className="text-primary">{t("tasks.card.run", { n: run.runNumber })}</span>
      <span className="text-[color:var(--faint)]"> · {badge ? t(badge.key) : t(`status.run.${run.status}`)}</span>
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
const Assignee = ({ name, label }: { name: string; label: string }): ReactNode => {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      title={name}
      aria-expanded={open}
      aria-label={label}
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
  onFilterChain: (task: BoardTask) => void;
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

export const cardTitle = (task: BoardTask): string => {
  return task.displayName;
};

/** What the card's model line says. The line sits under the run line, so it is
 *  the run's claimed model; a task with no run has only the assignee's
 *  configured model to show. */
export const cardModel = (task: BoardTask): string | null =>
  task.latestRun?.model ?? task.assigneeAgent?.model ?? null;

export const cardTime = (task: BoardTask, t: Translate, now = Date.now()): string => {
  const run = task.latestRun;
  if (!run) return timeAgo(task.updatedAt);
  if (run.status === "RUNNING" && run.startedAt !== null) {
    return t("tasks.card.runningDuration", { duration: duration(run.startedAt, null, now) });
  }
  if (run.startedAt !== null && run.endedAt !== null) {
    return `${duration(run.startedAt, run.endedAt)} · ${timeAgo(task.updatedAt)}`;
  }
  return timeAgo(task.updatedAt);
};

/** Only the changing text owns a clock. Memoized inactive cards never wake. */
export const RunningCardTime = ({ task, t }: { task: BoardTask; t: Translate }): ReactNode => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [task.latestRun?.startedAt]);
  return <>{cardTime(task, t, now)}</>;
};

const menu = (task: BoardTask, actions: CardActions, t: Translate): RowMenuEntry[] => [
  ...(retryable(task, task.latestRun) ? [{ label: t("common.retry"), onSelect: () => actions.onRetry(task) }] : []),
  // Only where there is an error to copy, and it copies the whole of it — the
  // card shows three lines and hover-to-expand a 2KB log is not an answer.
  ...(task.failureReason === null ? [] : [{ label: t("tasks.menu.copyError"), onSelect: () => actions.onCopyError(task) }]),
  { label: t("tasks.menu.archive"), onSelect: () => actions.onArchive(task) },
  { label: t("common.delete"), danger: true, onSelect: () => actions.onDelete(task) },
  // The keyboard's and touch's replacement for the drag (K15/K16).
  { kind: "heading" as const, label: t("tasks.menu.moveTo") },
  ...moveTargets(task.status).map((status) => ({
    label: statusLabel(status),
    onSelect: () => actions.onMove(task, status),
  })),
];

const TaskCardBody = ({ task, actions, draggable = false }: CardProps): ReactNode => {
  const t = useT();
  const assignee = task.assigneeAgent?.title ?? null;
  const schedule = scheduleLabel(task);
  const run = runLabel(task, t);
  const model = cardModel(task);
  const taskCostLabel = usageCostLabel(task.taskCost);
  const hasTokenFallback = task.taskCost !== null && task.taskCost.costUsd === null;
  const title = cardTitle(task);
  const chain = chainBinding(task);
  const chainLabel = chain === null ? null : chainBindingLabel(chain);
  const repair = task.repairOf ?? null;
  return <article
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
        <a data-card-title="" href={`#/tasks/${task.id}`} className={TASK_TITLE}>{title}</a>
      </h3>
      <RowMenu items={menu(task, actions, t)} label={t("tasks.card.actionsFor", { name: task.name })} />
    </div>
    <div className={TASK_META}>
      <div className={TASK_META_ROW}>
        {/* Two lines, not one ellipsized one. Measured in a 170px content box:
            "Waiting for previous step" came out as "Waiting for previous st…"
            and a cron's prose as "At 09:00 AM, only on M…". This line is the
            answer to "what starts this task" — an answer cut off two characters
            from the end is not a shorter answer, it is no answer.
            Null on a `NOW` task, which is nearly every task: the row is shared
            with the pills, so it survives an absent schedule and disappears
            with them. */}
        {schedule === null ? null : <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{schedule}</span>}
        {task.approvalGate ? <Pill tone="amber" className={TASK_PILL}>{t("tasks.pill.approval")}</Pill> : null}
        {/* MANUAL renders nothing: most tasks are manual, and a pill on every
            card would be noise rather than provenance ([A8]). */}
        {task.source === "CRON" ? <Pill tone="grey" className={TASK_PILL}>{t("tasks.pill.cron")}</Pill> : task.source === "WEBHOOK" ? <Pill tone="accent" className={TASK_PILL}>{t("tasks.pill.webhook")}</Pill> : null}
      </div>
      {task.blockedOn ? (
        <div data-card-blocked-on="" className={TASK_META_ROW}>
          <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
            {t("tasks.card.blockedOn", { name: task.blockedOn.taskName })}
          </span>
        </div>
      ) : null}
      {/* No placeholder for a chain-less card (K4). A merge-tail repair task is
          chain-less in its own columns but not in fact, so the row is driven by
          the binding rather than by the chain progress a detached task has none
          of — otherwise the repair card sits on the board with nothing saying
          which chain it belongs to. */}
      {chainLabel === null ? null : (
        <div className={cn(TASK_META_ROW, "overflow-hidden text-ellipsis whitespace-nowrap")}>
          <button
            type="button"
            className="max-w-full overflow-hidden text-ellipsis rounded-full border border-border bg-secondary px-[7px] py-[1px] text-secondary-foreground hover:text-foreground"
            title={chainLabel}
            aria-label={t("tasks.card.filterChain", { name: chainLabel })}
            onClick={(event) => { event.stopPropagation(); actions.onFilterChain(task); }}
          >
            {chainLabel}
          </button>
          {/* Which repair this is, in the chain's own row: a repair card carries
              no step ordinal, and the kind is the only thing that distinguishes
              two repairs of the same chain. */}
          {repair === null
            ? null
            : <Pill tone="amber" className={TASK_PILL}>{t("tasks.pill.repair", { kind: repair.repairKind })}</Pill>}
          {/* The marker keeps the card's node ordinal and the API-derived dense
              execution-layer progress together, without recomputing either. */}
          <span>{chainPositionMarker(task.chainProgress)}</span>
        </div>
      )}
      {run === null ? null : <div className={TASK_META_ROW}>{run}</div>}
      {model === null ? null : (
        <div className={TASK_META_ROW}>
          <span className="min-w-0 [overflow-wrap:anywhere]" aria-label={t("tasks.card.model", { model })}>
            {model}
          </span>
        </div>
      )}
      {task.failureReason === null ? null : <div className={cn(TASK_META_ROW, TASK_FAILURE)}>{task.failureReason}</div>}
    </div>
    <div className={TASK_FOOT}>
      {/* An agent by name, or a person icon and no word. "Unassigned" beside a
          robot was on every card a human owns — which is most of them — and it
          named a state that is not a problem in the vocabulary of the one thing
          the card cannot see: the board projection carries no assignee *type*,
          so an agent task missing its agent is indistinguishable here from a
          task no agent was ever meant to run. */}
      <span className={cn(ROW, "min-w-0 gap-[6px]")}>
        {assignee === null
          ? <IconUser />
          : <><IconRobot /><Assignee name={assignee} label={t("tasks.card.assignee", { name: assignee })} /></>}
      </span>
      <span className="flex-1" />
      {task.taskCost !== null && !hasTokenFallback
        ? <span className="whitespace-nowrap">{taskCostLabel}</span>
        : task.latestRun?.costUsd
          ? <span className="whitespace-nowrap">{money(task.latestRun.costUsd)}</span>
          : null}
      <span className="whitespace-nowrap">
        {task.latestRun?.status === "RUNNING" && task.latestRun.startedAt !== null
          ? <RunningCardTime task={task} t={t} />
          : cardTime(task, t)}
      </span>
    </div>
    {hasTokenFallback ? (
      <div data-task-cost-fallback="" className="mt-[6px] max-w-full whitespace-normal text-[11.5px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">
        {taskCostLabel}
      </div>
    ) : null}
  </article>;
};

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
