import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, TaskStatus } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "invalid-json-body-operator";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

type Fixture = {
  task: { id: string };
  chainTask: { id: string };
};

let sequence = 0;
const seedFixture = async (): Promise<Fixture> => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({
    data: { name: "Invalid JSON", slug: `invalid-json-${suffix}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: `agent-${suffix}`,
      title: "Agent",
      model: "claude",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "repo",
      remoteUrl: "https://example.test/repo.git",
      mountPath: "/repo",
    },
  });
  await db.agentRepoAccess.create({
    data: {
      projectId: project.id,
      agentId: agent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE",
    },
  });
  const task = await db.task.create({
    data: {
      projectId: project.id,
      assigneeAgentId: agent.id,
      repoId: repo.id,
      name: "Patchable",
      description: "work",
      status: TaskStatus.TODO,
    },
  });
  const chainId = `chain-${suffix}`;
  const chainTask = await db.task.create({
    data: {
      projectId: project.id,
      assigneeAgentId: agent.id,
      repoId: repo.id,
      name: "Chain step",
      description: "work",
      status: TaskStatus.DOING,
      chainId,
      chainIndex: 0,
      chainLayer: 1,
    },
  });
  await db.task.create({
    data: {
      projectId: project.id,
      assigneeAgentId: agent.id,
      repoId: repo.id,
      name: "Chain successor",
      description: "work",
      status: TaskStatus.TODO,
      chainId,
      chainIndex: 1,
      chainLayer: 2,
    },
  });
  return { task, chainTask };
};

const request = async (
  method: "PATCH" | "POST",
  path: string,
  rawBody?: string,
): Promise<{ status: number; body: any }> => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(path, {
      method,
      headers: {
        Authorization: `Bearer ${OPERATOR}`,
        "Content-Type": "application/json",
      },
      ...(rawBody === undefined ? {} : { body: rawBody }),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null) as any,
    };
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

test("empty and malformed JSON bodies are named 400 refusals on both task JSON routes", async () => {
  const fixture = await seedFixture();
  const routes = [
    ["POST", `/tasks/${fixture.chainTask.id}/chain/hold`] as const,
    ["PATCH", `/tasks/${fixture.task.id}`] as const,
  ];
  for (const [method, path] of routes) {
    for (const rawBody of [undefined, "not json"]) {
      const result = await request(method, path, rawBody);
      assert.equal(result.status, 400, `${method} ${path} ${String(rawBody)}`);
      assert.deepEqual(result.body, {
        error: "Request body must be valid JSON",
        code: "invalid-json",
      });
    }
  }
});

test("an object body still reaches each route's Zod validator", async () => {
  const fixture = await seedFixture();
  const routes = [
    ["POST", `/tasks/${fixture.chainTask.id}/chain/hold`] as const,
    ["PATCH", `/tasks/${fixture.task.id}`] as const,
  ];
  for (const [method, path] of routes) {
    const result = await request(method, path, "{}");
    assert.equal(result.status, 400, `${method} ${path}`);
    assert.equal(result.body.error, "Validation failed");
    assert.ok(Array.isArray(result.body.issues));
    assert.notEqual(result.body.code, "invalid-json");
  }
});

test("valid JSON bodies keep hold and patch behavior unchanged", async () => {
  const fixture = await seedFixture();
  const held = await request(
    "POST",
    `/tasks/${fixture.chainTask.id}/chain/hold`,
    JSON.stringify({ requestId: "hold-valid" }),
  );
  assert.equal(held.status, 200);
  assert.equal(held.body.control.state, "held");
  assert.equal(held.body.code, undefined);

  const patched = await request(
    "PATCH",
    `/tasks/${fixture.task.id}`,
    JSON.stringify({ name: "Renamed" }),
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, "Renamed");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.task.id } })).name, "Renamed");
});
