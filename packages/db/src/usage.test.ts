import assert from "node:assert/strict";
import test from "node:test";

import { deriveUsageColumns, extractUsage, sumUsage } from "./usage.js";

type StoredSessionEvent = {
  child: string;
  type: "FINAL_OUTPUT" | "PROVIDER_RAW";
  payload: unknown;
};

const deriveFinalOutputUsage = (events: StoredSessionEvent[]) => deriveUsageColumns(
  sumUsage(
    events
      .filter((event) => event.type === "FINAL_OUTPUT")
      .map((event) => extractUsage(event.payload)),
  ),
);

const turnCompleted = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
  type: "turn.completed",
  usage: { input_tokens: inputTokens, cached_input_tokens: cachedInputTokens, output_tokens: outputTokens },
});

test("sums each child's FINAL_OUTPUT once", () => {
  const events: StoredSessionEvent[] = [
    { child: "provider-child-1", type: "FINAL_OUTPUT", payload: turnCompleted(100, 25, 10) },
    { child: "provider-child-2", type: "FINAL_OUTPUT", payload: turnCompleted(200, 50, 20) },
  ];

  const derived = deriveFinalOutputUsage(events);

  assert.deepEqual(
    {
      inputTokens: derived.inputTokens,
      outputTokens: derived.outputTokens,
      totalTokens: derived.totalTokens,
    },
    { inputTokens: 300, outputTokens: 30, totalTokens: 330 },
  );
});

test("an interrupted child with no FINAL_OUTPUT contributes no usage", () => {
  const resumedChildOutput = turnCompleted(200, 50, 20);
  const events: StoredSessionEvent[] = [
    // The provider payload may contain usage, but without the adapter's
    // FINAL_OUTPUT row it must not enter session usage aggregation.
    { child: "interrupted-provider-child", type: "PROVIDER_RAW", payload: turnCompleted(900, 300, 90) },
    { child: "resumed-provider-child", type: "FINAL_OUTPUT", payload: resumedChildOutput },
  ];

  const derived = deriveFinalOutputUsage(events);

  assert.deepEqual(
    {
      inputTokens: derived.inputTokens,
      outputTokens: derived.outputTokens,
      totalTokens: derived.totalTokens,
    },
    { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
  );
});
