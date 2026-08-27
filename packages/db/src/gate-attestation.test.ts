import assert from "node:assert/strict";
import test from "node:test";

import { deriveGateAttestation } from "./gate-attestation.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const V2 = "regression-verification-v2";
const V1 = "regression-verification";

const pass = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  schemaVersion: 2,
  outcome: "pass",
  headSha: HEAD,
  baseHeadSha: BASE,
  gateVerdict: "PASS",
  gateProof: `MERGE GATE: PASS ${HEAD}`,
  ...overrides,
});

test("a passing v2 verdict attests the head the gate signed", () => {
  assert.deepEqual(deriveGateAttestation(V2, pass()), {
    headSha: HEAD,
    baseHeadSha: BASE,
    proof: `MERGE GATE: PASS ${HEAD}`,
  });
});

test("a proof naming another commit attests nothing", () => {
  assert.equal(deriveGateAttestation(V2, pass({ gateProof: `MERGE GATE: PASS ${BASE}` })), null);
});

test("a proof line without an oid attests nothing", () => {
  assert.equal(deriveGateAttestation(V2, pass({ gateProof: "MERGE GATE: PASS" })), null);
  assert.equal(deriveGateAttestation(V2, pass({ gateProof: undefined })), null);
});

test("outcomes other than pass attest nothing", () => {
  const gateFail = JSON.stringify({
    schemaVersion: 2,
    outcome: "gate-fail",
    headSha: HEAD,
    baseHeadSha: BASE,
    gateVerdict: "FAIL",
    gateProof: "MERGE GATE: FAIL (unit tests)",
    summary: "unit tests",
  });
  assert.equal(deriveGateAttestation(V2, gateFail), null);
  const authorityResign = JSON.stringify({
    schemaVersion: 2,
    outcome: "authority-resign",
    headSha: HEAD,
    baseHeadSha: BASE,
    summary: "release authority must be re-signed",
  });
  assert.equal(deriveGateAttestation(V2, authorityResign), null);
});

test("the frozen v1 generation attests nothing, whatever it reports", () => {
  const v1Pass = JSON.stringify({
    schemaVersion: 1,
    outcome: "pass",
    headSha: HEAD,
    baseHeadSha: BASE,
    gateVerdict: "PASS",
  });
  assert.equal(deriveGateAttestation(V1, v1Pass), null);
  // A v1 body that forges the v2 proof line still attests nothing: the kind,
  // not the body, decides which generation is being read.
  assert.equal(deriveGateAttestation(V1, pass()), null);
});

test("non-regression outputs and unusable bodies attest nothing", () => {
  assert.equal(deriveGateAttestation("documentation", pass()), null);
  assert.equal(deriveGateAttestation(V2, "not json"), null);
  assert.equal(deriveGateAttestation(V2, null), null);
});
