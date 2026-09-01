import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_API_URL, loadRunnerConfig, runnerProxyEnvironment } from "./config.js";
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

  // The runner cannot import from @anneal/api, so this default exists twice. Two
  // independent definitions of one path is the exact shape of the three-way default bug
  // this batch fixed, so pin them against each other by source: the API side is
  // workspace-root.ts's defaultWorkspaceRoot, and if either moves, this fails loudly instead
  // of the two silently sweeping different roots.
  assert.match(
    apiSource("workspace-root.ts"),
    /export const defaultWorkspaceRoot = \(\): string => join\(homedir\(\), "\.agentos", "runs"\);/u,
  );
});

test("host proof slots default to three and accept strict positive integer overrides", () => {
  const previous = process.env.AGENTOS_HOST_PROOF_SLOTS;
  try {
    delete process.env.AGENTOS_HOST_PROOF_SLOTS;
    assert.equal(loadRunnerConfig().hostProofSlots, 3);

    for (const [raw, expected] of [["1", 1], ["7", 7], ["9007199254740991", Number.MAX_SAFE_INTEGER]] as const) {
      process.env.AGENTOS_HOST_PROOF_SLOTS = raw;
      assert.equal(loadRunnerConfig().hostProofSlots, expected);
    }

    for (const raw of ["", "0", "-1", "1.5", "1slot", " 3", "3 ", "9007199254740992"]) {
      process.env.AGENTOS_HOST_PROOF_SLOTS = raw;
      assert.throws(loadRunnerConfig, /AGENTOS_HOST_PROOF_SLOTS must be a positive integer/u);
    }
  } finally {
    if (previous === undefined) delete process.env.AGENTOS_HOST_PROOF_SLOTS;
    else process.env.AGENTOS_HOST_PROOF_SLOTS = previous;
  }
});

test("the dependency cache defaults beside the workspace root and accepts an explicit runner-owned root", () => {
  const previousWorkspace = process.env.RUNNER_WORKSPACE_ROOT;
  const previousCache = process.env.RUNNER_DEPENDENCY_CACHE_ROOT;
  try {
    process.env.RUNNER_WORKSPACE_ROOT = "/var/agentos/workspaces";
    delete process.env.RUNNER_DEPENDENCY_CACHE_ROOT;
    assert.equal(loadRunnerConfig().dependencyCacheRoot, "/var/agentos/dependency-cache");
    process.env.RUNNER_DEPENDENCY_CACHE_ROOT = "/srv/agentos/dependencies";
    assert.equal(loadRunnerConfig().dependencyCacheRoot, "/srv/agentos/dependencies");
  } finally {
    if (previousWorkspace === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
    else process.env.RUNNER_WORKSPACE_ROOT = previousWorkspace;
    if (previousCache === undefined) delete process.env.RUNNER_DEPENDENCY_CACHE_ROOT;
    else process.env.RUNNER_DEPENDENCY_CACHE_ROOT = previousCache;
  }
});

// The mirror belongs to the account that runs the tasks, not to the machine's
// workspace area: it is fetched with that account's credentials and read only
// by it, and its home is the one directory every deployment already gives that
// account at 0700.
test("the repository mirror defaults into the task account's home and accepts an explicit root", () => {
  const previousHome = process.env.RUNNER_HOME;
  const previousMirror = process.env.RUNNER_REPO_MIRROR_ROOT;
  try {
    process.env.RUNNER_HOME = "/opt/agentos/accounts/runner-1";
    delete process.env.RUNNER_REPO_MIRROR_ROOT;
    assert.equal(loadRunnerConfig().repoMirrorRoot, "/opt/agentos/accounts/runner-1/.agentos/repo-mirrors");
    process.env.RUNNER_REPO_MIRROR_ROOT = "/srv/agentos/mirrors";
    assert.equal(loadRunnerConfig().repoMirrorRoot, "/srv/agentos/mirrors");
  } finally {
    if (previousHome === undefined) delete process.env.RUNNER_HOME;
    else process.env.RUNNER_HOME = previousHome;
    if (previousMirror === undefined) delete process.env.RUNNER_REPO_MIRROR_ROOT;
    else process.env.RUNNER_REPO_MIRROR_ROOT = previousMirror;
  }
});

test("the daemon reports the runner package version", () => {
  const metadata = require("../package.json") as { version: string };
  assert.equal(loadRunnerConfig().daemonVersion, metadata.version);
});

test("an explicit runner Git identity is accepted only as a complete pair", () => {
  const previousName = process.env.RUNNER_GIT_USER_NAME;
  const previousEmail = process.env.RUNNER_GIT_USER_EMAIL;
  try {
    process.env.RUNNER_GIT_USER_NAME = "Configured Human";
    process.env.RUNNER_GIT_USER_EMAIL = "configured@example.invalid";
    assert.deepEqual(loadRunnerConfig().gitIdentity, {
      name: "Configured Human",
      email: "configured@example.invalid",
    });
    delete process.env.RUNNER_GIT_USER_EMAIL;
    assert.throws(loadRunnerConfig, /RUNNER_GIT_USER_NAME and RUNNER_GIT_USER_EMAIL must be set together/u);
  } finally {
    if (previousName === undefined) delete process.env.RUNNER_GIT_USER_NAME;
    else process.env.RUNNER_GIT_USER_NAME = previousName;
    if (previousEmail === undefined) delete process.env.RUNNER_GIT_USER_EMAIL;
    else process.env.RUNNER_GIT_USER_EMAIL = previousEmail;
  }
});

test("runner proxy configuration is opt-in and maps to child-standard names", () => {
  assert.deepEqual(runnerProxyEnvironment({}), {});
  assert.deepEqual(runnerProxyEnvironment({
    RUNNER_HTTP_PROXY: "http://127.0.0.1:7897",
    RUNNER_HTTPS_PROXY: "http://127.0.0.1:7897",
    RUNNER_NO_PROXY: "127.0.0.1,localhost",
  }), {
    HTTP_PROXY: "http://127.0.0.1:7897",
    http_proxy: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    https_proxy: "http://127.0.0.1:7897",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  });
});

test("runner proxy configuration ignores inherited conventional values", () => {
  assert.deepEqual(runnerProxyEnvironment({
    HTTP_PROXY: "http://inherited.invalid:8000",
    HTTPS_PROXY: "http://inherited.invalid:8000",
    NO_PROXY: "inherited.invalid",
    RUNNER_HTTP_PROXY: "http://127.0.0.1:7897",
    RUNNER_HTTPS_PROXY: "",
    RUNNER_NO_PROXY: "localhost",
  }), {
    HTTP_PROXY: "http://127.0.0.1:7897",
    http_proxy: "http://127.0.0.1:7897",
    NO_PROXY: "localhost",
    no_proxy: "localhost",
  });
  assert.deepEqual(runnerProxyEnvironment({
    HTTP_PROXY: "http://legacy.invalid:7890",
    HTTPS_PROXY: "http://legacy.invalid:7890",
    NO_PROXY: "localhost",
  }), {});
});

test("the runner accepts only a safe operator-selected gate destination", () => {
  const previous = process.env.RUNNER_GATE_SERVER;
  try {
    process.env.RUNNER_GATE_SERVER = "agentos-gate";
    assert.equal(loadRunnerConfig().gateServer, "agentos-gate");
    const qualifiedDestination = ["gate", "worker"].join("@");
    process.env.RUNNER_GATE_SERVER = qualifiedDestination;
    assert.equal(loadRunnerConfig().gateServer, qualifiedDestination);
    for (const value of ["", "-oProxyCommand=bad", "gate;bad", "gate:22", "gate name"]) {
      process.env.RUNNER_GATE_SERVER = value;
      assert.throws(loadRunnerConfig, /RUNNER_GATE_SERVER must be a safe ssh destination/u);
    }
  } finally {
    if (previous === undefined) delete process.env.RUNNER_GATE_SERVER;
    else process.env.RUNNER_GATE_SERVER = previous;
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
