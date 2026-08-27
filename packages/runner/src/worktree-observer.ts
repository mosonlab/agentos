import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { RunnerConfig } from "./config.js";
import { runCommand, type CommandOptions } from "./exec.js";
import { workspaceEnvironment } from "./adapters/environment.js";

/**
 * The command surface used by worktree observation. Keeping this injectable
 * lets completion tests exercise the parser without creating a repository;
 * production uses the runner's single external-command implementation below.
 */
export type WorktreeObserverCommandExecutor = (
  config: RunnerConfig,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: CommandOptions,
) => Promise<string>;

const command: WorktreeObserverCommandExecutor = (
  config,
  executable,
  args,
  cwd,
  env,
  options = {},
): Promise<string> => runCommand(config.runAsPrefix, executable, args, cwd, env, options);

const WORKTREE_FIELD = "worktree ";

/**
 * Extracts paths from `git worktree list --porcelain -z`.
 *
 * `-z` makes each machine-readable field NUL-delimited, so a worktree path
 * containing a newline cannot be mistaken for another record. Git paths cannot
 * contain NUL, which makes selecting the `worktree ` fields sufficient; the
 * other fields (`HEAD`, `branch`, `locked`, and `prunable`) are irrelevant to
 * containment.
 */
const listedWorktreePaths = (output: string): string[] => output
  .split("\0")
  .filter((field) => field.startsWith(WORKTREE_FIELD))
  .map((field) => field.slice(WORKTREE_FIELD.length));

const within = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

type ResolvedPath = { path: string; physical: boolean };

const resolvedPath = async (path: string): Promise<ResolvedPath> => {
  const absolute = resolve(path);
  try {
    return { path: await realpath(absolute), physical: true };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: absolute, physical: false };
    throw error;
  }
};

/**
 * Reports registered worktrees whose resolved path lies outside `workspaceRoot`.
 *
 * The current checkout is included in Git's inventory, so it is deliberately
 * not exempted. Returned paths are normalized absolute paths, in Git's listed
 * order. This is report-only: an outside path is data, never a reason to
 * mutate or throw. Callers should invoke it while `checkoutPath` is available,
 * before disposing the run workspace, and decide separately how to persist the
 * returned observation.
 */
export const observeExternalWorktrees = async (
  config: RunnerConfig,
  checkoutPath: string,
  workspaceRoot: string,
  execute: WorktreeObserverCommandExecutor = command,
): Promise<string[]> => {
  const output = await execute(
    config,
    "git",
    ["worktree", "list", "--porcelain", "-z"],
    checkoutPath,
    workspaceEnvironment(config),
  );
  const checkout = resolve(checkoutPath);
  const lexicalRoot = resolve(workspaceRoot);
  const root = await resolvedPath(lexicalRoot);
  const worktrees = await Promise.all(listedWorktreePaths(output).map(
    (listedPath) => resolvedPath(resolve(checkout, listedPath)),
  ));
  return worktrees
    .filter((worktree) => {
      // Existing paths are judged by their physical location so aliases and
      // symlinks cannot disguise an escape. A stale registered path has no
      // physical answer; compare its spelling against both forms of the root
      // so /tmp and /private/tmp do not manufacture a macOS-only violation.
      if (worktree.physical) return !within(root.path, worktree.path);
      return !within(root.path, worktree.path) && !within(lexicalRoot, worktree.path);
    })
    .map((worktree) => worktree.path);
};
