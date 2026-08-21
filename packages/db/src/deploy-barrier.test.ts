import assert from "node:assert/strict";
import test from "node:test";

import { DEPLOY_BARRIER_CLASS, DEPLOY_BARRIER_KEY, deployBarrierAllowsClaim } from "./deploy-barrier.js";

test("claim barrier uses the shared transaction lock and fails closed", async () => {
  const calls: unknown[] = [];
  const tx = {
    $queryRaw: async (query: unknown) => {
      calls.push(query);
      return [{ granted: false }];
    },
  };
  assert.equal(await deployBarrierAllowsClaim(tx as never), false);
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /pg_try_advisory_xact_lock_shared/u);
  assert.match(JSON.stringify(calls[0]), new RegExp(String(DEPLOY_BARRIER_CLASS), "u"));
  assert.match(JSON.stringify(calls[0]), new RegExp(String(DEPLOY_BARRIER_KEY), "u"));
});

test("claim proceeds only on one affirmative barrier row", async () => {
  for (const [rows, expected] of [
    [[{ granted: true }], true],
    [[{ granted: false }], false],
    [[], false],
    [[{ granted: true }, { granted: true }], false],
  ] as const) {
    const tx = { $queryRaw: async () => rows };
    assert.equal(await deployBarrierAllowsClaim(tx as never), expected);
  }
});
