import assert from "node:assert/strict";
import test from "node:test";

import { runnerBackendAllowsClaim } from "./runner-backend-health.js";

const cliAvailability = (available: boolean) => ({
  cliAvailability: available
    ? {
        available: true,
        binary: "codex",
        resolvedPath: "/opt/runner/bin/codex",
        reason: null,
        unavailableSince: null,
        outageKey: null,
        lastCheckedAt: "2026-08-29T12:00:00.000Z",
      }
    : {
        available: false,
        binary: "codex",
        resolvedPath: null,
        reason: "runner-cli-unavailable: codex CLI was not found",
        unavailableSince: "2026-08-29T12:00:00.000Z",
        outageKey: "runner-cli-unavailable:CODEX:test",
        lastCheckedAt: "2026-08-29T12:00:00.000Z",
      },
});

test("runner backend claim allowance requires available CLI and a closed circuit", () => {
  assert.equal(runnerBackendAllowsClaim(null), true, "an absent backend row preserves legacy allowance");
  assert.equal(runnerBackendAllowsClaim({ capabilities: cliAvailability(true), circuitOpen: false }), true);
  assert.equal(runnerBackendAllowsClaim({ capabilities: cliAvailability(false), circuitOpen: false }), false);
  assert.equal(runnerBackendAllowsClaim({ capabilities: cliAvailability(true), circuitOpen: true }), false);
  // @ts-expect-error Prisma findUnique returns null, never undefined.
  runnerBackendAllowsClaim(undefined);
});
