import { type DragEvent, type ReactNode, useCallback, useEffect, useRef } from "react";

import { COLUMNS } from "../lib/board";
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
const COLUMN_HEAD = "sticky top-0 z-[2] flex h-[36px] flex-none items-center gap-[8px] bg-popover px-[2px] text-[12.5px] text-secondary-foreground";
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
  column: { status: TaskStatus; label: string };
  tasks: BoardTask[];
  loading: boolean;
  dragOver: TaskStatus | null;
  onDragOver: (status: TaskStatus) => void;
  onDragLeave: (status: TaskStatus) => void;
  onDrop: (taskId: string, status: TaskStatus) => void;
  onArchiveDone: () => void;
  actions: CardActions;
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
      {tasks.map((task) => <TaskCard key={task.id} task={task} actions={actions} draggable />)}
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

/** Which way the board should travel while a drag hovers at `clientX`, in
 *  pixels per tick. Zero anywhere but within `DRAG_EDGE_PX` of an edge. */
export const dragEdgeStep = (clientX: number, box: { left: number; right: number }): number =>
  (clientX - box.left < DRAG_EDGE_PX ? -DRAG_STEP_PX
    : box.right - clientX < DRAG_EDGE_PX ? DRAG_STEP_PX
      : 0);

export const DesktopBoard = ({ byStatus, loading, dragOver, setDragOver, onMove, onArchiveDone, actions, boardRef }: {
  byStatus: Map<TaskStatus, BoardTask[]>;
  loading: boolean;
  dragOver: TaskStatus | null;
  setDragOver: (status: TaskStatus | null) => void;
  onMove: (taskId: string, status: TaskStatus) => void;
  onArchiveDone: () => void;
  actions: CardActions;
  boardRef: React.RefObject<HTMLDivElement | null>;
}): ReactNode => {
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

  return (
    <div
      ref={boardRef}
      className={BOARD}
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
  );
};
