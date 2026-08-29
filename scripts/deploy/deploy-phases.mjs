const phase = (scope, name, hostMethod, mutating, ledgerState = null) => Object.freeze({
  scope,
  name,
  hostMethod,
  mutating,
  ledgerState,
});

/**
 * The declaration is ordered across the main prefix and the host upgrade. A
 * prefix entry names the main operation that owns the boundary; an upgrade
 * entry names the production-host method that executes it.
 */
export const DEPLOY_PHASES = Object.freeze([
  phase("prefix", "parse-arguments", "parseArgs", false),
  phase("prefix", "check-escalation", "checkEscalation", false),
  phase("prefix", "acquire-deploy-lock", "acquireLock", false),
  phase("prefix", "read-revisions", "readRevisions", false),
  phase("prefix", "check-already-deployed", "checkAlreadyDeployed", false),
  phase("prefix", "start-deployment-ledger", "startDeploymentLedger", false, "STARTED"),
  phase("prefix", "prepare-release-artifact", "prepareReleaseArtifact", true, "ARTIFACT_PREPARED"),
  phase("upgrade", "verify-release-artifact", "verifyArtifact", false, "ARTIFACT_VERIFIED"),
  phase("upgrade", "acquire-quiet-window", "waitForQuiet", false),
  phase("upgrade", "prepare-operation-workspace", "prepareWorkspace", true),
  phase("upgrade", "verify-stable-service-paths", "verifyStableServicePaths", false),
  phase("upgrade", "backup", "backup", true, "BACKED_UP"),
  phase("upgrade", "guarded-migration", "guardedMigration", true, "SCHEMA_ADVANCED"),
  phase("upgrade", "generate-prisma-client", "generatePrismaClient", true),
  phase("upgrade", "canonical-prompt-sync", "syncCanonicalPrompts", true),
  phase("upgrade", "verify-runtime-prisma-client", "verifyRuntimePrismaClient", false),
  phase("upgrade", "assert-quiet-before-restart", "assertQuietBeforeRestart", false),
  phase("upgrade", "publish-build", "publishBuild", true, "ACTIVATED"),
  phase("upgrade", "restart-services", "restartServices", true),
  phase("upgrade", "verify-services", "verifyServices", false, "VERIFIED"),
]);

export const PREFIX_DEPLOY_PHASES = Object.freeze(
  DEPLOY_PHASES.filter(({ scope }) => scope === "prefix"),
);

export const UPGRADE_DEPLOY_PHASES = Object.freeze(
  DEPLOY_PHASES.filter(({ scope }) => scope === "upgrade"),
);
