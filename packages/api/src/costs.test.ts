import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, RunStatus } from "@anneal/db";

import { aggregateCosts, costsWindowEnd, costsWindowStart, type CostsRunRow } from "./costs.js";

const row = (overrides: Partial<CostsRunRow> & Pick<CostsRunRow, "id" | "model" | "status">): CostsRunRow => {
  const { id, model, status, ...rest } = overrides;
  return {
    id,
    model,
    status,
    subagentModel: null,
    startedAt: new Date("2026-08-28T12:00:00.000Z"),
    agent: { id: "dev-id", name: "dev" },
    task: null,
    session: {
      nativeChildUsed: false,
      costUsd: new Prisma.Decimal(1),
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
    },
    ...rest,
  };
};

test("timezone windows use local midnight and retain one local date across DST", () => {
  const now = new Date("2026-03-08T18:00:00.000Z");
  assert.equal(costsWindowStart(now, 1, "America/Los_Angeles").toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(costsWindowEnd(now, "America/Los_Angeles").toISOString(), "2026-03-09T07:00:00.000Z");
});

test("timezone windows start at the first valid instant when local midnight is skipped", () => {
  const now = new Date("2020-09-06T12:00:00.000Z");
  assert.equal(costsWindowStart(now, 1, "America/Santiago").toISOString(), "2020-09-06T04:00:00.000Z");
  assert.equal(costsWindowEnd(now, "America/Santiago").toISOString(), "2020-09-07T03:00:00.000Z");
});

test("aggregateCosts preserves model identity, isolates mixed runs, and reconciles spend", () => {
  const runs = [
    row({
      id: "success", model: "openai-codex/gpt-5.6-luna:max", status: RunStatus.SUCCEEDED,
      session: {
        nativeChildUsed: false, costUsd: new Prisma.Decimal(5),
        inputTokens: 1_000, cachedInputTokens: 250, outputTokens: 10,
      },
    }),
    row({
      id: "failed", model: "claude-opus-5:high", status: RunStatus.FAILED,
      session: {
        nativeChildUsed: false, costUsd: new Prisma.Decimal(2),
        inputTokens: 3_000, cachedInputTokens: 750, outputTokens: 20,
      },
    }),
    row({
      id: "mixed", model: "openai-codex/gpt-5.6-sol:max", status: RunStatus.CANCELLED,
      session: {
        nativeChildUsed: true, costUsd: new Prisma.Decimal(3),
        inputTokens: null, cachedInputTokens: null, outputTokens: null,
      },
    }),
    row({
      id: "unpriced", model: "openai-codex/gpt-5.6-luna:max", status: RunStatus.LOST,
      agent: { id: "review-id", name: "reviewer" },
      session: {
        nativeChildUsed: false, costUsd: null,
        inputTokens: 100, cachedInputTokens: null, outputTokens: null,
      },
    }),
  ];

  const report = aggregateCosts(
    runs,
    [
      { agentId: "dev-id", _count: { _all: 3 } },
      { agentId: "review-id", _count: { _all: 1 } },
    ],
    new Date("2026-08-28T00:00:00.000Z"),
    1,
    "UTC",
  );

  assert.ok(report.since instanceof Date);
  assert.deepEqual(report.byModel.map(({ model, usd, runs, costUnavailableRuns }) => ({
    model, usd: usd.toString(), runs, costUnavailableRuns,
  })), [
    { model: "openai-codex/gpt-5.6-luna:max", usd: "5", runs: 2, costUnavailableRuns: 1 },
    { model: "mixed", usd: "3", runs: 1, costUnavailableRuns: 0 },
    { model: "claude-opus-5:high", usd: "2", runs: 1, costUnavailableRuns: 0 },
  ]);
  assert.equal(report.byModel.reduce((sum, entry) => sum + Number(entry.usd), 0), Number(report.totalUsd));
  assert.ok(!report.byModel.some((entry) => entry.model === "openai-codex/gpt-5.6-sol:max"));

  const dev = report.byAgent.find((entry) => entry.agent === "dev");
  const reviewer = report.byAgent.find((entry) => entry.agent === "reviewer");
  assert.equal(dev?.cachePct, 25);
  assert.equal(reviewer?.cachePct, null);
  assert.equal(dev?.wastedUsd.toString(), "5");
  assert.equal(reviewer?.wastedUsd.toString(), "0");
  assert.equal(report.wastedUsd.toString(), "5");
});

test("aggregateCosts reconciles by-model rounding with the serialized total", () => {
  const runs = [
    row({
      id: "model-a", model: "gpt-5.6-sol:high", status: RunStatus.SUCCEEDED,
      session: {
        nativeChildUsed: false, costUsd: null,
        inputTokens: 13, cachedInputTokens: 13, outputTokens: 0,
      },
    }),
    row({
      id: "model-b", model: "gpt-5.6-sol:max", status: RunStatus.SUCCEEDED,
      session: {
        nativeChildUsed: false, costUsd: null,
        inputTokens: 13, cachedInputTokens: 13, outputTokens: 0,
      },
    }),
  ];

  const report = aggregateCosts(
    runs,
    [{ agentId: "dev-id", _count: { _all: 2 } }],
    new Date("2026-08-28T00:00:00.000Z"),
    1,
    "UTC",
  );

  assert.equal(report.totalUsd.toString(), "0.000013");
  assert.deepEqual(report.byModel.map(({ model, usd }) => ({ model, usd: usd.toString() })), [
    { model: "gpt-5.6-sol:high", usd: "0.000007" },
    { model: "gpt-5.6-sol:max", usd: "0.000006" },
  ]);
  assert.equal(
    report.byModel.reduce((sum, entry) => sum.plus(entry.usd), new Prisma.Decimal(0)).toString(),
    report.totalUsd.toString(),
  );
});
