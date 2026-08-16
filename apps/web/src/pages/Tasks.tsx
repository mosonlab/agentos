import { type ReactNode, useMemo, useState } from "react";

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

const BOARD = "grid grid-flow-col auto-cols-[minmax(250px,1fr)] gap-[14px] overflow-x-auto pb-[10px]";
const COLUMN = "flex min-h-[420px] flex-col";
const COLUMN_HEAD = "flex items-center gap-[8px] px-[2px] pt-0 pb-[12px] text-[12.5px] text-secondary-foreground";
/** The 1% tint is the faint drop region the board draws behind every column,
 *  cards or not — it is a declaration, not decoration. */
const COLUMN_BODY = "grid flex-1 grid-cols-[minmax(0,1fr)] content-start gap-[10px] rounded-xl border border-[color:var(--border-soft)] bg-[color-mix(in_srgb,var(--foreground)_1%,transparent)] p-[10px]";
const COLUMN_BODY_OVER = "border-[color:var(--primary-soft)] bg-[color-mix(in_srgb,var(--primary)_4%,transparent)]";
const COLUMN_EMPTY = "px-0 py-[26px] text-center text-[12px] text-[color:var(--faint)]";
const TASK_CARD = "cursor-pointer rounded-xl border border-border bg-card px-[14px] py-[13px] hover:border-[color:var(--border-hover)]";
const TASK_META = "mt-[9px] grid gap-[6px] text-[11.5px] text-muted-foreground";
const TASK_META_ROW = "flex flex-wrap items-center gap-[8px]";
/** `size-[13px]`, not the button base's `[&_svg]:size-4`. */
const TASK_FOOT = "mt-[10px] flex items-center gap-[10px] text-[11.5px] text-muted-foreground [&_svg]:size-[13px] [&_svg]:flex-none [&_svg]:opacity-85";

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
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

export const TaskCard = ({ task, onDelete, onRetry, onArchive }: {
  task: Task;
  onDelete: (task: Task) => void;
  onRetry: (task: Task) => void;
  onArchive: (task: Task) => void;
}): ReactNode => {
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

export const TasksPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const tasksPath = projectId === "" ? null : `/tasks?projectId=${encodeURIComponent(projectId)}`;
  const { data, loading, error, reload } = usePoll<Task[]>(tasksPath);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { error: actionError, run } = useAction();
  const tasks = useMemo(() => data ?? [], [data]);

  const move = (taskId: string, status: TaskStatus): void => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status === status) return;
    void run(async () => { await api.patch(`/tasks/${taskId}`, { status }); reload(); });
  };
  const remove = (task: Task): void => {
    if (!window.confirm(`Delete task ${task.name}?`)) return;
    void run(async () => { await api.delete(`/tasks/${task.id}`); reload(); });
  };
  const retry = (task: Task): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/retry`, {}); reload(); });
  };
  const archive = (task: Task): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/archive`, {}); reload(); });
  };
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
    <Page className="text-foreground">
      <TasksPageHead active="tasks" onCreated={reload} />

      <div className={cn(STACK, "mt-4")}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {notice === null ? null : <InfoNotice message={notice} onDismiss={() => setNotice(null)} />}

        <div className={BOARD}>
          {COLUMNS.map((column) => {
            const columnTasks = tasks.filter((task) => task.status === column.status);
            return (
              <div className={COLUMN} key={column.status}>
                <div className={COLUMN_HEAD}>
                  {column.label}<span className={COUNT}>{columnTasks.length}</span>
                  {/* Only on a non-empty Done column: a button that would
                      archive nothing is not offered (A2). */}
                  {column.status === "DONE" && columnTasks.length > 0 ? (
                    <>
                      <span className="flex-1" />
                      <Button type="button" variant="legacy" size="legacySmall" className="shadow-none" onClick={() => void archiveDone()}>
                        Archive All
                      </Button>
                    </>
                  ) : null}
                </div>
                <div
                  className={cn(COLUMN_BODY, dragOver === column.status && COLUMN_BODY_OVER)}
                  onDragOver={(event) => { event.preventDefault(); setDragOver(column.status); }}
                  onDragLeave={() => setDragOver((current) => (current === column.status ? null : current))}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOver(null);
                    move(event.dataTransfer.getData("text/plain"), column.status);
                  }}
                >
                  {columnTasks.map((task) => <TaskCard key={task.id} task={task} onDelete={remove} onRetry={retry} onArchive={archive} />)}
                  {columnTasks.length === 0 ? <div className={COLUMN_EMPTY}>{loading ? "Loading…" : "Drop tasks here"}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Page>
  );
};
