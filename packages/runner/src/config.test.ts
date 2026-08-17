import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadRunnerConfig } from "./config.js";

const require = createRequire(import.meta.url);

const apiSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../api/src/${relative}`, import.meta.url)), "utf8");

test("the default workspace root matches the API's definition of it", () => {
  const previous = process.env.RUNNER_WORKSPACE_ROOT;
  delete process.env.RUNNER_WORKSPACE_ROOT;
  try {
    assert.equal(loadRunnerConfig().workspaceRoot, join(homedir(), ".agentos", "runs"));
  } finally {
    if (previous !== undefined) process.env.RUNNER_WORKSPACE_ROOT = previous;
  }

  // The runner cannot import from @agentos/api, so this default exists twice. Two
  // independent definitions of one path is the exact shape of the three-way default bug
  // this batch fixed, so pin them against each other by source: the API side is
  // reconcile.ts's defaultWorkspaceRoot, and if either moves, this fails loudly instead
  // of the two silently sweeping different roots.
  assert.match(
    apiSource("reconcile.ts"),
    /export const defaultWorkspaceRoot = \(\): string => join\(homedir\(\), "\.agentos", "runs"\);/u,
  );
});

test("the daemon reports the runner package version", () => {
  const metadata = require("../package.json") as { version: string };
  assert.equal(loadRunnerConfig().daemonVersion, metadata.version);
});

test("the tool inactivity deadline defaults to 30 minutes and rejects unsafe values", () => {
  const previous = process.env.RUNNER_TOOL_DEADLINE_MS;
  try {
    delete process.env.RUNNER_TOOL_DEADLINE_MS;
    assert.equal(loadRunnerConfig().toolDeadlineMs, 30 * 60_000);

    process.env.RUNNER_TOOL_DEADLINE_MS = "0";
    assert.throws(() => loadRunnerConfig(), /RUNNER_TOOL_DEADLINE_MS must be a positive integer/u);

    process.env.RUNNER_TOOL_DEADLINE_MS = "not-a-number";
    assert.throws(() => loadRunnerConfig(), /RUNNER_TOOL_DEADLINE_MS must be a positive integer/u);

    process.env.RUNNER_TOOL_DEADLINE_MS = "1800000ms";
    assert.throws(() => loadRunnerConfig(), /RUNNER_TOOL_DEADLINE_MS must be a positive integer/u);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TOOL_DEADLINE_MS;
    else process.env.RUNNER_TOOL_DEADLINE_MS = previous;
  }
});
