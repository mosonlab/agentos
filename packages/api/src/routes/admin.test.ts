import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@anneal/db";

import { createApp } from "../test-app.js";
import { withTokens } from "./test-support.js";

const projectRow = () => ({
  id: "project-1",
  name: "Demo",
  slug: "demo",
  yamlDocument: "",
  maxDurationMin: 240,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 3,
  specGateDefault: false,
  mergeGateDefault: false,
  spendCap: new Prisma.Decimal("10"),
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});

const patchProject = async (body: unknown): Promise<{ response: Response; updates: unknown[] }> => {
  const updates: unknown[] = [];
  const database = {
    project: {
      update: async (args: { data: unknown }) => {
        updates.push(args.data);
        return { ...projectRow(), ...args.data as Record<string, unknown> };
      },
    },
  } as unknown as PrismaClient;
  const response = await createApp(database).request("/projects/project-1", {
    method: "PATCH",
    headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, updates };
};

test("a project PATCH still writes one named setting at a time", async () => {
  await withTokens(async () => {
    const { response, updates } = await patchProject({ mergeGateDefault: true });
    assert.equal(response.status, 200);
    assert.deepEqual(updates, [{ mergeGateDefault: true }]);
    const project = await response.json() as Record<string, unknown>;
    assert.equal(project.mergeGateDefault, true);
    assert.equal(project.specGateDefault, false);
  });
});

/* `skipOptionalSteps` was a project-wide switch and is now a per-instantiation
 * staffing decision. The schema is strict so an operator or script still
 * sending it is told, rather than having that key dropped while the rest of the
 * body is written — which would report success for a change that never
 * happened. */
test("a project PATCH carrying the retired optional-step switch is refused, not partly applied", async () => {
  await withTokens(async () => {
    const { response, updates } = await patchProject({ specGateDefault: true, skipOptionalSteps: true });
    assert.equal(response.status, 400);
    assert.deepEqual(updates, []);
    const body = await response.json() as { error: string };
    assert.equal(body.error, "Validation failed");
  });
});

test("a project PATCH with no recognised field is refused", async () => {
  await withTokens(async () => {
    const { response, updates } = await patchProject({});
    assert.equal(response.status, 400);
    assert.deepEqual(updates, []);
  });
});
