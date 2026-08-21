import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@prisma/client";

import { sessionUsageCost, sumUsageCosts } from "./cost.js";

test("Codex tokens use the model table, cached rate, and ignore the effort suffix", () => {
  const cost = sessionUsageCost("gpt-5.6-sol:xhigh", {
    costUsd: null,
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    outputTokens: 100_000,
  });
  assert.equal(cost.costUsd?.toString(), "6.2");
  assert.equal(cost.estimated, true);
});

test("an unpriced model exposes tokens and no dollar figure", () => {
  const cost = sessionUsageCost("future-model:high", {
    costUsd: null,
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
  });
  assert.equal(cost.costUsd, null);
  assert.equal(cost.estimated, false);
  assert.deepEqual(
    { inputTokens: cost.inputTokens, cachedInputTokens: cost.cachedInputTokens, outputTokens: cost.outputTokens },
    { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 },
  );
});

test("a provider-reported Claude cost always wins over the price table", () => {
  const reported = new Prisma.Decimal("0.049117");
  const cost = sessionUsageCost("gpt-5.6-sol:high", {
    costUsd: reported,
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    outputTokens: 100_000,
  });
  assert.equal(cost.costUsd?.toString(), "0.049117");
  assert.equal(cost.estimated, false);
});

test("an unpriced token component suppresses a partial aggregate dollar amount", () => {
  const priced = sessionUsageCost("gpt-5.6-luna", {
    costUsd: null, inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 50,
  });
  const unknown = sessionUsageCost("future-model", {
    costUsd: null, inputTokens: 10, cachedInputTokens: null, outputTokens: 5,
  });
  const total = sumUsageCosts([priced, unknown]);
  assert.equal(total?.costUsd, null);
  assert.equal(total?.inputTokens, 1_010);
  assert.equal(total?.outputTokens, 55);
});
