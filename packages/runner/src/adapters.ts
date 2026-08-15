import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";

export const buildPrompt = (claim: ClaimedTask): string => [
  claim.agent.foundationalPrompt,
  "",
  `Role (${claim.agent.name}): ${claim.agent.rolePrompt}`,
  "",
  `Task: ${claim.task.name}`,
  claim.task.description,
].join("\n");

export const assertWorkingDirectory = async (workingDirectory: string | null): Promise<string> => {
  if (!workingDirectory) throw new Error("Task has no working directory");
  const info = await stat(workingDirectory);
  if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${workingDirectory}`);
  return workingDirectory;
};

type RunHooks = {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
};

export const runAdapter = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workingDirectory: string,
  hooks: RunHooks,
): Promise<number> => new Promise((resolve, reject) => {
  const command = config.commands[claim.runner];
  const child = spawn("/bin/sh", ["-lc", command], {
    cwd: workingDirectory,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => hooks.onStdout(chunk));
  child.stderr.on("data", (chunk: string) => hooks.onStderr(chunk));
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (signal) reject(new Error(`${claim.runner} terminated by ${signal}`));
    else resolve(code ?? 1);
  });
  child.stdin.end(buildPrompt(claim));
});
