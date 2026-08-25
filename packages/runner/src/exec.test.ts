import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { CommandTimeoutError, KILL_GRACE_MS, runCommand } from "./exec.js";
import { isTransientNetworkError } from "./network-retry.js";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const waitForDeath = async (pid: number): Promise<boolean> => {
  for (let waited = 0; waited < 3_000; waited += 25) {
    if (!alive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

test("a hung command is timed out and its whole process group dies with it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-timeout-"));
  try {
    const pidFile = join(directory, "child.pid");
    // The background `sleep` stands in for the helpers a real `git clone`
    // forks (git-remote-https, ssh): killing only the direct child would leave
    // it running inside a workspace the runner is about to delete.
    const script = `sleep 30 & echo $! > ${pidFile}; wait`;
    const error = await runCommand([], "/bin/sh", ["-c", script], directory, env, { timeoutMs: 300 })
      .then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 300ms/);
    // The whole point of the wording: a hung command must re-enter the
    // existing transient retry path instead of failing the run outright.
    assert.equal(isTransientNetworkError(error), true);
    const descendant = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    assert.ok(Number.isInteger(descendant));
    assert.equal(await waitForDeath(descendant), true, "descendant of the timed-out command was orphaned");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command that ignores SIGTERM is escalated to SIGKILL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-sigkill-"));
  try {
    // `exec` keeps the ignored SIGTERM disposition across the exec, so the
    // entire group survives the polite signal and only SIGKILL ends it.
    // The timeout implementation uses Node's monotonic timers. Measure it with
    // the same kind of clock: VM wall-clock synchronisation may move Date.now()
    // backwards while the SIGTERM grace is elapsing.
    const started = performance.now();
    const error = await runCommand([], "/bin/sh", ["-c", "trap '' TERM; exec sleep 30"], directory, env, { timeoutMs: 300 })
      .then(() => null, (reason: unknown) => reason);
    const elapsed = performance.now() - started;
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 300ms/);
    assert.ok(elapsed >= 300 + KILL_GRACE_MS, `expected the SIGTERM grace to elapse, took ${elapsed}ms`);
    assert.ok(elapsed < 300 + 3 * KILL_GRACE_MS, `expected SIGKILL to end it promptly, took ${elapsed}ms`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a command without a timeout is never killed for being slow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-untimed-"));
  try {
    const output = await runCommand([], "/bin/sh", ["-c", "sleep 0.4; echo finished"], directory, env);
    assert.equal(output, "finished");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ordinary failure keeps the message shape delivery classifies on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-failure-"));
  try {
    const error = await runCommand([], "/bin/sh", ["-c", "echo 'remote: Permission denied' >&2; exit 128"], directory, env, { timeoutMs: 5_000 })
      .then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "/bin/sh failed (128): remote: Permission denied");
    assert.equal(isTransientNetworkError(error), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a descendant that ignores SIGTERM is killed even when the group leader exits first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-exec-orphan-"));
  try {
    const pidFile = join(directory, "descendant.pid");
    // The branch a naive "clear every timer once the promise settles" misses:
    // the leader obeys SIGTERM and exits, the descendant ignores it *and* has
    // redirected the inherited pipes, so the direct child's `close` fires
    // first. If that cancelled the pending group SIGKILL, the descendant would
    // outlive the runner's workspace.
    const script = `( trap '' TERM; exec sleep 30 ) >/dev/null 2>&1 </dev/null & echo $! > ${pidFile}; wait`;
    const error = await runCommand([], "/bin/sh", ["-c", script], directory, env, { timeoutMs: 300 })
      .then(() => null, (reason: unknown) => reason);
    assert.ok(error instanceof Error);
    assert.match(error.message, /timed out after 300ms/);
    const descendant = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    assert.ok(Number.isInteger(descendant));
    assert.equal(await waitForDeath(descendant), true, "SIGTERM-ignoring descendant survived the group kill");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the runner's own CLI preflight timeout is not mistaken for a network timeout", async () => {
  // adapters.ts:capture emits this exact string for a local binary that never
  // answers `--version`. It predates this module and means "the CLI is broken",
  // not "the network blinked"; a text-matching classifier would make a missing
  // binary look retryable.
  assert.equal(isTransientNetworkError("preflight timed out after 30 seconds"), false);
  assert.equal(isTransientNetworkError(new Error("claude failed (1): \npreflight timed out after 30 seconds")), false);
  // Ours is recognised by type, not by wording.
  assert.equal(isTransientNetworkError(new CommandTimeoutError("git", ["push"], 20_000)), true);
});

test("fetch transport failures are classified as transient", () => {
  assert.equal(isTransientNetworkError(new TypeError("fetch failed")), true);
});
