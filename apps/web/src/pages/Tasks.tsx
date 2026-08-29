import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { type BoardEntry, type Counts, boardEntries, boardEntriesByStatus, chainBinding, chainBindingLabel, countByStatus, defaultTab, focusAfterMove, operatorMoveTargets, orderColumn, parseStatus, statusLabel, tabKey, taskBoardEntry } from "../lib/board";
import { formatT } from "../lib/format";
import { useAction, useMediaQuery, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import { replace, useQuery } from "../lib/router";
import { storage } from "../lib/storage";
import type { BoardTask, TaskStartability, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { DesktopBoard } from "../components/desktop-board";
import { MobileTaskList } from "../components/mobile-task-list";
import { TasksPageHead } from "../components/tasks-tabs";
import { type ChainAggregateActions } from "../components/chain-aggregate-card";
import { type CardActions } from "../components/task-card";
import { EmptyState, ErrorNotice, InfoNotice, KeyValue, Modal, Page, STACK } from "../components/ui";
import { Button } from "../components/ui/button";

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

/** Every card the chain owns, which includes the merge-tail repair tasks the
 *  chain produced — those carry no chain columns of their own, so filtering on
 *  `chainId` alone dropped them out of the group they belong to. */
export const tasksForChain = (tasks: readonly BoardTask[], chainId: string | null): BoardTask[] =>
  (chainId === null ? [...tasks] : tasks.filter((task) => chainBinding(task)?.id === chainId));

export const ChainFilterControl = ({ name, onClear }: { name: string; onClear: () => void }): ReactNode => {
  const t = useT();
  return <div className="flex items-center gap-[8px] text-[12px] text-muted-foreground">
    <span>{t("tasks.filter.chain", { name })}</span>
    <Button type="button" variant="legacy" size="legacySmall" onClick={onClear}>
      {t("tasks.filter.clear")}
    </Button>
  </div>;
};

export type HeldRows = Map<string, { key: string; row: BoardTask }>;

export const moveAction = (origin: "drop" | "menu", status: TaskStatus, startable: boolean): "confirm-start" | "patch" => (
  (origin === "drop" || origin === "menu") && status === "DOING" && startable ? "confirm-start" : "patch"
);

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

export const StartTaskDialog = ({ request, pending, error, onCancel, onConfirm }: {
  request: TaskStartability;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode => {
  const t = useT();
  if (!request.task.agent || !request.task.repo || !request.task.targetBranch) {
    throw new Error("Startable task response is missing agent, repository, or target branch");
  }
  return (
    <Modal title={t("tasks.startDialog.title")} onClose={onCancel} footer={(
      <>
        <Button type="button" variant="legacy" size="legacy" disabled={pending} onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending} onClick={onConfirm}>{t("tasks.startDialog.confirm")}</Button>
      </>
    )}>
      <div className="text-[13px] font-bold text-foreground">{request.task.name}</div>
      <KeyValue items={[
        { k: t("tasks.startDialog.agent"), v: request.task.agent.title },
        { k: t("tasks.startDialog.repo"), v: request.task.repo.name },
        { k: t("tasks.startDialog.targetBranch"), v: request.task.targetBranch },
      ]} />
      {error === null ? null : <ErrorNotice message={error} />}
    </Modal>
  );
};

export const useTaskStartConfirmation = (reload: () => void): {
  request: TaskStartability | null;
  pending: boolean;
  error: string | null;
  requestForMove: (origin: "drop" | "menu", taskId: string, requireStart?: boolean) => Promise<boolean>;
  requestForDrop: (taskId: string) => Promise<boolean>;
  requestForStart: (taskId: string) => Promise<boolean>;
  confirm: () => Promise<void>;
  cancel: () => void;
} => {
  const [request, setRequest] = useState<TaskStartability | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestForMove = useCallback(async (origin: "drop" | "menu", taskId: string, requireStart = false): Promise<boolean> => {
    const verdict = await api.get<TaskStartability>(`/tasks/${taskId}/startability`);
    if (moveAction(origin, "DOING", verdict.startable) === "patch") {
      if (requireStart) throw new Error("Task is not currently startable");
      return false;
    }
    setError(null);
    setRequest(verdict);
    return true;
  }, []);

  const requestForStart = useCallback((taskId: string): Promise<boolean> => requestForMove("menu", taskId, true), [requestForMove]);

  const requestForDrop = useCallback((taskId: string): Promise<boolean> => requestForMove("drop", taskId), [requestForMove]);

  const confirm = useCallback(async (): Promise<void> => {
    if (!request) return;
    setPending(true);
    setError(null);
    try {
      await api.post(`/tasks/${request.task.id}/start`, {});
      setRequest(null);
      reload();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }, [request, reload]);

  const cancel = useCallback((): void => {
    if (pending) return;
    setRequest(null);
    setError(null);
  }, [pending]);

  return { request, pending, error, requestForMove, requestForDrop, requestForStart, confirm, cancel };
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
  const [chainFilter, setChainFilter] = useState<{ id: string; name: string } | null>(null);
  const { error: actionError, run } = useAction();
  const t = useT();
  const allTasks = useStableRows(useMemo(() => data ?? [], [data]));
  const tasks = useMemo(() => tasksForChain(allTasks, chainFilter?.id ?? null), [allTasks, chainFilter]);

  // One DOM or the other, never both: rendering five columns *and* a phone list
  // would put 112 cards on the page twice and hand the poll twice the work to
  // reconcile. The breakpoint is the same 900px the stylesheet uses.
  const narrow = useMediaQuery("(max-width: 900px)");

  const entries = useMemo<BoardEntry[]>(
    () => chainFilter === null ? boardEntries(allTasks) : tasks.map(taskBoardEntry),
    [allTasks, chainFilter, tasks],
  );
  const byStatus = useMemo(() => boardEntriesByStatus(entries), [entries]);
  const counts: Counts = useMemo(() => countByStatus(entries), [entries]);

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
    setChainFilter(null);
    settled.current = false;
    replace("/tasks");
  }, [projectId]);

  /* ---------------------------------------------------------- the actions */

  // Held in a ref so `move` does not have to re-declare itself, and the memoized
  // card callbacks below stay stable, every time a task list arrives.
  const latest = useRef(tasks);
  latest.current = tasks;
  const latestAll = useRef(allTasks);
  latestAll.current = allTasks;

  /** Which card should take the focus once the moved one lands, and the list it
   *  was in when it left — read after the next payload, not now. */
  const pendingFocus = useRef<{ id: string; before: string[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const start = useTaskStartConfirmation(reload);

  const recordMove = useCallback((task: BoardTask, status: TaskStatus): void => {
    pendingFocus.current = {
      id: task.id,
      before: orderColumn(
        task.status,
        latest.current.filter((candidate) => candidate.status === task.status),
      ).map((candidate) => candidate.id),
    };
    setAnnouncement(t("tasks.announcement.moved", { name: task.name, status: statusLabel(status) }));
  }, [t]);

  const move = useCallback((taskId: string, status: TaskStatus, origin: "drop" | "menu" = "menu"): void => {
    const task = latest.current.find((candidate) => candidate.id === taskId);
    if (!task || task.status === status) return;
    void run(async () => {
      if (status === "DOING" && await start.requestForMove(origin, taskId, task.assigneeType === "AGENT")) return;
      recordMove(task, status);
      await api.patch(`/tasks/${taskId}`, { status });
      reload();
    });
  }, [run, reload, recordMove, start]);

  const drop = useCallback((taskId: string, status: TaskStatus): void => {
    const task = latest.current.find((candidate) => candidate.id === taskId);
    if (!task || task.status === status || !operatorMoveTargets(task).includes(status)) return;
    move(taskId, status, "drop");
  }, [move]);

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
    onMove: (task, status, origin = "menu") => move(task.id, status, origin),
    onRetry: retry,
    onArchive: archive,
    onDelete: remove,
    onCopyError: copyError,
    onFilterChain: (task) => {
      const chain = chainBinding(task);
      if (chain !== null) setChainFilter({ id: chain.id, name: chainBindingLabel(chain) });
    },
  }), [move, retry, archive, remove, copyError]);

  /** Aggregate cards use the same startability/confirmation surface as a
   * task dropped onto Doing. Keeping this callback at the page boundary means
   * stale-view 4xx responses remain visible in StartTaskDialog. */
  const aggregateActions: ChainAggregateActions = useMemo(() => ({
    onActivate: (taskId) => {
      void run(async () => { await start.requestForStart(taskId); });
    },
    onFilter: (aggregate) => setChainFilter({ id: aggregate.chainId, name: aggregate.chainName ?? aggregate.chainId.slice(0, 8) }),
    // The aggregate owns the visible members returned by this board read.
    // Archived siblings are already absent; settling the rest through the
    // existing idempotent task route removes the aggregate without inventing a
    // second chain-execution mutation.
    onArchive: (_aggregate, taskIds) => {
      void run(async () => {
        for (const taskId of taskIds) await api.post(`/tasks/${taskId}/archive`, {});
        reload();
      });
    },
  }), [run, reload, start]);

  /** `api.post` is called for its payload, which `useAction.run` discards — but
   *  the call still runs *inside* `run`, so failures land in the same
   *  `ErrorNotice` as everything else on the page. One error surface, one
   *  information surface. */
  const archiveDone = useCallback(async (): Promise<void> => {
    const done = latestAll.current.filter((task) => task.status === "DONE");
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
      {start.request === null ? null : (
        <StartTaskDialog
          request={start.request}
          pending={start.pending}
          error={start.error}
          onCancel={start.cancel}
          onConfirm={() => void start.confirm()}
        />
      )}
      <TasksPageHead active="tasks" onCreated={reload} />

      <div className={cn(STACK, BOARD_STACK, "mt-4")}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {notice === null ? null : <InfoNotice message={notice} onDismiss={() => setNotice(null)} />}
        {chainFilter === null ? null : <ChainFilterControl name={chainFilter.name} onClear={() => setChainFilter(null)} />}

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
            aggregateActions={aggregateActions}
            listRef={listRef}
          />
        ) : (
          <DesktopBoard
            byStatus={byStatus}
            loading={loading}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onMove={drop}
            onArchiveDone={() => void archiveDone()}
            actions={actions}
            aggregateActions={aggregateActions}
            boardRef={boardRef}
            projectId={projectId}
          />
        )}
      </div>
    </Page>
  );
};
