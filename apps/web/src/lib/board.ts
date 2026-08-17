import { formatDateTime, formatT } from "./format";
import { cronProse } from "./schedule";
import type { BoardTask, RunStatus, TaskStatus } from "./types";

/** The board's five columns, in the order they are read. Backlog is first: it is
 *  where work waits before it is queued, and the scheduler never picks anything
 *  out of it. */
export const COLUMNS: Array<{ status: TaskStatus; labelKey: string }> = [
  { status: "BACKLOG", labelKey: "tasks.column.BACKLOG" },
  { status: "TODO", labelKey: "tasks.column.TODO" },
  { status: "DOING", labelKey: "tasks.column.DOING" },
  { status: "REVIEW", labelKey: "tasks.column.REVIEW" },
  { status: "DONE", labelKey: "tasks.column.DONE" },
];

export const STATUSES: TaskStatus[] = COLUMNS.map((column) => column.status);

export const statusLabel = (status: TaskStatus): string =>
  formatT(COLUMNS.find((column) => column.status === status)?.labelKey ?? `status.task.${status}`);

/** A `?status=` value the board is willing to act on, or null. */
export const parseStatus = (raw: string | null | undefined): TaskStatus | null => {
  const upper = (raw ?? "").toUpperCase();
  return STATUSES.find((status) => status === upper) ?? null;
};

export type Counts = Record<TaskStatus, number>;
const DEFAULT_STATUS: TaskStatus = "TODO";

export const countByStatus = (tasks: readonly { status: TaskStatus }[]): Counts => {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Counts;
  for (const task of tasks) counts[task.status] += 1;
  return counts;
};

/**
 * Which tab a project's board opens on when nothing has been chosen yet.
 *
 * Todo first, because that is the queue an operator opens the board to look at.
 * Done is never reached by this function even when it holds 97 of 112 cards:
 * "most rows" is not "most interesting", and a board that opens on finished work
 * has answered a question nobody asked.
 */
export const defaultTab = (counts: Counts): TaskStatus => {
  if (counts.TODO > 0) return DEFAULT_STATUS;
  return STATUSES.filter((status) => status !== "DONE").find((status) => counts[status] > 0) ?? DEFAULT_STATUS;
};

/* ------------------------------------------------------------- the schedule */

export type ScheduleSubject = Pick<
  BoardTask, "scheduleKind" | "runAt" | "cron" | "timezone" | "status" | "chainId" | "chainIndex" | "chainProgress"
>;
const WAITING_STATUSES = new Set<TaskStatus>(["TODO", "BACKLOG"]);

/**
 * Is this task's `runAt` a parking value rather than a schedule?
 *
 * A chain step past the first one is started by its predecessor finishing — the
 * control plane advances `followUpTaskId` and enqueues the successor — so the
 * clock is not what will start it, whatever `runAt` says. Chains are in fact
 * created with `runAt` pushed far out (the live board's are all 2099-01-01)
 * precisely so the scheduler's `runAt <= now` sweep never picks them up.
 *
 * Derived from the chain columns, not from the sentinel date: a magic constant
 * would be a second, undocumented contract between whoever writes the chain and
 * this renderer, and would start lying the day someone parks a step at 2098.
 * The *first* step of a chain is excluded because the scheduler genuinely can
 * fire it, so its `runAt` is a real answer to "when does this run".
 */
export const chainParked = (task: ScheduleSubject): boolean =>
  task.scheduleKind === "AT"
  && task.chainId !== null
  && task.chainIndex !== null
  && task.chainProgress?.position !== 1;

/**
 * The one-line answer to "what starts this task", for the board card.
 *
 * Never the raw enum: `AT` lower-cased to a lone "at" is what 42 of the live
 * board's 112 cards showed, which reads as a rendering accident rather than a
 * schedule. And never the parking date either — 2099-01-01 is an implementation
 * detail of how chains are held back, not something an operator should have to
 * decode.
 */
export const scheduleLabel = (task: ScheduleSubject): string => {
  if (task.scheduleKind === "NOW") return formatT("tasks.schedule.NOW");
  if (task.scheduleKind === "CRON") return cronProse(task.cron, task.timezone);
  if (chainParked(task)) {
    // The same fact from two sides: a step that has not started is waiting, and
    // one that has is no longer waiting for anything.
    return WAITING_STATUSES.has(task.status)
      ? formatT("tasks.schedule.waitingForPrevious")
      : formatT("tasks.schedule.startedByChain");
  }
  return task.runAt === null
    ? formatT("tasks.schedule.notScheduled")
    : formatT("tasks.schedule.atTime", { time: formatDateTime(task.runAt) });
};

/* -------------------------------------------------------------- the actions */

const ACTIVE_RUN: RunStatus[] = ["QUEUED", "CLAIMED", "PROVISIONING", "RUNNING"];

/**
 * A retry only lands once the last run is terminal; the API rejects the rest.
 *
 * Takes the run separately because the two callers hold it differently — the
 * board card gets one projected `latestRun`, the detail page has the whole `runs`
 * array — and a rule the board and the detail page could state differently is a
 * rule the operator gets two answers from.
 */
export const retryable = (
  task: { status: TaskStatus; failureReason: string | null },
  run: { status: RunStatus } | null | undefined,
): boolean => {
  if (!run) return false;
  if (ACTIVE_RUN.includes(run.status)) return false;
  return task.status === "REVIEW" || task.failureReason !== null || run.status !== "SUCCEEDED";
};

/** Where a card may be moved to: everywhere it is not. */
export const moveTargets = (status: TaskStatus): TaskStatus[] =>
  STATUSES.filter((candidate) => candidate !== status);

/* -------------------------------------------------------------- persistence */

/** Per project, so switching projects never inherits another board's tab or
 *  horizontal position — the two boards are different work. */
export const tabKey = (projectId: string): string => `agentos.board.tab.${projectId}`;
export const scrollKey = (projectId: string): string => `agentos.board.scrollLeft.${projectId}`;

/**
 * Which card should hold focus after `moved` leaves the list it was in.
 *
 * Returns the card itself when it is still on screen (the desktop board, where a
 * move only changes column), the next card down when it is not, the one above
 * when it was last, and null when the list is now empty and the container has to
 * take the focus instead.
 */
export const focusAfterMove = (visible: readonly string[], moved: string, before: readonly string[]): string | null => {
  if (visible.includes(moved)) return moved;
  const index = before.indexOf(moved);
  if (index === -1) return visible[0] ?? null;
  const after = before.slice(index + 1).find((id) => visible.includes(id));
  if (after !== undefined) return after;
  const above = [...before.slice(0, index)].reverse().find((id) => visible.includes(id));
  return above ?? visible[0] ?? null;
};

/* ------------------------------------------------------ horizontal movement */

/** How far one `<`/`>` press moves the board: one column plus the gap, so a
 *  press always lands the next column against the same edge. */
export const columnStep = (board: { scrollWidth: number; clientWidth: number }, columns: number, gap: number): number =>
  (columns <= 0 ? board.clientWidth : (board.scrollWidth - gap * (columns - 1)) / columns + gap);

/** Clamp a target scroll position into the board's own range, so the buttons
 *  cannot leave it a fraction of a pixel short of an edge and stay enabled. */
export const clampScroll = (target: number, board: { scrollWidth: number; clientWidth: number }): number =>
  Math.max(0, Math.min(Math.round(target), Math.max(0, board.scrollWidth - board.clientWidth)));

/** A pixel of slack at each end. Chrome reports `scrollWidth`/`scrollLeft`
 *  fractionally at fractional zoom levels, and a board sitting 0.4px short of
 *  its end with an enabled `>` button that moves nothing is a broken control. */
const EDGE_SLACK = 1;

export type ScrollBox = { scrollLeft: number; scrollWidth: number; clientWidth: number };
export type Edges = { overflowing: boolean; atStart: boolean; atEnd: boolean };

/** What the two arrows and the two edge fades are both driven by. A board that
 *  does not overflow is at both ends at once, which is exactly the state that
 *  disables both arrows and draws neither fade. */
export const edgeState = (box: ScrollBox): Edges => {
  const furthest = Math.max(0, box.scrollWidth - box.clientWidth);
  return {
    overflowing: furthest > EDGE_SLACK,
    atStart: box.scrollLeft <= EDGE_SLACK,
    atEnd: box.scrollLeft >= furthest - EDGE_SLACK,
  };
};

export const sameEdges = (a: Edges, b: Edges): boolean =>
  a.overflowing === b.overflowing && a.atStart === b.atStart && a.atEnd === b.atEnd;

/** The remembered horizontal position, made safe to assign.
 *
 *  `storage` hands back whatever is in `localStorage`, which is whatever was
 *  there before this build — and a stale position from a wider viewport, or from
 *  a project with more columns of content, would otherwise leave the board
 *  scrolled past its own end on arrival. */
export const storedScroll = (raw: string | null | undefined, board: ScrollBox): number => {
  const value = Number(raw);
  return raw === null || raw === undefined || raw === "" || !Number.isFinite(value)
    ? 0
    : clampScroll(value, board);
};
