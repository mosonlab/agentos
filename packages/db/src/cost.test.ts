import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@prisma/client";

import { runSessionUsageCost, sessionUsageCost, sumUsageCosts } from "./cost.js";

test("Codex tokens use the model table, cached rate, and ignore the effort suffix", () => {
  const cost = sessionUsageCost("gpt-5.6-sol:xhigh", {
    costUsd: null,
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    cacheCreationInputTokens: 0,
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
    cacheCreationInputTokens: 0,
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
    cacheCreationInputTokens: 0,
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
    cacheCreationInputTokens: 0,
    outputTokens: 100_000,
  });
  // 600k uncached + 400k cached input and 100k output at Fable 5 rates.
  assert.equal(cost.costUsd?.toString(), "11.4");
  assert.equal(cost.estimated, true);
});

test("GPT-6 Astra token-only usage prices from its own row", () => {
  const cost = sessionUsageCost("gpt-6-astra:medium", {
    costUsd: null,
    inputTokens: 800_000,
    cachedInputTokens: 300_000,
    cacheCreationInputTokens: 0,
    outputTokens: 60_000,
  });
  // 500k uncached at $10/M = 5.0, 300k cached at $1/M = 0.3, 60k output at $50/M = 3.0 => 8.3
  assert.equal(cost.costUsd?.toString(), "8.3");
  assert.equal(cost.estimated, true);
});

test("splitting cache creation from the legacy cached total preserves the estimate", () => {
  const beforeSplit = sessionUsageCost("gpt-5.6-luna", {
    costUsd: null,
    inputTokens: 160,
    cachedInputTokens: 150,
    cacheCreationInputTokens: null,
    outputTokens: 10,
  });
  const afterSplit = sessionUsageCost("gpt-5.6-luna", {
    costUsd: null,
    inputTokens: 160,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
    outputTokens: 10,
  });
  assert.equal(beforeSplit.costUsd?.toString(), "0.000017");
  assert.equal(afterSplit.costUsd?.toString(), beforeSplit.costUsd?.toString());
  assert.equal(afterSplit.estimated, true);
});

test("an unknown historical cache split preserves the legacy estimate and provider cost remains authoritative", () => {
  const unknown = sessionUsageCost("gpt-5.6-luna", {
    costUsd: null,
    inputTokens: 160,
    cachedInputTokens: 100,
    cacheCreationInputTokens: null,
    outputTokens: 10,
  });
  assert.equal(unknown.costUsd?.toString(), "0.000026");
  assert.equal(unknown.estimated, true);

  const reported = sessionUsageCost("gpt-5.6-luna", {
    costUsd: new Prisma.Decimal("0.25"),
    inputTokens: 160,
    cachedInputTokens: 100,
    cacheCreationInputTokens: null,
    outputTokens: 10,
  });
  assert.equal(reported.costUsd?.toString(), "0.25");
  assert.equal(reported.estimated, false);
});

test("an unsplit native-child aggregate is priced at the root model, not at the child model", () => {
  const cost = runSessionUsageCost({
    model: "gpt-6-astra:high",
    session: {
      nativeChildUsed: true,
      costUsd: null,
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      cacheCreationInputTokens: 0,
      outputTokens: 500_000,
    },
  });
  // Codex reports one aggregate per session, so the root model prices all of
  // it: 900k uncached at $10/M = 9.0, 100k cached at $1/M = 0.1, 500k output
  // at $50/M = 25.0 => 34.1. The retired Luna override made the same row
  // $0.782, a forty-fold understatement of an Astra executioner.
  assert.equal(cost?.costUsd?.toString(), "34.1");
  assert.equal(cost?.estimated, true);
  assert.deepEqual(
    { inputTokens: cost?.inputTokens, cachedInputTokens: cost?.cachedInputTokens, outputTokens: cost?.outputTokens },
    { inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 500_000 },
  );
});

test("a session with no observed native child is priced at the same root model rates", () => {
  const cost = runSessionUsageCost({
    model: "gpt-6-astra:high",
    session: {
      nativeChildUsed: false,
      costUsd: null,
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      cacheCreationInputTokens: 0,
      outputTokens: 500_000,
    },
  });
  // Identical tokens, identical hand-computed total: an observed child no
  // longer moves the rate, it only means the aggregate is a mixed estimate.
  assert.equal(cost?.costUsd?.toString(), "34.1");
  assert.equal(cost?.estimated, true);
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
      cacheCreationInputTokens: 0,
      outputTokens: 100_000,
    },
  };
  const cost = runSessionUsageCost(grantedRun);
  assert.equal(cost?.costUsd?.toString(), "6.2");
  assert.equal(cost?.estimated, true);
});

test("an observed native child never demotes a Sol root to the child's rate", () => {
  const cost = runSessionUsageCost({
    model: "gpt-5.6-sol:high",
    session: {
      nativeChildUsed: true,
      costUsd: null,
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      cacheCreationInputTokens: 0,
      outputTokens: 500_000,
    },
  });
  // 900k uncached at $5/M = 4.5, 100k cached at $0.5/M = 0.05, 500k output at
  // $30/M = 15.0 => 19.55.
  assert.equal(cost?.costUsd?.toString(), "19.55");
  assert.equal(cost?.estimated, true);
});

test("a provider-reported amount stays authoritative for a native-child session", () => {
  const cost = runSessionUsageCost({
    model: "gpt-6-astra:high",
    session: {
      nativeChildUsed: true,
      costUsd: new Prisma.Decimal("1.5"),
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      cacheCreationInputTokens: 0,
      outputTokens: 500_000,
    },
  });
  assert.equal(cost?.costUsd?.toString(), "1.5");
  assert.equal(cost?.estimated, false);
});

test("a clean root and child split keeps each model's pricing", () => {
  const root = sessionUsageCost("gpt-5.6-sol:high", {
    costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheCreationInputTokens: 0, outputTokens: 100_000,
  });
  const child = sessionUsageCost("gpt-5.6-luna:max", {
    costUsd: null, inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheCreationInputTokens: 0, outputTokens: 100_000,
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
    cacheCreationInputTokens: 0,
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
    cacheCreationInputTokens: 0,
    outputTokens: 100_000,
  });
  assert.equal(cost.costUsd?.toString(), "0.049117");
  assert.equal(cost.estimated, false);
});

test("an unpriced token component suppresses a partial aggregate dollar amount", () => {
  const priced = sessionUsageCost("gpt-5.6-luna", {
    costUsd: null, inputTokens: 1_000, cachedInputTokens: 100, cacheCreationInputTokens: 0, outputTokens: 50,
  });
  const unknown = sessionUsageCost("future-model", {
    costUsd: null, inputTokens: 10, cachedInputTokens: null, cacheCreationInputTokens: 0, outputTokens: 5,
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
    const cost = sessionUsageCost("gpt-5.6-sol", { costUsd: null, cacheCreationInputTokens: 0, ...tokens });
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
    costUsd: null, inputTokens: 1_000, cachedInputTokens: 100, cacheCreationInputTokens: 0, outputTokens: 50,
  });
  const incomplete = sessionUsageCost("gpt-5.6-luna", {
    costUsd: null, inputTokens: 10, cachedInputTokens: null, cacheCreationInputTokens: 0, outputTokens: 5,
  });
  const total = sumUsageCosts([complete, incomplete]);
  assert.equal(total?.costUsd, null);
  assert.equal(total?.inputTokens, 1_010);
  assert.equal(total?.cachedInputTokens, 100);
  assert.equal(total?.outputTokens, 55);
});
