import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@agentos/db";

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

test("Inbox list applies project scope and returns stored human replies", async () => {
  await withOperator(async () => {
    let query: Record<string, unknown> | undefined;
    const database = { inboxMessage: { findMany: async (arguments_: Record<string, unknown>) => {
      query = arguments_;
      return [{ id: "question-1", from: "AGENT", replies: [{ id: "reply-1", from: "HUMAN", body: "continue" }] }];
    } } } as unknown as PrismaClient;
    const response = await request(database, "/inbox/messages?projectId=project-1");
    assert.equal(response.status, 200);
    const messages = await response.json() as Array<{ replies: Array<{ from: string }> }>;
    assert.equal(messages[0]?.replies[0]?.from, "HUMAN");
    const where = query?.where as { replyToMessageId: null; OR: unknown[] };
    assert.equal(where.replyToMessageId, null);
    assert.equal(where.OR.length, 4);
  });
});
