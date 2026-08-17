import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-foundation-token";
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method,
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const seedProject = async (label: string) => {
  const project = await db.project.create({ data: { name: label, slug: `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  return { project, environment };
};

const createBody = (environmentId: string, name: string) => ({
  environmentId, name, title: "Agent", model: "claude-opus-5:high", rolePrompt: "role",
  runnerPreference: "CLAUDE" as const, inboxAccess: false,
});

test("agent creation without a foundation copies the project's first agent", async () => {
  const { project, environment } = await seedProject("foundation-copy");
  const canonical = "known seeded foundation";
  await db.agent.create({ data: {
    ...createBody(environment.id, "seeded"), projectId: project.id, foundationalPrompt: canonical,
  } });
  const response = await call("POST", `/projects/${project.id}/agents`, createBody(environment.id, "created"));
  assert.equal(response.status, 201);
  assert.equal(response.body.foundationalPrompt, canonical);
  assert.equal((await db.agent.findUniqueOrThrow({ where: { id: response.body.id } })).foundationalPrompt, canonical);
});

test("agent creation without any project foundation fails before writing", async () => {
  const { project, environment } = await seedProject("foundation-missing");
  const response = await call("POST", `/projects/${project.id}/agents`, createBody(environment.id, "created"));
  assert.equal(response.status, 400);
  assert.match(response.body.error, /npm run db:seed/u);
  assert.equal(await db.agent.count({ where: { projectId: project.id } }), 0);
});

test("explicit create and patch foundation paths remain available", async () => {
  const { project, environment } = await seedProject("foundation-explicit");
  const response = await call("POST", `/projects/${project.id}/agents`, {
    ...createBody(environment.id, "created"), foundationalPrompt: "explicit foundation",
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.foundationalPrompt, "explicit foundation");
  const patched = await call("PATCH", `/agents/${response.body.id}`, { foundationalPrompt: "patched foundation" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.foundationalPrompt, "patched foundation");
});
