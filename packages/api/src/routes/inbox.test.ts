import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  RunStatus,
  RunnerPreference,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";
import { lockedAgent, withTokens } from "./test-support.js";

/* A merge-tail stop report: agent-authored text, attached to the task it
 * happened on, and nothing resumes on a reply. It is the shape the Inbox is
 * full of, and the old "attached to nothing" rule refused to close it. */
const stopReport = {
  id: "message-1", status: "OPEN", from: "AGENT", kind: "TEXT", gateTaskId: null, replyToMessageId: null,
};

const closeRequest = async (app: ReturnType<typeof createApp>, messageId: string): Promise<Response> =>
  await app.request(`/inbox/messages/${messageId}/close`, {
    method: "POST",
    headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: `close-${messageId}` }),
  });

test("Inbox summary counts only open messages that need a reply and is not swallowed by the message-id route", async () => {
  await withTokens(async () => {
    const messages = [
      { id: "choice", status: "OPEN", from: "AGENT", kind: "CHOICE", gateTaskId: null, replyToMessageId: null },
      { id: "waiting-text", status: "OPEN", from: "AGENT", kind: "TEXT", gateTaskId: null, replyToMessageId: null },
      { id: "notice", status: "OPEN", from: "AGENT", kind: "TEXT", gateTaskId: null, replyToMessageId: null },
      { id: "closed", status: "CLOSED", from: "AGENT", kind: "CHOICE", gateTaskId: null, replyToMessageId: null },
    ];
    const database = {
      inboxMessage: {
        findMany: async () => messages,
        findUnique: async () => { throw new Error("summary was routed as a message id"); },
      },
      session: { findMany: async () => [{ waitingOnMessageId: "waiting-text" }] },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/inbox/messages/summary", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { needsReply: 2 });
  });
});

test("Inbox summary returns zero when every open card is a dismissible notice", async () => {
  await withTokens(async () => {
    const database = {
      inboxMessage: { findMany: async () => [
        { id: "notice", status: "OPEN", from: "AGENT", kind: "TEXT", gateTaskId: null, replyToMessageId: null },
      ] },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/inbox/messages/summary", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.deepEqual(await response.json(), { needsReply: 0 });
  });
});

test("Inbox read models expose the server-owned free-text capability", async () => {
  await withTokens(async () => {
    const messages = [
      {
        id: "waiting-choice", status: "OPEN", from: "AGENT", kind: "MULTIPLE_CHOICE",
        gateTaskId: null, replyToMessageId: null, dedupeKey: "question:choice",
        session: { taskId: "task-1", waitingOnMessageId: "waiting-choice" },
      },
      {
        id: "open-gate", status: "OPEN", from: "AGENT", kind: "MULTIPLE_CHOICE",
        gateTaskId: "gate-task", replyToMessageId: null, dedupeKey: "gate:1",
        session: { taskId: "producing-task", waitingOnMessageId: null },
      },
      {
        id: "stop-question", status: "OPEN", from: "AGENT", kind: "TEXT",
        gateTaskId: null, replyToMessageId: null, dedupeKey: "merge-stop:stop-1",
        session: { taskId: "task-1", waitingOnMessageId: "stop-question" },
      },
      {
        id: "answered", status: "ANSWERED", from: "AGENT", kind: "TEXT",
        gateTaskId: null, replyToMessageId: null, dedupeKey: "question:answered",
        session: { taskId: "task-1", waitingOnMessageId: "answered" },
      },
      {
        id: "detached", status: "OPEN", from: "AGENT", kind: "TEXT",
        gateTaskId: null, replyToMessageId: null, dedupeKey: "notification:1", session: null,
      },
    ];
    const database = {
      inboxMessage: {
        findMany: async () => messages,
        findUnique: async () => messages[0],
      },
      session: { findMany: async () => [
        { waitingOnMessageId: "waiting-choice" },
        { waitingOnMessageId: "stop-question" },
        { waitingOnMessageId: "answered" },
      ] },
    } as unknown as PrismaClient;

    const list = await createApp(database).request("/inbox/messages", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(list.status, 200);
    const listMessages = await list.json() as Array<{ id: string; acceptsFreeText: boolean }>;
    assert.deepEqual(
      Object.fromEntries(listMessages.map((message) => [message.id, message.acceptsFreeText])),
      {
        "waiting-choice": true,
        "open-gate": true,
        "stop-question": false,
        answered: false,
        detached: false,
      },
    );

    const single = await createApp(database).request("/inbox/messages/waiting-choice", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(single.status, 200);
    assert.equal((await single.json() as { acceptsFreeText: boolean }).acceptsFreeText, true);
  });
});

test("decision notes are rejected with a named 400 for non-gate cards", async () => {
  await withTokens(async () => {
    let transactionStarted = false;
    const database = {
      inboxMessage: {
        findUnique: async () => ({ gateTaskId: null }),
      },
      $transaction: async () => { transactionStarted = true; throw new Error("must not apply"); },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/inbox/messages/question-1/decision", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "choice-1", note: " operator context ", requestId: "request-1" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "A decision note is only supported for an approval-gate card",
      code: "inbox-note-not-allowed",
    });
    assert.equal(transactionStarted, false);
  });
});

test("operator can close a notification attached to a task when no run waits on it", async () => {
  await withTokens(async () => {
    let updateWhere: unknown;
    const database = {
      inboxMessage: {
        findUnique: async () => stopReport,
        updateMany: async ({ where }: { where: unknown }) => { updateWhere = where; return { count: 1 }; },
      },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const response = await closeRequest(createApp(database), "message-1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { closed: true, duplicate: false, requestId: "close-message-1" });
    // The conditional update guards what the row itself can prove; the waiting
    // session is checked above it, and cannot appear for an existing card.
    assert.deepEqual(updateWhere, {
      id: "message-1", status: "OPEN", from: "AGENT", kind: "TEXT",
      gateTaskId: null, replyToMessageId: null,
    });
  });
});

test("operator cannot close a gate, nor a card a suspended run resumes on", async () => {
  await withTokens(async () => {
    const gateDatabase = {
      inboxMessage: { findUnique: async () => ({ ...stopReport, gateTaskId: "gate-1" }) },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const gate = await closeRequest(createApp(gateDatabase), "message-2");
    assert.equal(gate.status, 409);
    assert.match(String((await gate.json() as { error: string }).error), /no run is waiting on/u);

    const waitingDatabase = {
      inboxMessage: { findUnique: async () => stopReport },
      session: { findMany: async () => [{ waitingOnMessageId: "message-1" }] },
    } as unknown as PrismaClient;
    const waiting = await closeRequest(createApp(waitingDatabase), "message-1");
    assert.equal(waiting.status, 409);
    assert.match(String((await waiting.json() as { error: string }).error), /no run is waiting on/u);
  });
});

test("archived successor errors from gate approve and reject map to named 409 responses", async () => {
  await withTokens(async () => {
    const gateResponse = async (decision: "approve" | "reject") => {
      const targetId = decision === "approve" ? "successor-1" : "gate-1";
      const executable = {
        id: targetId,
        projectId: "project-1",
        name: decision === "approve" ? "Successor step" : "Redo step",
        description: "work",
        chainId: "chain-1",
        chainIndex: decision === "approve" ? 2 : 1,
        chainLayer: decision === "approve" ? 2 : 1,
        status: "TODO",
        assigneeType: "AGENT",
        assigneeAgentId: "agent-archived",
        repoId: "repo-1",
        templateId: "template-1",
        templateStepId: null,
        targetBranch: "main",
        updatedAt: new Date(),
        maxDurationMin: 120,
        stallTimeoutMin: 10,
        maxSessionsPerTask: 3,
        approvalGate: false,
        archivedAt: null,
        failureReason: null,
        runs: [],
        assigneeAgent: {
          id: "agent-archived",
          name: "Archived Gate Agent",
          archivedAt: new Date(),
          model: "model",
          runnerPreference: RunnerPreference.CLAUDE,
          foundationalPrompt: "foundation",
          rolePrompt: "role",
        },
        repo: { id: "repo-1", defaultBranch: "main" },
        templateStep: null,
      };
      const gateTask = {
        id: "gate-1",
        projectId: "project-1",
        name: "Gate",
        chainId: "chain-1",
        chainIndex: 1,
        chainLayer: 1,
        status: "REVIEW",
        archivedAt: null,
        approvalGate: true,
        assigneeType: "AGENT",
        assigneeAgentId: "agent-archived",
        repoId: "repo-1",
        templateId: "template-1",
        templateStepId: null,
        templateStep: null,
        runs: [],
        assigneeAgent: executable.assigneeAgent,
      };
      const tx = {
        // The reject path locks the redo row before queueing it. This task is
        // unarchived — the archived *assignee* is what must produce the 409.
        $queryRaw: async (_strings: unknown, taskId: string) => [{ id: taskId, archivedAt: null }],
        inboxMessage: {
          findUnique: async () => ({
            id: "message-1", kind: "MULTIPLE_CHOICE", gateTaskId: gateTask.id,
            agentId: "agent-1", sessionId: "session-1", taskId: gateTask.id,
            goalId: null, threadId: "thread-1",
            session: { id: "session-1", run: { id: "run-1", status: RunStatus.SUCCEEDED } },
            gateTask,
          }),
          updateMany: async () => ({ count: 1 }),
          create: async () => ({ id: "reply-1" }),
        },
        inboxDecision: { create: async () => ({}) },
        task: {
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            if (where.id === gateTask.id && typeof data.status === "string") gateTask.status = data.status;
            return {};
          },
          findUniqueOrThrow: async () => executable,
          // Both approval and rejection resolve the target through the real
          // layered chain rows; no linked-list relation is available.
          findUnique: async () => executable,
          findFirst: async () => null,
          findMany: async () => decision === "approve" ? [gateTask, executable] : [],
          updateMany: async () => ({ count: 1 }),
        },
        taskActivity: { create: async () => ({}) },
        chainControl: { findMany: async () => [] },
        agent: { findUnique: async () => lockedAgent(executable.assigneeAgent) },
        run: { create: async () => { throw new Error("must not create"); } },
      };
      const database = {
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      } as unknown as PrismaClient;
      return createApp(database).request("/inbox/messages/message-1/decision", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ decision, requestId: `request-${decision}` }),
      });
    };

    for (const decision of ["approve", "reject"] as const) {
      const response = await gateResponse(decision);
      assert.equal(response.status, 409);
      assert.match(String((await response.json() as { error: string }).error), /Archived Gate Agent.*archived/);
    }
  });
});
