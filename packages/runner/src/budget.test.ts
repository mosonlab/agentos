import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBudget, type BudgetSnapshot } from "./budget.js";

const now = new Date("2026-08-15T12:00:00.000Z");
const base: BudgetSnapshot = {
  now,
  startedAt: new Date(now.getTime() - 1_000),
  maxDurationMs: 120 * 60_000,
  currentRunNumber: 1,
  maxRuns: 3,
  processAlive: true,
  lastProgressEventAt: new Date(now.getTime() - 1_000),
  stallTimeoutMs: 10 * 60_000,
  toolDeadlineMs: 60 * 60_000,
  inFlightTool: null,
};

test("max-runs budget gate triggers", () => {
  assert.deepEqual(evaluateBudget({ ...base, currentRunNumber: 4 }), {
    allowed: false,
    gate: "max-runs",
    reason: "run 4 exceeds maximum 3",
  });
});

test("walltime budget gate triggers", () => {
  const result = evaluateBudget({ ...base, startedAt: new Date(now.getTime() - base.maxDurationMs) });
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.gate, "walltime");
});

test("stall budget gate uses process activity, structured progress, and per-tool deadline", () => {
  const dead = evaluateBudget({ ...base, processAlive: false });
  assert.equal(dead.allowed, false);
  if (!dead.allowed) assert.match(dead.reason, /process/u);

  const idle = evaluateBudget({ ...base, lastProgressEventAt: new Date(now.getTime() - base.stallTimeoutMs) });
  assert.equal(idle.allowed, false);
  if (!idle.allowed) assert.match(idle.reason, /structured progress/u);

  const tool = evaluateBudget({
    ...base,
    lastProgressEventAt: new Date(now.getTime() - base.stallTimeoutMs * 2),
    inFlightTool: {
      id: "tool-1",
      name: "test",
      startedAt: new Date(now.getTime() - base.toolDeadlineMs),
      lastProgressAt: new Date(now.getTime() - base.toolDeadlineMs),
    },
  });
  assert.equal(tool.allowed, false);
  if (!tool.allowed) assert.match(tool.reason, /tool deadline/u);
});
