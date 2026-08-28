import assert from "node:assert/strict";
import test from "node:test";

import { InboxDeliveryStatus, InboxStatus, type PrismaClient } from "@anneal/db";

import { deliverPending } from "./delivery.js";

test("delivery requires an OPEN message both when selecting and when claiming it", async () => {
  let sent = false;
  const db = {
    inboxMessage: {
      findMany: async (query: { where: { status?: string } }) => {
        assert.equal(query.where.status, InboxStatus.OPEN);
        return [{
          id: "message-1",
          status: InboxStatus.CLOSED,
          deliveryStatus: InboxDeliveryStatus.PENDING,
          deliveryAttempts: 0,
          body: "closed before delivery",
          choices: [],
          taskId: "task-1",
          thread: { externalChatId: "chat-1" },
        }];
      },
      updateMany: async (query: { where: { status?: string } }) => {
        assert.equal(query.where.status, InboxStatus.OPEN);
        return { count: 0 };
      },
    },
  } as unknown as PrismaClient;

  const result = await deliverPending(db, {
    send: async () => {
      sent = true;
      return { messageId: "external-1" };
    },
  });

  assert.deepEqual(result, { delivered: 0, failed: 0 });
  assert.equal(sent, false);
});
