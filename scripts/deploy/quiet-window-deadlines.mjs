import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SERVICE_LABELS, DeployFailure } from "./quiet-window-lib.mjs";

const seconds = (value) => value * 1_000;
const minutes = (value) => seconds(value * 60);

/** Budgets follow the deploy step, not the executable. Artifact construction
 * normally takes 8-10 minutes; migration preflight is normally seconds and a
 * real migration plus backfill was observed at 75 seconds. */
export const DEPLOY_STEP_TIMEOUT_MS = Object.freeze({
  remoteMainRead: seconds(30),
  serviceInspection: seconds(15),
  releaseArtifactBuild: minutes(15),
  migrationPreflight: minutes(2),
  migrationDeploy: minutes(5),
  databaseBackup: minutes(5),
  prismaClientGeneration: minutes(3),
  canonicalPromptSync: minutes(3),
  serviceRestart: seconds(30),
  previousServiceRestore: seconds(30),
});

const serviceSweepBudget = SERVICE_LABELS.length * DEPLOY_STEP_TIMEOUT_MS.serviceInspection;
const serviceRestartBudget = SERVICE_LABELS.length * DEPLOY_STEP_TIMEOUT_MS.serviceRestart;

/** Successful work that can run while the barrier is held. Synchronous phases
 * are covered by the separate watchdog process and by the explicit margin. */
export const DEPLOY_BARRIER_PHASE_TIMEOUT_MS = Object.freeze({
  "prepare-operation-workspace": 0,
  "verify-stable-service-paths": serviceSweepBudget,
  backup: DEPLOY_STEP_TIMEOUT_MS.databaseBackup,
  "guarded-migration": DEPLOY_STEP_TIMEOUT_MS.migrationPreflight + DEPLOY_STEP_TIMEOUT_MS.migrationDeploy,
  "generate-prisma-client": DEPLOY_STEP_TIMEOUT_MS.prismaClientGeneration,
  "canonical-prompt-sync": DEPLOY_STEP_TIMEOUT_MS.canonicalPromptSync,
  "verify-runtime-prisma-client": 0,
  "assert-quiet-before-restart": 0,
  "publish-build": 0,
  "restart-services": serviceRestartBudget,
  "verify-services": serviceSweepBudget,
});
export const DEPLOY_BARRIER_BUDGETED_WORK_MS = Object.values(DEPLOY_BARRIER_PHASE_TIMEOUT_MS)
  .reduce((total, timeoutMs) => total + timeoutMs, 0);
export const DEPLOY_BARRIER_RECOVERY_BUDGET_MS = SERVICE_LABELS.length
  * DEPLOY_STEP_TIMEOUT_MS.previousServiceRestore;
export const DEPLOY_BARRIER_WATCHDOG_MARGIN_MS = minutes(5);
export const DEPLOY_BARRIER_TIMEOUT_MS = DEPLOY_BARRIER_BUDGETED_WORK_MS
  + DEPLOY_BARRIER_RECOVERY_BUDGET_MS
  + DEPLOY_BARRIER_WATCHDOG_MARGIN_MS;
export const MIGRATION_DEPLOY_TIMEOUT_REASON = "migration-deploy-timeout";
export const BARRIER_TIMEOUT_REASON = "deploy-barrier-timeout";

export const waitForEscalationClear = async ({
  escalationExists,
  verifyBarrier,
  wait,
  onHold = () => undefined,
  onPersistencePending = () => undefined,
  onCleared = () => undefined,
}) => {
  onHold();
  let persistenceObserved = false;
  let persistencePendingReported = false;
  while (true) {
    if (!await verifyBarrier()) {
      throw new DeployFailure("deploy-barrier-lost-during-hold", "exclusive-session-lock-not-held");
    }
    const exists = escalationExists();
    if (exists) persistenceObserved = true;
    else if (persistenceObserved) break;
    else if (!persistencePendingReported) {
      persistencePendingReported = true;
      onPersistencePending();
    }
    await wait();
  }
  onCleared();
};

/** The barrier is the outage boundary, so a separately scheduled child owns
 * its deadline and persists the alert even if the deploy event loop blocks.
 * The callback aborts the current deployment through its existing path. */
export const createBarrierWatchdog = async ({
  timeoutMs = DEPLOY_BARRIER_TIMEOUT_MS,
  escalationPath,
  escalationRecord,
  onTimeout,
  onError = () => undefined,
  spawnImpl = spawn,
}) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("deploy-barrier-timeout-invalid");
  }
  if (typeof escalationPath !== "string" || escalationPath === "") {
    throw new TypeError("deploy-barrier-escalation-path-required");
  }
  if (typeof escalationRecord !== "object" || escalationRecord === null) {
    throw new TypeError("deploy-barrier-escalation-record-required");
  }
  let released = false;
  let exited = false;
  let timeoutReported = false;
  const child = spawnImpl(process.execPath, [
    fileURLToPath(new URL("./quiet-window-watchdog-worker.mjs", import.meta.url)),
    String(Date.now() + timeoutMs),
    escalationPath,
    JSON.stringify(escalationRecord),
  ], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let acceptReady;
  let rejectReady;
  const ready = new Promise((accept, reject) => {
    acceptReady = accept;
    rejectReady = reject;
  });
  let acceptExit;
  const exit = new Promise((accept) => { acceptExit = accept; });
  child.once("error", (error) => {
    onError(error);
    rejectReady(new DeployFailure("deploy-barrier-watchdog-unavailable", error.name));
  });
  child.once("close", (code, signal) => {
    exited = true;
    acceptExit();
    if (released || timeoutReported) return;
    const error = new DeployFailure(
      "deploy-barrier-watchdog-unavailable",
      `exit-${code ?? "signal"}${signal ? `-${signal}` : ""}`,
    );
    onError(error);
    rejectReady(error);
  });
  child.on("message", (message) => {
    if (message?.type === "ready") acceptReady();
    if (message?.type === "error") onError(new Error(`barrier-watchdog-${message.detail}`));
    if (message?.type === "timeout" && !released) {
      timeoutReported = true;
      Promise.resolve(onTimeout()).catch(onError);
    }
  });
  await ready;
  return Object.freeze({
    release: async () => {
      if (released) return;
      released = true;
      if (!exited) child.kill("SIGTERM");
      await exit;
    },
  });
};
