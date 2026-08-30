import assert from "node:assert/strict";
import test from "node:test";

import { DeployFailure } from "./quiet-window-lib.mjs";
import {
  BARRIER_TIMEOUT_REASON,
  createBarrierWatchdog,
  DEPLOY_BARRIER_TIMEOUT_MS,
  DEPLOY_STEP_TIMEOUT_MS,
  MIGRATION_DEPLOY_TIMEOUT_REASON,
  retainBarrierOnMigrationTimeout,
  waitForEscalationClear,
} from "./quiet-window-deadlines.mjs";
import { createDeployInterruption } from "./quiet-window-interrupt.mjs";

test("deploy deadlines are step-specific and preserve the observed build margin", () => {
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild >= 15 * 60_000);
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.migrationPreflight < DEPLOY_STEP_TIMEOUT_MS.migrationDeploy);
  assert.ok(DEPLOY_STEP_TIMEOUT_MS.migrationDeploy < DEPLOY_STEP_TIMEOUT_MS.releaseArtifactBuild);
  assert.ok(DEPLOY_BARRIER_TIMEOUT_MS >= DEPLOY_STEP_TIMEOUT_MS.migrationDeploy);
  assert.equal(new Set(Object.values(DEPLOY_STEP_TIMEOUT_MS)).size > 1, true);
});

test("only migrate deploy timeout marks the barrier for retention", async () => {
  let retained = 0;
  const barrier = { retainUntilEscalationCleared: () => { retained += 1; } };
  await assert.rejects(
    retainBarrierOnMigrationTimeout(barrier, async () => {
      throw new DeployFailure(MIGRATION_DEPLOY_TIMEOUT_REASON, "fixture");
    }),
    (error) => error.reason === MIGRATION_DEPLOY_TIMEOUT_REASON,
  );
  assert.equal(retained, 1);

  await assert.rejects(
    retainBarrierOnMigrationTimeout(barrier, async () => {
      throw new DeployFailure("migration-preflight-timeout", "fixture");
    }),
  );
  assert.equal(retained, 1);
});

test("a retained barrier waits until the escalation marker is cleared", async () => {
  let active = true;
  let holds = 0;
  let clears = 0;
  let waits = 0;
  await waitForEscalationClear({
    escalationExists: () => active,
    wait: async () => {
      waits += 1;
      active = false;
    },
    onHold: () => { holds += 1; },
    onCleared: () => { clears += 1; },
  });
  assert.deepEqual({ holds, clears, waits }, { holds: 1, clears: 1, waits: 1 });
});

test("barrier watchdog independently interrupts and can be cancelled", async () => {
  const interruption = createDeployInterruption();
  const failure = new DeployFailure(BARRIER_TIMEOUT_REASON, "budget-5ms");
  const fired = new Promise((resolve) => {
    createBarrierWatchdog({
      timeoutMs: 5,
      onTimeout: () => {
        interruption.interruptWithFailure(failure);
        resolve();
      },
    });
  });
  await fired;
  assert.throws(() => interruption.throwIfInterrupted(), (error) => error === failure);

  let cancelledFired = false;
  const cancelled = createBarrierWatchdog({
    timeoutMs: 5,
    onTimeout: () => { cancelledFired = true; },
  });
  await cancelled.release();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(cancelledFired, false);
});
