import { DeployFailure } from "./quiet-window-lib.mjs";
import { runCommandWithRetry } from "./quiet-window-retry.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const TRANSIENT_REASON = "remote-main-unreadable";
const AUTH_FAILURE = /(?:authentication failed|could not read username|terminal prompts disabled|invalid (?:username|password)|permission denied|access denied|forbidden|requested url returned error: (?:401|403|407)|repository not found)/iu;
const TRANSIENT_FAILURE = /(?:could not resolve (?:host|proxy)|failed to connect|connection (?:timed out|reset|refused|closed)|operation timed out|network is unreachable|proxy .*(?:aborted|failed)|connect tunnel failed|recv failure|tls .*(?:connection|handshake)|ssl(?:_error_syscall| .*(?:connect|error))|gnutls_handshake.*terminated|unexpected (?:disconnect|eof)|remote end hung up|early eof|econnreset|etimedout|eai_again|http\/2 stream.*not closed cleanly|requested url returned error: (?:408|429|5\d\d)|empty reply from server)/iu;

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
    return { failure: new DeployFailure(TRANSIENT_REASON, failureDetail(result)) };
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
