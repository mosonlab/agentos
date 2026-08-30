import { formatDateTime, formatT } from "./format";
import { cronProse } from "./schedule";
import type { BoardTask, ChainAggregate, RunStatus, TaskStatus } from "./types";

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

/** One page per status keeps mounted card and reconciliation work independent
 * of how much completed history the project retains. */
export const CARD_PAGE_SIZE = 20;

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

/* ---------------------------------------------------------------- the chain */

export type ChainBinding = { id: string; name: string | null };

/**
 * Which chain a board card belongs to.
 *
 * Read through this rather than off `chainId`, because an autonomous merge-tail
 * repair task has no chain columns at all — it is created chain-detached so the
 * chain stays a static, linear, once-through structure — and the API resolves
 * its chain from the repair marker instead. Both answers are the same fact, and
 * the filter, the card badge and the page's filter control all have to give the
 * same one.
 */
export const chainBinding = (task: Pick<BoardTask, "chainId" | "chainName" | "repairOf">): ChainBinding | null => {
  if (task.chainId !== null) return { id: task.chainId, name: task.chainName };
  const repair = task.repairOf;
  return repair === null ? null : { id: repair.chainId, name: repair.chainName };
};

/** What the chain is called on screen: its name where the API could derive one,
 *  and a short form of its id where it could not. */
export const chainBindingLabel = (binding: ChainBinding): string => binding.name ?? binding.id.slice(0, 8);

/* --------------------------------------------------------------- projection */

export type TaskBoardEntry = { kind: "task"; id: string; status: TaskStatus; task: BoardTask };
export type ChainBoardEntry = {
  kind: "chain";
  id: string;
  status: TaskStatus;
  aggregate: ChainAggregate;
  /** Raw members are retained only for the chain filter and for resolving a
   * representative step when an older projection omitted its ordinal. */
  members: BoardTask[];
  representativeTaskId: string;
};
export type BoardEntry = TaskBoardEntry | ChainBoardEntry;

export const taskBoardEntry = (task: BoardTask): TaskBoardEntry => ({
  kind: "task", id: task.id, status: task.status, task,
});

export const isBoardEntry = (value: BoardEntry | BoardTask): value is BoardEntry =>
  "kind" in value && (value.kind === "task" || value.kind === "chain");

/** Collapse raw board rows into the entries both board shells render. Grouping
 * uses `chainBinding`, so chain-detached merge-tail repairs stay with their
 * chain even though they have no chain columns of their own. */
export const boardEntries = (tasks: readonly BoardTask[]): BoardEntry[] => {
  const order: Array<TaskBoardEntry | { kind: "chain-group"; id: string }> = [];
  const groups = new Map<string, { members: BoardTask[] }>();
  for (const task of tasks) {
    const binding = chainBinding(task);
    if (binding === null) {
      order.push(taskBoardEntry(task));
      continue;
    }
    const group = groups.get(binding.id);
    if (group) group.members.push(task);
    else {
      groups.set(binding.id, { members: [task] });
      order.push({ kind: "chain-group", id: binding.id });
    }
  }
  return order.map((item): BoardEntry => {
    if (item.kind !== "chain-group") return item;
    const group = groups.get(item.id)!;
    const { members } = group;
    const aggregate = members.find((member): member is BoardTask & { chainAggregate: ChainAggregate } => (
      member.chainAggregate !== null
    ))!.chainAggregate;
    const representativeTaskId = aggregate.detailTaskId;
    return {
      kind: "chain",
      id: `chain:${aggregate.chainId}`,
      status: aggregate.status,
      aggregate,
      members,
      representativeTaskId,
    };
  });
};

/** Normalize a board column input. Keeping raw-task compatibility here makes
 * the extracted column easy to use from existing callers and focused tests. */
export const normalizeBoardEntries = (entries: readonly (BoardEntry | BoardTask)[]): BoardEntry[] =>
  entries.map((entry) => isBoardEntry(entry) ? entry : taskBoardEntry(entry));

/** A parked chain the Todo column head can offer to activate: the chain, what
 * it is called, how long it is, and the Task the existing per-task start path
 * acts on. `waiting-on-predecessor` is deliberately excluded — those chains
 * dispatch themselves when their predecessor completes. */
export type ParkedChain = { chainId: string; name: string; stepCount: number; taskId: string };

/** The parked chains among a column's entries, in the order they are rendered.
 * Single-task cards are never parked chains: only an aggregate carries an
 * activation Task. */
export const parkedChains = (entries: readonly BoardEntry[]): ParkedChain[] =>
  entries.flatMap((entry) => {
    if (entry.kind !== "chain") return [];
    const { activation } = entry.aggregate;
    if (activation.state !== "parked-unactivated" || activation.taskId === null) return [];
    return [{
      chainId: entry.aggregate.chainId,
      name: chainBindingLabel({ id: entry.aggregate.chainId, name: entry.aggregate.chainName }),
      stepCount: entry.aggregate.stepCount,
      taskId: activation.taskId,
    }];
  });

export const boardEntriesByStatus = (entries: readonly BoardEntry[]): Map<TaskStatus, BoardEntry[]> => {
  const groups = new Map<TaskStatus, BoardEntry[]>(COLUMNS.map((column) => [column.status, []]));
  for (const entry of entries) groups.get(entry.status)?.push(entry);
  for (const [status, rows] of groups) groups.set(status, orderColumn(status, rows));
  return groups;
};

/* ------------------------------------------------------------- the schedule */

export type ScheduleSubject = Pick<
  BoardTask, "scheduleKind" | "runAt" | "cron" | "timezone" | "status" | "chainId" | "chainIndex" | "chainProgress"
>;
const WAITING_STATUSES = new Set<TaskStatus>(["TODO", "BACKLOG"]);

/**
 * Is this task's `runAt` a parking value rather than a schedule?
 *
 * A chain step past the first one is started by its execution layer becoming
 * eligible — the control plane enqueues that layer — so the clock is not what
 * will start it, whatever `runAt` says. Chains are in fact
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
 * The one-line answer to "what starts this task", for the board card, or null
 * where there is no answer worth a row.
 *
 * Never the raw enum: `AT` lower-cased to a lone "at" is what 42 of the live
 * board's 112 cards showed, which reads as a rendering accident rather than a
 * schedule. And never the parking date either — 2099-01-01 is an implementation
 * detail of how chains are held back, not something an operator should have to
 * decode.
 *
 * `NOW` is null for the same reason `MANUAL` renders no provenance pill: it is
 * the default, true of nearly every card, so a row saying "Once" on all of them
 * is filler taking a line from the title. Every value that distinguishes one
 * card from the next — cron prose, a time, a chain's wait — still renders.
 */
export const scheduleLabel = (task: ScheduleSubject): string | null => {
  if (task.scheduleKind === "NOW") return null;
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

/**
 * The order one column's cards are read in.
 *
 * `GET /tasks` returns the whole board newest-first (`createdAt desc`), which is
 * right for every column that reports what just happened. Backlog is the one
 * column that is a queue rather than a report: it is dispatched from the top, so
 * newest-first prints the queue backwards. The explicit creation-time sort
 * preserves the API's id-ascending tiebreak when timestamps are equal; a plain
 * reverse would silently invert that stable order.
 */
export const orderColumn = <T extends BoardTask | BoardEntry>(status: TaskStatus, tasks: readonly T[]): T[] => {
  const createdAt = (entry: T): string => isBoardEntry(entry)
    ? entry.kind === "task" ? entry.task.createdAt : entry.aggregate.createdAt
    : entry.createdAt;
  return status === "BACKLOG"
    ? [...tasks].sort((left, right) => (
        createdAt(left) < createdAt(right) ? -1
          : createdAt(left) > createdAt(right) ? 1
            : left.id.localeCompare(right.id)
      ))
    : [...tasks];
};

/* -------------------------------------------------------------- the actions */

export const ACTIVE_RUN_STATUSES = [
  "QUEUED", "CLAIMED", "PROVISIONING", "RUNNING", "WAITING_INBOX",
] as const satisfies readonly RunStatus[];

export const isActiveRunStatus = (status: RunStatus): boolean =>
  ACTIVE_RUN_STATUSES.includes(status as (typeof ACTIVE_RUN_STATUSES)[number]);

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
  if (isActiveRunStatus(run.status)) return false;
  return task.status === "REVIEW" || task.failureReason !== null || run.status !== "SUCCEEDED";
};

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
