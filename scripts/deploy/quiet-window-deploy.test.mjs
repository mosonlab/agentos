import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeployFailure,
  DeploymentLedgerError,
  SERVICE_LABELS,
  deployedBuildStampRefusal,
  dryRunDecision,
  executeUpgrade,
  gitPreflightFailure,
  quietWindowIsOpen,
  runLocked,
  shouldPersistFailure,
} from "./quiet-window-lib.mjs";
import {
  controlledLaunchdPath,
  parseInstallerArgs,
  renderLaunchdPlist,
  verifyBackupConfiguration,
  verifyRenderedToolchain,
} from "./install-launchd.mjs";
import {
  acquireProcessLock,
  blockingRunsStatement,
  deployArtifactPaths,
  DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  DEPLOY_REQUIRED_ARTIFACT_PATHS,
  inspectGitPreflight,
  inspectProductionCheckout,
  pruneDeployHistory,
  publishDirectories,
  workspaceDependencyPaths,
} from "./quiet-window-adapters.mjs";
import {
  backupConfigurationFromEnvironment,
  writePgDumpBackup,
} from "./quiet-window-backup.mjs";
import { createProductionHost } from "./quiet-window-host.mjs";
import { createDeployInterruption } from "./quiet-window-interrupt.mjs";
import {
  materializeReleaseSnapshot,
  publishReleaseSnapshot,
  RELEASE_SNAPSHOT_OUTPUTS,
} from "./release-snapshot.mjs";
import { runCommandWithRetry } from "./quiet-window-retry.mjs";
import {
  createDeploymentLedger,
  DEPLOYMENT_LEDGER_STATES,
  pruneDeploymentLedgers,
} from "./deployment-ledger.mjs";

const revisions = { from: "a".repeat(40), to: "b".repeat(40) };

test("quiet-window runbook pins source-declared canonical transitions", () => {
  const repositoryRoot = realpathSync(new URL("../../", import.meta.url));
  const syncSource = readFileSync(join(repositoryRoot, "packages/db/prisma/sync-canonical-prompts.ts"), "utf8");
  const runbook = readFileSync(join(repositoryRoot, "docs/runbooks/quiet-window-auto-deploy.md"), "utf8");
  if (/const AGENT_TRANSITIONS = new Map\(\[\s*\[/u.test(syncSource)) {
    assert.match(runbook, /source-declared assignee, review-base, or Agent-default transition/u);
    assert.match(runbook, /review-coordinator` and `review-coordinator-sol/u);
    assert.match(runbook, /from model\s+`gpt-5\.6-sol:high` with `runnerPreference` `CODEX` to model\s+`openai-codex\/gpt-5\.6-sol:high` with `runnerPreference` `PI`/u);
    assert.match(runbook, /both persisted fields exactly match that `from` state/u);
  }
  assert.match(syncSource, /const REGRESSION_AGENT_NAME = "regression-verifier"/u);
  assert.match(syncSource, /"compound-engineer-workflow:6", \{ from: null, to: 5 \}/u);
  assert.match(syncSource, /"direct-engineer-workflow:3", \{ from: null, to: 2 \}/u);
  assert.match(runbook, /`compound-engineer-workflow:6` from `null` to step 5/u);
  assert.match(runbook, /`direct-engineer-workflow:3` from `null` to step 2/u);
  assert.match(runbook, /`regression-verifier` is the one source-declared role creation/u);
  assert.match(runbook, /Full Assurance step 11/u);
  assert.match(runbook, /TODO, and free of every Run, Session, and step output/u);
});

const fixture = (failure = null) => {
  const calls = [];
  const state = { serving: "previous", escalated: null, notification: null, restarted: false };
  const step = (name, work = async () => undefined) => async () => {
    calls.push(name);
    if (failure === name) {
      const reason = name === "canonical-prompt-sync"
        ? "canonical-prompt-sync-refused"
        : name === "generate-prisma-client"
          ? "prisma-client-generation-refused"
          : `${name}-failed`;
      throw new DeployFailure(reason, "fixture");
    }
    return work();
  };
  const host = {
    fastForward: step("fast-forward", async () => revisions.to),
    createStage: step("create-stage"),
    installDependencies: step("install-dependencies"),
    build: step("build"),
    backup: step("backup"),
    guardedMigration: step("guarded-migration"),
    generatePrismaClient: step("generate-prisma-client"),
    syncCanonicalPrompts: step("canonical-prompt-sync"),
    verifyRuntimePrismaClient: step("verify-runtime-prisma-client"),
    assertQuietBeforeRestart: step("quiet-recheck"),
    publishBuild: step("publish-build", async () => {
      state.serving = "candidate";
      return {
        rollback: async () => { calls.push("rollback-build"); state.serving = "previous"; },
        commit: async () => { calls.push("commit-build"); },
      };
    }),
    restartServices: step("restart-services", async () => { state.restarted = true; }),
    verifyServices: step("verify-services"),
    restorePreviousServices: step("restore-previous-services", async () => { state.restarted = false; }),
    escalate: async (record) => { calls.push("escalate"); state.escalated = record; },
    notify: async (record) => { calls.push(`notify-${record.outcome}`); state.notification = record; },
    cleanupStage: async () => { calls.push("cleanup-stage"); },
  };
  return { host, calls, state };
};

test("service label inventory covers every loaded production service", () => {
  assert.deepEqual(SERVICE_LABELS, [
    "com.agentos.api",
    "com.agentos.inbox",
    "com.agentos.runner",
    "com.agentos.runner-2",
    "com.agentos.runner-3",
    "com.agentos.runner-4",
    "com.agentos.runner-5",
    "com.agentos.runner-6",
    "com.agentos.runner-7",
    "com.agentos.runner-8",
    "com.agentos.runner-9",
    "com.agentos.runner-10",
    "com.agentos.web",
  ]);
});

test("quiet-window predicate blocks only claimed, provisioning, and running", () => {
  for (const status of ["claimed", "provisioning", "running", "CLAIMED", "RUNNING"]) {
    assert.equal(quietWindowIsOpen([{ status }]), false, status);
  }
  for (const status of ["queued", "waiting-inbox", "succeeded", "failed"]) {
    assert.equal(quietWindowIsOpen([{ status }]), true, status);
  }
  assert.equal(quietWindowIsOpen([{ status: "queued" }, { status: "waiting-inbox" }]), true);
});

test("a new-scope checkout accepts an old-scope live stamp during the rename transition", () => {
  const repositoryRoot = realpathSync(new URL("../../", import.meta.url));
  const checkoutManifest = JSON.parse(readFileSync(join(repositoryRoot, "packages/api/package.json"), "utf8"));
  const commit = "a".repeat(40);
  assert.equal(checkoutManifest.name, "@anneal/api");
  assert.equal(deployedBuildStampRefusal({ packageName: "@anneal/api", commit, dirty: false }), null);
  assert.equal(deployedBuildStampRefusal({ packageName: "@agentos/api", commit, dirty: false }), null);
  assert.equal(deployedBuildStampRefusal({ packageName: "@other/api", commit, dirty: false }), "unexpected-package-name");
  assert.equal(deployedBuildStampRefusal({ packageName: "@anneal/api", commit, dirty: true }), "dirty-build");
  assert.equal(deployedBuildStampRefusal({ packageName: "@anneal/api", commit: "not-a-sha", dirty: false }), "invalid-commit");
});

test("production host factory refuses a missing mechanism", () => {
  assert.throws(() => createProductionHost({}), /production-host-adapter-missing:fastForward/u);
});

test("published artifacts derive every workspace dependency tree from the target manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-workspaces-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
  for (const workspace of ["apps/web", "packages/api", "packages/runner"]) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, "package.json"), JSON.stringify({ name: workspace }));
  }
  const nested = workspaceDependencyPaths(root);
  assert.deepEqual(nested, ["apps/web/node_modules", "packages/api/node_modules", "packages/runner/node_modules"]);
  const artifacts = deployArtifactPaths(root);
  assert.deepEqual(DEPLOY_REQUIRED_ARTIFACT_PATHS, [
    "packages/github-client/dist",
    "packages/db/dist",
    "packages/api/dist",
    "packages/runner/dist",
    "packages/inbox/dist",
    "packages/merge-executor/dist",
    "apps/web/dist",
    "node_modules",
  ]);
  assert.deepEqual(DEPLOY_OPTIONAL_ARTIFACT_PATHS, ["packages/cli/dist"]);
  assert.equal(artifacts.at(-1), "node_modules");
  assert.ok(artifacts.includes("packages/api/dist"));
  assert.ok(artifacts.includes("packages/cli/dist"));
  for (const path of nested) assert.ok(artifacts.includes(path));
  rmSync(root, { recursive: true, force: true });
});

test("git preflight names dirty and non-fast-forward refusals", () => {
  assert.equal(gitPreflightFailure({ branch: "feature", dirty: false, head: "a", target: "b", fastForward: true }), "production-checkout-not-main");
  assert.equal(gitPreflightFailure({ branch: "main", dirty: true, head: "a", target: "b", fastForward: true }), "dirty-working-tree");
  assert.equal(gitPreflightFailure({ branch: "main", dirty: false, head: "a", target: "b", fastForward: false }), "non-fast-forward-main");
  assert.equal(gitPreflightFailure({ branch: "main", dirty: false, head: "a", target: "b", fastForward: true }), null);
  assert.equal(gitPreflightFailure({ branch: "main", dirty: false, head: "b", target: "b", fastForward: false }), null);
});

test("the mutating entry checks checkout ownership before its already-deployed no-op", () => {
  const source = readFileSync(new URL("./quiet-window-deploy.mjs", import.meta.url), "utf8");
  const lockedEntry = source.indexOf("return runLocked(");
  const checkoutPreflight = source.indexOf("assertProductionCheckout();", lockedEntry);
  const alreadyDeployed = source.indexOf("if (from === to)", lockedEntry);
  assert.ok(lockedEntry >= 0);
  assert.ok(checkoutPreflight > lockedEntry);
  assert.ok(alreadyDeployed > checkoutPreflight);
});

test("dry-run failures never persist escalation state", () => {
  assert.equal(shouldPersistFailure({ dryRun: true, reason: "environment-unreadable" }), false);
  assert.equal(shouldPersistFailure({ dryRun: true, reason: "usage" }), false);
  assert.equal(shouldPersistFailure({ dryRun: false, reason: "environment-unreadable" }), true);
  assert.equal(shouldPersistFailure({ dryRun: false, reason: "usage" }), false);
});

test("idle quiet-wait interruption is non-sticky while an upgrade interruption escalates", () => {
  assert.equal(shouldPersistFailure({
    dryRun: false,
    reason: "deploy-interrupted",
    upgradeStarted: false,
  }), false);
  assert.equal(shouldPersistFailure({
    dryRun: false,
    reason: "deploy-interrupted",
    upgradeStarted: true,
  }), true);
});

test("successful upgrade runs the safety sequence in order", async () => {
  const { host, calls, state } = fixture();
  assert.deepEqual(await executeUpgrade(host, revisions), { ok: true });
  assert.deepEqual(calls, [
    "fast-forward", "create-stage", "install-dependencies", "build", "backup",
    "guarded-migration", "generate-prisma-client", "canonical-prompt-sync", "verify-runtime-prisma-client", "quiet-recheck",
    "publish-build", "restart-services", "verify-services", "notify-success", "commit-build", "cleanup-stage",
  ]);
  assert.equal(state.serving, "candidate");
  assert.equal(state.notification.from, revisions.from);
  assert.equal(state.notification.to, revisions.to);
});

test("the first failing step stops the pipeline and keeps the previous build serving", async () => {
  const { host, calls, state } = fixture("build");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "build-failed");
  assert.deepEqual(calls, [
    "fast-forward", "create-stage", "install-dependencies", "build",
    "escalate", "notify-failure", "cleanup-stage",
  ]);
  assert.equal(state.serving, "previous");
  assert.equal(state.restarted, false);
  assert.equal(state.escalated.reason, "build-failed");
});

test("structural sync refusal escalates without publishing or restarting", async () => {
  const { host, calls, state } = fixture("canonical-prompt-sync");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "canonical-prompt-sync-refused");
  assert.equal(calls.includes("publish-build"), false);
  assert.equal(calls.includes("restart-services"), false);
  assert.equal(state.serving, "previous");
  assert.equal(state.escalated.reason, "canonical-prompt-sync-refused");
});

test("Prisma client generation refusal escalates before canonical sync", async () => {
  const { host, calls, state } = fixture("generate-prisma-client");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "prisma-client-generation-refused");
  assert.equal(calls.includes("canonical-prompt-sync"), false);
  assert.equal(calls.includes("publish-build"), false);
  assert.equal(state.escalated.reason, "prisma-client-generation-refused");
});

test("restart failure rolls the build back and restarts the previous services", async () => {
  const { host, calls, state } = fixture("restart-services");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(state.serving, "previous");
  assert.equal(calls.includes("rollback-build"), true);
  assert.equal(calls.includes("restore-previous-services"), true);
  assert.equal(calls.includes("commit-build"), false);
});

test("SIGTERM after publication enters the failure path and restores the previous services", async () => {
  const interruption = createDeployInterruption();
  const { host, calls, state } = fixture();
  host.restartServices = async () => {
    calls.push("restart-services");
    assert.equal(interruption.interrupt("SIGTERM"), true);
    interruption.throwIfInterrupted();
  };
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "deploy-interrupted");
  assert.equal(result.failure.detail, "SIGTERM");
  assert.equal(state.serving, "previous");
  assert.ok(calls.includes("rollback-build"));
  assert.ok(calls.includes("restore-previous-services"));
  assert.ok(calls.includes("notify-failure"));
});

test("pointer activation is durably recorded before restart and rollback outcome reaches the terminal ledger event", async () => {
  const { host, calls, state } = fixture();
  const records = [];
  const releaseIdentity = {
    name: `${revisions.to}-${"c".repeat(64)}`,
    commit: revisions.to,
    digest: "c".repeat(64),
  };
  const pointerTransition = {
    oldTarget: `releases/${revisions.from}-${"d".repeat(64)}`,
    newTarget: `releases/${releaseIdentity.name}`,
  };
  host.publishBuild = async () => {
    calls.push("publish-build");
    state.serving = "candidate";
    return {
      releaseIdentity,
      pointerTransition,
      rollback: async () => {
        calls.push("rollback-build");
        state.serving = "previous";
        return { outcome: "rolled-back", ...pointerTransition };
      },
      commit: async () => { calls.push("commit-build"); },
    };
  };
  host.restartServices = async () => {
    calls.push("restart-services");
    assert.equal(records.at(-1)?.state, "ACTIVATED");
    assert.deepEqual(records.at(-1)?.metadata.pointerTransition, pointerTransition);
    throw new DeployFailure("service-restart-failed", "fixture");
  };
  const ledger = {
    record: (stateName, metadata) => { records.push({ state: stateName, metadata }); },
  };

  const result = await executeUpgrade(host, revisions, { ledger });

  assert.equal(result.ok, false);
  assert.equal(state.serving, "previous");
  assert.deepEqual(records.find(({ state: phase }) => phase === "ACTIVATED")?.metadata.releaseIdentity, releaseIdentity);
  assert.equal(records.at(-1)?.state, "FAILED");
  assert.deepEqual(records.at(-1)?.metadata.releaseIdentity, releaseIdentity);
  assert.deepEqual(records.at(-1)?.metadata.pointerTransition, pointerTransition);
  assert.deepEqual(records.at(-1)?.metadata.rollbackPointerOutcome, {
    outcome: "rolled-back",
    ...pointerTransition,
  });
  assert.equal(records.at(-1)?.metadata.reasonCode, "service-restart-failed");
});

test("a service that exits after kickstart rolls back before success", async () => {
  const { host, calls, state } = fixture("verify-services");
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "verify-services-failed");
  assert.equal(state.serving, "previous");
  assert.ok(calls.includes("rollback-build"));
  assert.ok(calls.includes("restore-previous-services"));
  assert.equal(calls.includes("notify-success"), false);
});

test("a stale /version target is a service-verification failure", async () => {
  const { host, calls, state } = fixture();
  host.verifyServices = async () => {
    calls.push("verify-services-stale-version");
    throw new DeployFailure("service-verification-failed", "stale-version");
  };
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "service-verification-failed");
  assert.equal(state.serving, "previous");
  assert.ok(calls.includes("restore-previous-services"));
});

test("notification revisions use the target fixed by fetch after a quiet wait", async () => {
  const { host, state } = fixture();
  const advanced = "c".repeat(40);
  host.fastForward = async () => advanced;
  assert.deepEqual(await executeUpgrade(host, revisions), { ok: true });
  assert.equal(state.notification.to, advanced);
});

test("a successful upgrade records every ledger boundary and a terminal state", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-ledger-success-"));
  const ledger = createDeploymentLedger({
    stateDir: root,
    targetCommit: revisions.to,
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  const { host } = fixture();
  host.backup = async () => ({ backupIdentity: "/safe/backups/deploy.dump" });
  host.guardedMigration = async () => ({ migrationTailBefore: "20260828010000_before", migrationTailAfter: "20260829010000_after" });
  host.build = async () => ({ buildStamp: { packageName: "@anneal/api", commit: revisions.to, dirty: false } });
  const result = await executeUpgrade(host, revisions, { ledger });
  assert.deepEqual(result, { ok: true });
  const state = JSON.parse(readFileSync(ledger.statePath, "utf8"));
  const events = readFileSync(ledger.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(state.state, "SUCCEEDED");
  assert.deepEqual(events.map((event) => event.phase), [
    "STARTED", "BACKED_UP", "SCHEMA_ADVANCED", "ACTIVATED", "VERIFIED", "SUCCEEDED",
  ]);
  assert.equal(events[1].backup_identity, "deploy.dump");
  assert.equal(events[2].migration_tail_before, "20260828010000_before");
  assert.equal(events[2].migration_tail_after, "20260829010000_after");
  assert.equal(events[2].activated_build_stamp, null);
  assert.deepEqual(events[3].activated_build_stamp, {
    packageName: "@anneal/api", commit: revisions.to, dirty: false,
  });
  assert.deepEqual(events.at(-1).activated_build_stamp, {
    packageName: "@anneal/api", commit: revisions.to, dirty: false,
  });
  for (const persisted of [state, ...events]) {
    for (const alias of [
      "deploymentId", "targetCommit", "backupIdentity", "migrationTailBefore",
      "migrationTailAfter", "activatedBuildStamp", "reasonCode",
    ]) assert.equal(alias in persisted, false, alias);
  }
  assert.equal(events.some((event) => JSON.stringify(event).includes("DATABASE_URL")), false);
  rmSync(root, { recursive: true, force: true });
});

test("failed and unproven post-schema upgrades receive distinct ledger terminals", async () => {
  const failedRoot = mkdtempSync(join(tmpdir(), "agentos-deploy-ledger-failed-"));
  const failedLedger = createDeploymentLedger({ stateDir: failedRoot, targetCommit: revisions.to });
  const failedFixture = fixture("build");
  const failed = await executeUpgrade(failedFixture.host, revisions, { ledger: failedLedger });
  assert.equal(failed.ok, false);
  assert.equal(JSON.parse(readFileSync(failedLedger.statePath, "utf8")).state, "FAILED");
  const failedEvents = readFileSync(failedLedger.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(failedEvents.at(-1).reason_code, "build-failed");

  const manualRoot = mkdtempSync(join(tmpdir(), "agentos-deploy-ledger-manual-"));
  const manualLedger = createDeploymentLedger({ stateDir: manualRoot, targetCommit: revisions.to });
  const restoredRoot = mkdtempSync(join(tmpdir(), "agentos-deploy-ledger-restored-"));
  const restoredLedger = createDeploymentLedger({ stateDir: restoredRoot, targetCommit: revisions.to });
  const restoredFixture = fixture();
  restoredFixture.host.publishBuild = async () => {
    throw new DeployFailure("build-swap-failed", "fixture-restored-live-tree");
  };
  const restored = await executeUpgrade(restoredFixture.host, revisions, { ledger: restoredLedger });
  assert.equal(restored.ok, false);
  assert.equal(JSON.parse(readFileSync(restoredLedger.statePath, "utf8")).state, "FAILED");

  const manualFixture = fixture("restart-services");
  manualFixture.host.publishBuild = async () => ({
    rollback: async () => { throw new DeployFailure("build-rollback-failed", "fixture"); },
    commit: async () => undefined,
  });
  const manual = await executeUpgrade(manualFixture.host, revisions, { ledger: manualLedger });
  assert.equal(manual.ok, false);
  assert.equal(JSON.parse(readFileSync(manualLedger.statePath, "utf8")).state, "MANUAL_RECOVERY");
  const manualEvents = readFileSync(manualLedger.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(manualEvents.at(-1).phase, "MANUAL_RECOVERY");
  assert.equal(manualEvents.at(-1).reason_code, "build-rollback-failed");
  rmSync(failedRoot, { recursive: true, force: true });
  rmSync(restoredRoot, { recursive: true, force: true });
  rmSync(manualRoot, { recursive: true, force: true });
});

test("a pre-activation failure never records the staged build stamp as activated", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-ledger-pre-activation-"));
  const ledger = createDeploymentLedger({ stateDir: root, targetCommit: revisions.to });
  const { host } = fixture("generate-prisma-client");
  host.build = async () => ({ buildStamp: { packageName: "@anneal/api", commit: revisions.to, dirty: false } });
  const result = await executeUpgrade(host, revisions, { ledger });
  assert.equal(result.ok, false);
  const events = readFileSync(ledger.eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.every((event) => event.activated_build_stamp === null), true);
  rmSync(root, { recursive: true, force: true });
});

test("a ledger write failure is surfaced as the deploy failure", async () => {
  const { host, calls } = fixture();
  const ledger = {
    record: (state) => {
      if (state === "BACKED_UP") {
        const error = new Error("fixture ledger disk full");
        error.reason = "deployment-ledger-write-failed";
        error.detail = "record-ENOSPC";
        throw error;
      }
    },
  };
  const result = await executeUpgrade(host, revisions, { ledger });
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "deployment-ledger-write-failed");
  assert.ok(calls.includes("escalate"));
});

test("a terminal ledger failure preserves the original deploy failure", async () => {
  const { host, state } = fixture("build");
  const logs = [];
  host.log = (line) => logs.push(line);
  const ledger = {
    record: (phase) => {
      if (phase === "FAILED") throw new DeploymentLedgerError("record", Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    },
  };
  const result = await executeUpgrade(host, revisions, { ledger });
  assert.equal(result.failure.reason, "build-failed");
  assert.equal(result.ledgerFailure.reason, "deployment-ledger-write-failed");
  assert.equal(state.escalated.reason, "build-failed");
  assert.match(logs.join("\n"), /deployment-ledger-write-failed/u);
});

test("a SUCCEEDED ledger failure rolls back before success notification or commit", async () => {
  const { host, calls, state } = fixture();
  const ledger = {
    record: (phase) => {
      if (phase === "SUCCEEDED") throw new DeploymentLedgerError("record", Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    },
  };
  const result = await executeUpgrade(host, revisions, { ledger });
  assert.equal(result.failure.reason, "deployment-ledger-write-failed");
  assert.equal(state.serving, "previous");
  assert.equal(calls.includes("notify-success"), false);
  assert.equal(calls.includes("commit-build"), false);
  assert.equal(calls.includes("rollback-build"), true);
  assert.equal(calls.includes("notify-failure"), true);
});

test("unrelated errors with a reason property remain unexpected errors", async () => {
  const { host } = fixture();
  host.build = async () => { throw { reason: "unrelated-host-reason", detail: "fixture" }; };
  const result = await executeUpgrade(host, revisions);
  assert.equal(result.failure.reason, "unexpected-error");
});

test("short ledger writes and sync failures fail loudly without advancing state", async () => {
  for (const failure of ["short-write", "sync"]) {
    const root = mkdtempSync(join(tmpdir(), `agentos-deploy-ledger-${failure}-`));
    let armed = false;
    let partialWritten = false;
    const filesystem = {
      writeSync: (...args) => {
        if (!armed || failure !== "short-write") return writeSync(...args);
        if (!partialWritten) {
          partialWritten = true;
          const [descriptor, buffer, offset, length, position] = args;
          return writeSync(descriptor, buffer, offset, Math.min(5, length), position);
        }
        return 0;
      },
      fsyncSync: (descriptor) => {
        if (armed && failure === "sync") throw Object.assign(new Error("fixture sync failure"), { code: "EIO" });
        return fsyncSync(descriptor);
      },
    };
    const ledger = createDeploymentLedger({ stateDir: root, targetCommit: revisions.to, filesystem });
    ledger.start();
    armed = true;
    const { host } = fixture();
    const result = await executeUpgrade(host, revisions, { ledger, ledgerStarted: true });
    assert.equal(result.failure.reason, "deployment-ledger-write-failed", failure);
    assert.equal(JSON.parse(readFileSync(ledger.statePath, "utf8")).state, "STARTED", failure);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger retention removes only old UUID deployment directories", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-ledger-retention-"));
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    const directory = join(root, "deployments", id);
    mkdirSync(directory, { recursive: true });
    utimesSync(directory, new Date(Date.UTC(2026, 7, 20 + index)), new Date(Date.UTC(2026, 7, 20 + index)));
  }
  mkdirSync(join(root, "deployments", "operator-notes"), { recursive: true });
  assert.deepEqual(pruneDeploymentLedgers({ stateDir: root, limit: 2 }), { kept: 2, removed: 1 });
  assert.equal(existsSync(join(root, "deployments", ids[0])), false);
  assert.equal(existsSync(join(root, "deployments", "operator-notes")), true);
  assert.deepEqual(DEPLOYMENT_LEDGER_STATES, [
    "STARTED", "BACKED_UP", "SCHEMA_ADVANCED", "ACTIVATED", "VERIFIED", "SUCCEEDED", "FAILED", "MANUAL_RECOVERY",
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("ledger allocation bounds retention even when deploy attempts fail", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-ledger-allocation-retention-"));
  for (let index = 0; index < 16; index += 1) {
    createDeploymentLedger({ stateDir: root, targetCommit: revisions.to });
  }
  assert.equal(readdirSync(join(root, "deployments")).length, 14);
  rmSync(root, { recursive: true, force: true });
});

test("a held lock prevents a concurrent pipeline", async () => {
  let ran = false;
  const lines = [];
  const result = await runLocked({ acquireLock: async () => null, log: (line) => lines.push(line) }, async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.deepEqual(result, { ok: true, skipped: "lock-held" });
  assert.deepEqual(lines, ["SKIP concurrent-run lock-held"]);
});

test("a lock is released after the owner fails", async () => {
  let released = false;
  await assert.rejects(
    runLocked({
      acquireLock: async () => ({ release: async () => { released = true; } }),
      log: () => undefined,
    }, async () => { throw new Error("fixture"); }),
    /fixture/,
  );
  assert.equal(released, true);
});

test("the production SQL is derived from the blocking-status authority", () => {
  const statement = blockingRunsStatement();
  assert.deepEqual(statement.parameters, ["claimed", "provisioning", "running"]);
  assert.match(statement.sql, /IN \(\$1,\$2,\$3\)/u);
  for (const status of statement.parameters) assert.equal(statement.sql.includes(`'${status}'`), false);
});

test("production Git preflight refuses real dirty and divergent repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-git-"));
  const git = "/usr/bin/git";
  const run = (...args) => execFileSync(git, ["-C", root, ...args], { encoding: "utf8" }).trim();
  run("init", "-b", "main");
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.com");
  writeFileSync(join(root, "file"), "base");
  run("add", "file");
  run("commit", "-m", "base");
  const base = run("rev-parse", "HEAD");
  assert.equal(inspectProductionCheckout({ git, root }).refusal, null);
  run("checkout", "-b", "target");
  writeFileSync(join(root, "file"), "target");
  run("commit", "-am", "target");
  const target = run("rev-parse", "HEAD");
  run("checkout", "main");
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, null);
  run("checkout", "-b", "feature");
  assert.equal(inspectProductionCheckout({ git, root }).refusal, "production-checkout-not-main");
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, "production-checkout-not-main");
  run("checkout", "main");
  writeFileSync(join(root, "dirty"), "dirty");
  assert.equal(inspectProductionCheckout({ git, root }).refusal, "dirty-working-tree");
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, "dirty-working-tree");
  rmSync(join(root, "dirty"));
  writeFileSync(join(root, "file"), "divergent");
  run("commit", "-am", "divergent");
  assert.equal(inspectGitPreflight({ git, root, target }).refusal, "non-fast-forward-main");
  rmSync(root, { recursive: true, force: true });
});

test("a killed filesystem-lock owner is reclaimed with process identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-lock-"));
  const lockPath = join(root, "lock");
  const moduleUrl = new URL("./quiet-window-adapters.mjs", import.meta.url).href;
  const code = `import { acquireProcessLock } from ${JSON.stringify(moduleUrl)}; acquireProcessLock({path:${JSON.stringify(lockPath)}}); console.log('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((accept, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk) => chunk.includes("READY") ? accept() : reject(new Error("lock owner not ready")));
    child.once("error", reject);
  });
  assert.equal(acquireProcessLock({ path: lockPath }), null);
  child.kill("SIGKILL");
  await new Promise((accept) => child.once("exit", accept));
  let pipelineRan = false;
  await assert.rejects(
    runLocked({
      acquireLock: async () => acquireProcessLock({ path: lockPath }),
      log: () => undefined,
    }, async () => { pipelineRan = true; }),
    /stale-deploy-owner-recovered/u,
  );
  assert.equal(pipelineRan, false);
  const nextOwner = acquireProcessLock({ path: lockPath });
  assert.equal(nextOwner?.recovered, null);
  await nextOwner?.release();
  rmSync(root, { recursive: true, force: true });
});

test("real directory publication restores previous bytes after a partial swap", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-publish-"));
  const stage = join(root, "stage");
  const previous = join(root, "previous");
  for (const path of ["one/dist", "two/dist"]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "value"), `old-${path}`);
  }
  mkdirSync(join(stage, "one/dist"), { recursive: true });
  writeFileSync(join(stage, "one/dist/value"), "new-one");
  assert.throws(
    () => publishDirectories({ root, stage, previousDirectory: previous, paths: ["one/dist", "two/dist"] }),
    /build-swap-failed/u,
  );
  assert.equal(readFileSync(join(root, "one/dist/value"), "utf8"), "old-one/dist");
  assert.equal(readFileSync(join(root, "two/dist/value"), "utf8"), "old-two/dist");
  rmSync(root, { recursive: true, force: true });
});

test("publication replaces or removes every workspace-local dependency tree transactionally", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-workspace-publish-"));
  const stage = join(root, "stage");
  const previous = join(root, "previous");
  for (const path of ["packages/api/node_modules", "packages/runner/node_modules"]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "value"), `old-${path}`);
  }
  mkdirSync(join(stage, "packages/api/node_modules"), { recursive: true });
  writeFileSync(join(stage, "packages/api/node_modules/value"), "new-api");
  const publication = publishDirectories({
    root,
    stage,
    previousDirectory: previous,
    paths: ["packages/api/node_modules", "packages/runner/node_modules"],
    optionalMissingPaths: ["packages/api/node_modules", "packages/runner/node_modules"],
  });
  assert.equal(readFileSync(join(root, "packages/api/node_modules/value"), "utf8"), "new-api");
  assert.equal(existsSync(join(root, "packages/runner/node_modules")), false);
  await publication.rollback();
  assert.equal(readFileSync(join(root, "packages/api/node_modules/value"), "utf8"), "old-packages/api/node_modules");
  assert.equal(readFileSync(join(root, "packages/runner/node_modules/value"), "utf8"), "old-packages/runner/node_modules");
  rmSync(root, { recursive: true, force: true });
});

test("publication removes a retired CLI dist on commit and restores it on rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-retired-cli-"));
  const cliDist = join(root, "packages/cli/dist");
  mkdirSync(cliDist, { recursive: true });
  writeFileSync(join(cliDist, "index.js"), "old-cli");

  const rollbackPublication = publishDirectories({
    root,
    stage: join(root, "stage"),
    previousDirectory: join(root, "previous-rollback"),
    paths: DEPLOY_OPTIONAL_ARTIFACT_PATHS,
    optionalMissingPaths: DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  });
  assert.equal(existsSync(cliDist), false);
  await rollbackPublication.rollback();
  assert.equal(readFileSync(join(cliDist, "index.js"), "utf8"), "old-cli");

  const commitPublication = publishDirectories({
    root,
    stage: join(root, "stage"),
    previousDirectory: join(root, "previous-commit"),
    paths: DEPLOY_OPTIONAL_ARTIFACT_PATHS,
    optionalMissingPaths: DEPLOY_OPTIONAL_ARTIFACT_PATHS,
  });
  await commitPublication.commit();
  assert.equal(existsSync(cliDist), false);
  rmSync(root, { recursive: true, force: true });
});

test("deploy history retention keeps bounded rollback builds and daily database coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-retention-"));
  const backups = join(root, "backups");
  mkdirSync(backups);
  const previousNames = [];
  for (let index = 0; index < 6; index += 1) {
    const name = `previous-${randomUUID()}`;
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "sentinel"), String(index));
    const modified = new Date(Date.UTC(2026, 7, 20 + index));
    utimesSync(path, modified, modified);
    previousNames.push(name);
  }
  mkdirSync(join(root, "previous-not-a-deployer-transaction"));
  const stageName = `stage-${randomUUID()}`;
  mkdirSync(join(root, stageName));
  writeFileSync(join(root, "escalated.json"), "retain\n");

  const backupNames = [];
  const createBackup = (day, hour, minute) => {
    const timestamp = `${day}T${String(hour).padStart(2, "0")}-${String(minute).padStart(2, "0")}-00-000Z`;
    const name = `${timestamp}-${"a".repeat(12)}-${"b".repeat(12)}.dump`;
    const path = join(backups, name);
    writeFileSync(path, name);
    const modified = new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
    utimesSync(path, modified, modified);
    backupNames.push(name);
  };
  createBackup("2026-07-30", 12, 0);
  for (let index = 0; index < 20; index += 1) createBackup("2026-08-25", Math.floor(index / 60), index % 60);
  writeFileSync(join(backups, "operator-note.txt"), "retain\n");

  const result = pruneDeployHistory({
    stateDir: root,
    now: Date.parse("2026-08-27T00:00:00.000Z"),
  });

  assert.deepEqual(result, { keptPrevious: 3, removedPrevious: 3, keptBackups: 15, removedBackups: 6 });
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith("previous-") && name !== "previous-not-a-deployer-transaction").sort(),
    previousNames.slice(-3).sort(),
  );
  assert.ok(existsSync(join(root, "previous-not-a-deployer-transaction")));
  assert.ok(existsSync(join(root, stageName)));
  assert.equal(readFileSync(join(root, "escalated.json"), "utf8"), "retain\n");
  assert.equal(readdirSync(backups).filter((name) => name.endsWith(".dump")).length, 15);
  assert.ok(existsSync(join(backups, backupNames[0])));
  assert.equal(readFileSync(join(backups, "operator-note.txt"), "utf8"), "retain\n");
  rmSync(root, { recursive: true, force: true });
});

test("deploy history retention refuses a matched symlink without touching its target", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-retention-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "agentos-deploy-retention-target-"));
  writeFileSync(join(outside, "sentinel"), "retain\n");
  symlinkSync(outside, join(root, `previous-${randomUUID()}`));
  assert.throws(
    () => pruneDeployHistory({ stateDir: root }),
    /deploy-retention-refused/u,
  );
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "retain\n");
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("dry-run reads every decision surface and invokes no mutation", async () => {
  const calls = [];
  const result = await dryRunDecision({
    revisions: async () => { calls.push("revisions"); return { from: "a", source: "a", to: "b" }; },
    blockingRuns: async () => { calls.push("runs"); return [{ id: "r1", status: "waiting-inbox" }]; },
    repositoryState: async () => { calls.push("repository"); return { branch: "main", dirty: false, fastForward: "yes" }; },
    serviceState: async () => { calls.push("services"); return { ok: true }; },
    backupState: async () => { calls.push("backup"); return { ok: true, mode: "container" }; },
  });
  assert.equal(result.quiet, true);
  assert.deepEqual(new Set(calls), new Set(["revisions", "runs", "repository", "services", "backup"]));
  assert.ok(result.lines.includes("DRY-RUN backup=ready mode=container"));
  assert.equal(result.lines.filter((line) => line.includes("mutation=skipped")).length, 11);
});

const buildCacheFixture = (root, revision, buildKey) => {
  const tree = join(root, "builds", buildKey, "tree");
  for (const output of RELEASE_SNAPSHOT_OUTPUTS) {
    mkdirSync(join(tree, output), { recursive: true });
    writeFileSync(join(tree, output, "artifact.txt"), output);
  }
  writeFileSync(join(root, "builds", buildKey, "READY"), `${buildKey}\n`);
  writeFileSync(join(tree, "packages/api/dist/build-info.json"), JSON.stringify({
    packageName: "@anneal/api", commit: revision, dirty: false,
  }));
  writeFileSync(join(tree, "packages/runner/dist/build-info.json"), JSON.stringify({
    packageName: "@anneal/runner", commit: revision, dirty: false,
  }));
};

test("an exact merge-gate snapshot materializes every deploy output without a source build", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-release-snapshot-"));
  const cacheRoot = join(root, "cache");
  const stageRoot = join(root, "stage");
  const revision = "c".repeat(40);
  const buildKey = "d".repeat(64);
  mkdirSync(stageRoot);
  buildCacheFixture(cacheRoot, revision, buildKey);
  assert.deepEqual(publishReleaseSnapshot({ revision, buildKey, cacheRoot }), { published: true, buildKey });
  assert.deepEqual(materializeReleaseSnapshot({ revision, stageRoot, cacheRoot }), { hit: true, buildKey });
  for (const output of RELEASE_SNAPSHOT_OUTPUTS) {
    assert.equal(readFileSync(join(stageRoot, output, "artifact.txt"), "utf8"), output);
  }
  rmSync(root, { recursive: true, force: true });
});

test("a missing or evicted release snapshot explicitly falls back to a source build", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-release-miss-"));
  const cacheRoot = join(root, "cache");
  const stageRoot = join(root, "stage");
  const revision = "e".repeat(40);
  const buildKey = "f".repeat(64);
  mkdirSync(stageRoot);
  assert.deepEqual(materializeReleaseSnapshot({ revision, stageRoot, cacheRoot }), { hit: false, reason: "missing" });
  buildCacheFixture(cacheRoot, revision, buildKey);
  publishReleaseSnapshot({ revision, buildKey, cacheRoot });
  rmSync(join(cacheRoot, "builds", buildKey), { recursive: true });
  assert.deepEqual(materializeReleaseSnapshot({ revision, stageRoot, cacheRoot }), { hit: false, reason: "evicted" });
  rmSync(root, { recursive: true, force: true });
});

test("a pre-rename warm cache entry is a cache miss instead of corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-release-pre-rename-"));
  const cacheRoot = join(root, "cache");
  const stageRoot = join(root, "stage");
  const revision = "9".repeat(40);
  const buildKey = "8".repeat(64);
  mkdirSync(stageRoot);
  buildCacheFixture(cacheRoot, revision, buildKey);
  publishReleaseSnapshot({ revision, buildKey, cacheRoot });
  writeFileSync(join(cacheRoot, "builds", buildKey, "tree/packages/api/dist/build-info.json"), JSON.stringify({
    packageName: "@agentos/api", commit: revision, dirty: false,
  }));
  assert.deepEqual(materializeReleaseSnapshot({ revision, stageRoot, cacheRoot }), {
    hit: false,
    reason: "incompatible",
  });
  rmSync(root, { recursive: true, force: true });
});

test("a present but corrupted or symlinked release snapshot fails loudly", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-release-invalid-"));
  const cacheRoot = join(root, "cache");
  const stageRoot = join(root, "stage");
  const revision = "1".repeat(40);
  const buildKey = "2".repeat(64);
  mkdirSync(stageRoot);
  buildCacheFixture(cacheRoot, revision, buildKey);
  publishReleaseSnapshot({ revision, buildKey, cacheRoot });
  rmSync(join(cacheRoot, "builds", buildKey, "tree", "apps/web/dist/artifact.txt"));
  assert.throws(
    () => materializeReleaseSnapshot({ revision, stageRoot, cacheRoot }),
    (error) => error instanceof DeployFailure && error.reason === "release-snapshot-invalid",
  );
  writeFileSync(join(cacheRoot, "builds", buildKey, "tree", "apps/web/dist/artifact.txt"), "apps/web/dist");
  symlinkSync("/tmp", join(cacheRoot, "builds", buildKey, "tree", "apps/web/dist/unsafe"));
  assert.throws(
    () => materializeReleaseSnapshot({ revision, stageRoot, cacheRoot }),
    (error) => error instanceof DeployFailure && error.reason === "release-snapshot-invalid",
  );
  rmSync(root, { recursive: true, force: true });
});

test("Git network commands retry twice with bounded delays before succeeding or surfacing failure", async () => {
  const waits = [];
  let attempts = 0;
  const recovered = await runCommandWithRetry(async () => ({
    code: ++attempts === 3 ? 0 : 128, stdout: "", stderr: "transient",
  }), { wait: async (milliseconds) => { waits.push(milliseconds); } });
  assert.equal(recovered.code, 0);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2_000, 5_000]);

  attempts = 0;
  const failed = await runCommandWithRetry(async () => {
    attempts += 1;
    return { code: 128, stdout: "", stderr: "still unavailable" };
  }, { wait: async () => undefined });
  assert.equal(failed.code, 128);
  assert.equal(attempts, 3);
});

test("the merge gate publishes deploy acceleration only after its final drift proof", () => {
  const repositoryRoot = realpathSync(new URL("../../", import.meta.url));
  const source = readFileSync(join(repositoryRoot, "scripts/merge-gate.sh"), "utf8");
  const drift = source.lastIndexOf('step "verify the gated commit did not drift"');
  const buildPublication = source.lastIndexOf("publish_deferred_build_snapshot");
  const releasePublication = source.lastIndexOf("publish_release_snapshot");
  assert.ok(drift >= 0 && drift < buildPublication && buildPublication < releasePublication);
});

test("deployment regenerates Prisma Client after migration and verifies it", () => {
  const repositoryRoot = realpathSync(new URL("../../", import.meta.url));
  const source = readFileSync(join(repositoryRoot, "scripts/deploy/quiet-window-deploy.mjs"), "utf8");
  assert.match(source, /prisma-client-generation-refused/u);
  assert.match(source, /\[loadBinaries\(\)\.npm, "run", "db:generate"\]/u);
  assert.ok(source.indexOf("guardedMigration:") < source.indexOf("generatePrismaClient:"));
  assert.ok(source.indexOf("generatePrismaClient:") < source.indexOf("syncCanonicalPrompts:"));
  assert.match(source, /npm-ci-did-not-produce-generated-prisma-client/u);
  assert.match(source, /node_modules\/\.prisma\/client\/schema\.prisma/u);
});

test("dry-run reports a refused container backup contract as a named decision", async () => {
  const result = await dryRunDecision({
    revisions: async () => ({ from: "a", source: "a", to: "b" }),
    blockingRuns: async () => [],
    repositoryState: async () => ({ branch: "main", dirty: false, fastForward: "yes" }),
    serviceState: async () => ({ ok: true }),
    backupState: async () => ({
      ok: false,
      mode: "container",
      reason: "backup-container-pg-dump-not-executable:/missing/pg_dump",
    }),
  });
  assert.equal(result.backup.ok, false);
  assert.ok(result.lines.includes(
    "DRY-RUN backup=not-ready mode=container reason=backup-container-pg-dump-not-executable:/missing/pg_dump",
  ));
});

const fakeDocker = (root) => {
  const path = join(root, "docker-fixture");
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'true\\n'
  exit 0
fi
if [ -n "$FAKE_DOCKER_LOG" ]; then
  printf '%s\\n' "$@" > "$FAKE_DOCKER_LOG"
  printf 'password=%s\\n' "$PGPASSWORD" >> "$FAKE_DOCKER_LOG"
fi
if [ -n "$FAKE_DOCKER_DELAY" ]; then
  sleep "$FAKE_DOCKER_DELAY"
fi
if [ "$FAKE_DOCKER_FAIL" = "1" ]; then
  printf 'fixture backup failed\\n' >&2
  exit 42
fi
printf 'PGDUMP-CUSTOM-FIXTURE'
`);
  chmodSync(path, 0o755);
  return path;
};

test("installer requires an explicit backup mode and executable configuration", () => {
  assert.throws(() => parseInstallerArgs([]), /installer-option-required:--pg-dump-mode/u);
  assert.throws(
    () => parseInstallerArgs([
      "--pg-dump-mode", "container",
      "--pg-dump-container", "agentos-postgres-1",
      "--container-pg-dump-binary", "/usr/local/bin/pg_dump",
    ]),
    /installer-option-required:--docker-binary/u,
  );
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-installer-refusal-"));
  const docker = join(root, "docker");
  writeFileSync(docker, "#!/bin/sh\nexit 0\n");
  chmodSync(docker, 0o644);
  assert.throws(
    () => verifyBackupConfiguration({
      mode: "container",
      dockerBinary: docker,
      container: "agentos-postgres-1",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    }),
    /backup-configuration-invalid:docker-binary-not-executable/u,
  );
  chmodSync(docker, 0o755);
  assert.throws(
    () => verifyBackupConfiguration({
      mode: "container",
      dockerBinary: docker,
      container: "agentos-postgres-1",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    }, (_program, args) => {
      if (args[0] === "inspect") return "true\n";
      throw new Error("not executable");
    }),
    /backup-container-pg-dump-not-executable/u,
  );
  assert.throws(
    () => backupConfigurationFromEnvironment({ DEPLOY_PG_DUMP_MODE: "container" }),
    /DEPLOY_PG_DUMP_CONTAINER-invalid/u,
  );
  rmSync(root, { recursive: true, force: true });
});

test("installer verifies and renders the production container backup contract", () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-installer-"));
  const docker = fakeDocker(root);
  const parsed = parseInstallerArgs([
    "--pg-dump-mode", "container",
    "--docker-binary", docker,
    "--pg-dump-container", "agentos-postgres-1",
    "--container-pg-dump-binary", "/usr/local/bin/pg_dump",
  ]);
  const backup = verifyBackupConfiguration(parsed.backup);
  assert.deepEqual(backup, {
    mode: "container",
    dockerBinary: realpathSync(docker),
    container: "agentos-postgres-1",
    pgDumpBinary: "/usr/local/bin/pg_dump",
  });
  const template = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
  const rendered = renderLaunchdPlist(template, {
    nodeBinary: "/node&bin",
    deployScript: "/repo/<deploy>",
    repositoryRoot: "/repo",
    stdoutPath: "/logs/out",
    stderrPath: "/logs/err",
    path: "/node&path:/usr/bin:/bin",
    gitBinary: "/usr/bin/git",
    npmBinary: "/opt/homebrew/bin/npm",
    backup,
  });
  assert.match(rendered, /\/node&amp;bin/u);
  assert.match(rendered, /\/node&amp;path:\/usr\/bin:\/bin/u);
  assert.match(rendered, /\/repo\/&lt;deploy&gt;/u);
  assert.match(rendered, /\/opt\/homebrew\/bin\/npm/u);
  assert.match(rendered, /<key>PATH<\/key>/u);
  assert.match(rendered, /DEPLOY_NODE_BINARY/u);
  assert.match(rendered, /DEPLOY_PG_DUMP_MODE/u);
  assert.match(rendered, /agentos-postgres-1/u);
  assert.match(rendered, /DEPLOY_CONTAINER_PG_DUMP_BINARY/u);
  assert.doesNotMatch(rendered, /DEPLOY_PG_DUMP_BINARY/u);
  assert.doesNotMatch(rendered, /__[A-Z_]+__/u);
  rmSync(root, { recursive: true, force: true });
});

test("macOS plutil accepts the rendered launchd contract", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-plutil-"));
  try {
    const template = readFileSync(new URL("./com.agentos.auto-deploy.plist.in", import.meta.url), "utf8");
    const rendered = renderLaunchdPlist(template, {
      nodeBinary: "/opt/node/bin/node",
      deployScript: "/opt/agentos/deploy.mjs",
      repositoryRoot: "/opt/agentos/repository",
      stdoutPath: "/var/log/agentos-deploy.stdout",
      stderrPath: "/var/log/agentos-deploy.stderr",
      path: "/opt/node/bin:/usr/bin:/bin",
      gitBinary: "/usr/bin/git",
      npmBinary: "/opt/node/bin/npm",
      backup: {
        mode: "container",
        dockerBinary: "/usr/local/bin/docker",
        container: "agentos-postgres-1",
        pgDumpBinary: "/usr/local/bin/pg_dump",
      },
    });
    const renderedPath = join(root, "rendered.plist");
    writeFileSync(renderedPath, rendered);
    execFileSync("/usr/bin/plutil", ["-lint", renderedPath], { stdio: "ignore" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer proves node, git, and npm under the exact rendered launchd PATH", () => {
  const values = {
    nodeBinary: "/opt/node/bin/node",
    gitBinary: "/opt/git/bin/git",
    npmBinary: "/opt/npm/npm-cli.js",
  };
  const path = controlledLaunchdPath(values);
  assert.equal(path, "/opt/node/bin:/opt/git/bin:/usr/local/bin:/usr/bin:/bin");
  const calls = [];
  verifyRenderedToolchain({ ...values, path }, (program, args, options) => {
    calls.push({ program, args, path: options.env.PATH });
    return "fixture\n";
  });
  assert.deepEqual(calls, [
    { program: values.nodeBinary, args: ["--version"], path },
    { program: values.gitBinary, args: ["--version"], path },
    { program: values.nodeBinary, args: [values.npmBinary, "--version"], path },
  ]);
});

test("container backup preserves pg_dump arguments and writes host output atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-backup-"));
  const docker = fakeDocker(root);
  const logPath = join(root, "arguments");
  const output = join(root, "backup.dump");
  await writePgDumpBackup({
    configuration: {
      mode: "container",
      dockerBinary: docker,
      container: "agentos-postgres-1",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    },
    databaseUrl: "postgresql://fixture:placeholder%40value@127.0.0.1:5544/agentos",
    output,
    env: { ...process.env, FAKE_DOCKER_LOG: logPath },
  });
  const flow = readFileSync(logPath, "utf8").split("\n");
  assert.deepEqual(flow.slice(0, 13), [
    "exec", "--env", "PGPASSWORD", "agentos-postgres-1", "/usr/local/bin/pg_dump",
    "-Fc", "--host", "127.0.0.1", "--port", "5544", "--username", "fixture", "--dbname",
  ]);
  assert.equal(flow[13], "agentos");
  assert.equal(flow[14], "password=placeholder@value");
  assert.equal(flow.some((value) => value.includes("placeholder@value") && !value.startsWith("password=")), false);
  assert.equal(readFileSync(output, "utf8"), "PGDUMP-CUSTOM-FIXTURE");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".partial-")), []);
  rmSync(root, { recursive: true, force: true });
});

test("container backup failure leaves no final or partial host backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-backup-failure-"));
  const docker = fakeDocker(root);
  const output = join(root, "backup.dump");
  await assert.rejects(
    writePgDumpBackup({
      configuration: {
        mode: "container",
        dockerBinary: docker,
        container: "agentos-postgres-1",
        pgDumpBinary: "/usr/local/bin/pg_dump",
      },
      databaseUrl: "postgresql://alice:secret@localhost:5432/agentos",
      output,
      env: { ...process.env, FAKE_DOCKER_FAIL: "1" },
    }),
    /pg_dump-exit-42: fixture backup failed/u,
  );
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".partial-")), []);
  rmSync(root, { recursive: true, force: true });
});

test("an interrupted container backup terminates the child and removes its partial file", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-deploy-backup-interrupt-"));
  const docker = fakeDocker(root);
  const output = join(root, "backup.dump");
  const controller = new AbortController();
  const pending = writePgDumpBackup({
    configuration: {
      mode: "container",
      dockerBinary: docker,
      container: "agentos-postgres-1",
      pgDumpBinary: "/usr/local/bin/pg_dump",
    },
    databaseUrl: "postgresql://alice:secret@localhost:5432/agentos",
    output,
    env: { ...process.env, FAKE_DOCKER_DELAY: "10" },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /pg_dump-interrupted/u);
  assert.equal(existsSync(output), false);
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".partial-")), []);
  rmSync(root, { recursive: true, force: true });
});
