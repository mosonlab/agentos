import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@agentos/db";

import { defaultInboxResumeWindowMs, suspendForInbox } from "./inbox.js";

test("question persistence and WAITING_INBOX transition share one transaction", async () => {
  const calls: string[] = [];
  let sessionUpdate: Record<string, unknown> | undefined;
  const tx = {
    run: {
      findFirst: async () => ({
        id: "run-1", agentId: "agent-1", taskId: "task-1", goalId: null,
        session: { id: "session-1", providerConversationId: "provider-1" },
      }),
      updateMany: async () => { calls.push("run.waiting"); return { count: 1 }; },
    },
    inboxThread: { upsert: async () => { calls.push("thread"); return { id: "thread-1" }; } },
    inboxMessage: { create: async () => { calls.push("question"); return { id: "question-1" }; } },
    session: { update: async ({ data }: { data: Record<string, unknown> }) => { calls.push("session.waiting"); sessionUpdate = data; return {}; } },
    taskActivity: { create: async () => { calls.push("activity"); return {}; } },
  };
  let transactionCount = 0;
  const db = { $transaction: async (operation: (value: typeof tx) => Promise<unknown>) => {
    transactionCount += 1;
    return operation(tx);
  } } as unknown as PrismaClient;
  const now = new Date("2026-08-16T07:00:00.000Z");
  await suspendForInbox(db, {
    runId: "run-1", fencingToken: "fence-1", requestId: "request-1", body: "Ship it?", chatId: "chat-1",
    choices: [{ id: "approve", label: "批准" }, { id: "reject", label: "拒绝" }],
  }, now);
  assert.equal(transactionCount, 1);
  assert.deepEqual(calls, ["thread", "question", "run.waiting", "session.waiting", "activity"]);
  assert.deepEqual(sessionUpdate?.resumableUntil, new Date(now.getTime() + defaultInboxResumeWindowMs));
});
