import assert from "node:assert/strict";
import test from "node:test";

import { FAILURE_EVIDENCE_LIMIT, truncateEvidence } from "./failure-envelope.js";

test("truncation keeps the tail, where a CLI states its verdict", () => {
  const noise = "progress\n".repeat(2_000);
  const summary = truncateEvidence(`${noise}fatal: Authentication failed`);
  assert.ok(summary);
  assert.ok(summary.endsWith("fatal: Authentication failed"), "the verdict at the end of the stream must survive");
  assert.match(summary, /^…\[\d+ earlier characters truncated\]\n/u);
  assert.ok(summary.length <= FAILURE_EVIDENCE_LIMIT + 64);
});
