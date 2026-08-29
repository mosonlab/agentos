import assert from "node:assert/strict";
import test from "node:test";

import { parseRepairCycles, repairTaskHref, shortRepairSha } from "../lib/repair-subtimeline";

const activity = (
  id: string,
  kind: string,
  repairTaskId: string,
  startHeadSha: string,
  targetHeadSha: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  taskId: "regression-task",
  actorType: "control-plane",
  actorId: null,
  body: "",
  commitSha: null,
  createdAt: `2026-08-28T00:0${id.slice(-1)}:00.000Z`,
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
    activity("q1", "mergeTail.repairQueued", "repair-1", "a".repeat(40), "b".repeat(40), { repairKind: "gate-fix" }),
    activity("r1", "mergeTail.repairResult", "repair-1", "a".repeat(40), "b".repeat(40), {
      repairKind: "gate-fix", resolvedHeadSha: "c".repeat(40), state: "succeeded",
    }),
    activity("q2", "repairQueued", "repair-2", "c".repeat(40), "b".repeat(40), { repairKind: "review-fix" }),
    activity("r2", "repairResult", "repair-2", "c".repeat(40), "b".repeat(40), {
      repairKind: "review-fix", resolvedHeadSha: "d".repeat(40), state: "succeeded",
    }),
    activity("q3", "mergeTail.repairAttempt", "repair-3", "d".repeat(40), "b".repeat(40), { repairKind: "gate-fix" }),
    activity("r3", "mergeTail.repairResult", "repair-3", "d".repeat(40), "b".repeat(40), {
      repairKind: "gate-fix", resolvedHeadSha: "e".repeat(40), state: "succeeded",
    }),
    activity("q4", "mergeTail.repairQueued", "repair-4", "e".repeat(40), "b".repeat(40), { repairKind: "refresh-conflict" }),
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
  assert.equal(cycles[0]?.targetHeadSha, "b".repeat(40));
  assert.equal(cycles[0]?.resolvedHeadSha, "c".repeat(40));
  assert.equal(cycles[0]?.endHeadSha, "c".repeat(40));
  assert.equal(cycles[0]?.taskHref, "/tasks/repair-1");
});

test("keeps queued repairs pending and retains failed result state", () => {
  const cycles = parseRepairCycles([
    activity("q1", "repairQueued", "repair-pending", "a".repeat(40), "b".repeat(40), { repairKind: "gate-fix" }),
    activity("q2", "repairQueued", "repair-failed", "c".repeat(40), "b".repeat(40), { repairKind: "review-fix" }),
    activity("r2", "repairResult", "repair-failed", "c".repeat(40), "b".repeat(40), {
      repairKind: "review-fix", resolvedHeadSha: null, state: "failed",
    }),
  ]);

  assert.deepEqual(cycles.map(({ repairTaskId, outcome, state, endHeadSha }) => ({ repairTaskId, outcome, state, endHeadSha })), [
    { repairTaskId: "repair-pending", outcome: "pending", state: "queued", endHeadSha: null },
    { repairTaskId: "repair-failed", outcome: "failed", state: "failed", endHeadSha: null },
  ]);
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

test("short SHA and task-card link helpers stay safe for absent values", () => {
  assert.equal(shortRepairSha("abcdef1234567890"), "abcdef1");
  assert.equal(shortRepairSha(null), "—");
  assert.equal(shortRepairSha(""), "—");
  assert.equal(repairTaskHref("repair-1"), "/tasks/repair-1");
  assert.equal(repairTaskHref(null), null);
});
