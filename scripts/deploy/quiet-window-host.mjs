import { deployPhasesForRole } from "./deploy-phases.mjs";
import { DEFAULT_DEPLOY_ROLE } from "./deploy-role.mjs";

/** Import-safe production adapter for the deployment host seam. Every phase
 * method, the read-only methods dry-run drives, and the recovery and
 * notification methods must all be present before a deployment starts. */
export const createProductionHost = (adapters, deployRole = DEFAULT_DEPLOY_ROLE) => {
  for (const { hostMethod: method } of deployPhasesForRole(deployRole)) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  for (const method of [
    "blockingRuns",
    "artifactState",
    "serviceState",
    ...(deployRole === DEFAULT_DEPLOY_ROLE ? ["backupState"] : []),
    "restorePreviousServices",
    "escalate",
    "notify",
  ]) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  return Object.freeze({ ...adapters });
};
