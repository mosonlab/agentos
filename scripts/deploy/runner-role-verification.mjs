import { DeployFailure } from "./quiet-window-lib.mjs";

const fail = (reason, detail = "") => { throw new DeployFailure(reason, detail); };

export const runnerIdsFromInventory = (inventory) => Object.freeze(
  inventory.map(({ runnerId }) => runnerId).filter((runnerId) => typeof runnerId === "string"),
);

export const readRunnerRegistry = async ({ apiBaseUrl, operatorToken, fetchImpl = fetch }) => {
  if (typeof operatorToken !== "string" || operatorToken === "") {
    fail("runner-registration-verification-unavailable", "OPERATOR_TOKEN-missing");
  }
  let response;
  try {
    response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/u, "")}/runners`, {
      headers: { accept: "application/json", authorization: `Bearer ${operatorToken}` },
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    fail("runner-registration-verification-unavailable", error instanceof Error ? error.name : "request-failed");
  }
  if (!response?.ok) {
    fail("runner-registration-verification-unavailable", `http-${response?.status ?? "unknown"}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("runner-registration-verification-unavailable", "response-is-not-json");
  }
  if (!Array.isArray(payload?.daemons)) {
    fail("runner-registration-verification-unavailable", "daemons-missing");
  }
  return payload;
};

export const localRegistrationSnapshot = (payload, runnerIds) => Object.freeze(Object.fromEntries(
  payload.daemons
    .filter(({ runnerId }) => runnerIds.includes(runnerId))
    .map(({ runnerId, lastSeenAt }) => [runnerId, typeof lastSeenAt === "string" ? lastSeenAt : null]),
));

/** Return the first deterministic refusal detail, or null when every local
 * runner has produced a newer observation from the activated build. */
export const runnerRegistrationRefusal = ({ payload, runnerIds, before, targetCommit }) => {
  const daemons = new Map(payload.daemons.map((daemon) => [daemon.runnerId, daemon]));
  for (const runnerId of runnerIds) {
    const daemon = daemons.get(runnerId);
    if (!daemon) return `runner-missing-${runnerId}`;
    if (daemon.online !== true) return `runner-offline-${runnerId}`;
    if (daemon.daemonVersion !== targetCommit) return `runner-build-mismatch-${runnerId}`;
    if (typeof daemon.lastSeenAt !== "string" || !Number.isFinite(Date.parse(daemon.lastSeenAt))) {
      return `runner-registration-invalid-${runnerId}`;
    }
    const previous = before[runnerId];
    if (typeof previous === "string" && Date.parse(daemon.lastSeenAt) <= Date.parse(previous)) {
      return `runner-registration-stale-${runnerId}`;
    }
  }
  return null;
};
