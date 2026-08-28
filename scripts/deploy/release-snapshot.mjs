import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DeployFailure } from "./quiet-window-lib.mjs";

const RELEASE_INDEX_VERSION = 1;
const REVISION = /^[0-9a-f]{40}$/u;
const BUILD_KEY = /^[0-9a-f]{64}$/u;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;

export const RELEASE_SNAPSHOT_OUTPUTS = Object.freeze([
  "packages/github-client/dist",
  "packages/db/dist",
  "packages/api/dist",
  "packages/runner/dist",
  "packages/inbox/dist",
  "packages/merge-executor/dist",
  "apps/web/dist",
]);

export const defaultReleaseSnapshotCacheRoot = () => join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "agentos-merge-gate",
);

const invalid = (detail) => { throw new DeployFailure("release-snapshot-invalid", detail); };

const assertDirectory = (path, label) => {
  let status;
  try { status = lstatSync(path); } catch { invalid(`${label}-missing`); }
  if (status.isSymbolicLink() || !status.isDirectory()) invalid(`${label}-not-a-directory`);
};

const assertRegularFile = (path, label) => {
  let status;
  try { status = lstatSync(path); } catch { invalid(`${label}-missing`); }
  if (status.isSymbolicLink() || !status.isFile()) invalid(`${label}-not-a-regular-file`);
};

const inventoryDirectory = (path, relativePath, files) => {
  const label = `build-output:${relativePath}`;
  assertDirectory(path, label);
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) invalid(`${label}-contains-symlink:${entry.name}`);
    const relativeChild = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) inventoryDirectory(child, relativeChild, files);
    else if (entry.isFile()) {
      const contents = readFileSync(child);
      files.push({
        path: relativeChild,
        size: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    } else invalid(`${label}-contains-non-file:${entry.name}`);
  }
};

const inventoryBuildOutputs = (tree) => {
  const files = [];
  for (const output of RELEASE_SNAPSHOT_OUTPUTS) inventoryDirectory(join(tree, output), output, files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
};

const readJsonObject = (path, label) => {
  assertRegularFile(path, label);
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label}-root-not-object`);
    return value;
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    invalid(`${label}-unreadable`);
  }
};

const readReleaseIndex = (path, revision) => {
  const value = readJsonObject(path, "release-index");
  if (value.schemaVersion !== RELEASE_INDEX_VERSION) invalid("release-index-version");
  if (value.revision !== revision) invalid("release-index-revision");
  if (!BUILD_KEY.test(value.buildKey ?? "")) invalid("release-index-build-key");
  if (JSON.stringify(value.outputs) !== JSON.stringify(RELEASE_SNAPSHOT_OUTPUTS)) invalid("release-index-outputs");
  if (!Array.isArray(value.files) || value.files.length > 50_000) invalid("release-index-files");
  let previousPath = "";
  for (const file of value.files) {
    if (typeof file !== "object" || file === null || Array.isArray(file)
      || typeof file.path !== "string" || file.path <= previousPath
      || !RELEASE_SNAPSHOT_OUTPUTS.some((output) => file.path.startsWith(`${output}/`))
      || !Number.isSafeInteger(file.size) || file.size < 0
      || !CONTENT_HASH.test(file.sha256 ?? "")) invalid("release-index-file-entry");
    previousPath = file.path;
  }
  return value;
};

const assertBuildStamp = (tree, path, revision, packageName) => {
  const stamp = readJsonObject(join(tree, path), `${packageName}-build-stamp`);
  if (stamp.commit !== revision || stamp.dirty !== false || stamp.packageName !== packageName) {
    invalid(`${packageName}-build-stamp-mismatch`);
  }
};

const validateBuildEntry = (cacheRoot, revision, buildKey, expectedFiles = null) => {
  const entry = join(cacheRoot, "builds", buildKey);
  if (!existsSync(entry)) return null;
  assertDirectory(entry, "build-entry");
  const ready = join(entry, "READY");
  assertRegularFile(ready, "build-entry-ready");
  if (readFileSync(ready, "utf8").trim() !== buildKey) invalid("build-entry-ready-mismatch");
  const tree = join(entry, "tree");
  assertDirectory(tree, "build-entry-tree");
  assertBuildStamp(tree, "packages/api/dist/build-info.json", revision, "@anneal/api");
  assertBuildStamp(tree, "packages/runner/dist/build-info.json", revision, "@anneal/runner");
  const files = inventoryBuildOutputs(tree);
  if (expectedFiles !== null && JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    invalid("build-entry-content-mismatch");
  }
  return { tree, files };
};

const releaseIndexPath = (cacheRoot, revision) => join(cacheRoot, "releases", `${revision}.json`);

export const publishReleaseSnapshot = ({
  revision,
  buildKey,
  cacheRoot = defaultReleaseSnapshotCacheRoot(),
}) => {
  if (!REVISION.test(revision ?? "")) invalid("revision");
  if (!BUILD_KEY.test(buildKey ?? "")) invalid("build-key");
  if (existsSync(cacheRoot)) assertDirectory(cacheRoot, "cache-root");
  else mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const proposed = validateBuildEntry(cacheRoot, revision, buildKey);
  if (proposed === null) invalid("build-entry-missing");

  const releases = join(cacheRoot, "releases");
  if (existsSync(releases)) assertDirectory(releases, "release-index-directory");
  else mkdirSync(releases, { mode: 0o700 });
  const path = releaseIndexPath(cacheRoot, revision);
  if (existsSync(path)) {
    const current = readReleaseIndex(path, revision);
    if (validateBuildEntry(cacheRoot, revision, current.buildKey, current.files) !== null) {
      return Object.freeze({ published: false, buildKey: current.buildKey });
    }
  }

  const temporary = join(releases, `.${revision}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: RELEASE_INDEX_VERSION,
      revision,
      buildKey,
      outputs: RELEASE_SNAPSHOT_OUTPUTS,
      files: proposed.files,
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o444);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return Object.freeze({ published: true, buildKey });
};

const makeWritable = (path) => {
  const status = lstatSync(path);
  if (status.isDirectory()) {
    chmodSync(path, status.mode | 0o700);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } else {
    chmodSync(path, status.mode | 0o200);
  }
};

export const materializeReleaseSnapshot = ({
  stageRoot,
  revision,
  cacheRoot = defaultReleaseSnapshotCacheRoot(),
}) => {
  if (!REVISION.test(revision ?? "")) invalid("revision");
  if (!existsSync(cacheRoot)) return Object.freeze({ hit: false, reason: "missing" });
  assertDirectory(cacheRoot, "cache-root");
  const releases = join(cacheRoot, "releases");
  if (!existsSync(releases)) return Object.freeze({ hit: false, reason: "missing" });
  assertDirectory(releases, "release-index-directory");
  const path = releaseIndexPath(cacheRoot, revision);
  if (!existsSync(path)) return Object.freeze({ hit: false, reason: "missing" });
  const index = readReleaseIndex(path, revision);
  const entry = validateBuildEntry(cacheRoot, revision, index.buildKey, index.files);
  if (entry === null) return Object.freeze({ hit: false, reason: "evicted" });

  const copied = [];
  try {
    for (const output of RELEASE_SNAPSHOT_OUTPUTS) {
      const destination = join(stageRoot, output);
      if (existsSync(destination)) invalid(`staged-output-already-exists:${output}`);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(entry.tree, output), destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        mode: fsConstants.COPYFILE_FICLONE,
      });
      copied.push(destination);
      makeWritable(destination);
    }
  } catch (error) {
    for (const destination of copied.reverse()) rmSync(destination, { recursive: true, force: true });
    if (error instanceof DeployFailure) throw error;
    throw new DeployFailure(
      "release-snapshot-materialization-failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  return Object.freeze({ hit: true, buildKey: index.buildKey });
};

const entrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (entrypoint) {
  const [action, revision, cacheRoot, buildKey] = process.argv.slice(2);
  if (action !== "publish" || !revision || !cacheRoot || !buildKey) {
    process.stderr.write("usage: release-snapshot.mjs publish <revision> <cache-root> <build-key>\n");
    process.exitCode = 64;
  } else {
    try {
      const result = publishReleaseSnapshot({ revision, cacheRoot, buildKey });
      process.stdout.write(`release snapshot ${result.published ? "published" : "reused"}: ${revision} ${result.buildKey}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
