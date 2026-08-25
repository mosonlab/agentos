import assert from "node:assert/strict";
import test from "node:test";

import {
  READINESS_CLAIM_LEASE_MS,
  READINESS_READ_BUDGET_MS,
} from "./merge-readiness-worker.js";

test("readiness GitHub reads have a 20-second budget within the claim lease", () => {
  assert.equal(READINESS_READ_BUDGET_MS, 20_000);
  assert.ok(READINESS_READ_BUDGET_MS < READINESS_CLAIM_LEASE_MS);
});
