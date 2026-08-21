import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nextStoredCliAvailability,
  preserveCliAvailability,
  readStoredCliAvailability,
  storeCliAvailability,
} from "./runner-cli-availability.js";

test("a continuous missing-CLI outage keeps one identity until recovery", () => {
  const first = nextStoredCliAvailability({
    runner: "CLAUDE", binary: "claude", available: false, resolvedPath: null,
  }, null, new Date("2026-08-21T01:00:00.000Z"));
  const repeated = nextStoredCliAvailability({
    runner: "CLAUDE", binary: "/opt/claude", available: false, resolvedPath: null,
  }, first, new Date("2026-08-21T01:01:00.000Z"));

  assert.equal(repeated.outageKey, first.outageKey);
  assert.equal(repeated.unavailableSince, first.unavailableSince);
  assert.match(repeated.reason ?? "", /\/opt\/claude/u);
  assert.equal(repeated.lastCheckedAt, "2026-08-21T01:01:00.000Z");

  const recovered = nextStoredCliAvailability({
    runner: "CLAUDE", binary: "/opt/claude", available: true, resolvedPath: "/opt/claude",
  }, repeated, new Date("2026-08-21T01:02:00.000Z"));
  assert.deepEqual(recovered, {
    available: true,
    binary: "/opt/claude",
    resolvedPath: "/opt/claude",
    reason: null,
    unavailableSince: null,
    outageKey: null,
    lastCheckedAt: "2026-08-21T01:02:00.000Z",
  });
});

test("availability is an explicit capability and preflight preserves it", () => {
  const missing = nextStoredCliAvailability({
    runner: "PI", binary: "pi", available: false, resolvedPath: null,
  }, null, new Date("2026-08-21T02:00:00.000Z"));
  const stored = storeCliAvailability({ heartbeat: true }, missing);
  const merged = preserveCliAvailability({ resume: true }, stored);

  assert.deepEqual(readStoredCliAvailability(merged), missing);
  assert.deepEqual(merged, { resume: true, cliAvailability: missing });
});

test("preflight cannot inject the reserved CLI availability capability", () => {
  const merged = preserveCliAvailability({
    resume: true,
    cliAvailability: { available: false },
  }, null);

  assert.deepEqual(merged, { resume: true });
  assert.equal(readStoredCliAvailability(merged), null);
});

test("malformed persisted availability fails loudly", () => {
  assert.throws(
    () => readStoredCliAvailability({ cliAvailability: { available: false } }),
    /capabilities\.cliAvailability is malformed/u,
  );
});
