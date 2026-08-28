import assert from "node:assert/strict";
import test from "node:test";

import { parsePiTranscript } from "./pi.js";

/**
 * The event shapes below are the usage-bearing portion of
 * spikes/cli-capabilities/samples/pi-openai-codex-gpt-5.6-luna-20260828T214948Z.jsonl,
 * captured from pi 0.84.3. In this capture message_start and message_update
 * carry a zero-valued provisional usage object, message_end carries the final
 * usage, and turn_end/agent_end repeat that final object.
 */
const FRESH_LUNA_TRANSCRIPT: readonly unknown[] = [
  { type: "session", version: 3, id: "01a04a59-b634-7b22-8299-75f122b4d1cc" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Reply with exactly one short word: hello." }] } },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Reply with exactly one short word: hello." }] } },
  {
    type: "message_start",
    message: {
      role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-luna",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "pending",
    },
  },
  { type: "message_update", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } },
  {
    type: "message_end",
    message: {
      role: "assistant", content: [{ type: "text", text: "hello" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-luna",
      usage: {
        input: 2197, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2202,
        cost: { input: 0.00043940000000000006, output: 0.000006, cacheRead: 0, cacheWrite: 0, total: 0.00044540000000000004 },
      }, stopReason: "stop",
    },
  },
  {
    type: "turn_end",
    message: {
      role: "assistant", content: [{ type: "text", text: "hello" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-luna",
      usage: {
        input: 2197, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2202,
        cost: { input: 0.00043940000000000006, output: 0.000006, cacheRead: 0, cacheWrite: 0, total: 0.00044540000000000004 },
      }, stopReason: "stop",
    },
  },
  {
    type: "agent_end",
    messages: [{
      role: "assistant", content: [{ type: "text", text: "hello" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-luna",
      usage: {
        input: 2197, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2202,
        cost: { input: 0.00043940000000000006, output: 0.000006, cacheRead: 0, cacheWrite: 0, total: 0.00044540000000000004 },
      }, stopReason: "stop",
    }], willRetry: false,
  },
  { type: "agent_settled" },
];

const finalOutputOf = (events: Array<{ type: string; payload: Record<string, unknown> }>): Record<string, unknown> => {
  const final = events.filter((event) => event.type === "FINAL_OUTPUT");
  assert.equal(final.length, 1);
  return final[0]!.payload;
};

test("PI harvests one fresh openai-codex Luna message despite provisional and repeated usage", () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const state = parsePiTranscript(FRESH_LUNA_TRANSCRIPT, (event) => { events.push(event); });

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
