import assert from "node:assert/strict";
import test from "node:test";

import { runWithNetworkRetry } from "./network-retry.js";

test("git fetch uses the shared three-attempt transient retry policy", async () => {
  let calls = 0;
  const result = await runWithNetworkRetry("git", ["fetch", "origin"], async () => {
    calls += 1;
    if (calls < 3) throw new Error("fatal: connection reset by peer (ECONNRESET)");
    return "fetched";
  }, { wait: async () => undefined });
  assert.equal(result, "fetched");
  assert.equal(calls, 3);
});

test("commands outside the delivery network allowlist are never retried", async () => {
  let calls = 0;
  await assert.rejects(runWithNetworkRetry("git", ["commit"], async () => {
    calls += 1;
    throw new Error("ECONNRESET in a hook");
  }, { wait: async () => undefined }));
  assert.equal(calls, 1);
});
