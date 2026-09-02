import assert from "node:assert/strict";
import test from "node:test";

import { gateSlotOf, type GateSlot } from "./gate-slot.js";

const slot = (outputKind: string, taskTemplateName?: string): GateSlot | null => gateSlotOf({
  outputKind,
  ...(taskTemplateName === undefined ? {} : { taskTemplateName }),
});

test("gateSlotOf resolves specification and merge slots across output-kind generations", () => {
  const cases: Array<[string, GateSlot]> = [
    ["spec", "spec"],
    ["spec-v2", "spec"],
    ["spec-v99", "spec"],
    ["merge-authorization", "merge"],
    ["merge-authorization-v2", "merge"],
    ["merge-authorization-v99", "merge"],
  ];

  for (const [outputKind, expected] of cases) {
    assert.equal(slot(outputKind), expected, outputKind);
  }

  // Legacy template names do not need special handling: the structural role
  // is the same for canonical and retired template rows.
  assert.equal(slot("spec", "compound-engineer-workflow-legacy-v1"), "spec");
  assert.equal(slot("merge-authorization", "direct-engineer-workflow-legacy-pre-adjudication-ckt1"), "merge");
});

test("gateSlotOf returns null for nullish input and every non-slot role", () => {
  assert.equal(gateSlotOf(null), null);
  assert.equal(gateSlotOf(undefined), null);
  for (const outputKind of [
    "revalidation",
    "plan",
    "plan-review",
    "revised-plan",
    "implementation",
    "regression-verification",
    "regression-verification-v2",
    "merge-result",
    "unknown-v2",
  ]) {
    assert.equal(slot(outputKind), null, outputKind);
  }
});
