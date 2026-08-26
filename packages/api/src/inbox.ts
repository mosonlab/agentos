import {
  InboxDeliveryStatus,
  InboxKind,
  InboxSender,
  InboxStatus,
  Prisma,
  RunStatus,
  SessionExecutionStatus,
  type PrismaClient,
} from "@agentos/db";

import { lockTaskMutationRows } from "./task-write.js";
import {
  type FenceRefusalResponse,
  fencedRunWhere,
  isFenceRefusalResponse,
  type RunFence,
  withFencedRun,
} from "./run-fence.js";

export const defaultInboxResumeWindowMs = 7 * 24 * 60 * 60 * 1_000;

export type SuspendQuestion = {
  runId: string;
  fencingToken: string;
  requestId: string;
  body: string;
  choices: Array<{ id: string; label: string }>;
  chatId: string;
  resumableUntil?: Date | null;
};

export type SupersedeInboxMessageResult =
  | { closed: true; duplicate: false; requestId: string }
  | { closed: false; duplicate: true; requestId: string }
  | { error: string; code: 404 | 409 };

export class InboxRunFenceRefusal extends Error {
  readonly refusal: FenceRefusalResponse;

  constructor(refusal: FenceRefusalResponse) {
    super(`Run is not resumable: ${refusal.reason}`);
    this.name = "InboxRunFenceRefusal";
    this.refusal = refusal;
  }
}

/**
 * Closes one historical task-linked Inbox message after the operator has
 * archived its task. The Task row is the lifecycle mutex shared by archive and
 * unarchive, so the archived check remains true until this Inbox-only write
 * commits. The message body, decisions, replies, and every task-owned audit
 * row are deliberately untouched.
 */
export const supersedeTaskInboxMessage = async (
  db: PrismaClient,
  messageId: string,
  requestId: string,
): Promise<SupersedeInboxMessageResult> => db.$transaction(async (tx) => {
  const initial = await tx.inboxMessage.findUnique({
    where: { id: messageId },
    select: { status: true, from: true, taskId: true, gateTaskId: true, replyToMessageId: true },
  });
  if (!initial) return { error: "Inbox message not found", code: 404 };
  if (initial.taskId === null) {
    return { error: "Only a task-linked Inbox message can be superseded", code: 409 };
  }
  if (initial.from !== InboxSender.AGENT || initial.replyToMessageId !== null) {
    return { error: "Only a top-level agent Inbox message can be superseded", code: 409 };
  }
  if (initial.gateTaskId !== null) {
    return { error: "Only a non-gate Inbox message can be superseded", code: 409 };
  }
  // A prior successful supersession is safe to acknowledge without touching
  // the Task row again. This keeps retries idempotent even if the operator
  // later restores the task for inspection.
  if (initial.status === InboxStatus.CLOSED) {
    return { closed: false, duplicate: true, requestId };
  }

  // Archive and unarchive both take this lock before reading or writing
  // archivedAt. Do not replace this with an unlocked task read: that would
  // allow an unarchive to commit between the check and the Inbox update.
  const task = await lockTaskMutationRows(tx, initial.taskId);
  if (!task) return { error: "Inbox message task not found", code: 404 };
  if (task.archivedAt === null) {
    return { error: "Only an Inbox message for an archived task can be superseded", code: 409 };
  }

  // Re-read the mutable status after the Task lock. The conditional update
  // below is the message CAS: concurrent decisions or closes may win, but this
  // action never turns an ineligible or non-OPEN message into CLOSED.
  const message = await tx.inboxMessage.findUnique({
    where: { id: messageId },
    select: { status: true },
  });
  if (!message) return { error: "Inbox message not found", code: 404 };
  if (message.status === InboxStatus.CLOSED) {
    return { closed: false, duplicate: true, requestId };
  }
  if (message.status !== InboxStatus.OPEN) {
    return { error: "Only an open Inbox message can be superseded", code: 409 };
  }

  const closed = await tx.inboxMessage.updateMany({
    where: {
      id: messageId,
      taskId: task.id,
      gateTaskId: null,
      status: InboxStatus.OPEN,
    },
    // Superseded is not an answer. CLOSED removes the active Inbox noise while
    // leaving answeredAt null and preserving the absence of a decision.
    data: { status: InboxStatus.CLOSED },
  });
  if (closed.count === 1) {
    await tx.taskActivity.create({ data: {
      taskId: task.id,
      actorType: "operator",
      body: "Inbox message superseded",
      metadata: { inboxMessageId: messageId, requestId },
    } });
    return { closed: true, duplicate: false, requestId };
  }

  const current = await tx.inboxMessage.findUnique({ where: { id: messageId }, select: { status: true } });
  if (current?.status === InboxStatus.CLOSED) return { closed: false, duplicate: true, requestId };
  return { error: "Inbox message changed before it could be superseded", code: 409 };
}, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

/** Creates the durable outbox item and releases the Run lease in one commit. */
export const suspendForInbox = async (db: PrismaClient, input: SuspendQuestion, now = new Date()) => {
  const fence: RunFence = {
    runId: input.runId,
    fencingToken: input.fencingToken,
    at: now,
    statuses: [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING],
  };
  const result = await db.$transaction((tx) => withFencedRun(tx, fence, {
    id: true,
    agentId: true,
    taskId: true,
    goalId: true,
    session: { select: { id: true, providerConversationId: true } },
  }, async (run) => {
    const resumableUntil = input.resumableUntil === undefined
      ? new Date(now.getTime() + defaultInboxResumeWindowMs)
      : input.resumableUntil;
    if (!run?.session?.providerConversationId) throw new Error("Run is not resumable: provider conversation ID is unavailable");
    const thread = await tx.inboxThread.upsert({
      where: { channel_externalChatId_sessionId: { channel: "FEISHU", externalChatId: input.chatId, sessionId: run.session.id } },
      create: { channel: "FEISHU", externalChatId: input.chatId, sessionId: run.session.id, taskId: run.taskId, goalId: run.goalId },
      update: {},
    });
    const question = await tx.inboxMessage.create({ data: {
      from: InboxSender.AGENT,
      agentId: run.agentId,
      sessionId: run.session.id,
      taskId: run.taskId,
      goalId: run.goalId,
      threadId: thread.id,
      kind: input.choices.length > 0 ? InboxKind.MULTIPLE_CHOICE : InboxKind.TEXT,
      body: input.body,
      choices: input.choices as Prisma.InputJsonValue,
      dedupeKey: `session:${run.session.id}:question:${input.requestId}`,
      deliveryStatus: InboxDeliveryStatus.PENDING,
    } });
    const suspended = await tx.run.updateMany({
      where: fencedRunWhere(fence),
      data: {
        status: RunStatus.WAITING_INBOX,
        leaseExpiresAt: null,
        sessionTokenRevokedAt: now,
        workspaceRetained: true,
        inFlightTool: Prisma.JsonNull,
      },
    });
    if (suspended.count !== 1) throw new Error("Run changed while suspending for Inbox");
    await tx.session.update({ where: { id: run.session.id }, data: {
      executionStatus: SessionExecutionStatus.WAITING_INBOX,
      waitingOnMessageId: question.id,
      resumableUntil,
      runtimeHandle: null,
    } });
    if (run.taskId) await tx.taskActivity.create({ data: {
      taskId: run.taskId,
      actorType: "agent",
      actorId: run.agentId,
      body: "Run suspended waiting for Inbox reply",
      metadata: { inboxMessageId: question.id },
    } });
    return question;
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (isFenceRefusalResponse(result)) throw new InboxRunFenceRefusal(result);
  return result;
};
