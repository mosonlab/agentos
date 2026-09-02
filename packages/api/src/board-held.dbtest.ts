import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, TaskStatus } from "@anneal/db";

import {
  CHAIN_OPERATOR_TOKEN,
  seedBasicChain,
  seedRun,
} from "./chain-hold-resume-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
const priorOperatorToken = process.env.OPERATOR_TOKEN;

before(() => {
  process.env.OPERATOR_TOKEN = CHAIN_OPERATOR_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const aggregateFor = async (projectId: string, chainId: string) => {
  const response = await createApp(db).request(`/tasks?projectId=${projectId}&view=board`, {
    headers: { Authorization: `Bearer ${CHAIN_OPERATOR_TOKEN}` },
  });
  const rows = await response.json() as Array<Record<string, any>>;
  assert.equal(response.status, 200, JSON.stringify(rows));
  const row = rows.find((candidate) => candidate.chainAggregate?.chainId === chainId);
  assert.ok(row?.chainAggregate);
  return { row, aggregate: row.chainAggregate };
};

test("the persisted board projection distinguishes held-before-first, settled-layer, and running holds", async () => {
  const beforeFirst = await seedBasicChain(db, {
    statuses: [TaskStatus.TODO, TaskStatus.TODO],
    layers: [0, 1],
    label: "board-held-before-first",
  });
  const before = await aggregateFor(beforeFirst.project.id, beforeFirst.chainId);
  assert.equal(before.aggregate.status, TaskStatus.TODO);
  assert.equal(before.aggregate.activation.state, "held");
  assert.equal(before.aggregate.activation.taskId, beforeFirst.first.id);
  assert.deepEqual(before.aggregate.activation.hold, {
    heldLayer: 0,
    heldAt: beforeFirst.control!.heldAt!.toISOString(),
    holdReason: "fixture hold",
  });

  const afterLayer = await seedBasicChain(db, {
    statuses: [TaskStatus.DONE, TaskStatus.TODO],
    label: "board-held-after-layer",
  });
  const after = await aggregateFor(afterLayer.project.id, afterLayer.chainId);
  assert.equal(after.aggregate.status, TaskStatus.TODO, "a held aggregate whose layer finished belongs in Todo");
  assert.equal(after.aggregate.activation.state, "held");
  assert.equal(after.aggregate.activation.taskId, afterLayer.first.id);
  assert.equal(after.aggregate.activation.hold.heldLayer, 1);

  const running = await seedBasicChain(db, {
    statuses: [TaskStatus.DOING, TaskStatus.TODO],
    label: "board-running-held",
  });
  await seedRun(db, running, running.first.id);
  const active = await aggregateFor(running.project.id, running.chainId);
  assert.equal(active.aggregate.status, TaskStatus.DOING);
  assert.equal(active.aggregate.activation.state, "running");
  assert.equal(active.aggregate.activation.taskId, running.first.id);
  assert.equal(active.aggregate.activation.hold.heldLayer, 1);
});
