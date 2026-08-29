import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeployFailure,
  DEPLOY_STEPS,
  SERVICE_LABELS,
  deployedBuildStampRefusal,
  dryRunDecision,
  executeUpgrade,
  quietWindowIsOpen,
} from "./quiet-window-lib.mjs";
import {
  DEPLOY_REQUIRED_ARTIFACT_PATHS,
  deployReleaseArtifactPaths,
  workspaceDependencyPaths,
} from "./release-artifacts.mjs";
import { pruneDeployHistory } from "./deploy-preflight.mjs";
import { createDeploymentLedger, DEPLOYMENT_LEDGER_STATES } from "./deployment-ledger.mjs";
import { createProductionHost } from "./quiet-window-host.mjs";
import { renderLaunchdPlist } from "./install-launchd.mjs";
import { assembleReleaseDirectory } from "./release-directory.mjs";
import { buildReleaseArtifact, findReleaseArtifact, verifyReleaseArtifact } from "./release-artifact.mjs";

const revisions = { from: "a".repeat(40), to: "b".repeat(40) };

const fixture = (failure = null) => {
  const calls = [];
  const records = [];
  const state = { serving: "previous", escalated: null };
  const step = (name, work = async () => undefined) => async (...args) => {
    calls.push(name);
    if (failure === name) throw new DeployFailure(`${name}-failed`, "fixture");
    return work(...args);
  };
  const releaseName = `${revisions.to}-${"c".repeat(64)}`;
  const host = {
    verifyArtifact: step("verify-artifact", async () => ({
      releaseDirectoryIdentity: releaseName,
      buildStamp: { packageName: "@anneal/api", commit: revisions.to, dirty: false },
    })),
    waitForQuiet: step("wait-for-quiet"),
    prepareWorkspace: step("prepare-workspace"),
    verifyStableServicePaths: step("verify-stable-service-paths"),
    backup: step("backup", async () => ({ backupIdentity: "fixture.dump" })),
    guardedMigration: step("guarded-migration", async () => ({ migrationTailBefore: "before", migrationTailAfter: "after" })),
    generatePrismaClient: step("generate-prisma-client"),
    syncCanonicalPrompts: step("canonical-prompt-sync"),
    verifyRuntimePrismaClient: step("verify-runtime-prisma-client"),
    assertQuietBeforeRestart: step("quiet-recheck"),
    publishBuild: step("publish-build", async () => {
      state.serving = "candidate";
      return {
        releaseDirectoryIdentity: releaseName,
        releaseIdentity: { name: releaseName, commit: revisions.to, digest: "c".repeat(64) },
        rollback: async () => { calls.push("rollback-build"); state.serving = "previous"; },
        commit: async () => { calls.push("commit-build"); },
      };
    }),
    restartServices: step("restart-services"),
    verifyServices: step("verify-services"),
    restorePreviousServices: step("restore-services"),
    escalate: async (record) => { calls.push("escalate"); state.escalated = record; },
    notify: async (record) => { calls.push(`notify-${record.outcome}`); },
    cleanupWorkspace: async () => { calls.push("cleanup-workspace"); },
  };
  const ledger = {
    start: (metadata) => { records.push({ state: "STARTED", metadata }); },
    record: (name, metadata) => { records.push({ state: name, metadata }); },
  };
  return { host, calls, records, state, ledger };
};

const minimalBuildTree = (root, revision) => {
  const dist = join(root, "packages/api/dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), "export {};\n");
  writeFileSync(join(dist, "build-info.json"), `${JSON.stringify({
    packageName: "@anneal/api",
    commit: revision,
    dirty: false,
  })}\n`);
  const prisma = join(root, "packages/db/prisma");
  const source = join(root, "packages/db/src");
  mkdirSync(prisma, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(prisma, "preflight.ts"), 'import { census } from "../src/schema-census.js";\nvoid census;\n');
  writeFileSync(join(source, "schema-census.ts"), "export const census = true;\n");
};

const removeTree = (root) => {
  const makeWritable = (path) => {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return;
    chmodSync(path, status.mode & 0o777 | (status.isDirectory() ? 0o700 : 0o600));
    if (status.isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  };
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
};

test("service inventory covers the thirteen production labels", () => {
  assert.equal(SERVICE_LABELS.length, 13);
  assert.equal(SERVICE_LABELS[0], "com.agentos.api");
  assert.equal(SERVICE_LABELS.at(-1), "com.agentos.web");
});

test("quiet-window predicate blocks only active run states", () => {
  for (const status of ["claimed", "provisioning", "running", "RUNNING"]) assert.equal(quietWindowIsOpen([{ status }]), false);
  for (const status of ["queued", "waiting-inbox", "succeeded", "failed"]) assert.equal(quietWindowIsOpen([{ status }]), true);
});

test("deployed build stamps require an exact clean commit", () => {
  assert.equal(deployedBuildStampRefusal({ packageName: "@anneal/api", commit: revisions.to, dirty: false }), null);
  assert.equal(deployedBuildStampRefusal({ packageName: "@anneal/api", commit: revisions.to, dirty: true }), "dirty-build");
  assert.equal(deployedBuildStampRefusal({ packageName: "@other/api", commit: revisions.to, dirty: false }), "unexpected-package-name");
});

test("production host requires the artifact-only mechanisms", () => {
  assert.throws(() => createProductionHost({}), /production-host-adapter-missing:verifyArtifact/u);
});

test("release artifact inventory includes deploy runtime and workspace dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "anneal-artifact-inventory-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
  for (const workspace of ["apps/web", "packages/api"]) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, "package.json"), "{}\n");
  }
  assert.deepEqual(workspaceDependencyPaths(root), ["apps/web/node_modules", "packages/api/node_modules"]);
  const paths = deployReleaseArtifactPaths(root);
  assert.ok(paths.includes("scripts/deploy"));
  assert.ok(paths.includes("packages/db/src"));
  for (const path of DEPLOY_REQUIRED_ARTIFACT_PATHS) assert.ok(paths.includes(path), path);
  rmSync(root, { recursive: true, force: true });
});

test("successful activation verifies artifact before acquiring the quiet window", async () => {
  const { host, calls, records, ledger } = fixture();
  assert.deepEqual(await executeUpgrade(host, revisions, { ledger }), { ok: true });
  assert.deepEqual(calls, [
    "verify-artifact", "wait-for-quiet", "prepare-workspace", "verify-stable-service-paths", "backup",
    "guarded-migration", "generate-prisma-client", "canonical-prompt-sync", "verify-runtime-prisma-client",
    "quiet-recheck", "publish-build", "restart-services", "verify-services", "notify-success", "commit-build",
    "cleanup-workspace",
  ]);
  assert.deepEqual(records.map(({ state }) => state), [
    "STARTED", "ARTIFACT_VERIFIED", "BACKED_UP", "SCHEMA_ADVANCED", "ACTIVATED", "VERIFIED", "SUCCEEDED",
  ]);
  assert.ok(calls.indexOf("verify-artifact") < calls.indexOf("wait-for-quiet"));
});

test("missing artifact records FAILED without quiet-window, build, or activation", async () => {
  const { host, calls, records, ledger } = fixture();
  host.verifyArtifact = async () => {
    calls.push("verify-artifact");
    throw new DeployFailure("release-artifact-missing", revisions.to);
  };
  const result = await executeUpgrade(host, revisions, { ledger });
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "release-artifact-missing");
  assert.equal(calls.includes("wait-for-quiet"), false);
  assert.equal(calls.includes("publish-build"), false);
  assert.equal(calls.some((call) => /dependencies|install/u.test(call)), false);
  assert.equal(records.at(-1).state, "FAILED");
});

test("service verification failure rolls back before restoring services", async () => {
  const { host, calls, state } = fixture("verify-services");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(state.serving, "previous");
  assert.ok(calls.indexOf("rollback-build") < calls.indexOf("restore-services"));
});

test("standalone builder creates a verified exact-commit release", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-builder-"));
  const commands = [];
  const artifact = buildReleaseArtifact({
    deployRoot,
    revision: revisions.to,
    sourceRemote: "https://example.invalid/anneal.git",
    gitBinary: "/git",
    nodeBinary: "/node",
    npmBinary: "/npm",
    requiredPaths: ["packages/api/dist"],
    artifactPaths: () => ["packages/api/dist", "packages/db/prisma", "packages/db/src"],
    optionalArtifactPaths: () => [],
    execute: (program, args, options = {}) => {
      commands.push({ program, args });
      if (args.join(" ") === "/npm run build") minimalBuildTree(options.cwd, revisions.to);
    },
  });
  assert.equal(artifact.revision, revisions.to);
  assert.deepEqual(artifact.dbMaintenanceSourceImports, ["schema-census"]);
  assert.match(artifact.releaseName, new RegExp(`^${revisions.to}-[0-9a-f]{64}$`, "u"));
  assert.equal(findReleaseArtifact({ deployRoot, revision: revisions.to }).releaseName, artifact.releaseName);
  assert.equal(commands.length, 4);
  assert.deepEqual(commands.slice(1).map(({ args }) => args.slice(-2)), [
    ["--detach", revisions.to], ["/npm", "ci"], ["run", "build"],
  ]);
  removeTree(deployRoot);
});

test("artifact verification rejects an incomplete DB maintenance runtime before activation", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-runtime-closure-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  const assembled = assembleReleaseDirectory({
    stageRoot: source,
    deployRoot,
    revision: revisions.to,
    artifactPaths: ["packages/api/dist", "packages/db/prisma"],
    optionalArtifactPaths: [],
  });
  assert.throws(
    () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
    (error) => error instanceof DeployFailure
      && error.reason === "release-artifact-runtime-incomplete"
      && error.detail === "packages/db/src-missing",
  );
  removeTree(deployRoot);
});

test("artifact verification reports content digest mismatch distinctly", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-digest-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  const assembled = assembleReleaseDirectory({
    stageRoot: source,
    deployRoot,
    revision: revisions.to,
    artifactPaths: ["packages/api/dist"],
    optionalArtifactPaths: [],
  });
  const index = join(assembled.releaseDirectory, "packages/api/dist/index.js");
  chmodSync(index, 0o600);
  writeFileSync(index, "export const changed = true;\n");
  chmodSync(index, 0o400);
  assert.throws(
    () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
    (error) => error instanceof DeployFailure && error.reason === "release-artifact-digest-mismatch",
  );
  removeTree(deployRoot);
});

test("dry-run reports artifact readiness and performs no mutation", async () => {
  const calls = [];
  const result = await dryRunDecision({
    revisions: async () => ({ from: revisions.from, to: revisions.to }),
    blockingRuns: async () => [],
    artifactState: async () => { calls.push("artifact"); return { ok: true, releaseName: "fixture" }; },
    serviceState: async () => ({ ok: true }),
    backupState: async () => ({ ok: true, mode: "container" }),
  });
  assert.equal(result.artifact.ok, true);
  assert.deepEqual(calls, ["artifact"]);
  assert.equal(result.lines.filter((line) => line.includes("mutation=skipped")).length, DEPLOY_STEPS.length);
});

test("deploy source has no install/build fallback, checkout mutation, or legacy publication", () => {
  const source = readFileSync(new URL("./quiet-window-deploy.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /npm[^\n]*(?:ci|run["', ]+build)/u);
  assert.doesNotMatch(source, /worktree|fast-forward|assertProductionCheckout|inspectGitPreflight/u);
  assert.ok(source.indexOf("verifyArtifact:") < source.indexOf("waitForQuiet:"));
  assert.match(source, /process\.env\.AGENTOS_REPOSITORY_ROOT/u);
});

test("deploy history prunes recognized backups and leaves unrelated entries", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-retention-"));
  const backups = join(stateDir, "backups");
  mkdirSync(backups);
  for (let index = 0; index < 16; index += 1) {
    writeFileSync(join(backups, `2026-07-01T00-00-${String(index).padStart(2, "0")}-000Z-${"a".repeat(12)}-${"b".repeat(12)}.dump`), "dump\n");
  }
  writeFileSync(join(backups, "operator-note.txt"), "keep\n");
  mkdirSync(join(stateDir, "previous-operator-owned"));
  const result = pruneDeployHistory({ stateDir, now: Date.parse("2026-08-29T00:00:00Z"), dailyRetentionDays: 0 });
  assert.deepEqual(result, { keptBackups: 14, removedBackups: 2 });
  assert.equal(existsSync(join(backups, "operator-note.txt")), true);
  assert.equal(existsSync(join(stateDir, "previous-operator-owned")), true);
  rmSync(stateDir, { recursive: true, force: true });
});

test("deployment ledger accepts the artifact verification boundary", () => {
  assert.ok(DEPLOYMENT_LEDGER_STATES.includes("ARTIFACT_PREPARED"));
  assert.ok(DEPLOYMENT_LEDGER_STATES.includes("ARTIFACT_VERIFIED"));
  const stateDir = mkdtempSync(join(tmpdir(), "anneal-deploy-ledger-"));
  const ledger = createDeploymentLedger({ stateDir, targetCommit: revisions.to });
  ledger.start();
  ledger.record("ARTIFACT_VERIFIED", {
    releaseDirectoryIdentity: `${revisions.to}-${"c".repeat(64)}`,
    activatedBuildStamp: { packageName: "@anneal/api", commit: revisions.to, dirty: false },
  });
  const snapshot = JSON.parse(readFileSync(ledger.statePath, "utf8"));
  assert.equal(snapshot.state, "ARTIFACT_VERIFIED");
  assert.equal(snapshot.release_directory_identity, `${revisions.to}-${"c".repeat(64)}`);
  rmSync(stateDir, { recursive: true, force: true });
});

test("auto-deploy plist launches through current with an explicit source remote and deploy root", () => {
  const template = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
  const rendered = renderLaunchdPlist(template, {
    nodeBinary: "/opt/node",
    deployScript: "/srv/anneal/current/scripts/deploy/quiet-window-deploy.mjs",
    repositoryRoot: "/srv/anneal",
    sourceRemote: "https://example.invalid/anneal.git",
    stdoutPath: "/logs/out",
    stderrPath: "/logs/err",
    path: "/opt:/usr/bin:/bin",
    gitBinary: "/opt/git",
    npmBinary: "/opt/npm-cli.js",
    backup: {
      mode: "container",
      dockerBinary: "/opt/docker",
      container: "postgres",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    },
  });
  assert.match(rendered, /current\/scripts\/deploy\/quiet-window-deploy\.mjs/u);
  assert.match(rendered, /AGENTOS_REPOSITORY_ROOT/u);
  assert.match(rendered, /DEPLOY_SOURCE_REMOTE/u);
  assert.match(rendered, /https:\/\/example\.invalid\/anneal\.git/u);
  assert.doesNotMatch(rendered, /__[A-Z_]+__/u);
});
