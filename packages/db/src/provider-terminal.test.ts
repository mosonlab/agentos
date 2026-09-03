import assert from "node:assert/strict";
import test from "node:test";

import { isCodexReconnectStatus } from "./provider-terminal.js";

test("recognises reconnect progress with a network-wait cause", () => {
  assert.equal(isCodexReconnectStatus("Reconnecting... waiting for network (dns failure)"), true);
});

test("recognises reconnect progress with a retry counter and cause", () => {
  assert.equal(isCodexReconnectStatus("Reconnecting... 3/5 (tls handshake eof)"), true);
});

test("does not treat unrelated provider output as reconnect progress", () => {
  assert.equal(isCodexReconnectStatus("provider rejected turn"), false);
});
