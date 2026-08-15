import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { compact, duration, formatDateTime, money, sha, timeAgo, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { Link } from "../lib/router";
import type { Run, SessionEvent, Task, TaskActivity, TaskStepOutput, TaskStatus } from "../lib/types";
import { IconArrowLeft, IconChevron, IconRefresh, IconSend } from "../components/icons";
import {
  Card, EmptyState, ErrorNotice, KeyValue, Markdown, Pill, RunPill, ShowMore, TaskPill, Toggle,
} from "../components/ui";
import { retryable } from "./Tasks";

const RunEvents = ({ runId }: { runId: string }): ReactNode => {
  const { data, error, loading } = usePoll<SessionEvent[]>(`/runs/${runId}/events`, 3_000);
  const events = data ?? [];
  if (error !== null) return <ErrorNotice message={`${error.status} ${error.message}`} />;
  if (events.length === 0) return <EmptyState>{loading ? "Loading events…" : "No session events recorded for this run."}</EmptyState>;
  return (
    <div className="eventLog">
      {events.map((event) => (
        <div className="eventRow" key={event.id}>
          <span className="seq">#{event.seq}</span>
          <span className="type">{event.type}</span>
          <span className="payload" title={compact(event.payload, 2_000)}>{compact(event.payload)}</span>
        </div>
      ))}
    </div>
  );
};

const RunRow = ({ run, expanded, onToggle }: { run: Run; expanded: boolean; onToggle: () => void }): ReactNode => (
  <>
    <tr className="clickable" onClick={onToggle}>
      <td className="tight"><span className="dim"><IconChevron open={expanded} /></span></td>
      <td className="name">#{run.runNumber}<span className="sub">{run.runner.toLowerCase()} · {run.model}</span></td>
      <td><RunPill status={run.status} /></td>
      <td>{formatDateTime(run.startedAt ?? run.queuedAt)}</td>
      <td>{duration(run.startedAt, run.endedAt)}</td>
      <td>{run.branch ?? run.targetBranch ?? "—"}</td>
      <td className="small">{sha(run.baseSha)} → {sha(run.headSha)}</td>
      <td>{money(run.session?.costUsd ?? null)}</td>
      <td>{run.failureClass === null ? "—" : <Pill tone="red">{run.failureClass.toLowerCase().replace(/_/g, " ")}</Pill>}</td>
    </tr>
    {expanded ? (
      <tr>
        <td colSpan={9} style={{ background: "#1b1810" }}>
          <div className="stack">
            <KeyValue columns={3} items={[
              { k: "Run ID", v: <span className="small">{run.id}</span> },
              { k: "Runner instance", v: run.runnerId ?? "—" },
              { k: "Lease generation", v: `${run.leaseGeneration}` },
              { k: "Workspace", v: <span className="small">{run.workspacePath ?? "—"}{run.workspaceRetained ? " (retained)" : ""}</span> },
              { k: "Budget", v: `${run.maxDurationMin}m wall · ${run.stallTimeoutMin}m stall · ${run.maxRunsPerTask} runs` },
              { k: "Push", v: run.pullRequestUrl ? <a href={run.pullRequestUrl} target="_blank" rel="noreferrer">{run.pushStatus.toLowerCase()}</a> : run.pushStatus.toLowerCase().replace(/_/g, " ") },
              { k: "Session status", v: run.session?.executionStatus.toLowerCase().replace("_", " ") ?? "—" },
              { k: "Resume attempts", v: `${run.session?.resumeAttempt ?? 0}` },
              { k: "Termination", v: run.terminationReason ?? "—" },
            ]} />
            {run.failureReason === null ? null : <div className="notice error">{run.failureReason}</div>}
            <RunEvents runId={run.id} />
          </div>
        </td>
      </tr>
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
    <Card title="Activity" extra={<span className="count">{items.length}</span>}>
      <div className="stack">
        {items.length === 0 ? <EmptyState>No activity yet.</EmptyState> : (
          <div>
            {items.map((item) => (
              <div className="msgCard" key={item.id}>
                <div className="msgHead">
                  <span className="strong">{titleCase(item.actorType)}</span>
                  {item.actorId === null ? null : <span className="faint small">{item.actorId}</span>}
                  <span className="time">{formatDateTime(item.createdAt)}</span>
                </div>
                <Markdown text={item.body} />
              </div>
            ))}
          </div>
        )}
        {error === null ? null : <ErrorNotice message={error} />}
        <div className="row">
          <input type="text" value={comment} placeholder="Add a comment..." onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void send(); }} />
          <button type="button" className="btn" disabled={pending || comment.trim().length === 0} onClick={() => void send()}>
            <IconSend />Send
          </button>
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
    return <div className="page"><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></div>;
  }
  if (!task) return <div className="page"><EmptyState>Loading…</EmptyState></div>;

  const patch = (body: Record<string, unknown>): void => {
    void run(async () => { await api.patch(`/tasks/${taskId}`, body); reload(); });
  };
  const retry = (): void => {
    void run(async () => { await api.post(`/tasks/${taskId}/retry`, {}); reload(); });
  };
  const runs = task.runs;
  const totalCost = runs.reduce((sum, item) => sum + Number(item.session?.costUsd ?? 0), 0);

  return (
    <div className="page">
      <div className="detailHead">
        <Link to="/tasks" className="backLink"><IconArrowLeft /></Link>
        <h1>{task.name}</h1>
        <TaskPill status={task.status} />
        {task.templateId === null ? null : <Pill tone="violet">Template</Pill>}
        <span className="spacer" />
        <select value={task.status} disabled={pending} onChange={(event) => patch({ status: event.target.value })} style={{ width: 130 }}>
          {STATUSES.map((status) => <option key={status} value={status}>{status.toLowerCase()}</option>)}
        </select>
        {retryable(task) ? (
          <button type="button" className="btn" disabled={pending} onClick={retry}><IconRefresh />Retry</button>
        ) : null}
        <button type="button" className="btn" onClick={reload}><IconRefresh />Refresh</button>
      </div>

      <div className="stack">
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {task.failureReason === null ? null : <div className="notice error">{task.failureReason}</div>}

        <div className="statPills">
          <span className="statPill">{runs.length} runs</span>
          <span className="statPill">{money(totalCost === 0 ? null : totalCost)} spend</span>
          <span className="statPill">{task.maxDurationMin}m wall-clock</span>
          <span className="statPill">{task.stallTimeoutMin}m stall</span>
          <span className="statPill">max {task.maxSessionsPerTask} runs</span>
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
                <span className="row">
                  <Toggle on={task.approvalGate} onChange={(next) => patch({ approvalGate: next })} label="Requires approval" />
                  <span className="dim small">{task.approvalGate ? "Decided in the Inbox" : "Off"}</span>
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
            <div className="hint" style={{ marginTop: 10 }}>Updated {timeAgo(output.data.updatedAt)}</div>
          </Card>
        ) : null}

        <Card title="Runs" extra={<span className="count">{runs.length}</span>} flush>
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>Run</th><th>Status</th><th>Started</th><th>Duration</th>
                  <th>Branch</th><th>base → head</th><th>Cost</th><th>Failure class</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((item) => (
                  <RunRow key={item.id} run={item} expanded={expanded === item.id}
                    onToggle={() => setExpanded(expanded === item.id ? null : item.id)} />
                ))}
              </tbody>
            </table>
            {runs.length === 0 ? <EmptyState>No runs yet. Agent tasks queue a run on creation.</EmptyState> : null}
          </div>
        </Card>

        <Activity taskId={taskId} />
      </div>
    </div>
  );
};
