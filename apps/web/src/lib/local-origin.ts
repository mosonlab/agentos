/**
 * The Developer Preview transport policy for the web dev/preview server.
 *
 * This module runs in the Vite config process, not in the browser. That process
 * is the only one that holds `OPERATOR_TOKEN`, and it attaches it to everything
 * it proxies — so two questions have to be answered before a proxy exists at
 * all: where may it send the token (`WEB_API_URL`), and whose requests may make
 * it send one (the Origin/Host guard). Both answers are pure functions here, so
 * both are testable without a server, and neither performs I/O.
 *
 * `packages/runner/src/local-origin.ts` holds the second implementation of the
 * destination half, for `RUNNER_API_URL`. The two workspaces cannot import each
 * other, so `scripts/fixtures/local-api-origin-cases.json` is the shared table
 * both suites drive; drift is a failing test, not two policies.
 */

/** The whole accept decision for a destination. */
const ACCEPTED_DESTINATION = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u;

/** Structural decomposition, used only to explain a refusal. */
const DESTINATION_SHAPE =
  /^(?<scheme>[A-Za-z][A-Za-z0-9+.\-]*):\/\/(?<authority>[^/?#]*)(?<path>[^?#]*)(?<query>\?[^#]*)?(?<fragment>#.*)?$/u;

const HIGHEST_PORT = 65_535;

/** Vite's dev port; `packages/api/src/local-origin.ts` allows the same origin. */
export const WEB_DEV_PORT = 5173;

/** Vite's preview port. */
export const WEB_PREVIEW_PORT = 4173;

/** The address both servers bind. Never `0.0.0.0`, and never a name. */
export const LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_API_PORT = "3000";

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
  if (shape["scheme"] !== "http") return "scheme-not-http";
  const authority = shape["authority"] ?? "";
  if (authority.includes("@")) return "userinfo-present";
  const { host, port } = splitAuthority(authority);
  if (host !== LOOPBACK_HOST) return "host-not-numeric-loopback";
  if (port === null || port === "") return "port-missing";
  if (!/^[1-9]\d{0,4}$/u.test(port) || Number(port) > HIGHEST_PORT) return "port-invalid";
  if ((shape["path"] ?? "") !== "") return "path-present";
  if (shape["query"] !== undefined) return "query-present";
  if (shape["fragment"] !== undefined) return "fragment-present";
  return "destination-unparsable";
};

/** Pure: no DNS, no socket, no client. */
export const parseLocalApiDestination = (raw: string | undefined | null): LocalApiDestination => {
  const value = (raw ?? "").trim();
  if (value === "") return { accepted: false, reason: "destination-empty" };
  const accepted = ACCEPTED_DESTINATION.exec(value);
  const port = accepted ? Number(accepted[1]) : 0;
  if (accepted && port <= HIGHEST_PORT) return { accepted: true, origin: value, port };
  return { accepted: false, reason: classify(value) };
};

/** Thrown before a proxy exists. Names the variable and the reason, never the
 *  value: this message reaches a terminal, and a mistyped destination is often
 *  mistyped precisely because it was pasted from somewhere with a credential. */
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
 * Where this dev/preview server may proxy to. `WEB_API_URL` wins; otherwise the
 * destination is composed from `API_PORT`, and the composed value is validated
 * by the same rule, so the default cannot be the one path that skips the policy.
 */
export const resolveProxyTarget = (environment: Record<string, string | undefined>): string => {
  const configured = environment["WEB_API_URL"];
  // Only an *absent* variable composes a default. A present but empty one is a
  // configuration mistake and is refused, exactly as the runner refuses an empty
  // RUNNER_API_URL, rather than quietly proxying somewhere the file does not say.
  const raw = configured === undefined
    ? `http://${LOOPBACK_HOST}:${(environment["API_PORT"] ?? DEFAULT_API_PORT).trim()}`
    : configured;
  const parsed = parseLocalApiDestination(raw);
  if (!parsed.accepted) {
    throw new LocalApiDestinationError(configured === undefined ? "API_PORT" : "WEB_API_URL", parsed.reason);
  }
  return parsed.origin;
};

/** The origins this server serves. Exactly these may make it attach the token. */
export const serverOrigins = (port: number): string[] => [`http://${LOOPBACK_HOST}:${port}`];

export type ProxyRequestRefusal = "host-missing" | "host-not-server-origin" | "origin-not-allowed";

export type ProxyRequestVerdict = { allowed: true } | { allowed: false; reason: ProxyRequestRefusal };

const hostOf = (origin: string): string => origin.slice("http://".length);

/**
 * Whether one request may be proxied to the control plane with the operator
 * token attached.
 *
 * `Host` must be an origin this server actually serves, which is what stops DNS
 * rebinding: a name that resolves to 127.0.0.1 arrives with that name in `Host`.
 * `Origin`, when the browser sends one, must be exactly one of those origins.
 * An absent `Origin` is admitted: that is a same-origin navigation or a local
 * `curl`, and a cross-origin browser request always carries one.
 */
export const evaluateProxyRequest = (request: {
  origin?: string | undefined;
  host?: string | undefined;
  allowedOrigins: readonly string[];
}): ProxyRequestVerdict => {
  const host = request.host?.trim();
  if (host === undefined || host === "") return { allowed: false, reason: "host-missing" };
  const allowedHosts = request.allowedOrigins.map(hostOf);
  if (!allowedHosts.includes(host)) return { allowed: false, reason: "host-not-server-origin" };
  const origin = request.origin?.trim();
  if (origin === undefined || origin === "") return { allowed: true };
  if (!request.allowedOrigins.includes(origin)) return { allowed: false, reason: "origin-not-allowed" };
  return { allowed: true };
};

/** The refusal body. It names the policy and no value. */
export const proxyRefusalBody = (reason: ProxyRequestRefusal, allowedOrigins: readonly string[]): string =>
  JSON.stringify({
    error: "Forbidden by the local transport boundary",
    reason,
    open: allowedOrigins[0] ?? `http://${LOOPBACK_HOST}:${WEB_DEV_PORT}`,
  });

type GuardRequest = { url?: string | undefined; headers: Record<string, string | string[] | undefined> };
type GuardResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

const headerValue = (headers: GuardRequest["headers"], name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Whether Vite's proxy would route this raw `req.url` to this proxy context.
 *
 * This is `doesProxyContextMatchUrl` from Vite's own proxy middleware, restated:
 * a context beginning with `^` is a regular expression, anything else is a bare
 * prefix test on the unnormalised URL. The guard has to answer this question the
 * same way the proxy does, because the two are asked about the same request a
 * few middlewares apart — any URL the proxy matches and the guard does not is a
 * request that leaves this process with the operator token attached and was
 * never shown to the Origin policy.
 *
 * That gap was real: the guard used to accept only `/api`, `/api/…` and `/api?…`,
 * so `/api../tasks` — not a dot-segment, therefore sent verbatim by a browser —
 * was proxied unexamined and the config's `rewrite` turned it back into the real
 * route `/tasks`. Anything starting with the four characters `/api` is the
 * proxy's business, so it is the guard's business too.
 */
export const matchesProxyContext = (context: string, url: string): boolean =>
  // Flagless, like Vite's own `new RegExp(context)`. A `u` here would refuse
  // patterns Vite accepts, which would reopen the gap from the other side.
  (context.startsWith("^") && new RegExp(context).test(url)) || url.startsWith(context);

/**
 * Connect middleware for the dev and preview servers. It is installed inside
 * `configureServer`/`configurePreviewServer` *before* Vite's internal
 * middlewares, so it runs before the proxy — and therefore before the
 * `Authorization` header is attached and before any request leaves this process.
 *
 * `guardedContexts` are the proxy keys this server registered. `vite.config.ts`
 * passes `Object.keys(proxy)` rather than a literal, so a second proxy entry is
 * guarded by the act of registering it.
 */
export const createProxyGuard = (
  resolveAllowedOrigins: () => readonly string[],
  guardedContexts: readonly string[] = ["/api"],
) =>
  (request: GuardRequest, response: GuardResponse, next: () => void): void => {
    const path = request.url ?? "";
    if (!guardedContexts.some((context) => matchesProxyContext(context, path))) {
      next();
      return;
    }
    const allowedOrigins = resolveAllowedOrigins();
    const verdict = evaluateProxyRequest({
      origin: headerValue(request.headers, "origin"),
      host: headerValue(request.headers, "host"),
      allowedOrigins,
    });
    if (verdict.allowed) {
      next();
      return;
    }
    response.statusCode = 403;
    response.setHeader("Content-Type", "application/json");
    response.end(proxyRefusalBody(verdict.reason, allowedOrigins));
  };
