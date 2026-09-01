import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RunnerConfig } from "./config.js";
import {
  disposeWorkspace, type WorkspaceDisposalClaim, type WorkspaceDisposalIdentity,
} from "./dispose-workspace.js";
import { createControlPlaneDouble } from "./test-control-plane.js";

const config = (workspaceRoot: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 1_000,
  claimMaxLoadAverage: 1.5,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home: workspaceRoot,
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot,
  hostProofSlots: 3,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const runnerClaim = (runId: string): WorkspaceDisposalClaim => ({
  fencingToken: `fence-${runId}`,
  task: { id: "task-1" },
  run: { id: runId, runNumber: 2 },
  repo: { remoteUrl: "origin" },
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
}).trim();

const cases: Array<{ label: string; identity: WorkspaceDisposalIdentity }> = [
  {
    label: "runner cleanup",
    identity: {
      source: "runner",
      claim: runnerClaim("runner-run"),
    },
  },
  {
    label: "delayed reclaim",
    identity: {
      source: "reclaim",
      runId: "reclaim-run",
      taskId: null,
      runNumber: undefined,
    },
  },
];

for (const { label, identity } of cases) {
  test(`a pinned checkout refuses publication through ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentos-dispose-pinned-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, "review.txt"), "scratch only\n");
    const controlPlane = createControlPlaneDouble();

    const result = await disposeWorkspace(config(root), identity, {
      path: workspacePath,
      branch: "",
      baseSha: "base-sha",
      pinnedBaseSha: "pinned-sha",
    }, {
      alreadyDurable: false,
      retain: false,
    }, controlPlane.controlPlane);

    assert.deepEqual(result, {
      cleanupStatus: "SUCCEEDED",
      workspaceRetained: false,
      salvage: null,
    });
    assert.deepEqual(controlPlane.publishedBranches, []);
    assert.deepEqual(controlPlane.reclaimPublications, []);
    await assert.rejects(access(workspacePath));
  });
}

test("runner disposal salvages unfinished work through the production path before cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-dispose-salvage-"));
  const remote = join(root, "origin.git");
  const workspacePath = join(root, "workspace");
  git(root, "init", "--bare", remote);
  git(root, "init", "--initial-branch=main", workspacePath);
  git(workspacePath, "config", "user.name", "Runner Test");
  git(workspacePath, "config", "user.email", "runner@example.invalid");
  await writeFile(join(workspacePath, "tracked.txt"), "base\n");
  git(workspacePath, "add", "tracked.txt");
  git(workspacePath, "commit", "-m", "base");
  const baseSha = git(workspacePath, "rev-parse", "HEAD");
  git(workspacePath, "remote", "add", "origin", remote);
  await writeFile(join(workspacePath, "tracked.txt"), "unfinished\n");
  const controlPlane = createControlPlaneDouble();
  const claim = { ...runnerClaim("run-2"), repo: { remoteUrl: remote } };

  const result = await disposeWorkspace(config(root), { source: "runner", claim }, {
    path: workspacePath,
    branch: "feature/shared",
    baseSha,
    pinnedBaseSha: null,
  }, {
    alreadyDurable: false,
    retain: false,
  }, controlPlane.controlPlane);

  assert.equal(result.cleanupStatus, "SUCCEEDED");
  assert.equal(result.workspaceRetained, false);
  assert.equal(result.salvage?.pushedBranch, "agentos/task-1/run-2");
  assert.equal(git(remote, "rev-parse", "refs/heads/agentos/task-1/run-2"), result.salvage?.headSha);
  assert.deepEqual(controlPlane.publishedBranches, ["agentos/task-1/run-2"]);
  await assert.rejects(access(workspacePath));
});
