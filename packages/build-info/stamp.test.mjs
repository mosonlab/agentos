import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readBuildInfo } from "./index.mjs";
import { parseArguments, readGitState, stamp } from "./stamp.mjs";

const STAMP_CLI = fileURLToPath(new URL("stamp.mjs", import.meta.url));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A throwaway repository with one commit, so the test can compare the stamp
 *  against an object id it knows independently. */
const withRepository = (callback) => {
  const root = mkdtempSync(join(tmpdir(), "agentos-stamp-"));
  try {
    const packageDir = join(root, "packages", "thing");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@anneal/thing", version: "1.2.3" }));
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "-c", "user.email=t@example.invalid", "-c", "user.name=Test", "add", "-A");
    git(root, "-c", "user.email=t@example.invalid", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "commit", "-qm", "one");
    callback({ root, packageDir, head: git(root, "rev-parse", "HEAD") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("a clean worktree stamps the commit the artefact was built from", () => {
  withRepository(({ packageDir, head }) => {
    const { path, info } = stamp({ outDir: "dist", packageDir, now: new Date("2026-08-18T09:30:00.000Z") });
    assert.equal(info.commit, head);
    assert.equal(info.dirty, false);
    assert.equal(info.packageName, "@anneal/thing");
    assert.equal(info.version, "1.2.3");
    assert.equal(info.builtAt, "2026-08-18T09:30:00.000Z");
    assert.equal(path, join(packageDir, "dist", "build-info.json"));
    // The file on disk is what the running process will read, so assert on it
    // rather than on the return value alone.
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), info);
    assert.equal(readBuildInfo(pathToFileURL(`${join(packageDir, "dist")}/`)).commit, head);
  });
});

test("uncommitted work is reported, never rounded down to the commit", () => {
  withRepository(({ root, packageDir, head }) => {
    writeFileSync(join(packageDir, "extra.ts"), "export const x = 1;\n");
    const tracked = stamp({ outDir: "dist", packageDir });
    assert.equal(tracked.info.commit, head);
    assert.equal(tracked.info.dirty, true, "an untracked source file is uncommitted work");

    rmSync(join(packageDir, "extra.ts"));
    writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n");
    assert.equal(stamp({ outDir: "dist", packageDir }).info.dirty, true, "a modified tracked file is uncommitted work");
  });
});

test("the build's own output does not make the build dirty", () => {
  withRepository(({ packageDir, head }) => {
    // dist/ is gitignored, which is what lets provenance run inside `npm run
    // build` without the merge gate failing the worktree it just built.
    const first = stamp({ outDir: "dist", packageDir });
    assert.equal(first.info.dirty, false);
    const second = stamp({ outDir: "dist", packageDir });
    assert.equal(second.info.dirty, false);
    assert.equal(second.info.commit, head);
  });
});

test("building outside a git worktree records no commit instead of failing", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-stamp-nogit-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@anneal/tarball", version: "0.1.0" }));
    const { info } = stamp({ outDir: "dist", packageDir: root });
    assert.equal(info.commit, null);
    assert.equal(info.dirty, false);
    assert.equal(info.packageName, "@anneal/tarball");
    assert.deepEqual(readGitState(root), { commit: null, dirty: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI stamps the package it is run from", () => {
  withRepository(({ packageDir, head }) => {
    const output = execFileSync(process.execPath, [STAMP_CLI, "dist"], { cwd: packageDir, encoding: "utf8" });
    assert.match(output, new RegExp(head));
    assert.equal(JSON.parse(readFileSync(join(packageDir, "dist", "build-info.json"), "utf8")).commit, head);
  });
});

test("the CLI refuses arguments it does not understand rather than stamping something else", () => {
  assert.match(parseArguments([]).error, /output directory is required/);
  assert.match(parseArguments(["dist", "build"]).error, /second output directory/);
  assert.match(parseArguments(["dist", "--repo"]).error, /needs a directory/);
  assert.match(parseArguments(["--force"]).error, /unknown argument/);
  assert.deepEqual(parseArguments(["dist", "--package-dir", "/p", "--repo", "/r"]), {
    outDir: "dist",
    packageDir: "/p",
    repoDir: "/r",
  });
});
