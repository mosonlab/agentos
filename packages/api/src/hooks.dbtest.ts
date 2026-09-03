import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, type PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
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
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo", dependencyProvisioning: DependencyProvisioning.NONE } });
  await db.agentRepoAccess.create({ data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" } });
  const secret = await db.secret.create({ data: { name: `hook-${Date.now()}`, encryptedValue: encryptSecret("shared"), purpose: "WEBHOOK" } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id, name: "Ticket", description: "ticket", variables: ["ticket"], webhookSecretId: secret.id,
    webhookRepoId: repo.id, webhookPayloadMapping: { map: { ticket: "issue.title" } },
  } });
  await db.taskTemplateStep.create({ data: {
    taskTemplateId: template.id, assigneeAgentId: agent.id, stepIndex: 0, layer: 0, name: "Implement", assigneeType: "AGENT", prompt: "Handle {{ticket}}",
  } });
  return { project, template };
};

const fire = (
  templateId: string,
  payload: unknown,
  headers: Record<string, string> = {},
) => createApp(db).request(`/hooks/templates/${templateId}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Anneal-Webhook-Secret": "shared", ...headers },
  body: JSON.stringify(payload),
});

test("webhook happy path creates the operator-equivalent chain, first run, and webhook activities", async () => {
  const { template } = await seedWebhook();
  await db.taskTemplate.update({ where: { id: template.id }, data: { name: "Ticket\nQueue" } });
  const response = await fire(template.id, { issue: { title: "Fix race" } });
  assert.equal(response.status, 201);
  const result = await response.json() as { chainId: string; taskIds: string[] };
  assert.equal(result.taskIds.length, 1);
  assert.equal(await db.run.count({ where: { taskId: result.taskIds[0]! } }), 1);
  const triggerFire = await db.triggerFire.findFirstOrThrow({ where: { chainId: result.chainId } });
  const task = await db.task.findUniqueOrThrow({ where: { id: result.taskIds[0]! } });
  assert.ok(task.name.startsWith(`Ticket Queue: ${triggerFire.id}: `));
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

test("empty-string webhook scalars are unresolved and write nothing", async () => {
  const { template } = await seedWebhook();
  const response = await fire(template.id, { issue: { title: "" } });
  assert.equal(response.status, 400);
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.run.count(), 0);
  assert.equal(await db.triggerFire.count(), 0);
});

test("a blank webhook scalar uses a nonblank configured default", async () => {
  const { template } = await seedWebhook();
  await db.taskTemplate.update({
    where: { id: template.id },
    data: { webhookPayloadMapping: { map: { ticket: "issue.title" }, defaults: { ticket: "fallback" } } },
  });
  const response = await fire(template.id, { issue: { title: "   " } });
  assert.equal(response.status, 201);
  assert.match((await db.task.findFirstOrThrow()).description, /fallback/);
});

test("an invalid webhook branch is a client refusal with no durable rows", async () => {
  const { template } = await seedWebhook();
  await db.taskTemplate.update({
    where: { id: template.id },
    data: { variables: ["branchName"], webhookPayloadMapping: { map: { branchName: "issue.title" } } },
  });
  const response = await fire(template.id, { issue: { title: "bad..branch" } });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Invalid template branch name/);
  assert.equal(await db.task.count(), 0);
  assert.equal(await db.run.count(), 0);
  assert.equal(await db.triggerFire.count(), 0);
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
  const { project, template } = await seedWebhook();
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-hook-token";
  try {
    const app = createApp(db);
    const headers = { Authorization: "Bearer operator-hook-token" };
    const paths = [
      `/projects/${project.id}/task-templates`,
      `/projects/${project.id}/triggers`,
      `/triggers/${template.id}`,
    ];
    for (const path of paths) {
      const response = await app.request(path, { headers });
      assert.equal(response.status, 200, path);
      const body = await response.json() as Record<string, unknown> | Array<Record<string, unknown>>;
      const first = Array.isArray(body) ? body[0]! : body;
      assert.equal(Object.prototype.hasOwnProperty.call(first, "webhookSecret"), false, path);
      assert.doesNotMatch(JSON.stringify(body), /encryptedValue|ciphertextVersion|"shared"/, path);
    }
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
});

// --- batch 2.5: pause is a 401, and the replay window ------------------------

const setWindow = (templateId: string, seconds: number | null) =>
  db.taskTemplate.update({ where: { id: templateId }, data: { webhookReplayWindowSec: seconds } });

test("a paused trigger answers a correct secret exactly as it answers a wrong one", async () => {
  const { template } = await seedWebhook();
  const wrong = await createApp(db).request(`/hooks/templates/${template.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Anneal-Webhook-Secret": "not-the-secret" },
    body: JSON.stringify({ issue: { title: "Fix race" } }),
  });
  const wrongBody = await wrong.text();

  await db.taskTemplate.update({ where: { id: template.id }, data: { webhookPausedAt: new Date() } });
  const paused = await fire(template.id, { issue: { title: "Fix race" } });
  assert.equal(paused.status, wrong.status);
  assert.equal(paused.status, 401);
  // Byte-identical, not merely equal in status: a pause must not be detectable
  // by anyone holding the wrong secret.
  assert.equal(await paused.text(), wrongBody);
  assert.equal(await db.triggerFire.count(), 0);
  assert.equal(await db.task.count(), 0);
});

test("inside the replay window an identical redelivery is a 200 duplicate, not a second chain", async () => {
  const { template } = await seedWebhook();
  await setWindow(template.id, 300);
  const first = await fire(template.id, { issue: { title: "Fix race" } });
  assert.equal(first.status, 201);
  const chainId = (await first.json() as { chainId: string }).chainId;

  const second = await fire(template.id, { issue: { title: "Fix race" } });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { duplicate: true, chainId });
  assert.equal(await db.task.count(), 1);
  assert.equal(await db.triggerFire.count(), 1);
  // The ledger row records the key it deduped on: sha256 of the raw body.
  assert.equal((await db.triggerFire.findFirstOrThrow()).dedupeKey?.length, 64);
});

test("the delivery id beats the body hash, so a redelivery with a changed body is still a duplicate", async () => {
  const { template } = await seedWebhook();
  await setWindow(template.id, 300);
  const headers = { "X-Anneal-Delivery-Id": "delivery-9" };
  assert.equal((await fire(template.id, { issue: { title: "One" } }, headers)).status, 201);
  assert.equal((await fire(template.id, { issue: { title: "Two, retried" } }, headers)).status, 200);
  assert.equal(await db.task.count(), 1);
  assert.equal((await db.triggerFire.findFirstOrThrow()).dedupeKey, "delivery-9");
});

test("outside the replay window the same delivery fires again", async () => {
  const { template } = await seedWebhook();
  await setWindow(template.id, 300);
  assert.equal((await fire(template.id, { issue: { title: "Fix race" } })).status, 201);
  // Backdating the ledger row is the deterministic form of waiting 301 seconds.
  await db.triggerFire.updateMany({ data: { createdAt: new Date(Date.now() - 400_000) } });
  assert.equal((await fire(template.id, { issue: { title: "Fix race" } })).status, 201);
  assert.equal(await db.task.count(), 2);
  assert.equal(await db.triggerFire.count(), 2);
});

test("with the window disabled two identical deliveries still make two chains", async () => {
  const { template } = await seedWebhook();
  const first = await fire(template.id, { issue: { title: "Fix race" } });
  const second = await fire(template.id, { issue: { title: "Fix race" } });
  assert.deepEqual([first.status, second.status], [201, 201]);
  assert.equal(await db.task.count(), 2);
  // The ledger still records both, with no key to dedupe on.
  const fires = await db.triggerFire.findMany();
  assert.equal(fires.length, 2);
  assert.deepEqual(fires.map((row) => row.dedupeKey), [null, null]);
  assert.deepEqual(fires.map((row) => row.source), ["WEBHOOK", "WEBHOOK"]);
});

test("a webhook-born chain is stamped WEBHOOK on every task", async () => {
  const { template } = await seedWebhook();
  const response = await fire(template.id, { issue: { title: "Fix race" } });
  const taskIds = (await response.json() as { taskIds: string[] }).taskIds;
  for (const taskId of taskIds) {
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).source, "WEBHOOK");
  }
});
