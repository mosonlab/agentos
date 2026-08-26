import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { compact, compactTokens, durationWithInboxWait, formatDateTime, formatT, money, repoWebUrl } from "../lib/format";
import { POLL_MS, usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { mergeBadge } from "../lib/merge-outcome";
import { Link, navigate } from "../lib/router";
import { useProjectScope } from "../lib/project";
import { normalize, type StreamItem } from "../lib/session-stream";
import { useEventStream } from "../lib/use-event-stream";
import type { MergeOutcome, RunnerKind, Session, SessionEvent, SessionExecutionStatus } from "../lib/types";
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
export const sessionPill = (
  status: SessionExecutionStatus,
  mergeOutcome?: MergeOutcome | null | undefined,
): { tone: PillTone; label: string } => {
  // §SF-1 first, and only for a mechanical merge that stopped: this session's
  // run ended SUCCEEDED and the sessions list would otherwise read Done.
  const badge = mergeBadge(mergeOutcome);
  if (badge) return { tone: badge.tone, label: formatT(badge.key) };
  if (status === "REQUESTED" || status === "PROVISIONING") return { tone: "grey", label: formatT("sessions.pill.queued") };
  if (status === "RUNNING") return { tone: "green", label: formatT("sessions.pill.running") };
  if (status === "WAITING_INBOX") return { tone: "amber", label: formatT("sessions.pill.waiting") };
  if (status === "SUCCEEDED") return { tone: "green", label: formatT("sessions.pill.done") };
  if (status === "CANCELLED") return { tone: "grey", label: formatT("sessions.pill.cancelled") };
  // The remaining three — FAILED, TIMED_OUT, LOST — read exactly as the shared
  // per-enum status table already spells them.
  return { tone: "red", label: formatT(`status.session.${status}`) };
};

/** The stat bar's own lifecycle slot: `● Live` while the session runs, and on a
 *  terminal session the same slot reads Done or Failed. The header's status pill
 *  is a different element and does not satisfy this. */
export const lifecycleStat = (
  status: SessionExecutionStatus,
  mergeOutcome?: MergeOutcome | null | undefined,
): { label: string; tone: "green" | "amber" | "red" } => {
  // The stat's two tones become three for the same §SF-1 reason: a stopped
  // merge is neither Done nor Failed, and calling it either of them is a lie.
  const badge = mergeBadge(mergeOutcome);
  if (badge) return { label: formatT(badge.key), tone: badge.tone };
  return isLive(status) ? { label: formatT("sessions.lifecycle.live"), tone: "green" }
    : status === "SUCCEEDED" ? { label: formatT("sessions.lifecycle.done"), tone: "green" }
      : { label: formatT("sessions.lifecycle.failed"), tone: "red" };
};

/** `Files touched` shows `(0)` whenever path extraction found nothing. For
 *  CLAUDE that means the session really touched no file — the mapping is
 *  verified against real captured stdout. For every other runner the argument
 *  keys are inferred (plan §11-G1/G2), so a zero is as likely to be a gap in the
 *  mapping as a fact about the session, and saying so is the honest rendering. */
export const fileTrackingHint = (runner: RunnerKind, fileCount: number, toolCalls: number): string | null =>
  runner !== "CLAUDE" && fileCount === 0 && toolCalls > 0
    ? formatT("sessions.files.hint", { runner })
    : null;

/** The notice is unconditional for `WAITING_INBOX`; only the link is conditional.
 *  A session parked before its message id lands is exactly the state where an
 *  operator most needs to be told why nothing is happening. */
export const WaitingNotice = ({ status, messageId }: { status: SessionExecutionStatus; messageId: string | null }): ReactNode => {
  const t = useT();
  if (status !== "WAITING_INBOX") return null;
  const text = t("sessions.waiting");
  return (
    <div className={ROW}>
      {messageId === null ? <span>{text}</span> : <Link to={`/inbox/${messageId}`}>{text} ↗</Link>}
    </div>
  );
};

const resultWord = (session: Session): string =>
  formatT(isLive(session.executionStatus) ? "sessions.result.inProgress"
    : session.executionStatus === "SUCCEEDED" ? "sessions.result.success" : "sessions.result.failed");

const SessionStatusPill = ({ status, mergeOutcome }: { status: SessionExecutionStatus; mergeOutcome?: MergeOutcome | null | undefined }): ReactNode => {
  const { tone, label } = sessionPill(status, mergeOutcome);
  return <Pill tone={tone}>{label}</Pill>;
};

/* -------------------------------------------------------------- the list */

export const SessionRow = ({ session }: { session: Session }): ReactNode => {
  const t = useT();
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
        <span className={TABLE_SUB}>{session.run ? t("sessions.row.run", { n: session.run.runNumber }) : session.id}</span>
      </TableCell>
      <TableCell><AgentChip agent={null} name={session.agent?.title ?? session.agentId} /></TableCell>
      <TableCell>{target}</TableCell>
      <TableCell><Pill tone="grey">{session.runner}</Pill></TableCell>
      <TableCell>{durationWithInboxWait(
        session.startedAt,
        session.endedAt,
        session.executionStatus === "WAITING_INBOX" || session.resumeAttempt > 0,
      )}</TableCell>
      <TableCell><SessionStatusPill status={session.executionStatus} mergeOutcome={session.mergeOutcome} /></TableCell>
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
  const [moreError, setMoreError] = useState<string | null>(null);
  const t = useT();
  useEffect(() => { setOlder([]); setExhausted(false); setMoreError(null); }, [projectId]);

  const sessions = useMemo(() => {
    const byId = new Map<string, Session>();
    for (const session of [...(head.data ?? []), ...older]) if (!byId.has(session.id)) byId.set(session.id, session);
    return [...byId.values()].sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }, [head.data, older]);

  const loadMore = async (): Promise<void> => {
    const oldest = sessions.at(-1);
    if (!oldest) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get<Session[]>(
        `/sessions?projectId=${encodeURIComponent(projectId)}&limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest.requestedAt)}`,
      );
      setOlder((current) => [...current, ...page]);
      if (page.length < PAGE_SIZE) setExhausted(true);
    } catch (error) {
      // Surfaced beside the button, which stays enabled as the retry. Without
      // this the failure is an unhandled rejection and the operator sees nothing.
      const failure = error as { status?: number; message?: string };
      setMoreError(failure.status === undefined ? String(failure.message ?? error) : `${failure.status} ${failure.message}`);
    } finally {
      setLoadingMore(false);
    }
  };

  if (projectId === "") return <Page><EmptyState>{t("common.selectProject")}</EmptyState></Page>;

  return (
    <Page className="text-foreground">
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("sessions.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("sessions.head.subtitle", { project: project?.name ?? t("tasks.head.thisProject") })}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacy" size="legacy" onClick={head.reload}><IconRefresh />{t("common.refresh")}</Button>
        </div>
      </div>

      <div className={STACK}>
        {head.missing ? <GapNotice endpoint="GET /sessions" what={t("sessions.gap.what")} /> : null}
        {head.error === null || head.missing ? null : <ErrorNotice message={`${head.error.status} ${head.error.message}`} onRetry={head.reload} />}
        <Card flush>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("sessions.table.started")}</TableHead><TableHead>{t("sessions.table.agent")}</TableHead><TableHead>{t("sessions.table.task")}</TableHead>
                <TableHead>{t("sessions.table.runner")}</TableHead><TableHead>{t("sessions.table.duration")}</TableHead><TableHead>{t("sessions.table.status")}</TableHead><TableHead>{t("sessions.table.result")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => <SessionRow key={session.id} session={session} />)}
            </TableBody>
          </Table>
          {sessions.length === 0
            ? <EmptyState>{t(head.loading ? "common.loading" : "sessions.empty")}</EmptyState>
            : null}
        </Card>
        {sessions.length >= PAGE_SIZE && !exhausted ? (
          <div className={ROW}>
            <Button type="button" variant="legacy" size="legacy" disabled={loadingMore} onClick={() => void loadMore()}>
              {t(loadingMore ? "common.loading" : "sessions.loadMore")}
            </Button>
            {moreError === null ? null : <ErrorNotice message={moreError} />}
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
    : `${text.slice(0, BLOCK_MAX)}\n${formatT("sessions.truncated", { n: text.length - BLOCK_MAX })}`;

const TOOL_STATE_TONE: Record<string, string> = {
  running: "text-[color:var(--status-amber-fg)]",
  incomplete: "text-[color:var(--status-amber-fg)]",
  error: "text-[color:var(--destructive-fg)]",
  ok: "text-muted-foreground",
};

const ToolItem = ({ item }: { item: Extract<StreamItem, { kind: "tool" }> }): ReactNode => {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <div className="rounded-lg border border-[color:var(--border-soft)] bg-card">
      <button type="button" className="flex w-full items-center gap-[8px] border-0 bg-transparent px-[14px] py-[9px] text-left text-[12px]" onClick={() => setOpen(!open)}>
        <span className="text-muted-foreground"><IconChevron open={open} /></span>
        <span className="text-foreground">{item.name}</span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">{item.primaryArg ?? ""}</span>
        <span className={cn("text-[11.5px]", TOOL_STATE_TONE[item.state] ?? "text-muted-foreground")}>{t(`sessions.tool.state.${item.state}`)}</span>
        <span className={MSG_TIME}>{formatDateTime(item.at)}</span>
      </button>
      {open ? (
        <div className="grid gap-[10px] px-[14px] pb-[12px]">
          {item.filePath === null ? null : (
            <div className="text-[12px] text-secondary-foreground [overflow-wrap:anywhere]">{item.filePath}</div>
          )}
          <div>
            <div className="mb-[5px] text-[11.5px] text-muted-foreground">{t("sessions.tool.arguments")}</div>
            <div className={CODE_BLOCK}>{truncateBlock(JSON.stringify(item.args ?? null, null, 2))}</div>
          </div>
          <div>
            <div className="mb-[5px] text-[11.5px] text-muted-foreground">{t("sessions.tool.result")}</div>
            <div className={CODE_BLOCK}>{item.result === null ? "—" : truncateBlock(item.result)}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export const StreamItemView = ({ item }: { item: StreamItem }): ReactNode => {
  const t = useT();
  if (item.kind === "tool") return <ToolItem item={item} />;
  if (item.kind === "error") return <ErrorNotice message={item.message} />;
  return (
    <div className={MSG_CARD}>
      <div className={MSG_HEAD}>
        <span className="text-foreground">{t(item.kind === "final" ? "sessions.stream.result" : "sessions.stream.agent")}</span>
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
  const t = useT();
  // SessionEventSource is RUNNER | CLAUDE | CODEX | PI — "provider" means
  // "not RUNNER"; there is no literal provider value.
  const rows = events.filter((event) =>
    filter === "all" || (filter === "runner" ? event.source === "RUNNER" : event.source !== "RUNNER"));
  return (
    <Card
      title={<button type="button" className="flex items-center gap-[8px] border-0 bg-transparent p-0 text-[13.5px]" onClick={() => setOpen(!open)}>
        <span className="text-muted-foreground"><IconChevron open={open} /></span>{t("sessions.debug.title")}
      </button>}
      extra={<span className={COUNT}>{events.length}</span>}
    >
      {open ? (
        <div className={STACK}>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[{ value: "all", label: t("sessions.debug.filter.all") }, { value: "provider", label: t("sessions.debug.filter.provider") }, { value: "runner", label: t("sessions.debug.filter.runner") }]}
          />
          {rows.length === 0 ? <EmptyState>{t("sessions.debug.empty")}</EmptyState> : (
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
  const t = useT();
  return (
    <Card
      title={<button type="button" className="flex items-center gap-[8px] border-0 bg-transparent p-0 text-[13.5px]" onClick={() => setOpen(!open)}>
        <span className="text-muted-foreground"><IconChevron open={open} /></span>{t("sessions.files.title")}
      </button>}
      extra={<span className={COUNT}>{files.length}</span>}
    >
      {open ? (
        <div className={STACK}>
          {hint === null ? null : <div className={HINT}>{hint}</div>}
          {files.length === 0 ? <EmptyState>{t("sessions.files.empty")}</EmptyState> : (
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
  const t = useT();
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
  if (!session) return <Page><EmptyState>{t("common.loading")}</EmptyState></Page>;

  const lifecycle = lifecycleStat(session.executionStatus, session.mergeOutcome);
  const repoUrl = repoWebUrl(session.run?.repo?.remoteUrl);
  const branch = session.run?.branch ?? null;
  const plus = stream.capped ? "+" : "";
  const fileHint = fileTrackingHint(runner, files.length, counts.toolCalls);

  return (
    <Page className="text-foreground">
      <div className={DETAIL_HEAD}>
        <Link to="/sessions" className={BACK_LINK}><IconArrowLeft /></Link>
        <h1 className={DETAIL_HEAD_H1}>{session.agent?.title ?? session.agentId}</h1>
        <SessionStatusPill status={session.executionStatus} mergeOutcome={session.mergeOutcome} />
        <Pill tone="grey">{session.runner}</Pill>
        <span className="flex-1" />
        <Button type="button" variant="legacy" size="legacy" onClick={() => { reload(); stream.reload(); }}><IconRefresh />{t("common.refresh")}</Button>
      </div>

      <div className={STACK}>
        {session.failureReason === null ? null : <ErrorNotice message={session.failureReason} />}
        <WaitingNotice status={session.executionStatus} messageId={session.waitingOnMessageId} />

        <div className={STAT_PILLS}>
          <span className={STAT_PILL}>
            <span className={cn(DOT, DOT_TONE[lifecycle.tone])} />
            {lifecycle.label}
          </span>
          <span className={STAT_PILL}>{t("sessions.stat.messages", { n: `${counts.messages}${plus}` })}</span>
          <span className={STAT_PILL}>{t("sessions.stat.toolCalls", { n: `${counts.toolCalls}${plus}` })}</span>
          <span className={STAT_PILL}>{t("sessions.stat.files", { n: `${counts.files}${plus}` })}</span>
          {session.totalTokens === null ? null : <span className={STAT_PILL}>{t("sessions.stat.tokens", { n: compactTokens(session.totalTokens) })}</span>}
          {session.costUsd === null ? null : <span className={STAT_PILL}>{money(session.costUsd)}</span>}
        </div>

        <Card title={t("sessions.detail.title")}>
          <KeyValue columns={3} items={[
            { k: t("sessions.detail.task"), v: session.task ? <Link to={`/tasks/${session.task.id}`}>{session.task.name}</Link> : session.goal ? <Link to={`/goals/${session.goal.id}`}>{session.goal.title}</Link> : "—" },
            { k: t("sessions.detail.run"), v: session.run ? (session.task ? <Link to={`/tasks/${session.task.id}`}>#{session.run.runNumber}</Link> : `#${session.run.runNumber}`) : "—" },
            { k: t("sessions.detail.model"), v: session.run?.model ?? "—" },
            { k: t("sessions.detail.started"), v: formatDateTime(session.startedAt ?? session.requestedAt) },
            { k: t("sessions.detail.duration"), v: durationWithInboxWait(
              session.startedAt,
              session.endedAt,
              session.executionStatus === "WAITING_INBOX" || session.resumeAttempt > 0,
            ) },
            {
              k: t("sessions.detail.branch"),
              v: branch === null ? "—" : repoUrl === null
                ? branch
                : <a href={`${repoUrl}/tree/${branch}`} target="_blank" rel="noreferrer">{branch}</a>,
            },
            { k: t("sessions.detail.workspace"), v: <span className="text-[11.5px]">{session.run?.workspacePath ?? "—"}</span> },
            { k: t("sessions.detail.termination"), v: session.terminationReason ?? "—" },
            ...(session.resumeAttempt > 0 ? [{ k: t("sessions.detail.resumeAttempts"), v: `${session.resumeAttempt}` }] : []),
          ]} />
        </Card>

        <Card title={t("sessions.stream.title")} extra={<span className={COUNT}>{items.length}{plus}</span>}>
          <div className={STACK}>
            {stream.capped ? (
              <div className={HINT}>{t("sessions.stream.capped", { shown: stream.events.length, total: stream.total })}</div>
            ) : null}
            {stream.error === null ? null : <ErrorNotice message={`${stream.error.status} ${stream.error.message}`} onRetry={stream.reload} />}
            {items.length === 0 ? <EmptyState>{t(stream.loading ? "sessions.stream.loading" : "sessions.stream.empty")}</EmptyState> : (
              <div ref={scroller} className="max-h-[720px] overflow-auto [&>*+*]:mt-[12px]">
                {items.map((item) => <StreamItemView key={`${item.kind}-${item.id}`} item={item} />)}
              </div>
            )}
            {unseen > 0 ? (
              <button type="button" className="self-start border-0 bg-transparent p-0 text-[12px] text-primary" onClick={scrollToBottom}>
                {t("sessions.stream.new", { n: unseen })}
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
