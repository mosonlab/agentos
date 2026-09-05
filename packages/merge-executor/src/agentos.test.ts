/**
 * The control plane composes a refusal; this process decodes it. Both sides
 * are here, so a change to one that the other cannot read fails in this file
 * rather than in production, where the two builds are released separately.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RUN_COMPLETION_CONTRACT_VERSION, mechanicalContractMismatch } from "@anneal/db/claim-contract";

import { decodeContractMismatchRefusal } from "./agentos.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");

test("the executor decodes exactly the refusal the control plane composes", () => {
  for (const receivedVersion of [null, RUN_COMPLETION_CONTRACT_VERSION - 1, RUN_COMPLETION_CONTRACT_VERSION + 1]) {
    const mismatch = mechanicalContractMismatch({ receivedVersion, taskId: "task-1", now: NOW });
    assert.ok(mismatch);
    // Exactly what the route sends: the refusal's `error` plus the rest of it.
    const { error, ...detail } = mismatch.refusal;
    assert.deepEqual(decodeContractMismatchRefusal(JSON.stringify({ error, ...detail })), mismatch.refusal);
  }
});

test("a refusal that is not a contract mismatch is not decoded as one", () => {
  assert.equal(decodeContractMismatchRefusal(JSON.stringify({ error: "no", reason: "prior-output-missing" })), null);
  assert.equal(decodeContractMismatchRefusal(JSON.stringify({ error: "no", code: "other", expectedVersion: 1, receivedVersion: 0 })), null);
});

test("a mismatch refusal missing its version evidence is not decoded", () => {
  const mismatch = mechanicalContractMismatch({ receivedVersion: null, taskId: "task-1", now: NOW });
  assert.ok(mismatch);
  const { expectedVersion, ...withoutExpected } = mismatch.refusal;
  assert.equal(decodeContractMismatchRefusal(JSON.stringify(withoutExpected)), null);
  assert.equal(decodeContractMismatchRefusal(JSON.stringify({ ...mismatch.refusal, error: 7 })), null);
});

test("a body that is not a JSON object is not decoded", () => {
  assert.equal(decodeContractMismatchRefusal("<html>502</html>"), null);
  assert.equal(decodeContractMismatchRefusal("[]"), null);
  assert.equal(decodeContractMismatchRefusal("null"), null);
});
