import assert from "node:assert/strict";
import { test } from "node:test";

import type { CancellationRequest } from "./api.js";
import { createRunAuthority } from "./run-authority.js";

type Provider = { id: string };

const cancellation = (requestId: string): CancellationRequest => ({
  requestId,
  reason: "operator stop",
  requestedAt: new Date(0).toISOString(),
});

test("revocation during an awaited launch drains the provider before launch returns", async () => {
  let finishLaunch!: (provider: Provider) => void;
  const launchResult = new Promise<Provider>((resolve) => { finishLaunch = resolve; });
  const stops: Array<{ provider: Provider; reason: string }> = [];
  const authority = createRunAuthority<Provider>({
    stopProvider: async (provider, reason) => {
      stops.push({ provider, reason });
      return { processAlive: false };
    },
    acknowledgeCancellation: async () => undefined,
  });

  const launched = authority.launch(async () => launchResult);
  const revoked = authority.adopt({ held: false, reason: "revoked" });
  finishLaunch({ id: "provider-1" });

  assert.equal(await launched, null);
  await revoked;
  assert.equal(await authority.checkpoint(), "revoked");
  assert.deepEqual(stops, [{ provider: { id: "provider-1" }, reason: "fencing token rejected" }]);
});

test("duplicate cancellation acknowledges the first request once", async () => {
  const acknowledgements: CancellationRequest[] = [];
  const authority = createRunAuthority<Provider>({
    stopProvider: async () => ({ processAlive: false }),
    acknowledgeCancellation: async (request) => { acknowledgements.push(request); },
  });
  authority.abandonProviderLaunch();

  await Promise.all([
    authority.adopt({ held: false, reason: "cancelled", request: cancellation("cancel-1") }),
    authority.adopt({ held: false, reason: "cancelled", request: cancellation("cancel-2") }),
  ]);

  assert.equal(await authority.checkpoint(), "cancelled");
  assert.deepEqual(acknowledgements.map((request) => request.requestId), ["cancel-1"]);
});

test("cancellation wins a revocation race without stopping or acknowledging twice", async () => {
  let finishLaunch!: (provider: Provider) => void;
  const launchResult = new Promise<Provider>((resolve) => { finishLaunch = resolve; });
  const stops: Provider[] = [];
  const acknowledgements: CancellationRequest[] = [];
  const authority = createRunAuthority<Provider>({
    stopProvider: async (provider) => {
      stops.push(provider);
      return { processAlive: false };
    },
    acknowledgeCancellation: async (request) => { acknowledgements.push(request); },
  });

  const launched = authority.launch(async () => launchResult);
  const revoked = authority.adopt({ held: false, reason: "revoked" });
  const cancelled = authority.adopt({ held: false, reason: "cancelled", request: cancellation("cancel-1") });
  finishLaunch({ id: "provider-1" });

  assert.equal(await launched, null);
  await Promise.all([revoked, cancelled]);
  assert.equal(await authority.checkpoint(), "cancelled");
  assert.deepEqual(stops, [{ id: "provider-1" }]);
  assert.deepEqual(acknowledgements.map((request) => request.requestId), ["cancel-1"]);
});
