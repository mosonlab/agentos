import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { AssigneeType, type PrismaClient } from "@anneal/db";

import { resetTestDb, setupTestDb } from "./testdb.js";
import {
  readStepSnapshots,
  replaceRequest,
  seedAgent,
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
  assert.notEqual(result.body.error, code, JSON.stringify(result.body));
  assert.match(result.body.error, /Agent assignment.*invalid/u, JSON.stringify(result.body));
  assert.deepEqual(await readStepSnapshots(db, seed.template.id), before);
};

test("parallel approval gates are refused, while a gate alone in its layer succeeds", async () => {
  const seed = await seedAuthoringTemplate(db, "assignee-gate");
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "start" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "gate", approvalGate: true }),
      stepPayload(seed, 3, { layer: 2, outputKind: "sibling" }),
    ],
    "approval_gate_in_parallel_layer",
    2,
  );
  const valid = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1, outputKind: "start" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "gate", approvalGate: true }),
    ],
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});

test("Agent and human assignee facts are checked without a Repo grant", async () => {
  const seed = await seedAuthoringTemplate(db, "assignee-facts");
  const foreign = await seedAuthoringTemplate(db, "assignee-foreign");
  await db.agent.update({
    where: { id: seed.agents[1]!.id },
    data: { archivedAt: new Date() },
  });
  const cases = [
    { assigneeAgentId: null, code: "assignee_invalid" },
    { assigneeAgentId: randomUUID(), code: "assignee_invalid" },
    { assigneeAgentId: seed.agents[1]!.id, code: "assignee_invalid" },
    { assigneeAgentId: foreign.agents[0]!.id, code: "assignee_invalid" },
    { assigneeType: AssigneeType.HUMAN, assigneeAgentId: seed.agents[0]!.id, code: "assignee_invalid" },
  ] as const;
  for (const [index, candidate] of cases.entries()) {
    const { code, ...assignee } = candidate;
    await assertRefusal(
      seed,
      [
        stepPayload(seed, 1, { layer: 1, outputKind: `start-${index}` }),
        stepPayload(seed, 2, {
          layer: 2,
          outputKind: `invalid-${index}`,
          ...assignee,
        }),
      ],
      code,
      2,
    );
  }
  const valid = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [stepPayload(seed, 1, { layer: 1, outputKind: "valid-no-grant" })],
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});

test("integrator binding is bidirectional and assignee errors win", async () => {
  const seed = await seedAuthoringTemplate(db, "assignee-integrator");
  const sentinel = await seedAgent(db, seed, "merge-integrator");
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "start" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "merge-result", assigneeAgentId: seed.agents[0]!.id }),
    ],
    "integrator_binding_invalid",
    2,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "start" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "ordinary", assigneeAgentId: sentinel.id }),
    ],
    "integrator_binding_invalid",
    2,
  );
  await assertRefusal(
    seed,
    [
      stepPayload(seed, 1, { layer: 1, outputKind: "start" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "merge-result", assigneeAgentId: null }),
    ],
    "assignee_invalid",
    2,
  );
  const valid = await replaceRequest(db, seed.project.id, seed.template.id, {
    steps: [
      stepPayload(seed, 1, { layer: 1, outputKind: "start" }),
      stepPayload(seed, 2, { layer: 2, outputKind: "merge-result", assigneeAgentId: sentinel.id }),
    ],
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});
