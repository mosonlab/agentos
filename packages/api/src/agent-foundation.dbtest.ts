import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { loadAgentSources, PrismaClient, RunnerPreference } from "@anneal/db";

import { createApp } from "./test-app.js";
import { runDbScript } from "./test-db-script.js";
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

test("patching an Agent model records an operator runtime override", async () => {
  const { project, environment } = await seedProject("runtime-override");
  const response = await call("POST", `/projects/${project.id}/agents`, {
    ...createBody(environment.id, "created"), foundationalPrompt: "foundation",
  });
  assert.equal(response.status, 201);

  const patched = await call("PATCH", `/agents/${response.body.id}`, {
    model: "claude-opus-5:medium", runnerPreference: "CLAUDE",
  });
  assert.equal(patched.status, 200);
  const stored = await db.agent.findUniqueOrThrow({ where: { id: response.body.id } });
  assert.equal(stored.model, "claude-opus-5:medium");
  assert.equal(stored.runnerPreference, "CLAUDE");
  assert.equal(stored.runtimeConfigCustomized, true);
});

test("reset-runtime-config restores the role source and leaves canonical sync with nothing to adopt", async () => {
  await runDbScript("seed.ts");
  const source = (await loadAgentSources()).roles.find(({ name }) => name === "default");
  assert.ok(source);
  const project = await db.project.findUniqueOrThrow({ where: { slug: "agentos-example" } });
  const agent = await db.agent.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: source.name } },
  });
  assert.deepEqual({
    model: agent.model,
    runnerPreference: agent.runnerPreference,
    runtimeConfigCustomized: agent.runtimeConfigCustomized,
  }, {
    model: source.model,
    runnerPreference: source.runnerPreference,
    runtimeConfigCustomized: false,
  });

  const patched = await call("PATCH", `/agents/${agent.id}`, {
    model: "claude-opus-5:medium",
    runnerPreference: RunnerPreference.CLAUDE,
  });
  assert.equal(patched.status, 200);
  await db.agent.update({
    where: { id: agent.id },
    data: { runtimeConfigDriftNoticeFingerprint: "stale-runtime-drift" },
  });
  assert.deepEqual(await db.agent.findUniqueOrThrow({
    where: { id: agent.id },
    select: { model: true, runnerPreference: true, runtimeConfigCustomized: true },
  }), {
    model: "claude-opus-5:medium",
    runnerPreference: RunnerPreference.CLAUDE,
    runtimeConfigCustomized: true,
  });

  const reset = await call("POST", `/agents/${agent.id}/reset-runtime-config`);
  assert.equal(reset.status, 200);
  assert.deepEqual(await db.agent.findUniqueOrThrow({
    where: { id: agent.id },
    select: {
      model: true,
      runnerPreference: true,
      runtimeConfigCustomized: true,
      runtimeConfigDriftNoticeFingerprint: true,
    },
  }), {
    model: source.model,
    runnerPreference: source.runnerPreference,
    runtimeConfigCustomized: false,
    runtimeConfigDriftNoticeFingerprint: null,
  });

  const synced = await runDbScript("sync-canonical-prompts.ts");
  assert.match(synced, /"adoptedAgentDefaults":0/u);
});
