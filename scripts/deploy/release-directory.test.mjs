import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeployFailure } from "./quiet-window-lib.mjs";
import {
  assembleReleaseDirectory,
  computeReleaseDigest,
  probeReleaseImmutability,
  pruneReleaseDirectories,
  RELEASE_DIRECTORY_RETENTION_COUNT,
  verifyReleaseDirectory,
} from "./release-directory.mjs";

const revision = "a".repeat(40);

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-release-directory-"));
  const stageRoot = join(root, "stage");
  const deployRoot = join(root, "deploy");
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(deployRoot, { recursive: true });
  mkdirSync(join(stageRoot, "packages/api/dist"), { recursive: true });
  mkdirSync(join(stageRoot, "packages/db/dist"), { recursive: true });
  mkdirSync(join(stageRoot, "packages/db/prisma/migrations/001_init"), { recursive: true });
  mkdirSync(join(stageRoot, "node_modules/.prisma/client"), { recursive: true });
  mkdirSync(join(stageRoot, "node_modules/@anneal"), { recursive: true });
  mkdirSync(join(stageRoot, "node_modules/vendor/data"), { recursive: true });
  mkdirSync(join(stageRoot, "apps/web/dist"), { recursive: true });
  writeFileSync(join(stageRoot, "packages/api/dist/index.js"), "api\n");
  writeFileSync(join(stageRoot, "packages/api/dist/build-info.json"), JSON.stringify({
    packageName: "@anneal/api",
    commit: revision,
    dirty: false,
    version: "0.4.0",
    builtAt: "2026-08-29T00:00:00.000Z",
  }));
  writeFileSync(join(stageRoot, "packages/api/package.json"), JSON.stringify({ name: "@anneal/api" }));
  writeFileSync(join(stageRoot, "packages/db/dist/index.js"), "db\n");
  writeFileSync(join(stageRoot, "packages/db/package.json"), JSON.stringify({ name: "@anneal/db" }));
  writeFileSync(join(stageRoot, "packages/db/prisma/schema.prisma"), "datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }\n");
  writeFileSync(join(stageRoot, "packages/db/prisma/migrations/001_init/migration.sql"), "-- migration\n");
  writeFileSync(join(stageRoot, "node_modules/.prisma/client/index.js"), "generated\n");
  writeFileSync(join(stageRoot, "node_modules/vendor/data/runtime.bin"), "dependency-data\n");
  symlinkSync("../../packages/api", join(stageRoot, "node_modules/@anneal/api"));
  writeFileSync(join(stageRoot, "apps/web/dist/index.html"), "<html />\n");
  writeFileSync(join(stageRoot, ".env"), "DATABASE_URL=secret\n");
  mkdirSync(join(stageRoot, "shared/data"), { recursive: true });
  writeFileSync(join(stageRoot, "shared/data/operator.db"), "mutable\n");
  return { root, stageRoot, deployRoot };
};

const cleanup = ({ root }) => {
  const unlock = (path) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return;
    chmodSync(path, status.isDirectory() ? 0o700 : 0o600);
    if (status.isDirectory()) for (const entry of readdirSync(path)) unlock(join(path, entry));
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
};

const artifactPaths = [
  "packages/api/dist",
  "packages/api/package.json",
  "packages/db/dist",
  "packages/db/package.json",
  "packages/db/prisma",
  "apps/web/dist",
  "node_modules",
];

test("assembles a deterministic versioned release and excludes shared/secrets", () => {
  const context = fixture();
  try {
    const result = assembleReleaseDirectory({
      stageRoot: context.stageRoot,
      deployRoot: context.deployRoot,
      revision,
      artifactPaths,
    });
    assert.match(result.releaseName, new RegExp(`^${revision}-[0-9a-f]{64}$`, "u"));
    assert.equal(result.digest, result.releaseName.slice(revision.length + 1));
    assert.equal(existsSync(join(result.releaseDirectory, ".env")), false);
    assert.equal(existsSync(join(result.releaseDirectory, "shared")), false);
    assert.equal(existsSync(join(result.releaseDirectory, "packages/db/prisma/schema.prisma")), true);
    assert.equal(readFileSync(join(result.releaseDirectory, "packages/api/dist/index.js"), "utf8"), "api\n");
    assert.equal(readFileSync(join(result.releaseDirectory, "node_modules/vendor/data/runtime.bin"), "utf8"), "dependency-data\n");
    assert.equal(computeReleaseDigest(result.releaseDirectory), result.digest);
    assert.equal(lstatSync(result.releaseDirectory).mode & 0o222, 0);
    assert.equal(lstatSync(join(result.releaseDirectory, "packages/api/dist/index.js")).mode & 0o222, 0);

    const second = assembleReleaseDirectory({
      stageRoot: context.stageRoot,
      deployRoot: context.deployRoot,
      revision,
      artifactPaths,
    });
    assert.equal(second.releaseName, result.releaseName);
    assert.equal(second.reused, true);
  } finally {
    cleanup(context);
  }
});

test("rejects an API build stamp that does not identify the target revision", () => {
  const context = fixture();
  try {
    writeFileSync(join(context.stageRoot, "packages/api/dist/build-info.json"), JSON.stringify({
      packageName: "@anneal/api", commit: "b".repeat(40), dirty: false,
    }));
    assert.throws(
      () => assembleReleaseDirectory({
        stageRoot: context.stageRoot,
        deployRoot: context.deployRoot,
        revision,
        artifactPaths,
      }),
      (error) => error instanceof DeployFailure && error.reason === "release-build-stamp-invalid",
    );
  } finally {
    cleanup(context);
  }
});

test("verification catches a post-finalization mutation as a deployment failure", () => {
  const context = fixture();
  try {
    const result = assembleReleaseDirectory({
      stageRoot: context.stageRoot,
      deployRoot: context.deployRoot,
      revision,
      artifactPaths,
    });
    chmodSync(join(result.releaseDirectory, "packages/api/dist/index.js"), 0o644);
    writeFileSync(join(result.releaseDirectory, "packages/api/dist/index.js"), "mutated\n");
    assert.throws(
      () => verifyReleaseDirectory({ releaseDirectory: result.releaseDirectory }),
      (error) => error instanceof DeployFailure && error.reason === "release-digest-mismatch",
    );
  } finally {
    cleanup(context);
  }
});

test("an absent optional artifact is skipped through a symlinked stage root", () => {
  const context = fixture();
  const rootLink = `${context.root}-link`;
  try {
    symlinkSync(context.root, rootLink, "dir");
    const result = assembleReleaseDirectory({
      stageRoot: join(rootLink, "stage"),
      deployRoot: context.deployRoot,
      revision,
      artifactPaths: [...artifactPaths, "packages/cli/dist"],
      optionalArtifactPaths: ["packages/cli/dist"],
    });
    assert.equal(existsSync(join(result.releaseDirectory, "packages/cli/dist")), false);
  } finally {
    cleanup(context);
    rmSync(rootLink, { force: true });
  }
});

test("the production write probe accepts a finalized release without leaving a marker", () => {
  const context = fixture();
  try {
    const result = assembleReleaseDirectory({
      stageRoot: context.stageRoot,
      deployRoot: context.deployRoot,
      revision,
      artifactPaths,
    });
    assert.equal(probeReleaseImmutability(result.releaseDirectory), true);
    assert.equal(existsSync(join(result.releaseDirectory, ".release-write-probe")), false);
  } finally {
    cleanup(context);
  }
});

test("the production write probe rejects a writable release and removes its marker", () => {
  const context = fixture();
  try {
    const result = assembleReleaseDirectory({
      stageRoot: context.stageRoot,
      deployRoot: context.deployRoot,
      revision,
      artifactPaths,
    });
    chmodSync(result.releaseDirectory, 0o700);
    assert.throws(
      () => probeReleaseImmutability(result.releaseDirectory),
      (error) => error instanceof DeployFailure && error.reason === "release-not-immutable",
    );
    assert.equal(existsSync(join(result.releaseDirectory, ".release-write-probe")), false);
  } finally {
    cleanup(context);
  }
});

test("preserves safe workspace links while refusing links that escape the stage", () => {
  const context = fixture();
  try {
    const result = assembleReleaseDirectory({
      stageRoot: context.stageRoot,
      deployRoot: context.deployRoot,
      revision,
      artifactPaths,
    });
    assert.equal(readlinkSync(join(result.releaseDirectory, "node_modules/@anneal/api")), "../../packages/api");
    symlinkSync("/tmp", join(context.stageRoot, "node_modules/outside"));
    writeFileSync(join(context.stageRoot, "packages/api/dist/build-info.json"), JSON.stringify({
      packageName: "@anneal/api", commit: "b".repeat(40), dirty: false,
    }));
    assert.throws(
      () => assembleReleaseDirectory({
        stageRoot: context.stageRoot,
        deployRoot: join(context.root, "other-deploy"),
        revision: "b".repeat(40),
        artifactPaths,
      }),
      (error) => error instanceof DeployFailure && error.reason === "release-directory-invalid",
    );
  } finally {
    cleanup(context);
  }
});

test("release retention keeps current and previous targets even when they are old", () => {
  const context = fixture();
  try {
    const releasesRoot = join(context.deployRoot, "releases");
    mkdirSync(releasesRoot, { recursive: true });
    const names = ["1".repeat(40), "2".repeat(40), "3".repeat(40), "4".repeat(40)].map((commit, index) => `${commit}-${String(index + 1).repeat(64)}`);
    for (const name of names) mkdirSync(join(releasesRoot, name), { recursive: true });
    symlinkSync(join("releases", names[0]), join(context.deployRoot, "current"));
    symlinkSync(join("releases", names[1]), join(context.deployRoot, "previous"));
    const result = pruneReleaseDirectories({
      deployRoot: context.deployRoot,
      limit: 1,
    });
    assert.equal(result.kept, 3);
    assert.equal(result.removed, 1);
    assert.equal(existsSync(join(releasesRoot, names[0])), true);
    assert.equal(existsSync(join(releasesRoot, names[1])), true);
    assert.equal(RELEASE_DIRECTORY_RETENTION_COUNT, 3);
  } finally {
    cleanup(context);
  }
});

test("retention refuses matched symlinks and leaves their targets untouched", () => {
  const context = fixture();
  const outside = mkdtempSync(join(tmpdir(), "agentos-release-retention-target-"));
  try {
    const releasesRoot = join(context.deployRoot, "releases");
    mkdirSync(releasesRoot, { recursive: true });
    const name = `${"5".repeat(40)}-${"6".repeat(64)}`;
    writeFileSync(join(outside, "sentinel"), "keep\n");
    symlinkSync(outside, join(releasesRoot, name));
    assert.throws(
      () => pruneReleaseDirectories({ deployRoot: context.deployRoot, limit: 0 }),
      (error) => error instanceof DeployFailure && error.reason === "release-retention-refused",
    );
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep\n");
  } finally {
    cleanup(context);
    rmSync(outside, { recursive: true, force: true });
  }
});
