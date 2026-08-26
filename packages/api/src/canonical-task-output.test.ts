import assert from "node:assert/strict";
import test from "node:test";

import {
  isCanonicalAgentStep,
  isCanonicalBlindFindingsStep,
  isCanonicalBlindReviewStep,
  isLegacyCombinedBlindReviewStep,
  isCanonicalSolFindingsStep,
  isCanonicalFixStep,
  canonicalOutputRefusal,
  requiredOutputKind,
} from "./canonical-task-output.js";

const step = (template: string, stepIndex: number, outputKind: string) => ({
  taskTemplate: { name: template },
  stepIndex,
  outputKind,
});

test("agent-authored roles stop before readiness and integrator roles", () => {
  for (const outputKind of ["implementation", "blind-findings", "fixed-implementation", "regression-verification-v2"]) {
    assert.equal(isCanonicalAgentStep(step("any-template-generation", 99, outputKind)), true);
  }
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", 6, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow", 7, "merge-result")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow", 5, "unregistered")), false);
});

test("legacy agent roles remain authoritative without ordinal matching", () => {
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow-legacy-v1", 5, "must-fix")), true);
  assert.equal(isCanonicalAgentStep(step("direct-engineer-workflow-legacy-v1", 6, "merge-authorization")), false);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow-legacy-v1", 100, "documentation")), true);
  assert.equal(isCanonicalAgentStep(step("compound-engineer-workflow-legacy-v1", 11, "merge-authorization")), false);
});

test("Regression v2 is canonical while the rolled v1 contract remains readable", () => {
  const headSha = "a".repeat(40);
  const baseHeadSha = "b".repeat(40);
  const current = step("direct-engineer-workflow", 5, "regression-verification-v2");
  const legacy = step(
    "direct-engineer-workflow-legacy-pre-narrow-regression-lease-template-1",
    5,
    "regression-verification",
  );
  const output = (kind: string, schemaVersion: number, bodyOverrides: Record<string, unknown> = {}) => ({
    runId: "run-1",
    kind,
    body: JSON.stringify({
      schemaVersion,
      outcome: "pass",
      headSha,
      baseHeadSha,
      gateVerdict: "PASS",
      ...(schemaVersion === 2 ? { gateProof: `MERGE GATE: PASS ${headSha}` } : {}),
      ...bodyOverrides,
    }),
    commitSha: headSha,
    metadata: null,
  });

  assert.equal(requiredOutputKind(current), "regression-verification-v2");
  assert.equal(canonicalOutputRefusal(current, output("regression-verification-v2", 2), "run-1", headSha), null);
  assert.match(
    canonicalOutputRefusal(current, output("regression-verification-v2", 1), "run-1", headSha) ?? "",
    /schemaVersion 2/u,
  );
  assert.match(
    canonicalOutputRefusal(current, output("regression-verification-v2", 2, {
      gateProof: `MERGE GATE: PASS ${baseHeadSha}`,
    }), "run-1", headSha) ?? "",
    /gate proof oid must match headSha/u,
  );
  assert.match(
    canonicalOutputRefusal(current, output("regression-verification-v2", 2, {
      gateProof: undefined,
    }), "run-1", headSha) ?? "",
    /gateProof/u,
  );
  assert.equal(isCanonicalAgentStep(legacy), true);
  assert.equal(requiredOutputKind(legacy), "regression-verification");
  assert.equal(canonicalOutputRefusal(legacy, output("regression-verification", 1), "run-1", headSha), null);
});

test("the canonical graphs carry blind findings and no adjudication node", () => {
  assert.equal(isCanonicalBlindFindingsStep(step("direct-engineer-workflow", 3, "blind-findings")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow", 3, "blind-findings")), true);
  assert.equal(isCanonicalBlindFindingsStep(step("compound-engineer-workflow", 7, "blind-findings")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow", 4, "fixed-implementation")), false);
});

test("the retired combined review role is recognized by output kind", () => {
  assert.equal(isLegacyCombinedBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("compound-engineer-workflow-legacy-v1", 7, "must-fix")), true);
  assert.equal(isCanonicalBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("any-template-generation", 99, "must-fix")), true);
  assert.equal(isLegacyCombinedBlindReviewStep(step("direct-engineer-workflow-legacy-v1", 3, "blind-findings")), false);
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

test("a fixed-implementation output must close exactly the findings it adopted", () => {
  const headSha = "a".repeat(40);
  const sourceHead = "b".repeat(40);
  const fixStep = step("compound-engineer-workflow", 8, "fixed-implementation");
  assert.equal(isCanonicalFixStep(fixStep), true);
  assert.equal(isCanonicalFixStep(step("compound-engineer-workflow", 99, "fixed-implementation")), true);
  assert.equal(isCanonicalFixStep(step("compound-engineer-workflow", 8, "documentation")), false);
  assert.equal(isCanonicalFixStep(step("direct-engineer-workflow", 4, "fixed-implementation")), true);
  const artifact = (overrides: Record<string, unknown>) => JSON.stringify({
    schemaVersion: 1,
    headSha,
    sourceHead,
    dispositions: [],
    closedFindings: [],
    testsRun: ["focused"],
    residualRisks: [],
    ...overrides,
  });
  const refusalFor = (body: string) => canonicalOutputRefusal(fixStep, {
    runId: "run-1",
    kind: "fixed-implementation",
    body,
    commitSha: headSha,
    metadata: null,
  }, "run-1", headSha) ?? "";

  assert.equal(refusalFor(artifact({})), "");
  assert.match(refusalFor(artifact({
    dispositions: [
      { id: "SOL-1", disposition: "ADOPTED", reason: "real" },
      { id: "SOL-1", disposition: "REJECTED", reason: "second opinion" },
    ],
    closedFindings: [{ id: "SOL-1", status: "CLOSED", codeEvidence: "patch", testEvidence: "test" }],
  })), /dispositions contain duplicate ids: SOL-1/u);
  assert.match(refusalFor(artifact({
    dispositions: [{ id: "SOL-1", disposition: "ADOPTED", reason: "real" }],
    closedFindings: [],
  })), /must exactly cover the ADOPTED dispositions/u);
  assert.match(refusalFor(artifact({
    dispositions: [{ id: "SOL-1", disposition: "REJECTED", reason: "unreachable" }],
    closedFindings: [{ id: "SOL-1", status: "CLOSED", codeEvidence: "patch", testEvidence: "test" }],
  })), /must exactly cover the ADOPTED dispositions/u);
  assert.equal(refusalFor(artifact({
    dispositions: [
      { id: "SOL-1", disposition: "ADOPTED", reason: "real" },
      { id: "BLIND-1", disposition: "REJECTED", reason: "unreachable" },
    ],
    closedFindings: [{ id: "SOL-1", status: "CLOSED", codeEvidence: "patch", testEvidence: "test" }],
  })), "");
});
