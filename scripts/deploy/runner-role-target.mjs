import { DeployFailure } from "./quiet-window-lib.mjs";
import { resolveDeployRole as resolveConfiguredDeployRole } from "./deploy-role.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const API_SERVICES = new Set(["@anneal/api", "@agentos/api"]);

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };

export const resolveDeployRole = (environment = process.env) => {
  try {
    return resolveConfiguredDeployRole(environment);
  } catch {
    fail("deploy-role-invalid", String(environment.AGENTOS_DEPLOY_ROLE));
  }
};

export const controlPlaneApiBaseUrl = (environment = process.env) => {
  const configured = environment.RUNNER_API_URL
    ?? `http://127.0.0.1:${environment.API_PORT ?? "3000"}`;
  if (typeof configured !== "string" || configured.trim() === "") {
    fail("control-plane-api-url-invalid", "RUNNER_API_URL-missing");
  }
  try {
    const url = new URL(configured);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      fail("control-plane-api-url-invalid", "RUNNER_API_URL-must-be-an-http-origin");
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.href.replace(/\/$/u, "");
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("control-plane-api-url-invalid", "RUNNER_API_URL-unparseable");
  }
};

/** Resolve the runner host's only legal deployment target. The source check is
 * deliberately part of this preflight, before an artifact builder is called. */
export const readRunnerTargetRevision = async ({
  apiBaseUrl,
  fetchImpl = fetch,
  sourceContainsCommit,
}) => {
  const endpoint = `${apiBaseUrl.replace(/\/+$/u, "")}/version`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    fail("control-plane-version-unreachable", error instanceof Error ? error.name : "request-failed");
  }
  if (!response?.ok) fail("control-plane-version-unreachable", `http-${response?.status ?? "unknown"}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("control-plane-version-invalid", "response-is-not-json");
  }
  if (payload?.dirty === true) fail("control-plane-build-dirty", String(payload?.commit ?? "unknown"));
  if (payload?.dirty !== false || payload?.stamped !== true
      || !API_SERVICES.has(payload?.service) || !SHA.test(payload?.commit ?? "")) {
    fail("control-plane-version-invalid", "clean-stamped-api-commit-required");
  }

  let contained;
  try {
    contained = await sourceContainsCommit(payload.commit);
  } catch (error) {
    if (error instanceof DeployFailure) throw error;
    fail("control-plane-commit-unavailable", error instanceof Error ? error.name : "source-check-failed");
  }
  if (contained !== true) fail("control-plane-commit-unavailable", payload.commit);
  return payload.commit;
};
