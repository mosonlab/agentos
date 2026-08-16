import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { compact, compactTokens, duration, formatDateTime, money, repoWebUrl } from "../lib/format";
import { POLL_MS, usePoll } from "../lib/hooks";
import { Link, navigate } from "../lib/router";
import { useProjectScope } from "../lib/project";
import { normalize, type StreamItem } from "../lib/session-stream";
import { useEventStream } from "../lib/use-event-stream";
import type { Session, SessionEvent, SessionExecutionStatus } from "../lib/types";
import { IconArrowLeft, IconChevron, IconRefresh } from "../components/icons";
import {
  BACK_LINK, CODE_BLOCK, COUNT, DETAIL_HEAD, DETAIL_HEAD_H1, DOT, DOT_TONE, HINT, MSG_CARD, MSG_HEAD, MSG_TIME,
  PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, ROW, STACK,
  STAT_PILL, STAT_PILLS, TABLE_NAME, TABLE_SUB,
  AgentChip, Card, EmptyState, ErrorNotice, GapNotice, KeyValue, Markdown, Page, Pill, Segmented, type PillTone,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { cn } from "../lib/utils";

/** `.eventLog` is the scroll container and `.eventRow` is the row grid — two
 *  different boxes, not one. Moved here verbatim from TaskDetail: this page is
 *  now the product's only raw event table. */
const EVENT_LOG = "max-h-[420px] overflow-auto rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--code-background)]";
const EVENT_ROW = "grid grid-cols-[46px_92px_1fr] gap-[10px] border-b border-[color:var(--event-line)] px-[12px] py-[7px] text-[11.5px] last:border-b-0";

const PAGE_SIZE = 50;
const BLOCK_MAX = 8_000;
/** Auto-scroll only when the reader is already at the bottom (assumption A3). */
const NEAR_BOTTOM_PX = 100;

const LIVE_STATUSES: SessionExecutionStatus[] = ["REQUESTED", "PROVISIONING", "RUNNING", "WAITING_INBOX"];

export const isLive = (status: SessionExecutionStatus): boolean => LIVE_STATUSES.includes(status);

/** §4.1.1. Reuses the existing tone vocabulary; no new tones. */
export const sessionPill = (status: SessionExecutionStatus): { tone: PillTone; label: string } => {
  if (status === "REQUESTED" || status === "PROVISIONING") return { tone: "grey", label: "queued" };
  if (status === "RUNNING") return { tone: "green", label: "running" };
  if (status === "WAITING_INBOX") return { tone: "amber", label: "waiting" };
  if (status === "SUCCEEDED") return { tone: "green", label: "done" };
  if (status === "CANCELLED") return { tone: "grey", label: "cancelled" };
  return { tone: "red", label: status.toLowerCase().replace(/_/g, " ") };
};

/** The stat bar's own lifecycle slot: `● Live` while the session runs, and on a
 *  terminal session the same slot reads Done or Failed. The header's status pill
 *  is a different element and does not satisfy this. */
export const lifecycleStat = (status: SessionExecutionStatus): { label: string; tone: "green" | "red" } =>
  isLive(status) ? { label: "Live", tone: "green" }
    : status === "SUCCEEDED" ? { label: "Done", tone: "green" }
      : { label: "Failed", tone: "red" };

const resultWord = (session: Session): string =>
  isLive(session.executionStatus) ? "In progress" : session.executionStatus === "SUCCEEDED" ? "Success" : "Failed";

const SessionStatusPill = ({ status }: { status: SessionExecutionStatus }): ReactNode => {
  const { tone, label } = sessionPill(status);
  return <Pill tone={tone}>{label}</Pill>;
};

/* -------------------------------------------------------------- the list */

export const SessionRow = ({ session }: { session: Session }): ReactNode => {
  const target = session.task
    ? <Link to={`/tasks/${session.task.id}`}>{session.task.name}</Link>
    : session.goal
      ? <Link to={`/goals/${session.goal.id}`}>{session.goal.title}</Link>
      : "—";
  return (
    <TableRow
      className="cursor-pointer"
      // Link calls preventDefault and navigates but does not stop propagation,
      // so without this guard clicking the Task cell would open the session.
      onClick={(event) => { if (!event.defaultPrevented) navigate(`/sessions/${session.id}`); }}
    >
      <TableCell className={TABLE_NAME}>
        {formatDateTime(session.startedAt ?? session.requestedAt)}
        <span className={TABLE_SUB}>{session.run ? `run #${session.run.runNumber}` : session.id}</span>
      </TableCell>
      <TableCell><AgentChip agent={null} name={session.agent?.title ?? session.agentId} /></TableCell>
      <TableCell>{target}</TableCell>
      <TableCell><Pill tone="grey">{session.runner}</Pill></TableCell>
      <TableCell>{duration(session.startedAt, session.endedAt)}</TableCell>
      <TableCell><SessionStatusPill status={session.executionStatus} /></TableCell>
      <TableCell {...(session.failureReason === null ? {} : { title: compact(session.failureReason, 200) })}>
        {resultWord(session)}
      </TableCell>
    </TableRow>
  );
};

export const SessionsPage = (): ReactNode => {
  const { projectId, project } = useProjectScope();
  const path = projectId === "" ? null : `/sessions?projectId=${encodeURIComponent(projectId)}&limit=${PAGE_SIZE}`;
  const head = usePoll<Session[]>(path, POLL_MS);
  // Older pages are history: fetched imperatively, never polled, and dropped
  // whenever the project changes. usePoll replaces its data on every response,
  // so the live head cannot also hold them.
  const [older, setOlder] = useState<Session[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setOlder([]); setExhausted(false); }, [projectId]);

  const sessions = useMemo(() => {
    const byId = new Map<string, Session>();
    for (const session of [...(head.data ?? []), ...older]) if (!byId.has(session.id)) byId.set(session.id, session);
    return [...byId.values()].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }, [head.data, older]);

  const loadMore = async (): Promise<void> => {
    const oldest = sessions.at(-1);
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const page = await api.get<Session[]>(
        `/sessions?projectId=${encodeURIComponent(projectId)}&limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest.requestedAt)}`,
      );
      setOlder((current) => [...current, ...page]);
      if (page.length < PAGE_SIZE) setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  };

  if (projectId === "") return <Page><EmptyState>Select a project first.</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>Sessions</h1>
          <div className={PAGE_HEAD_SUBTITLE}>Every agent run in {project?.name ?? "this project"}, newest first</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacy" size="legacy" onClick={head.reload}><IconRefresh />Refresh</Button>
        </div>
      </div>

      <div className={STACK}>
        {head.missing ? <GapNotice endpoint="GET /sessions" what="会话列表" /> : null}
        {head.error === null || head.missing ? null : <ErrorNotice message={`${head.error.status} ${head.error.message}`} onRetry={head.reload} />}
        <Card flush>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead><TableHead>Agent</TableHead><TableHead>Task</TableHead>
                <TableHead>Runner</TableHead><TableHead>Duration</TableHead><TableHead>Status</TableHead><TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => <SessionRow key={session.id} session={session} />)}
            </TableBody>
          </Table>
          {sessions.length === 0
            ? <EmptyState>{head.loading ? "Loading…" : "No sessions yet. Agent tasks create a session when a run starts."}</EmptyState>
            : null}
        </Card>
        {sessions.length >= PAGE_SIZE && !exhausted ? (
          <div className={ROW}>
            <Button type="button" variant="legacy" size="legacy" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>
    </Page>
  );
};

/* ------------------------------------------------------------ the detail */

export const truncateBlock = (text: string): string =>
  text.length <= BLOCK_MAX
    ? text
    : `${text.slice(0, BLOCK_MAX)}\n… truncated, ${text.length - BLOCK_MAX} more characters`;

const TOOL_STATE_TONE: Record<string, string> = {
  running: "text-[color:var(--status-amber-fg)]",
  incomplete: "text-[color:var(--status-amber-fg)]",
  error: "text-[color:var(--destructive-fg)]",
  ok: "text-muted-foreground",
};

const ToolItem = ({ item }: { item: Extract<StreamItem, { kind: "tool" }> }): ReactNode => {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[color:var(--border-soft)] bg-card">
      <button type="button" className="flex w-full items-center gap-[8px] border-0 bg-transparent px-[14px] py-[9px] text-left text-[12px]" onClick={() => setOpen(!open)}>
        <span className="text-muted-foreground"><IconChevron open={open} /></span>
        <span className="text-foreground">{item.name}</span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">{item.primaryArg ?? ""}</span>
        <span className={cn("text-[11.5px]", TOOL_STATE_TONE[item.state] ?? "text-muted-foreground")}>{item.state}</span>
        <span className={MSG_TIME}>{formatDateTime(item.at)}</span>
      </button>
      {open ? (
        <div className="grid gap-[10px] px-[14px] pb-[12px]">
          {item.filePath === null ? null : (
            <div className="text-[12px] text-secondary-foreground [overflow-wrap:anywhere]">{item.filePath}</div>
          )}
          <div>
            <div className="mb-[5px] text-[11.5px] text-muted-foreground">Arguments</div>
            <div className={CODE_BLOCK}>{truncateBlock(JSON.stringify(item.args ?? null, null, 2))}</div>
          </div>
          <div>
            <div className="mb-[5px] text-[11.5px] text-muted-foreground">Result</div>
            <div className={CODE_BLOCK}>{item.result === null ? "—" : truncateBlock(item.result)}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const StreamItemView = ({ item }: { item: StreamItem }): ReactNode => {
  if (item.kind === "tool") return <ToolItem item={item} />;
  if (item.kind === "error") return <ErrorNotice message={item.message} />;
  return (
    <div className={MSG_CARD}>
      <div className={MSG_HEAD}>
        <span className="text-foreground">{item.kind === "final" ? "Result" : "Agent"}</span>
        <span className={MSG_TIME}>{formatDateTime(item.at)}</span>
      </div>
      <Markdown text={item.text} />
    </div>
  );
};

type DebugFilter = "all" | "provider" | "runner";

export const DebugEvents = ({ events }: { events: SessionEvent[] }): ReactNode => {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<DebugFilter>("all");
  // SessionEventSource is RUNNER | CLAUDE | CODEX | PI — "provider" means
  // "not RUNNER"; there is no literal provider value.
  const rows = events.filter((event) =>
    filter === "all" || (filter === "runner" ? event.source === "RUNNER" : event.source !== "RUNNER"));
  return (
    <Card
      title={<button type="button" className="flex items-center gap-[8px] border-0 bg-transparent p-0 text-[13.5px]" onClick={() => setOpen(!open)}>
        <span className="text-muted-foreground"><IconChevron open={open} /></span>Debug events
      </button>}
      extra={<span className={COUNT}>{events.length}</span>}
    >
      {open ? (
        <div className={STACK}>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[{ value: "all", label: "All" }, { value: "provider", label: "Provider" }, { value: "runner", label: "Runner" }]}
          />
          {rows.length === 0 ? <EmptyState>No events.</EmptyState> : (
            <div className={EVENT_LOG}>
              {rows.map((event) => (
                <div className={EVENT_ROW} key={event.id}>
                  <span className="text-[color:var(--faint)]">#{event.seq}</span>
                  <span className="overflow-hidden text-ellipsis text-primary">{event.type}</span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground" title={compact(event.payload, 2_000)}>{compact(event.payload)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
};

export const FilesTouched = ({ files, hint }: { files: Array<{ path: string; count: number }>; hint: string | null }): ReactNode => {
  const [open, setOpen] = useState(false);
  return (
    <Card
      title={<button type="button" className="flex items-center gap-[8px] border-0 bg-transparent p-0 text-[13.5px]" onClick={() => setOpen(!open)}>
        <span className="text-muted-foreground"><IconChevron open={open} /></span>Files touched
      </button>}
      extra={<span className={COUNT}>{files.length}</span>}
    >
      {open ? (
        <div className={STACK}>
          {hint === null ? null : <div className={HINT}>{hint}</div>}
          {files.length === 0 ? <EmptyState>No files recorded.</EmptyState> : (
            <div className="[&>*+*]:mt-[6px]">
              {files.map((file) => (
                <div className={ROW} key={file.path}>
                  <span className="min-w-0 flex-1 text-[12px] text-secondary-foreground [overflow-wrap:anywhere]">{file.path}</span>
                  <span className={COUNT}>{file.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
};

export const SessionDetailPage = ({ sessionId }: { sessionId: string }): ReactNode => {
  // Plain POLL_MS for the whole life of the page, terminal or not: it is one
  // small request on a page the operator is actively looking at, and late
  // metadata (endedAt, terminationReason, the backfilled token columns) must
  // not sit stale. Only the event stream stops.
  const { data: session, error, reload } = usePoll<Session>(`/sessions/${sessionId}`, POLL_MS);
  const terminal = session ? !isLive(session.executionStatus) : false;
  const stream = useEventStream(session?.runId ?? null, terminal);

  const scroller = useRef<HTMLDivElement | null>(null);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(0);
  /** The initial drain is history, not news, and it arrives over several pages.
   *  Without this the page opens claiming every event is new (seen in the
   *  browser against a real 771-event session: the stream rendered `98 new ↓`
   *  before the operator had done anything). */
  const primed = useRef(false);
  const drained = useRef(false);

  useEffect(() => {
    lastCount.current = 0;
    primed.current = false;
    drained.current = false;
    setUnseen(0);
  }, [sessionId]);

  // Keyed on the event count and the runner, not on array identity, so an empty
  // poll does not re-normalize 20 000 events.
  const runner = session?.runner ?? "CLAUDE";
  const { items, files, counts } = useMemo(
    () => normalize(stream.events, runner, terminal),
    [stream.events.length, runner, terminal],
  );

  const scrollToBottom = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    setUnseen(0);
  }, []);

  useEffect(() => {
    const added = items.length - lastCount.current;
    lastCount.current = items.length;
    if (added <= 0) return;
    const node = scroller.current;
    if (!node) return;
    if (!primed.current) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX;
    if (atBottom) scrollToBottom();
    else setUnseen((current) => current + added);
  }, [items.length, scrollToBottom]);

  // The drain is over on the `loading` true → false *transition*, not on a bare
  // `loading === false`: the hook starts with `loading` false while `runId` is
  // still null, so testing the value alone primes before a single event has
  // arrived. Declared after the effect above so the last history page still
  // counts as history. A live session then jumps to the newest output; a
  // finished one stays at the beginning to be read.
  useEffect(() => {
    if (stream.loading) { drained.current = true; return; }
    if (!drained.current || primed.current) return;
    primed.current = true;
    if (!terminal) scrollToBottom();
  }, [stream.loading, terminal, scrollToBottom]);

  if (error !== null && session === null) {
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  if (!session) return <Page><EmptyState>Loading…</EmptyState></Page>;

  const lifecycle = lifecycleStat(session.executionStatus);
  const repoUrl = repoWebUrl(session.run?.repo?.remoteUrl);
  const branch = session.run?.branch ?? null;
  const plus = stream.capped ? "+" : "";
  const fileHint = runner === "CODEX" && files.length === 0 && counts.toolCalls > 0
    ? "File tracking is not available for CODEX sessions."
    : null;

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/sessions" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{session.agent?.title ?? session.agentId}</h1>
        <SessionStatusPill status={session.executionStatus} />
        <Pill tone="grey">{session.runner}</Pill>
        <span className="flex-1" />
        <Button type="button" variant="legacy" size="legacy" onClick={() => { reload(); stream.reload(); }}><IconRefresh />Refresh</Button>
      </div>

      <div className={STACK}>
        {session.failureReason === null ? null : <ErrorNotice message={session.failureReason} />}
        {session.executionStatus === "WAITING_INBOX" && session.waitingOnMessageId !== null ? (
          <div className={ROW}>
            <Link to={`/inbox/${session.waitingOnMessageId}`}>This session is waiting on an Inbox answer ↗</Link>
          </div>
        ) : null}

        <div className={STAT_PILLS}>
          <span className={STAT_PILL}>
            <span className={cn(DOT, lifecycle.tone === "green" ? DOT_TONE.green : DOT_TONE.red)} />
            {lifecycle.label}
          </span>
          <span className={STAT_PILL}>{counts.messages}{plus} messages</span>
          <span className={STAT_PILL}>{counts.toolCalls}{plus} tool calls</span>
          <span className={STAT_PILL}>{counts.files}{plus} files</span>
          {session.totalTokens === null ? null : <span className={STAT_PILL}>{compactTokens(session.totalTokens)} tokens</span>}
          {session.costUsd === null ? null : <span className={STAT_PILL}>{money(session.costUsd)}</span>}
        </div>

        <Card title="Details">
          <KeyValue columns={3} items={[
            { k: "Task", v: session.task ? <Link to={`/tasks/${session.task.id}`}>{session.task.name}</Link> : session.goal ? <Link to={`/goals/${session.goal.id}`}>{session.goal.title}</Link> : "—" },
            { k: "Run", v: session.run ? (session.task ? <Link to={`/tasks/${session.task.id}`}>#{session.run.runNumber}</Link> : `#${session.run.runNumber}`) : "—" },
            { k: "Model", v: session.run?.model ?? "—" },
            { k: "Started", v: formatDateTime(session.startedAt ?? session.requestedAt) },
            { k: "Duration", v: duration(session.startedAt, session.endedAt) },
            {
              k: "Branch",
              v: branch === null ? "—" : repoUrl === null
                ? branch
                : <a href={`${repoUrl}/tree/${branch}`} target="_blank" rel="noreferrer">{branch}</a>,
            },
            { k: "Workspace", v: <span className="text-[11.5px]">{session.run?.workspacePath ?? "—"}</span> },
            { k: "Termination", v: session.terminationReason ?? "—" },
            ...(session.resumeAttempt > 0 ? [{ k: "Resume attempts", v: `${session.resumeAttempt}` }] : []),
          ]} />
        </Card>

        <Card title="Stream" extra={<span className={COUNT}>{items.length}{plus}</span>}>
          <div className={STACK}>
            {stream.capped ? (
              <div className={HINT}>Showing the first {stream.events.length} of {stream.total} events. Older events are in the database.</div>
            ) : null}
            {stream.error === null ? null : <ErrorNotice message={`${stream.error.status} ${stream.error.message}`} onRetry={stream.reload} />}
            {items.length === 0 ? <EmptyState>{stream.loading ? "Loading events…" : "No events yet."}</EmptyState> : (
              <div ref={scroller} className="max-h-[720px] overflow-auto [&>*+*]:mt-[12px]">
                {items.map((item) => <StreamItemView key={`${item.kind}-${item.id}`} item={item} />)}
              </div>
            )}
            {unseen > 0 ? (
              <button type="button" className="self-start border-0 bg-transparent p-0 text-[12px] text-primary" onClick={scrollToBottom}>
                {unseen} new ↓
              </button>
            ) : null}
          </div>
        </Card>

        <FilesTouched files={files} hint={fileHint} />
        <DebugEvents events={stream.events} />
      </div>
    </Page>
  );
};
