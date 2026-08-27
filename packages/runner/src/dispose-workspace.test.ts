import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import {
  disposeWorkspace, type WorkspaceDisposalIdentity,
} from "./dispose-workspace.js";
import { createControlPlaneDouble } from "./test-control-plane.js";

const config = (workspaceRoot: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 1_000,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home: workspaceRoot,
  workspaceRoot,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const cases: Array<{ label: string; identity: WorkspaceDisposalIdentity }> = [
  {
    label: "runner cleanup",
    identity: {
      source: "runner",
      claim: { run: { id: "runner-run" } } as ClaimedTask,
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
