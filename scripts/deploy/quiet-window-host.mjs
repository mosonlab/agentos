import { DEPLOY_PHASES } from "./deploy-phases.mjs";

/** Import-safe production adapter for the deployment host seam. Every phase
 * method, the read-only methods dry-run drives, and the recovery and
 * notification methods must all be present before a deployment starts. */
export const createProductionHost = (adapters) => {
  for (const { hostMethod: method } of DEPLOY_PHASES) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  for (const method of [
    "blockingRuns",
    "artifactState",
    "serviceState",
    "backupState",
    "restorePreviousServices",
    "escalate",
    "notify",
  ]) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  return Object.freeze({ ...adapters });
};
