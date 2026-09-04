import assert from "node:assert/strict";
import test from "node:test";

import { defaultRunnerPath as runnerDefaultRunnerPath } from "@anneal/runner/config";

import { controlledGitEnvironment, defaultRunnerPath } from "./git-launch.js";

test("controlled Git and runner children share platform-specific PATH defaults", () => {
  const darwin = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const linux = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  assert.equal(defaultRunnerPath("darwin"), darwin);
  assert.equal(defaultRunnerPath("linux"), linux);
  assert.equal(defaultRunnerPath("linux").includes("/opt/homebrew"), false);
  assert.equal(defaultRunnerPath("darwin"), runnerDefaultRunnerPath("darwin"));
  assert.equal(defaultRunnerPath("linux"), runnerDefaultRunnerPath("linux"));
  assert.throws(() => defaultRunnerPath("win32"), /unsupported runner platform: win32/u);
});

test("RUNNER_PATH overrides the controlled Git default", () => {
  const previous = process.env.RUNNER_PATH;
  process.env.RUNNER_PATH = "/operator/bin";
  try {
    assert.equal(controlledGitEnvironment().PATH, "/operator/bin");
  } finally {
    if (previous === undefined) delete process.env.RUNNER_PATH;
    else process.env.RUNNER_PATH = previous;
  }
});
