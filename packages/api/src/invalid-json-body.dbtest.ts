import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, RunStatus, TaskStatus } from "@anneal/db";

import { issueSessionToken } from "./auth.js";
import { seedBasicChain, seedRun } from "./chain-hold-resume-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "invalid-json-body-operator";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const seedFixture = () => seedBasicChain(db, {
  control: null,
  statuses: [TaskStatus.DOING, TaskStatus.TODO],
  layers: [1, 2],
  label: "invalid-json",
});

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
    ["POST", `/tasks/${fixture.first.id}/chain/hold`] as const,
    ["PATCH", `/tasks/${fixture.second.id}`] as const,
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
    ["POST", `/tasks/${fixture.first.id}/chain/hold`] as const,
    ["PATCH", `/tasks/${fixture.second.id}`] as const,
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
    `/tasks/${fixture.first.id}/chain/hold`,
    JSON.stringify({ requestId: "hold-valid" }),
  );
  assert.equal(held.status, 200);
  assert.equal(held.body.control.state, "held");
  assert.equal(held.body.code, undefined);

  const patched = await request(
    "PATCH",
    `/tasks/${fixture.second.id}`,
    JSON.stringify({ name: "Renamed" }),
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, "Renamed");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.second.id } })).name, "Renamed");
});

test("empty and malformed bodies are named 400 refusals on session file writes", async () => {
  const fixture = await seedFixture();
  const { run } = await seedRun(db, fixture, fixture.first.id, { status: RunStatus.RUNNING });
  const { token, hash } = issueSessionToken();
  await db.run.update({
    where: { id: run.id },
    data: {
      sessionTokenHash: hash,
      sessionTokenExpiresAt: new Date(Date.now() + 60_000),
    },
  });

  for (const rawBody of [undefined, "not json"]) {
    const response = await createApp(db).request(`/session/runs/${run.id}/files/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(rawBody === undefined ? {} : { body: rawBody }),
    });
    assert.equal(response.status, 400, String(rawBody));
    assert.deepEqual(await response.json(), {
      error: "Request body must be valid JSON",
      code: "invalid-json",
    });
  }
});
