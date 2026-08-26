import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, RunStatus, type PrismaClient } from "@agentos/db";

import { defaultInboxResumeWindowMs, suspendForInbox } from "./inbox.js";

test("question persistence and WAITING_INBOX transition share one transaction", async () => {
  const calls: string[] = [];
  const fencedPredicates: Prisma.RunWhereInput[] = [];
  let sessionUpdate: Record<string, unknown> | undefined;
  const run = {
    id: "run-1", agentId: "agent-1", taskId: "task-1", goalId: null,
    session: { id: "session-1", providerConversationId: "provider-1" },
  };
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      if (query.join("?").includes('FROM "Run"')) {
        calls.push("lock.run");
        return [{ id: "run-1" }];
      }
      calls.push("lock.task");
      return [{ id: "task-1", archivedAt: null }];
    },
    run: {
      findFirst: async ({ where }: { where: Prisma.RunWhereInput }) => {
        calls.push("run.read");
        fencedPredicates.push(where);
        return run;
      },
      updateMany: async ({ where }: { where: Prisma.RunWhereInput }) => {
        calls.push("run.waiting");
        fencedPredicates.push(where);
        return { count: 1 };
      },
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
  assert.deepEqual(calls, [
    "lock.run", "run.read", "lock.task", "run.read",
    "thread", "question", "run.waiting", "session.waiting", "activity",
  ]);
  assert.equal(fencedPredicates.length, 3);
  for (const where of fencedPredicates) {
    assert.deepEqual(where.leaseExpiresAt, { gt: now });
    assert.deepEqual(where.status, { in: [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] });
  }
  assert.deepEqual(sessionUpdate?.resumableUntil, new Date(now.getTime() + defaultInboxResumeWindowMs));
});
