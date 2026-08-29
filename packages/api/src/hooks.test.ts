import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resolvePayloadVariables } from "./hooks.js";
import { encryptSecret } from "./secrets.js";

test("payload mapping resolves dot paths, stringifies scalars, and falls back to defaults", () => {
  const template = {
    variables: ["ticket", "attempt", "enabled", "fallback"],
    webhookPayloadMapping: {
      map: { ticket: "issue.title", attempt: "issue.attempt", enabled: "issue.enabled", fallback: "issue.object" },
      defaults: { fallback: "default" },
    },
  } as any;
  const resolved = resolvePayloadVariables(template, { issue: { title: "Fix", attempt: 3, enabled: false, object: { bad: true } } });
  assert.ok("variables" in resolved);
  assert.deepEqual({ ...resolved.variables }, { ticket: "Fix", attempt: "3", enabled: "false", fallback: "default" });
  assert.deepEqual(resolvePayloadVariables({ ...template, webhookPayloadMapping: { map: { ticket: "missing" } } }, {}), {
    unresolved: ["ticket", "attempt", "enabled", "fallback"],
  });
});

test("payload mapping rejects empty strings and preserves magic variable names as own properties", () => {
  const empty = resolvePayloadVariables({ variables: ["ticket"], webhookPayloadMapping: { map: { ticket: "issue.title" } } } as any, { issue: { title: "" } });
  assert.deepEqual(empty, { unresolved: ["ticket"] });
  const magic = resolvePayloadVariables({ variables: ["__proto__"], webhookPayloadMapping: { map: JSON.parse('{"__proto__":"value"}') } } as any, { value: "safe" });
  assert.ok("variables" in magic);
  assert.equal(Object.getPrototypeOf(magic.variables), null);
  assert.equal(Object.prototype.hasOwnProperty.call(magic.variables, "__proto__"), true);
  assert.equal(magic.variables.__proto__, "safe");
});

test("all webhook authentication failures return byte-identical 401 responses", async () => {
  const prior = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  process.env.AGENTOS_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  try {
    const validSecret = { encryptedValue: encryptSecret("correct"), ciphertextVersion: 1, disabledAt: null };
    const cases = [
      null,
      { id: "template", webhookSecretId: null, webhookRepoId: "repo", webhookSecret: null },
      { id: "template", webhookSecretId: "secret", webhookRepoId: null, webhookSecret: validSecret },
      { id: "template", webhookSecretId: "secret", webhookRepoId: "repo", webhookSecret: { ...validSecret, disabledAt: new Date() } },
      { id: "template", webhookSecretId: "secret", webhookRepoId: "repo", webhookSecret: validSecret },
    ];
    const bodies: string[] = [];
    for (const template of cases) {
      const database = { taskTemplate: { findUnique: async () => template } } as unknown as PrismaClient;
      const response = await createApp(database).request("/hooks/templates/template", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Anneal-Webhook-Secret": "wrong" }, body: "{}",
      });
      assert.equal(response.status, 401);
      bodies.push(await response.text());
    }
    assert.equal(new Set(bodies).size, 1);
  } finally {
    if (prior === undefined) delete process.env.AGENTOS_SECRET_ENCRYPTION_KEY; else process.env.AGENTOS_SECRET_ENCRYPTION_KEY = prior;
  }
});

test("webhook payload errors and exact public route matching are enforced", async () => {
  const priorKey = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  const priorToken = process.env.OPERATOR_TOKEN;
  process.env.AGENTOS_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
  process.env.OPERATOR_TOKEN = "operator-hook-token";
  try {
    const template = { id: "template", projectId: "project", variables: [], webhookPayloadMapping: null, webhookSecretId: "secret", webhookRepoId: "repo", webhookSecret: { encryptedValue: encryptSecret("correct"), ciphertextVersion: 1, disabledAt: null } };
    const database = { taskTemplate: { findUnique: async () => template } } as unknown as PrismaClient;
    const invalid = await createApp(database).request("/hooks/templates/template", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Anneal-Webhook-Secret": "correct" }, body: "not-json",
    });
    assert.equal(invalid.status, 400);
    const oversized = await createApp(database).request("/hooks/templates/template", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Anneal-Webhook-Secret": "correct" }, body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await createApp({} as PrismaClient).request("/hooks/other", { method: "POST" })).status, 401);
    assert.equal((await createApp({} as PrismaClient).request("/tasks", { method: "POST" })).status, 401);
  } finally {
    if (priorKey === undefined) delete process.env.AGENTOS_SECRET_ENCRYPTION_KEY; else process.env.AGENTOS_SECRET_ENCRYPTION_KEY = priorKey;
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = priorToken;
  }
});

test("template webhook PATCH validates merged secret/repo configuration and permits the kill switch", async () => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-hook-token";
  try {
    const template: { id: string; projectId: string; webhookSecretId: string | null; webhookRepoId: string | null; webhookPayloadMapping: null } = { id: "template", projectId: "project", webhookSecretId: null, webhookRepoId: null, webhookPayloadMapping: null };
    const database = {
      taskTemplate: { findUnique: async () => template, update: async ({ data }: { data: Record<string, unknown> }) => ({ ...template, ...data }) },
      secret: { findFirst: async ({ where }: { where: { id: string } }) => where.id === "webhook" ? { id: "webhook" } : null },
      repo: { findFirst: async ({ where }: { where: { id: string } }) => where.id === "repo" ? { id: "repo" } : null },
    } as unknown as PrismaClient;
    const request = (body: unknown) => createApp(database).request("/task-templates/template", {
      method: "PATCH", headers: { Authorization: "Bearer operator-hook-token", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await request({ webhookSecretId: "webhook" })).status, 400);
    assert.equal((await request({ webhookSecretId: "wrong", webhookRepoId: "repo" })).status, 400);
    assert.equal((await request({ webhookSecretId: "webhook", webhookRepoId: "foreign" })).status, 400);
    template.webhookSecretId = "webhook";
    template.webhookRepoId = "repo";
    assert.equal((await request({ webhookSecretId: null })).status, 200);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
});
