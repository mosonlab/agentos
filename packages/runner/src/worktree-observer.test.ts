import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { RunnerConfig } from "./config.js";
import {
  observeExternalWorktrees,
  type WorktreeObserverCommandExecutor,
} from "./worktree-observer.js";

const config = (root: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 1_000,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home: root,
  workspaceRoot: root,
  failedWorkspaceRetention: 0,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const porcelain = (...records: string[]): string => records.join("\0\0") + "\0\0";

test("reports every registered worktree outside the resolved run workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-worktree-observer-"));
  const checkout = join(root, "run", "checkout");
  const workspaceRoot = join(root, "run");
  const outside = join(root, "operator", "pool");
  const newlinePath = join(root, "operator", "line\nbreak");
  const calls: Array<{ executable: string; args: string[]; cwd: string }> = [];
  const execute: WorktreeObserverCommandExecutor = async (_config, executable, args, cwd) => {
    calls.push({ executable, args, cwd });
    return porcelain(
      [
        `worktree ${checkout}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
      ].join("\0"),
      [
        `worktree ${outside}/../pool/linked`,
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/linked",
      ].join("\0"),
      [
        `worktree ${newlinePath}`,
        "HEAD 3333333333333333333333333333333333333333",
        "branch refs/heads/newline",
        "locked reason with worktree text",
      ].join("\0"),
    );
  };

  assert.deepEqual(await observeExternalWorktrees(config(root), checkout, workspaceRoot, execute), [
    resolve(root, "operator", "pool", "linked"),
    resolve(newlinePath),
  ]);
  assert.deepEqual(calls, [{
    executable: "git",
    args: ["worktree", "list", "--porcelain", "-z"],
    cwd: checkout,
  }]);
});

test("reports a checkout outside the run root too, with no special exemption", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-worktree-observer-outside-"));
  const checkout = join(root, "operator", "checkout");
  const workspaceRoot = join(root, "run");
  const execute: WorktreeObserverCommandExecutor = async () => porcelain(
    [
      "worktree ../../operator/checkout",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
    ].join("\0"),
  );

  assert.deepEqual(await observeExternalWorktrees(config(root), checkout, workspaceRoot, execute), [checkout]);
});

test("returns no observation when all registered worktrees resolve inside the run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-worktree-observer-compliant-"));
  const checkout = join(root, "run", "checkout");
  const linked = join(root, "run", "relative", "linked");
  const execute: WorktreeObserverCommandExecutor = async () => porcelain(
    [
      `worktree ${checkout}`,
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
    ].join("\0"),
    [
      "worktree relative/linked",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/linked",
    ].join("\0"),
  );

  assert.deepEqual(await observeExternalWorktrees(config(root), checkout, join(root, "run"), execute), []);
  assert.equal(linked.startsWith(join(root, "run")), true);
});
