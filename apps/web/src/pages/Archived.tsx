import { type ReactNode, useMemo } from "react";

import { api } from "../lib/api";
import { chainMarker } from "../lib/chain";
import { formatDateTime } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fatal } from "../lib/poll-state";
import { useProjectScope } from "../lib/project";
import { navigate } from "../lib/router";
import type { TaskList } from "../lib/types";
import { TasksPageHead } from "../components/tasks-tabs";
import {
  HINT, STACK, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  AgentChip, EmptyState, ErrorNotice, Page, RowMenu, TaskPill,
} from "../components/ui";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/** [A7]: the archive grows without bound, so the page shows a window rather
 *  than pretending to show everything. */
export const ARCHIVED_LIMIT = 200;

export const ArchivedRow = ({ task, onUnarchive }: { task: TaskList; onUnarchive: (task: TaskList) => void }): ReactNode => {
  const t = useT();
  return (
    <TableRow
      className="cursor-pointer"
      onClick={(event) => { if (!event.defaultPrevented) navigate(`/tasks/${task.id}`); }}
    >
      <TableCell className={TABLE_NAME}>
        {task.name}
        {/* The step name when the task came from a template; a raw cuid is noise,
            so a task that has no step name gets no sub-line at all. */}
        {task.templateStep === null ? null : <span className={TABLE_SUB}>{task.templateStep.name}</span>}
      </TableCell>
      <TableCell><TaskPill status={task.status} /></TableCell>
      <TableCell><AgentChip agent={null} name={task.assigneeAgent?.title ?? t("ui.chip.unassigned")} /></TableCell>
      <TableCell>{chainMarker(task.chainProgress) ?? "—"}</TableCell>
      <TableCell>{formatDateTime(task.archivedAt)}</TableCell>
      <TableCell className={TABLE_TIGHT}>
        <RowMenu items={[{ label: t(task.chainId === null ? "archived.menu.unarchive" : "archived.menu.unarchiveChain"), onSelect: () => onUnarchive(task) }]} />
      </TableCell>
    </TableRow>
  );
};

export const ArchivedPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const path = projectId === "" ? null : `/tasks?projectId=${encodeURIComponent(projectId)}&archived=true`;
  const { data, loading, error, reload } = usePoll<TaskList[]>(path);
  const { error: actionError, run } = useAction();
  const t = useT();

  const tasks = useMemo(() => [...(data ?? [])].sort(
    (left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""),
  ), [data]);
  const shown = tasks.slice(0, ARCHIVED_LIMIT);

  const unarchive = (task: TaskList): void => {
    void run(async () => { await api.post(`/tasks/${task.id}/unarchive`, {}); reload(); });
  };

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <TasksPageHead active="archived" />
      <div className={STACK}>
        {fatal(error, data)
          ? <ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} />
          : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {shown.length === 0
          ? <EmptyState>{t(loading ? "common.loading" : "archived.empty")}</EmptyState>
          : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("archived.table.name")}</TableHead>
                    <TableHead>{t("archived.table.status")}</TableHead>
                    <TableHead>{t("archived.table.agent")}</TableHead>
                    <TableHead>{t("archived.table.chain")}</TableHead>
                    <TableHead>{t("archived.table.archived")}</TableHead>
                    <TableHead className={TABLE_TIGHT} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((task) => <ArchivedRow key={task.id} task={task} onUnarchive={unarchive} />)}
                </TableBody>
              </Table>
              {tasks.length > ARCHIVED_LIMIT
                ? <div className={HINT}>{t("archived.window", { n: ARCHIVED_LIMIT })}</div>
                : null}
            </>
          )}
      </div>
    </Page>
  );
};
