import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MergeRecoveryStatus } from "@prisma/client";

import {
  defenseListReason,
  defenseTriggers,
  isTestPath,
  isMergeReadinessStep,
  mergeRecoveryPhase,
  mergeRecoveryTransitionAllowed,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_FINDING_TEXT,
  parseIndependentReviewDecision,
  parseResolverResult,
  parseRegressionVerdict,
  resolutionTestTriggers,
} from "./merge-tail.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("merge recovery state transitions and operator phases are explicit", () => {
  assert.equal(mergeRecoveryTransitionAllowed(MergeRecoveryStatus.VALIDATING, MergeRecoveryStatus.REPAIRING), true);
  assert.equal(mergeRecoveryTransitionAllowed(MergeRecoveryStatus.VALIDATING, MergeRecoveryStatus.FAILED), true);
  assert.equal(mergeRecoveryTransitionAllowed(MergeRecoveryStatus.REPAIRING, MergeRecoveryStatus.AWAITING_AUTHORIZATION), true);
  assert.equal(mergeRecoveryTransitionAllowed(MergeRecoveryStatus.AWAITING_AUTHORIZATION, MergeRecoveryStatus.REPAIRING), true);
  assert.equal(mergeRecoveryTransitionAllowed(MergeRecoveryStatus.AWAITING_AUTHORIZATION, MergeRecoveryStatus.SUCCEEDED), true);
  assert.equal(mergeRecoveryTransitionAllowed(MergeRecoveryStatus.SUCCEEDED, MergeRecoveryStatus.REPAIRING), false);
  assert.equal(mergeRecoveryTransitionAllowed(MergeRecoveryStatus.FAILED, MergeRecoveryStatus.VALIDATING), false);
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

test("both canonical readiness steps are mechanical server-owned shapes", () => {
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 11, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow-legacy-v1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 11, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow-legacy-v1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 7, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow-legacy-pre-adjudication-ckt1" }), true);
  assert.equal(isMergeReadinessStep({ stepIndex: 12, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow-legacy-pre-adjudication-ckt1" }), true);
  // The renamed rows keep only their own ordinal; the current one is not theirs.
  assert.equal(isMergeReadinessStep({ stepIndex: 6, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow-legacy-pre-adjudication-ckt1" }), false);
  assert.equal(isMergeReadinessStep({ stepIndex: 11, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow-legacy-pre-adjudication-ckt1" }), false);
  // The adjudication-era ordinals belong to the renamed rows, never to the canonical names.
  assert.equal(isMergeReadinessStep({ stepIndex: 7, outputKind: "merge-authorization", taskTemplateName: "direct-engineer-workflow" }), false);
  assert.equal(isMergeReadinessStep({ stepIndex: 12, outputKind: "merge-authorization", taskTemplateName: "compound-engineer-workflow" }), false);
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

test("the defense list covers tracked merge-tail machinery", () => {
  const tracked = execFileSync("git", ["-C", "../..", "ls-files"], { encoding: "utf8" })
    .trim().split("\n");
  const sourcePaths = tracked.filter((path) => (
    /^(?:packages\/api|packages\/db)\/src\/.*\.ts$/u.test(path) && !isTestPath(path)
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
});

test("resolution review triggers only when existing test lines changed", () => {
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", previousFilename: null, patch: "@@ -1,0 +2 @@\n+added" }]), []);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }]), [
    { path: "src/a.test.ts", reason: "existing-test-lines-modified" },
  ]);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.ts", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new" }]), []);
  assert.deepEqual(resolutionTestTriggers([{ filename: "src/a.test.ts", previousFilename: null, patch: null }]), [
    { path: "src/a.test.ts", reason: "existing-test-lines-unverifiable" },
  ]);
  assert.deepEqual(resolutionTestTriggers([{
    filename: "scripts/renamed.mjs", previousFilename: "scripts/merge-integrator-system-test.mjs",
    patch: "@@ -1 +1 @@\n-old\n+new",
  }]), [{ path: "scripts/merge-integrator-system-test.mjs", reason: "existing-test-lines-modified" }]);
});

test("the test-path predicate covers the repository's tracked test inventory", () => {
  const tracked = execFileSync("git", ["-C", "../..", "ls-files"], { encoding: "utf8" })
    .trim().split("\n")
    .filter((path) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.(?:dbtest|test|spec)|-test)\.[^.]+$/u.test(path));
  assert.ok(tracked.includes("scripts/merge-integrator-system-test.mjs"));
  for (const path of tracked) assert.equal(isTestPath(path), true, path);
});

test("renames preserve guarded source identities", () => {
  assert.deepEqual(defenseTriggers([{
    filename: "packages/api/src/reader.ts",
    previousFilename: "packages/api/src/merge-readiness-worker.ts",
    patch: null,
  }]), [{ path: "packages/api/src/merge-readiness-worker.ts", reason: "merge-tail-machinery" }]);
});

const reviewBody = (findings: unknown[], headSha = A) => JSON.stringify({ schemaVersion: 1, headSha, findings });

const blocking = {
  severity: "blocking",
  title: "rollback loses the predecessor row",
  detail: "the compensating write runs outside the transaction",
  reachability: "reached whenever the second write fails after the first commits",
};
const followUp = { severity: "follow-up", title: "spec drift", detail: "the comment names a field that no caller reads" };

test("an empty findings array is the approval", () => {
  const parsed = parseIndependentReviewDecision(reviewBody([]), A);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.status === "ok" && parsed.decision.outcome, "approved");
  assert.equal(parsed.status === "ok" && parsed.decision.blockingSummary, "");
});

test("only follow-up findings accept the head with follow-ups instead of rejecting it", () => {
  const parsed = parseIndependentReviewDecision(reviewBody([followUp, followUp]), A);
  assert.equal(parsed.status === "ok" && parsed.decision.outcome, "accepted-with-followups");
  assert.equal(parsed.status === "ok" && parsed.decision.findings.length, 2);
});

test("one blocking finding rejects the head and its summary carries every blocking finding", () => {
  const parsed = parseIndependentReviewDecision(reviewBody([followUp, blocking]), A);
  assert.equal(parsed.status === "ok" && parsed.decision.outcome, "rejected");
  assert.equal(
    parsed.status === "ok" && parsed.decision.blockingSummary,
    `${blocking.title}: ${blocking.detail}`,
  );
});

test("a blocking finding without a reachability argument voids the decision", () => {
  const { reachability, ...unproven } = blocking;
  assert.equal(reachability.length > 0, true);
  const parsed = parseIndependentReviewDecision(reviewBody([unproven]), A);
  assert.equal(parsed.status, "invalid");
  assert.match(parsed.status === "invalid" ? parsed.reason : "", /reachability/u);
});

test("a decision bound to another head, or with no findings array, is invalid", () => {
  assert.equal(parseIndependentReviewDecision(reviewBody([], B), A).status, "invalid");
  assert.equal(parseIndependentReviewDecision(JSON.stringify({ schemaVersion: 1, headSha: A }), A).status, "invalid");
  assert.equal(parseIndependentReviewDecision(JSON.stringify({ schemaVersion: 2, headSha: A, findings: [] }), A).status, "invalid");
  assert.equal(parseIndependentReviewDecision("not json", A).status, "invalid");
  assert.equal(parseIndependentReviewDecision(null, A).status, "invalid");
});

test("a finding with an unknown severity or an empty title is invalid", () => {
  assert.equal(parseIndependentReviewDecision(reviewBody([{ ...followUp, severity: "must-fix" }]), A).status, "invalid");
  assert.equal(parseIndependentReviewDecision(reviewBody([{ ...followUp, title: "  " }]), A).status, "invalid");
  assert.equal(parseIndependentReviewDecision(reviewBody([{ ...followUp, detail: "" }]), A).status, "invalid");
});

test("a decision with more findings than one range can carry, or an over-long field, is invalid", () => {
  const many = Array.from({ length: MAX_REVIEW_FINDINGS + 1 }, () => followUp);
  assert.equal(parseIndependentReviewDecision(reviewBody(many), A).status, "invalid");
  assert.equal(parseIndependentReviewDecision(reviewBody(Array.from({ length: MAX_REVIEW_FINDINGS }, () => followUp)), A).status, "ok");
  const long = { ...followUp, detail: "d".repeat(MAX_REVIEW_FINDING_TEXT + 1) };
  assert.equal(parseIndependentReviewDecision(reviewBody([long]), A).status, "invalid");
});

test("an authority-resign verdict is a first-class outcome and still needs its summary", () => {
  const parsed = parseRegressionVerdict(JSON.stringify({
    schemaVersion: 1, outcome: "authority-resign", headSha: A, baseHeadSha: B,
    summary: "added packages/db/prisma/migrations/20260826000000_x/migration.sql",
  }));
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.status === "ok" ? parsed.verdict.outcome : null, "authority-resign");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 1, outcome: "authority-resign", headSha: A, baseHeadSha: B, summary: "   ",
  })).status, "invalid");
  assert.equal(parseRegressionVerdict(JSON.stringify({
    schemaVersion: 1, outcome: "authority-resign", headSha: A, baseHeadSha: B,
  })).status, "invalid");
});
