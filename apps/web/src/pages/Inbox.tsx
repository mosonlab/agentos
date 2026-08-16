import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { firstLine, formatDateTime, restLines, timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import { cn } from "../lib/utils";
import type { Agent, InboxMessage } from "../lib/types";
import { IconArrowLeft, IconQuestion, IconRobot, IconUser } from "../components/icons";
import {
  BACK_LINK, DETAIL_HEAD, LONG_TEXT, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE,
  PAGE_HEAD_TITLES, ROW, ROW_WRAP, STACK, STAT_PILL, TOOLBAR,
  Card, EmptyState, ErrorNotice, InboxPill, Markdown, Page, Pill, Segmented,
} from "../components/ui";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";

/** Both stacked lists — inbox rows and decision choices — are the same grid. */
const LIST = "grid grid-cols-[minmax(0,1fr)] gap-[10px]";

/** `.inboxItem` and `.choice` stay raw `<button>`s: they are full-width cards
 *  that happen to be clickable, not `.btn`s, so they take no Button variant
 *  (plan §2.5) and never had a box-shadow. */
const INBOX_ITEM = "flex w-full cursor-pointer gap-[14px] rounded-xl border border-border bg-card px-[16px] py-[13px] text-left hover:border-[color:var(--border-hover)]";
const CHOICE = "flex w-full items-start gap-[11px] rounded-lg border border-border bg-secondary px-[14px] py-[12px] text-left text-foreground hover:border-[color:var(--primary-soft)]";

const MSG_CARD = "rounded-xl border border-border bg-card px-[18px] py-[14px]";
const MSG_HEAD = "mb-[10px] flex items-center gap-[8px] text-[12.5px] text-secondary-foreground";
const MSG_TIME = "ml-auto text-[11.5px] text-[color:var(--faint)]";
/** `.msgCard + .msgCard { margin-top: 12px }` — every card but the first. */
const MSG_LIST = "[&>*+*]:mt-[12px]";

const useAgentNames = (): Map<string, string> => {
  const { projectId } = useProjectScope();
  const { data } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 30_000);
  return new Map((data ?? []).map((agent) => [agent.id, agent.title]));
};

const senderName = (message: InboxMessage, names: Map<string, string>): string =>
  // Unmatched inbound Feishu text lands here as a HUMAN message with no agent.
  message.from === "HUMAN" ? "You" : message.agentId === null ? "System" : names.get(message.agentId) ?? "Agent";

export const InboxPage = (): ReactNode => {
  const { data, loading, error, reload } = usePoll<InboxMessage[]>("/inbox/messages");
  const names = useAgentNames();
  const [filter, setFilter] = useState<"active" | "answered">("active");
  const messages = (data ?? []).filter((message) => (filter === "active" ? message.status === "OPEN" : message.status !== "OPEN"));

  return (
    <Page>
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>Inbox</h1>
          <div className={PAGE_HEAD_SUBTITLE}>Messages and updates from your agents</div>
        </div>
      </div>

      {/* Reference puts the Active/Archived switch on the left under the title
          (inboxes-list-t0885.jpg), not in the header action slot. */}
      <div className={TOOLBAR}>
        <Segmented
          accent
          value={filter}
          onChange={setFilter}
          options={[{ value: "active", label: "Active" }, { value: "answered", label: "Answered" }]}
        />
      </div>

      <div className={STACK}>
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        <div className={LIST}>
          {messages.map((message) => (
            <button type="button" className={INBOX_ITEM} key={message.id} onClick={() => navigate(`/inbox/${message.id}`)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-[8px] text-[12.5px] font-bold text-foreground">
                  {message.from === "HUMAN" || message.agentId === null ? <IconUser /> : <IconRobot />}
                  {senderName(message, names)}
                  {message.status === "OPEN" ? <InboxPill status={message.status} /> : null}
                  {message.gateTaskId === null ? null : <Pill tone="violet">Approval gate</Pill>}
                </div>
                <div className="mt-[5px] flex items-center gap-[8px] text-[13px] text-foreground">
                  {message.status === "OPEN" ? <span className="size-[7px] flex-none rounded-full bg-primary" /> : null}
                  {firstLine(message.body)}
                </div>
                <div className="mt-[4px] overflow-hidden text-[12px] text-ellipsis whitespace-nowrap text-muted-foreground">{restLines(message.body) || "—"}</div>
              </div>
              <div className="flex-none text-right text-[11.5px] text-muted-foreground">
                {timeAgo(message.createdAt)}
                <div className="mt-[5px] text-[color:var(--faint)]">{message.channel.toLowerCase()} · {message.deliveryStatus.toLowerCase()}</div>
              </div>
            </button>
          ))}
        </div>
        {messages.length === 0
          ? <EmptyState>{loading ? "Loading…" : filter === "active" ? "Nothing waiting on you." : "No answered messages yet."}</EmptyState>
          : null}
      </div>
    </Page>
  );
};

export const InboxThreadPage = ({ messageId }: { messageId: string }): ReactNode => {
  const { data, error, reload } = usePoll<InboxMessage[]>("/inbox/messages");
  const names = useAgentNames();
  const [reply, setReply] = useState("");
  const { pending, error: actionError, run } = useAction();

  if (error !== null && data === null) {
    return <Page><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></Page>;
  }
  const message = (data ?? []).find((candidate) => candidate.id === messageId) ?? null;
  if (!message) {
    return (
      <Page>
        <div className={DETAIL_HEAD}><Link to="/inbox" className={BACK_LINK}><IconArrowLeft />Back to Inbox</Link></div>
        <EmptyState>Message not found. The control plane only exposes agent-authored messages via <code>GET /inbox/messages</code>.</EmptyState>
      </Page>
    );
  }

  // Both channels post to the same endpoint; requestId makes double clicks and a
  // Feishu tap racing the web button idempotent (DECISIONS #16).
  const decide = (decision: string): void => {
    void run(async () => {
      await api.post(`/inbox/messages/${message.id}/decision`, { decision, requestId: `${message.id}:${decision}` });
      reload();
    });
  };

  const sendReply = (): void => {
    const body = reply.trim();
    if (body === "") return;
    void run(async () => {
      await api.post(`/inbox/messages/${message.id}/reply`, { body, requestId: `${message.id}:reply:${Date.now()}` });
      setReply("");
      reload();
    });
  };

  const choices = message.choices ?? [];
  const open = message.status === "OPEN";

  return (
    <Page>
      <div className={DETAIL_HEAD}>
        <Link to="/inbox" className={BACK_LINK}><IconArrowLeft />Back to Inbox</Link>
        <span className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground">updated {timeAgo(message.answeredAt ?? message.createdAt)}</span>
      </div>

      <div className={STACK}>
        <div className={ROW}>
          <h1 className="text-[18px]">{firstLine(message.body)}</h1>
          <InboxPill status={message.status} />
          {message.gateTaskId === null ? null : <Pill tone="violet">Approval gate</Pill>}
        </div>

        <div className={ROW_WRAP}>
          {message.taskId === null ? null : <Link to={`/tasks/${message.taskId}`} className={STAT_PILL}>Task {message.taskId.slice(-6)}</Link>}
          {message.goalId === null ? null : <Link to={`/goals/${message.goalId}`} className={STAT_PILL}>Goal {message.goalId.slice(-6)}</Link>}
          <span className={STAT_PILL}>{message.channel.toLowerCase()} · {message.deliveryStatus.toLowerCase()}</span>
          {message.deliveryAttempts > 0 ? <span className={STAT_PILL}>{message.deliveryAttempts} delivery attempts</span> : null}
        </div>

        {message.lastDeliveryError === null ? null : <ErrorNotice message={`Delivery error: ${message.lastDeliveryError}`} />}

        <div className={MSG_LIST}>
          <div className={MSG_CARD}>
            <div className={MSG_HEAD}>
              {message.agentId === null ? <IconUser /> : <IconRobot />}
              <span className="text-foreground">{senderName(message, names)}</span>
              <span className={MSG_TIME}>{formatDateTime(message.createdAt)}</span>
            </div>
            <Markdown text={message.body} />
          </div>

          {(message.replies ?? []).map((replyMessage) => (
            <div className={cn(MSG_CARD, "ml-[40px] bg-secondary")} key={replyMessage.id}>
              <div className={MSG_HEAD}>
                <IconUser />
                <span className="text-foreground">You (web)</span>
                <span className={MSG_TIME}>{formatDateTime(replyMessage.createdAt)}</span>
              </div>
              <Markdown text={replyMessage.body} />
            </div>
          ))}
          {(message.replies ?? []).length === 0 ? (message.decisions ?? []).map((decision) => (
            <div className={cn(MSG_CARD, "ml-[40px] bg-secondary")} key={decision.id}>
              <div className={MSG_HEAD}>
                <IconUser />
                <span className="text-foreground">{decision.actorOpenId === "web-operator" ? "You (web)" : decision.actorOpenId ?? "Operator"}</span>
                <span className={MSG_TIME}>{formatDateTime(decision.createdAt)}</span>
              </div>
              <div className={LONG_TEXT}>{decision.decision}</div>
            </div>
          )) : null}
        </div>

        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {open ? (
          <Card>
            <div className={STACK}>
              <div className="flex items-center gap-[10px] rounded-lg border border-[color:var(--status-amber-line)] bg-[color-mix(in_srgb,var(--status-amber-fg)_5%,transparent)] px-[14px] py-[11px] text-[12.5px] text-[color:var(--status-amber-fg)]"><IconQuestion />The agent is waiting for your reply before continuing.</div>
              {choices.length > 0 ? (
                <div className={LIST}>
                  {choices.map((option) => (
                    <button type="button" key={option.id} className={CHOICE} disabled={pending} onClick={() => decide(option.id)}>
                      <span className="mt-[2px] size-[15px] flex-none rounded-full border border-[color:var(--radio-border)]" />
                      <span className="flex-1 text-[12.5px]">{option.label}<span className="mt-[3px] block">{option.id}</span></span>
                    </button>
                  ))}
                </div>
              ) : message.gateTaskId !== null ? (
                <div className={ROW}>
                  <Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" disabled={pending} onClick={() => decide("approve")}>Approve</Button>
                  <Button type="button" variant="legacyDanger" size="legacy" className="shadow-none" disabled={pending} onClick={() => decide("reject")}>Reject</Button>
                </div>
              ) : (
                <>
                  <Textarea rows={5} className="shadow-none" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Write a reply…" />
                  <div className={ROW}><span className="flex-1" /><Button type="button" variant="legacyPrimary" size="legacy" className="shadow-none" disabled={pending || reply.trim() === ""} onClick={sendReply}>Reply</Button></div>
                </>
              )}
            </div>
          </Card>
        ) : (
          <Card>
            <div className="text-muted-foreground">
              Answered {timeAgo(message.answeredAt)}
              {message.selectedChoiceId === null ? "" : ` · selected “${message.selectedChoiceId}”`}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
};
