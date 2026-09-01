import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parsePiEvent, parsePiTranscript } from "./pi.js";

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
  parsePiTranscript(await capturedTranscript(), (event) => { events.push(event); });

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

test("PI drops streaming chunks while preserving terminal and tool events", async () => {
  const transcript = await capturedTranscript();
  transcript.splice(-1, 0,
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" },
    { type: "tool_execution_update", toolCallId: "tool-1", output: "hello" },
    { type: "tool_execution_end", toolCallId: "tool-1", output: "hello" },
  );
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  parsePiTranscript(transcript, (event) => { events.push(event); });

  const chunkTypes = new Set(["message_update", "tool_execution_update"]);
  const persistedChunkEvents = events.filter((event) =>
    chunkTypes.has(typeof event.payload.type === "string" ? event.payload.type : "")
    && ["MODEL_DELTA", "TOOL_PROGRESS", "PROVIDER_RAW"].includes(event.type));
  assert.deepEqual(persistedChunkEvents, []);

  const count = (type: string): number => events.filter((event) => event.type === type).length;
  assert.deepEqual({
    MODEL_COMPLETED: count("MODEL_COMPLETED"),
    TOOL_STARTED: count("TOOL_STARTED"),
    TOOL_COMPLETED: count("TOOL_COMPLETED"),
    PROVIDER_STATUS: count("PROVIDER_STATUS"),
    FINAL_OUTPUT: count("FINAL_OUTPUT"),
  }, {
    MODEL_COMPLETED: 3,
    TOOL_STARTED: 1,
    TOOL_COMPLETED: 1,
    PROVIDER_STATUS: 3,
    FINAL_OUTPUT: 1,
  });

  const assistantCompleted = events.find((event) => event.type === "MODEL_COMPLETED"
    && (event.payload.message as { role?: unknown } | undefined)?.role === "assistant");
  assert.ok(assistantCompleted, "the assistant message remains a MODEL_COMPLETED event");
  assert.deepEqual(finalOutputOf(events).agentosPiUsage, {
    messages: 1,
    reported: 1,
    input: 2197,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    costNanoUsd: 445400,
  });
});

test("PI message chunks still renew adapter progress", async () => {
  const state = parsePiTranscript([]);
  const before = state.lastProgressEventAt;
  await new Promise<void>((resolve) => setTimeout(resolve, 2));

  parsePiEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "still working" },
  }, () => undefined);

  assert.ok(state.lastProgressEventAt.getTime() > before.getTime());
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
