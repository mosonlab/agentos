import assert from "node:assert/strict";
import test from "node:test";

import {
  isCanonicalAgentStep,
  isCanonicalBlindFindingsStep,
  isCanonicalBlindReviewStep,
  isLegacyCombinedBlindReviewStep,
  isCanonicalSolFindingsStep,
  canonicalOutputRefusal,
} from "./canonical-task-output.js";

const step = (template: string, stepIndex: number, outputKind: string) => ({
  taskTemplate: { name: template },
  stepIndex,
  outputKind,
});

test("canonical agent ranges stop before the new readiness and merge nodes", () => {
  for (const index of [1, 2, 3, 4, 5]) {
    assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", index, "implementation")), true);
  }
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow", index, "implementation")), true);
  }
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", 6, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", 7, "merge-result")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow", 11, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow", 12, "merge-result")), false);
});

test("legacy-v1 agent ranges remain authoritative at their old positions", () => {
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow-legacy-v1", 5, "must-fix")), true);
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow-legacy-v1", 6, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow-legacy-v1", 10, "documentation")), true);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow-legacy-v1", 11, "merge-authorization")), false);
});

test("the canonical graphs carry blind findings and no adjudication node", () => {
  assert.equal(isCanonicalBlindFindingsStep(step("direct-engineer-workflow", 3, "blind-findings")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow", 3, "blind-findings")), true);
  assert.equal(isCanonicalBlindFindingsStep(step("compound-engineer-workflow", 7, "blind-findings")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow", 3, "must-fix")), false);
  // The fix step owns the dispositions now, so no canonical node authors must-fix.
  assert.equal(isCanonicalBlindReviewStep(step("compound-engineer-workflow", 8, "must-fix")), false);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow", 4, "must-fix")), false);
});

test("the old combined review identity is recognized only under legacy-v1 names", () => {
  assert.equal(isLegacyCombinedBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("compound-engineer-workflow-legacy-v1", 7, "must-fix")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("direct-engineer-workflow", 3, "must-fix")), false);
  assert.equal(isLegacyCombinedBlindReviewStep(step("compound-engineer-workflow", 7, "must-fix")), false);
});

test("blind-findings is a versioned immutable review output and cannot be authored by another step", () => {
  const headSha = "a".repeat(40);
  const blindStep = step("direct-engineer-workflow", 3, "blind-findings");
  const body = JSON.stringify({
    schemaVersion: 1,
    headSha,
    reviewedBase: "b".repeat(40),
    reviewedHead: headSha,
    findings: [],
  });
  assert.equal(isCanonicalSolFindingsStep(step("direct-engineer-workflow", 2, "sol-findings")), true);
  assert.equal(canonicalOutputRefusal(blindStep, {
    runId: "run-1",
    kind: "blind-findings",
    body,
    commitSha: headSha,
    metadata: null,
  }, "run-1", headSha), null);
  assert.match(canonicalOutputRefusal(step("direct-engineer-workflow", 2, "sol-findings"), {
    runId: "run-1",
    kind: "blind-findings",
    body,
    commitSha: headSha,
    metadata: null,
  }, "run-1", headSha) ?? "", /does not match canonical kind/u);
});
