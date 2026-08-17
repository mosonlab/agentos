import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { claimRequestBody, runnerTelemetryBody } from "./api.js";
import { loadRunnerConfig } from "./config.js";

const require = createRequire(import.meta.url);
const packageVersion = (require("../package.json") as { version: string }).version;

test("claim and heartbeat telemetry carry the exact package version", async () => {
  const config = loadRunnerConfig();
  const stats = async (): Promise<{ bavail: number; bsize: number }> => ({ bavail: 12, bsize: 4_096 });
  const claim = await claimRequestBody(config, stats);
  const heartbeat = await runnerTelemetryBody(config, stats);
  assert.equal(claim.daemonVersion, packageVersion);
  assert.equal(heartbeat.daemonVersion, packageVersion);
  assert.equal(claim.daemonVersion, heartbeat.daemonVersion);
  assert.deepEqual(claim, {
    runnerId: config.runnerId,
    leaseSeconds: config.leaseSeconds,
    daemonVersion: packageVersion,
    diskFreeBytes: 49_152,
    pollIntervalMs: config.pollIntervalMs,
    workspaceRoot: config.workspaceRoot,
  });
});

test("a statfs failure omits disk telemetry without blocking a claim", async () => {
  const config = loadRunnerConfig();
  const claim = await claimRequestBody(config, async () => { throw new Error("unmounted"); });
  assert.equal(Object.hasOwn(claim, "diskFreeBytes"), false);
  assert.equal(claim.runnerId, config.runnerId);
  assert.equal(claim.leaseSeconds, config.leaseSeconds);
});

test("the claim telemetry stays inside the API schema bounds", async () => {
  const config = loadRunnerConfig();
  const body = await claimRequestBody(config, async () => ({ bavail: 1, bsize: 4_096 }));
  assert.ok(typeof body.daemonVersion === "string" && body.daemonVersion.length <= 40);
  assert.ok(Number.isSafeInteger(body.diskFreeBytes) && Number(body.diskFreeBytes) >= 0);
  assert.ok(Number.isSafeInteger(body.pollIntervalMs) && Number(body.pollIntervalMs) > 0 && Number(body.pollIntervalMs) <= 3_600_000);
  assert.ok(typeof body.workspaceRoot === "string" && body.workspaceRoot.length <= 500);
});
