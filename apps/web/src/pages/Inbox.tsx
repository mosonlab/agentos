import { type ReactNode, useState } from "react";

import { api } from "../lib/api";
import { firstLine, formatDateTime, restLines, timeAgo } from "../lib/format";
import { useAction, usePoll } from "../lib/hooks";
import { useProjectScope } from "../lib/project";
import { Link, navigate } from "../lib/router";
import type { Agent, InboxMessage } from "../lib/types";
import { IconArrowLeft, IconQuestion, IconRobot, IconUser } from "../components/icons";
import { Card, EmptyState, ErrorNotice, InboxPill, Markdown, Pill, Segmented } from "../components/ui";

const useAgentNames = (): Map<string, string> => {
  const { projectId } = useProjectScope();
  const { data } = usePoll<Agent[]>(projectId === "" ? null : `/projects/${projectId}/agents`, 30_000);
  return new Map((data ?? []).map((agent) => [agent.id, agent.title]));
};

const senderName = (message: InboxMessage, names: Map<string, string>): string =>
  message.agentId === null ? "System" : names.get(message.agentId) ?? "Agent";

export const InboxPage = (): ReactNode => {
  const { data, loading, error, reload } = usePoll<InboxMessage[]>("/inbox/messages");
  const names = useAgentNames();
  const [filter, setFilter] = useState<"active" | "answered">("active");
  const messages = (data ?? []).filter((message) => (filter === "active" ? message.status === "OPEN" : message.status !== "OPEN"));

  return (
    <div className="page">
      <div className="pageHead">
        <div className="titles">
          <h1>Inbox</h1>
          <div className="subtitle">Messages and updates from your agents</div>
        </div>
      </div>

      {/* Reference puts the Active/Archived switch on the left under the title
          (inboxes-list-t0885.jpg), not in the header action slot. */}
      <div className="toolbar">
        <Segmented
          accent
          value={filter}
          onChange={setFilter}
          options={[{ value: "active", label: "Active" }, { value: "answered", label: "Answered" }]}
        />
      </div>

      <div className="stack">
        {error === null ? null : <ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} />}
        <div className="inboxList">
          {messages.map((message) => (
            <button type="button" className="inboxItem" key={message.id} onClick={() => navigate(`/inbox/${message.id}`)}>
              <div className="body">
                <div className="sender">
                  {message.agentId === null ? <IconUser /> : <IconRobot />}
                  {senderName(message, names)}
                  {message.status === "OPEN" ? <InboxPill status={message.status} /> : null}
                  {message.gateTaskId === null ? null : <Pill tone="violet">Approval gate</Pill>}
                </div>
                <div className="title">
                  {message.status === "OPEN" ? <span className="unreadDot" /> : null}
                  {firstLine(message.body)}
                </div>
                <div className="summary">{restLines(message.body) || "—"}</div>
              </div>
              <div className="side">
                {timeAgo(message.createdAt)}
                <div className="src">{message.channel.toLowerCase()} · {message.deliveryStatus.toLowerCase()}</div>
              </div>
            </button>
          ))}
        </div>
        {messages.length === 0
          ? <EmptyState>{loading ? "Loading…" : filter === "active" ? "Nothing waiting on you." : "No answered messages yet."}</EmptyState>
          : null}
      </div>
    </div>
  );
};

export const InboxThreadPage = ({ messageId }: { messageId: string }): ReactNode => {
  const { data, error, reload } = usePoll<InboxMessage[]>("/inbox/messages");
  const names = useAgentNames();
  const [reply, setReply] = useState("");
  const { pending, error: actionError, run } = useAction();

  if (error !== null && data === null) {
    return <div className="page"><ErrorNotice message={`${error.status} ${error.message}`} onRetry={reload} /></div>;
  }
  const message = (data ?? []).find((candidate) => candidate.id === messageId) ?? null;
  if (!message) {
    return (
      <div className="page">
        <div className="detailHead"><Link to="/inbox" className="backLink"><IconArrowLeft />Back to Inbox</Link></div>
        <EmptyState>Message not found. The control plane only exposes agent-authored messages via <code>GET /inbox/messages</code>.</EmptyState>
      </div>
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
    <div className="page">
      <div className="detailHead">
        <Link to="/inbox" className="backLink"><IconArrowLeft />Back to Inbox</Link>
        <span className="spacer" />
        <span className="dim small">updated {timeAgo(message.answeredAt ?? message.createdAt)}</span>
      </div>

      <div className="stack">
        <div className="row">
          <h1 style={{ fontSize: 18 }}>{firstLine(message.body)}</h1>
          <InboxPill status={message.status} />
          {message.gateTaskId === null ? null : <Pill tone="violet">Approval gate</Pill>}
        </div>

        <div className="rowWrap">
          {message.taskId === null ? null : <Link to={`/tasks/${message.taskId}`} className="statPill">Task {message.taskId.slice(-6)}</Link>}
          {message.goalId === null ? null : <Link to={`/goals/${message.goalId}`} className="statPill">Goal {message.goalId.slice(-6)}</Link>}
          <span className="statPill">{message.channel.toLowerCase()} · {message.deliveryStatus.toLowerCase()}</span>
          {message.deliveryAttempts > 0 ? <span className="statPill">{message.deliveryAttempts} delivery attempts</span> : null}
        </div>

        {message.lastDeliveryError === null ? null : <ErrorNotice message={`Delivery error: ${message.lastDeliveryError}`} />}

        <div>
          <div className="msgCard">
            <div className="msgHead">
              {message.agentId === null ? <IconUser /> : <IconRobot />}
              <span className="strong">{senderName(message, names)}</span>
              <span className="time">{formatDateTime(message.createdAt)}</span>
            </div>
            <Markdown text={message.body} />
          </div>

          {(message.replies ?? []).map((replyMessage) => (
            <div className="msgCard mine" key={replyMessage.id}>
              <div className="msgHead">
                <IconUser />
                <span className="strong">You (web)</span>
                <span className="time">{formatDateTime(replyMessage.createdAt)}</span>
              </div>
              <Markdown text={replyMessage.body} />
            </div>
          ))}
          {(message.replies ?? []).length === 0 ? (message.decisions ?? []).map((decision) => (
            <div className="msgCard mine" key={decision.id}>
              <div className="msgHead">
                <IconUser />
                <span className="strong">{decision.actorOpenId === "web-operator" ? "You (web)" : decision.actorOpenId ?? "Operator"}</span>
                <span className="time">{formatDateTime(decision.createdAt)}</span>
              </div>
              <div className="longText">{decision.decision}</div>
            </div>
          )) : null}
        </div>

        {actionError === null ? null : <ErrorNotice message={actionError} />}

        {open ? (
          <Card>
            <div className="stack">
              <div className="waitBar"><IconQuestion />The agent is waiting for your reply before continuing.</div>
              {choices.length > 0 ? (
                <div className="choiceList">
                  {choices.map((option) => (
                    <button type="button" key={option.id} className="choice" disabled={pending} onClick={() => decide(option.id)}>
                      <span className="radio" />
                      <span className="label">{option.label}<span className="hint">{option.id}</span></span>
                    </button>
                  ))}
                </div>
              ) : message.gateTaskId !== null ? (
                <div className="row">
                  <button type="button" className="btn primary" disabled={pending} onClick={() => decide("approve")}>Approve</button>
                  <button type="button" className="btn danger" disabled={pending} onClick={() => decide("reject")}>Reject</button>
                </div>
              ) : (
                <>
                  <textarea rows={5} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Write a reply…" />
                  <div className="row"><span className="spacer" /><button type="button" className="btn primary" disabled={pending || reply.trim() === ""} onClick={sendReply}>Reply</button></div>
                </>
              )}
            </div>
          </Card>
        ) : (
          <Card>
            <div className="dim">
              Answered {timeAgo(message.answeredAt)}
              {message.selectedChoiceId === null ? "" : ` · selected “${message.selectedChoiceId}”`}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
};
