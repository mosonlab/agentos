/**
 * The bundle validator's own boundaries.
 *
 * `release-migrate.test.ts` proves the migrator refuses each fault; this file
 * proves the judgements at the edges — the exact age that is still fresh, the
 * exact skew that is still tolerated, and the field shapes that a producer
 * cannot get half right.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ARCHIVE_MEMBER,
  ATTESTATION_MEMBER,
  ATTESTATION_MAX_AGE_MS,
  ATTESTATION_MAX_SKEW_MS,
  parseAttestation,
  validateBackupBundle,
  type BundleFacts,
} from "./backup-bundle.js";

const NOW_MS = Date.parse("2026-08-19T12:00:00Z");
const TARGET = "0123456789abcdef0123456789abcdef";
const WAL = "fedcba9876543210fedcba9876543210";
const SHA = "ab".repeat(32);

const attestation = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  version: 1,
  createdAt: new Date(NOW_MS).toISOString(),
  archive: { bytes: 1024, sha256: SHA },
  targetFingerprint: TARGET,
  walFingerprint: WAL,
  quiescence: "exclusive-maintenance-lock-held-for-the-whole-dump",
  ...overrides,
});

const facts = (overrides: Partial<BundleFacts> = {}): BundleFacts => ({
  isDirectory: true,
  directoryMode: 0o700,
  entries: [
    { name: ARCHIVE_MEMBER, kind: "file", mode: 0o600 },
    { name: ATTESTATION_MEMBER, kind: "file", mode: 0o600 },
  ],
  archive: { bytes: 1024, sha256: SHA, magic: "PGDMP" },
  attestationText: attestation(),
  ...overrides,
});

const judge = (overrides: Partial<BundleFacts> = {}, nowMs = NOW_MS): ReturnType<typeof validateBackupBundle> =>
  validateBackupBundle(facts(overrides), { nowMs, targetFingerprint: TARGET });

describe("validateBackupBundle", () => {
  it("accepts the bundle the producer writes", () => {
    const result = judge();
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.attestation.walFingerprint, WAL);
  });

  it("accepts members in either order, because a directory listing has none", () => {
    const swapped = judge({ entries: [
      { name: ATTESTATION_MEMBER, kind: "file", mode: 0o600 },
      { name: ARCHIVE_MEMBER, kind: "file", mode: 0o600 },
    ] });
    assert.equal(swapped.ok, true);
  });

  it("refuses a setuid or group-readable member even when the low bits look right", () => {
    for (const mode of [0o4600, 0o640, 0o606, 0o700]) {
      const result = judge({ entries: [
        { name: ARCHIVE_MEMBER, kind: "file", mode },
        { name: ATTESTATION_MEMBER, kind: "file", mode: 0o600 },
      ] });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "bundle-member-mode-is-not-0600");
    }
  });

  it("holds the age boundary exactly", () => {
    const justFresh = judge({}, NOW_MS + ATTESTATION_MAX_AGE_MS);
    assert.equal(justFresh.ok, true);
    const justStale = judge({}, NOW_MS + ATTESTATION_MAX_AGE_MS + 1);
    assert.equal(justStale.ok === false && justStale.reason, "attestation-is-older-than-fifteen-minutes");
  });

  it("holds the clock-skew boundary exactly", () => {
    const tolerated = judge({}, NOW_MS - ATTESTATION_MAX_SKEW_MS);
    assert.equal(tolerated.ok, true);
    const beyond = judge({}, NOW_MS - ATTESTATION_MAX_SKEW_MS - 1);
    assert.equal(beyond.ok === false && beyond.reason, "attestation-is-more-than-sixty-seconds-in-the-future");
  });

  it("judges shape before contents, so a malformed bundle never has its digest believed", () => {
    // Both faults at once: the member set is wrong *and* the digest disagrees.
    // The member set is the one reported, because a bundle whose shape is wrong
    // is not a bundle whose contents mean anything.
    const result = judge({
      entries: [{ name: ARCHIVE_MEMBER, kind: "file", mode: 0o600 }],
      archive: { bytes: 1, sha256: "cd".repeat(32), magic: "PGDMP" },
    });
    assert.equal(result.ok === false && result.reason, "bundle-members-are-not-exactly-archive-dump-and-attestation-json");
  });

  it("does not accept a bundle whose target fingerprint merely looks similar", () => {
    const result = validateBackupBundle(facts(), { nowMs: NOW_MS, targetFingerprint: TARGET.toUpperCase() });
    assert.equal(result.ok === false && result.reason, "attestation-describes-a-different-target");
  });
});

describe("parseAttestation", () => {
  it("refuses every field it cannot use, one at a time", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ version: "1" }, "attestation-version-is-unsupported"],
      [{ createdAt: 1_800_000_000 }, "attestation-is-malformed"],
      [{ createdAt: "not-a-time" }, "attestation-created-at-is-unparsable"],
      [{ archive: null }, "attestation-is-malformed"],
      [{ archive: { bytes: 0, sha256: SHA } }, "attestation-is-malformed"],
      [{ archive: { bytes: 1.5, sha256: SHA } }, "attestation-is-malformed"],
      [{ archive: { bytes: 1024, sha256: "ZZ".repeat(32) } }, "attestation-is-malformed"],
      [{ archive: { bytes: 1024, sha256: SHA.slice(0, 63) } }, "attestation-is-malformed"],
      [{ targetFingerprint: "0123" }, "attestation-is-malformed"],
      [{ walFingerprint: 42 }, "attestation-is-malformed"],
      [{ quiescence: "" }, "attestation-is-malformed"],
    ];
    for (const [overrides, reason] of cases) {
      const result = parseAttestation(attestation(overrides));
      assert.equal(result.ok, false, JSON.stringify(overrides));
      assert.equal(result.ok === false && result.reason, reason, JSON.stringify(overrides));
    }
  });

  it("refuses text that is not a JSON object at all", () => {
    for (const text of ["", "[]", "null", "\"attested\"", "{oops}"]) {
      const result = parseAttestation(text);
      assert.equal(result.ok, false, text);
    }
  });

  it("tolerates a field it does not know, so a later producer version can add one", () => {
    const result = parseAttestation(attestation({ note: "added-by-a-later-producer" }));
    assert.equal(result.ok, true);
  });
});
