const METHODS = Object.freeze([
  "verifyArtifact", "waitForQuiet", "prepareWorkspace", "backup",
  "guardedMigration", "generatePrismaClient", "syncCanonicalPrompts", "verifyRuntimePrismaClient",
  "verifyStableServicePaths",
  "assertQuietBeforeRestart", "publishBuild", "restartServices", "verifyServices",
  "restorePreviousServices", "escalate", "notify", "cleanupWorkspace",
]);

/** Import-safe production-host composition boundary used by the real job and harness. */
export const createProductionHost = (adapters) => {
  for (const method of METHODS) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  return Object.freeze({ ...adapters });
};
