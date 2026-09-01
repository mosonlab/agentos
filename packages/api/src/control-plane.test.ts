import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";

const withOperator = async (callback: () => Promise<void>): Promise<void> => {
  const previousToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "control-plane-test-operator";
  try {
    await callback();
  } finally {
    if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousToken;
  }
};

const request = async (database: PrismaClient, path: string, init?: RequestInit): Promise<Response> => createApp(database).request(path, {
  ...init,
  headers: {
    Authorization: "Bearer control-plane-test-operator",
    "Content-Type": "application/json",
    ...init?.headers,
  },
});

test("GET /agents/:id requests every capability binding used by the frontend", async () => {
  await withOperator(async () => {
    let query: Record<string, unknown> | undefined;
    const database = { agent: { findUnique: async (arguments_: Record<string, unknown>) => {
      query = arguments_;
      return { id: "agent-1", repoAccess: [], skills: [], mcpConnections: [], secretGrants: [], filesystemGrants: [], collaborators: [] };
    } } } as unknown as PrismaClient;
    const response = await request(database, "/agents/agent-1");
    assert.equal(response.status, 200);
    const include = query?.include as Record<string, unknown>;
    assert.deepEqual(Object.keys(include).sort(), [
      "collaborators", "environment", "filesystemGrants", "mcpConnections", "repoAccess", "secretGrants", "skills",
    ]);
  });
});

test("agent capability route inventory keeps supported forms and unregisters redundant forms", async () => {
  await withOperator(async () => {
    const app = createApp({} as PrismaClient);
    const inventory = app.routes.map(({ method, path }) => `${method} ${path}`);
    const removed = [
      "GET /agents/:agentId/collaborators",
      "GET /agents/:agentId/skills",
      "GET /agents/:agentId/mcp-connections",
      "POST /agents/:agentId/skills/:skillId",
      "POST /agents/:agentId/mcp-connections/:connectionId",
    ];
    const retained = [
      "GET /agents/:agentId",
      "POST /agents/:agentId/collaborators",
      "DELETE /agents/:agentId/collaborators/:allowedAgentId",
      "POST /agents/:agentId/skills",
      "DELETE /agents/:agentId/skills/:skillId",
      "POST /agents/:agentId/mcp-connections",
      "DELETE /agents/:agentId/mcp-connections/:connectionId",
    ];
    assert.deepEqual(inventory.filter((route) => removed.includes(route)), []);
    for (const route of retained) assert.ok(inventory.includes(route), `${route} is not registered`);

    for (const [method, path] of removed.map((route) => route.split(" ") as [string, string])) {
      const response = await app.request(path, {
        method,
        headers: {
          Authorization: "Bearer control-plane-test-operator",
          "Content-Type": "application/json",
        },
        ...(method === "POST" ? { body: JSON.stringify({ skillId: "skill-1", mcpConnectionId: "connection-1" }) } : {}),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "Not found" });
    }
  });
});

test("Secrets encrypt writes and never return plaintext or ciphertext", async () => {
  await withOperator(async () => {
    const previousKey = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
    process.env.AGENTOS_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    let persisted: Record<string, unknown> | undefined;
    const database = { secret: { create: async ({ data }: { data: Record<string, unknown> }) => {
      persisted = data;
      return { id: "secret-1", name: data.name, purpose: data.purpose, description: null, ciphertextVersion: 1, keyId: "v1", rotatedAt: null, disabledAt: null };
    } } } as unknown as PrismaClient;
    try {
      const response = await request(database, "/secrets", {
        method: "POST",
        body: JSON.stringify({ name: "TOKEN", purpose: "ENV", value: "plain-value" }),
      });
      assert.equal(response.status, 201);
      assert.match(String(persisted?.encryptedValue), /^v1:/);
      assert.notEqual(persisted?.encryptedValue, "plain-value");
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.value, undefined);
      assert.equal(body.encryptedValue, undefined);
    } finally {
      if (previousKey === undefined) delete process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
      else process.env.AGENTOS_SECRET_ENCRYPTION_KEY = previousKey;
    }
  });
});

test("an approval gate card carries the producing step's task, so the board can show the full artifact", async () => {
  await withOperator(async () => {
    // The card's own taskId is the gate step; the artifact belongs to the step
    // whose run opened it, reachable only through the card's session.
    const database = {
      inboxMessage: { findMany: async () => [
        { id: "gate-1", from: "AGENT", kind: "MULTIPLE_CHOICE", replyToMessageId: null, gateTaskId: "gate-task", taskId: "gate-task", session: { taskId: "producing-task" } },
        { id: "plain-1", from: "AGENT", kind: "TEXT", replyToMessageId: null, gateTaskId: null, taskId: "some-task", session: { taskId: "some-task" } },
      ] },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const response = await request(database, "/inbox/messages");
    assert.equal(response.status, 200);
    const messages = await response.json() as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.artifactTaskId, "producing-task");
    // A question that is not a gate has no artifact to offer, and the raw
    // session relation never reaches the client either way.
    assert.equal(messages[1]?.artifactTaskId, null);
    assert.equal(messages[0]?.session, undefined);
    // A gate owes a decision; a plain text card attached to a finished task
    // owes nothing, which is what lets the Inbox offer to archive it.
    assert.equal(messages[0]?.dismissible, false);
    assert.equal(messages[1]?.dismissible, true);
  });
});

test("Inbox list applies project scope and returns stored human replies", async () => {
  await withOperator(async () => {
    let query: Record<string, unknown> | undefined;
    const database = {
      inboxMessage: { findMany: async (arguments_: Record<string, unknown>) => {
        query = arguments_;
        return [{ id: "question-1", from: "AGENT", replies: [{ id: "reply-1", from: "HUMAN", body: "continue" }] }];
      } },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const response = await request(database, "/inbox/messages?projectId=project-1");
    assert.equal(response.status, 200);
    const messages = await response.json() as Array<{ replies: Array<{ from: string }> }>;
    assert.equal(messages[0]?.replies[0]?.from, "HUMAN");
    const where = query?.where as { replyToMessageId: null; OR: unknown[] };
    assert.equal(where.replyToMessageId, null);
    assert.equal(where.OR.length, 5);
    assert.deepEqual(where.OR[4], { agentId: null, taskId: null, goalId: null, sessionId: null });
  });
});
