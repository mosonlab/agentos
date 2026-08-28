import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parsePiTranscript } from "./pi.js";

const CAPTURE = new URL("../../../../spikes/cli-capabilities/samples/pi-openai-codex-gpt-5.6-luna-20260828T214948Z.jsonl", import.meta.url);

const capturedTranscript = async (): Promise<unknown[]> => (await readFile(CAPTURE, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as unknown);

const finalOutputOf = (events: Array<{ type: string; payload: Record<string, unknown> }>): Record<string, unknown> => {
  const final = events.filter((event) => event.type === "FINAL_OUTPUT");
  assert.equal(final.length, 1);
  return final[0]!.payload;
};

test("PI harvests one fresh openai-codex Luna message despite provisional and repeated usage", async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const state = parsePiTranscript(await capturedTranscript(), (event) => { events.push(event); });

  assert.deepEqual(state.piUsage, {
    messages: 1,
    reported: 1,
    input: 2197,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    costNanoUsd: 445400,
  });
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, {
    messages: 1,
    reported: 1,
    input: 2197,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    costNanoUsd: 445400,
  });
  assert.equal(events.some((event) => event.type === "ADAPTER_ERROR"), false);
});

test("PI treats cache-only usage as tokens when diagnosing a missing cost", () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  parsePiTranscript([
    { type: "message_end", message: { role: "assistant", usage: { cacheRead: 7 } } },
    { type: "agent_settled" },
  ], (event) => { events.push(event); });

  const errors = events.filter((event) => event.type === "ADAPTER_ERROR");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]!.payload.error), /^Session cost is incomplete: PI reported no cost$/u);
});
