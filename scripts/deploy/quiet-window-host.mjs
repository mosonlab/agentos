const METHODS = Object.freeze([
  "fastForward", "createStage", "installDependencies", "build", "backup",
  "guardedMigration", "syncCanonicalPrompts", "verifyRuntimePrismaClient",
  "assertQuietBeforeRestart", "publishBuild", "restartServices", "verifyServices",
  "restorePreviousServices", "escalate", "notify", "cleanupStage",
]);

/** Import-safe production-host composition boundary used by the real job and harness. */
export const createProductionHost = (adapters) => {
  for (const method of METHODS) {
    if (typeof adapters[method] !== "function") throw new TypeError(`production-host-adapter-missing:${method}`);
  }
  return Object.freeze({ ...adapters });
};
