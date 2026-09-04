import { DEPLOY_ROLES } from "./deploy-role.mjs";

export { DEPLOY_ROLES };

const phase = (scope, name, hostMethod, mutating, ledgerState = null, roles = DEPLOY_ROLES) => Object.freeze({
  scope,
  name,
  hostMethod,
  mutating,
  ledgerState,
  roles,
});

/** The full ordered deployment. Every row names a host method that receives
 * the DeploymentAttempt and returns the facts it established. */
export const DEPLOY_PHASES = Object.freeze([
  phase("prefix", "read-revisions", "readRevisions", false),
  phase("prefix", "check-already-deployed", "checkAlreadyDeployed", false),
  phase("prefix", "start-deployment-ledger", "startDeploymentLedger", false, "STARTED"),
  phase("prefix", "prepare-release-artifact", "prepareReleaseArtifact", true, "ARTIFACT_PREPARED"),
  phase("upgrade", "verify-release-artifact", "verifyArtifact", false, "ARTIFACT_VERIFIED"),
  phase("upgrade", "acquire-quiet-window", "waitForQuiet", false),
  phase("upgrade", "prepare-operation-workspace", "prepareWorkspace", true),
  phase("upgrade", "verify-stable-service-paths", "verifyStableServicePaths", false),
  phase("upgrade", "backup", "backup", true, "BACKED_UP", Object.freeze(["control-plane"])),
  phase("upgrade", "guarded-migration", "guardedMigration", true, "SCHEMA_ADVANCED", Object.freeze(["control-plane"])),
  phase("upgrade", "generate-prisma-client", "generatePrismaClient", true, null, Object.freeze(["control-plane"])),
  phase("upgrade", "canonical-prompt-sync", "syncCanonicalPrompts", true, null, Object.freeze(["control-plane"])),
  phase("upgrade", "verify-runtime-prisma-client", "verifyRuntimePrismaClient", false, null, Object.freeze(["control-plane"])),
  phase("upgrade", "assert-quiet-before-restart", "assertQuietBeforeRestart", false),
  phase("upgrade", "verify-control-plane-target", "verifyControlPlaneTarget", false, null, Object.freeze(["runner"])),
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

export const deployPhasesForRole = (role) => {
  if (!DEPLOY_ROLES.includes(role)) throw new Error(`deploy-role-invalid:${String(role)}`);
  return Object.freeze(DEPLOY_PHASES.filter(({ roles }) => roles.includes(role)));
};

export const upgradeDeployPhasesForRole = (role) => Object.freeze(
  deployPhasesForRole(role).filter(({ scope }) => scope === "upgrade"),
);
