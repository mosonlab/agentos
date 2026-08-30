import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateRefusalCodes,
  classifyCandidate,
  classifyDurable,
  classifyFresh,
  classifyRetryBudget,
  type DurableCandidateFacts,
  type FreshRecoveryFacts,
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

type SnapshotFacts = Extract<FreshRecoveryFacts, { kind: "snapshot" }>;

const freshDecision = (overrides: Partial<SnapshotFacts> = {}) => classifyFresh({
  kind: "snapshot",
  candidate,
  snapshot: snapshot(),
  comparisonAvailable: true,
  authorizedAdvance: { status: "ahead", behindBy: 0 },
  observedAdvance: null,
  ...overrides,
});

const durableFacts = (): DurableCandidateFacts => ({
  task: {
    id: candidate.integratorTaskId,
    chainId: "chain-1",
    chainIndex: 3,
    repoId: "repo-1",
    repositoryPresent: true,
    status: "REVIEW",
    isIntegratorStep: true,
  },
  stop: {
    stopId: candidate.stopId,
    condition: "base-drift",
    evidence: JSON.stringify({ observed: CURRENT, authorized: BASE }),
    sourceRunId: candidate.sourceRunId,
  },
  existingAttempt: null,
  sourceRun: {
    id: candidate.sourceRunId,
    taskId: candidate.integratorTaskId,
    status: "SUCCEEDED",
    hasSession: true,
  },
  activeRunCount: 0,
  output: {
    runId: candidate.sourceRunId,
    kind: "merge-result",
    outcome: "stopped",
    condition: "base-drift",
    evidence: JSON.stringify({ observed: CURRENT, authorized: BASE }),
  },
  readiness: {
    id: candidate.readinessTaskId,
    status: "DONE",
    isReadinessStep: true,
    outputCommitSha: HEAD,
  },
  regression: { id: candidate.regressionTaskId, status: "DONE" },
  authorizationSelection: {
    authorization: {
      activityId: candidate.authorizationActivityId,
      repository: candidate.repository,
      prNumber: candidate.prNumber,
      headSha: HEAD,
      baseSha: BASE,
      baseRef: candidate.targetBranch,
    },
    refusal: null,
  },
  intents: [{
    sourceRunId: candidate.sourceRunId,
    authorizationActivityId: candidate.authorizationActivityId,
    prNumber: candidate.prNumber,
    headSha: HEAD,
  }],
  target: { resolved: true, repository: candidate.repository, prNumber: candidate.prNumber },
  firstRunTargetRef: candidate.targetBranch,
});

test("durable candidate facts decide every refusal without a database", () => {
  const cases: Array<{
    code: typeof candidateRefusalCodes[number];
    reason: string;
    change: (facts: DurableCandidateFacts) => void;
  }> = [
    { code: "identity-incomplete", reason: "chain or repository identity is incomplete", change: (facts) => { facts.task!.chainId = null; } },
    { code: "source-run-unbound", reason: "stop is not bound to an executor run", change: (facts) => { facts.stop!.sourceRunId = null; } },
    { code: "evidence-invalid", reason: "base-drift evidence is malformed or is not a SHA-only drift payload", change: (facts) => { facts.stop!.evidence = "{}"; } },
    { code: "source-run-mismatch", reason: "source executor run identity or terminal state does not match the stop", change: (facts) => { facts.sourceRun!.hasSession = false; } },
    { code: "chain-active", reason: "the chain has an active foreign run while recovery is being classified", change: (facts) => { facts.activeRunCount = 1; } },
    { code: "output-mismatch", reason: "executor output does not exactly match the recorded source stop", change: (facts) => { facts.output!.runId = "run-2"; } },
    { code: "tail-unresolved", reason: "current direct/compound regression and readiness tail cannot be resolved", change: (facts) => { facts.readiness = null; } },
    { code: "tail-state-mismatch", reason: "merge tail task state is not the completed-readiness/stopped-executor shape", change: (facts) => { facts.regression!.status = "TODO"; } },
    { code: "authorization-invalid", reason: "authorized readiness evidence is ambiguous-tie", change: (facts) => { facts.authorizationSelection = { authorization: null, refusal: "ambiguous-tie" }; } },
    { code: "intent-count", reason: "source executor run has multiple server-bound merge intents", change: (facts) => { facts.intents!.push({ ...facts.intents![0] }); } },
    { code: "intent-mismatch", reason: "executor intent does not match the selected authorization", change: (facts) => { facts.intents![0]!.headSha = "d".repeat(40); } },
    { code: "authorized-base-mismatch", reason: "stop evidence does not match the authorized base SHA", change: (facts) => { facts.authorizationSelection!.authorization!.baseSha = "d".repeat(40); } },
    { code: "readiness-head-mismatch", reason: "readiness output does not match the authorized head SHA", change: (facts) => { facts.readiness!.outputCommitSha = "d".repeat(40); } },
    { code: "target-unresolved", reason: "pull-request identity is repository", change: (facts) => { facts.target = { resolved: false, unresolvable: "repository" }; } },
    { code: "target-mismatch", reason: "resolved repository or pull-request identity differs from the authorization", change: (facts) => { facts.target = { resolved: true, repository: candidate.repository, prNumber: 124 }; } },
    { code: "target-branch-mismatch", reason: "chain first-run target ref differs from the authorized base ref", change: (facts) => { facts.firstRunTargetRef = "release"; } },
  ];
  assert.equal(cases.length, candidateRefusalCodes.length);
  assert.deepEqual(cases.map(({ code }) => code), [...candidateRefusalCodes]);
  for (const refusal of cases) {
    const facts = durableFacts();
    refusal.change(facts);
    assert.deepEqual(classifyCandidate(facts), {
      kind: refusal.code === "chain-active" ? "retry" : "ineligible",
      code: refusal.code,
      reason: refusal.reason,
      stopId: candidate.stopId,
    });
  }
});

test("durable candidate classification narrows skip and inspect outcomes", () => {
  const missingTask = durableFacts();
  missingTask.task = null;
  assert.deepEqual(classifyCandidate(missingTask), { kind: "skip" });
  const terminalAttempt = durableFacts();
  terminalAttempt.existingAttempt = { status: "FAILED", reopenableLegacyRefusal: false };
  assert.deepEqual(classifyCandidate(terminalAttempt), { kind: "skip" });
  assert.deepEqual(classifyCandidate(durableFacts()), { kind: "inspect", candidate });
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

test("fresh classification narrows reader facts and snapshot outcomes", () => {
  assert.deepEqual(classifyFresh({ kind: "reader-unavailable" }), {
    kind: "retry",
    reason: "server-side GitHub reader is unavailable",
  });
  assert.deepEqual(classifyFresh({ kind: "reader-failure", reason: "reader timeout" }), {
    kind: "retry",
    reason: "reader timeout",
  });
  assert.equal(freshDecision({ comparisonAvailable: false }).kind, "ineligible");
  assert.equal(freshDecision({ authorizedAdvance: { status: "diverged", behindBy: 1 } }).kind, "ineligible");
  assert.equal(freshDecision({
    candidate: { ...candidate, observedBaseSha: "d".repeat(40) },
    observedAdvance: { status: "behind", behindBy: 1 },
  }).kind, "ineligible");
  assert.deepEqual(freshDecision(), { kind: "queue", candidate, currentBaseSha: CURRENT });
});

test("retry-budget classification narrows retry and ineligible outcomes", () => {
  assert.deepEqual(classifyRetryBudget({
    reason: "reader timeout",
    validationAttempts: 0,
    maxAttempts: 2,
  }), { kind: "retry", reason: "reader timeout", classificationAttempt: 1 });
  assert.equal(classifyRetryBudget({
    reason: "reader timeout",
    validationAttempts: 2,
    maxAttempts: 2,
  }).kind, "ineligible");
});

test("durable classification narrows skip, retry, ineligible, exhausted, and queue outcomes", () => {
  assert.equal(classifyDurable({
    expected: candidate,
    candidateDecision: { kind: "inspect", candidate },
    aggregateValidating: true,
    recoveryCount: 2,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "exhausted");
  assert.deepEqual(classifyDurable({
    expected: candidate,
    candidateDecision: { kind: "inspect", candidate },
    aggregateValidating: false,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }), { kind: "skip" });
  assert.equal(classifyDurable({
    expected: candidate,
    candidateDecision: {
      kind: "retry",
      code: "chain-active",
      stopId: candidate.stopId,
      reason: "the chain has an active foreign run while recovery is being classified",
    },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "retry");
  assert.equal(classifyDurable({
    expected: candidate,
    candidateDecision: { kind: "inspect", candidate: { ...candidate, sourceRunId: "run-2" } },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "ineligible");
  assert.deepEqual(classifyDurable({
    expected: candidate,
    candidateDecision: { kind: "inspect", candidate },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }), { kind: "queue", candidate, currentBaseSha: CURRENT });
});
