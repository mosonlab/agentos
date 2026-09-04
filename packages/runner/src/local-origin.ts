/**
 * The Developer Preview destination policy for `RUNNER_API_URL`.
 *
 * The runner carries a bearer token on every control-plane call, so where that
 * call goes is a credential question, not a convenience one. This module answers
 * it with pure string work: no DNS, no socket, no client, nothing that could
 * leak the token to whatever a mistyped or hostile destination resolves to. The
 * caller (`loadRunnerConfig`) runs it before it builds anything.
 *
 * The accepted form is one anchored regex — the exact numeric IPv4 loopback HTTP
 * origin. Reason codes exist only to say why a value was refused, and the
 * classification order is fixed so one value always yields one reason.
 *
 * `apps/web/src/lib/local-origin.ts` and the runner-only deployment target hold
 * the other implementations. They cannot all share a runtime module (different
 * workspaces and toolchains), so `scripts/fixtures/local-api-origin-cases.json`
 * is the shared table their suites drive, and drift shows up as a failing test.
 */

/** The whole accept decision. Anything this does not match is refused. */
const ACCEPTED_DESTINATION = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u;

/** Structural decomposition, used only to explain a refusal. */
const DESTINATION_SHAPE =
  /^(?<scheme>[A-Za-z][A-Za-z0-9+.\-]*):\/\/(?<authority>[^/?#]*)(?<path>[^?#]*)(?<query>\?[^#]*)?(?<fragment>#.*)?$/u;

const HIGHEST_PORT = 65_535;

export type LocalApiDestinationRefusal =
  | "destination-empty"
  | "destination-unparsable"
  | "scheme-not-http"
  | "userinfo-present"
  | "host-not-numeric-loopback"
  | "port-missing"
  | "port-invalid"
  | "path-present"
  | "query-present"
  | "fragment-present";

export type LocalApiDestination =
  | { accepted: true; origin: string; port: number }
  | { accepted: false; reason: LocalApiDestinationRefusal };

/** Host and port as written, without normalising either. */
const splitAuthority = (authority: string): { host: string; port: string | null } => {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return { host: authority, port: null };
    const after = authority.slice(close + 1);
    return { host: authority.slice(0, close + 1), port: after.startsWith(":") ? after.slice(1) : null };
  }
  const separator = authority.lastIndexOf(":");
  if (separator === -1) return { host: authority, port: null };
  return { host: authority.slice(0, separator), port: authority.slice(separator + 1) };
};

const classify = (value: string): LocalApiDestinationRefusal => {
  const shape = DESTINATION_SHAPE.exec(value)?.groups;
  if (!shape) return "destination-unparsable";
  // Case-sensitive: `HTTP://` is not the accepted spelling, and saying so is
  // more useful than silently folding it.
  if (shape["scheme"] !== "http") return "scheme-not-http";
  const authority = shape["authority"] ?? "";
  if (authority.includes("@")) return "userinfo-present";
  const { host, port } = splitAuthority(authority);
  if (host !== "127.0.0.1") return "host-not-numeric-loopback";
  if (port === null || port === "") return "port-missing";
  if (!/^[1-9]\d{0,4}$/u.test(port) || Number(port) > HIGHEST_PORT) return "port-invalid";
  if ((shape["path"] ?? "") !== "") return "path-present";
  if (shape["query"] !== undefined) return "query-present";
  if (shape["fragment"] !== undefined) return "fragment-present";
  // Unreachable: a value that survives every check above is the accepted form,
  // which the caller already matched. Refusing is still the safe answer.
  return "destination-unparsable";
};

/**
 * Decide whether one configured destination is the supported loopback origin.
 * Pure: it performs no I/O and touches no ambient state.
 */
export const parseLocalApiDestination = (raw: string | undefined | null): LocalApiDestination => {
  // An .env reader already strips surrounding whitespace; indentation in a
  // hand-edited file is not a different policy.
  const value = (raw ?? "").trim();
  if (value === "") return { accepted: false, reason: "destination-empty" };
  const accepted = ACCEPTED_DESTINATION.exec(value);
  const port = accepted ? Number(accepted[1]) : 0;
  if (accepted && port <= HIGHEST_PORT) return { accepted: true, origin: value, port };
  return { accepted: false, reason: classify(value) };
};

/** Raised before any client exists, and it names the variable, never the value. */
export class LocalApiDestinationError extends Error {
  readonly variable: string;
  readonly reason: LocalApiDestinationRefusal;

  constructor(variable: string, reason: LocalApiDestinationRefusal) {
    super(
      `${variable} is not a supported Developer Preview destination (${reason}). `
      + "The only accepted form is http://127.0.0.1:<port> — no userinfo, path, query or fragment.",
    );
    this.name = "LocalApiDestinationError";
    this.variable = variable;
    this.reason = reason;
  }
}

/**
 * The destination the runner will actually talk to, or a refusal. `fallback` is
 * the shipped default and is itself validated, so the default can never be the
 * one value that skips the policy. Only an *absent* variable falls back: a
 * present but empty value is a configuration mistake and is refused, rather than
 * quietly becoming a different destination than the file says.
 */
export const requireLocalApiDestination = (
  variable: string,
  raw: string | undefined,
  fallback: string,
): string => {
  const parsed = parseLocalApiDestination(raw === undefined ? fallback : raw);
  if (!parsed.accepted) throw new LocalApiDestinationError(variable, parsed.reason);
  return parsed.origin;
};
