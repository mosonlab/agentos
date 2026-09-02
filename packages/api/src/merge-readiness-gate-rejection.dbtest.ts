import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  MERGE_INTEGRATOR_KIND,
  PrismaClient,
  TaskStatus,
  applyInboxDecisionTx,
  advanceTemplateTask,
} from "@anneal/db";

import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { patchTask } from "./task-patch.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const openMergeGate = async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-rejection",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await db.$transaction((tx) => advanceTemplateTask(
    tx,
    chain.gateTask.id,
    chain.gateRun.id,
    null,
    new Date("2026-08-31T00:00:01.000Z"),
  ));
  const card = await db.inboxMessage.findFirstOrThrow({
    where: { gateTaskId: chain.readinessTask.id, status: "OPEN" },
  });
  return { chain, card };
};

const reject = (cardId: string, externalEventId: string) => db.$transaction((tx) => (
  applyInboxDecisionTx(tx, {
    inboxMessageId: cardId,
    externalEventId,
    decision: "reject",
    actorOpenId: "operator-1",
  })
));

test("Inbox rejection abandons the merge tail without activating or mutating GitHub", async () => {
  const { chain, card } = await openMergeGate();
  assert.ok(chain.readinessTask);
  assert.ok(chain.integratorTask);

  const aggregateCard = await db.inboxMessage.create({ data: {
    from: "AGENT",
    taskId: chain.integratorTask.id,
    kind: "TEXT",
    body: "merge execution aggregate",
    status: "OPEN",
    dedupeKey: `merge-gate-rejection-aggregate:${chain.chainId}`,
  } });

  const result = await reject(card.id, "merge-gate-reject-inbox");
  assert.equal(result.gateAction, "rejected");

  const [readiness, regression, integrator, gateCard, closedAggregate] = await Promise.all([
    db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } }),
    db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } }),
    db.task.findUniqueOrThrow({ where: { id: chain.integratorTask.id } }),
    db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } }),
    db.inboxMessage.findUniqueOrThrow({ where: { id: aggregateCard.id } }),
  ]);
  assert.equal(readiness.status, TaskStatus.DONE);
  assert.equal(regression.status, TaskStatus.DONE);
  assert.equal(integrator.status, TaskStatus.DONE);
  assert.equal(gateCard.status, "ANSWERED");
  assert.equal(closedAggregate.status, "CLOSED");
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask.id } }), 0);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: chain.integratorTask.id } });
  assert.equal(output.kind, "merge-result");
  assert.match(output.body, /abandoned/iu);
  assert.match(output.body, /No merge was performed/iu);
  const rejection = await db.taskActivity.findFirst({
    where: { taskId: chain.readinessTask.id, actorType: "operator", body: { contains: "merge chain abandoned" } },
  });
  assert.ok(rejection);
  assert.equal(await db.inboxMessage.count({ where: { taskId: chain.integratorTask.id, status: "OPEN" } }), 0);
  assert.equal(await db.taskActivity.count({
    where: { taskId: chain.readinessTask.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization } },
  }), 0);
});

test("task PATCH rejection shares the terminal merge-gate disposition", async () => {
  const { chain, card } = await openMergeGate();
  assert.ok(chain.readinessTask);
  assert.ok(chain.integratorTask);

  const patched = await patchTask(db, chain.readinessTask.id, { status: TaskStatus.TODO });
  assert.ok("task" in patched, JSON.stringify(patched));
  assert.equal(patched.task.status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } })).status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask.id } })).status, TaskStatus.DONE);
  const answered = await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
  assert.equal(answered.status, "ANSWERED");
  assert.equal(answered.selectedChoiceId, "reject");
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask.id } }), 0);
  const output = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: chain.integratorTask.id } });
  assert.equal(output.kind, "merge-result");
  assert.match(output.body, /merge gate rejection/iu);
  assert.ok(await db.taskActivity.findFirst({
    where: { taskId: chain.readinessTask.id, actorType: "operator", body: { contains: "merge chain abandoned" } },
  }));
  assert.equal(await db.taskActivity.count({
    where: { taskId: chain.readinessTask.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization } },
  }), 0);
});

test("the rejection helper refuses an already-active merge execution run", async () => {
  const { chain, card } = await openMergeGate();
  assert.ok(chain.integratorTask);
  await db.run.create({ data: {
    projectId: chain.project.id,
    taskId: chain.integratorTask.id,
    agentId: chain.integratorAgent.id,
    repoId: chain.repo.id,
    runNumber: 1,
    dedupeKey: `merge-gate-rejection-active:${chain.chainId}`,
    runner: "CODEX",
    model: chain.integratorAgent.model,
    promptHash: "hash",
    status: "QUEUED",
  } });

  await assert.rejects(
    () => reject(card.id, "merge-gate-reject-active"),
    /active merge execution run/iu,
  );
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "OPEN");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask!.id } })).status, TaskStatus.REVIEW);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.integratorTask!.id } })).status, TaskStatus.TODO);
});
