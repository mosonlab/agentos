import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { compact, duration, formatDateTime, money, sha, timeAgo, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { Link } from "../lib/router";
import type { Run, SessionEvent, Task, TaskActivity, TaskStepOutput, TaskStatus } from "../lib/types";
import { IconArrowLeft, IconChevron, IconRefresh, IconSend } from "../components/icons";
import {
  BACK_LINK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, MSG_CARD, MSG_HEAD, MSG_TIME, ROW, STACK,
  STAT_PILL, STAT_PILLS, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  Card, EmptyState, ErrorNotice, KeyValue, Markdown, Page, Pill, RunPill, ShowMore, TaskPill, Toggle,
} from "../components/ui";
import { retryable } from "./Tasks";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/** `.eventLog` is the scroll container and `.eventRow` is the row grid — two
 *  different boxes, not one. The last row drops its rule. */
const EVENT_LOG = "max-h-[420px] overflow-auto rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--code-background)]";
const EVENT_ROW = "grid grid-cols-[46px_92px_1fr] gap-[10px] border-b border-[color:var(--event-line)] px-[12px] py-[7px] text-[11.5px] last:border-b-0";

const RunEvents = ({ runId }: { runId: string }): ReactNode => {
  const { data, error, loading } = usePoll<SessionEvent[]>(`/runs/${runId}/events`, 3_000);
  const events = data ?? [];
  if (error !== null) return <ErrorNotice message={`${error.status} ${error.message}`} />;
  if (events.length === 0) return <EmptyState>{loading ? "Loading events…" : "No session events recorded for this run."}</EmptyState>;
  return (
    <div className={EVENT_LOG}>
      {events.map((event) => (
        <div className={EVENT_ROW} key={event.id}>
          <span className="text-[color:var(--faint)]">#{event.seq}</span>
          <span className="overflow-hidden text-ellipsis text-primary">{event.type}</span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground" title={compact(event.payload, 2_000)}>{compact(event.payload)}</span>
        </div>
      ))}
    </div>
  );
};

const RunRow = ({ run, expanded, onToggle }: { run: Run; expanded: boolean; onToggle: () => void }): ReactNode => (
  <>
    <TableRow className="cursor-pointer" onClick={onToggle}>
      <TableCell className={TABLE_TIGHT}><span className="text-muted-foreground"><IconChevron open={expanded} /></span></TableCell>
      <TableCell className={TABLE_NAME}>#{run.runNumber}<span className={TABLE_SUB}>{run.runner.toLowerCase()} · {run.model}</span></TableCell>
      <TableCell><RunPill status={run.status} /></TableCell>
      <TableCell>{formatDateTime(run.startedAt ?? run.queuedAt)}</TableCell>
      <TableCell>{duration(run.startedAt, run.endedAt)}</TableCell>
      <TableCell>{run.branch ?? run.targetBranch ?? "—"}</TableCell>
      <TableCell className="text-[11.5px]">{sha(run.baseSha)} → {sha(run.headSha)}</TableCell>
      <TableCell>{money(run.session?.costUsd ?? null)}</TableCell>
      <TableCell>{run.failureClass === null ? "—" : <Pill tone="red">{run.failureClass.toLowerCase().replace(/_/g, " ")}</Pill>}</TableCell>
    </TableRow>
    {expanded ? (
      <TableRow>
        <TableCell colSpan={9} className="bg-[color:var(--surface-run-detail)]">
          <div className={STACK}>
            <KeyValue columns={3} items={[
              { k: "Run ID", v: <span className="text-[11.5px]">{run.id}</span> },
              { k: "Runner instance", v: run.runnerId ?? "—" },
              { k: "Lease generation", v: `${run.leaseGeneration}` },
              { k: "Workspace", v: <span className="text-[11.5px]">{run.workspacePath ?? "—"}{run.workspaceRetained ? " (retained)" : ""}</span> },
              { k: "Budget", v: `${run.maxDurationMin}m wall · ${run.stallTimeoutMin}m stall · ${run.maxRunsPerTask} runs` },
              { k: "Push", v: run.pullRequestUrl ? <a href={run.pullRequestUrl} target="_blank" rel="noreferrer">{run.pushStatus.toLowerCase()}</a> : run.pushStatus.toLowerCase().replace(/_/g, " ") },
              { k: "Session status", v: run.session?.executionStatus.toLowerCase().replace("_", " ") ?? "—" },
              { k: "Resume attempts", v: `${run.session?.resumeAttempt ?? 0}` },
              { k: "Termination", v: run.terminationReason ?? "—" },
            ]} />
            {run.failureReason === null ? null : <ErrorNotice message={run.failureReason} />}
            <RunEvents runId={run.id} />
          </div>
        </TableCell>
      </TableRow>
    ) : null}
  </>
);

const Activity = ({ taskId }: { taskId: string }): ReactNode => {
  const { data, reload } = usePoll<TaskActivity[]>(`/tasks/${taskId}/activity`);
  const [comment, setComment] = useState("");
  const { pending, error, run } = useAction();
  const items = data ?? [];

  const send = async (): Promise<void> => {
    if (comment.trim().length === 0) return;
    const ok = await run(() => api.post(`/tasks/${taskId}/activity`, { actorType: "operator", body: comment }));
    if (ok) { setComment(""); reload(); }
  };

  return (
    <Card title="Activity" extra={<span className={COUNT}>{items.length}</span>}>
      <div className={STACK}>
        {items.length === 0 ? <EmptyState>No activity yet.</EmptyState> : (
          <div className="[&>*+*]:mt-[12px]">
            {items.map((item) => (
              <div className={MSG_CARD} key={item.id}>
                <div className={MSG_HEAD}>
                  <span className="text-foreground">{titleCase(item.actorType)}</span>
                  {item.actorId === null ? null : <span className="text-[11.5px] text-[color:var(--faint)]">{item.actorId}</span>}
                  <span className={MSG_TIME}>{formatDateTime(item.createdAt)}</span>
                </div>
                <Markdown text={item.body} />
              </div>
            ))}
          </div>
        )}
        {error === null ? null : <ErrorNotice message={error} />}
        <div className={ROW}>
          <Input type="text" value={comment} placeholder="Add a comment..." onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void send(); }} />
          <Button type="button" variant="legacy" size="legacy" disabled={pending || comment.trim().length === 0} onClick={() => void send()}>
            <IconSend />Send
          </Button>
        </div>
      </div>
    </Card>
  );
};

const STATUSES: TaskStatus[] = ["TODO", "DOING", "REVIEW", "DONE"];

export const TaskDetailPage = ({ taskId }: { taskId: string }): ReactNode => {
  const { data: task, error, reload } = usePoll<Task>(`/tasks/${taskId}`);
  const output = usePoll<TaskStepOutput>(`/tasks/${taskId}/output`, 10_000);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { pending, error: actionError, run } = useAction();

  if (error !== null && task === null) {
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  if (!task) return <Page><EmptyState>Loading…</EmptyState></Page>;

  const patch = (body: Record<string, unknown>): void => {
    void run(async () => { await api.patch(`/tasks/${taskId}`, body); reload(); });
  };
  const retry = (): void => {
    void run(async () => { await api.post(`/tasks/${taskId}/retry`, {}); reload(); });
  };
  const runs = task.runs;
  const totalCost = runs.reduce((sum, item) => sum + Number(item.session?.costUsd ?? 0), 0);

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/tasks" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{task.name}</h1>
        <TaskPill status={task.status} />
        {task.templateId === null ? null : <Pill tone="violet">Template</Pill>}
        <span className="flex-1" />
        <Select className="w-[130px]" value={task.status} disabled={pending} onChange={(event) => patch({ status: event.target.value })}>
          {STATUSES.map((status) => <option key={status} value={status}>{status.toLowerCase()}</option>)}
        </Select>
        {retryable(task) ? (
          <Button type="button" variant="legacy" size="legacy" disabled={pending} onClick={retry}><IconRefresh />Retry</Button>
        ) : null}
        <Button type="button" variant="legacy" size="legacy" onClick={reload}><IconRefresh />Refresh</Button>
      </div>

      <div className={STACK}>
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {task.failureReason === null ? null : <ErrorNotice message={task.failureReason} />}

        <div className={STAT_PILLS}>
          <span className={STAT_PILL}>{runs.length} runs</span>
          <span className={STAT_PILL}>{money(totalCost === 0 ? null : totalCost)} spend</span>
          <span className={STAT_PILL}>{task.maxDurationMin}m wall-clock</span>
          <span className={STAT_PILL}>{task.stallTimeoutMin}m stall</span>
          <span className={STAT_PILL}>max {task.maxSessionsPerTask} runs</span>
        </div>

        <Card title="Details">
          <KeyValue items={[
            { k: "Agent", v: task.assigneeAgent ? <Link to={`/agents/${task.assigneeAgent.id}`}>{task.assigneeAgent.title}</Link> : "No agent" },
            { k: "Assignee", v: task.assigneeType === "AGENT" ? "Agent" : "Human" },
            { k: "Repo", v: task.repo ? `${task.repo.name} · ${task.repo.remoteUrl}` : "—" },
            { k: "Target branch", v: task.targetBranch ?? task.repo?.defaultBranch ?? "—" },
            { k: "Schedule", v: task.scheduleKind === "NOW" ? "Run once" : titleCase(task.scheduleKind) },
            { k: "Working directory", v: task.workingDirectory ?? "—" },
            {
              k: "Requires approval",
              v: (
                <span className={ROW}>
                  <Toggle on={task.approvalGate} onChange={(next) => patch({ approvalGate: next })} label="Requires approval" />
                  <span className="text-[11.5px] text-muted-foreground">{task.approvalGate ? "Decided in the Inbox" : "Off"}</span>
                </span>
              ),
            },
            { k: "Created", v: formatDateTime(task.createdAt) },
          ]} />
        </Card>

        <Card title="Prompt">
          {task.description.trim().length === 0
            ? <EmptyState>No prompt recorded.</EmptyState>
            : <ShowMore text={task.description} lines={8} />}
        </Card>

        {output.data ? (
          <Card title="Step output" extra={<Pill tone="grey">{output.data.kind}</Pill>}>
            <ShowMore text={output.data.body} lines={10} />
            <div className="mt-2.5">Updated {timeAgo(output.data.updatedAt)}</div>
          </Card>
        ) : null}

        <Card title="Runs" extra={<span className={COUNT}>{runs.length}</span>} flush>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>Run</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead>Duration</TableHead>
                <TableHead>Branch</TableHead><TableHead>base → head</TableHead><TableHead>Cost</TableHead><TableHead>Failure class</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((item) => (
                <RunRow key={item.id} run={item} expanded={expanded === item.id}
                  onToggle={() => setExpanded(expanded === item.id ? null : item.id)} />
              ))}
            </TableBody>
          </Table>
          {runs.length === 0 ? <EmptyState>No runs yet. Agent tasks queue a run on creation.</EmptyState> : null}
        </Card>

        <Activity taskId={taskId} />
      </div>
    </Page>
  );
};
