import {
  applyInboxDecision,
  InboxKind,
  InboxSender,
  InboxStatus,
  MAX_APPROVAL_GATE_NOTE_CHARS,
  parseStopQuestionKey,
  Prisma,
  type PrismaClient,
} from "@anneal/db";
import { z } from "zod";

import { supersedeTaskInboxMessage } from "../inbox.js";
import {
  id,
  readJson,
  refusal,
  refusalJson,
  type RouteApp,
  type RouteDeps,
  validated,
} from "./support.js";

/**
 * An approval gate's `taskId` is the gate step itself; the artifact the approver
 * is being asked about was produced by the *previous* step, whose run opened the
 * card. That producing task needs no stored column: the card carries the
 * producing run's `sessionId`, and `Session.taskId` is that run's task
 * (`app.ts` writes `candidate.taskId` when the session is created). Exposing it
 * as `artifactTaskId` is what lets the board render the full artifact next to
 * the decision instead of the truncated preview the card body carries for
 * Feishu — and it works for cards opened before this field existed.
 */
const withArtifactTask = <T extends { gateTaskId: string | null; session: { taskId: string | null } | null }>(
  message: T,
): Omit<T, "session"> & { artifactTaskId: string | null } => {
  const { session, ...rest } = message;
  return { ...rest, artifactTaskId: message.gateTaskId === null ? null : session?.taskId ?? null };
};

/**
 * Whether an Inbox card can accept an operator's free-text answer. This is a
 * read-model property rather than a browser policy: only an open question
 * which can resume a suspended agent session, or an open approval gate, may
 * offer the text field. Stop questions are machine-state prompts and must
 * remain choice-only even when their body happens to be text.
 */
const acceptsFreeText = (message: {
  id: string;
  status: InboxStatus;
  from: InboxSender;
  kind: InboxKind;
  gateTaskId: string | null;
  dedupeKey: string | null;
}, waiting: ReadonlySet<string>): boolean => {
  if (message.status !== InboxStatus.OPEN || parseStopQuestionKey(message.dedupeKey)) return false;
  if (message.from !== InboxSender.AGENT) return false;
  if (message.gateTaskId !== null) return true;
  return (message.kind === InboxKind.TEXT || message.kind === InboxKind.MULTIPLE_CHOICE) && waiting.has(message.id);
};

/**
 * A card nobody is blocked on, so archiving it strands nothing.
 *
 * The rule used to be "attached to no task, goal, or session", which was a
 * proxy for that and misfired on the common case: a merge-tail stop report is
 * attached to the task it happened on, yet its run ended long ago and no reply
 * would resume anything. What actually blocks is a suspended session pointing
 * at the card through `Session.waitingOnMessageId` (`inbox.ts`'s
 * `suspendForInbox`), or a decision the operator still owes — a choice list or
 * an approval gate.
 */
const withDismissible = <T extends {
  id: string; from: InboxSender; kind: InboxKind; gateTaskId: string | null; replyToMessageId: string | null;
}>(message: T, blocked: ReadonlySet<string>): T & { dismissible: boolean } => ({
  ...message,
  dismissible: message.from === "AGENT"
    && message.kind === InboxKind.TEXT
    && message.gateTaskId === null
    && message.replyToMessageId === null
    && !blocked.has(message.id),
});

const withInboxReadModel = <T extends {
  id: string;
  status: InboxStatus;
  from: InboxSender;
  kind: InboxKind;
  gateTaskId: string | null;
  dedupeKey: string | null;
  replyToMessageId: string | null;
  session: { taskId: string | null } | null;
}>(message: T, blocked: ReadonlySet<string>) => withDismissible({
  ...withArtifactTask(message),
  acceptsFreeText: acceptsFreeText(message, blocked),
}, blocked);

/** The cards a suspended session will resume on. A session only ever waits on a
 *  message its own suspension created, so this set cannot grow for a card that
 *  already exists — which is why the close route may check it before its
 *  conditional update rather than inside one statement. */
const blockedMessageIds = async (db: PrismaClient, ids: string[]): Promise<ReadonlySet<string>> => {
  if (ids.length === 0) return new Set();
  const waiting = await db.session.findMany({
    where: { waitingOnMessageId: { in: ids } },
    select: { waitingOnMessageId: true },
  });
  return new Set(waiting.flatMap((session) => session.waitingOnMessageId === null ? [] : [session.waitingOnMessageId]));
};

const inboxDecisionInput = z.object({
  decision: z.string().trim().min(1).max(8000),
  requestId: z.string().trim().min(1).max(200),
  // Keep note's shape check in the route so malformed notes receive the same
  // named refusal as blank and overlong notes, rather than the app-wide
  // generic Zod validation response.
  note: z.unknown().optional(),
});
const inboxReplyInput = z.object({
  body: z.string().trim().min(1).max(8000),
  requestId: z.string().trim().min(1).max(200),
});
const inboxCloseInput = z.object({
  requestId: z.string().trim().min(1).max(200),
});

/**
 * Project scope for Inbox rows. Relation ids are nullable because deleting
 * the related history leaves the message behind; once all four nullable
 * relations are gone, the row is global and remains visible in every
 * project's Inbox.
 */
const inboxProjectPredicate = (projectId: string): Prisma.InboxMessageWhereInput => ({
  OR: [
    { agent: { projectId } },
    { task: { projectId } },
    { goal: { projectId } },
    { session: { projectId } },
    { agentId: null, taskId: null, goalId: null, sessionId: null },
  ],
});

export const registerInboxRoutes = (app: RouteApp, { db }: RouteDeps): void => {
  app.get("/inbox/messages/summary", async (context) => {
    const projectId = context.req.query("projectId");
    const messages = await db.inboxMessage.findMany({
      where: {
        status: InboxStatus.OPEN,
        replyToMessageId: null,
        ...(projectId ? inboxProjectPredicate(projectId) : {}),
      },
      select: { id: true, status: true, from: true, kind: true, gateTaskId: true, replyToMessageId: true },
    });
    const blocked = await blockedMessageIds(db, messages.map((message) => message.id));
    const needsReply = messages.filter((message) => (
      message.status === InboxStatus.OPEN && !withDismissible(message, blocked).dismissible
    )).length;
    return validated(context, { needsReply });
  });
  app.get("/inbox/messages", async (context) => {
    const projectId = context.req.query("projectId");
    const messages = await db.inboxMessage.findMany({
      where: {
        replyToMessageId: null,
        ...(projectId ? inboxProjectPredicate(projectId) : {}),
      },
      include: { decisions: true, replies: { orderBy: { createdAt: "asc" } }, session: { select: { taskId: true } } },
      orderBy: { createdAt: "desc" },
    });
    const blocked = await blockedMessageIds(db, messages.map((message) => message.id));
    return validated(context, messages.map((message) => withInboxReadModel(message, blocked)));
  });
  app.get("/inbox/messages/:messageId", async (context) => {
    const message = await db.inboxMessage.findUnique({
      where: { id: id.parse(context.req.param("messageId")) },
      include: {
        decisions: true,
        replies: { orderBy: { createdAt: "asc" } },
        replyTo: true,
        session: { select: { taskId: true } },
      },
    });
    if (!message) return context.json({ error: "Inbox message not found" }, 404);
    return context.json(withInboxReadModel(message, await blockedMessageIds(db, [message.id])));
  });
  app.post("/inbox/messages/:messageId/decision", async (context) => {
    const input = await readJson(context.req.raw, inboxDecisionInput);
    let note: string | undefined;
    if (input.note !== undefined) {
      const parsedNote = typeof input.note === "string" ? input.note.trim() : null;
      if (parsedNote === null || parsedNote.length === 0 || parsedNote.length > MAX_APPROVAL_GATE_NOTE_CHARS) {
        return refusalJson(context, refusal(
          "invalid-request",
          "Inbox decision note must be a string between 1 and 8000 characters after trimming",
          { code: "inbox-note-invalid" },
        ));
      }
      note = parsedNote;
    }
    const body = {
      decision: input.decision,
      requestId: input.requestId,
      ...(note === undefined ? {} : { note }),
    };
    const messageId = id.parse(context.req.param("messageId"));
    // The DB transaction repeats this invariant while claiming the card. This
    // early read gives non-gate note usage its 400 refusal before a decision can
    // be interpreted as a choice or a free-text reply. gateTaskId is immutable,
    // so the read cannot race a gate/non-gate change.
    if (body.note !== undefined) {
      const message = await db.inboxMessage.findUnique({ where: { id: messageId }, select: { gateTaskId: true } });
      if (message?.gateTaskId === null) {
        return refusalJson(context, refusal(
          "invalid-request",
          "A decision note is only supported for an approval-gate card",
          { code: "inbox-note-not-allowed" },
        ));
      }
    }
    try {
      const result = await applyInboxDecision(db, {
        inboxMessageId: messageId,
        externalEventId: `web:${body.requestId}`,
        decision: body.decision,
        actorOpenId: "web-operator",
        ...(body.note === undefined ? {} : { note: body.note }),
      });
      return context.json(result, result.duplicate ? 200 : 201);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return context.json({ duplicate: true, resumed: false });
      }
      throw error;
    }
  });
  app.post("/inbox/messages/:messageId/reply", async (context) => {
    const body = await readJson(context.req.raw, inboxReplyInput);
    try {
      const result = await applyInboxDecision(db, {
        inboxMessageId: id.parse(context.req.param("messageId")),
        externalEventId: `web:${body.requestId}`,
        decision: body.body,
        actorOpenId: "web-operator",
        allowFreeText: true,
      });
      return context.json(result, result.duplicate ? 200 : 201);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return context.json({ duplicate: true, resumed: false });
      }
      throw error;
    }
  });
  app.post("/inbox/messages/:messageId/close", async (context) => {
    const body = await readJson(context.req.raw, inboxCloseInput);
    const messageId = id.parse(context.req.param("messageId"));
    const message = await db.inboxMessage.findUnique({
      where: { id: messageId },
      select: { id: true, status: true, from: true, kind: true, gateTaskId: true, replyToMessageId: true },
    });
    if (!message) return context.json({ error: "Inbox message not found" }, 404);
    if (!withDismissible(message, await blockedMessageIds(db, [messageId])).dismissible) {
      return context.json({ error: "Only a notification no run is waiting on can be closed without a decision" }, 409);
    }
    if (message.status === InboxStatus.CLOSED) {
      return context.json({ closed: false, duplicate: true, requestId: body.requestId });
    }
    if (message.status !== InboxStatus.OPEN) {
      return context.json({ error: "Only an open notification can be closed" }, 409);
    }
    const closed = await db.inboxMessage.updateMany({
      where: {
        id: messageId, status: InboxStatus.OPEN, from: "AGENT", kind: "TEXT",
        gateTaskId: null, replyToMessageId: null,
      },
      data: { status: InboxStatus.CLOSED, answeredAt: new Date() },
    });
    if (closed.count !== 1) {
      const current = await db.inboxMessage.findUnique({ where: { id: messageId }, select: { status: true } });
      if (current?.status === InboxStatus.CLOSED) {
        return context.json({ closed: false, duplicate: true, requestId: body.requestId });
      }
      return context.json({ error: "Inbox message changed before it could be closed" }, 409);
    }
    return context.json({ closed: true, duplicate: false, requestId: body.requestId });
  });
  app.post("/inbox/messages/:messageId/supersede", async (context) => {
    // principalMayAccess already restricts this operator action, but keep the
    // check at the handler boundary so the lifecycle operation stays explicit
    // if route middleware is ever rearranged.
    if (context.get("principal").kind !== "operator") return context.json({ error: "Forbidden for principal" }, 403);
    const body = await readJson(context.req.raw, inboxCloseInput);
    const result = await supersedeTaskInboxMessage(
      db,
      id.parse(context.req.param("messageId")),
      body.requestId,
    );
    if ("message" in result) return refusalJson(context, result);
    return context.json(result);
  });
};
