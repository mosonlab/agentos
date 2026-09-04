import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { type PrismaClient } from "@anneal/db";

import { resetTestDb, setupTestDb } from "./testdb.js";
import {
  readStepSnapshots,
  replaceRequest,
  seedAuthoringTemplate,
  stepPayload,
  TEMPLATE_AUTHORING_OPERATOR,
} from "./template-authoring-test-helpers.js";

let db: PrismaClient;
let priorOperatorToken: string | undefined;

before(() => {
  priorOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = TEMPLATE_AUTHORING_OPERATOR;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
});

const assertRefusal = async (
  dbTemplate: Awaited<ReturnType<typeof seedAuthoringTemplate>>,
  steps: unknown[],
  code: string,
  stepIndex: number,
) => {
  const before = await readStepSnapshots(db, dbTemplate.template.id);
  const result = await replaceRequest(db, dbTemplate.project.id, dbTemplate.template.id, { steps });
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.code, code, JSON.stringify(result.body));
  assert.equal(result.body.stepIndex, stepIndex, JSON.stringify(result.body));
  assert.deepEqual(await readStepSnapshots(db, dbTemplate.template.id), before);
};

test("first step must be an Agent and first layer must contain one Step", async () => {
  const seed = await seedAuthoringTemplate(db, "order-first");
  await assertRefusal(
    seed,
    [stepPayload(seed, 1, { assigneeType: "HUMAN", assigneeAgentId: null })],
    "first_step_not_agent",
    1,
  );
  await assertRefusal(
    seed,
    [stepPayload(seed, 1, { layer: 1 }), stepPayload(seed, 2, { layer: 1 })],
    "first_layer_not_single",
    2,
  );
});

test("layers are non-decreasing and every base points to an earlier lower layer", async () => {
  const seed = await seedAuthoringTemplate(db, "order-base");
  await assertRefusal(
    seed,
    [stepPayload(seed, 1, { layer: 2 }), stepPayload(seed, 2, { layer: 1 })],
    "layer_order_invalid",
    2,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1 }),
      stepPayload(seed, 2, { layer: 2, baseFromStepIndex: 2 }),
      stepPayload(seed, 3, { layer: 2, baseFromStepIndex: 2 }),
    ],
    "base_step_invalid",
    2,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1 }),
      stepPayload(seed, 2, { layer: 2, baseFromStepIndex: 99 }),
    ],
    "base_step_invalid",
    2,
  );
  const valid = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1 }),
      stepPayload(seed, 2, { layer: 2, baseFromStepIndex: 1 }),
    ],
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});

test("optional steps obey entry, base, gate-slot, and merge-tail invariants", async () => {
  const seed = await seedAuthoringTemplate(db, "order-optional");
  await assertRefusal(
    seed,
    [stepPayload(seed, 1, { layer: 1, optional: true })],
    "first_step_optional",
    1,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "base" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "optional", optional: true }),
      stepPayload(seed, 3, { layer: 3, outputKind: "consumer", baseFromStepIndex: 2 }),
    ],
    "base_step_optional",
    3,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "start" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "spec", optional: true }),
    ],
    "gate_slot_step_optional",
    2,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "start" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "optional", optional: true }),
      stepPayload(seed, 3, { layer: 3, outputKind: "merge-authorization" }),
    ],
    "optional_step_precedes_merge_tail",
    2,
  );
});

test("fixed validator order returns only the earliest rule on repeated submissions", async () => {
  const seed = await seedAuthoringTemplate(db, "order-precedence");
  const before = await readStepSnapshots(db, seed.template.id);
  const cases = [
    {
      steps: [
        stepPayload(seed, 1, { assigneeType: "HUMAN", assigneeAgentId: null }),
        stepPayload(seed, 2, { layer: 1 }),
      ],
      code: "first_step_not_agent",
      stepIndex: 1,
    },
    {
      steps: [
        stepPayload(seed, 1, { layer: 1 }),
        stepPayload(seed, 2, { layer: 1 }),
        stepPayload(seed, 3, { layer: 0, baseFromStepIndex: 99 }),
      ],
      code: "first_layer_not_single",
      stepIndex: 2,
    },
    {
      steps: [
        stepPayload(seed, 1, { layer: 1 }),
        stepPayload(seed, 2, { layer: 0, baseFromStepIndex: 99 }),
      ],
      code: "layer_order_invalid",
      stepIndex: 2,
    },
  ] as const;
  for (const candidate of cases) {
    const result = await replaceRequest(db, seed.project.id, seed.template.id, { steps: candidate.steps });
    assert.equal(result.status, 422, JSON.stringify(result.body));
    assert.equal(result.body.code, candidate.code, JSON.stringify(result.body));
    assert.equal(result.body.stepIndex, candidate.stepIndex, JSON.stringify(result.body));
    assert.deepEqual(await readStepSnapshots(db, seed.template.id), before);
  }
});
