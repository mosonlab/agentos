import assert from "node:assert/strict";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LOOPBACK_HOST,
  LocalApiDestinationError,
  WEB_DEV_PORT,
  WEB_PREVIEW_PORT,
  createProxyGuard,
  evaluateProxyRequest,
  matchesProxyContext,
  parseLocalApiDestination,
  resolveProxyTarget,
  serverOrigins,
  type LocalApiDestinationRefusal,
} from "../lib/local-origin.js";

type OriginCases = {
  reasonPrecedence: string[];
  accepted: Array<{ description: string; value: string; port: number }>;
  rejected: Array<{ description: string; value: string | null; reason: LocalApiDestinationRefusal }>;
};

/** The same table `packages/runner` drives. Two implementations, one policy. */
const casesPath = fileURLToPath(new URL("../../../../scripts/fixtures/local-api-origin-cases.json", import.meta.url));
const cases = JSON.parse(readFileSync(casesPath, "utf8")) as OriginCases;

/** Every route to the network in this process, replaced by a recorder. The
 *  destination policy and the request guard are pure, and "pure" is the whole
 *  claim: validation finishes before a proxy, a bearer header, a DNS lookup or a
 *  socket exists. */
const attempts: string[] = [];
const spy = <T extends object, K extends keyof T>(target: T, key: K, label: string): void => {
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      attempts.push(`${label}:${String(args[0])}`);
      throw new Error(`network I/O attempted during transport validation: ${label}`);
    },
  });
};

spy(dns, "lookup", "dns.lookup");
spy(dns.promises, "lookup", "dns.promises.lookup");
spy(dns, "resolve", "dns.resolve");
spy(http, "request", "http.request");
spy(https, "request", "https.request");
spy(net, "connect", "net.connect");
spy(net.Socket.prototype, "connect", "socket.connect");
spy(globalThis as { fetch: typeof fetch }, "fetch", "fetch");

test("the shared table is the policy: accepted destinations parse to their exact origin", () => {
  assert.ok(cases.accepted.length > 0);
  for (const accepted of cases.accepted) {
    const parsed = parseLocalApiDestination(accepted.value);
    assert.ok(parsed.accepted, `${accepted.description}: ${accepted.value} was refused`);
    assert.equal(parsed.port, accepted.port, accepted.description);
    assert.equal(parsed.origin, accepted.value.trim(), accepted.description);
  }
});

test("the shared table is the policy: rejected destinations are refused with their exact reason", () => {
  assert.ok(cases.rejected.length > 0);
  for (const rejected of cases.rejected) {
    const parsed = parseLocalApiDestination(rejected.value);
    assert.equal(parsed.accepted, false, `${rejected.description}: ${String(rejected.value)} was accepted`);
    if (parsed.accepted) continue;
    assert.equal(parsed.reason, rejected.reason, rejected.description);
  }
});

test("resolving the proxy target refuses every rejected destination before a proxy exists", () => {
  for (const rejected of cases.rejected) {
    if (rejected.value === null) continue;
    assert.throws(
      () => resolveProxyTarget({ WEB_API_URL: rejected.value ?? undefined }),
      (error: unknown) =>
        error instanceof LocalApiDestinationError
        && error.reason === rejected.reason
        && error.variable === "WEB_API_URL",
      `${rejected.description}: ${rejected.value} was accepted as a proxy target`,
    );
  }
  assert.deepEqual(attempts, [], "validation performed network I/O");
});

test("the default target is composed from API_PORT and validated by the same rule", () => {
  assert.equal(resolveProxyTarget({}), "http://127.0.0.1:3000");
  assert.equal(resolveProxyTarget({ API_PORT: "3100" }), "http://127.0.0.1:3100");
  assert.equal(resolveProxyTarget({ WEB_API_URL: "http://127.0.0.1:4000" }), "http://127.0.0.1:4000");
  // A composed default is not a way around the policy.
  assert.throws(
    () => resolveProxyTarget({ API_PORT: "0" }),
    (error: unknown) => error instanceof LocalApiDestinationError && error.variable === "API_PORT",
  );
});

test("a refused destination names the variable and the reason, and never the value", () => {
  const credentialBearing = "http://operator:s3cr3t-token-value@203.0.113.9:3000";
  assert.throws(
    () => resolveProxyTarget({ WEB_API_URL: credentialBearing }),
    (error: unknown) => {
      assert.ok(error instanceof LocalApiDestinationError);
      assert.doesNotMatch(error.message, /s3cr3t-token-value/u);
      assert.doesNotMatch(error.message, /203\.0\.113\.9/u);
      return true;
    },
  );
});

const devOrigins = serverOrigins(WEB_DEV_PORT);

test("the guard admits this server's own origin and a request with no Origin", () => {
  assert.deepEqual(
    evaluateProxyRequest({ origin: "http://127.0.0.1:5173", host: "127.0.0.1:5173", allowedOrigins: devOrigins }),
    { allowed: true },
  );
  // A local `curl` or a same-origin navigation sends no Origin at all.
  assert.deepEqual(evaluateProxyRequest({ host: "127.0.0.1:5173", allowedOrigins: devOrigins }), { allowed: true });
  // Preview is the same policy on its own port.
  assert.deepEqual(
    evaluateProxyRequest({
      origin: `http://127.0.0.1:${WEB_PREVIEW_PORT}`,
      host: `127.0.0.1:${WEB_PREVIEW_PORT}`,
      allowedOrigins: serverOrigins(WEB_PREVIEW_PORT),
    }),
    { allowed: true },
  );
});

test("the guard refuses every other Origin, including the localhost spelling", () => {
  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:5174",
    "http://127.0.0.2:5173",
    "http://[::1]:5173",
    "https://127.0.0.1:5173",
    "http://127.0.0.1:5173.evil.example",
    "http://evil.example",
    "null",
  ]) {
    assert.deepEqual(
      evaluateProxyRequest({ origin, host: "127.0.0.1:5173", allowedOrigins: devOrigins }),
      { allowed: false, reason: "origin-not-allowed" },
      `${origin} was admitted`,
    );
  }
});

test("the guard refuses a Host this server does not serve, which is what stops DNS rebinding", () => {
  // A name that resolves to 127.0.0.1 still arrives with that name in Host.
  for (const host of ["evil.example", "localhost:5173", "127.0.0.1:5174", "127.0.0.1", "[::1]:5173"]) {
    assert.deepEqual(
      evaluateProxyRequest({ host, allowedOrigins: devOrigins }),
      { allowed: false, reason: "host-not-server-origin" },
      `${host} was admitted`,
    );
  }
  assert.deepEqual(evaluateProxyRequest({ allowedOrigins: devOrigins }), { allowed: false, reason: "host-missing" });
  assert.deepEqual(evaluateProxyRequest({ host: "   ", allowedOrigins: devOrigins }), { allowed: false, reason: "host-missing" });
});

type Recorded = { statusCode: number; headers: Record<string, string>; body: string | undefined; passed: boolean };

const driveGuard = (headers: Record<string, string | undefined>, url = "/api/projects"): Recorded => {
  const recorded: Recorded = { statusCode: 200, headers: {}, body: undefined, passed: false };
  const guard = createProxyGuard(() => devOrigins);
  guard(
    { url, headers },
    {
      get statusCode() { return recorded.statusCode; },
      set statusCode(value: number) { recorded.statusCode = value; },
      setHeader: (name: string, value: string) => { recorded.headers[name] = value; },
      end: (body?: string) => { recorded.body = body; },
    },
    () => { recorded.passed = true; },
  );
  return recorded;
};

test("a refused request is answered 403 and never reaches the proxy", () => {
  const refused = driveGuard({ host: "127.0.0.1:5173", origin: "http://evil.example" });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.passed, false, "a refused request was handed to the next middleware");
  const body = JSON.parse(String(refused.body)) as { reason: string; open: string };
  assert.equal(body.reason, "origin-not-allowed");
  assert.equal(body.open, "http://127.0.0.1:5173");
  // Nothing about the refusal reached the network, and no token was mentioned.
  assert.doesNotMatch(String(refused.body), /Bearer|OPERATOR_TOKEN/u);
  assert.deepEqual(attempts, []);

  const rebinding = driveGuard({ host: "agentos.local" });
  assert.equal(rebinding.statusCode, 403);
  assert.equal(rebinding.passed, false);
});

test("an admitted request is passed on untouched, and paths Vite would not proxy are not guarded", () => {
  const admitted = driveGuard({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" });
  assert.equal(admitted.passed, true);
  assert.equal(admitted.body, undefined);
  // The page itself, its assets and the HMR socket are not this guard's business.
  // None of these begins with the proxy context, so Vite never forwards them.
  for (const url of ["/", "/index.html", "/@vite/client", "/ap", "/apf", "/tasks", "/API/tasks", "//api/tasks"]) {
    assert.equal(driveGuard({ host: "evil.example" }, url).passed, true, `${url} was guarded`);
  }
});

/**
 * S-1: the guard used to test three path shapes while Vite's proxy tested a bare
 * prefix, so `/api../tasks` was forwarded — with the operator bearer token —
 * without the Origin policy ever being consulted, and `rewrite` turned it back
 * into the real control-plane route `/tasks`. The reviewer's original payload is
 * first in this table; the rest are the same gap spelled other ways.
 *
 * The expectation is not a hand-written list of verdicts. It is `url.startsWith`
 * against the context, which is Vite's rule — so this test fails if the guard is
 * ever narrower than the proxy again, whatever shape the next gap takes.
 */
test("every URL Vite's proxy would forward is guarded, including /api../tasks", () => {
  const forwarded = [
    "/api../tasks",        // the reviewer's payload: not a dot-segment, so sent verbatim
    "/api..%2ftasks",
    "/api%2e%2e/tasks",
    "/api%2e%2e%2ftasks",
    "/api%2ftasks",
    "/api%2Ftasks",
    "/api..;/tasks",
    "/api.../tasks",
    "/api\\tasks",
    "/apix",
    "/apis-elsewhere",
    "/api;jsessionid=1/tasks",
    "/api#not-a-fragment",
    "/api",
    "/api/",
    "/api/projects",
    "/api?query=1",
  ];
  for (const url of forwarded) {
    // Vite's own predicate, restated here so the assertion does not lean on the
    // module under test for its expectation.
    assert.equal(url.startsWith("/api"), true, `${url} is not in the proxy's context`);
    const refused = driveGuard({ host: "evil.example", origin: "http://evil.example" }, url);
    assert.equal(refused.passed, false, `${url} reached the proxy`);
    assert.equal(refused.statusCode, 403, `${url} was not refused`);
    assert.doesNotMatch(String(refused.body), /Bearer|OPERATOR_TOKEN/u);
  }
  // And nothing left this process while deciding any of it.
  assert.deepEqual(attempts, []);
});

test("the guard's path predicate is Vite's doesProxyContextMatchUrl, including the ^regex form", () => {
  // A bare context is a prefix test on the unnormalised URL.
  assert.equal(matchesProxyContext("/api", "/api../tasks"), true);
  assert.equal(matchesProxyContext("/api", "/apix"), true);
  assert.equal(matchesProxyContext("/api", "/ap"), false);
  assert.equal(matchesProxyContext("/api", "/API"), false);
  // A context beginning with `^` is a RegExp — Vite tests it unanchored-at-the-end
  // and with no flags, and so does this.
  assert.equal(matchesProxyContext("^/socket", "/socket/io"), true);
  assert.equal(matchesProxyContext("^/socket", "/x/socket"), false);
  // Registering a second proxy entry guards it; nothing else changes.
  const guardTwo = createProxyGuard(() => devOrigins, ["/api", "/rpc"]);
  const record = (url: string): boolean => {
    let passed = false;
    guardTwo(
      { url, headers: { host: "127.0.0.1:5173", origin: "http://evil.example" } },
      { statusCode: 200, setHeader: () => {}, end: () => {} },
      () => { passed = true; },
    );
    return passed;
  };
  assert.equal(record("/rpc../tasks"), false);
  assert.equal(record("/api../tasks"), false);
  assert.equal(record("/other"), true);
});

test("the dev and preview servers bind the loopback literal and route through the guard", () => {
  const source = readFileSync(fileURLToPath(new URL("../../vite.config.ts", import.meta.url)), "utf8");
  // The policy lives in one module; the config consumes it rather than restating
  // it. Both halves are pinned, because either one missing is a silent hole.
  assert.match(source, /resolveProxyTarget\(environment\)/u);
  assert.match(source, /createProxyGuard\(/u);
  // Both guards are handed the proxy's own keys, so the set Vite matches and the
  // set the guard examines cannot drift apart (S-1).
  assert.equal(source.match(/\}, Object\.keys\(proxy\)\)/gu)?.length, 2, "a guard was installed without the proxy's own contexts");
  assert.match(source, /server:\s*\{\s*host:\s*LOOPBACK_HOST/u);
  assert.match(source, /preview:\s*\{\s*host:\s*LOOPBACK_HOST/u);
  assert.equal(LOOPBACK_HOST, "127.0.0.1");
  // The token is read from the server-side variable only; no VITE_* credential
  // exists for the bundler to inline.
  assert.match(source, /environment\["OPERATOR_TOKEN"\]/u);
  assert.doesNotMatch(source, /VITE_[A-Z_]*TOKEN/u);
  // No wildcard bind survives as a value (the prose above the binding may name it).
  assert.doesNotMatch(source, /"0\.0\.0\.0"/u);
  // And the destination is resolved before the proxy record is built, so a
  // refusal happens before any `Authorization` header exists.
  assert.ok(source.indexOf("resolveProxyTarget(environment)") < source.indexOf("Authorization"));
});

test("the guard is installed inside configureServer, ahead of Vite's own middlewares", async () => {
  // Returning a function from configureServer would install it *after* the proxy,
  // which is exactly the ordering bug this pins: a post hook would never see the
  // request the proxy already answered with the operator token attached.
  const { default: configure } = await import("../../vite.config.js");
  const resolved = typeof configure === "function"
    ? await configure({ command: "serve", mode: "development" })
    : configure;
  const plugins = (resolved as { plugins?: unknown[] }).plugins ?? [];
  const boundary = plugins.flat(Infinity).find(
    (plugin): plugin is { name: string; configureServer: (server: unknown) => unknown } =>
      typeof plugin === "object" && plugin !== null && (plugin as { name?: string }).name === "agentos-local-transport-boundary",
  );
  assert.ok(boundary, "the transport boundary plugin is not registered");

  const installed: Array<(...args: unknown[]) => void> = [];
  const returned = boundary.configureServer({
    httpServer: { address: () => ({ port: WEB_DEV_PORT }) },
    config: { server: { port: WEB_DEV_PORT } },
    middlewares: { use: (middleware: (...args: unknown[]) => void) => { installed.push(middleware); } },
  });
  assert.equal(returned, undefined, "configureServer returned a post hook, which runs after the proxy");
  assert.equal(installed.length, 1);

  // The installed middleware is the guard, and it refuses a foreign Origin.
  const recorded = { statusCode: 200, body: "" };
  installed[0]?.(
    { url: "/api/projects", headers: { host: "127.0.0.1:5173", origin: "http://evil.example" } },
    {
      set statusCode(value: number) { recorded.statusCode = value; },
      get statusCode() { return recorded.statusCode; },
      setHeader: () => {},
      end: (body?: string) => { recorded.body = body ?? ""; },
    },
    () => { assert.fail("a foreign Origin reached the proxy"); },
  );
  assert.equal(recorded.statusCode, 403);
  assert.deepEqual(attempts, []);
});

test("a production build does not read or embed the development proxy environment", async () => {
  const priorTarget = process.env.WEB_API_URL;
  const priorToken = process.env.OPERATOR_TOKEN;
  process.env.WEB_API_URL = "https://not-loopback.example";
  process.env.OPERATOR_TOKEN = "must-not-enter-build";
  try {
    const { default: configure } = await import("../../vite.config.js");
    const resolved = typeof configure === "function"
      ? await configure({ command: "build", mode: "production" })
      : configure;
    const config = resolved as {
      server?: { proxy?: Record<string, unknown> };
      preview?: { proxy?: Record<string, unknown> };
    };
    assert.deepEqual(config.server?.proxy, {});
    assert.deepEqual(config.preview?.proxy, {});
  } finally {
    if (priorTarget === undefined) delete process.env.WEB_API_URL;
    else process.env.WEB_API_URL = priorTarget;
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = priorToken;
  }
});
