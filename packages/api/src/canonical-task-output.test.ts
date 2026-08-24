import assert from "node:assert/strict";
import test from "node:test";

import {
  isCanonicalAdjudicationStep,
  isCanonicalAgentStep,
  isCanonicalBlindFindingsStep,
  isCanonicalBlindReviewStep,
  isLegacyCombinedBlindReviewStep,
  isCanonicalSolFindingsStep,
  canonicalOutputRefusal,
  reviewAdjudicationClaimRefusal,
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

test("adjudication guards select the immediate predecessor review layer for Direct and Full", async () => {
  const cases = [
    { template: "direct-engineer-workflow", adjudicationStep: 4, adjudicationLayer: 3, reviewLayer: 2 },
    { template: "compound-engineer-workflow", adjudicationStep: 8, adjudicationLayer: 7, reviewLayer: 6 },
  ] as const;
  for (const candidate of cases) {
    let predecessorWhere: Record<string, unknown> | null = null;
    let siblingWhere: Record<string, unknown> | null = null;
    const tx = {
      task: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          predecessorWhere = args.where;
          return { chainLayer: candidate.reviewLayer };
        },
        findMany: async (args: { where: Record<string, unknown> }) => {
          siblingWhere = args.where;
          return [];
        },
      },
    } as never;
    const refusal = await reviewAdjudicationClaimRefusal(tx, {
      task: {
        id: "adjudication-task",
        projectId: "project-1",
        chainId: "chain-1",
        chainLayer: candidate.adjudicationLayer,
        templateStep: step(candidate.template, candidate.adjudicationStep, "must-fix"),
      },
      implementationBaseSha: "b".repeat(40),
      implementationHeadSha: "a".repeat(40),
    });
    assert.match(refusal ?? "", new RegExp(`layer ${candidate.reviewLayer}[^]*found 0`, "u"));
    assert.deepEqual(predecessorWhere?.chainLayer, { lt: candidate.adjudicationLayer });
    assert.equal(siblingWhere?.chainLayer, candidate.reviewLayer);
  }
});
