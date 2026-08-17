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

// --- one branch and one PR per chain -----------------------------------------
//
// The six tests above stay unmodified on purpose, and their passing is itself a
// regression pin: the `claim` fixture omits `opensPullRequest` entirely, so they
// prove that a claim payload from a *stale API build* still opens a pull request
// rather than silently never opening one again.

const noPrClaim = { ...claim, run: { ...claim.run, opensPullRequest: false } } as ClaimedTask;

test("a step that does not open pull requests still pushes its branch", async () => {
  const calls: string[] = [];
  const fake: CommandExecutor = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "list") return "[]";
    return "";
  };
  const result = await deliverWorkspace(config, noPrClaim, workspace, fake);
  assert.equal(result.pushStatus, "SUCCEEDED");
  // The push is what the *next* step of the chain clones, so it is unconditional.
  assert.ok(calls.includes("git push --set-upstream origin feature/test"));
  assert.ok(calls.some((call) => call.startsWith("gh pr list")));
  assert.equal(calls.some((call) => call.startsWith("gh pr create")), false);
});

test("a step that does not open pull requests says so instead of failing", async () => {
  const fake: CommandExecutor = async (executable, args) => (executable === "gh" && args[1] === "list" ? "[]" : "");
  const result = await deliverWorkspace(config, noPrClaim, workspace, fake);
  assert.equal(result.pullRequestUrl, undefined);
  assert.match(result.deliveryInstructions ?? "", /Branch 'feature\/test' was pushed/);
  assert.match(result.deliveryInstructions ?? "", /does not open a pull request/);
});

test("a late documentation step reports the chain's existing pull request", async () => {
  const calls: string[] = [];
  const fake: CommandExecutor = async (executable, args) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/7", number: 7 }]);
    return "";
  };
  const result = await deliverWorkspace(config, noPrClaim, workspace, fake);
  // The lookup is deliberately kept ahead of the flag check: a documentation
  // step running after the implementation step still shows the chain's PR.
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(calls.some((call) => call.startsWith("gh pr create")), false);
});

test("no gh and no pull request by design reads as design, not as a degraded path", async () => {
  const fake: CommandExecutor = async (executable) => { if (executable === "gh") throw new Error("ENOENT"); return ""; };
  const result = await deliverWorkspace(config, noPrClaim, workspace, fake);
  assert.match(result.deliveryInstructions ?? "", /does not open a pull request/);
  assert.doesNotMatch(result.deliveryInstructions ?? "", /manually/);
});

test("a failed pull-request lookup does not fail a step that opens no pull request", async () => {
  // Everything this step owed the chain is already on the remote, so a `gh pr
  // list` error is not a delivery failure. Reporting FAILED here would fail a
  // documentation step *after* its push, and a delivery failure carrying a
  // failureClass is marked non-retryable — one rate-limited lookup would wedge
  // the step permanently.
  const fake: CommandExecutor = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") throw new Error("gh: API rate limit exceeded");
    return "";
  };
  const result = await deliverWorkspace(config, noPrClaim, workspace, fake);
  assert.equal(result.pushStatus, "SUCCEEDED");
  assert.equal(result.failureClass, undefined);
  assert.match(result.deliveryInstructions ?? "", /does not open a pull request/);
});

test("the ref that was actually pushed is recorded on every path that pushed", async () => {
  // `pushedBranch` is the only publication evidence the control plane trusts,
  // because `branch` and `pushStatus` each lie in one direction:
  //   (b) below is the direction where the branch IS published but the run is
  //       recorded FAILED — the next chain step would base on the default branch
  //       and be rejected non-fast-forward;
  //   (d) below is the direction where a salvage push SUCCEEDED against a
  //       per-run branch while `branch` still reads the shared one — the next
  //       chain step would clone a ref nobody created.
  const created: CommandExecutor = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/acme/app/pull/9", number: 9 }]);
    return "";
  };
  assert.equal((await deliverWorkspace(config, claim, workspace, created)).pushedBranch, "feature/test");

  const prFails: CommandExecutor = async (executable, args) => {
    if (executable === "gh" && args[1] === "list") return "[]";
    if (executable === "gh" && args[1] === "create") throw new Error("gh: API rate limit exceeded");
    return "";
  };
  const failed = await deliverWorkspace(config, claim, workspace, prFails);
  assert.equal(failed.pushStatus, "FAILED");
  assert.equal(failed.pushedBranch, "feature/test");

  const pushFails: CommandExecutor = async (executable, args) => {
    if (executable === "git" && args[0] === "push") throw new Error("remote rejected");
    return "";
  };
  assert.equal((await deliverWorkspace(config, claim, workspace, pushFails)).pushedBranch, undefined);

  const salvage: CommandExecutor = async (executable, args) => {
    if (executable === "git" && args[0] === "status") return "M tracked.ts";
    return executable === "git" && args[0] === "rev-parse" ? "salvage-sha" : "";
  };
  const salvaged = await deliverFailedWorkspace(config, claim, workspace, salvage);
  assert.equal(salvaged?.pushedBranch, "agentos/task-1/run-2");
  assert.notEqual(salvaged?.pushedBranch, workspace.branch);
});
