import { type ReactNode, useMemo } from "react";

import { api } from "../lib/api";
import { chainMarker } from "../lib/chain";
import { formatDateTime } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { fatal } from "../lib/poll-state";
import { useProjectScope } from "../lib/project";
import { navigate } from "../lib/router";
import type { Task } from "../lib/types";
import { TasksPageHead } from "../components/tasks-tabs";
import {
  HINT, STACK, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  AgentChip, EmptyState, ErrorNotice, Page, RowMenu, TaskPill,
} from "../components/ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/** [A7]: the archive grows without bound, so the page shows a window rather
 *  than pretending to show everything. */
export const ARCHIVED_LIMIT = 200;

export const ArchivedRow = ({ task, onUnarchive }: { task: Task; onUnarchive: (task: Task) => void }): ReactNode => (
  <TableRow
    className="cursor-pointer"
    onClick={(event) => { if (!event.defaultPrevented) navigate(`/tasks/${task.id}`); }}
  >
    <TableCell className={TABLE_NAME}>
      {task.name}
      <span className={TABLE_SUB}>{task.templateStep?.name ?? task.id}</span>
    </TableCell>
    <TableCell><TaskPill status={task.status} /></TableCell>
    <TableCell><AgentChip agent={null} name={task.assigneeAgent?.title ?? "Unassigned"} /></TableCell>
    <TableCell>{chainMarker(task.chainProgress) ?? "—"}</TableCell>
    <TableCell>{formatDateTime(task.archivedAt)}</TableCell>
    <TableCell className={TABLE_TIGHT}>
      <RowMenu items={[{ label: "Unarchive", onSelect: () => onUnarchive(task) }]} />
    </TableCell>
  </TableRow>
);

export const ArchivedPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const path = projectId === "" ? null : `/tasks?projectId=${encodeURIComponent(projectId)}&archived=true`;
  const { data, loading, error, reload } = usePoll<Task[]>(path);
  const { error: actionError, run } = useAction();

  const tasks = useMemo(() => [...(data ?? [])].sort(
    (left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""),
  ), [data]);
  const shown = tasks.slice(0, ARCHIVED_LIMIT);

  const unarchive = (task: Task): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/unarchive`, {}); reload(); });
  };

  if (projectId === "") return <Page><EmptyState>Select a project first.</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <TasksPageHead active="archived" />
      <div className={STACK}>
        {fatal(error, data)
          ? <ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} />
          : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {shown.length === 0
          ? <EmptyState>{loading ? "Loading…" : "Nothing archived yet."}</EmptyState>
          : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Chain</TableHead>
                    <TableHead>Archived</TableHead>
                    <TableHead className={TABLE_TIGHT} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((task) => <ArchivedRow key={task.id} task={task} onUnarchive={unarchive} />)}
                </TableBody>
              </Table>
              {tasks.length > ARCHIVED_LIMIT
                ? <div className={HINT}>Showing the {ARCHIVED_LIMIT} most recently archived.</div>
                : null}
            </>
          )}
      </div>
    </Page>
  );
};
