import { DEPLOY_PHASES } from "./deploy-phases.mjs";

/** Import-safe production adapter for the deployment host seam. */
export const createProductionHost = (adapters) => {
  for (const { hostMethod: method } of DEPLOY_PHASES) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  for (const method of ["restorePreviousServices", "escalate", "notify"]) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  return Object.freeze({ ...adapters });
};
