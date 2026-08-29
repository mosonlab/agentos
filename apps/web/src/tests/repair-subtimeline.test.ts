import assert from "node:assert/strict";
import test from "node:test";

import { isRegressionStep, parseRepairCycles, type RepairActivity } from "../lib/repair-subtimeline";

const activity = (
  id: string,
  kind: string,
  repairTaskId: string,
  startHeadSha: string,
  targetHeadSha: string,
  extra: Record<string, unknown> = {},
): RepairActivity => ({
  id,
  metadata: {
    schemaVersion: 1,
    kind,
    repairKind: extra.repairKind ?? "gate-fix",
    repairTaskId,
    startHeadSha,
    targetHeadSha,
    ...extra,
  },
});

test("pairs four queued/result markers by task and keeps queue order", () => {
  const activities = [
    activity("q1", "mergeTail.repairAttempt", "repair-1", "a".repeat(40), "b".repeat(40), { repairKind: "gate-fix" }),
    activity("r1", "mergeTail.repairResult", "repair-1", "a".repeat(40), "b".repeat(40), {
      repairKind: "gate-fix", resolvedHeadSha: "c".repeat(40), state: "succeeded",
    }),
    activity("q2", "mergeTail.repairAttempt", "repair-2", "c".repeat(40), "b".repeat(40), { repairKind: "review-fix" }),
    activity("r2", "mergeTail.repairResult", "repair-2", "c".repeat(40), "b".repeat(40), {
      repairKind: "review-fix", resolvedHeadSha: "d".repeat(40), state: "succeeded",
    }),
    activity("q3", "mergeTail.repairAttempt", "repair-3", "d".repeat(40), "b".repeat(40), { repairKind: "gate-fix" }),
    activity("r3", "mergeTail.repairResult", "repair-3", "d".repeat(40), "b".repeat(40), {
      repairKind: "gate-fix", resolvedHeadSha: "e".repeat(40), state: "succeeded",
    }),
    activity("q4", "mergeTail.repairAttempt", "repair-4", "e".repeat(40), "b".repeat(40), { repairKind: "refresh-conflict" }),
    activity("r4", "mergeTail.repairResult", "repair-4", "e".repeat(40), "b".repeat(40), {
      repairKind: "refresh-conflict", resolvedHeadSha: "f".repeat(40), state: "succeeded",
    }),
  ];

  const cycles = parseRepairCycles(activities);
  assert.equal(cycles.length, 4);
  assert.deepEqual(cycles.map(({ ordinal, repairKind, repairTaskId, outcome }) => ({ ordinal, repairKind, repairTaskId, outcome })), [
    { ordinal: 1, repairKind: "gate-fix", repairTaskId: "repair-1", outcome: "succeeded" },
    { ordinal: 2, repairKind: "review-fix", repairTaskId: "repair-2", outcome: "succeeded" },
    { ordinal: 3, repairKind: "gate-fix", repairTaskId: "repair-3", outcome: "succeeded" },
    { ordinal: 4, repairKind: "refresh-conflict", repairTaskId: "repair-4", outcome: "succeeded" },
  ]);
  assert.equal(cycles[0]?.startHeadSha, "a".repeat(40));
  assert.equal(cycles[0]?.endHeadSha, "c".repeat(40));
  assert.equal(cycles[0]?.taskHref, "/tasks/repair-1");
});

test("keeps queued repairs pending and retains failed outcomes", () => {
  const cycles = parseRepairCycles([
    activity("q1", "mergeTail.repairAttempt", "repair-pending", "a".repeat(40), "b".repeat(40), { repairKind: "gate-fix" }),
    activity("q2", "mergeTail.repairAttempt", "repair-failed", "c".repeat(40), "b".repeat(40), { repairKind: "review-fix" }),
    activity("r2", "mergeTail.repairResult", "repair-failed", "c".repeat(40), "b".repeat(40), {
      repairKind: "review-fix", resolvedHeadSha: null, state: "failed",
    }),
  ]);

  assert.deepEqual(cycles.map(({ repairTaskId, outcome, endHeadSha }) => ({ repairTaskId, outcome, endHeadSha })), [
    { repairTaskId: "repair-pending", outcome: "pending", endHeadSha: null },
    { repairTaskId: "repair-failed", outcome: "failed", endHeadSha: null },
  ]);
});

test("pairs the current repairAttempt writer fields with repairResult fields", () => {
  const queued = activity("q1", "mergeTail.repairAttempt", "repair-1", "ignored", "ignored");
  queued.metadata = {
    schemaVersion: 1,
    kind: "mergeTail.repairAttempt",
    repairKind: "gate-fix",
    repairTaskId: "repair-1",
    headSha: "a".repeat(40),
    baseHeadSha: "b".repeat(40),
  };
  const cycles = parseRepairCycles([
    queued,
    activity("r1", "mergeTail.repairResult", "repair-1", "a".repeat(40), "b".repeat(40), {
      resolvedHeadSha: "c".repeat(40),
    }),
  ]);

  assert.equal(cycles.length, 1);
  assert.equal(cycles[0]?.startHeadSha, "a".repeat(40));
  assert.equal(cycles[0]?.endHeadSha, "c".repeat(40));
});

test("returns no cycles for empty or malformed and unknown metadata", () => {
  assert.deepEqual(parseRepairCycles([]), []);
  assert.deepEqual(parseRepairCycles([
    { metadata: null },
    { metadata: ["mergeTail.repairQueued"] },
    { metadata: { kind: "mergeTail.unrelated", repairTaskId: "unknown" } },
    { metadata: { kind: "mergeTail.repairQueued", repairTaskId: "missing-heads" } },
    { metadata: { kind: "mergeTail.repairResult", repairKind: "gate-fix", repairTaskId: "missing-heads" } },
    { metadata: { kind: "mergeTail.repairResult", repairKind: "gate-fix", repairTaskId: 42, startHeadSha: "a", targetHeadSha: "b" } },
  ]), []);
});

test("identifies the canonical Regression node from chain step copy", () => {
  assert.equal(isRegressionStep({ name: "Release: Regression verification", stepName: "Regression verification" }), true);
  assert.equal(isRegressionStep({ name: "Release: Merge authorization", stepName: "Merge authorization" }), false);
});
