import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { ChainControlState, PrismaClient, TaskStatus } from "@anneal/db";

import { CHAIN_OPERATOR_TOKEN, seedBasicChain } from "./chain-hold-resume-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const chainRead = async (taskId: string): Promise<{ status: number; body: any }> => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = CHAIN_OPERATOR_TOKEN;
  try {
    const response = await createApp(db).request(`/tasks/${taskId}/chain`, {
      headers: { Authorization: `Bearer ${CHAIN_OPERATOR_TOKEN}` },
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

test("GET Chain projects held, released, and never-held control state without changing Step fields", async () => {
  const held = await seedBasicChain(db, { label: "read-held" });
  const heldRead = await chainRead(held.first.id);
  assert.equal(heldRead.status, 200, JSON.stringify(heldRead.body));
  assert.deepEqual(heldRead.body.control, {
    projectId: held.project.id,
    chainId: held.chainId,
    state: "held",
    heldLayer: 1,
    heldAt: "2026-08-28T00:00:00.000Z",
    holdRequestId: "hold-fixture",
    holdReason: "fixture hold",
    releasedAt: null,
    releaseRequestId: null,
    holdGeneration: 1,
  });
  assert.deepEqual(
    heldRead.body.steps.map((step: any) => ({
      taskId: step.taskId,
      position: step.position,
      chainIndex: step.chainIndex,
      layer: step.layer,
      status: step.status,
      startable: step.startable,
      startAction: step.startAction,
      currentExecution: step.currentExecution,
    })),
    [
      { taskId: held.first.id, position: 1, chainIndex: 0, layer: 1, status: TaskStatus.DONE, startable: false, startAction: null, currentExecution: false },
      { taskId: held.second.id, position: 2, chainIndex: 1, layer: 2, status: TaskStatus.TODO, startable: false, startAction: null, currentExecution: false },
      { taskId: held.third.id, position: 3, chainIndex: 2, layer: 3, status: TaskStatus.TODO, startable: false, startAction: null, currentExecution: false },
    ],
  );

  const released = await seedBasicChain(db, {
    label: "read-released",
    control: {
      state: ChainControlState.RELEASED,
      heldLayer: 2,
      heldAt: new Date("2026-08-28T01:00:00.000Z"),
      holdRequestId: "hold-before-release",
      holdReason: "inspect first layer",
      releasedAt: new Date("2026-08-28T02:00:00.000Z"),
      releaseRequestId: "release-fixture",
      holdGeneration: 1,
      event: true,
    },
  });
  const releasedRead = await chainRead(released.first.id);
  assert.equal(releasedRead.status, 200, JSON.stringify(releasedRead.body));
  assert.deepEqual(releasedRead.body.control, {
    projectId: released.project.id,
    chainId: released.chainId,
    state: "released",
    heldLayer: 2,
    heldAt: "2026-08-28T01:00:00.000Z",
    holdRequestId: "hold-before-release",
    holdReason: "inspect first layer",
    releasedAt: "2026-08-28T02:00:00.000Z",
    releaseRequestId: "release-fixture",
    holdGeneration: 1,
  });
  assert.deepEqual(releasedRead.body.steps.map((step: any) => step.status), [TaskStatus.DONE, TaskStatus.TODO, TaskStatus.TODO]);

  const neverHeld = await seedBasicChain(db, { label: "read-never-held", control: null });
  const neverHeldRead = await chainRead(neverHeld.first.id);
  assert.equal(neverHeldRead.status, 200, JSON.stringify(neverHeldRead.body));
  assert.equal(neverHeldRead.body.control, null);
  assert.deepEqual(neverHeldRead.body.steps.map((step: any) => step.status), [TaskStatus.DONE, TaskStatus.TODO, TaskStatus.TODO]);
});
