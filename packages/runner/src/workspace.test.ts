import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { provisionWorkspace } from "./workspace.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("provisioning trusts an already-published intended head after its database ACK was lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-workspace-publication-"));
  try {
    const remote = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "--bare", remote);
    git(root, "init", "--initial-branch=main", seed);
    git(seed, "config", "user.name", "AgentOS Test");
    git(seed, "config", "user.email", "runner@agentos.local");
    await writeFile(join(seed, "tree.txt"), "base\n");
    git(seed, "add", "tree.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-u", "origin", "main");
    git(seed, "switch", "-c", "agentos/chain/demo-deadbeef");
    await writeFile(join(seed, "tree.txt"), "published\n");
    git(seed, "commit", "-am", "published before ACK loss");
    git(seed, "push", "-u", "origin", "agentos/chain/demo-deadbeef");
    const publishedSha = git(seed, "rev-parse", "HEAD");

    const config = {
      workspaceRoot: join(root, "workspaces"),
      runAsPrefix: [],
      path: process.env.PATH ?? "/usr/bin:/bin",
      home: process.env.HOME ?? root,
    } as unknown as RunnerConfig;
    const claim = {
      task: { id: "task-1" },
      repo: { remoteUrl: remote, defaultBranch: "main" },
      run: {
        id: "run-2",
        runNumber: 2,
        // Database evidence was lost, so the resolver selected main even
        // though the intended shared head is already durable on the remote.
        targetBranch: "main",
        branch: "agentos/chain/demo-deadbeef",
      },
    } as ClaimedTask;

    const workspace = await provisionWorkspace(config, claim);
    assert.equal(workspace.branch, "agentos/chain/demo-deadbeef");
    assert.equal(workspace.baseSha, publishedSha);
    assert.equal(await readFile(join(workspace.path, "tree.txt"), "utf8"), "published\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
