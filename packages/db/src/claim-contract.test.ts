import assert from "node:assert/strict";
import test from "node:test";

import {
  MECHANICAL_CONTRACT_MISMATCH_CODE,
  RUN_COMPLETION_CONTRACT_VERSION,
} from "./claim-contract.js";

test("exports one completion contract version for independently built processes", () => {
  assert.equal(RUN_COMPLETION_CONTRACT_VERSION, 1);
  assert.equal(Number.isInteger(RUN_COMPLETION_CONTRACT_VERSION), true);
  assert.equal(RUN_COMPLETION_CONTRACT_VERSION > 0, true);
  assert.equal(MECHANICAL_CONTRACT_MISMATCH_CODE, "mechanical_contract_mismatch");
});
