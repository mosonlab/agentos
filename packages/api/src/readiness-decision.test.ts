import assert from "node:assert/strict";
import test from "node:test";

import type { MergeEvidence } from "@agentos/db";

import { readinessDecision, type ReadinessInput } from "./readiness-decision.js";
import type { PullRequestSnapshot } from "./github-read.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = new Date("2026-08-26T12:00:00.000Z");

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "mosonlab/agentos",
  number: 42,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "main",
  headRefOid: HEAD,
  baseSha: BASE,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: [],
  checkContexts: [],
  headCommitOid: HEAD,
  readAt: NOW.toISOString(),
  ...overrides,
});

const evidence: MergeEvidence = {
  schemaVersion: 2,
  nonce: "nonce",
  repository: "mosonlab/agentos",
  prNumber: 42,
  headSha: HEAD,
  baseRef: "main",
  baseSha: BASE,
  mergeMethod: "merge",
  requiredChecks: [],
  readAt: NOW.toISOString(),
};

const context = {
  readiness: { id: "readiness-1", chainId: "chain-1", projectId: "project-1", repoId: "repo-1" },
  now: NOW,
} as const;

const ready = (overrides: Partial<Extract<ReadinessInput, { stage: "ready" }>> = {}): Extract<ReadinessInput, { stage: "ready" }> => ({
  ...context,
  stage: "ready",
  regression: { headSha: HEAD, baseHeadSha: BASE },
  target: { repository: "mosonlab/agentos", prNumber: 42 },
  snapshot: snapshot(),
  comparison: { status: "ahead", behindBy: 0, filesComplete: true, files: [] },
  resolutions: [],
  review: null,
  branch: "readiness-decision",
  evidence,
  ...overrides,
});

test("authorize carries the exact head evidence into apply", () => {
  assert.deepEqual(readinessDecision(ready()), {
    kind: "authorize",
    evidence,
    repository: "mosonlab/agentos",
    prNumber: 42,
    issuedAt: NOW.toISOString(),
  });
});

test("review parks an already-open blind review", () => {
  const decision = readinessDecision(ready({
    comparison: {
      status: "ahead",
      behindBy: 0,
      filesComplete: true,
      files: [{ filename: "packages/api/src/app.ts", previousFilename: null, patch: null }],
    },
    review: { state: "open", reviewTaskId: "review-1" },
  }));
  assert.deepEqual(decision, {
    kind: "review",
    action: "park",
    reviewTaskId: "review-1",
    baseSha: BASE,
    headSha: HEAD,
  });
});

test("review opens a blind review for a newly triggered defense path", () => {
  const decision = readinessDecision(ready({
    comparison: {
      status: "ahead",
      behindBy: 0,
      filesComplete: true,
      files: [{ filename: "packages/api/src/app.ts", previousFilename: null, patch: null }],
    },
  }));
  assert.equal(decision.kind, "review");
  assert.equal(decision.action, "open");
});

test("head drift requeues Regression", () => {
  const decision = readinessDecision(ready({ snapshot: snapshot({ headRefOid: "c".repeat(40) }) }));
  assert.equal(decision.kind, "requeue-regression");
  assert.match(decision.reason, /stale PASS head/u);
});

test("timeout and transport failures defer without a terminal stop", () => {
  for (const kind of ["timeout", "transport"] as const) {
    assert.deepEqual(readinessDecision({
      ...context,
      stage: "read-failed",
      failure: { kind, message: `${kind} failure` },
    }), {
      kind: "defer",
      reason: `readiness evaluation failed: ${kind} failure`,
    });
  }
});

test("deterministic GitHub response failures stop", () => {
  const decision = readinessDecision({
    ...context,
    stage: "read-failed",
    failure: { kind: "response", message: "malformed comparison" },
  });
  assert.deepEqual(decision, {
    kind: "stop",
    condition: "readiness-read-failed",
    evidence: "readiness evaluation failed: malformed comparison",
  });
});

test("an unclaimed candidate skips", () => {
  assert.deepEqual(readinessDecision({ ...context, stage: "claim-lost" }), { kind: "skip" });
});

test("an incomplete comparison is a named stop", () => {
  const decision = readinessDecision(ready({
    comparison: { status: "ahead", behindBy: 0, filesComplete: false, files: [] },
  }));
  assert.equal(decision.kind, "stop");
  assert.equal(decision.condition, "comparison-incomplete");
});
