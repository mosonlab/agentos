import assert from "node:assert/strict";
import test from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { deliverFailedWorkspace, deliverWorkspace, pullRequestTitle, type CommandExecutor } from "./delivery.js";

const config = { runAsPrefix: [], path: "/fake/bin", home: "/fake/home" } as unknown as RunnerConfig;
const claim = {
  task: { id: "task-1", name: "Feature" },
  repo: { remoteUrl: "https://github.com/acme/app.git", defaultBranch: "main" },
  run: { id: "run-2", runNumber: 2 },
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

test("a chain step reuses the open pull request on its shared head branch", async () => {
  const calls: string[] = [];
  const fake: CommandExecutor = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/7", number: 7 }]);
    return "";
  };
  const result = await deliverWorkspace(config, claim, workspace, fake);
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(calls.some((call) => call.startsWith("gh pr create")), false);
});

test("delivery opens one pull request titled after the chain, not the step", async () => {
  const calls: string[] = [];
  let created = false;
  const fake: CommandExecutor = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "create") { created = true; return ""; }
    if (executable === "gh" && args[1] === "list") {
      return created ? JSON.stringify([{ url: "https://github.com/acme/app/pull/8", number: 8 }]) : "[]";
    }
    return "";
  };
  const chained = {
    ...claim,
    task: { ...claim.task, name: "lines subcommand: Write spec", templateStep: { name: "Write spec" } },
  } as ClaimedTask;
  const result = await deliverWorkspace(config, chained, workspace, fake);
  assert.equal(result.pullRequestNumber, 8);
  assert.equal(pullRequestTitle(chained.task), "lines subcommand");
  assert.ok(calls.some((call) => call.includes("--title lines subcommand")));
});

test("a failed run commits uncommitted changes, pushes them as WIP, and opens no pull request", async () => {
  const calls: string[] = [];
  const fake: CommandExecutor = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "git" && args[0] === "status") return "M tracked.ts\n?? new.ts";
    return executable === "git" && args[0] === "rev-parse" ? "salvage-sha" : "";
  };
  const result = await deliverFailedWorkspace(config, claim, workspace, fake);
  assert.equal(result?.pushStatus, "SUCCEEDED");
  assert.equal(result?.headSha, "salvage-sha");
  assert.equal(result?.failureClass, undefined);
  assert.equal(result?.pullRequestUrl, undefined);
  assert.deepEqual(calls, [
    "git add -A",
    "git status --porcelain",
    "git -c user.name=AgentOS Runner -c user.email=runner@agentos.local -c commit.gpgSign=false -c core.hooksPath=/dev/null commit --no-verify -m WIP salvage for AgentOS run run-2",
    "git rev-parse HEAD",
    "git push origin HEAD:refs/heads/agentos/task-1/run-2",
  ]);
  assert.equal(calls.some((call) => call.includes("--force")), false);
  assert.equal(calls.some((call) => call.startsWith("gh ")), false);
});

test("a failed run with no new commit is not pushed at all", async () => {
  const calls: string[] = [];
  const fake: CommandExecutor = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return executable === "git" && args[0] === "rev-parse" ? workspace.baseSha : "";
  };
  assert.equal(await deliverFailedWorkspace(config, claim, workspace, fake), null);
  assert.deepEqual(calls, ["git add -A", "git status --porcelain", "git rev-parse HEAD"]);
});

test("a failed run still pushes commits the agent made before crashing", async () => {
  const calls: string[] = [];
  const fake: CommandExecutor = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return executable === "git" && args[0] === "rev-parse" ? "agent-commit-sha" : "";
  };
  const result = await deliverFailedWorkspace(config, claim, workspace, fake);
  assert.equal(result?.headSha, "agent-commit-sha");
  assert.equal(calls.some((call) => call.includes(" commit ")), false);
  assert.equal(calls.at(-1), "git push origin HEAD:refs/heads/agentos/task-1/run-2");
});
