import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateRefusalCodes,
  recoveryDecision,
  type CandidateLoad,
  type RecoveryCandidate,
  type RecoveryPullRequestFacts,
} from "./base-drift-recovery-decision.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CURRENT = "c".repeat(40);

const candidate: RecoveryCandidate = {
  integratorTaskId: "integrator-1",
  readinessTaskId: "readiness-1",
  regressionTaskId: "regression-1",
  sourceRunId: "run-1",
  stopId: "stop-1",
  authorizationActivityId: "authorization-1",
  repository: "acme/widgets",
  prNumber: 123,
  targetBranch: "main",
  authorizedHeadSha: HEAD,
  authorizedBaseSha: BASE,
  observedBaseSha: CURRENT,
};

const snapshot = (overrides: Partial<RecoveryPullRequestFacts> = {}): RecoveryPullRequestFacts => ({
  repository: candidate.repository,
  number: candidate.prNumber,
  state: "OPEN",
  isDraft: false,
  merged: false,
  baseRefName: candidate.targetBranch,
  baseSha: CURRENT,
  headRefOid: HEAD,
  headCommitOid: HEAD,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  ...overrides,
});

const freshDecision = (overrides: Partial<Parameters<typeof recoveryDecision>[0] & { stage: "fresh" }> = {}) => recoveryDecision({
  stage: "fresh",
  candidate,
  snapshot: snapshot(),
  comparisonAvailable: true,
  authorizedAdvance: { status: "ahead", behindBy: 0 },
  observedAdvance: null,
  ...overrides,
});

test("all durable candidate refusal paths decide without a database", () => {
  assert.equal(candidateRefusalCodes.length, 16);
  for (const code of candidateRefusalCodes) {
    const load: CandidateLoad = {
      kind: "refused",
      code,
      stopId: "stop-1",
      ...(code === "authorization-invalid" ? { detail: "ambiguous" } : {}),
      ...(code === "target-unresolved" ? { detail: "repository" } : {}),
    };
    const decision = recoveryDecision({ stage: "candidate", load });
    assert.equal(decision.kind, code === "chain-active" ? "retry" : "ineligible", code);
    assert.notEqual("reason" in decision ? decision.reason : "", "", code);
  }
  assert.deepEqual(recoveryDecision({
    stage: "candidate",
    load: { kind: "refused", code: "target-branch-mismatch", stopId: "stop-1" },
  }), {
    kind: "ineligible",
    reason: "chain first-run target ref differs from the authorized base ref",
  });
});

test("all fresh pull-request refusal paths decide without a database", () => {
  const cases: Array<[string, Partial<RecoveryPullRequestFacts>, RegExp]> = [
    ["identity", { number: 124 }, /identity mismatches/u],
    ["state", { state: "CLOSED" }, /no longer an unmerged OPEN/u],
    ["draft", { isDraft: true }, /draft state changed/u],
    ["foreign merge", { autoMergeRequest: { enabledAt: "now", mergeMethod: "MERGE" } }, /automatic merge machinery/u],
    ["target", { baseRefName: "release" }, /target ref changed/u],
    ["head", { headRefOid: "d".repeat(40) }, /head changed/u],
    ["base", { baseSha: BASE }, /does not prove an advanced SHA/u],
  ];
  for (const [label, current, reason] of cases) {
    const decision = freshDecision({ snapshot: snapshot(current) });
    assert.equal(decision.kind, "ineligible", label);
    assert.match(decision.kind === "ineligible" ? decision.reason : "", reason, label);
  }
});

test("ancestry refusal, retry, queue, exhaustion, and skip are explicit decisions", () => {
  assert.equal(freshDecision({ comparisonAvailable: false }).kind, "ineligible");
  assert.equal(freshDecision({ authorizedAdvance: { status: "diverged", behindBy: 1 } }).kind, "ineligible");
  assert.equal(freshDecision({
    candidate: { ...candidate, observedBaseSha: "d".repeat(40) },
    observedAdvance: { status: "behind", behindBy: 1 },
  }).kind, "ineligible");
  assert.deepEqual(freshDecision(), { kind: "queue", candidate, currentBaseSha: CURRENT });

  assert.deepEqual(recoveryDecision({
    stage: "classification-retry",
    reason: "reader timeout",
    validationAttempts: 0,
    maxAttempts: 2,
  }), { kind: "retry", reason: "reader timeout", classificationAttempt: 1 });
  assert.equal(recoveryDecision({
    stage: "classification-retry",
    reason: "reader timeout",
    validationAttempts: 2,
    maxAttempts: 2,
  }).kind, "ineligible");

  assert.equal(recoveryDecision({
    stage: "durable",
    expected: candidate,
    load: { kind: "candidate", candidate },
    aggregateValidating: true,
    recoveryCount: 2,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "exhausted");
  assert.deepEqual(recoveryDecision({
    stage: "durable",
    expected: candidate,
    load: { kind: "candidate", candidate },
    aggregateValidating: false,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }), { kind: "skip" });
});
