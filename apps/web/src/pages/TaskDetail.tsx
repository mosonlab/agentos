import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { compactTokens, duration, formatDateTime, money, repoWebUrl, sha, timeAgo, titleCase } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { Link } from "../lib/router";
import { fatal } from "../lib/poll-state";
import type { Chain, ChainStep, Run, Task, TaskActivity, TaskStepOutput, TaskStatus } from "../lib/types";
import { cn } from "../lib/utils";
import { IconArchive, IconArrowLeft, IconChevron, IconRefresh, IconSend } from "../components/icons";
import { ChainList } from "../components/chain-list";
import {
  BACK_LINK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, MSG_CARD, MSG_HEAD, MSG_TIME, ROW, SHOW_MORE_BUTTON, STACK,
  STAT_PILL, STAT_PILLS, TABLE_NAME, TABLE_SUB, TABLE_TIGHT,
  Card, EmptyState, ErrorNotice, KeyValue, Markdown, Page, Pill, RunPill, ShowMore, TaskPill, Toggle, isLongText,
} from "../components/ui";
import { retryable } from "../lib/board";
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

const RunRow = ({ run, remoteUrl, expanded, onToggle }: { run: Run; remoteUrl: string | null | undefined; expanded: boolean; onToggle: () => void }): ReactNode => {
  const t = useT();
  return (
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
        <TableCell>{run.failureClass === null ? "—" : <Pill tone="red">{t(`status.failure.${run.failureClass}`)}</Pill>}</TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={10} className="bg-[color:var(--surface-run-detail)]">
            <div className={STACK}>
              <KeyValue columns={3} items={[
                { k: t("taskDetail.run.id"), v: <span className="text-[11.5px]">{run.id}</span> },
                { k: t("taskDetail.run.runnerInstance"), v: run.runnerId ?? "—" },
                { k: t("taskDetail.run.leaseGeneration"), v: `${run.leaseGeneration}` },
                { k: t("taskDetail.run.workspace"), v: <span className="text-[11.5px]">{run.workspacePath ?? "—"}{run.workspaceRetained ? ` ${t("taskDetail.run.retained")}` : ""}</span> },
                { k: t("taskDetail.run.budget"), v: t("taskDetail.run.budgetValue", { wall: run.maxDurationMin, stall: run.stallTimeoutMin, runs: run.maxRunsPerTask }) },
                // `pushStatus` is an open string on the wire, not a closed union, so
                // it stays a technical identifier (spec §4.3.7's carve-out).
                { k: t("taskDetail.run.push"), v: run.pushStatus.toLowerCase().replace(/_/g, " ") },
                // The task Details card sources its anchor from the newest run
                // alone, so without this entry an earlier run's PR — a retry, a
                // review run, a run that failed after pushing — is reachable from
                // nowhere. Distinct from `Push`, which is the status and not a link.
                { k: t("taskDetail.run.pullRequest"), v: run.pullRequestUrl === null ? "—"
                  : <ExternalLink href={run.pullRequestUrl}>{pullRequestLabel(run.pullRequestUrl)}</ExternalLink> },
                { k: t("taskDetail.run.sessionStatus"), v: run.session ? t(`status.session.${run.session.executionStatus}`) : "—" },
                { k: t("taskDetail.run.session"), v: run.session ? <Link to={`/sessions/${run.session.id}`}>{t("taskDetail.run.openSession")}</Link> : "—" },
                { k: t("taskDetail.run.resumeAttempts"), v: `${run.session?.resumeAttempt ?? 0}` },
                { k: t("taskDetail.run.termination"), v: run.terminationReason ?? "—" },
              ]} />
              {run.failureReason === null ? null : <ErrorNotice message={run.failureReason} />}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
};

const Activity = ({ taskId }: { taskId: string }): ReactNode => {
  const { data, reload } = usePoll<TaskActivity[]>(`/tasks/${taskId}/activity`);
  const [comment, setComment] = useState("");
  const { pending, error, run } = useAction();
  const t = useT();
  const items = data ?? [];

  const send = async (): Promise<void> => {
    if (comment.trim().length === 0) return;
    const ok = await run(() => api.post(`/tasks/${taskId}/activity`, { actorType: "operator", body: comment }));
    if (ok) { setComment(""); reload(); }
  };

  return (
    <Card title={t("taskDetail.activity.title")} extra={<span className={COUNT}>{items.length}</span>}>
      <div className={STACK}>
        {items.length === 0 ? <EmptyState>{t("taskDetail.activity.empty")}</EmptyState> : (
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
          <Input type="text" value={comment} placeholder={t("taskDetail.activity.placeholder")} onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void send(); }} />
          <Button type="button" variant="legacy" size="legacy" disabled={pending || comment.trim().length === 0} onClick={() => void send()}>
            <IconSend />{t("taskDetail.activity.send")}
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
  const t = useT();
  const empty = output.body.trim().length === 0;
  const long = isLongText(output.body, 10);
  return (
    <Card title={t("taskDetail.output.title")} extra={<Pill tone="grey">{output.kind}</Pill>}>
      {empty ? <EmptyState>{t("taskDetail.output.empty")}</EmptyState> : (
        <div>
          <div className={cn(!open && long && "max-h-[420px] overflow-hidden")}>
            <Markdown text={output.body} />
          </div>
          {long ? (
            <button type="button" className={SHOW_MORE_BUTTON} onClick={() => setOpen(!open)}>
              <IconChevron open={open} />{t(open ? "ui.showMore.less" : "ui.showMore.more")}
            </button>
          ) : null}
        </div>
      )}
      <div className="mt-2.5">{t("taskDetail.output.updated", { at: timeAgo(output.updatedAt) })}</div>
    </Card>
  );
};

// BACKLOG first, so the header select can park a task as well as move it on.
const STATUSES: TaskStatus[] = ["BACKLOG", "TODO", "DOING", "REVIEW", "DONE"];

export const TaskDetailPage = ({ taskId }: { taskId: string }): ReactNode => {
  const { data: task, error, reload } = usePoll<Task>(`/tasks/${taskId}`);
  const output = usePoll<TaskStepOutput>(`/tasks/${taskId}/output`, 10_000);
  // No new cadence: the chain rides the page's default poll.
  const chain = usePoll<Chain>(`/tasks/${taskId}/chain`);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { pending, error: actionError, run } = useAction();
  const t = useT();

  // `usePoll` keeps the last good data on error, which is right for a blip and
  // wrong for a deletion — `fatal` is what makes a 404 authoritative. The chain
  // poll deliberately has no error branch of its own: its 404 can also mean
  // "this task never had a chain", and it must not paper over a live task.
  if (fatal(error, task)) {
    return <Page><ErrorNotice message={`${error!.status} ${error!.message}`} onRetry={reload} /></Page>;
  }
  if (!task) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  const patch = (body: Record<string, unknown>): void => {
    void run(async () => { await api.patch(`/tasks/${taskId}`, body); reload(); });
  };
  const retry = (): void => {
    void run(async () => { await api.post(`/tasks/${taskId}/retry`, {}); reload(); });
  };
  const startStep = (step: ChainStep): void => {
    void run(async () => { await api.post(`/tasks/${step.taskId}/start`, {}); reload(); chain.reload(); });
  };
  const setArchived = (archived: boolean): void => {
    void run(async () => {
      await api.post(`/tasks/${taskId}/${archived ? "archive" : "unarchive"}`, {});
      reload();
      chain.reload();
    });
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
        {task.templateId === null ? null : <Pill tone="violet">{t("tasks.pill.template")}</Pill>}
        {task.archivedAt === null ? null : <Pill tone="grey">{t("chain.archived")}</Pill>}
        <span className="flex-1" />
        {/* `disabled:opacity-100 disabled:cursor-default`: the retired sheet had no
            `select:disabled` rule at all, so this control rendered at full opacity
            with the UA cursor while a patch was in flight. The primitive dims to
            50% and shows `not-allowed` (ui/select.tsx:21). */}
        <Select className="w-[130px] disabled:opacity-100 disabled:cursor-default" value={task.status} disabled={pending} onChange={(event) => patch({ status: event.target.value })}>
          {STATUSES.map((status) => <option key={status} value={status}>{t(`status.task.${status}`)}</option>)}
        </Select>
        {retryable(task, task.runs[0]) ? (
          <Button type="button" variant="legacy" size="legacy" disabled={pending} onClick={retry}><IconRefresh />{t("common.retry")}</Button>
        ) : null}
        <Button type="button" variant="legacy" size="legacy" disabled={pending} onClick={() => setArchived(task.archivedAt === null)}>
          <IconArchive />{t(task.archivedAt === null ? "tasks.menu.archive" : "archived.menu.unarchive")}
        </Button>
        <Button type="button" variant="legacy" size="legacy" onClick={reload}><IconRefresh />{t("common.refresh")}</Button>
      </div>

      <div className={STACK}>
        {actionError === null ? null : <ErrorNotice message={actionError} />}
        {task.failureReason === null ? null : <ErrorNotice message={task.failureReason} />}

        <div className={STAT_PILLS}>
          <span className={STAT_PILL}>{t("taskDetail.stats.runs", { n: runs.length })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.spend", { amount: money(totalCost === 0 ? null : totalCost) })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.tokens", { n: compactTokens(totalTokens) })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.wallClock", { n: task.maxDurationMin })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.stall", { n: task.stallTimeoutMin })}</span>
          <span className={STAT_PILL}>{t("taskDetail.stats.maxRuns", { n: task.maxSessionsPerTask })}</span>
        </div>

        <Card title={t("taskDetail.details.title")}>
          <KeyValue items={[
            { k: t("taskDetail.details.agent"), v: task.assigneeAgent ? <Link to={`/agents/${task.assigneeAgent.id}`}>{task.assigneeAgent.title}</Link> : t("taskDetail.details.noAgent") },
            { k: t("taskDetail.details.assignee"), v: t(task.assigneeType === "AGENT" ? "newTask.option.agent" : "newTask.option.human") },
            { k: t("taskDetail.details.repo"), v: task.repo ? `${task.repo.name} · ${task.repo.remoteUrl}` : "—" },
            { k: t("taskDetail.details.targetBranch"), v: task.targetBranch ?? task.repo?.defaultBranch ?? "—" },
            {
              k: t("taskDetail.details.branch"),
              v: newestBranch === null ? "—"
                : newestBranchUrl === null ? newestBranch
                  : <ExternalLink href={newestBranchUrl}>{newestBranch}</ExternalLink>,
            },
            {
              k: t("taskDetail.details.pullRequest"),
              v: pullRequestUrl === null ? "—"
                : <ExternalLink href={pullRequestUrl}>{pullRequestLabel(pullRequestUrl)}</ExternalLink>,
            },
            { k: t("taskDetail.details.schedule"), v: t(`taskDetail.details.scheduleKind.${task.scheduleKind}`) },
            { k: t("taskDetail.details.workingDirectory"), v: task.workingDirectory ?? "—" },
            {
              k: t("taskDetail.details.approval"),
              v: (
                <span className={ROW}>
                  <Toggle on={task.approvalGate} onChange={(next) => patch({ approvalGate: next })} label={t("taskDetail.details.approval")} />
                  <span className="text-[11.5px] text-muted-foreground">{t(task.approvalGate ? "taskDetail.details.approvalOn" : "taskDetail.details.approvalOff")}</span>
                </span>
              ),
            },
            { k: t("taskDetail.details.created"), v: formatDateTime(task.createdAt) },
          ]} />
        </Card>

        {chain.data && chain.data.chainId !== null
          ? <ChainList chain={chain.data} taskId={taskId} pending={pending} onStart={startStep} />
          : null}

        <Card title={t("taskDetail.prompt.title")}>
          {task.description.trim().length === 0
            ? <EmptyState>{t("taskDetail.prompt.empty")}</EmptyState>
            : <ShowMore text={task.description} lines={8} />}
        </Card>

        {output.data ? <StepOutput output={output.data} /> : null}

        <Card title={t("taskDetail.runs.title")} extra={<span className={COUNT}>{runs.length}</span>} flush>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>{t("taskDetail.runs.table.run")}</TableHead><TableHead>{t("taskDetail.runs.table.status")}</TableHead><TableHead>{t("taskDetail.runs.table.started")}</TableHead><TableHead>{t("taskDetail.runs.table.duration")}</TableHead>
                <TableHead>{t("taskDetail.runs.table.branch")}</TableHead><TableHead>base → head</TableHead><TableHead>{t("taskDetail.runs.table.cost")}</TableHead><TableHead>{t("taskDetail.runs.table.tokens")}</TableHead><TableHead>{t("taskDetail.runs.table.failureClass")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((item) => (
                <RunRow key={item.id} run={item} remoteUrl={task.repo?.remoteUrl} expanded={expanded === item.id}
                  onToggle={() => setExpanded(expanded === item.id ? null : item.id)} />
              ))}
            </TableBody>
          </Table>
          {runs.length === 0 ? <EmptyState>{t("taskDetail.runs.empty")}</EmptyState> : null}
        </Card>

        <Activity taskId={taskId} />
      </div>
    </Page>
  );
};
