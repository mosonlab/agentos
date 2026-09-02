import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";

import {
  DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  DEPLOY_REQUIRED_ARTIFACT_PATHS,
  deployReleaseArtifactPaths,
  workspaceDependencyPaths,
} from "./release-artifacts.mjs";
import { assembleReleaseDirectory, verifyReleaseDirectory } from "./release-directory.mjs";
import { DeployFailure } from "./quiet-window-lib.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const RELEASE = /^(?<commit>[0-9a-f]{40})-(?<digest>[0-9a-f]{64})$/u;
const RUNTIME_TOOL_ROOT = "packages/runner/dist/runtime-tools";
const RUNTIME_TOOL_DESTINATIONS = Object.freeze([
  "regression-verification.sh",
  "gate-worker/gate-dispatch.sh",
  "gate-worker/lib.sh",
  "gate-worker/mirror-push.sh",
  "gate-worker/remote-gate.sh",
  "gate-worker/run-gate.sh",
]);
const RUNTIME_TOOL_ENTRIES = new Map([
  ["", new Set(["gate-worker", "regression-verification.sh"])],
  ["gate-worker", new Set(["gate-dispatch.sh", "lib.sh", "mirror-push.sh", "remote-gate.sh", "run-gate.sh"])],
]);

const fail = (reason, detail) => {
  throw new DeployFailure(reason, detail);
};

const runtimeFailure = (detail) => fail("release-artifact-runtime-incomplete", detail);

const runtimeToolStatus = (releaseDirectory, relativePath) => {
  const path = join(releaseDirectory, relativePath);
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") runtimeFailure(`${relativePath}-missing`);
    runtimeFailure(`${relativePath}-unreadable`);
  }
  return { path, status };
};

const assertRuntimeToolDirectory = (releaseDirectory, relativePath) => {
  const { status } = runtimeToolStatus(releaseDirectory, relativePath);
  if (status.isSymbolicLink() || !status.isDirectory()) runtimeFailure(`${relativePath}-not-a-directory`);
  return status;
};

const assertRuntimeToolFile = (releaseDirectory, relativePath) => {
  const { status } = runtimeToolStatus(releaseDirectory, relativePath);
  if (status.isSymbolicLink() || !status.isFile()) runtimeFailure(`${relativePath}-not-a-regular-file`);
  return status;
};

const sortedEntryNames = (path) => readdirSync(path, { withFileTypes: true }).map(({ name }) => name).sort();

const assertRuntimeToolInventory = (releaseDirectory) => {
  const runtimeRoot = join(releaseDirectory, RUNTIME_TOOL_ROOT);
  assertRuntimeToolDirectory(releaseDirectory, RUNTIME_TOOL_ROOT);
  for (const [directory, expectedNames] of RUNTIME_TOOL_ENTRIES) {
    const relativeDirectory = directory ? `${RUNTIME_TOOL_ROOT}/${directory}` : RUNTIME_TOOL_ROOT;
    const directoryPath = join(releaseDirectory, relativeDirectory);
    if (directory) assertRuntimeToolDirectory(releaseDirectory, relativeDirectory);
    const observedNames = sortedEntryNames(directoryPath);
    const expected = [...expectedNames].sort();
    if (JSON.stringify(observedNames) !== JSON.stringify(expected)) {
      runtimeFailure(`${relativeDirectory}-inventory-mismatch`);
    }
    for (const name of expectedNames) {
      if (name === "gate-worker") continue;
      assertRuntimeToolFile(releaseDirectory, `${relativeDirectory}/${name}`);
    }
  }

  // Runtime tools are runner-owned. Reject another runtime-tools component or
  // a symlink alias to the canonical tree, without treating an unrelated file
  // that happens to share a generic basename (such as lib.sh) as tooling.
  const canonicalRuntimeRoot = realpathSync(runtimeRoot);
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === RUNTIME_TOOL_ROOT) continue;
      if (relativePath.split("/").includes("runtime-tools")) runtimeFailure(`misplaced-${relativePath}`);
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = realpathSync(entryPath);
        if (resolved === canonicalRuntimeRoot || resolved.startsWith(`${canonicalRuntimeRoot}${sep}`)) {
          runtimeFailure(`misplaced-${relativePath}`);
        }
      }
      // Dependency trees are independent artifacts and cannot be a runner
      // bundle destination. Avoid turning their size or basenames into deploy
      // verification inputs.
      if (entry.isDirectory() && entry.name !== "node_modules") walk(entryPath, relativePath);
    }
  };
  walk(releaseDirectory, "");
  return Object.freeze({
    root: runtimeRoot,
    files: Object.freeze(RUNTIME_TOOL_DESTINATIONS.map((destination) => `${RUNTIME_TOOL_ROOT}/${destination}`)),
  });
};

const maintenanceSourceImports = (releaseDirectory) => {
  const prismaRoot = join(releaseDirectory, "packages/db/prisma");
  const sourceRoot = join(releaseDirectory, "packages/db/src");
  if (!existsSync(prismaRoot) || lstatSync(prismaRoot).isSymbolicLink() || !lstatSync(prismaRoot).isDirectory()) {
    fail("release-artifact-runtime-incomplete", "packages/db/prisma-missing");
  }
  if (!existsSync(sourceRoot) || lstatSync(sourceRoot).isSymbolicLink() || !lstatSync(sourceRoot).isDirectory()) {
    fail("release-artifact-runtime-incomplete", "packages/db/src-missing");
  }
  const imports = new Set();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const source = readFileSync(path, "utf8");
        for (const match of source.matchAll(/\bfrom\s+["']\.\.\/src\/(?<module>[^"']+)\.js["']/gu)) {
          imports.add(match.groups.module);
        }
      }
    }
  };
  visit(prismaRoot);
  for (const imported of imports) {
    if (imported.split("/").some((component) => component === ".." || component === "")) {
      fail("release-artifact-runtime-incomplete", "packages/db/src-import-invalid");
    }
    const sourcePath = join(sourceRoot, `${imported}.ts`);
    if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) {
      fail("release-artifact-runtime-incomplete", `packages/db/src/${imported}.ts-missing`);
    }
  }
  return Object.freeze([...imports].sort());
};

export const verifyReleaseArtifact = ({ deployRoot, revision, releaseName }) => {
  if (!SHA.test(revision ?? "")) fail("release-artifact-invalid", "target-commit-invalid");
  const identity = RELEASE.exec(releaseName ?? "")?.groups;
  if (!identity || identity.commit !== revision) fail("release-artifact-invalid", "release-name-target-mismatch");
  const releaseDirectory = join(deployRoot, "releases", releaseName);
  if (!existsSync(releaseDirectory)) fail("release-artifact-missing", releaseName);
  const status = lstatSync(releaseDirectory);
  if (status.isSymbolicLink() || !status.isDirectory()) fail("release-artifact-invalid", "release-path-not-directory");
  try {
    const verified = verifyReleaseDirectory({ releaseDirectory, revision, digest: identity.digest });
    const dbMaintenanceSourceImports = maintenanceSourceImports(verified.releaseDirectory);
    const runtimeTools = assertRuntimeToolInventory(verified.releaseDirectory);
    return Object.freeze({
      ...verified,
      releaseDirectoryIdentity: verified.releaseName,
      buildStamp: verified.apiBuildStamp,
      dbMaintenanceSourceImports,
      runtimeTools,
    });
  } catch (error) {
    if (error instanceof DeployFailure && error.reason === "release-digest-mismatch") {
      fail("release-artifact-digest-mismatch", error.detail);
    }
    throw error;
  }
};

export const findReleaseArtifact = ({ deployRoot, revision }) => {
  if (!SHA.test(revision ?? "")) fail("release-artifact-invalid", "target-commit-invalid");
  const releasesRoot = join(deployRoot, "releases");
  if (!existsSync(releasesRoot)) fail("release-artifact-missing", revision);
  const matches = readdirSync(releasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${revision}-`))
    .map((entry) => entry.name)
    .sort();
  if (matches.length === 0) fail("release-artifact-missing", revision);
  if (matches.length !== 1) fail("release-artifact-ambiguous", `target-${revision}-matches-${matches.length}`);
  return verifyReleaseArtifact({ deployRoot, revision, releaseName: matches[0] });
};

const run = (program, args, options = {}) => {
  try {
    return execFileSync(program, args, { stdio: "inherit", ...options });
  } catch (error) {
    fail(options.reason ?? "release-artifact-build-failed", error?.status === undefined ? "command-failed" : `exit-${error.status}`);
  }
};

export const buildReleaseArtifact = ({
  deployRoot,
  revision,
  sourceRemote,
  gitBinary,
  nodeBinary,
  npmBinary,
  execute = run,
  assemble = assembleReleaseDirectory,
  verify = verifyReleaseArtifact,
  requiredPaths = DEPLOY_REQUIRED_ARTIFACT_PATHS,
  artifactPaths = deployReleaseArtifactPaths,
  optionalArtifactPaths = (root) => [...DEPLOY_OPTIONAL_ARTIFACT_PATHS, ...workspaceDependencyPaths(root)],
}) => {
  if (!SHA.test(revision ?? "")) fail("release-artifact-build-refused", "target-commit-invalid");
  if (typeof sourceRemote !== "string" || sourceRemote.length === 0) fail("release-artifact-build-refused", "source-remote-missing");
  try {
    return findReleaseArtifact({ deployRoot, revision });
  } catch (error) {
    if (!(error instanceof DeployFailure) || error.reason !== "release-artifact-missing") throw error;
  }

  const stateRoot = join(deployRoot, ".agentos-deploy");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const buildRoot = mkdtempSync(join(stateRoot, "artifact-build-"));
  try {
    execute(gitBinary, ["clone", "--no-checkout", "--filter=blob:none", sourceRemote, buildRoot], {
      reason: "release-artifact-source-unavailable",
    });
    execute(gitBinary, ["-C", buildRoot, "checkout", "--detach", revision], {
      reason: "release-artifact-source-unavailable",
    });
    execute(nodeBinary, [npmBinary, "ci"], { cwd: buildRoot, reason: "release-artifact-dependencies-failed" });
    execute(nodeBinary, [npmBinary, "run", "build"], { cwd: buildRoot, reason: "release-artifact-build-failed" });
    for (const path of requiredPaths) {
      if (!existsSync(join(buildRoot, path))) fail("release-artifact-output-missing", path);
    }
    const result = assemble({
      stageRoot: buildRoot,
      deployRoot,
      revision,
      artifactPaths: artifactPaths(buildRoot),
      optionalArtifactPaths: optionalArtifactPaths(buildRoot),
      retention: false,
      probeImmutability: true,
    });
    return verify({ deployRoot, revision, releaseName: result.releaseName });
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
};
