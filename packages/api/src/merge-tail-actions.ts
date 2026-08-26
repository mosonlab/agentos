import { createHash } from "node:crypto";

import { Prisma } from "@agentos/db";

type DbTx = Prisma.TransactionClient;

export const openMergeTailStopNotice = async (
  tx: DbTx,
  input: { taskId: string; agentId: string; sessionId?: string; reason: string },
): Promise<void> => {
  await tx.inboxMessage.create({ data: {
    from: "AGENT",
    agentId: input.agentId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    taskId: input.taskId,
    kind: "TEXT",
    body: `Autonomous merge tail stopped: ${input.reason}`,
    dedupeKey: `merge-tail-stop:${input.taskId}:${createHash("sha256").update(input.reason).digest("hex")}`,
  } });
};
