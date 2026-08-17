import { spawn } from "node:child_process";

import type { ClaimedTask, FailureClass } from "./api.js";
import type { RunnerConfig } from "./config.js";
import type { Workspace } from "./workspace.js";
import { workspaceEnvironment } from "./workspace.js";

export type DeliveryResult = {
  pushStatus: "SUCCEEDED" | "FAILED";
  pushRemote: string;
  /** The ref actually handed to `git push`, reported on every path that pushed —
   *  including the PR-failure path, where the branch is on the remote no matter
   *  what `gh` did. The control plane treats this as the one publication
   *  signal, so a path that pushes and forgets to report it makes a chain step
   *  base on the wrong branch. */
  pushedBranch?: string;
  headSha?: string;
  pushError?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  deliveryInstructions?: string;
  failureClass?: FailureClass;
};

export type CommandExecutor = (executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;

export const executeCommand = (config: RunnerConfig): CommandExecutor => (
  executable,
  args,
  cwd,
  env,
) => new Promise((resolve, reject) => {
  const prefixed = config.runAsPrefix.length > 0;
  const child = spawn(prefixed ? config.runAsPrefix[0]! : executable, prefixed ? [...config.runAsPrefix.slice(1), executable, ...args] : args, {
    cwd, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0 && !signal) resolve(stdout.trim());
    else reject(new Error(`${executable} failed (${signal ?? code}): ${stderr.trim()}`));
  });
});

const githubRepo = (remote: string): string | null => {
  const ssh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (ssh?.[1]) return ssh[1];
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return url.pathname.replace(/^\//, "").replace(/\.git$/, "") || null;
  } catch {
    return null;
  }
};

const failureClassFor = (message: string): FailureClass => /auth|credential|permission denied|403|401/i.test(message)
  ? "AUTH_REQUIRED"
  : "TOOL_FAILED";

const manual = (branch: string, remote: string, reason: string): DeliveryResult => ({
  pushStatus: "SUCCEEDED",
  pushRemote: remote,
  pushedBranch: branch,
  deliveryInstructions: `${reason} Branch '${branch}' was pushed. Open a pull request manually against the repository default branch.`,
});

/** The step pushed and is done: it was never meant to open a pull request, so
 *  saying "open one manually" would be wrong advice, not just noise. */
const noPullRequest = (branch: string, remote: string): DeliveryResult => ({
  pushStatus: "SUCCEEDED",
  pushRemote: remote,
  pushedBranch: branch,
  deliveryInstructions: `Branch '${branch}' was pushed. This step does not open a pull request.`,
});

// A chain step is named "<chain>: <step>"; the PR is the chain's, not the step's.
export const pullRequestTitle = (task: ClaimedTask["task"]): string => {
  const step = task.templateStep?.name;
  const suffix = step ? `: ${step}` : null;
  return suffix && task.name.endsWith(suffix) && task.name.length > suffix.length
    ? task.name.slice(0, -suffix.length)
    : task.name;
};

export const deliverWorkspace = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace,
  command: CommandExecutor = executeCommand(config),
): Promise<DeliveryResult> => {
  const env = workspaceEnvironment(config);
  const remote = claim.repo.remoteUrl;
  // `!== false`, not a truthiness test, and the difference is the whole point.
  // The field is required in ClaimedTask so our own code cannot omit it; the
  // comparison is what makes a *stale API build* that omits it from the claim
  // payload degrade to today's behaviour (open the PR) instead of to the
  // expensive failure (never open one again, silently). Read from `run`, not
  // `task`: the run carries the snapshot taken when it was created, so an
  // operator's PATCH cannot change a run that is already queued.
  // No step name, output kind or task name is consulted here or anywhere in
  // this package.
  const opensPullRequest = claim.run.opensPullRequest !== false;
  // The push is unconditional: a step that opens no PR still publishes its
  // branch, which is what lets the *next* step of the chain clone it.
  try {
    await command("git", ["push", "--set-upstream", "origin", workspace.branch], workspace.path, env);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { pushStatus: "FAILED", pushRemote: remote, pushError: message, failureClass: failureClassFor(message) };
  }
  const repo = githubRepo(remote);
  if (!repo) {
    return opensPullRequest
      ? manual(workspace.branch, remote, "Remote is not hosted on GitHub.")
      : noPullRequest(workspace.branch, remote);
  }
  try {
    await command("gh", ["--version"], workspace.path, env);
  } catch {
    return opensPullRequest
      ? manual(workspace.branch, remote, "The gh CLI is unavailable.")
      : noPullRequest(workspace.branch, remote);
  }
  // Only an *open* PR on this head may be reused: a merged or closed one would
  // silently swallow the push. One open PR per head branch is a GitHub invariant,
  // so a chain sharing a branch keeps exactly one human-facing PR.
  const openPullRequest = async (): Promise<{ url: string; number: number } | null> => {
    const raw = await command("gh", [
      "pr", "list", "--repo", repo, "--head", workspace.branch, "--state", "open", "--limit", "1", "--json", "url,number",
    ], workspace.path, env);
    const parsed = JSON.parse(raw || "[]") as Array<{ url: string; number: number }>;
    return parsed[0] ?? null;
  };
  try {
    // The lookup runs before the flag check on purpose: a documentation step
    // running after the implementation step still reports the chain's PR on its
    // gate card and in GET /tasks/:id. Only *creation* is suppressed.
    const existing = await openPullRequest();
    if (existing) return { pushStatus: "SUCCEEDED", pushRemote: remote, pushedBranch: workspace.branch, pullRequestUrl: existing.url, pullRequestNumber: existing.number };
    if (!opensPullRequest) return noPullRequest(workspace.branch, remote);
    await command("gh", [
      "pr", "create", "--repo", repo,
      "--base", claim.repo.defaultBranch,
      "--head", workspace.branch,
      "--title", pullRequestTitle(claim.task),
      "--body", `Automated delivery for AgentOS task ${claim.task.id}.`,
    ], workspace.path, env);
    const created = await openPullRequest();
    return created
      ? { pushStatus: "SUCCEEDED", pushRemote: remote, pushedBranch: workspace.branch, pullRequestUrl: created.url, pullRequestNumber: created.number }
      : { pushStatus: "SUCCEEDED", pushRemote: remote, pushedBranch: workspace.branch };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // The push above already succeeded, so the branch exists on the remote no
    // matter what `gh` did. Report that fact (`pushedBranch`) on both paths, or
    // the chain's next step bases on the default branch and its push of the
    // already-published shared name is rejected non-fast-forward — a wedge no
    // retry clears.
    //
    // For a step that was never meant to open a PR, a failed `gh pr list` is
    // not a delivery failure at all: everything this step owed the chain is
    // already on the remote. Reporting FAILED here would fail a documentation
    // step *after* its push, and the runner marks a delivery failure with a
    // failureClass non-retryable.
    if (!opensPullRequest) return noPullRequest(workspace.branch, remote);
    return {
      pushStatus: "FAILED",
      pushRemote: remote,
      pushedBranch: workspace.branch,
      pushError: message,
      deliveryInstructions: `Branch '${workspace.branch}' was pushed, but PR creation failed. Run gh pr create manually.`,
      failureClass: failureClassFor(message),
    };
  }
};

/**
 * Salvage for a failed run: commit any trackable worktree changes, then push the
 * run branch as WIP so the work survives workspace cleanup. Never opens a PR,
 * and never reports a failureClass — the run already has one from CLI evidence.
 *
 * The per-run branch here is deliberate and is now load-bearing: a failed run's
 * half-finished tree must never enter the chain's shared branch, which every
 * later step of the chain clones. Never change this to workspace.branch.
 *
 * Note what this function does *not* control: the completion payload still
 * reports `Run.branch` as the workspace branch (runner.ts spreads the workspace
 * result before this one), so a salvaged run still *looks* like a push to the
 * shared branch in that column. `pushedBranch` is the column that tells the
 * truth, and it is the only one @agentos/db's resolveRunBranches trusts. Keep
 * them in sync: whatever ref is handed to `git push` is the ref reported as
 * `pushedBranch`.
 */
export const deliverFailedWorkspace = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace,
  command: CommandExecutor = executeCommand(config),
): Promise<DeliveryResult | null> => {
  const env = workspaceEnvironment(config);
  const remote = claim.repo.remoteUrl;
  const branch = `agentos/${claim.task.id}/run-${claim.run.runNumber}`;
  try {
    // Respect .gitignore while including tracked deletions and untracked files.
    await command("git", ["add", "-A"], workspace.path, env);
    const status = await command("git", ["status", "--porcelain"], workspace.path, env);
    if (status) {
      await command("git", [
        "-c", "user.name=AgentOS Runner",
        "-c", "user.email=runner@agentos.local",
        "-c", "commit.gpgSign=false",
        "-c", "core.hooksPath=/dev/null",
        "commit", "--no-verify", "-m", `WIP salvage for AgentOS run ${claim.run.id}`,
      ], workspace.path, env);
    }
    const head = await command("git", ["rev-parse", "HEAD"], workspace.path, env);
    // A clean run branch that never diverged from its base has nothing to push.
    if (head === workspace.baseSha) return null;
    // Plain push, never forced: the run branch is unique per (task, run), so a
    // rejection means something else is there and salvaging must not clobber it.
    await command("git", ["push", "origin", `HEAD:refs/heads/${branch}`], workspace.path, env);
    return {
      pushStatus: "SUCCEEDED",
      pushRemote: remote,
      pushedBranch: branch,
      headSha: head,
      deliveryInstructions: `Run failed; its commits were pushed to '${branch}' as work in progress. No pull request was opened.`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { pushStatus: "FAILED", pushRemote: remote, pushError: `WIP salvage failed: ${message}` };
  }
};
