import assert from "node:assert/strict";
import {
  assembleReleaseDirectory,
} from "./release-directory.mjs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { RUNTIME_TOOL_FILES } from "../../packages/runner/scripts/build-runtime-tools.mjs";
import {
  materializeReleaseSnapshot,
  publishReleaseSnapshot,
  RELEASE_SNAPSHOT_OUTPUTS,
} from "./release-snapshot.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const revision = "a".repeat(40);
const buildKey = "b".repeat(64);

const removeTree = (root) => {
  const makeWritable = (path) => {
    let status;
    try { status = lstatSync(path); } catch { return; }
    if (status.isSymbolicLink()) return;
    chmodSync(path, status.isDirectory() ? 0o700 : 0o600);
    if (status.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  };
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
};

const runtimeToolContents = (source) => readFileSync(join(repositoryRoot, source), "utf8");

const releaseFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "anneal-release-snapshot-"));
  const cacheRoot = join(root, "cache");
  const tree = join(cacheRoot, "builds", buildKey, "tree");
  mkdirSync(tree, { recursive: true });
  for (const output of RELEASE_SNAPSHOT_OUTPUTS) {
    const outputRoot = join(tree, output);
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(join(outputRoot, "index.js"), `${output}\n`);
  }
  writeFileSync(join(tree, "packages/api/dist/build-info.json"), `${JSON.stringify({
    packageName: "@anneal/api",
    commit: revision,
    dirty: false,
  })}\n`);
  writeFileSync(join(tree, "packages/runner/dist/build-info.json"), `${JSON.stringify({
    packageName: "@anneal/runner",
    commit: revision,
    dirty: false,
  })}\n`);
  mkdirSync(join(tree, "packages/runner/dist/runtime-tools/gate-worker"), { recursive: true });
  for (const { source, destination } of RUNTIME_TOOL_FILES) {
    writeFileSync(join(tree, "packages/runner/dist/runtime-tools", destination), runtimeToolContents(source));
  }
  writeFileSync(join(cacheRoot, "builds", buildKey, "READY"), `${buildKey}\n`);
  return { root, cacheRoot, tree };
};

const fileInventory = (root) => {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, relativePath);
      else files.push(relativePath);
    }
  };
  visit(root);
  return files.sort();
};

const expectedRuntimePaths = RUNTIME_TOOL_FILES
  .map(({ destination }) => `packages/runner/dist/runtime-tools/${destination}`)
  .sort();

test("release snapshots and deploy releases carry exactly the six runner runtime tools", (t) => {
  const context = releaseFixture();
  const stageRoot = join(context.root, "stage");
  const deployRoot = join(context.root, "deploy");
  mkdirSync(stageRoot);
  try {
    const published = publishReleaseSnapshot({ revision, buildKey, cacheRoot: context.cacheRoot });
    assert.deepEqual(published, { published: true, buildKey });
    assert.deepEqual(materializeReleaseSnapshot({ stageRoot, revision, cacheRoot: context.cacheRoot }), {
      hit: true,
      buildKey,
    });

    const stagedRuntimePaths = fileInventory(stageRoot).filter((path) => path.includes("runtime-tools"));
    assert.deepEqual(stagedRuntimePaths, expectedRuntimePaths);
    for (const { source, destination } of RUNTIME_TOOL_FILES) {
      assert.equal(
        readFileSync(join(stageRoot, "packages/runner/dist/runtime-tools", destination), "utf8"),
        runtimeToolContents(source),
      );
    }

    const assembled = assembleReleaseDirectory({
      stageRoot,
      deployRoot,
      revision,
      artifactPaths: ["packages/api/dist", "packages/runner/dist"],
      optionalArtifactPaths: [],
    });
    const releaseRuntimePaths = assembled.files
      .map(({ path }) => path)
      .filter((path) => path.includes("runtime-tools"));
    assert.deepEqual(releaseRuntimePaths, expectedRuntimePaths);
    for (const { source, destination } of RUNTIME_TOOL_FILES) {
      assert.equal(
        readFileSync(join(assembled.releaseDirectory, "packages/runner/dist/runtime-tools", destination), "utf8"),
        runtimeToolContents(source),
      );
    }
    assert.equal(existsSync(join(assembled.releaseDirectory, "runtime-tools")), false);
    assert.equal(
      assembled.files.some(({ path }) => path.endsWith("/runtime-tools") && path !== "packages/runner/dist/runtime-tools"),
      false,
    );
  } finally {
    t.after(() => removeTree(context.root));
  }
});

test("release snapshots do not publish runtime-tool paths outside runner dist", (t) => {
  const context = releaseFixture();
  const stageRoot = join(context.root, "stage");
  try {
    mkdirSync(join(context.tree, "runtime-tools"), { recursive: true });
    writeFileSync(join(context.tree, "runtime-tools", "unexpected.sh"), "not part of runner dist\n");
    publishReleaseSnapshot({ revision, buildKey, cacheRoot: context.cacheRoot });
    mkdirSync(stageRoot);
    assert.deepEqual(materializeReleaseSnapshot({ stageRoot, revision, cacheRoot: context.cacheRoot }), { hit: true, buildKey });
    assert.equal(existsSync(join(stageRoot, "runtime-tools")), false);
    assert.equal(fileInventory(stageRoot).some((path) => path.startsWith("runtime-tools/")), false);
  } finally {
    t.after(() => removeTree(context.root));
  }
});
