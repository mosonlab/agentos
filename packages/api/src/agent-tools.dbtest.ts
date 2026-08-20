import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-tools-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> => asOperator(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

const seedAgent = async (label: string) => {
  const project = await db.project.create({ data: { name: label, slug: `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude-opus-5:high",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  return { project, environment, agent };
};

test("an agent created without disabledTools reads back an empty denied set", async () => {
  const { agent } = await seedAgent("tools-default");
  assert.deepEqual(agent.disabledTools, []);
  const read = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
  assert.deepEqual(read.disabledTools, []);
});

test("PATCH persists a denied set", async () => {
  const { agent } = await seedAgent("tools-patch");
  const { status, body } = await call("PATCH", `/agents/${agent.id}`, { disabledTools: ["BASH", "WEB_SEARCH"] });
  assert.equal(status, 200);
  assert.deepEqual(body.disabledTools, ["BASH", "WEB_SEARCH"]);
  assert.deepEqual((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).disabledTools, ["BASH", "WEB_SEARCH"]);
});

test("an unknown tool key is a 400 and writes nothing", async () => {
  const { agent } = await seedAgent("tools-reject");
  await call("PATCH", `/agents/${agent.id}`, { disabledTools: ["BASH"] });
  const { status } = await call("PATCH", `/agents/${agent.id}`, { disabledTools: ["NOPE"] });
  assert.equal(status, 400);
  assert.deepEqual((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).disabledTools, ["BASH"]);
});

test("the denied set can be cleared back to empty", async () => {
  const { agent } = await seedAgent("tools-clear");
  await call("PATCH", `/agents/${agent.id}`, { disabledTools: ["BASH"] });
  const { status, body } = await call("PATCH", `/agents/${agent.id}`, { disabledTools: [] });
  assert.equal(status, 200);
  assert.deepEqual(body.disabledTools, []);
});
