import { type DragEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { COLUMNS, type Edges, clampScroll, columnStep, edgeState, sameEdges, scrollKey, storedScroll } from "../lib/board";
import { useT } from "../lib/i18n";
import { storage } from "../lib/storage";
import type { BoardTask, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { COUNT } from "./ui";
import { Button } from "./ui/button";
import { type CardActions, TaskCard } from "./task-card";

/**
 * The board is one scroll surface, in both directions.
 *
 * What was here before gave each of the five columns its own `overflow-y-auto`
 * and left the board horizontal-only. Measured, that produced: a wheel over
 * Backlog, Doing or Review — none of which overflowed — moving nothing at all;
 * Todo and Done scrolled to unrelated positions; a horizontal trackpad gesture
 * over the *cards* swallowed by the column's own `overflow-x-hidden` and moving
 * the board not at all, so only the column heads and the bottom scrollbar
 * accepted it; and the two columns that did overflow rendering their cards 10px
 * narrower than the three that did not, because a native scrollbar took the
 * width out of the content box.
 *
 * One scroller answers all four. Any wheel anywhere over the board moves the
 * board, on either axis, because there is nothing else that could take it. The
 * column heads stay put with `position: sticky` inside it. All five columns
 * share one vertical position, which is what a kanban board means — a short
 * column ending in whitespace beside a long one is the standard behaviour, not
 * a defect.
 */
export const BOARD = "min-h-0 flex-1 overflow-auto overscroll-x-contain [scrollbar-gutter:stable]";
/**
 * Five fixed 250px columns below 1440px, five equal ones above it.
 *
 * The old rule was `minmax(250px, 1fr)` on every viewport, which set a 1,306px
 * floor (5x250 + 4x14) against a page whose `max-w-[1240px] px-[34px]` gave the
 * content at most 1,172px — so Done was cut off at *every* desktop width,
 * including a 1,440px one where the geometry easily fits. The board is allowed
 * out of the shared page width for exactly this reason (K1): at 1440 the five
 * columns come to 222px each, inside the 220–230px this was specified at.
 */
export const BOARD_GRID = "grid min-h-full grid-cols-[repeat(5,250px)] gap-[12px] pb-[10px] [@media(min-width:1440px)]:grid-cols-[repeat(5,minmax(0,1fr))]";
const COLUMN = "flex min-w-0 flex-col";
/**
 * Every head is the same height, whatever it contains.
 *
 * Done's head was 40px against the other four's 31px, because `Archive All` is
 * a 28px button and the four text-only heads were 19px of content — so Done's
 * label sat 4.5px low and its first card started 9px below every other column's.
 * A head's height is now a property of the board, not of whether a column
 * happens to offer an action.
 */
const COLUMN_HEAD = "sticky top-0 z-[2] flex h-[36px] flex-none items-center gap-[8px] bg-background px-[2px] text-[12.5px] text-secondary-foreground";
/** The 1% tint is the faint drop region the board draws behind every column,
 *  cards or not — it is a declaration, not decoration. No `overflow` of its own:
 *  the board owns both axes, and a second scroller here is the whole defect. */
const COLUMN_BODY = "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-[10px] rounded-xl border border-[color:var(--border-soft)] bg-[color-mix(in_srgb,var(--foreground)_1%,transparent)] p-[10px]";
const COLUMN_BODY_OVER = "border-[color:var(--primary-soft)] bg-[color-mix(in_srgb,var(--primary)_4%,transparent)]";
const COLUMN_EMPTY = "px-0 py-[26px] text-center text-[12px] text-[color:var(--faint)]";

/** One board column, extracted so its three rules — the head, the `Archive All`
 *  presence rule and the empty-state drop invitation — can be asserted from
 *  rendered markup rather than from the page's source text. */
export const BoardColumn = ({ column, tasks, loading, dragOver, onDragOver, onDragLeave, onDrop, onArchiveDone, actions }: {
  column: { status: TaskStatus; labelKey: string };
  tasks: BoardTask[];
  loading: boolean;
  dragOver: TaskStatus | null;
  onDragOver: (status: TaskStatus) => void;
  onDragLeave: (status: TaskStatus) => void;
  onDrop: (taskId: string, status: TaskStatus) => void;
  onArchiveDone: () => void;
  actions: CardActions;
}): ReactNode => {
  const t = useT();
  return <div className={COLUMN}>
    <div className={COLUMN_HEAD}>
      {t(column.labelKey)}<span className={COUNT}>{tasks.length}</span>
      {/* Only on a non-empty Done column: a button that would archive nothing
          is not offered (A2). */}
      {column.status === "DONE" && tasks.length > 0 ? (
        <>
          <span className="flex-1" />
          <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={onArchiveDone}>
            {t("tasks.archiveAll")}
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
      {tasks.map((task) => <TaskCard key={task.id} task={task} actions={actions} draggable />)}
      {/* Every column gets the same invitation, Backlog included (E16). */}
      {tasks.length === 0 ? <div className={COLUMN_EMPTY}>{t(loading ? "common.loading" : "tasks.column.drop")}</div> : null}
    </div>
  </div>;
};

/* --------------------------------------------------- horizontal navigation */

/** Must match `gap-[12px]` in `BOARD_GRID`: a press moves one column *plus* the
 *  gap, so the next column lands against the same edge the last one left. */
const BOARD_GAP_PX = 12;
/** How long after the last scroll event the position is written down. The board
 *  emits these at frame rate under a trackpad, and `localStorage.setItem` is a
 *  synchronous main-thread write — 60 of them a second is a long task. */
const REMEMBER_MS = 200;

const SHELL = "relative flex min-h-0 flex-1 flex-col gap-[8px]";
/** Present only when horizontal travel exists. A permanently reserved row left
 *  36px of unexplained whitespace (28px plus the shell gap) on wide screens
 *  where all five columns already fit. */
const NAV = "flex h-[28px] flex-none items-center justify-end gap-[6px]";
const NAV_HINT = "mr-auto text-[12px] text-[color:var(--faint)]";
/** `flex`, not a bare block. The board inside it is sized by `flex-1`, and in a
 *  block parent that resolves to `height: auto` — measured, that made the board
 *  15,755px tall inside a 696px frame, with no scrollbar of its own and 97 Done
 *  cards clipped away by the page. A wrapper that only exists to position two
 *  fades must not be the thing that decides the board's height. */
export const FRAME = "relative flex min-h-0 flex-1 flex-col";
/** Drawn over the board, never in the way of it: the fade is the only thing on
 *  the page that says a column is cut off rather than absent. */
const FADE = "pointer-events-none absolute inset-y-0 z-[3] w-[28px]";
const FADE_LEFT = "left-0 bg-[linear-gradient(to_right,var(--background),transparent)]";
const FADE_RIGHT = "right-0 bg-[linear-gradient(to_left,var(--background),transparent)]";

const NO_EDGES: Edges = { overflowing: false, atStart: true, atEnd: true };

/**
 * The board's horizontal state, read from the element rather than tracked.
 *
 * Deliberately *not* React state per scroll event: a `setState` on every one of
 * a trackpad's 60-a-second scroll events would re-render 112 cards for a fact
 * that changes twice per board — at the two ends. `sameEdges` keeps the previous
 * object whenever nothing crossed an edge, so React bails out of the update.
 */
const useEdges = (boardRef: React.RefObject<HTMLDivElement | null>): [Edges, () => void] => {
  const [edges, setEdges] = useState<Edges>(NO_EDGES);
  const sync = useCallback((): void => {
    const board = boardRef.current;
    if (!board) return;
    const next = edgeState(board);
    setEdges((previous) => (sameEdges(previous, next) ? previous : next));
  }, [boardRef]);
  return [edges, sync];
};

/** The arrows, as one control. Extracted so their disabled rule can be asserted
 *  from markup: an arrow at its end is disabled, not silently inert. */
export const BoardArrows = ({ edges, onStep }: { edges: Edges; onStep: (direction: -1 | 1) => void }): ReactNode => {
  const t = useT();
  return <>
    <Button
      type="button" variant="legacy" size="legacySmall" className="shadow-none"
      aria-label={t("tasks.board.scrollLeft")} disabled={edges.atStart}
      onClick={() => onStep(-1)}
    >
      ←
    </Button>
    <Button
      type="button" variant="legacy" size="legacySmall" className="shadow-none"
      aria-label={t("tasks.board.scrollRight")} disabled={edges.atEnd}
      onClick={() => onStep(1)}
    >
      →
    </Button>
  </>;
};

/** The entire navigation row is conditional, not just its contents. Wide
 *  boards therefore spend no vertical space explaining movement they do not
 *  have, while overflowed boards retain the hint and keyboard controls. */
export const BoardNavigation = ({ edges, onStep }: { edges: Edges; onStep: (direction: -1 | 1) => void }): ReactNode => {
  const t = useT();
  if (!edges.overflowing) return null;
  return (
    <div className={NAV}>
      <span className={NAV_HINT}>{t("tasks.board.scrollHint")}</span>
      <BoardArrows edges={edges} onStep={onStep} />
    </div>
  );
};

/** How close to the board's edge a drag has to get before the board starts
 *  moving under it, and how many pixels per tick it then moves. */
const DRAG_EDGE_PX = 76;
const DRAG_STEP_PX = 12;
const DRAG_TICK_MS = 16;

/** Which way the board should travel while a drag hovers at `clientX`, in
 *  pixels per tick. Zero anywhere but within `DRAG_EDGE_PX` of an edge. */
export const dragEdgeStep = (clientX: number, box: { left: number; right: number }): number =>
  (clientX - box.left < DRAG_EDGE_PX ? -DRAG_STEP_PX
    : box.right - clientX < DRAG_EDGE_PX ? DRAG_STEP_PX
      : 0);

export const DesktopBoard = ({ byStatus, loading, dragOver, setDragOver, onMove, onArchiveDone, actions, boardRef, projectId }: {
  byStatus: Map<TaskStatus, BoardTask[]>;
  loading: boolean;
  dragOver: TaskStatus | null;
  setDragOver: (status: TaskStatus | null) => void;
  onMove: (taskId: string, status: TaskStatus) => void;
  onArchiveDone: () => void;
  actions: CardActions;
  boardRef: React.RefObject<HTMLDivElement | null>;
  projectId: string;
}): ReactNode => {
  const t = useT();
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
  }, [boardRef, stopEdgeScroll]);
  // `dragleave` bubbles: crossing from a card to its column fires one at the
  // board with `relatedTarget` still inside the board. Stopping on those would
  // reduce the edge scroll to one tick per `dragover`.
  const onBoardDragLeave = useCallback((event: DragEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    stopEdgeScroll();
  }, [stopEdgeScroll]);
  useEffect(() => stopEdgeScroll, [stopEdgeScroll]);

  /* ------------------------------------------------ arrows, fades, memory */

  const [edges, syncEdges] = useEdges(boardRef);

  // One listener for both jobs. `passive` because neither of them can cancel a
  // scroll, and saying so keeps the scroll off the main thread's critical path.
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    let handle = 0;
    const onScroll = (): void => {
      syncEdges();
      window.clearTimeout(handle);
      handle = window.setTimeout(
        () => storage.set(scrollKey(projectId), String(Math.round(board.scrollLeft))),
        REMEMBER_MS,
      );
    };
    board.addEventListener("scroll", onScroll, { passive: true });
    // The board's own width changes with the window, and its content's width
    // changes at 1440px where the columns stop being 250px — both cross the
    // overflow threshold without a scroll event to notice it.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(syncEdges) : null;
    observer?.observe(board);
    if (board.firstElementChild !== null) observer?.observe(board.firstElementChild);
    return () => {
      window.clearTimeout(handle);
      board.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [boardRef, projectId, syncEdges]);

  // Restore before paint, so a remembered position is where the board *starts*
  // rather than somewhere it visibly jumps to. Once per project: a poll landing
  // 24 times a minute must never pull the board back under the operator, which
  // is why this is keyed on the project and not on the task list.
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    board.scrollLeft = storedScroll(storage.get(scrollKey(projectId)), board);
    // Vertically, back to the top. Measured without this: switching projects
    // kept the *other* board's 300px of vertical travel, so a new project opened
    // part-way down a column it had nothing to do with. Only the horizontal
    // position is remembered, because only it is about which columns you were
    // reading.
    board.scrollTop = 0;
    syncEdges();
  }, [boardRef, projectId, syncEdges]);

  const step = useCallback((direction: -1 | 1): void => {
    const board = boardRef.current;
    if (!board) return;
    const target = clampScroll(board.scrollLeft + direction * columnStep(board, COLUMNS.length, BOARD_GAP_PX), board);
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    board.scrollTo({ left: target, behavior: still ? "auto" : "smooth" });
  }, [boardRef]);

  return (
    <div className={SHELL}>
      <BoardNavigation edges={edges} onStep={step} />

      <div className={FRAME}>
        <div
          ref={boardRef}
          className={BOARD}
          // A scrollable region has to be reachable without a pointer; focused,
          // it takes arrow keys natively, which is the vertical half of what the
          // two buttons do horizontally.
          role="region"
          aria-label={t("tasks.board.label")}
          tabIndex={0}
          onDragOver={onBoardDragOver}
          onDragLeave={onBoardDragLeave}
          onDragEnd={stopEdgeScroll}
          onDrop={stopEdgeScroll}
        >
          <div className={BOARD_GRID}>
            {COLUMNS.map((column) => (
              <BoardColumn
                key={column.status}
                column={column}
                tasks={byStatus.get(column.status) ?? []}
                loading={loading}
                dragOver={dragOver}
                onDragOver={setDragOver}
                onDragLeave={(status) => setDragOver(dragOver === status ? null : dragOver)}
                onDrop={(taskId, status) => { setDragOver(null); stopEdgeScroll(); onMove(taskId, status); }}
                onArchiveDone={onArchiveDone}
                actions={actions}
              />
            ))}
          </div>
        </div>
        {edges.atStart ? null : <div aria-hidden="true" className={cn(FADE, FADE_LEFT)} />}
        {edges.atEnd ? null : <div aria-hidden="true" className={cn(FADE, FADE_RIGHT)} />}
      </div>
    </div>
  );
};
