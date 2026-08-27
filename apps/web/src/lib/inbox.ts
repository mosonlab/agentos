import type { InboxMessage } from "./types";

/** A detached notification: an agent-authored text card that hangs off no task,
 *  goal, session, gate, or parent message. The control plane owns this exact
 *  predicate — `POST /inbox/messages/:id/close` refuses anything else, because
 *  closing such a card archives it without approving or resuming anything. The
 *  Inbox mirrors it to split cards that need a reply from cards that only
 *  report something, so the awaiting-reply count means what it says. */
export const isNotice = (message: InboxMessage): boolean =>
  message.from === "AGENT"
  && message.kind === "TEXT"
  && message.taskId === null
  && message.goalId === null
  && message.sessionId === null
  && message.gateTaskId === null
  && message.replyToMessageId === null;

/** Cards the operator still owes an answer to — the badge count and the Active
 *  lane. Notices are open too, but nobody is blocked on them. */
export const needsReply = (message: InboxMessage): boolean =>
  message.status === "OPEN" && !isNotice(message);

export type DeployNotice = {
  outcome: "success" | "failure";
  /** The revision production moved to, or `unknown` when the run failed before
   *  it resolved one. */
  revision: string;
  reason: string;
  at: string;
};

/* The body shape written by `scripts/deploy/quiet-window-deploy.mjs`:
 * `[auto-deploy] success: <from> -> <to>; reason=deployed`. A successful deploy
 * is archived on write and never notifies, so this line is the only place the
 * operator can see that production moved — and when. */
const DEPLOY_BODY = /^\[auto-deploy\] (success|failure): \S+ -> (\S+); reason=([^;]+)/;

export const latestDeploy = (messages: InboxMessage[]): DeployNotice | null => {
  /* `GET /inbox/messages` returns newest first, so the first match is current.
   * Sorting here anyway would hide a change in that contract, not survive it. */
  for (const message of messages) {
    const match = DEPLOY_BODY.exec(message.body);
    if (match === null) continue;
    /* All three groups are mandatory in the pattern, so a match has them; the
     * guard is what `noUncheckedIndexedAccess` needs to see. */
    const [, outcome = "", revision = "", reason = ""] = match;
    return {
      outcome: outcome === "success" ? "success" : "failure",
      revision: revision.slice(0, 7),
      reason,
      at: message.createdAt,
    };
  }
  return null;
};
