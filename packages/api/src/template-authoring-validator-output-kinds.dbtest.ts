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
  seed: Awaited<ReturnType<typeof seedAuthoringTemplate>>,
  steps: unknown[],
  code: string,
  stepIndex: number,
) => {
  const before = await readStepSnapshots(db, seed.template.id);
  const result = await replaceRequest(db, seed.project.id, seed.template.id, { steps });
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.code, code, JSON.stringify(result.body));
  assert.equal(result.body.stepIndex, stepIndex, JSON.stringify(result.body));
  assert.deepEqual(await readStepSnapshots(db, seed.template.id), before);
};

test("a prior kind must have a producer in a strictly earlier layer", async () => {
  const seed = await seedAuthoringTemplate(db, "output-prior");
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "source" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "middle" }),
      stepPayload(seed, 3, { layer: 2, outputKind: "consumer", priorOutputKinds: ["middle"] }),
    ],
    "prior_kind_unproduced",
    3,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "source" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "consumer", priorOutputKinds: ["not-produced"] }),
    ],
    "prior_kind_unproduced",
    2,
  );
  const valid = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1, outputKind: "custom-output-v2" }),
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "another-custom-output-v2",
        priorOutputKinds: ["custom-output-v2"],
      }),
    ],
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});

test("duplicate output and prior kinds report the later or consuming Step", async () => {
  const seed = await seedAuthoringTemplate(db, "output-duplicates");
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "same-kind" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "same-kind" }),
      stepPayload(seed, 3, { layer: 3, outputKind: "later-kind" }),
    ],
    "output_kind_duplicate",
    2,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "source-kind" }),
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "consumer-kind",
        priorOutputKinds: ["source-kind", "source-kind"],
      }),
    ],
    "prior_kind_duplicate",
    2,
  );
});

test("unknown output kinds remain legal when their prior wiring is consistent", async () => {
  const seed = await seedAuthoringTemplate(db, "output-unknown");
  const result = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1, outputKind: "operator-defined-v7" }),
      stepPayload(seed, 2, {
        layer: 2,
        outputKind: "operator-consumer-v7",
        priorOutputKinds: ["operator-defined-v7"],
      }),
    ],
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.template.steps.map((step: any) => step.outputKind), [
    "operator-defined-v7",
    "operator-consumer-v7",
  ]);
});
