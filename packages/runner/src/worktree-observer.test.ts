import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  try {
    const workspace = join(root, "run");
    const outside = join(root, "operator", "pool");
    const newlinePath = join(root, "operator", "line\nbreak");
    const calls: Array<{ executable: string; args: string[]; cwd: string }> = [];
    const execute: WorktreeObserverCommandExecutor = async (_config, executable, args, cwd) => {
      calls.push({ executable, args, cwd });
      return porcelain(
        [
          `worktree ${workspace}`,
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

    assert.deepEqual(await observeExternalWorktrees(config(root), workspace, execute), [
      resolve(root, "operator", "pool", "linked"),
      resolve(newlinePath),
    ]);
    assert.deepEqual(calls, [{
      executable: "git",
      args: ["worktree", "list", "--porcelain", "-z"],
      cwd: workspace,
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns no observation when all registered worktrees resolve inside the run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-worktree-observer-compliant-"));
  try {
    const workspace = join(root, "run");
    const execute: WorktreeObserverCommandExecutor = async () => porcelain(
      [
        `worktree ${workspace}`,
        "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "branch refs/heads/main",
      ].join("\0"),
      [
        "worktree relative/linked",
        "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "branch refs/heads/linked",
      ].join("\0"),
    );

    assert.deepEqual(await observeExternalWorktrees(config(root), workspace, execute), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unresolvable worktree path does not hide other outside worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-worktree-observer-unresolvable-"));
  try {
    const workspace = join(root, "run");
    const notDirectory = join(root, "not-a-directory");
    const otherOutside = join(root, "operator", "linked");
    await writeFile(notDirectory, "file\n");
    const execute: WorktreeObserverCommandExecutor = async () => porcelain(
      `worktree ${workspace}`,
      `worktree ${notDirectory}/linked`,
      `worktree ${otherOutside}`,
    );

    assert.deepEqual(await observeExternalWorktrees(config(root), workspace, execute), [
      join(notDirectory, "linked"),
      otherOutside,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
