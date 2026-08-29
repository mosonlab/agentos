import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import {
  candidateRefusalCodes,
  classifyCandidate,
  classifyDurable,
  classifyFresh,
  classifyRetryBudget,
  type CandidateLoad,
  type FreshRecoveryFacts,
  type RecoveryCandidate,
  type RecoveryPullRequestFacts,
} from "./base-drift-recovery-decision.js";
import { settleRecovery } from "./merge-base-drift-worker.js";

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
    const decision = classifyCandidate(load);
    assert.equal(decision.kind, code === "chain-active" ? "retry" : "ineligible", code);
    assert.notEqual("reason" in decision ? decision.reason : "", "", code);
  }
  assert.deepEqual(classifyCandidate({
    kind: "refused", code: "target-branch-mismatch", stopId: "stop-1",
  }), {
    kind: "ineligible",
    reason: "chain first-run target ref differs from the authorized base ref",
    stopId: "stop-1",
  });
});

test("candidate classification narrows skip and inspect outcomes", () => {
  assert.deepEqual(classifyCandidate({ kind: "skip" }), { kind: "skip" });
  assert.deepEqual(classifyCandidate({ kind: "candidate", candidate }), { kind: "inspect", candidate });
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
    load: { kind: "candidate", candidate },
    aggregateValidating: true,
    recoveryCount: 2,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "exhausted");
  assert.deepEqual(classifyDurable({
    expected: candidate,
    load: { kind: "candidate", candidate },
    aggregateValidating: false,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }), { kind: "skip" });
  assert.equal(classifyDurable({
    expected: candidate,
    load: { kind: "refused", code: "chain-active", stopId: candidate.stopId },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "retry");
  assert.equal(classifyDurable({
    expected: candidate,
    load: { kind: "candidate", candidate: { ...candidate, sourceRunId: "run-2" } },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }).kind, "ineligible");
  assert.deepEqual(classifyDurable({
    expected: candidate,
    load: { kind: "candidate", candidate },
    aggregateValidating: true,
    recoveryCount: 0,
    maxRecoveries: 2,
    currentBaseSha: CURRENT,
  }), { kind: "queue", candidate, currentBaseSha: CURRENT });
});

test("settleRecovery maps persistence outcomes to tick deltas without a database", async () => {
  const calls: string[] = [];
  let retryOutcome: "retryable" | "ineligible" | "skipped" = "retryable";
  let ineligibleSettled = false;
  const operations = {
    recordRetry: async (
      _db: PrismaClient,
      taskId: string,
      stopId: string,
      reason: string,
    ): Promise<"retryable" | "ineligible" | "skipped"> => {
      calls.push(`retry:${taskId}:${stopId}:${reason}`);
      return retryOutcome;
    },
    settleIneligible: async (
      _db: PrismaClient,
      taskId: string,
      stopId: string,
      reason: string,
      identity?: Partial<RecoveryCandidate>,
    ): Promise<boolean> => {
      calls.push(`ineligible:${taskId}:${stopId}:${reason}:${identity?.repository ?? "none"}`);
      return ineligibleSettled;
    },
  };
  const db = {} as PrismaClient;
  const task = { id: "integrator-1", identity: candidate };

  assert.deepEqual(await settleRecovery(
    db, task, candidate.stopId, { kind: "retry", reason: "reader timeout" }, operations,
  ), { recovered: 0, exhausted: 0, ineligible: 0 });
  retryOutcome = "ineligible";
  assert.deepEqual(await settleRecovery(
    db, task, candidate.stopId, { kind: "retry", reason: "reader unavailable" }, operations,
  ), { recovered: 0, exhausted: 0, ineligible: 1 });
  assert.deepEqual(await settleRecovery(
    db, task, candidate.stopId, { kind: "ineligible", reason: "head changed" }, operations,
  ), { recovered: 0, exhausted: 0, ineligible: 0 });
  ineligibleSettled = true;
  assert.deepEqual(await settleRecovery(
    db, task, candidate.stopId, { kind: "ineligible", reason: "base changed" }, operations,
  ), { recovered: 0, exhausted: 0, ineligible: 1 });
  assert.deepEqual(await settleRecovery(
    db, task, candidate.stopId, { kind: "recovered" }, operations,
  ), { recovered: 1, exhausted: 0, ineligible: 0 });
  assert.deepEqual(await settleRecovery(
    db, task, candidate.stopId, { kind: "exhausted" }, operations,
  ), { recovered: 0, exhausted: 1, ineligible: 0 });
  assert.deepEqual(await settleRecovery(
    db, task, candidate.stopId, { kind: "skip" }, operations,
  ), { recovered: 0, exhausted: 0, ineligible: 0 });
  assert.deepEqual(calls, [
    "retry:integrator-1:stop-1:reader timeout",
    "retry:integrator-1:stop-1:reader unavailable",
    "ineligible:integrator-1:stop-1:head changed:acme/widgets",
    "ineligible:integrator-1:stop-1:base changed:acme/widgets",
  ]);
});
