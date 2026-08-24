import assert from "node:assert/strict";
import test from "node:test";

import {
  isCanonicalAdjudicationStep,
  isCanonicalAgentStep,
  isCanonicalBlindFindingsStep,
  isCanonicalBlindReviewStep,
  isLegacyCombinedBlindReviewStep,
} from "./canonical-task-output.js";

const step = (template: string, stepIndex: number, outputKind: string) => ({
  taskTemplate: { name: template },
  stepIndex,
  outputKind,
});

test("canonical agent ranges stop before the new readiness and merge nodes", () => {
  for (const index of [1, 2, 3, 4, 5, 6]) {
    assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", index, "implementation")), true);
  }
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow", index, "implementation")), true);
  }
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", 7, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", 8, "merge-result")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow", 12, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow", 13, "merge-result")), false);
});

test("legacy-v1 agent ranges remain authoritative at their old positions", () => {
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow-legacy-v1", 5, "must-fix")), true);
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow-legacy-v1", 6, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow-legacy-v1", 10, "documentation")), true);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow-legacy-v1", 11, "merge-authorization")), false);
});

test("blind and adjudication identities are split on canonical graphs", () => {
  assert.equal(isCanonicalBlindFindingsStep(step("direct-engineer-workflow", 3, "blind-findings")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow", 3, "blind-findings")), true);
  assert.equal(isCanonicalAdjudicationStep(step("direct-engineer-workflow", 4, "must-fix")), true);
  assert.equal(isCanonicalBlindFindingsStep(step("compound-engineer-workflow", 7, "blind-findings")), true);
  assert.equal(isCanonicalAdjudicationStep(step("compound-engineer-workflow", 8, "must-fix")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow", 3, "must-fix")), false);
  assert.equal(isCanonicalAdjudicationStep(step("compound-engineer-workflow", 7, "must-fix")), false);
});

test("the old combined review identity is recognized only under legacy-v1 names", () => {
  assert.equal(isLegacyCombinedBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("compound-engineer-workflow-legacy-v1", 7, "must-fix")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("direct-engineer-workflow", 3, "must-fix")), false);
  assert.equal(isLegacyCombinedBlindReviewStep(step("compound-engineer-workflow", 7, "must-fix")), false);
});
