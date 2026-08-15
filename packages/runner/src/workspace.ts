import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";

export type Workspace = {
  path: string;
  branch: string;
  baseSha: string;
};

const inside = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${sep}`);

const command = async (
  config: RunnerConfig,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> => new Promise((resolvePromise, reject) => {
  const prefixed = config.runAsPrefix.length > 0;
  const child = spawn(prefixed ? config.runAsPrefix[0]! : executable, prefixed ? [...config.runAsPrefix.slice(1), executable, ...args] : args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0 && !signal) resolvePromise(stdout.trim());
    else reject(new Error(`${executable} failed (${signal ?? code}): ${stderr.trim()}`));
  });
});

export const workspaceEnvironment = (config: RunnerConfig): NodeJS.ProcessEnv => ({
  PATH: config.path,
  HOME: config.home,
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0",
});

export const provisionWorkspace = async (config: RunnerConfig, claim: ClaimedTask): Promise<Workspace> => {
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(root, claim.run.id);
  if (!inside(root, workspace)) throw new Error("Resolved workspace escaped the controlled root");
  const env = workspaceEnvironment(config);
  if (config.runAsPrefix.length > 0) {
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new Error("RUNNER_WORKSPACE_ROOT is not a directory");
    await command(config, "/bin/mkdir", [workspace], root, env);
  } else {
    await mkdir(root, { recursive: true, mode: 0o750 });
    await mkdir(workspace, { recursive: false, mode: 0o750 });
  }
  try {
    const target = claim.run.targetBranch ?? claim.repo.defaultBranch;
    await command(config, "git", ["clone", "--no-local", "--branch", target, "--single-branch", claim.repo.remoteUrl, workspace], root, env);
    const baseSha = await command(config, "git", ["rev-parse", "HEAD"], workspace, env);
    const branch = `agentos/${claim.task.id}/run-${claim.run.runNumber}`;
    await command(config, "git", ["switch", "-c", branch], workspace, env);
    return { path: workspace, branch, baseSha };
  } catch (error: unknown) {
    await cleanupWorkspace(config, workspace).catch(() => undefined);
    throw error;
  }
};

export const captureWorkspaceResult = async (
  config: RunnerConfig,
  workspace: Workspace,
): Promise<{ branch: string; baseSha: string; headSha: string }> => {
  const env = workspaceEnvironment(config);
  const branch = await command(config, "git", ["branch", "--show-current"], workspace.path, env);
  const headSha = await command(config, "git", ["rev-parse", "HEAD"], workspace.path, env);
  return { branch, baseSha: workspace.baseSha, headSha };
};

export const cleanupWorkspace = async (
  config: RunnerConfig,
  workspacePath: string,
): Promise<void> => {
  const root = resolve(config.workspaceRoot);
  const workspace = resolve(workspacePath);
  if (!inside(root, workspace) || workspace === root) throw new Error("Refusing to clean a path outside the controlled workspace root");
  if (config.runAsPrefix.length > 0) {
    await command(config, "/bin/rm", ["-rf", "--", workspace], root, workspaceEnvironment(config));
  } else {
    await rm(workspace, { recursive: true, force: true });
  }
};
