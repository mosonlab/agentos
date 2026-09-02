import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { AssigneeType, PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const operator = "gate-slot-chain-read";

const readChain = async (taskId: string): Promise<{ status: number; body: any }> => {
  const previous = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = operator;
  try {
    const response = await createApp(db).request(`/tasks/${taskId}/chain`, {
      headers: { Authorization: `Bearer ${operator}` },
    });
    return { status: response.status, body: await response.json() };
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previous;
  }
};

test("GET /tasks/:id/chain projects each configurable gate slot", async () => {
  const project = await db.project.create({ data: { name: "Gate slots", slug: `gate-slots-${Date.now()}` } });
  const template = await db.taskTemplate.create({
    data: { projectId: project.id, name: "mixed", description: "mixed", variables: [] },
  });
  const stepData = [
    { stepIndex: 1, layer: 1, name: "Write a spec", outputKind: "spec" },
    { stepIndex: 2, layer: 2, name: "Implementation", outputKind: "implementation" },
    { stepIndex: 3, layer: 3, name: "Merge authorization", outputKind: "merge-authorization-v2" },
  ];
  const steps = await Promise.all(stepData.map((step) => db.taskTemplateStep.create({
    data: {
      taskTemplateId: template.id,
      name: step.name,
      stepIndex: step.stepIndex,
      layer: step.layer,
      assigneeType: AssigneeType.AGENT,
      prompt: step.name,
      outputKind: step.outputKind,
      approvalGate: false,
    },
  })));
  const chainId = `gate-slot-chain-${Date.now()}`;
  const tasks = await Promise.all(steps.map((step) => db.task.create({
    data: {
      projectId: project.id,
      name: step.name,
      description: step.name,
      templateId: template.id,
      templateStepId: step.id,
      chainId,
      chainIndex: step.stepIndex,
      chainLayer: step.layer,
      approvalGate: step.stepIndex === 1 || step.stepIndex === 3,
    },
  })));

  const result = await readChain(tasks[1]!.id);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.steps.map((step: { gateSlot: string | null }) => step.gateSlot), ["spec", null, "merge"]);
});
