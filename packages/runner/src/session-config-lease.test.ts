import assert from "node:assert/strict";
import test from "node:test";

import type { RunnerConfig } from "./config.js";
import { openSessionConfig } from "./session-config-lease.js";
import type { AgentScratch } from "./workspace.js";

const config = { runAsPrefix: [] } as unknown as RunnerConfig;

const scratch: AgentScratch = {
  base: "/scratch/base",
  workspaceRoot: "/scratch/workspaces",
  stateDir: "/scratch/control-plane",
  toolsDir: "/scratch/tools",
  configRoot: "/sessions/session-1/config",
};

test("cleanup failure restores an isolated config root and reports a structured retained disposal", async () => {
  let rootExists = true;
  let provisions = 0;
  let cleanups = 0;
  const lease = openSessionConfig(config, { runner: "CODEX", resume: null }, scratch, {
    sessionConfigRootExists: async () => rootExists,
    provisionSessionConfig: async () => {
      provisions += 1;
      rootExists = true;
    },
    cleanupAgentScratch: async (_config, _scratch, options) => {
      cleanups += 1;
      assert.equal(options?.retainConfigRoot, false);
      rootExists = false;
      throw new Error("cleanup refused after removing config root");
    },
  });

  const disposal = await lease.settle("succeeded");

  assert.equal(lease.isolated, true);
  assert.equal(cleanups, 1);
  assert.equal(provisions, 1);
  assert.equal(disposal.retainedPath, scratch.configRoot);
  assert.equal(disposal.cleanupFailureReason, "cleanup refused after removing config root");
});

test("a failed terminal write re-provisions a config root removed by prior success cleanup", async () => {
  let rootExists = true;
  let provisions = 0;
  const retained: boolean[] = [];
  const lease = openSessionConfig(config, { runner: "PI", resume: null }, scratch, {
    sessionConfigRootExists: async () => rootExists,
    provisionSessionConfig: async () => {
      provisions += 1;
      rootExists = true;
    },
    cleanupAgentScratch: async (_config, _scratch, options) => {
      retained.push(options?.retainConfigRoot === true);
      if (!options?.retainConfigRoot) rootExists = false;
    },
  });

  assert.deepEqual(await lease.settle("succeeded"), {
    retainedPath: null,
    cleanupFailureReason: null,
  });
  assert.deepEqual(await lease.settle("failed"), {
    retainedPath: scratch.configRoot,
    cleanupFailureReason: null,
  });
  assert.equal(provisions, 1);
  assert.deepEqual(retained, [false, true]);
});
