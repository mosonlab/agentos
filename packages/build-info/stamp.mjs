#!/usr/bin/env node
//
// Writes the build stamp that `readBuildInfo` reads, as the last thing a
// package's `build` script does:
//
//   "build": "tsc -p tsconfig.json && node ../build-info/stamp.mjs dist"
//
// It runs inside `npm run build` rather than beside it, because a provenance
// step an operator can forget is provenance you cannot rely on during an
// incident. It writes only into the output directory, which is gitignored, so
// building never dirties the worktree — the merge gate fails a build that does.
//
//   node ../build-info/stamp.mjs <outDir> [--package-dir <dir>] [--repo <dir>]
//
// A missing or broken git — building from a release tarball, say — is not a
// build failure: the stamp records `commit: null`, which no deployment check
// will ever accept as a match, and the build carries on.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { isEntryPoint } from "./index.mjs";

const usage = (message) => {
  process.stderr.write(`stamp: ${message}\n\nusage: node stamp.mjs <outDir> [--package-dir <dir>] [--repo <dir>]\n`);
  process.exit(2);
};

export const parseArguments = (argv) => {
  let outDir;
  let packageDir;
  let repoDir;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--package-dir" || argument === "--repo") {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${argument} needs a directory` };
      if (argument === "--package-dir") packageDir = value;
      else repoDir = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      return { error: `unknown argument ${argument}` };
    } else if (outDir !== undefined) {
      return { error: `unexpected second output directory ${argument}` };
    } else {
      outDir = argument;
    }
  }
  if (outDir === undefined) return { error: "an output directory is required" };
  return { outDir, packageDir, repoDir };
};

const git = (repoDir, args) => execFileSync("git", ["-C", repoDir, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

/**
 * The commit this tree is at, and whether the tree is still exactly that
 * commit. `status --porcelain` is the same question the merge gate asks before
 * it will bind a PASS to an object id: staged, unstaged and untracked work all
 * mean the built content is not what the commit says it is.
 */
export const readGitState = (repoDir) => {
  try {
    const commit = git(repoDir, ["rev-parse", "HEAD"]).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) return { commit: null, dirty: false };
    return { commit, dirty: git(repoDir, ["status", "--porcelain"]).trim().length > 0 };
  } catch {
    return { commit: null, dirty: false };
  }
};

export const stamp = ({ outDir, packageDir = process.cwd(), repoDir, now = new Date() }) => {
  const resolvedPackageDir = resolve(packageDir);
  const resolvedOutDir = isAbsolute(outDir) ? outDir : join(resolvedPackageDir, outDir);
  const manifest = JSON.parse(readFileSync(join(resolvedPackageDir, "package.json"), "utf8"));
  const { commit, dirty } = readGitState(resolve(repoDir ?? resolvedPackageDir));
  const info = {
    commit,
    dirty,
    packageName: typeof manifest.name === "string" ? manifest.name : "unknown",
    version: typeof manifest.version === "string" ? manifest.version : "unknown",
    builtAt: now.toISOString(),
  };
  mkdirSync(resolvedOutDir, { recursive: true });
  const path = join(resolvedOutDir, "build-info.json");
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
  return { path, info };
};

if (isEntryPoint(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) usage(parsed.error);
  const { path, info } = stamp(parsed);
  if (!info.commit) {
    process.stderr.write(`stamp: no git commit available for ${info.packageName}; wrote an unattributed build stamp to ${path}\n`);
  }
  process.stdout.write(`${info.packageName} build stamp: ${info.commit ?? "no-commit"}${info.dirty ? "-dirty" : ""} -> ${path}\n`);
}
