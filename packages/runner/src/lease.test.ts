import assert from "node:assert/strict";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { deliverUnderLease, openDeliveryLease, type LeaseHeartbeat } from "./lease.js";
import { DELIVERY_LEASE_RESERVE_MS, MIN_DELIVERY_BUDGET_MS } from "./network-retry.js";

const config = { leaseSeconds: 60, heartbeatIntervalMs: 30_000 } as unknown as RunnerConfig;
const claim = { run: { id: "run-1" } } as ClaimedTask;

const rejection = (status: number, code?: string): Error => Object.assign(new Error("rejected"), { status, code });

const openWith = async (send: LeaseHeartbeat, lastRenewalAt = 0, now: () => number = () => 0) =>
  openDeliveryLease(config, claim, lastRenewalAt, { send, now, startedAt: new Date(0) });

test("a rejected lease stops the runner from touching the remote at all", async () => {
  // The control plane answering 409 means this runner no longer owns the run:
  // it was reassigned, suspended for Inbox, or its lease expired. Pushing or
  // opening a pull request now writes to a shared branch on behalf of a run
  // somebody else is already running.
  const lease = await openWith(async () => { throw rejection(409); });
  try {
    assert.equal(lease.rejected, true);
    let delivered = 0;
    const result = await deliverUnderLease(lease, async () => { delivered += 1; return "pushed"; });
    assert.equal(delivered, 0, "delivery ran without authority over the run");
    assert.equal(result, null);
  } finally { lease.close(); }
});

test("a suspended run is distinguished from a lost one", async () => {
  const lease = await openWith(async () => { throw rejection(409, "WAITING_INBOX"); });
  try {
    assert.equal(lease.rejected, true);
    assert.equal(lease.waitingInbox, true);
  } finally { lease.close(); }
});

test("an unreachable API is survivable, unlike a revoked lease", async () => {
  // A transient heartbeat failure must not be read as "someone took the run":
  // the push is often the only thing that can still save the run's work.
  const lease = await openWith(async () => { throw new Error("fetch failed"); });
  try {
    assert.equal(lease.rejected, false);
    let delivered = 0;
    await deliverUnderLease(lease, async () => { delivered += 1; return "pushed"; });
    assert.equal(delivered, 1);
  } finally { lease.close(); }
});

test("the phase deadline is measured from when the renewal was sent, not when it answered", async () => {
  // The API stamps leaseExpiresAt from its own clock at or after the send. If
  // the runner measured from the response, a slow response would silently
  // spend the round trip out of the reserve the arithmetic depends on.
  let clock = 1_000;
  const lease = await openDeliveryLease(config, claim, 0, {
    send: async () => { clock += 9_000; return { ok: true, cancellation: null }; },
    now: () => clock,
    startedAt: new Date(0),
  });
  try {
    assert.equal(lease.renewedAt, 1_000);
    assert.equal(lease.deadline, 1_000 + 60_000 - DELIVERY_LEASE_RESERVE_MS);
  } finally { lease.close(); }
});

test("a failed opening renewal falls back to the last renewal that landed", async () => {
  // 40s after the last known-good renewal of a 60s lease there is no 35s
  // budget left, so the phase gets the bounded floor instead: publishing the
  // branch is still worth more than the arithmetic, but not unboundedly so.
  let clock = 40_000;
  const lease = await openDeliveryLease(config, claim, 0, {
    send: async () => { throw new Error("fetch failed"); },
    now: () => clock,
    startedAt: new Date(0),
  });
  try {
    assert.equal(lease.renewedAt, 0);
    assert.equal(lease.deadline, clock + MIN_DELIVERY_BUDGET_MS);
  } finally { lease.close(); }
});

test("a typed cancellation rejects delivery without treating it as Inbox suspension", async () => {
  const cancellation = { requestId: "cancel-1", reason: "operator stop", requestedAt: new Date(0).toISOString() };
  const lease = await openDeliveryLease(config, claim, 0, {
    send: async () => ({ ok: false, cancellation }),
    now: () => 1_000,
    startedAt: new Date(0),
  });
  try {
    assert.equal(lease.rejected, true);
    assert.equal(lease.waitingInbox, false);
    assert.deepEqual(lease.cancellation, cancellation);
    let delivered = 0;
    await deliverUnderLease(lease, async () => { delivered += 1; return null; });
    assert.equal(delivered, 0);
  } finally { lease.close(); }
});

test("a lease rejected by a later heartbeat still blocks the next remote write", async () => {
  let calls = 0;
  const lease = await openDeliveryLease({ ...config, heartbeatIntervalMs: 5 }, claim, 0, {
    send: async () => { calls += 1; if (calls > 1) throw rejection(409); return { ok: true, cancellation: null }; },
    now: () => 0,
    startedAt: new Date(0),
  });
  try {
    assert.equal(lease.rejected, false);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.equal(lease.rejected, true);
    let delivered = 0;
    await deliverUnderLease(lease, async () => { delivered += 1; return null; });
    assert.equal(delivered, 0);
  } finally { lease.close(); }
});
