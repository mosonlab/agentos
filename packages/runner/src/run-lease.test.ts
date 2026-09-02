import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlPlaneError,
  type Authority,
  type CancellationRequest,
} from "./api.js";
import { DELIVERY_LEASE_RESERVE_MS, MIN_DELIVERY_BUDGET_MS } from "./network-retry.js";
import {
  createRunLease,
  deliverUnderLease,
  type RunLeaseClock,
  type RunLeaseEvidence,
} from "./run-lease.js";

type Provider = { id: string };
type FakeInterval = {
  callback: () => void | Promise<void>;
  intervalMs: number;
  nextAt: number;
};

class FakeClock implements RunLeaseClock {
  time = 0;
  readonly intervals = new Set<FakeInterval>();

  now = (): number => this.time;

  setInterval = (callback: () => void | Promise<void>, intervalMs: number): unknown => {
    const interval = { callback, intervalMs, nextAt: this.time + intervalMs };
    this.intervals.add(interval);
    return interval;
  };

  clearInterval = (timer: unknown): void => {
    this.intervals.delete(timer as FakeInterval);
  };

  async advanceTo(target: number): Promise<void> {
    if (target < this.time) throw new Error("Fake clock cannot move backwards");
    while (true) {
      const nextAt = Math.min(...[...this.intervals].map((interval) => interval.nextAt));
      if (!Number.isFinite(nextAt) || nextAt > target) break;
      this.time = nextAt;
      const due = [...this.intervals].filter((interval) => interval.nextAt === nextAt);
      for (const interval of due) {
        interval.nextAt += interval.intervalMs;
        await interval.callback();
      }
    }
    this.time = target;
  }
}

const cancellation = (requestId: string): CancellationRequest => ({
  requestId,
  reason: "operator stop",
  requestedAt: new Date(0).toISOString(),
});

const rejection = (code?: string): Error => new ControlPlaneError(409, "rejected", code);

const createLease = (
  clock: FakeClock,
  send: (evidence: RunLeaseEvidence) => Promise<Authority>,
  overrides: Partial<Parameters<typeof createRunLease<Provider>>[0]> = {},
) => createRunLease<Provider>({
  heartbeatIntervalMs: 10,
  leaseSeconds: 60,
  initialPhase: { name: "provision", startedAt: new Date(clock.now()) },
  send,
  stopProvider: async () => ({ processAlive: false }),
  acknowledgeCancellation: async () => undefined,
  clock,
  ...overrides,
});

test("one renewal loop stays continuous across provision, execute, and deliver", async () => {
  const clock = new FakeClock();
  const attempts: Array<{ at: number; phase: string; startRunInFlight: boolean }> = [];
  let startRunInFlight = false;
  const lease = createLease(clock, async (evidence) => {
    attempts.push({
      at: clock.now(),
      phase: String(evidence.inFlightTool?.name ?? "execute"),
      startRunInFlight,
    });
    return { held: true };
  });

  try {
    await clock.advanceTo(10);
    await lease.enterPhase({
      name: "execute",
      evidence: async () => ({
        processAlive: true,
        lastProgressEventAt: new Date(clock.now()),
        inFlightTool: { name: "provider" },
      }),
    });

    let finishStartRun!: () => void;
    const startRunWrite = new Promise<void>((resolve) => { finishStartRun = resolve; });
    startRunInFlight = true;
    await clock.advanceTo(30);
    assert.deepEqual(
      attempts.filter((attempt) => attempt.startRunInFlight).map((attempt) => attempt.at),
      [20, 30],
      "the execute phase must renew while the startRun network write is in flight",
    );
    finishStartRun();
    await startRunWrite;
    startRunInFlight = false;

    await clock.advanceTo(35);
    await lease.enterPhase({ name: "deliver", startedAt: new Date(clock.now()) });
    await clock.advanceTo(45);

    assert.deepEqual(attempts.map((attempt) => attempt.phase), [
      "workspace-provision",
      "provider",
      "provider",
      "delivery",
      "delivery",
    ]);
    const attemptTimes = [0, ...attempts.map((attempt) => attempt.at)];
    for (let index = 1; index < attemptTimes.length; index += 1) {
      assert.ok(
        attemptTimes[index]! - attemptTimes[index - 1]! <= 10,
        `renewal gap exceeded cadence: ${attemptTimes[index - 1]} -> ${attemptTimes[index]}`,
      );
    }
  } finally {
    await lease.close();
  }
});

test("a rejected renewal reaches the authority verdict without caller-side adoption", async () => {
  const clock = new FakeClock();
  const lease = createLease(clock, async () => { throw rejection(); });
  lease.abandonProviderLaunch();
  try {
    await clock.advanceTo(10);
    assert.deepEqual(lease.authority, { held: false, reason: "revoked" });
    assert.equal(lease.held, false);
  } finally {
    await lease.close();
  }
});

test("revocation during an awaited launch drains the provider before launch returns", async () => {
  const clock = new FakeClock();
  let finishLaunch!: (provider: Provider) => void;
  const launchResult = new Promise<Provider>((resolve) => { finishLaunch = resolve; });
  const stops: Array<{ provider: Provider; reason: string }> = [];
  const lease = createLease(clock, async () => ({ held: true }), {
    stopProvider: async (provider, reason) => {
      stops.push({ provider, reason });
      return { processAlive: false };
    },
  });

  try {
    const launched = lease.launch(async () => launchResult);
    const revoked = lease.adoptError(rejection());
    finishLaunch({ id: "provider-1" });

    assert.equal(await launched, null);
    await revoked;
    assert.deepEqual(await lease.checkpoint(), { held: false, reason: "revoked" });
    assert.deepEqual(stops, [{ provider: { id: "provider-1" }, reason: "fencing token rejected" }]);
  } finally {
    await lease.close();
  }
});

test("a cancellation stops the provider and acknowledges its durable request once", async () => {
  const clock = new FakeClock();
  const acknowledgements: CancellationRequest[] = [];
  const stops: Provider[] = [];
  const request = cancellation("cancel-1");
  const lease = createLease(clock, async () => ({ held: false, reason: "cancelled", request }), {
    stopProvider: async (provider) => { stops.push(provider); return { processAlive: false }; },
    acknowledgeCancellation: async (received) => { acknowledgements.push(received); },
  });
  const provider = await lease.launch(async () => ({ id: "provider-1" }));
  assert.deepEqual(provider, { id: "provider-1" });

  try {
    await clock.advanceTo(20);
    assert.deepEqual(await lease.checkpoint(), { held: false, reason: "cancelled", request });
    assert.deepEqual(stops, [{ id: "provider-1" }]);
    assert.deepEqual(acknowledgements, [request]);
  } finally {
    await lease.close();
  }
});

test("a revoked Lease blocks remote delivery", async () => {
  const clock = new FakeClock();
  const lease = createLease(clock, async () => { throw rejection(); });
  lease.abandonProviderLaunch();
  try {
    await lease.enterPhase({ name: "deliver", startedAt: new Date(0) });
    let delivered = 0;
    const result = await deliverUnderLease(lease, async () => { delivered += 1; return "pushed"; });
    assert.equal(delivered, 0);
    assert.equal(result, null);
  } finally {
    await lease.close();
  }
});

test("Inbox suspension remains distinct from lost authority", async () => {
  const clock = new FakeClock();
  const lease = createLease(clock, async () => { throw rejection("WAITING_INBOX"); });
  lease.abandonProviderLaunch();
  try {
    await lease.enterPhase({ name: "deliver", startedAt: new Date(0) });
    assert.deepEqual(lease.authority, { held: false, reason: "waiting-inbox" });
  } finally {
    await lease.close();
  }
});

test("a transport failure is survivable and does not block delivery", async () => {
  const clock = new FakeClock();
  const lease = createLease(clock, async () => { throw new Error("fetch failed"); });
  lease.abandonProviderLaunch();
  try {
    await lease.enterPhase({ name: "deliver", startedAt: new Date(0) });
    let delivered = 0;
    await deliverUnderLease(lease, async () => { delivered += 1; return "pushed"; });
    assert.equal(lease.held, true);
    assert.equal(delivered, 1);
  } finally {
    await lease.close();
  }
});

test("the delivery deadline is measured from when its renewal was sent", async () => {
  const clock = new FakeClock();
  clock.time = 1_000;
  const lease = createLease(clock, async () => {
    clock.time += 9_000;
    return { held: true };
  });
  lease.abandonProviderLaunch();
  try {
    await lease.enterPhase({ name: "deliver", startedAt: new Date(0) });
    assert.equal(lease.deadline, 1_000 + 60_000 - DELIVERY_LEASE_RESERVE_MS);
  } finally {
    await lease.close();
  }
});

test("a failed delivery renewal uses the last renewal that landed", async () => {
  const clock = new FakeClock();
  const lease = createLease(clock, async () => { throw new Error("fetch failed"); });
  lease.abandonProviderLaunch();
  clock.time = 40_000;
  try {
    await lease.enterPhase({ name: "deliver", startedAt: new Date(0) });
    assert.equal(lease.deadline, clock.time + MIN_DELIVERY_BUDGET_MS);
  } finally {
    await lease.close();
  }
});

test("a later renewal rejection blocks the next remote write", async () => {
  const clock = new FakeClock();
  let calls = 0;
  const lease = createLease(clock, async () => {
    calls += 1;
    if (calls > 1) throw rejection();
    return { held: true };
  });
  lease.abandonProviderLaunch();
  try {
    await lease.enterPhase({ name: "deliver", startedAt: new Date(0) });
    await clock.advanceTo(10);
    let delivered = 0;
    await deliverUnderLease(lease, async () => { delivered += 1; return null; });
    assert.equal(lease.held, false);
    assert.equal(delivered, 0);
  } finally {
    await lease.close();
  }
});
