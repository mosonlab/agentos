import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "template-base-pinning-operator";
let db: PrismaClient;
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const request = async (path: string, method: "POST" | "PATCH", body: Record<string, unknown>) => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const seed = async () => {
  const project = await db.project.create({ data: { name: "Pinned template", slug: `pinned-${Date.now()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "reviewer",
    title: "Reviewer",
    model: "claude-opus-5",
    foundationalPrompt: "foundation",
    rolePrompt: "review",
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: "pinned-template",
    description: "template",
    variables: [],
  } });
  return { agent, template };
};

const stepBody = (agentId: string, stepIndex: number, baseFromStepIndex: number | null) => ({
  stepIndex,
  name: `Step ${stepIndex}`,
  assigneeType: "AGENT",
  assigneeAgentId: agentId,
  prompt: "review",
  baseFromStepIndex,
});

test("template step create and update reject self and forward base references", async () => {
  const { agent, template } = await seed();
  const root = `/task-templates/${template.id}/steps`;
  const first = await request(root, "POST", stepBody(agent.id, 1, null));
  assert.equal(first.status, 201, JSON.stringify(first.body));

  for (const invalidBase of [2, 3]) {
    const invalid = await request(root, "POST", stepBody(agent.id, 2, invalidBase));
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    assert.match(String(invalid.body.error), /strictly earlier stepIndex/u);
  }

  const second = await request(root, "POST", stepBody(agent.id, 2, 1));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.baseFromStepIndex, 1);

  const selfPatch = await request(`${root}/${String(second.body.id)}`, "PATCH", { baseFromStepIndex: 2 });
  assert.equal(selfPatch.status, 400, JSON.stringify(selfPatch.body));
  assert.match(String(selfPatch.body.error), /strictly earlier stepIndex/u);

  const forwardPatch = await request(`${root}/${String(second.body.id)}`, "PATCH", { baseFromStepIndex: 3 });
  assert.equal(forwardPatch.status, 400, JSON.stringify(forwardPatch.body));
  assert.match(String(forwardPatch.body.error), /strictly earlier stepIndex/u);
});
