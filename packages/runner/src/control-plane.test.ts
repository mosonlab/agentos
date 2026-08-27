import assert from "node:assert/strict";
import test from "node:test";

import { authorityAfterHeartbeat, authorityFor, ControlPlaneError, retriableStartupError } from "./api.js";

test("ControlPlaneError classifies Run authority without leaking HTTP casts to callers", () => {
  assert.deepEqual(authorityFor(new ControlPlaneError(409, "stale fence")), {
    held: false,
    reason: "revoked",
  });
  assert.deepEqual(authorityFor(new ControlPlaneError(409, "suspended", "WAITING_INBOX")), {
    held: false,
    reason: "waiting-inbox",
  });
  assert.deepEqual(authorityFor(new ControlPlaneError(503, "unavailable")), { held: true });
  assert.deepEqual(authorityFor(new Error("connection reset")), { held: true });
});

test("heartbeat cancellation is an Authority verdict with its durable request", () => {
  const request = { requestId: "cancel-1", reason: "operator stop", requestedAt: new Date(0).toISOString() };
  assert.deepEqual(authorityAfterHeartbeat({ ok: false, cancellation: request }), {
    held: false,
    reason: "cancelled",
    request,
  });
  assert.deepEqual(authorityAfterHeartbeat({ ok: true, cancellation: null }), { held: true });
});

test("startup retries only transport failures and control-plane server errors", () => {
  assert.equal(retriableStartupError(new Error("connection reset")), true);
  assert.equal(retriableStartupError(new ControlPlaneError(503, "unavailable")), true);
  assert.equal(retriableStartupError(new ControlPlaneError(401, "unauthorized")), false);
  assert.equal(retriableStartupError(new ControlPlaneError(409, "refused")), false);
});
