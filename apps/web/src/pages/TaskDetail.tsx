import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { compactTokens, duration, formatDateTime, money, repoWebUrl, sha, timeAgo, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { Link } from "../lib/router";
import type { Run, Task, TaskActivity, TaskStepOutput, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { IconArrowLeft, IconChevron, IconRefresh, IconSend } from "../components/icons";
import {
  BACK_LINK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, MSG_CARD, MSG_HEAD, MSG_TIME, ROW, SHOW_MORE_BUTTON, STACK,
  STAT_PILL, STAT_PILLS, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  Card, EmptyState, ErrorNotice, KeyValue, Markdown, Page, Pill, RunPill, ShowMore, TaskPill, Toggle, isLongText,
} from "../components/ui";
import { retryable } from "./Tasks";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

/** The raw event table used to live here. It now lives on the session page
 *  (`pages/Sessions.tsx`) so the product has exactly one of them; the run row
 *  links there instead (plan WI-8, open question A1). */

const ExternalLink = ({ href, children }: { href: string; children: ReactNode }): ReactNode => (
  <a href={href} target="_blank" rel="noreferrer">{children}</a>
);

/** `null` whenever the remote is not a GitHub repo we can address, which is the
 *  caller's signal to render plain text rather than a link that 404s. */
export const branchUrl = (remoteUrl: string | null | undefined, branch: string | null | undefined): string | null => {
  const base = repoWebUrl(remoteUrl);
  if (base === null || !branch) return null;
  return `${base}/tree/${branch}`;
};

/** `#39` from a `/pull/39` tail; the whole URL when it does not parse, because a
 *  link with no label is worse than a long one. */
export const pullRequestLabel = (url: string): string => {
  const parsed = /\/pull\/(\d+)\/?$/.exec(url);
  return parsed === null ? url : `#${parsed[1]}`;
};

const BranchCell = ({ remoteUrl, branch }: { remoteUrl: string | null | undefined; branch: string | null | undefined }): ReactNode => {
  if (!branch) return <>—</>;
  const href = branchUrl(remoteUrl, branch);
  // The row toggles on click; opening the branch must not also expand it.
  return href === null ? <>{branch}</> : (
    <a href={href} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{branch}</a>
  );
};

const RunRow = ({ run, remoteUrl, expanded, onToggle }: { run: Run; remoteUrl: string | null | undefined; expanded: boolean; onToggle: () => void }): ReactNode => (
  <>
    <TableRow className="cursor-pointer" onClick={onToggle}>
      <TableCell className={TABLE_TIGHT}><span className="text-muted-foreground"><IconChevron open={expanded} /></span></TableCell>
      <TableCell className={TABLE_NAME}>#{run.runNumber}<span className={TABLE_SUB}>{run.runner.toLowerCase()} · {run.model}</span></TableCell>
      <TableCell><RunPill status={run.status} /></TableCell>
      <TableCell>{formatDateTime(run.startedAt ?? run.queuedAt)}</TableCell>
      <TableCell>{duration(run.startedAt, run.endedAt)}</TableCell>
      <TableCell><BranchCell remoteUrl={remoteUrl} branch={run.branch ?? run.targetBranch} /></TableCell>
      {/* No size class: this cell carried `.small` before the batch, but
          `.table td { font-size: 12.5px }` outranks `.small` on specificity, so
          11.5px never reached it. The four `.small` spans that survive as
          `text-[11.5px]` all sit in KeyValue lists, outside any table. */}
      <TableCell>{sha(run.baseSha)} → {sha(run.headSha)}</TableCell>
      <TableCell>{money(run.session?.costUsd ?? null)}</TableCell>
      <TableCell>{compactTokens(run.session?.totalTokens ?? null)}</TableCell>
      <TableCell>{run.failureClass === null ? "—" : <Pill tone="red">{run.failureClass.toLowerCase().replace(/_/g, " ")}</Pill>}</TableCell>
    </TableRow>
    {expanded ? (
      <TableRow>
        <TableCell colSpan={10} className="bg-[color:var(--surface-run-detail)]">
          <div className={STACK}>
            <KeyValue columns={3} items={[
              { k: "Run ID", v: <span className="text-[11.5px]">{run.id}</span> },
              { k: "Runner instance", v: run.runnerId ?? "—" },
              { k: "Lease generation", v: `${run.leaseGeneration}` },
              { k: "Workspace", v: <span className="text-[11.5px]">{run.workspacePath ?? "—"}{run.workspaceRetained ? " (retained)" : ""}</span> },
              { k: "Budget", v: `${run.maxDurationMin}m wall · ${run.stallTimeoutMin}m stall · ${run.maxRunsPerTask} runs` },
              // The pull-request anchor lives in the task Details card now; this
              // entry is the push status and nothing else.
              { k: "Push", v: run.pushStatus.toLowerCase().replace(/_/g, " ") },
              { k: "Session status", v: run.session?.executionStatus.toLowerCase().replace("_", " ") ?? "—" },
              { k: "Session", v: run.session ? <Link to={`/sessions/${run.session.id}`}>Open session ↗</Link> : "—" },
              { k: "Resume attempts", v: `${run.session?.resumeAttempt ?? 0}` },
              { k: "Termination", v: run.terminationReason ?? "—" },
            ]} />
            {run.failureReason === null ? null : <ErrorNotice message={run.failureReason} />}
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

/** The step output is markdown, so it cannot use `ShowMore`'s line clamp — that
 *  clamp needs a single text node. A height clamp plus the same control does the
 *  same job over rendered blocks. Whitespace-only bodies get the Prompt card's
 *  empty state rather than an empty box (spec §6). */
export const StepOutput = ({ output }: { output: TaskStepOutput }): ReactNode => {
  const [open, setOpen] = useState(false);
  const empty = output.body.trim().length === 0;
  const long = isLongText(output.body, 10);
  return (
    <Card title="Step output" extra={<Pill tone="grey">{output.kind}</Pill>}>
      {empty ? <EmptyState>No output recorded.</EmptyState> : (
        <div>
          <div className={cn(!open && long && "max-h-[420px] overflow-hidden")}>
            <Markdown text={output.body} />
          </div>
          {long ? (
            <button type="button" className={SHOW_MORE_BUTTON} onClick={() => setOpen(!open)}>
              <IconChevron open={open} />{open ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      )}
      <div className="mt-2.5">Updated {timeAgo(output.updatedAt)}</div>
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
  // `—`, never `0`: a task whose sessions all predate the usage columns has an
  // unknown token count, not a zero one (spec §4.6.5).
  const counted = runs.map((item) => item.session?.totalTokens).filter((value): value is number => typeof value === "number");
  const totalTokens = counted.length === 0 ? null : counted.reduce((sum, value) => sum + value, 0);
  // `app.ts` orders runs `runNumber desc`, so the newest run is the head.
  const newest = runs[0];
  const newestBranch = newest?.branch ?? newest?.targetBranch ?? null;
  const newestBranchUrl = branchUrl(task.repo?.remoteUrl, newestBranch);
  const pullRequestUrl = newest?.pullRequestUrl ?? null;

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/tasks" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{task.name}</h1>
        <TaskPill status={task.status} />
        {task.templateId === null ? null : <Pill tone="violet">Template</Pill>}
        <span className="flex-1" />
        {/* `disabled:opacity-100 disabled:cursor-default`: the retired sheet had no
            `select:disabled` rule at all, so this control rendered at full opacity
            with the UA cursor while a patch was in flight. The primitive dims to
            50% and shows `not-allowed` (ui/select.tsx:21). */}
        <Select className="w-[130px] disabled:opacity-100 disabled:cursor-default" value={task.status} disabled={pending} onChange={(event) => patch({ status: event.target.value })}>
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
          <span className={STAT_PILL}>{compactTokens(totalTokens)} tokens</span>
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
            {
              k: "Branch",
              v: newestBranch === null ? "—"
                : newestBranchUrl === null ? newestBranch
                  : <ExternalLink href={newestBranchUrl}>{newestBranch}</ExternalLink>,
            },
            {
              k: "Pull request",
              v: pullRequestUrl === null ? "—"
                : <ExternalLink href={pullRequestUrl}>{pullRequestLabel(pullRequestUrl)}</ExternalLink>,
            },
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

        {output.data ? <StepOutput output={output.data} /> : null}

        <Card title="Runs" extra={<span className={COUNT}>{runs.length}</span>} flush>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>Run</TableHead><TableHead>Status</TableHead><TableHead>Started</TableHead><TableHead>Duration</TableHead>
                <TableHead>Branch</TableHead><TableHead>base → head</TableHead><TableHead>Cost</TableHead><TableHead>Tokens</TableHead><TableHead>Failure class</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((item) => (
                <RunRow key={item.id} run={item} remoteUrl={task.repo?.remoteUrl} expanded={expanded === item.id}
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
