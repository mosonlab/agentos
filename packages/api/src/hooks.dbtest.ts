import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type { PrismaClient } from "@agentos/db";

import { createApp } from "./app.js";
import { encryptSecret } from "./secrets.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let priorKey: string | undefined;
before(() => {
  priorKey = process.env.AGENTOS_SECRET_ENCRYPTION_KEY;
  process.env.AGENTOS_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorKey === undefined) delete process.env.AGENTOS_SECRET_ENCRYPTION_KEY; else process.env.AGENTOS_SECRET_ENCRYPTION_KEY = priorKey;
});

const seedWebhook = async () => {
  const project = await db.project.create({ data: { name: "Hooks", slug: `hooks-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo" } });
  await db.agentRepoAccess.create({ data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" } });
  const secret = await db.secret.create({ data: { name: `hook-${Date.now()}`, encryptedValue: encryptSecret("shared"), purpose: "WEBHOOK" } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: "Ticket", description: "ticket", variables: ["ticket"], webhookSecretId: secret.id,
    webhookRepoId: repo.id, webhookPayloadMapping: { map: { ticket: "issue.title" } },
  } });
  await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id, assigneeAgentId: agent.id, stepIndex: 0, name: "Implement", assigneeType: "AGENT", prompt: "Handle {{ticket}}",
  } });
  return { project, template };
};

const fire = (templateId: string, payload: unknown) => createApp(db).request(`/hooks/templates/${templateId}`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-AgentOS-Webhook-Secret": "shared" }, body: JSON.stringify(payload),
});

test("webhook happy path creates the operator-equivalent chain, first run, and webhook activities", async () => {
  const { template } = await seedWebhook();
  const response = await fire(template.id, { issue: { title: "Fix race" } });
  assert.equal(response.status, 201);
  const result = await response.json() as { chainId: string; taskIds: string[] };
  assert.equal(result.taskIds.length, 1);
  assert.equal(await db.run.count({ where: { taskId: result.taskIds[0]! } }), 1);
  const activity = await db.taskActivity.findFirstOrThrow({ where: { taskId: result.taskIds[0]! } });
  assert.equal(activity.actorType, "webhook");
  assert.match(JSON.stringify(activity.metadata), /webhookTemplateId/);
});

test("unresolved webhook variables create no database rows", async () => {
  const { template } = await seedWebhook();
  const response = await fire(template.id, { issue: {} });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /ticket/);
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.run.count(), 0);
  assert.equal(await db.taskActivity.count(), 0);
});

test("two webhook fires create two independent chains", async () => {
  const { template } = await seedWebhook();
  const first = await fire(template.id, { issue: { title: "One" } });
  const second = await fire(template.id, { issue: { title: "Two" } });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const ids = [(await first.json() as any).chainId, (await second.json() as any).chainId];
  assert.notEqual(ids[0], ids[1]);
  assert.equal(await db.task.count(), 2);
});

test("empty-string webhook scalars instantiate successfully", async () => {
  const { template } = await seedWebhook();
  const response = await fire(template.id, { issue: { title: "" } });
  assert.equal(response.status, 201);
  assert.equal(await db.task.count(), 1);
  assert.equal(await db.run.count(), 1);
});

test("concurrent webhook fires retry serialization conflicts and create independent chains", async () => {
  const { template } = await seedWebhook();
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => fire(template.id, { issue: { title: `Burst ${index}` } })));
  assert.deepEqual(responses.map((response) => response.status), [201, 201, 201, 201, 201, 201]);
  const chainIds = await Promise.all(responses.map(async (response) => (await response.json() as { chainId: string }).chainId));
  assert.equal(new Set(chainIds).size, 6);
  assert.equal(await db.task.count(), 6);
  assert.equal(await db.run.count(), 6);
});

test("template GET responses never include the Secret relation or ciphertext", async () => {
  const { project } = await seedWebhook();
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-hook-token";
  try {
    const response = await createApp(db).request(`/projects/${project.id}/task-templates`, { headers: { Authorization: "Bearer operator-hook-token" } });
    assert.equal(response.status, 200);
    const body = await response.json() as Array<Record<string, unknown>>;
    assert.equal(Object.prototype.hasOwnProperty.call(body[0], "webhookSecret"), false);
    assert.doesNotMatch(JSON.stringify(body), /encryptedValue|ciphertextVersion/);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
});
