import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { RunnerConfig } from "./config.js";
import { bindCommandRunner, type CommandRunner } from "./exec.js";
import { workspaceEnvironment } from "./adapters/environment.js";

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

const decodeQuotedPath = (value: string): string => {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error("git worktree returned an unterminated quoted path");
  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    const escaped = value[index];
    if (escaped === undefined || index >= value.length - 1) {
      throw new Error("git worktree returned an incomplete path escape");
    }
    const simple: Record<string, string> = {
      a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\u000b", f: "\f", r: "\r", "\\": "\\", '"': '"',
    };
    if (simple[escaped] !== undefined) {
      decoded += simple[escaped];
      continue;
    }
    if (!/[0-7]/u.test(escaped)) throw new Error(`git worktree returned an unknown path escape \\${escaped}`);
    let octal = escaped;
    while (octal.length < 3 && /[0-7]/u.test(value[index + 1] ?? "")) {
      index += 1;
      octal += value[index];
    }
    decoded += String.fromCharCode(Number.parseInt(octal, 8));
  }
  return decoded;
};

const legacyListedWorktreePaths = (output: string): string[] => output
  .split("\n")
  .filter((line) => line.startsWith(WORKTREE_FIELD))
  .map((line) => decodeQuotedPath(line.slice(WORKTREE_FIELD.length)));

const lacksNulWorktreeOutput = (error: unknown): boolean => error instanceof Error
  && /unknown (?:switch|option) [`']?z['`]?/iu.test(error.message);

const within = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

type ResolvedPath = { path: string; physical: boolean };

const resolvedPath = async (path: string): Promise<ResolvedPath> => {
  const absolute = resolve(path);
  try {
    return { path: await realpath(absolute), physical: true };
  } catch {
    // A stale, unreadable, or otherwise unresolvable registration still has a
    // lexical location worth reporting. One path's errno must never erase the
    // independently observable violations that follow it.
    return { path: absolute, physical: false };
  }
};

/**
 * Reports registered worktrees whose resolved path lies outside `workspacePath`.
 *
 * Returned paths are normalized absolute paths, in Git's listed order. This is
 * report-only: an outside path is data, never a reason to mutate or throw.
 * Callers should invoke it while the workspace is available, before disposing
 * it, and decide separately how to persist the returned observation.
 *
 * `run` is bound to the workspace by default; passing one lets completion tests
 * exercise the parser without creating a repository.
 */
export const observeExternalWorktrees = async (
  config: RunnerConfig,
  workspacePath: string,
  run: CommandRunner = bindCommandRunner(config.runAsPrefix, workspacePath, workspaceEnvironment(config)),
): Promise<string[]> => {
  let worktreePaths: string[];
  try {
    const output = await run("git", ["worktree", "list", "--porcelain", "-z"]);
    worktreePaths = listedWorktreePaths(output);
  } catch (error: unknown) {
    if (!lacksNulWorktreeOutput(error)) throw error;
    const output = await run("git", ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"]);
    worktreePaths = legacyListedWorktreePaths(output);
  }
  const lexicalRoot = resolve(workspacePath);
  const root = await resolvedPath(lexicalRoot);
  const worktrees = await Promise.all(worktreePaths.map(
    (listedPath) => resolvedPath(resolve(lexicalRoot, listedPath)),
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
