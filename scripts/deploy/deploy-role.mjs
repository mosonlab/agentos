/**
 * The deployment role is intentionally a small, closed vocabulary.  Keep the
 * default implicit so an existing control-plane install renders exactly the
 * same definitions and manifests as before this setting was introduced.
 */
export const DEFAULT_DEPLOY_ROLE = "control-plane";
export const DEPLOY_ROLES = Object.freeze([DEFAULT_DEPLOY_ROLE, "runner"]);

export const resolveDeployRole = (environment = process.env) => {
  const configured = environment?.AGENTOS_DEPLOY_ROLE;
  const role = configured === undefined ? DEFAULT_DEPLOY_ROLE : configured;
  if (!DEPLOY_ROLES.includes(role)) {
    throw new Error(`deploy-role-invalid:${String(role)}`);
  }
  return role;
};
