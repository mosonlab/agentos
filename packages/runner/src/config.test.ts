import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_API_URL, loadRunnerConfig } from "./config.js";
import { LocalApiDestinationError } from "./local-origin.js";

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
  // workspace-root.ts's defaultWorkspaceRoot, and if either moves, this fails loudly instead
  // of the two silently sweeping different roots.
  assert.match(
    apiSource("workspace-root.ts"),
    /export const defaultWorkspaceRoot = \(\): string => join\(homedir\(\), "\.agentos", "runs"\);/u,
  );
});

test("the daemon reports the runner package version", () => {
  const metadata = require("../package.json") as { version: string };
  assert.equal(loadRunnerConfig().daemonVersion, metadata.version);
});

test("a run-as deployment reads the staged session baseline unless explicitly overridden", () => {
  const previousPrefix = process.env.RUNNER_RUN_AS_PREFIX;
  const previousBaseline = process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT;
  try {
    process.env.RUNNER_RUN_AS_PREFIX = "sudo -u _agentos1 -E --";
    delete process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT;
    assert.equal(loadRunnerConfig().sessionConfigBaselineRoot, "/opt/agentos/lib/session-config-baseline");
    process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT = "/staged/test-baseline";
    assert.equal(loadRunnerConfig().sessionConfigBaselineRoot, "/staged/test-baseline");
  } finally {
    if (previousPrefix === undefined) delete process.env.RUNNER_RUN_AS_PREFIX;
    else process.env.RUNNER_RUN_AS_PREFIX = previousPrefix;
    if (previousBaseline === undefined) delete process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT;
    else process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT = previousBaseline;
  }
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

const withApiUrl = (value: string | undefined, body: () => void): void => {
  const previous = process.env.RUNNER_API_URL;
  if (value === undefined) delete process.env.RUNNER_API_URL;
  else process.env.RUNNER_API_URL = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.RUNNER_API_URL;
    else process.env.RUNNER_API_URL = previous;
  }
};

test("the default control-plane destination is the loopback literal, not a resolvable name", () => {
  // `localhost` was the old default. It is a name: a hosts file, a DNS search
  // domain or an IPv6-first resolver decides where it points, and this process
  // attaches the runner bearer token to whatever answers. The default must be
  // the address itself, and it must also satisfy the destination policy.
  assert.equal(DEFAULT_API_URL, "http://127.0.0.1:3000");
  withApiUrl(undefined, () => {
    assert.equal(loadRunnerConfig().apiUrl, "http://127.0.0.1:3000");
  });
  // No `http://localhost` literal survives anywhere in the loader itself.
  assert.doesNotMatch(readFileSync(fileURLToPath(new URL("./config.ts", import.meta.url)), "utf8"), /https?:\/\/localhost/u);
});

test("a non-loopback control-plane destination is refused when the config is loaded", () => {
  // Refused here means refused before the runner has a client: index.ts calls
  // loadRunnerConfig before the preflight and the poll loop.
  for (const destination of ["http://localhost:3000", "http://198.51.100.7:3000", "https://127.0.0.1:3000"]) {
    withApiUrl(destination, () => {
      assert.throws(loadRunnerConfig, LocalApiDestinationError, `${destination} was accepted`);
    });
  }
});
