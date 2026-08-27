import type { InboxMessage } from "./types";

/** Cards the operator still owes an answer to — the badge count and the Active
 *  lane. A notification is open too, but nobody is blocked on it: the control
 *  plane decides which is which and says so in `dismissible`, the same rule
 *  `POST /inbox/messages/:id/close` enforces. */
export const needsReply = (message: InboxMessage): boolean =>
  message.status === "OPEN" && !message.dismissible;

/** Open, and safe to archive without approving or resuming anything. */
export const isNotice = (message: InboxMessage): boolean =>
  message.status === "OPEN" && message.dismissible;

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
