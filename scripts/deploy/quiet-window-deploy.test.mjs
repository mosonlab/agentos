import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { RUNTIME_TOOL_FILES } from "../../packages/runner/scripts/build-runtime-tools.mjs";
import { DEPLOY_PHASES, UPGRADE_DEPLOY_PHASES } from "./deploy-phases.mjs";
import { openDeploymentAttempt, parseReleaseArtifactReceipt } from "./deployment-attempt.mjs";
import {
  DeployFailure,
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
import {
  checkExistingEscalation,
  ESCALATION_RETRY_CAP,
  selfClearEscalation,
  writeEscalationWithAttempts,
} from "./quiet-window-escalation.mjs";
import { renderLaunchdPlist } from "./install-launchd.mjs";
import { assembleReleaseDirectory } from "./release-directory.mjs";
import { buildReleaseArtifact, findReleaseArtifact, verifyReleaseArtifact } from "./release-artifact.mjs";
import {
  autoDeployNoticeBody,
  canonicalSyncNoticeRecord,
  canonicalSyncRefusedLines,
} from "./quiet-window-deploy.mjs";

const revisions = { from: "a".repeat(40), to: "b".repeat(40) };
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY_SCRIPT = fileURLToPath(new URL("./quiet-window-deploy.mjs", import.meta.url));
const EXPECTED_RUNTIME_PATHS = RUNTIME_TOOL_FILES
  .map(({ destination }) => `packages/runner/dist/runtime-tools/${destination}`)
  .sort();
const EXPECTED_PHASES = [
  "parse-arguments",
  "check-escalation",
  "acquire-deploy-lock",
  "read-revisions",
  "check-already-deployed",
  "start-deployment-ledger",
  "prepare-release-artifact",
  "verify-release-artifact",
  "acquire-quiet-window",
  "prepare-operation-workspace",
  "verify-stable-service-paths",
  "backup",
  "guarded-migration",
  "generate-prisma-client",
  "canonical-prompt-sync",
  "verify-runtime-prisma-client",
  "assert-quiet-before-restart",
  "publish-build",
  "restart-services",
  "verify-services",
];

const fixture = ({ failure = null, builderOutput = null } = {}) => {
  const calls = [];
  const phaseCalls = [];
  const records = [];
  const state = { serving: "previous", escalated: null };
  const step = (name, work = async () => undefined) => async (...args) => {
    calls.push(name);
    phaseCalls.push(name);
    if (failure === name) throw new DeployFailure(`${name}-failed`, "fixture");
    return work(...args);
  };
  const support = (name, work = async () => undefined) => async (...args) => {
    calls.push(name);
    return work(...args);
  };
  const releaseName = `${revisions.to}-${"c".repeat(64)}`;
  const release = {
    releaseName,
    releaseDirectory: `/fixture/releases/${releaseName}`,
    revision: revisions.to,
    digest: "c".repeat(64),
    buildStamp: { packageName: "@anneal/api", commit: revisions.to, dirty: false },
  };
  const resource = (name, extra = {}) => ({
    ...extra,
    release: async () => { calls.push(name); },
  });
  const lock = resource("release-lock");
  const barrier = resource("release-barrier", { verify: async () => true });
  const ledger = {
    start: (metadata) => { records.push({ state: "STARTED", metadata }); },
    record: (name, metadata) => { records.push({ state: name, metadata }); },
  };
  const host = {
    parseArgs: step("parse-arguments", async () => ({ options: {} })),
    checkEscalation: step("check-escalation"),
    acquireLock: step("acquire-deploy-lock", async () => ({ lock, resources: [lock] })),
    readRevisions: step("read-revisions", async (attempt) => ({
      revisions: { from: revisions.from, to: attempt.targetCommit },
    })),
    checkAlreadyDeployed: step("check-already-deployed", async (attempt) => {
      assert.equal(attempt.requireFact("revisions").to, revisions.to);
    }),
    startDeploymentLedger: step("start-deployment-ledger", async () => ({ ledger })),
    prepareReleaseArtifact: step("prepare-release-artifact", async () => {
      if (builderOutput !== null && parseReleaseArtifactReceipt(builderOutput) === null) {
        throw new DeployFailure("release-artifact-build-failed", "builder-receipt-invalid");
      }
      return { preparedRelease: release };
    }),
    verifyArtifact: step("verify-release-artifact", async (attempt) => {
      assert.equal(attempt.requireFact("preparedRelease"), release);
      return { verifiedRelease: release };
    }),
    waitForQuiet: step("acquire-quiet-window", async () => ({ barrier, resources: [barrier] })),
    prepareWorkspace: step("prepare-operation-workspace", async (attempt) => {
      assert.equal(attempt.requireFact("verifiedRelease"), release);
      return {
        operationWorkspace: "/fixture/operation",
        resources: [resource("release-workspace")],
      };
    }),
    verifyStableServicePaths: step("verify-stable-service-paths"),
    backup: step("backup", async (attempt) => {
      assert.equal(attempt.requireFact("operationWorkspace"), "/fixture/operation");
      return { backup: { backupIdentity: "fixture.dump" } };
    }),
    guardedMigration: step("guarded-migration", async (attempt) => {
      assert.equal(attempt.requireFact("backup").backupIdentity, "fixture.dump");
      return { migration: { migrationTailBefore: "before", migrationTailAfter: "after" } };
    }),
    generatePrismaClient: step("generate-prisma-client", async (attempt) => {
      assert.equal(attempt.requireFact("operationWorkspace"), "/fixture/operation");
    }),
    syncCanonicalPrompts: step("canonical-prompt-sync", async (attempt) => {
      assert.equal(attempt.requireFact("operationWorkspace"), "/fixture/operation");
    }),
    verifyRuntimePrismaClient: step("verify-runtime-prisma-client", async (attempt) => {
      assert.equal(attempt.requireFact("operationWorkspace"), "/fixture/operation");
    }),
    assertQuietBeforeRestart: step("assert-quiet-before-restart", async (attempt) => {
      assert.equal(await attempt.requireFact("barrier").verify(), true);
    }),
    publishBuild: step("publish-build", async (attempt) => {
      assert.equal(attempt.requireFact("verifiedRelease"), release);
      state.serving = "candidate";
      return {
        publication: {
          releaseDirectoryIdentity: releaseName,
          releaseIdentity: { name: releaseName, commit: revisions.to, digest: "c".repeat(64) },
          rollback: async () => { calls.push("rollback-build"); state.serving = "previous"; },
        },
      };
    }),
    restartServices: step("restart-services", async (attempt) => {
      assert.equal(attempt.requireFact("publication").releaseDirectoryIdentity, releaseName);
    }),
    verifyServices: step("verify-services", async () => ({
      serviceVerification: { activatedBuildStamp: release.buildStamp },
    })),
    restorePreviousServices: support("restore-services"),
    escalate: async (record) => { calls.push("escalate"); state.escalated = record; },
    notify: async (record) => { calls.push(`notify-${record.outcome}`); },
  };
  return { host, calls, phaseCalls, records, state, ledger };
};

const attempt = () => openDeploymentAttempt({
  deployRoot: "/fixture",
  targetCommit: revisions.to,
  transactionId: "fixture-transaction",
});

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
  const runnerDist = join(root, "packages/runner/dist");
  mkdirSync(join(runnerDist, "runtime-tools/gate-worker"), { recursive: true });
  writeFileSync(join(runnerDist, "build-info.json"), `${JSON.stringify({
    packageName: "@anneal/runner",
    commit: revision,
    dirty: false,
  })}\n`);
  for (const { source: sourcePath, destination } of RUNTIME_TOOL_FILES) {
    cpSync(join(REPOSITORY_ROOT, sourcePath), join(runnerDist, "runtime-tools", destination));
  }
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

const RETRYABLE_ESCALATION_REASONS = new Set([
  "remote-main-unreadable",
  "remote-main-read-timeout",
  "quiet-window-query-failed",
  "deploy-barrier-unavailable",
]);

const escalationFixture = (t, record) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-deploy-escalation-self-heal-"));
  const escalationPath = join(root, "escalated.json");
  const snapshot = `${JSON.stringify(record)}\n`;
  writeFileSync(escalationPath, snapshot, { mode: 0o600 });
  const logs = [];
  const notifications = [];
  let retryNotifications = 0;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    escalationPath,
    snapshot,
    logs,
    notifications,
    options: {
      escalationPath,
      retryableReasons: RETRYABLE_ESCALATION_REASONS,
      retryCap: ESCALATION_RETRY_CAP,
      readRemoteMain: async () => assert.fail("retry admission must not read remote main"),
      retryEscalationNotification: async () => { retryNotifications += 1; },
      log: (line) => logs.push(line),
    },
    retryNotifications: () => retryNotifications,
  };
};

test("retryable escalation self-clears after a successful deployment outcome", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "quiet-window-query-failed",
    detail: "platform-database-unreadable",
    attempts: 2,
    from: revisions.from,
    to: revisions.to,
  });
  const checked = await checkExistingEscalation(state.options);
  assert.equal(checked.active, false);
  assert.equal(checked.retryEscalation.attempts, 2);
  assert.equal(state.retryNotifications(), 1);
  const cleared = await selfClearEscalation({
    escalationPath: state.escalationPath,
    retryEscalation: checked.retryEscalation,
    notify: async (record) => { state.notifications.push(record); },
    log: (line) => state.logs.push(line),
  });
  assert.equal(cleared, true);
  assert.equal(existsSync(state.escalationPath), false);
  assert.deepEqual(state.notifications, [{
    outcome: "success",
    reason: "escalation-self-cleared",
    detail: "escalation reason=quiet-window-query-failed attempts=2",
    from: revisions.from,
    to: revisions.to,
  }]);
  assert.deepEqual(state.logs, ["SELF-CLEAR escalation reason=quiet-window-query-failed attempts=2"]);
});

test("repeated retryable failures persist attempts atomically through the cap and then block", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "remote-main-unreadable",
    attempts: ESCALATION_RETRY_CAP - 2,
  });
  for (const expected of [ESCALATION_RETRY_CAP - 1, ESCALATION_RETRY_CAP]) {
    const persisted = writeEscalationWithAttempts({
      escalationPath: state.escalationPath,
      record: { outcome: "failure", reason: "remote-main-unreadable" },
      retryableReasons: RETRYABLE_ESCALATION_REASONS,
    });
    assert.equal(persisted.attempts, expected);
    assert.equal(JSON.parse(readFileSync(state.escalationPath, "utf8")).attempts, expected);
    assert.equal(lstatSync(state.escalationPath).mode & 0o777, 0o600);
  }
  const checked = await checkExistingEscalation(state.options);
  assert.deepEqual(checked, { active: true });
  assert.equal(state.retryNotifications(), 1);
  assert.equal(existsSync(state.escalationPath), true);
});

test("retry attempt persistence handles legacy, unreadable, and non-retryable markers", (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "remote-main-unreadable",
  });
  let persisted = writeEscalationWithAttempts({
    escalationPath: state.escalationPath,
    record: { outcome: "failure", reason: "remote-main-unreadable" },
    retryableReasons: RETRYABLE_ESCALATION_REASONS,
  });
  assert.equal(persisted.attempts, 2);

  writeFileSync(state.escalationPath, "not-json\n", { mode: 0o600 });
  persisted = writeEscalationWithAttempts({
    escalationPath: state.escalationPath,
    record: { outcome: "failure", reason: "remote-main-unreadable" },
    retryableReasons: RETRYABLE_ESCALATION_REASONS,
  });
  assert.equal(persisted.attempts, 1);

  persisted = writeEscalationWithAttempts({
    escalationPath: state.escalationPath,
    record: { outcome: "failure", reason: "environment-unreadable" },
    retryableReasons: RETRYABLE_ESCALATION_REASONS,
  });
  assert.equal(Object.hasOwn(persisted, "attempts"), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(state.escalationPath, "utf8")), "attempts"), false);
});

test("malformed retry attempts fail closed", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "remote-main-unreadable",
    attempts: "1",
  });
  const checked = await checkExistingEscalation(state.options);
  assert.deepEqual(checked, { active: true });
  assert.equal(existsSync(state.escalationPath), true);
});

test("non-retryable escalation remains blocked", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "environment-unreadable",
    attempts: 1,
  });
  const checked = await checkExistingEscalation(state.options);
  assert.deepEqual(checked, { active: true });
  assert.equal(existsSync(state.escalationPath), true);
});

test("a Prisma client import failure remains manually latched", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "database-client-unavailable",
    detail: "prisma-client-import-failed",
  });

  const checked = await checkExistingEscalation(state.options);

  assert.deepEqual(checked, { active: true });
  assert.equal(existsSync(state.escalationPath), true);
});

test("self-clear notification failure keeps the escalation marker", async (t) => {
  const state = escalationFixture(t, {
    outcome: "failure",
    reason: "deploy-barrier-unavailable",
    attempts: 1,
  });
  const checked = await checkExistingEscalation(state.options);
  const cleared = await selfClearEscalation({
    escalationPath: state.escalationPath,
    retryEscalation: checked.retryEscalation,
    notify: async () => { throw new Error("inbox-unavailable"); },
    log: (line) => state.logs.push(line),
  });
  assert.equal(cleared, false);
  assert.equal(existsSync(state.escalationPath), true);
  assert.equal(readFileSync(state.escalationPath, "utf8"), state.snapshot);
  assert.equal(state.logs.length, 1);
  assert.match(state.logs[0], /^STOP escalation-self-clear-failed /u);
});

test("--clear-escalation removes any marker without deployment environment initialization", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-deploy-manual-clear-"));
  const stateDir = join(root, ".agentos-deploy");
  const escalationPath = join(stateDir, "escalated.json");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(escalationPath, JSON.stringify({
    reason: "remote-main-unreadable",
    attempts: ESCALATION_RETRY_CAP,
  }), { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [DEPLOY_SCRIPT, "--clear-escalation"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTOS_REPOSITORY_ROOT: root,
      QUIET_WINDOW_POLL_SECONDS: "60",
      DATABASE_URL: "",
      FEISHU_DEFAULT_CHAT_ID: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(escalationPath), false);
  assert.match(result.stdout, /CLEARED escalation operator-action-required-before-this-command/u);
});

test("--clear-escalation reports the path it looked at when no marker exists", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-deploy-manual-clear-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [DEPLOY_SCRIPT, "--clear-escalation"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTOS_REPOSITORY_ROOT: root,
      QUIET_WINDOW_POLL_SECONDS: "60",
      DATABASE_URL: "",
      FEISHU_DEFAULT_CHAT_ID: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  // The failure this covers: an operator pointed at the wrong root reads
  // "CLEARED" while the real marker is still in place.
  assert.doesNotMatch(result.stdout, /CLEARED escalation/u);
  assert.match(result.stdout, /NO-ESCALATION-TO-CLEAR path=/u);
  assert.match(result.stdout, new RegExp(`path=${root.replaceAll("\\", "\\\\")}`, "u"));
});

test("--clear-escalation runs when invoked through the production current symlink", (t) => {
  const root = mkdtempSync(join(tmpdir(), "anneal-deploy-current-entrypoint-"));
  const release = join(root, "releases", "reviewed");
  mkdirSync(join(root, "releases"));
  symlinkSync(REPOSITORY_ROOT, release);
  symlinkSync("releases/reviewed", join(root, "current"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [
    join(root, "current", "scripts", "deploy", "quiet-window-deploy.mjs"),
    "--clear-escalation",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTOS_REPOSITORY_ROOT: root,
      QUIET_WINDOW_POLL_SECONDS: "60",
      DATABASE_URL: "",
      FEISHU_DEFAULT_CHAT_ID: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NO-ESCALATION-TO-CLEAR path=/u);
});

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

test("canonical sync refusal output reaches the successful deploy Inbox notice", () => {
  const refusal = "REFUSED foreign-project: Agent prompt structure drift";
  const record = canonicalSyncNoticeRecord({
    outcome: "success",
    reason: "deployed",
    from: revisions.from,
    to: revisions.to,
  }, canonicalSyncRefusedLines(`SYNC foreign-project\n${refusal}\nSYNC healthy-project\n`));

  assert.equal(
    autoDeployNoticeBody(record),
    `[auto-deploy] success: ${revisions.from} -> ${revisions.to}; reason=deployed; detail=${refusal}`,
  );
});

test("production host requires every deploy phase", () => {
  assert.throws(() => createProductionHost({}), /production-host-adapter-missing:parseArgs/u);
  for (const { hostMethod } of DEPLOY_PHASES) {
    const { host } = fixture();
    delete host[hostMethod];
    assert.throws(
      () => createProductionHost(host),
      new RegExp(`production-host-adapter-missing:${hostMethod}`, "u"),
    );
  }
});

test("release artifact inventory copies and verifies deploy runtime and workspace dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "anneal-artifact-inventory-"));
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-inventory-release-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
  for (const workspace of ["apps/web", "packages/api"]) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, "package.json"), "{}\n");
  }
  const adapterPath = "scripts/merge-lease-adapter.mjs";
  const adapterContents = "export const fixture = true;\n";
  minimalBuildTree(root, revisions.to);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, adapterPath), adapterContents);
  try {
    assert.deepEqual(workspaceDependencyPaths(root), ["apps/web/node_modules", "packages/api/node_modules"]);
    const paths = deployReleaseArtifactPaths(root);
    assert.ok(paths.includes("scripts/deploy"));
    assert.ok(paths.includes(adapterPath));
    assert.ok(paths.includes("packages/db/src"));
    for (const path of DEPLOY_REQUIRED_ARTIFACT_PATHS) assert.ok(paths.includes(path), path);
    const assembled = assembleReleaseDirectory({
      stageRoot: root,
      deployRoot,
      revision: revisions.to,
      artifactPaths: paths.filter((path) => [
        "packages/api/dist",
        "packages/runner/dist",
        "packages/db/prisma",
        "packages/db/src",
        adapterPath,
      ].includes(path)),
      optionalArtifactPaths: [],
    });
    const verified = verifyReleaseArtifact({
      deployRoot,
      revision: revisions.to,
      releaseName: assembled.releaseName,
    });
    assert.equal(readFileSync(join(verified.releaseDirectory, adapterPath), "utf8"), adapterContents);
    const adapterEvidence = verified.files.find(({ path }) => path === adapterPath);
    assert.equal(adapterEvidence?.type, "file");
    assert.equal(adapterEvidence?.size, Buffer.byteLength(adapterContents));
    assert.match(adapterEvidence?.sha256 ?? "", /^[0-9a-f]{64}$/u);
  } finally {
    removeTree(root);
    removeTree(deployRoot);
  }
});

test("fixture executes the whole deploy sequence with explicit attempt facts", async () => {
  const { host, calls, phaseCalls, records } = fixture();
  assert.deepEqual(await executeUpgrade(host, attempt()), { ok: true });
  assert.deepEqual(phaseCalls, EXPECTED_PHASES);
  assert.deepEqual(calls, [
    ...EXPECTED_PHASES,
    "notify-success",
    "release-workspace",
    "release-barrier",
    "release-lock",
  ]);
  assert.deepEqual(records.map(({ state }) => state), [
    "STARTED", "ARTIFACT_PREPARED", "ARTIFACT_VERIFIED", "BACKED_UP", "SCHEMA_ADVANCED", "ACTIVATED", "VERIFIED", "SUCCEEDED",
  ]);
});

test("a successful attempt invokes self-clear before releasing its resources", async () => {
  const { host, calls } = fixture();
  let clearCalls = 0;
  host.selfClearEscalation = async () => {
    clearCalls += 1;
    calls.push("self-clear");
  };
  assert.deepEqual(await executeUpgrade(host, attempt()), { ok: true });
  assert.equal(clearCalls, 1);
  assert.ok(calls.indexOf("self-clear") < calls.indexOf("release-lock"));
});

test("an already-deployed no-op also invokes self-clear", async () => {
  const { host, calls } = fixture();
  let clearCalls = 0;
  host.checkAlreadyDeployed = async () => ({ skip: "already-deployed" });
  host.selfClearEscalation = async () => {
    clearCalls += 1;
    calls.push("self-clear");
  };
  const result = await executeUpgrade(host, attempt());
  assert.deepEqual(result, { ok: true, skipped: "already-deployed" });
  assert.equal(clearCalls, 1);
  assert.ok(calls.indexOf("self-clear") < calls.indexOf("release-lock"));
});

test("a lock-held skip does not self-clear a retryable escalation", async () => {
  const { host } = fixture();
  let clearCalls = 0;
  host.acquireLock = async () => ({ skip: "lock-held" });
  host.selfClearEscalation = async () => { clearCalls += 1; };
  const result = await executeUpgrade(host, attempt());
  assert.deepEqual(result, { ok: true, skipped: "lock-held" });
  assert.equal(clearCalls, 0);
});

test("missing artifact records FAILED without quiet-window, build, or activation", async () => {
  const { host, calls, records } = fixture({ failure: "verify-release-artifact" });
  const result = await executeUpgrade(host, attempt());
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "verify-release-artifact-failed");
  assert.equal(calls.includes("acquire-quiet-window"), false);
  assert.equal(calls.includes("publish-build"), false);
  assert.equal(calls.some((call) => /dependencies|install/u.test(call)), false);
  assert.equal(records.at(-1).state, "FAILED");
});

test("malformed builder receipt records FAILED before the quiet window opens", async () => {
  const { host, calls, records } = fixture({ builderOutput: "RELEASE-ARTIFACT {not-json}\n" });
  const result = await executeUpgrade(host, attempt());
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "release-artifact-build-failed");
  assert.equal(result.failure.detail, "builder-receipt-invalid");
  assert.deepEqual(records.map(({ state }) => state), ["STARTED", "FAILED"]);
  assert.equal(calls.includes("acquire-quiet-window"), false);
});

test("each independently listed deploy phase stops execution at its first failure", async () => {
  for (const [index, name] of EXPECTED_PHASES.entries()) {
    const { host, phaseCalls } = fixture({ failure: name });
    const result = await executeUpgrade(host, attempt());
    assert.equal(result.ok, false, name);
    assert.deepEqual(phaseCalls, EXPECTED_PHASES.slice(0, index + 1), name);
  }
});

test("service verification failure rolls back before restoring services", async () => {
  const { host, calls, state } = fixture({ failure: "verify-services" });
  const result = await executeUpgrade(host, attempt());
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
    requiredPaths: ["packages/api/dist", "packages/runner/dist"],
    artifactPaths: () => ["packages/api/dist", "packages/runner/dist", "packages/db/prisma", "packages/db/src"],
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
  for (const { source, destination } of RUNTIME_TOOL_FILES) {
    assert.deepEqual(
      readFileSync(join(artifact.releaseDirectory, "packages/runner/dist/runtime-tools", destination)),
      readFileSync(join(REPOSITORY_ROOT, source)),
    );
  }
  assert.deepEqual(
    artifact.files.filter(({ path }) => path.includes("runtime-tools")).map(({ path }) => path),
    EXPECTED_RUNTIME_PATHS,
  );
  assert.equal(commands.length, 4);
  assert.deepEqual(commands.slice(1).map(({ args }) => args.slice(-2)), [
    ["--detach", revisions.to], ["/npm", "ci"], ["run", "build"],
  ]);
  removeTree(deployRoot);
});

const assertRuntimeInventoryFailure = ({ artifactPaths, mutate }) => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-runtime-tools-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  mutate?.(source);
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths,
      optionalArtifactPaths: [],
    });
    assert.throws(
      () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
      (error) => error instanceof DeployFailure && error.reason === "release-artifact-runtime-incomplete",
    );
  } finally {
    removeTree(deployRoot);
  }
};

test("artifact verification rejects missing, extra, non-regular, and misplaced runtime tools", () => {
  const completePaths = ["packages/api/dist", "packages/runner/dist", "packages/db/prisma", "packages/db/src"];
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths.filter((path) => path !== "packages/runner/dist"),
  });
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths,
    mutate: (source) => writeFileSync(
      join(source, "packages/runner/dist/runtime-tools/extra.sh"),
      "unexpected\n",
    ),
  });
  assertRuntimeInventoryFailure({
    artifactPaths: completePaths,
    mutate: (source) => {
      const path = join(source, "packages/runner/dist/runtime-tools/regression-verification.sh");
      rmSync(path);
      symlinkSync("gate-worker/lib.sh", path);
    },
  });
  assertRuntimeInventoryFailure({
    artifactPaths: [...completePaths, "runtime-tools"],
    mutate: (source) => {
      mkdirSync(join(source, "runtime-tools"), { recursive: true });
      writeFileSync(join(source, "runtime-tools/unexpected.sh"), "unexpected\n");
    },
  });
  assertRuntimeInventoryFailure({
    artifactPaths: [...completePaths, "runtime-tool-alias"],
    mutate: (source) => {
      symlinkSync("packages/runner/dist/runtime-tools", join(source, "runtime-tool-alias"));
    },
  });
});

test("artifact verification accepts an unrelated nested lib.sh", () => {
  const deployRoot = mkdtempSync(join(tmpdir(), "anneal-artifact-unrelated-lib-"));
  const source = join(deployRoot, "source");
  mkdirSync(source);
  minimalBuildTree(source, revisions.to);
  writeFileSync(join(source, "packages/db/src/lib.sh"), "unrelated fixture\n");
  try {
    const assembled = assembleReleaseDirectory({
      stageRoot: source,
      deployRoot,
      revision: revisions.to,
      artifactPaths: ["packages/api/dist", "packages/runner/dist", "packages/db/prisma", "packages/db/src"],
      optionalArtifactPaths: [],
    });
    assert.doesNotThrow(
      () => verifyReleaseArtifact({ deployRoot, revision: revisions.to, releaseName: assembled.releaseName }),
    );
  } finally {
    removeTree(deployRoot);
  }
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
  const execution = fixture();
  assert.deepEqual(await executeUpgrade(execution.host, attempt()), { ok: true });
  const result = await dryRunDecision({
    revisions: async () => ({ from: revisions.from, to: revisions.to }),
    blockingRuns: async () => [],
    artifactState: async () => { calls.push("artifact"); return { ok: true, releaseName: "fixture" }; },
    serviceState: async () => ({ ok: true }),
    backupState: async () => ({ ok: true, mode: "container" }),
  });
  assert.equal(result.artifact.ok, true);
  assert.deepEqual(calls, ["artifact"]);
  const plannedPhases = result.lines
    .filter((line) => line.startsWith("DRY-RUN plan step="))
    .map((line) => line.match(/^DRY-RUN plan step=([^ ]+) mutation=skipped$/u)?.[1]);
  assert.deepEqual(plannedPhases, EXPECTED_PHASES.slice(7));
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

test("deployment ledger accepts the artifact verification seam", () => {
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
