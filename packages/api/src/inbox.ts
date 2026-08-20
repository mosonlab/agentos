import { InboxDeliveryStatus, InboxKind, InboxSender, Prisma, RunStatus, SessionExecutionStatus, type PrismaClient } from "@agentos/db";

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

/** Creates the durable outbox item and releases the Run lease in one commit. */
export const suspendForInbox = async (db: PrismaClient, input: SuspendQuestion, now = new Date()) =>
  db.$transaction(async (tx) => {
    const resumableUntil = input.resumableUntil === undefined
      ? new Date(now.getTime() + defaultInboxResumeWindowMs)
      : input.resumableUntil;
    const run = await tx.run.findFirst({
      where: {
        id: input.runId,
        fencingToken: input.fencingToken,
        leaseExpiresAt: { gt: now },
        status: { in: [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] },
      },
      include: { session: true },
    });
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
      where: { id: run.id, fencingToken: input.fencingToken, status: { in: [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] } },
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
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
