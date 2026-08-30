import { DeployFailure } from "./quiet-window-lib.mjs";
import { runCommandWithRetry } from "./quiet-window-retry.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const TRANSIENT_REASON = "remote-main-unreadable";
const AUTH_FAILURE = /(?:authentication failed|could not read username|terminal prompts disabled|invalid (?:username|password)|permission denied|access denied|forbidden|requested url returned error: (?:401|403|407)|repository not found)/iu;
const TRANSIENT_FAILURE = /(?:could not resolve (?:host|proxy)|failed to connect|connection (?:timed out|reset|refused|closed)|operation timed out|network is unreachable|proxy .*(?:aborted|failed)|connect tunnel failed|recv failure|tls .*(?:connection|handshake)|ssl(?:_error_syscall| .*(?:connect|error))|gnutls_handshake.*terminated|unexpected (?:disconnect|eof)|remote end hung up|early eof|econnreset|etimedout|eai_again|http\/2 stream.*not closed cleanly|requested url returned error: (?:408|429|5\d\d)|empty reply from server)/iu;
const AUTO_CLEAR_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  source: "remote-main-transport-classifier",
});

export const transientRemoteMainEscalationFields = (failure) =>
  failure?.reason === TRANSIENT_REASON && failure.autoClear === AUTO_CLEAR_PROVENANCE
    ? { autoClear: AUTO_CLEAR_PROVENANCE }
    : {};

const failureDetail = (result) => `exit-${Number.isInteger(result?.code) ? result.code : 1}`;

/** Classify one exact-ref ls-remote result. Only transport failures receive the
 * self-clearable reason; auth, a missing main ref, malformed output and unknown
 * command failures stay distinct and therefore remain operator-latched. */
export const classifyRemoteMainResult = (result) => {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr : "";
  if (result?.code === 0) {
    const lines = stdout.trim().split("\n").filter(Boolean);
    const fields = lines.length === 1 ? lines[0].trim().split(/\s+/u) : [];
    if (fields.length === 2 && SHA.test(fields[0]) && fields[1] === "refs/heads/main") {
      return { revision: fields[0] };
    }
    return { failure: new DeployFailure("remote-main-corrupt-response", "invalid-main-ref") };
  }

  const diagnosis = `${stderr}\n${stdout}`;
  if (AUTH_FAILURE.test(diagnosis)) {
    return { failure: new DeployFailure("remote-main-auth-failed", failureDetail(result)) };
  }
  if (result?.code === 2) {
    return { failure: new DeployFailure("remote-main-ref-missing", failureDetail(result)) };
  }
  if (TRANSIENT_FAILURE.test(diagnosis)) {
    const failure = new DeployFailure(TRANSIENT_REASON, failureDetail(result));
    failure.autoClear = AUTO_CLEAR_PROVENANCE;
    return { failure };
  }
  return { failure: new DeployFailure("remote-main-read-failed", failureDetail(result)) };
};

/** Read remote main with bounded backoff for transport failures only. */
export const readRemoteMainRevision = async ({
  run,
  delaysMs,
  wait,
  onRetry = () => undefined,
}) => {
  const result = await runCommandWithRetry(run, {
    delaysMs,
    wait,
    shouldRetry: (attemptResult) =>
      classifyRemoteMainResult(attemptResult).failure?.reason === TRANSIENT_REASON,
    onRetry: (retry) => onRetry({ ...retry, reason: TRANSIENT_REASON }),
  });
  const classified = classifyRemoteMainResult(result);
  if (classified.failure) throw classified.failure;
  return classified.revision;
};

/** Clear only the one escalation class whose recovery can be proved by a later
 * remote read. The clear happens before the single audit line can claim it. */
export const autoClearTransientRemoteMainEscalation = async ({
  escalation,
  readRemoteMain,
  clear,
  audit,
  now = () => new Date(),
}) => {
  if (escalation?.reason !== TRANSIENT_REASON) return { cleared: false };
  if (escalation?.autoClear?.schemaVersion !== AUTO_CLEAR_PROVENANCE.schemaVersion
    || escalation.autoClear.source !== AUTO_CLEAR_PROVENANCE.source) return { cleared: false };
  if (typeof escalation.escalatedAt !== "string"
    || Number.isNaN(Date.parse(escalation.escalatedAt))) return { cleared: false };
  const revision = await readRemoteMain();
  const clearedAt = now().toISOString();
  const removed = await clear();
  if (removed === false) return { cleared: true, revision };
  await audit(`AUDIT escalation-auto-cleared escalation=${TRANSIENT_REASON} failed-window=${escalation.escalatedAt}..${clearedAt} clearing-read=${revision}`);
  return { cleared: true, revision };
};
