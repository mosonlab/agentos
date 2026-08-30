import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { formatT, money, timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fatal } from "../lib/poll-state";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import { automationState, cronProse, nextRunLabel, scheduleLabel } from "../lib/schedule";
import type { RecurringFire, TaskList } from "../lib/types";
import { IconBolt, IconChevron } from "../components/icons";
import { TasksPageHead } from "../components/tasks-tabs";
import {
  FIELD_ROW, HINT, STACK, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  AgentChip, Card, EmptyState, ErrorNotice, Field, Page, Pill, RowMenu, RunPill,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { cn } from "../lib/utils";

/** §4.7's three states, as the pill each one renders. */
/* Pure, exported and asserted directly by `automations.test.tsx`, so — like
 * `archiveDoneNotice` — it reads the locale through `formatT`, the WI-4
 * registration seam, rather than taking a `Translate` parameter. */
export const stateLabel = (task: TaskList): { tone: "green" | "amber" | "red"; label: string; note: string | null } => {
  const state = automationState(task);
  if (state === "paused") return { tone: "amber", label: formatT("automations.state.paused"), note: null };
  if (state === "quarantined") return { tone: "red", label: formatT("automations.state.quarantined"), note: formatT("automations.note.fixCron") };
  return { tone: "green", label: formatT("automations.state.active"), note: formatT("automations.nextRun", { at: nextRunLabel(task.runAt) }) };
};

/** The copies a recurring definition has fired, polled only while the row is
 *  open. The summary above it comes from the list response instead: `usePoll`
 *  with a null path clears its data and issues no request, so anything read from
 *  a mounted-when-expanded poll reads `Never` on every collapsed row. */
const Fires = ({ taskId }: { taskId: string }): ReactNode => {
  const { data, loading } = usePoll<RecurringFire[]>(`/tasks/${taskId}/recurring-fires?take=5`, 10_000);
  const t = useT();
  const fires = data ?? [];
  if (fires.length === 0) return <div className={HINT}>{t(loading ? "common.loading" : "automations.fires.empty")}</div>;
  return (
    <div className={STACK}>
      {fires.map((fire) => (
        <div key={fire.taskId} className="flex flex-wrap items-center gap-[10px] text-[12px]">
          <span className="text-muted-foreground">{timeAgo(fire.createdAt)}</span>
          <Link to={`/tasks/${fire.taskId}`}>{fire.name}</Link>
          {fire.latestRun ? <RunPill status={fire.latestRun.status} /> : <Pill tone="grey">{t("automations.fires.noRun")}</Pill>}
          {fire.latestRun?.session ? <Link to={`/sessions/${fire.latestRun.session.id}`}>{t("automations.fires.session")}</Link> : null}
          <span className="text-muted-foreground">{money(fire.latestRun?.session?.costUsd ?? null)}</span>
        </div>
      ))}
      <div><Link to="/sessions">{t("automations.fires.viewAll")}</Link></div>
    </div>
  );
};

/** Plain-text cron editing, per spec §3.2: no builder, and deliberately no
 *  client-side validator either. `validateSchedule` already rejects a bad
 *  expression and a bad IANA zone with a specific 400 and recomputes `runAt` on
 *  success; a second validator here could only disagree with it. The live prose
 *  preview is the feedback a builder would have provided. */
export const CronEditor = ({ task, onSaved }: { task: TaskList; onSaved: () => void }): ReactNode => {
  const [cron, setCron] = useState(task.cron ?? "");
  const [timezone, setTimezone] = useState(task.timezone ?? "");
  const { pending, error, run } = useAction();
  const t = useT();
  const save = (): void => {
    // The row keeps whatever the operator typed on a rejection, so a typo is
    // corrected rather than retyped.
    void run(async () => {
      await api.patch(`/tasks/${task.id}`, { cron, timezone: timezone.trim() === "" ? null : timezone });
      onSaved();
    });
  };
  return (
    <div className={STACK}>
      {error === null ? null : <ErrorNotice message={error} />}
      <div className={FIELD_ROW}>
        <Field label={t("automations.cron.label")} hint={t("automations.cron.hint")}>
          <Input type="text" value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * *" />
        </Field>
        <Field label={t("automations.timezone.label")} hint={t("automations.timezone.hint")}>
          <Input type="text" value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Shanghai" />
        </Field>
      </div>
      <div className={HINT}>{cronProse(cron === "" ? null : cron, timezone === "" ? null : timezone)}</div>
      <div>
        <Button type="button" variant="legacyPrimary" size="legacy" disabled={pending} onClick={save}>{t("common.save")}</Button>
      </div>
    </div>
  );
};

export const AutomationRow = ({ task, expanded, onToggle, onPause, onDelete, onSaved }: {
  task: TaskList;
  expanded: boolean;
  onToggle: () => void;
  onPause: (task: TaskList) => void;
  onDelete: (task: TaskList) => void;
  onSaved: () => void;
}): ReactNode => {
  const state = stateLabel(task);
  const paused = task.schedulePausedAt !== null;
  const t = useT();
  return (
    <>
      <TableRow className="cursor-pointer" onClick={(event) => { if (!event.defaultPrevented) onToggle(); }}>
        <TableCell className={TABLE_TIGHT}><span className="text-muted-foreground"><IconChevron open={expanded} /></span></TableCell>
        <TableCell className={TABLE_NAME}>
          <Link to={`/tasks/${task.id}`}>{task.name}</Link>
          <span className={TABLE_SUB}>{t("automations.fired", { n: task.recurringFireCount })}</span>
        </TableCell>
        <TableCell><AgentChip agent={null} {...(task.assigneeAgent ? { name: task.assigneeAgent.title } : {})} /></TableCell>
        <TableCell>
          {scheduleLabel(task)}
          <span className={TABLE_SUB}>{task.cron ?? "—"} · {task.timezone ?? "UTC"}</span>
        </TableCell>
        <TableCell>
          <span className="inline-flex flex-wrap items-center gap-[8px]">
            <Pill tone={state.tone}>{state.label}</Pill>
            {/* B5/O3: a parked definition is still scheduled — the scheduler only
                ever picks up TODO, so saying just "Active" would be a lie. */}
            {task.status === "BACKLOG" ? <span className="text-[11.5px] text-muted-foreground">{t("automations.inBacklog")}</span> : null}
          </span>
          {state.note === null ? null : <span className={TABLE_SUB}>{state.note}</span>}
        </TableCell>
        <TableCell>{task.recurringLastFiredAt === null ? t("automations.never") : timeAgo(task.recurringLastFiredAt)}</TableCell>
        <TableCell className={TABLE_TIGHT}>
          <RowMenu items={[
            { label: t(paused ? "automations.menu.resume" : "automations.menu.pause"), onSelect: () => onPause(task) },
            { label: t("automations.menu.openTask"), onSelect: () => navigate(`/tasks/${task.id}`) },
            { label: t("common.delete"), danger: true, onSelect: () => onDelete(task) },
          ]} />
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={7} className="bg-[color:var(--surface-run-detail)]">
            <div className={cn(STACK, "py-[6px]")}>
              <CronEditor task={task} onSaved={onSaved} />
              <Card title={t("automations.fires.title")}><Fires taskId={task.id} /></Card>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
};

export const AutomationsPage = (): ReactNode => {
  const { projectId } = useProjectScope();
  const path = projectId === "" ? null : `/tasks?projectId=${encodeURIComponent(projectId)}`;
  const { data, loading, error, reload } = usePoll<TaskList[]>(path);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { error: actionError, run } = useAction();
  const t = useT();

  // The board's own query already returns exactly this set, so the page adds no
  // endpoint and shares one cache with it. No `archivedAt` predicate: `GET /tasks`
  // defaults to `archived=false` and this path passes no override, so filtering
  // again here would read as a guard while removing nothing.
  const automations = (data ?? []).filter((task) => task.scheduleKind === "CRON");

  const togglePause = (task: TaskList): void => {
    const action = task.schedulePausedAt === null ? "pause" : "resume";
    void run(async () => { await api.post(`/tasks/${task.id}/schedule/${action}`, {}); reload(); });
  };
  const remove = (task: TaskList): void => {
    if (!window.confirm(t("automations.confirm.delete", { name: task.name }))) return;
    void run(async () => { await api.delete(`/tasks/${task.id}`); reload(); });
  };

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <TasksPageHead active="automations" onCreated={reload} />
      <div className={STACK}>
        {fatal(error, data) ? <ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /> : null}
        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {automations.length === 0 ? (
          <EmptyState>
            <span className="mb-[10px] inline-flex text-[color:var(--faint)]"><IconBolt size={22} /></span>
            <div>{t(loading ? "common.loading" : "automations.empty.title")}</div>
            <div className={cn(HINT, "mt-[6px]")}>{t("automations.empty.hint")}</div>
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={TABLE_TIGHT} />
                <TableHead>{t("automations.table.title")}</TableHead>
                <TableHead>{t("automations.table.agent")}</TableHead>
                <TableHead>{t("automations.table.schedule")}</TableHead>
                <TableHead>{t("automations.table.status")}</TableHead>
                <TableHead>{t("automations.table.lastRun")}</TableHead>
                <TableHead className={TABLE_TIGHT} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {automations.map((task) => (
                <AutomationRow
                  key={task.id}
                  task={task}
                  expanded={expanded === task.id}
                  onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
                  onPause={togglePause}
                  onDelete={remove}
                  onSaved={reload}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Page>
  );
};
