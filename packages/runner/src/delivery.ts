import { spawn } from "node:child_process";

import type { ClaimedTask, FailureClass } from "./api.js";
import type { RunnerConfig } from "./config.js";
import type { Workspace } from "./workspace.js";
import { workspaceEnvironment } from "./workspace.js";

export type DeliveryResult = {
  pushStatus: "SUCCEEDED" | "FAILED";
  pushRemote: string;
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
  deliveryInstructions: `${reason} Branch '${branch}' was pushed. Open a pull request manually against the repository default branch.`,
});

export const deliverWorkspace = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace,
  command: CommandExecutor = executeCommand(config),
): Promise<DeliveryResult> => {
  const env = workspaceEnvironment(config);
  const remote = claim.repo.remoteUrl;
  try {
    await command("git", ["push", "--set-upstream", "origin", workspace.branch], workspace.path, env);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { pushStatus: "FAILED", pushRemote: remote, pushError: message, failureClass: failureClassFor(message) };
  }
  const repo = githubRepo(remote);
  if (!repo) return manual(workspace.branch, remote, "Remote is not hosted on GitHub.");
  try {
    await command("gh", ["--version"], workspace.path, env);
  } catch {
    return manual(workspace.branch, remote, "The gh CLI is unavailable.");
  }
  const view = async (): Promise<{ url: string; number: number }> => {
    const raw = await command("gh", ["pr", "view", workspace.branch, "--repo", repo, "--json", "url,number"], workspace.path, env);
    return JSON.parse(raw) as { url: string; number: number };
  };
  try {
    try {
      const existing = await view();
      return { pushStatus: "SUCCEEDED", pushRemote: remote, pullRequestUrl: existing.url, pullRequestNumber: existing.number };
    } catch {
      await command("gh", [
        "pr", "create", "--repo", repo,
        "--base", claim.repo.defaultBranch,
        "--head", workspace.branch,
        "--title", claim.task.name,
        "--body", `Automated delivery for AgentOS task ${claim.task.id}.`,
      ], workspace.path, env);
      const created = await view();
      return { pushStatus: "SUCCEEDED", pushRemote: remote, pullRequestUrl: created.url, pullRequestNumber: created.number };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      pushStatus: "FAILED",
      pushRemote: remote,
      pushError: message,
      deliveryInstructions: `Branch '${workspace.branch}' was pushed, but PR creation failed. Run gh pr create manually.`,
      failureClass: failureClassFor(message),
    };
  }
};

