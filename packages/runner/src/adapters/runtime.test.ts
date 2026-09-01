import assert from "node:assert/strict";
import test from "node:test";

import { createAdapterState, emitAdapterEvent, processProviderEvent, type AdapterEventParser } from "./runtime.js";

test("provider-event persistence can suppress output while retaining parser state and progress", () => {
  const state = createAdapterState("PI", "runtime-test", undefined, new Date(0));
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const parseEvent: AdapterEventParser = (parserState, event, sink) => {
    parserState.providerConversationId = String(event.id);
    emitAdapterEvent(parserState, sink, "MODEL_DELTA", event);
  };
  const before = state.lastProgressEventAt;

  processProviderEvent(state, { type: "message_update", id: "suppressed" }, (event) => events.push(event), parseEvent, () => false);

  assert.deepEqual(events, []);
  assert.equal(state.providerConversationId, "suppressed");
  assert.ok(state.lastProgressEventAt.getTime() > before.getTime());
});

test("provider-event persistence keeps raw and parsed output when accepted", () => {
  const state = createAdapterState("CODEX", "runtime-test");
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const parseEvent: AdapterEventParser = (_parserState, event, sink) => {
    sink({ source: "CODEX", type: "MODEL_COMPLETED", payload: event });
  };

  processProviderEvent(state, { type: "turn.completed" }, (event) => events.push(event), parseEvent, () => true);

  assert.deepEqual(events.map(({ type }) => type), ["PROVIDER_RAW", "MODEL_COMPLETED"]);
});
