import assert from "node:assert/strict";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { deliverWorkspace, type CommandExecutor } from "./delivery.js";

const config = { runAsPrefix: [], path: "/fake/bin", home: "/fake/home" } as unknown as RunnerConfig;
const claim = {
  task: { id: "task-1", name: "Feature" },
  repo: { remoteUrl: "https://github.com/acme/app.git", defaultBranch: "main" },
} as ClaimedTask;
const workspace = { path: "/fake/work", branch: "feature/test", baseSha: "base" };

test("delivery degrades to manual instructions when gh is unavailable", async () => {
  const calls: string[] = [];
  const fake: CommandExecutor = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh") throw new Error("ENOENT");
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, fake);
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.match(result.deliveryInstructions ?? "", /gh CLI is unavailable/);
  assert.deepEqual(calls, ["git push --set-upstream origin feature/test", "gh --version"]);
});

test("delivery records a pushed branch without invoking gh for a non-GitHub remote", async () => {
  const calls: string[] = [];
  const fake: CommandExecutor = async (executable, args) => { calls.push(`${executable} ${args.join(" ")}`); return ""; };
  const result = await deliverWorkspace(config, {
    ...claim, repo: { ...claim.repo, remoteUrl: "ssh://git@example.test/acme/app.git" },
  }, workspace, fake);
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.match(result.deliveryInstructions ?? "", /not hosted on GitHub/);
  assert.equal(calls.length, 1);
});
