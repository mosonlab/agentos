import { UPGRADE_DEPLOY_PHASES } from "./deploy-phases.mjs";

/** Import-safe production-host composition boundary used by the real job and harness. */
export const createProductionHost = (adapters) => {
  for (const { hostMethod: method } of UPGRADE_DEPLOY_PHASES) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  for (const method of ["restorePreviousServices", "escalate", "notify", "cleanupWorkspace"]) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  return Object.freeze({ ...adapters });
};
