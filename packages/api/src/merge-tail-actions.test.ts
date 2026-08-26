import assert from "node:assert/strict";
import test from "node:test";

import { shellQuote } from "./merge-tail-actions.js";

test("shellQuote preserves shell metacharacters as literal single-quoted text", () => {
  assert.equal(shellQuote("feature/$branch"), "'feature/$branch'");
  assert.equal(shellQuote("feature/`branch`"), "'feature/`branch`'");
  assert.equal(shellQuote("feature/topic;next"), "'feature/topic;next'");
  assert.equal(shellQuote("feature/reviewer'fix"), "'feature/reviewer'\\''fix'");
});
