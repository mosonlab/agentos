import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEPLOY_PHASES, UPGRADE_DEPLOY_PHASES } from "./deploy-phases.mjs";
import { openDeploymentAttempt } from "./deployment-attempt.mjs";
import { runDeployCommand } from "./quiet-window-command.mjs";
import { writeEscalationRecord } from "./quiet-window-escalation-record.mjs";
import { DeployFailure, executeUpgrade } from "./quiet-window-lib.mjs";
import {
  DEPLOY_BARRIER_BUDGETED_WORK_MS,
  DEPLOY_BARRIER_PHASE_TIMEOUT_MS,
  DEPLOY_BARRIER_RECOVERY_BUDGET_MS,
  BARRIER_TIMEOUT_REASON,
  createBarrierWatchdog,
  DEPLOY_BARRIER_TIMEOUT_MS,
  DEPLOY_BARRIER_WATCHDOG_MARGIN_MS,
  DEPLOY_STEP_TIMEOUT_MS,
  waitForQuietWithWatchdog,
  waitForEscalationClear,
} from "./quiet-window-deadlines.mjs";
import { createDeployInterruption } from "./quiet-window-interrupt.mjs";

const revisions = { from: "a".repeat(40), to: "b".repeat(40) };

const timeoutUpgrade = ({ phase, run, escalationFails = false, wait, barrierHeld = true }) => {
  const calls = [];
  const state = { escalationExists: false, retained: false, released: false };
  const barrier = {
    retainUntilEscalationCleared: () => { state.retained = true; calls.push("retain-barrier"); },
    release: async () => {
      if (state.retained) {
        await waitForEscalationClear({
          escalationExists: () => state.escalationExists,
          verifyBarrier: async () => barrierHeld,
          wait: wait ?? (async () => { state.escalationExists = false; calls.push("clear-escalation"); }),
          onHold: () => { calls.push("hold-barrier"); },
        });
      }
      state.released = true;
      calls.push("release-barrier");
    },
    verify: async () => barrierHeld,
  };
  const host = {};
  for (const { hostMethod } of DEPLOY_PHASES) host[hostMethod] = async () => undefined;
  host.acquireLock = async () => ({ resources: [{ release: async () => { calls.push("release-lock"); } }] });
  host.readRevisions = async () => ({ revisions });
  host.startDeploymentLedger = async () => ({ ledger: { start: async () => undefined, record: async () => undefined } });
  host.waitForQuiet = async () => ({ barrier, resources: [barrier] });
  host[phase] = async () => run({ barrier, state, calls });
  host.escalate = async (record) => {
    calls.push(`escalate-${record.reason}`);
    if (escalationFails) throw new Error("escalation-write-failed");
    state.escalationExists = true;
  };
  host.notify = async (record) => { calls.push(`notify-${record.outcome}`); };
  host.markEscalationNotified = async () => { calls.push("mark-notified"); };
  host.log = () => undefined;
  const attempt = openDeploymentAttempt({ deployRoot: "/fixture", targetCommit: revisions.to, transactionId: "timeout-fixture" });
  return { barrier, calls, execute: () => executeUpgrade(host, attempt), state };
};

const hangingCommand = (options) => runDeployCommand(
  "/bin/sh",
  ["-c", "trap '' TERM; exec sleep 30"],
  { timeoutMs: 20, timeoutReason: "fixture-timeout", killGraceMs: 20, ...options },
);

test("deploy deadlines are step-specific and preserve the observed build margin", () => {
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild >= 15 * 60_000);
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.migrationPreflight < DEPLOY_STEP_TIMEOUT_MS.migrationDeploy);
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.migrationDeploy < DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild);
  const supervisedPhases = UPGRADE_DEPLOY_PHASES
    .slice(UPGRADE_DEPLOY_PHASES.findIndex(({ name }) => name === "acquire-quiet-window") + 1)
    .map(({ name }) => name);
  assert.deepEqual(Object.keys(DEPLOY_BARRIER_PHASE_TIMEOUT_MS), supervisedPhases);
  assert.equal(
    DEPLOY_BARRIER_BUDGETED_WORK_MS,
    Object.values(DEPLOY_BARRIER_PHASE_TIMEOUT_MS).reduce((total, timeoutMs) => total + timeoutMs, 0),
  );
  assert.equal(
    DEPLOY_BARRIER_TIMEOUT_MS,
    DEPLOY_BARRIER_BUDGETED_WORK_MS
      + DEPLOY_BARRIER_RECOVERY_BUDGET_MS
      + DEPLOY_BARRIER_WATCHDOG_MARGIN_MS,
  );
  assert.ok(DEPLOY_BARRIER_TIMEOUT_MS > DEPLOY_BARRIER_BUDGETED_WORK_MS);
  assert.equal(new Set(Object.values(DEPLOY_STEP_TIMEOUT_MS)).size > 1, true);
});

test("a retained barrier waits until the escalation marker is cleared", async () => {
  let active = true;
  let holds = 0;
  let clears = 0;
  let waits = 0;
  await waitForEscalationClear({
    escalationExists: () => active,
    verifyBarrier: async () => true,
    wait: async () => {
      waits += 1;
      active = false;
    },
    onHold: () => { holds += 1; },
    onCleared: () => { clears += 1; },
  });
  assert.deepEqual({ holds, clears, waits }, { holds: 1, clears: 1, waits: 1 });
});

test("a retained barrier fails closed until persistence is observed and then explicitly cleared", async () => {
  let active = false;
  let waits = 0;
  let persistencePending = 0;
  const held = waitForEscalationClear({
    escalationExists: () => active,
    verifyBarrier: async () => true,
    wait: async () => {
      waits += 1;
      if (waits === 1) active = true;
      else active = false;
    },
    onPersistencePending: () => { persistencePending += 1; },
  });
  await held;
  assert.equal(waits, 2);
  assert.equal(persistencePending, 1);
});

test("a retained barrier surfaces loss of its advisory lock", async () => {
  await assert.rejects(
    waitForEscalationClear({
      escalationExists: () => true,
      verifyBarrier: async () => false,
      wait: async () => undefined,
    }),
    (error) => error instanceof DeployFailure && error.reason === "deploy-barrier-lost-during-hold",
  );
});

test("the barrier watchdog starts before the post-lock blocking-runs query", async () => {
  const calls = [];
  let queryCount = 0;
  const barrier = { release: async () => { calls.push("release-barrier"); } };
  const watchdog = { release: async () => { calls.push("release-watchdog"); } };
  const result = await waitForQuietWithWatchdog({
    blockingRuns: async () => {
      queryCount += 1;
      calls.push(queryCount === 1 ? "query-before-lock" : "query-after-lock");
      return [];
    },
    acquireBarrier: async () => {
      calls.push("acquire-barrier");
      return barrier;
    },
    startWatchdog: async () => {
      calls.push("start-watchdog");
      return watchdog;
    },
    wait: async () => undefined,
  });
  assert.deepEqual(calls, ["query-before-lock", "acquire-barrier", "start-watchdog", "query-after-lock"]);
  assert.deepEqual(result, { barrier, watchdog });
});

test("ordinary step timeout escalates, notifies, fails, and releases the barrier", async () => {
  const execution = timeoutUpgrade({
    phase: "prepareWorkspace",
    run: async () => hangingCommand(),
  });
  const result = await execution.execute();
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "fixture-timeout");
  assert.equal(execution.state.retained, false);
  assert.equal(execution.state.released, true);
  assert.ok(execution.calls.indexOf("notify-failure") < execution.calls.indexOf("release-barrier"));
});

test("migration timeout escalates and retains the barrier through explicit clear", async () => {
  const execution = timeoutUpgrade({
    phase: "guardedMigration",
    run: async ({ barrier }) => hangingCommand({
      timeoutReason: "migration-deploy-timeout",
      onTermination: () => barrier.retainUntilEscalationCleared(),
    }),
  });
  const result = await execution.execute();
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "migration-deploy-timeout");
  assert.equal(execution.state.retained, true);
  assert.equal(execution.state.released, true);
  assert.ok(execution.calls.indexOf("escalate-migration-deploy-timeout") < execution.calls.indexOf("hold-barrier"));
  assert.ok(execution.calls.indexOf("clear-escalation") < execution.calls.indexOf("release-barrier"));
});

test("lock loss during a retained migration hold becomes the terminal deploy failure", async () => {
  const execution = timeoutUpgrade({
    phase: "guardedMigration",
    barrierHeld: false,
    run: async ({ barrier }) => hangingCommand({
      timeoutReason: "migration-deploy-timeout",
      onTermination: () => barrier.retainUntilEscalationCleared(),
    }),
  });
  const result = await execution.execute();
  assert.equal(result.ok, false);
  assert.equal(result.failure.reason, "deploy-barrier-lost-during-hold");
  assert.deepEqual(
    execution.calls.filter((call) => call.startsWith("escalate-")),
    ["escalate-migration-deploy-timeout", "escalate-deploy-barrier-lost-during-hold"],
  );
  assert.equal(execution.calls.at(-1), "mark-notified");
});

test("watchdog expiry during active migration retains the barrier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-migration-watchdog-"));
  const escalationPath = join(directory, "escalated.json");
  const execution = timeoutUpgrade({
    phase: "guardedMigration",
    run: async ({ barrier }) => {
      const controller = new AbortController();
      const failure = new DeployFailure(BARRIER_TIMEOUT_REASON, "fixture-watchdog");
      const watchdog = await createBarrierWatchdog({
        timeoutMs: 500,
        escalationPath,
        escalationRecord: { outcome: "failure", reason: failure.reason, detail: failure.detail, ...revisions },
        onTimeout: () => controller.abort(),
      });
      try {
        return await hangingCommand({
          timeoutMs: 2_000,
          signal: controller.signal,
          abortFailure: () => failure,
          onTermination: () => barrier.retainUntilEscalationCleared(),
        });
      } finally {
        await watchdog.release();
      }
    },
  });
  try {
    const result = await execution.execute();
    assert.equal(result.ok, false);
    assert.equal(result.failure.reason, BARRIER_TIMEOUT_REASON);
    assert.equal(execution.state.retained, true);
    assert.ok(execution.calls.includes("hold-barrier"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration retention does not treat escalation-write failure as operator clear", async () => {
  let allowPersistence;
  let waitStarted;
  const persistenceAllowed = new Promise((resolve) => { allowPersistence = resolve; });
  const firstWait = new Promise((resolve) => { waitStarted = resolve; });
  let waits = 0;
  let execution;
  execution = timeoutUpgrade({
    phase: "guardedMigration",
    escalationFails: true,
    wait: async () => {
      waits += 1;
      if (waits === 1) {
        waitStarted();
        await persistenceAllowed;
        execution.state.escalationExists = true;
      } else {
        execution.state.escalationExists = false;
      }
    },
    run: async ({ barrier }) => hangingCommand({
      timeoutReason: "migration-deploy-timeout",
      onTermination: () => barrier.retainUntilEscalationCleared(),
    }),
  });
  const result = execution.execute();
  await firstWait;
  assert.equal(execution.state.released, false);
  allowPersistence();
  await assert.rejects(result, /escalation-write-failed/u);
  assert.equal(execution.state.released, true);
  assert.equal(waits, 2);
});

test("latest terminal escalation replaces a watchdog precursor", () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-escalation-replace-"));
  const path = join(directory, "escalated.json");
  try {
    writeEscalationRecord({ path, record: { reason: BARRIER_TIMEOUT_REASON, detail: "precursor" } });
    writeEscalationRecord({ path, record: { reason: "terminal-failure", detail: "terminal-detail" } });
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(record.reason, "terminal-failure");
    assert.equal(record.detail, "terminal-detail");
    assert.equal(record.notificationDelivered, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("barrier watchdog independently persists an alert during a synchronous parent stall", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-barrier-watchdog-"));
  const escalationPath = join(directory, "escalated.json");
  const interruption = createDeployInterruption();
  const failure = new DeployFailure(BARRIER_TIMEOUT_REASON, "budget-5ms");
  const watchdog = await createBarrierWatchdog({
    timeoutMs: 20,
    escalationPath,
    escalationRecord: { outcome: "failure", reason: failure.reason, detail: failure.detail, from: "a", to: "b" },
    onTimeout: () => { interruption.interruptWithFailure(failure); },
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  try {
    assert.equal(existsSync(escalationPath), true, "watchdog child did not persist while parent was stalled");
    const record = JSON.parse(readFileSync(escalationPath, "utf8"));
    assert.equal(record.reason, BARRIER_TIMEOUT_REASON);
  } finally {
    await watchdog.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("barrier watchdog can be cancelled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "anneal-barrier-watchdog-cancel-"));
  const escalationPath = join(directory, "escalated.json");
  let cancelledFired = false;
  const cancelled = await createBarrierWatchdog({
    timeoutMs: 10_000,
    escalationPath,
    escalationRecord: { outcome: "failure", reason: BARRIER_TIMEOUT_REASON, from: "a", to: "b" },
    onTimeout: () => { cancelledFired = true; },
  });
  await cancelled.release();
  assert.equal(cancelledFired, false);
  assert.equal(existsSync(escalationPath), false);
  rmSync(directory, { recursive: true, force: true });
});
