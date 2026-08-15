import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@agentos/db";

import { eventIdentity, processFeishuEvent, type FeishuEnvelope } from "./events.js";

const envelope: FeishuEnvelope = {
  header: { event_id: "evt-1", event_type: "card.action.trigger" },
  event: { action: { value: { inboxMessageId: "question-1", choiceId: "approve" } }, operator: { open_id: "ou-1" } },
};

test("event_id is the stable Feishu dedupe identity", () => {
  assert.deepEqual(eventIdentity(envelope), { eventId: "evt-1", eventType: "card.action.trigger" });
});

test("duplicate external event is acknowledged without a second resume", async () => {
  let transactions = 0;
  const db = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      if (transactions === 2) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
      return operation(tx);
    },
  } as unknown as PrismaClient;
  let resumeWrites = 0;
  const tx = {
    inboxExternalEvent: { create: async () => ({}), update: async () => ({}) },
    inboxMessage: {
      findUnique: async () => ({
        id: "question-1", agentId: "agent-1", sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status: "WAITING_INBOX" } },
      }),
      updateMany: async () => ({ count: 1 }),
      create: async () => ({ id: "reply-1" }),
    },
    inboxDecision: { create: async () => ({}) },
    run: { updateMany: async () => { resumeWrites += 1; return { count: 1 }; } },
    session: { update: async () => ({}) },
  };
  // Replace the first transaction callback's tx without requiring a database.
  (db.$transaction as unknown as (operation: (value: unknown) => Promise<unknown>) => Promise<unknown>) = async (operation) => {
    transactions += 1;
    if (transactions === 2) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    return operation(tx);
  };
  assert.equal((await processFeishuEvent(db, envelope)).resumed, true);
  assert.deepEqual(await processFeishuEvent(db, envelope), { duplicate: true, resumed: false });
  assert.equal(resumeWrites, 1);
});
