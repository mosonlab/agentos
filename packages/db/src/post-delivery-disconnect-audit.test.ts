import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPostDeliveryDisconnectAudit,
  postDeliveryDisconnectTerminalFailureFor,
  type PostDeliveryDisconnectAuditEvent,
} from "./post-delivery-disconnect-audit.js";

const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): PostDeliveryDisconnectAuditEvent => ({ seq, type, payload, at: new Date(seq * 1_000) });

test("Codex terminal failure follows the adapter's stream-wide error latch", () => {
  const reconnect = [
    event(1, "ADAPTER_ERROR", { type: "error", message: "Reconnecting... 1/5" }),
    event(2, "FINAL_OUTPUT", { type: "turn.completed" }),
  ];
  assert.equal(postDeliveryDisconnectTerminalFailureFor(reconnect, 1), false);

  const failed = [
    event(1, "ADAPTER_ERROR", { type: "error", message: "provider rejected turn" }),
    event(2, "FINAL_OUTPUT", { type: "turn.completed" }),
    event(3, "FINAL_OUTPUT", { type: "turn.completed" }),
  ];
  assert.equal(postDeliveryDisconnectTerminalFailureFor(failed, 1), true);
  assert.equal(
    postDeliveryDisconnectTerminalFailureFor(failed, 2),
    true,
    "Codex does not clear sawError after a terminal event",
  );
});

test("PI terminal failure uses only the last agent_end verdict", () => {
  const events = [
    event(1, "MODEL_COMPLETED", { type: "turn_end" }),
    event(2, "PROVIDER_STATUS", {
      type: "agent_end",
      messages: [{ stopReason: "error", errorMessage: "first attempt failed" }],
    }),
    event(3, "PROVIDER_STATUS", {
      type: "agent_end",
      errorMessage: "not read by the adapter",
      messages: [{ stopReason: "end_turn" }],
    }),
    event(4, "FINAL_OUTPUT", { type: "agent_settled" }),
  ];
  assert.equal(postDeliveryDisconnectTerminalFailureFor(events, 3), false);

  const failed = [
    ...events.slice(0, 2),
    event(3, "FINAL_OUTPUT", { type: "agent_settled" }),
  ];
  assert.equal(postDeliveryDisconnectTerminalFailureFor(failed, 2), true);
});

test("unknown terminal payloads use only explicit generic failure fields", () => {
  const failed = [event(1, "FINAL_OUTPUT", { type: "other", terminalSuccess: false })];
  const unknown = [event(1, "FINAL_OUTPUT", { type: "other", status: "incomplete" })];
  assert.equal(postDeliveryDisconnectTerminalFailureFor(failed, 0), true);
  assert.equal(postDeliveryDisconnectTerminalFailureFor(unknown, 0), false);
});

test("a later Claude terminal is classified independently from an earlier terminal", () => {
  const events = [
    event(1, "FINAL_OUTPUT", { type: "result", is_error: true, terminal_reason: "error" }),
    event(2, "FINAL_OUTPUT", { type: "result", is_error: false, terminal_reason: "completed" }),
  ];
  assert.equal(postDeliveryDisconnectTerminalFailureFor(events, 0), true);
  assert.equal(postDeliveryDisconnectTerminalFailureFor(events, 1), false);
});

test("audit table escapes tabs and line breaks in every cell", () => {
  assert.deepEqual(formatPostDeliveryDisconnectAudit([{
    runId: "run\t1",
    taskId: "task\r2",
    chainId: "chain\n3",
    providerError: "first\tline\r\nsecond",
  }]), [
    "runId\ttaskId\tchainId\tproviderError",
    "run 1\ttask\\r2\tchain\\n3\tfirst line\\r\\nsecond",
  ]);
});
