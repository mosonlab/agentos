import { DeployFailure } from "./quiet-window-lib.mjs";

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
  prismaClientGeneration: minutes(3),
  canonicalPromptSync: minutes(3),
  serviceRestart: seconds(30),
  previousServiceRestore: seconds(30),
});

export const DEPLOY_BARRIER_TIMEOUT_MS = minutes(15);
export const MIGRATION_DEPLOY_TIMEOUT_REASON = "migration-deploy-timeout";
export const BARRIER_TIMEOUT_REASON = "deploy-barrier-timeout";

export const retainBarrierOnMigrationTimeout = async (barrier, run) => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DeployFailure && error.reason === MIGRATION_DEPLOY_TIMEOUT_REASON) {
      barrier.retainUntilEscalationCleared();
    }
    throw error;
  }
};

export const waitForEscalationClear = async ({
  escalationExists,
  wait,
  onHold = () => undefined,
  onCleared = () => undefined,
}) => {
  if (!escalationExists()) return;
  onHold();
  while (escalationExists()) await wait();
  onCleared();
};

/** The barrier is the outage boundary, so it has a deadline independent of
 * child commands. Its callback is responsible for persisting the alert and
 * aborting the current deployment through the existing failure path. */
export const createBarrierWatchdog = ({
  timeoutMs = DEPLOY_BARRIER_TIMEOUT_MS,
  onTimeout,
  onError = () => undefined,
}) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("deploy-barrier-timeout-invalid");
  }
  let released = false;
  const timer = setTimeout(() => {
    if (released) return;
    Promise.resolve(onTimeout()).catch(onError);
  }, timeoutMs);
  return Object.freeze({
    release: async () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
    },
  });
};
