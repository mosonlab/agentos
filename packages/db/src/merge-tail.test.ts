import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MergeRecoveryStatus } from "@prisma/client";

import {
  defenseListReason,
  defenseTriggers,
  isMergeReadinessStep,
  mergeRecoveryPhase,
  mergeRecoveryTransitionAllowed,
  RECOVERY_TRANSITIONS,
  parseResolverResult,
  parseRegressionVerdict,
} from "./merge-tail.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("merge recovery state transitions and operator phases are explicit", () => {
  const statuses = Object.values(MergeRecoveryStatus);
  const declaredEdges = statuses.flatMap((from) => (
    [...RECOVERY_TRANSITIONS[from]].map((to) => `${from}->${to}`)
  ));
  assert.deepEqual(declaredEdges, [
    "VALIDATING->REPAIRING",
    "VALIDATING->FAILED",
    "REPAIRING->AWAITING_AUTHORIZATION",
    "REPAIRING->BLOCKED_DOWNSTREAM",
    "AWAITING_AUTHORIZATION->REPAIRING",
    "AWAITING_AUTHORIZATION->BLOCKED_DOWNSTREAM",
    "AWAITING_AUTHORIZATION->SUCCEEDED",
    "BLOCKED_DOWNSTREAM->REPAIRING",
    "FAILED->VALIDATING",
  ]);
  for (const from of statuses) {
    for (const to of statuses) {
      assert.equal(
        mergeRecoveryTransitionAllowed(from, to),
        from === to || RECOVERY_TRANSITIONS[from].has(to),
        `${from} -> ${to}`,
      );
    }
  }
  assert.deepEqual(Object.values(MergeRecoveryStatus).map((status) => mergeRecoveryPhase(status)), [
    "validation",
    "repair",
    "authorization-wait",
    "downstream-stop",
    "succeeded",
    "actual-failure",
  ]);
});

test("regression verdicts are exact-head, versioned, and fail closed", () => {
  const pass = parseRegressionVerdict(JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: A, baseHeadSha: B, gateVerdict: "PASS" }));
  assert.equal(pass.status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 1, outcome: "review-fail", headSha: A, baseHeadSha: B, summary: "MF-2 remains open",
  })).status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 1, outcome: "review-fail", headSha: A, baseHeadSha: B, summary: "  ",
  })).status, "invalid");
  assert.equal(parseRegressionVerdict(JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: A, baseHeadSha: B, gateVerdict: "FAIL" })).status, "invalid");
  assert.equal(parseRegressionVerdict("MERGE GATE: PASS").status, "invalid");
});

test("the narrowed Regression contract requires v2 while legacy output remains readable", () => {
  const v2 = JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${A}`,
  });
  const v1 = JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: A, baseHeadSha: B, gateVerdict: "PASS" });
  assert.equal(parseRegressionVerdict(v2, "regression-verification-v2").status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${B}`,
  }), "regression-verification-v2").status, "invalid");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "PASS",
  }), "regression-verification-v2").status, "invalid");
  assert.equal(parseRegressionVerdict(v1, "regression-verification").status, "ok");
  assert.equal(parseRegressionVerdict(v1, "regression-verification-v2").status, "invalid");
  assert.equal(parseRegressionVerdict(v2, "regression-verification").status, "invalid");
});

test("Regression v2 gate failures carry the complete Merge gate verdict", () => {
  const verdict = {
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (unit tests)",
    summary: "unit tests",
  };
  assert.equal(parseRegressionVerdict(JSON.stringify(verdict), "regression-verification-v2").status, "ok");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: A,
    baseHeadSha: B,
    gateVerdict: "FAIL",
    summary: "unit tests",
  }), "regression-verification-v2").status, "invalid");
});

test("readiness role is mechanical across template generations and ordinals", () => {
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 11, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow-legacy-v1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 11, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow-legacy-v1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 7, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow-legacy-pre-adjudication-ckt1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 12, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow-legacy-pre-adjudication-ckt1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 1, outputKind: "merge-authorization", taskTemplateName: "unrelated" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "approval", taskTemplateName: "direct-engineer-workflow" }), false);
});

test("merge-resolver results are versioned and head-bound", () => {
  assert.equal(parseResolverResult(JSON.stringify({
    schemaVersion: 1, outcome: "resolved", startHeadSha: A, targetHeadSha: B,
    resolvedHeadSha: B, tradeOffs: [], changedTestExpectations: [],
  })).status, "ok");
  for (const body of [undefined, "prose", JSON.stringify({ outcome: "resolved" }), JSON.stringify({
    schemaVersion: 1, outcome: "other", startHeadSha: A, targetHeadSha: B,
  })]) assert.equal(parseResolverResult(body).status, "invalid");
});

/** Test sources are not merge-tail machinery, so the inventory below skips them. */
const isTestSource = (path: string): boolean => (
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/u.test(path)
  || /(?:\.(?:dbtest|test|spec)|-test)\.[^.]+$/u.test(path)
);

test("the defense list covers tracked merge-tail machinery", () => {
  const tracked = execFileSync("git", ["-C", "../..", "ls-files"], { encoding: "utf8" })
    .trim().split("\n");
  const sourcePaths = tracked.filter((path) => (
    /^(?:packages\/api|packages\/db)\/src\/.*\.ts$/u.test(path) && !isTestSource(path)
  ));
  const sourcePatterns = [
    /import\s*(?:type\s*)?\{[^}]*\}\s*from "\.\/merge-tail\.js"/su,
    /\bRegressionRepairHandoff\b/u,
    /\bREGRESSION_VERIFICATION_KIND\b/u,
    /import\s*\{[^}]*\bhandleRegressionCompletion\b[^}]*\}\s*from "\.\/merge-tail-actions\.js"/su,
    /\bmergeTailLeaseChainId\(/u,
  ];
  const structuralPaths = sourcePaths.filter((path) => {
    const source = readFileSync(`../..\/${path}`, "utf8");
    return sourcePatterns.some((pattern) => pattern.test(source));
  });
  const regressionPromptPaths = tracked.filter((path) => (
    /^agents\/templates\/(?:direct|compound)-engineer-workflow\/\d+-regression-verification\.md$/u.test(path)
  ));
  const promptScriptPaths = regressionPromptPaths.flatMap((path) => (
    [...readFileSync(`../..\/${path}`, "utf8").matchAll(/`(scripts\/[^\s`]+)[\s`]/gu)]
      .flatMap((match) => match[1] ? [match[1]] : [])
  ));

  assert.ok(structuralPaths.length > 0);
  assert.ok(promptScriptPaths.length > 0);
  for (const path of new Set([...structuralPaths, ...promptScriptPaths])) {
    assert.notEqual(defenseListReason(path), null, path);
  }
  assert.equal(defenseListReason("apps/web/src/app.tsx"), null);
  assert.equal(defenseListReason("scripts/regression-verification.sh"), "merge-tail-machinery");
});

test("renames preserve guarded source identities", () => {
  assert.deepEqual(defenseTriggers([{
    filename: "packages/api/src/reader.ts",
    previousFilename: "packages/api/src/merge-readiness-worker.ts",
    patch: null,
  }]), [{ path: "packages/api/src/merge-readiness-worker.ts", reason: "merge-tail-machinery" }]);
});
