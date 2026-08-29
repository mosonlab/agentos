import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  DEPLOY_REQUIRED_ARTIFACT_PATHS,
  deployReleaseArtifactPaths,
  workspaceDependencyPaths,
} from "./quiet-window-adapters.mjs";
import { assembleReleaseDirectory, verifyReleaseDirectory } from "./release-directory.mjs";
import { DeployFailure } from "./quiet-window-lib.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const RELEASE = /^(?<commit>[0-9a-f]{40})-(?<digest>[0-9a-f]{64})$/u;

const fail = (reason, detail) => {
  throw new DeployFailure(reason, detail);
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
    return Object.freeze({
      ...verified,
      releaseDirectoryIdentity: verified.releaseName,
      buildStamp: verified.apiBuildStamp,
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
