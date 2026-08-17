import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { COLUMNS, type Counts, countByStatus, defaultTab, focusAfterMove, parseStatus, statusLabel, tabKey } from "../lib/board";
import { formatT } from "../lib/format";
import { useAction, useMediaQuery, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import { replace, useQuery } from "../lib/router";
import { storage } from "../lib/storage";
import type { BoardTask, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { DesktopBoard } from "../components/desktop-board";
import { MobileTaskList } from "../components/mobile-task-list";
import { TasksPageHead } from "../components/tasks-tabs";
import { type CardActions } from "../components/task-card";
import { EmptyState, ErrorNotice, InfoNotice, Page, STACK } from "../components/ui";

export { COLUMNS } from "../lib/board";

/**
 * The page owns the viewport on a desktop and gives it back on a phone.
 *
 * Above 900px the board is a fixed-height surface that scrolls inside itself, so
 * its horizontal scrollbar cannot end up 19,600px below the fold. At or below
 * 900px the page is `h-auto` and the *document* scrolls, because that is the one
 * scroll a phone always has — and because the previous arrangement kept the
 * desktop clipping (`max-h-[72dvh]`, `overflow-y-hidden`) while removing the
 * scroller that made it survivable, which left ~22,000px of cards unreachable.
 *
 * `max-w-none` is this page's one deviation from the shared 1,240px page width
 * (K1). Five 250px columns plus their gaps need 1,306px, so under the shared cap
 * the fifth column could never be on screen at once, at any viewport size.
 */
export const BOARD_PAGE = "flex h-[100dvh] max-w-none flex-col overflow-hidden pb-[16px] [@media(max-width:900px)]:h-auto [@media(max-width:900px)]:overflow-visible [@media(max-width:900px)]:pb-[60px]";
const BOARD_STACK = "flex min-h-0 flex-1 flex-col gap-[16px]";

/** The two shapes of the Archive All result, as one string. Exported so the
 *  message is testable without driving a click through a static render. */
/* Pure, exported and asserted directly by `tasks-board.test.tsx`, so it reads the
 * locale through `formatT` — the WI-4 registration seam — rather than gaining a
 * `Translate` parameter its two call sites would have to thread. */
export const archiveDoneNotice = (result: { archived: number; skipped: number }): string =>
  (result.skipped > 0
    ? formatT("tasks.archiveDone.some", result)
    : formatT("tasks.archiveDone.all", result));

export type HeldRows = Map<string, { key: string; row: BoardTask }>;

/** Keeps the previous object for every row whose serialization is unchanged.
 *
 *  `usePoll` already drops an identical *payload*; this handles the case where
 *  one row moved and 111 did not. Without it a single `updatedAt` tick hands
 *  112 fresh objects to 112 memoized cards and defeats all of them. Runs once
 *  per genuinely-changed payload, not once per poll. */
export const stableRows = (rows: readonly BoardTask[], held: HeldRows): { rows: BoardTask[]; held: HeldRows } => {
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

const useStableRows = (rows: readonly BoardTask[]): BoardTask[] => {
  const held = useRef<HeldRows>(new Map());
  return useMemo(() => {
    const result = stableRows(rows, held.current);
    held.current = result.held;
    return result.rows;
  }, [rows]);
};

export const TasksPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  // `view=board` is the projection this page reads (packages/api/src/board.ts):
  // the full row carries every Task column plus `repo`, the whole latest Run and
  // its whole Session — 1.58 MB for 112 tasks, of which the card renders ~5%.
  const tasksPath = projectId === "" ? null : `/tasks?projectId=${encodeURIComponent(projectId)}&view=board`;
  const { data, loading, error, reload } = usePoll<BoardTask[]>(tasksPath);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const { error: actionError, run } = useAction();
  const t = useT();
  const tasks = useStableRows(useMemo(() => data ?? [], [data]));

  // One DOM or the other, never both: rendering five columns *and* a phone list
  // would put 112 cards on the page twice and hand the poll twice the work to
  // reconcile. The breakpoint is the same 900px the stylesheet uses.
  const narrow = useMediaQuery("(max-width: 900px)");

  const byStatus = useMemo(() => {
    const groups = new Map<TaskStatus, BoardTask[]>(COLUMNS.map((column) => [column.status, []]));
    for (const task of tasks) groups.get(task.status)?.push(task);
    return groups;
  }, [tasks]);
  const counts: Counts = useMemo(() => countByStatus(tasks), [tasks]);

  /* ------------------------------------------------------- the phone's tab */

  const query = useQuery();
  const urlTab = parseStatus(query.get("status"));
  const [chosen, setChosen] = useState<TaskStatus | null>(null);
  const remembered = useMemo(() => parseStatus(storage.get(tabKey(projectId))), [projectId]);
  const resolved = urlTab ?? chosen ?? remembered;
  const tab = resolved ?? "TODO";

  const selectTab = useCallback((status: TaskStatus): void => {
    setChosen(status);
    storage.set(tabKey(projectId), status);
    // `replace`, not `navigate`: the URL should *describe* which list is on
    // screen, not cost a press of Back per tab to leave the board.
    replace(`/tasks?status=${status.toLowerCase()}`);
  }, [projectId]);

  // Todo first, and the first non-empty unfinished status when Todo is empty.
  // Resolved once, after the first payload — before it the counts are all zero
  // and every answer would be a guess that then visibly corrects itself.
  const settled = useRef(false);
  useEffect(() => {
    if (!narrow || settled.current || loading) return;
    settled.current = true;
    // Also when the tab came from memory rather than from the URL: the address
    // bar is supposed to say which list is on screen, and a remembered Done tab
    // under a bare `#/tasks` is a URL that describes a different page than the
    // one being looked at.
    if (urlTab === null) selectTab(resolved ?? defaultTab(counts));
  }, [narrow, urlTab, resolved, loading, counts, selectTab]);

  // A different project is different work: it inherits neither the tab nor the
  // deep link that named one. Skipped on the first render, so arriving on
  // `#/tasks?status=done` still lands on Done.
  const seenProject = useRef(projectId);
  useEffect(() => {
    if (seenProject.current === projectId) return;
    seenProject.current = projectId;
    setChosen(null);
    settled.current = false;
    replace("/tasks");
  }, [projectId]);

  /* ---------------------------------------------------------- the actions */

  // Held in a ref so `move` does not have to re-declare itself, and the memoized
  // card callbacks below stay stable, every time a task list arrives.
  const latest = useRef(tasks);
  latest.current = tasks;

  /** Which card should take the focus once the moved one lands, and the list it
   *  was in when it left — read after the next payload, not now. */
  const pendingFocus = useRef<{ id: string; before: string[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const move = useCallback((taskId: string, status: TaskStatus): void => {
    const task = latest.current.find((candidate) => candidate.id === taskId);
    if (!task || task.status === status) return;
    pendingFocus.current = {
      id: taskId,
      before: latest.current.filter((candidate) => candidate.status === task.status).map((candidate) => candidate.id),
    };
    // Announced rather than left to be noticed: on a phone the card leaves the
    // list entirely, and on the desktop board it lands in a column that may be
    // off screen.
    setAnnouncement(t("tasks.announcement.moved", { name: task.name, status: statusLabel(status) }));
    void run(async () => { await api.patch(`/tasks/${taskId}`, { status }); reload(); });
  }, [run, reload, t]);

  // Focus follows the card. It runs when a payload lands, which is when the move
  // has actually taken effect — `move` itself only sends the request.
  useEffect(() => {
    const request = pendingFocus.current;
    if (request === null) return;
    pendingFocus.current = null;
    const visible = [...document.querySelectorAll<HTMLElement>("[data-card]")]
      .map((node) => node.dataset.card ?? "");
    const target = focusAfterMove(visible, request.id, request.before);
    const node = target === null
      ? null
      : document.querySelector<HTMLElement>(`[data-card="${target}"] [data-card-title]`);
    if (node) node.focus(); else listRef.current?.focus();
  }, [tasks, tab]);

  const remove = useCallback((task: BoardTask): void => {
    if (!window.confirm(t("tasks.confirm.delete", { name: task.name }))) return;
    void run(async () => { await api.delete(`/tasks/${task.id}`); reload(); });
  }, [run, reload, t]);
  const retry = useCallback((task: BoardTask): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/retry`, {}); reload(); });
  }, [run, reload]);
  const archive = useCallback((task: BoardTask): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/archive`, {}); reload(); });
  }, [run, reload]);
  /** The whole `failureReason`, which is the half of it the card does not show.
   *  Reported either way: a copy that silently did nothing is worse than one
   *  that says the browser refused. */
  const copyError = useCallback((task: BoardTask): void => {
    const text = task.failureReason ?? "";
    void navigator.clipboard?.writeText(text).then(
      () => setNotice(t("tasks.notice.copiedError", { name: task.name })),
      () => setNotice(t("tasks.notice.copyFailed")),
    );
  }, [t]);

  const actions: CardActions = useMemo(() => ({
    onMove: (task, status) => move(task.id, status),
    onRetry: retry,
    onArchive: archive,
    onDelete: remove,
    onCopyError: copyError,
  }), [move, retry, archive, remove, copyError]);

  /** `api.post` is called for its payload, which `useAction.run` discards — but
   *  the call still runs *inside* `run`, so failures land in the same
   *  `ErrorNotice` as everything else on the page. One error surface, one
   *  information surface. */
  const archiveDone = useCallback(async (): Promise<void> => {
    const done = latest.current.filter((task) => task.status === "DONE");
    if (!window.confirm(t("tasks.confirm.archiveDone", { n: done.length }))) return;
    setNotice(null);
    let result: { archived: number; skipped: number } | null = null;
    const ok = await run(async () => {
      result = await api.post<{ archived: number; skipped: number }>(`/projects/${projectId}/tasks/archive-done`, {});
      reload();
    });
    if (ok && result !== null) setNotice(archiveDoneNotice(result));
  }, [projectId, run, reload, t]);

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className={cn("text-foreground", BOARD_PAGE)}>
      <TasksPageHead active="tasks" onCreated={reload} />

      <div className={cn(STACK, BOARD_STACK, "mt-4")}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {notice === null ? null : <InfoNotice message={notice} onDismiss={() => setNotice(null)} />}

        {/* Status changes are announced here whether they came from the menu or
            from a drag, because neither one is visible to a screen reader. */}
        <div aria-live="polite" className="sr-only">{announcement}</div>

        {narrow ? (
          <MobileTaskList
            tab={tab}
            counts={counts}
            tasks={byStatus.get(tab) ?? []}
            loading={loading}
            onSelectTab={selectTab}
            onArchiveDone={() => void archiveDone()}
            actions={actions}
            listRef={listRef}
          />
        ) : (
          <DesktopBoard
            byStatus={byStatus}
            loading={loading}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onMove={move}
            onArchiveDone={() => void archiveDone()}
            actions={actions}
            boardRef={boardRef}
            projectId={projectId}
          />
        )}
      </div>
    </Page>
  );
};
