import { applyInboxDecisionTx, InboxSender, InboxStatus, Prisma, type PrismaClient } from "@agentos/db";

export type FeishuEnvelope = {
  header?: { event_id?: string; event_type?: string };
  event?: Record<string, unknown>;
};

type EventResult = { duplicate: boolean; resumed: boolean; messageId?: string };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

const textContent = (message: Record<string, unknown>): string | null => {
  const raw = string(message.content);
  if (!raw) return null;
  try { return string(record(JSON.parse(raw))?.text); } catch { return raw; }
};

export const eventIdentity = (envelope: FeishuEnvelope): { eventId: string; eventType: string } => {
  const event = envelope.event ?? {};
  const message = record(event.message);
  const action = record(event.action);
  const eventType = envelope.header?.event_type ?? (action ? "card.action.trigger" : "im.message.receive_v1");
  const eventId = envelope.header?.event_id ?? string(message?.message_id) ?? string(event.token);
  if (!eventId) throw new Error("Feishu event is missing event_id");
  return { eventId, eventType };
};

export const processFeishuEvent = async (db: PrismaClient, envelope: FeishuEnvelope, now = new Date()): Promise<EventResult> => {
  const { eventId, eventType } = eventIdentity(envelope);
  try {
    return await db.$transaction(async (tx) => {
      await tx.inboxExternalEvent.create({ data: {
        channel: "FEISHU", externalEventId: eventId, eventType,
        payload: envelope as Prisma.InputJsonValue,
      } });
      const event = envelope.event ?? {};
      const message = record(event.message);
      const action = record(event.action);
      const actionValue = record(action?.value);
      const explicitQuestionId = string(actionValue?.inboxMessageId);
      const externalReplyId = string(message?.parent_id) ?? string(message?.root_id);
      const chatId = string(message?.chat_id) ?? string(record(event.context)?.open_chat_id);
      const candidates = explicitQuestionId || externalReplyId || !chatId ? [] : await tx.inboxMessage.findMany({
        where: { thread: { externalChatId: chatId }, from: InboxSender.AGENT, status: InboxStatus.OPEN },
        include: { session: { include: { run: true } } },
        orderBy: { createdAt: "desc" },
        take: 2,
      });
      if (candidates.length > 1) throw new Error("Reply is ambiguous; reply to the specific Feishu card message");
      const question = explicitQuestionId
        ? await tx.inboxMessage.findUnique({ where: { id: explicitQuestionId }, include: { session: { include: { run: true } } } })
        : externalReplyId
          ? await tx.inboxMessage.findUnique({ where: { externalMessageId: externalReplyId }, include: { session: { include: { run: true } } } })
          : candidates[0] ?? null;
      if (!question?.session?.run) throw new Error("No matching Inbox question");
      const choiceId = string(actionValue?.choiceId);
      const answer = choiceId ?? (message ? textContent(message) : null);
      if (!answer) throw new Error("Inbox reply is empty");
      const result = await applyInboxDecisionTx(tx, {
        inboxMessageId: question.id,
        externalEventId: eventId,
        decision: answer,
        actorOpenId: string(record(event.operator)?.open_id) ?? string(record(record(event.sender)?.sender_id)?.open_id),
        externalMessageId: string(message?.message_id),
      }, now);
      await tx.inboxExternalEvent.update({
        where: { channel_externalEventId: { channel: "FEISHU", externalEventId: eventId } }, data: { processedAt: now },
      });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { duplicate: true, resumed: false };
    }
    throw error;
  }
};
