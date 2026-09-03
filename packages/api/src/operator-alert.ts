import { InboxStatus, Prisma } from "@anneal/db";

export const hasOpenOperatorAlert = async (
  tx: Prisma.TransactionClient,
  dedupeKeyPrefix: string,
): Promise<boolean> => await tx.inboxMessage.findFirst({
  where: {
    status: InboxStatus.OPEN,
    dedupeKey: { startsWith: dedupeKeyPrefix },
  },
  select: { id: true },
}) !== null;

export const openOperatorAlert = async (
  tx: Prisma.TransactionClient,
  input: { body: string; dedupeKey: string },
): Promise<void> => {
  const chatId = process.env.FEISHU_DEFAULT_CHAT_ID;
  const thread = chatId
    ? await tx.inboxThread.findFirst({
      where: { channel: "FEISHU", externalChatId: chatId, sessionId: null },
    }) ?? await tx.inboxThread.create({
      data: { channel: "FEISHU", externalChatId: chatId },
    })
    : null;
  await tx.inboxMessage.create({
    data: {
      from: "AGENT",
      kind: "TEXT",
      body: input.body,
      dedupeKey: input.dedupeKey,
      ...(thread ? { threadId: thread.id } : {}),
    },
  });
};
