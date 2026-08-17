import { type DragEvent, type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { money, timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { navigate } from "../lib/router";
import type { Task, TaskStatus } from "../lib/types";
import { IconRobot } from "../components/icons";
import { cn } from "../lib/utils";
import { TasksPageHead } from "../components/tasks-tabs";
import { chainMarker } from "../lib/chain";
import {
  COUNT, DOT, DOT_TONE, ROW, STACK,
  EmptyState, ErrorNotice, InfoNotice, Page, Pill, RowMenu,
} from "../components/ui";
import { Button } from "../components/ui/button";

/** The board owns the viewport instead of the document.
 *
 *  Five columns need 1306px minimum (5 x 250 + 4 x 14) and the content box is
 *  ~680px wide at a 972px viewport, so the board has always been horizontally
 *  scrollable. What made that scrollbar unusable was the board's *height*: the
 *  Done column rendered all 85 cards, so the board grew to ~20,900px and its
 *  horizontal scrollbar sat ~19,600px below the fold. Bounding the page to one
 *  viewport and giving each column its own vertical scroller bounds the board
 *  at ~1 viewport regardless of card count, which puts that scrollbar back on
 *  screen. Card pixels are unchanged; only the column body's height is.
 *
 *  Rejected: a sticky horizontal scrollbar (a second, synthetic scroll surface
 *  that still leaves a 20,000px document to fall through); capping Done with a
 *  "show all" (hides the volume rather than handling it, and the acceptance
 *  bar is explicitly a *full* Done column); paginating Done (the same, plus a
 *  control that has no analogue in the other four columns). */
export const BOARD_PAGE = "flex h-[100dvh] flex-col overflow-hidden pb-[16px] [@media(max-width:900px)]:h-auto [@media(max-width:900px)]:overflow-visible [@media(max-width:900px)]:pb-[16px]";
const BOARD_STACK = "flex min-h-0 flex-1 flex-col gap-[16px]";
/** `overflow-y-hidden`: the board scrolls sideways only. Vertical travel
 *  belongs to the columns, so the wheel never has two candidates. */
export const BOARD = "grid min-h-0 flex-1 grid-flow-col auto-cols-[minmax(250px,1fr)] gap-[14px] overflow-x-auto overflow-y-hidden pb-[10px] [@media(max-width:900px)]:max-h-[72dvh]";
const COLUMN = "flex min-h-0 flex-col";
const COLUMN_HEAD = "flex items-center gap-[8px] px-[2px] pt-0 pb-[12px] text-[12.5px] text-secondary-foreground";
/** The 1% tint is the faint drop region the board draws behind every column,
 *  cards or not — it is a declaration, not decoration.
 *
 *  Scroll contract, stated rather than discovered: the body is the only
 *  vertical scroller on the page. `overscroll-contain` stops a wheel that has
 *  reached the column's end from being handed to an ancestor — there is no
 *  ancestor that scrolls vertically, so chaining would only ever be a surprise.
 *  `overflow-x-hidden` keeps the body from claiming horizontal wheel/trackpad
 *  gestures, which chain up to the board and move it sideways. The head sits
 *  outside the scroller, so `Archive All` and the column count never leave the
 *  screen; `RowMenu` portals out of the DOM, so a card menu is not clipped. */
export const COLUMN_BODY = "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-[10px] overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl border border-[color:var(--border-soft)] bg-[color-mix(in_srgb,var(--foreground)_1%,transparent)] p-[10px]";
const COLUMN_BODY_OVER = "border-[color:var(--primary-soft)] bg-[color-mix(in_srgb,var(--primary)_4%,transparent)]";
const COLUMN_EMPTY = "px-0 py-[26px] text-center text-[12px] text-[color:var(--faint)]";
const TASK_CARD = "cursor-pointer rounded-xl border border-border bg-card px-[14px] py-[13px] hover:border-[color:var(--border-hover)]";
const TASK_META = "mt-[9px] grid gap-[6px] text-[11.5px] text-muted-foreground";
const TASK_META_ROW = "flex flex-wrap items-center gap-[8px]";
/** `size-[13px]`, not the button base's `[&_svg]:size-4`. */
const TASK_FOOT = "mt-[10px] flex items-center gap-[10px] text-[11.5px] text-muted-foreground [&_svg]:size-[13px] [&_svg]:flex-none [&_svg]:opacity-85";

export const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  // Backlog is first: it is where work waits before it is queued, and the
  // scheduler never picks anything out of it.
  { status: "BACKLOG", label: "Backlog" },
  { status: "TODO", label: "Todo" },
  { status: "DOING", label: "Doing" },
  { status: "REVIEW", label: "Review" },
  { status: "DONE", label: "Done" },
];

// The board card keeps the run line light — a status dot plus text, as in
// kanban-tasks-board-t1560.jpg; pills are reserved for the task detail header.
const runLabel = (task: Task): ReactNode => {
  const run = task.runs[0];
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

// A retry only lands once the last run is terminal; the API rejects the rest.
export const retryable = (task: Task): boolean => {
  const run = task.runs[0];
  if (!run) return false;
  if (run.status === "QUEUED" || run.status === "CLAIMED" || run.status === "PROVISIONING" || run.status === "RUNNING") return false;
  return task.status === "REVIEW" || task.failureReason !== null || run.status !== "SUCCEEDED";
};

/** The two shapes of the Archive All result, as one string. Exported so the
 *  message is testable without driving a click through a static render. */
export const archiveDoneNotice = (result: { archived: number; skipped: number }): string =>
  (result.skipped > 0
    ? `Archived ${result.archived}, skipped ${result.skipped} (running)`
    : `Archived ${result.archived}`);

type CardProps = {
  task: Task;
  onDelete: (task: Task) => void;
  onRetry: (task: Task) => void;
  onArchive: (task: Task) => void;
};

const TaskCardBody = ({ task, onDelete, onRetry, onArchive }: CardProps): ReactNode => {
  const run = task.runs[0];
  return (
    <article
      className={TASK_CARD}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/plain", task.id)}
      onClick={() => navigate(`/tasks/${task.id}`)}
    >
      <div className={cn(ROW, "items-start")}>
        <h3 className="flex-1 text-[13px] leading-[1.45]">{task.name}</h3>
        <RowMenu items={[
          ...(retryable(task) ? [{ label: "Retry", onSelect: () => onRetry(task) }] : []),
          { label: "Archive", onSelect: () => onArchive(task) },
          { label: "Delete", danger: true, onSelect: () => onDelete(task) },
        ]} />
      </div>
      <div className={TASK_META}>
        <div className={TASK_META_ROW}>
          <span>{task.scheduleKind === "NOW" ? "Once" : task.scheduleKind.toLowerCase()}</span>
          {task.approvalGate ? <Pill tone="amber">Approval</Pill> : null}
          {task.templateId ? <Pill tone="violet">Template</Pill> : null}
          {/* MANUAL renders nothing: most tasks are manual, and a pill on every
              card would be noise rather than provenance ([A8]). */}
          {task.source === "CRON" ? <Pill tone="grey">cron</Pill> : task.source === "WEBHOOK" ? <Pill tone="accent">webhook</Pill> : null}
        </div>
        {/* No placeholder for a chain-less card (K4). */}
        {task.chainProgress ? (
          <div className={cn(TASK_META_ROW, "overflow-hidden text-ellipsis whitespace-nowrap")}>
            {chainMarker(task.chainProgress)}
          </div>
        ) : null}
        <div className={TASK_META_ROW}>{runLabel(task)}</div>
        {task.failureReason === null ? null : <div className={cn(TASK_META_ROW, "text-[var(--destructive-fg)]")}>{task.failureReason}</div>}
      </div>
      <div className={TASK_FOOT}>
        <span className={cn(ROW, "min-w-0 gap-[6px] overflow-hidden whitespace-nowrap")}>
          <IconRobot />
          <span className="overflow-hidden text-ellipsis">{task.assigneeAgent?.title ?? "Unassigned"}</span>
        </span>
        <span className="flex-1" />
        {run?.session?.costUsd ? <span className="whitespace-nowrap">{money(run.session.costUsd)}</span> : null}
        <span className="whitespace-nowrap">{timeAgo(task.updatedAt)}</span>
      </div>
    </article>
  );
};

/** A card re-renders only when its own row changed.
 *
 *  This is half of the fix; it is inert without the other half. `usePoll` now
 *  drops a byte-identical response, and `TasksPage` keeps the previous object
 *  for a row whose serialization did not change, so an unchanged card's `task`
 *  prop keeps its identity across a poll and this comparison short-circuits.
 *  The card props are `useCallback`-stable for the same reason. */
export const TaskCard = memo(TaskCardBody);
TaskCard.displayName = "TaskCard";

/** One board column, extracted so its three rules — the head, the `Archive All`
 *  presence rule and the empty-state drop invitation — can be asserted from
 *  rendered markup rather than from the page's source text. */
export const BoardColumn = ({ column, tasks, loading, dragOver, onDragOver, onDragLeave, onDrop, onArchiveDone, cardProps }: {
  column: { status: TaskStatus; label: string };
  tasks: Task[];
  loading: boolean;
  dragOver: TaskStatus | null;
  onDragOver: (status: TaskStatus) => void;
  onDragLeave: (status: TaskStatus) => void;
  onDrop: (taskId: string, status: TaskStatus) => void;
  onArchiveDone: () => void;
  cardProps: Omit<CardProps, "task">;
}): ReactNode => (
  <div className={COLUMN}>
    <div className={COLUMN_HEAD}>
      {column.label}<span className={COUNT}>{tasks.length}</span>
      {/* Only on a non-empty Done column: a button that would archive nothing
          is not offered (A2). */}
      {column.status === "DONE" && tasks.length > 0 ? (
        <>
          <span className="flex-1" />
          <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={onArchiveDone}>
            Archive All
          </Button>
        </>
      ) : null}
    </div>
    <div
      className={cn(COLUMN_BODY, dragOver === column.status && COLUMN_BODY_OVER)}
      onDragOver={(event) => { event.preventDefault(); onDragOver(column.status); }}
      onDragLeave={() => onDragLeave(column.status)}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(event.dataTransfer.getData("text/plain"), column.status);
      }}
    >
      {tasks.map((task) => <TaskCard key={task.id} task={task} {...cardProps} />)}
      {/* Every column gets the same invitation, Backlog included (E16). */}
      {tasks.length === 0 ? <div className={COLUMN_EMPTY}>{loading ? "Loading…" : "Drop tasks here"}</div> : null}
    </div>
  </div>
);

/** How close to the board's edge a drag has to get before the board starts
 *  moving under it, and how many pixels per tick it then moves. */
const DRAG_EDGE_PX = 76;
const DRAG_STEP_PX = 12;
const DRAG_TICK_MS = 16;

export type HeldRows = Map<string, { key: string; row: Task }>;

/** Keeps the previous object for every row whose serialization is unchanged.
 *
 *  `usePoll` already drops an identical *payload*; this handles the case where
 *  one row moved and 111 did not. Without it a single `updatedAt` tick hands
 *  112 fresh objects to 112 memoized cards and defeats all of them. Runs once
 *  per genuinely-changed payload, not once per poll. */
export const stableRows = (rows: readonly Task[], held: HeldRows): { rows: Task[]; held: HeldRows } => {
  const next: HeldRows = new Map();
  return {
    rows: rows.map((row) => {
      const key = JSON.stringify(row);
      const previous = held.get(row.id);
      const kept = previous !== undefined && previous.key === key ? previous.row : row;
      next.set(row.id, { key, row: kept });
      return kept;
    }),
    held: next,
  };
};

/** Which way the board should travel while a drag hovers at `clientX`, in
 *  pixels per tick. Zero anywhere but within `DRAG_EDGE_PX` of an edge. */
export const dragEdgeStep = (clientX: number, box: { left: number; right: number }): number =>
  (clientX - box.left < DRAG_EDGE_PX ? -DRAG_STEP_PX
    : box.right - clientX < DRAG_EDGE_PX ? DRAG_STEP_PX
      : 0);

const useStableRows = (rows: readonly Task[]): Task[] => {
  const held = useRef<HeldRows>(new Map());
  return useMemo(() => {
    const result = stableRows(rows, held.current);
    held.current = result.held;
    return result.rows;
  }, [rows]);
};

export const TasksPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  // `enrich` stays on: the board card reads `chainProgress` (`chainMarker`), so
  // the Projects page's `?enrich=false` opt-out is not available here. The two
  // *other* enriched fields — `recurringLastFiredAt` / `recurringFireCount` —
  // are dead weight for this page but ride the same flag, and splitting the
  // flag is an API change, not a board fix.
  const tasksPath = projectId === "" ? null : `/tasks?projectId=${encodeURIComponent(projectId)}`;
  const { data, loading, error, reload } = usePoll<Task[]>(tasksPath);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { error: actionError, run } = useAction();
  const tasks = useStableRows(useMemo(() => data ?? [], [data]));
  const byStatus = useMemo(() => {
    const groups = new Map<TaskStatus, Task[]>(COLUMNS.map((column) => [column.status, []]));
    for (const task of tasks) groups.get(task.status)?.push(task);
    return groups;
  }, [tasks]);

  // Held in a ref so `move` does not have to re-declare itself, and the memoized
  // card callbacks below stay stable, every time a task list arrives.
  const latest = useRef(tasks);
  latest.current = tasks;

  const move = useCallback((taskId: string, status: TaskStatus): void => {
    const task = latest.current.find((candidate) => candidate.id === taskId);
    if (!task || task.status === status) return;
    void run(async () => { await api.patch(`/tasks/${taskId}`, { status }); reload(); });
  }, [run, reload]);
  const remove = useCallback((task: Task): void => {
    if (!window.confirm(`Delete task ${task.name}?`)) return;
    void run(async () => { await api.delete(`/tasks/${task.id}`); reload(); });
  }, [run, reload]);
  const retry = useCallback((task: Task): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/retry`, {}); reload(); });
  }, [run, reload]);
  const archive = useCallback((task: Task): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/archive`, {}); reload(); });
  }, [run, reload]);
  const cardProps = useMemo(() => ({ onDelete: remove, onRetry: retry, onArchive: archive }), [remove, retry, archive]);

  // Only ~2.5 of five columns fit at a 972px viewport, so a drag that starts in
  // Todo cannot reach Done without the board moving — and a drag is holding the
  // pointer, so the scrollbar is not available. Holding near an edge scrolls the
  // board under the drag.
  //
  // `setInterval`, not `requestAnimationFrame`: measured in Chrome, rAF is
  // starved while a native HTML5 drag loop owns the main thread (a two-second
  // edge hold produced a single 16px frame), and it is throttled to ~1 fps in an
  // occluded window. A timer keeps firing in both cases. The loop is also what
  // makes a *stationary* hold work — `dragover` is not guaranteed to keep firing
  // when the pointer does not move.
  const boardRef = useRef<HTMLDivElement>(null);
  const edge = useRef(0);
  const timer = useRef(0);
  const stopEdgeScroll = useCallback((): void => {
    edge.current = 0;
    if (timer.current !== 0) { window.clearInterval(timer.current); timer.current = 0; }
  }, []);
  const onBoardDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    const board = boardRef.current;
    if (!board) return;
    edge.current = dragEdgeStep(event.clientX, board.getBoundingClientRect());
    if (edge.current === 0) { stopEdgeScroll(); return; }
    if (timer.current === 0) {
      timer.current = window.setInterval(() => {
        if (boardRef.current && edge.current !== 0) boardRef.current.scrollLeft += edge.current;
      }, DRAG_TICK_MS);
    }
  }, [stopEdgeScroll]);
  // `dragleave` bubbles: crossing from a card to its column fires one at the
  // board with `relatedTarget` still inside the board. Stopping on those would
  // reduce the edge scroll to one tick per `dragover`.
  const onBoardDragLeave = useCallback((event: DragEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    stopEdgeScroll();
  }, [stopEdgeScroll]);
  useEffect(() => stopEdgeScroll, [stopEdgeScroll]);
  /** `api.post` is called for its payload, which `useAction.run` discards — but
   *  the call still runs *inside* `run`, so failures land in the same
   *  `ErrorNotice` as everything else on the page. One error surface, one
   *  information surface. */
  const archiveDone = async (): Promise<void> => {
    const done = tasks.filter((task) => task.status === "DONE");
    if (!window.confirm(`Archive ${done.length} done tasks?`)) return;
    setNotice(null);
    let result: { archived: number; skipped: number } | null = null;
    const ok = await run(async () => {
      result = await api.post<{ archived: number; skipped: number }>(`/projects/${projectId}/tasks/archive-done`, {});
      reload();
    });
    if (ok && result !== null) setNotice(archiveDoneNotice(result));
  };

  if (projectId === "") return <Page><EmptyState>Select a project first.</EmptyState></Page>;

  return (
    <Page className={cn("text-foreground", BOARD_PAGE)}>
      <TasksPageHead active="tasks" onCreated={reload} />

      <div className={cn(STACK, BOARD_STACK, "mt-4")}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {notice === null ? null : <InfoNotice message={notice} onDismiss={() => setNotice(null)} />}

        <div
          ref={boardRef}
          className={BOARD}
          onDragOver={onBoardDragOver}
          onDragLeave={onBoardDragLeave}
          onDragEnd={stopEdgeScroll}
          onDrop={stopEdgeScroll}
        >
          {COLUMNS.map((column) => (
            <BoardColumn
              key={column.status}
              column={column}
              tasks={byStatus.get(column.status) ?? []}
              loading={loading}
              dragOver={dragOver}
              onDragOver={setDragOver}
              onDragLeave={(status) => setDragOver((current) => (current === status ? null : current))}
              onDrop={(taskId, status) => { setDragOver(null); stopEdgeScroll(); move(taskId, status); }}
              onArchiveDone={() => void archiveDone()}
              cardProps={cardProps}
            />
          ))}
        </div>
      </div>
    </Page>
  );
};
