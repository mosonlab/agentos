import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionSupervisor, type InboxSocket, type SocketCallbacks } from "./supervisor.js";

test("fake socket drives reconnect state and preserves the offline window", () => {
  let callbacks: SocketCallbacks | undefined;
  let closed = false;
  const fake: InboxSocket = { start: () => callbacks?.onReady(), close: () => { closed = true; } };
  const events: string[] = [];
  const supervisor = new ConnectionSupervisor((value) => { callbacks = value; return fake; }, (event) => events.push(event));
  const socket = supervisor.start();
  callbacks?.onReconnecting();
  assert.equal(supervisor.state.snapshot().state, "RECONNECTING");
  assert.equal(supervisor.state.snapshot().reconnectCount, 1);
  assert.ok(supervisor.state.snapshot().disconnectedAt);
  callbacks?.onReconnected();
  assert.equal(supervisor.state.snapshot().state, "ONLINE");
  supervisor.stop(socket);
  assert.equal(closed, true);
  assert.deepEqual(events, ["ready", "reconnecting", "reconnected", "stopped"]);
});
