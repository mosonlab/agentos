import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the shared registry before the Codex adapter. The registry also exposes
// the adapter and therefore forms a deliberate module cycle in production.
import "./adapters.js";
import { parseCodexTranscript } from "./adapters/codex.js";

const CAPTURE = new URL("../../../spikes/cli-capabilities/samples/codex-gpt-5.6-luna-max-20260828.stdout", import.meta.url);

const capturedTranscript = async (): Promise<unknown[]> => (await readFile(CAPTURE, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as unknown);

test("Codex Luna max capture preserves terminal usage for the ingest boundary", async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const state = parseCodexTranscript(await capturedTranscript(), (event) => { events.push(event); });
  const terminal = events.filter((event) => event.type === "FINAL_OUTPUT");

  assert.equal(state.providerConversationId, "01a04a63-1c7d-79a1-a8a1-55c516b83065");
  assert.equal(state.terminalEventSeen, true);
  assert.equal(state.terminalSuccess, true);
  assert.equal(state.finalOutput, "OK");
  assert.equal(terminal.length, 1);
  assert.deepEqual(terminal[0]?.payload, {
    type: "turn.completed",
    usage: {
      input_tokens: 12_317,
      cached_input_tokens: 8_960,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
  });
});
