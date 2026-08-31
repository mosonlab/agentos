import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@prisma/client";

import { runSessionUsageCost, sessionUsageCost, sumUsageCosts } from "./cost.js";

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

test("a provider-prefixed model uses the existing bare model price row", () => {
  const cost = sessionUsageCost("openai-codex/gpt-5.6-sol:high", {
    costUsd: null,
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    outputTokens: 100_000,
  });
  assert.equal(cost.costUsd?.toString(), "6.2");
  assert.equal(cost.estimated, true);
});

test("Claude Opus token-only usage uses the new price row and effort normalization", () => {
  const cost = sessionUsageCost("claude-opus-5:high", {
    costUsd: null,
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    outputTokens: 100_000,
  });
  // 600k uncached + 400k cached input and 100k output at Opus 5 rates.
  assert.equal(cost.costUsd?.toString(), "5.7");
  assert.equal(cost.estimated, true);
});

test("a provider-prefixed Claude Fable model uses its bare price row", () => {
  const cost = sessionUsageCost("anthropic/claude-fable-5:medium", {
    costUsd: null,
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    outputTokens: 100_000,
  });
  // 600k uncached + 400k cached input and 100k output at Fable 5 rates.
  assert.equal(cost.costUsd?.toString(), "11.4");
  assert.equal(cost.estimated, true);
});

test("an unsplit native-child session uses the pinned Luna price", () => {
  const cost = sessionUsageCost("gpt-5.6-sol:high", {
    costUsd: null,
    inputTokens: 1_000_000,
    cachedInputTokens: 100_000,
    outputTokens: 500_000,
  }, { mixedModels: true });
  // 900k uncached + 100k cached input and 500k output at Luna rates.
  assert.equal(cost.costUsd?.toString(), "0.782");
  assert.equal(cost.estimated, true);
  assert.deepEqual(
    { inputTokens: cost.inputTokens, cachedInputTokens: cost.cachedInputTokens, outputTokens: cost.outputTokens },
    { inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  );
});

test("a native-child grant without an observed child keeps the root model price", () => {
  const grantedRun = {
    model: "gpt-5.6-sol:high",
    subagentModel: "gpt-5.6-luna:max",
    session: {
      nativeChildUsed: false,
      costUsd: null,
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 100_000,
    },
  };
  const cost = runSessionUsageCost(grantedRun);
  assert.equal(cost?.costUsd?.toString(), "6.2");
  assert.equal(cost?.estimated, true);
});

test("an observed unsplit native child prices the aggregate at Luna", () => {
  const cost = runSessionUsageCost({
    model: "gpt-5.6-sol:high",
    session: {
      nativeChildUsed: true,
      costUsd: null,
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      outputTokens: 500_000,
    },
  });
  assert.equal(cost?.costUsd?.toString(), "0.782");
  assert.equal(cost?.estimated, true);
});

test("a clean root and child split keeps each model's pricing", () => {
  const root = sessionUsageCost("gpt-5.6-sol:high", {
    costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000,
  });
  const child = sessionUsageCost("gpt-5.6-luna:max", {
    costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000,
  });
  assert.equal(root.costUsd?.toString(), "6.2");
  assert.equal(child.costUsd?.toString(), "0.248");
  assert.equal(sumUsageCosts([root, child])?.costUsd?.toString(), "6.448");
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

test("incomplete priced token rows never produce a partial dollar estimate", () => {
  const incomplete = [
    { inputTokens: 10, cachedInputTokens: null, outputTokens: null },
    { inputTokens: null, cachedInputTokens: 2, outputTokens: null },
    { inputTokens: null, cachedInputTokens: null, outputTokens: 3 },
    { inputTokens: null, cachedInputTokens: 2, outputTokens: 3 },
    { inputTokens: 10, cachedInputTokens: null, outputTokens: 3 },
    { inputTokens: 10, cachedInputTokens: 2, outputTokens: null },
  ];

  for (const tokens of incomplete) {
    const cost = sessionUsageCost("gpt-5.6-sol", { costUsd: null, ...tokens });
    assert.equal(cost.costUsd, null, JSON.stringify(tokens));
    assert.equal(cost.estimated, false, JSON.stringify(tokens));
    assert.deepEqual(
      { inputTokens: cost.inputTokens, cachedInputTokens: cost.cachedInputTokens, outputTokens: cost.outputTokens },
      tokens,
    );
  }
});

test("an incomplete priced session suppresses a partial aggregate dollar amount", () => {
  const complete = sessionUsageCost("gpt-5.6-luna", {
    costUsd: null, inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 50,
  });
  const incomplete = sessionUsageCost("gpt-5.6-luna", {
    costUsd: null, inputTokens: 10, cachedInputTokens: null, outputTokens: 5,
  });
  const total = sumUsageCosts([complete, incomplete]);
  assert.equal(total?.costUsd, null);
  assert.equal(total?.inputTokens, 1_010);
  assert.equal(total?.cachedInputTokens, 100);
  assert.equal(total?.outputTokens, 55);
});
