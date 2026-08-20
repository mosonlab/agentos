/**
 * The live half of the transport-boundary regression (review S-1 / MF-1).
 *
 * `local-origin.test.ts` drives the guard as a pure function with the network
 * stubbed out. That is the right test for the policy, and it is not enough for
 * this defect: the bug was not in the policy but in the seam between the guard's
 * path predicate and Vite's proxy context match, and a seam is only observable
 * with both sides really running.
 *
 * So this file starts the real `apps/web/vite.config.ts` on a loopback port with
 * a recording control plane behind it, and asserts the two things a unit test
 * cannot: the foreign-origin request is answered 403, and the upstream recorded
 * nothing — no route, and no `Authorization: Bearer …`.
 *
 * Before the fix, `/api../tasks` here returns 200 and the upstream records
 * `{ target: "/tasks", auth: "Bearer <operator token>" }`, which is exactly what
 * the reviewer observed against a dev server at b0db900.
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

type Recorded = { target: string; method: string; auth: string | undefined; origin: string | undefined };

const upstreamCalls: Recorded[] = [];
let upstream: Server;
let vite: ViteDevServer;
let webOrigin = "";

/** The control plane, replaced by a recorder. It answers everything 200, so a
 *  request that reaches it is unmistakable in the assertions below. */
const startUpstream = async (): Promise<number> => {
  upstream = createHttpServer((request, response) => {
    upstreamCalls.push({
      target: request.url ?? "",
      method: request.method ?? "",
      auth: request.headers.authorization,
      origin: Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin,
    });
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ reached: "control-plane" }));
  });
  await new Promise<void>((resolve) => { upstream.listen(0, "127.0.0.1", resolve); });
  return (upstream.address() as AddressInfo).port;
};

before(async () => {
  const upstreamPort = await startUpstream();
  // Set on the process rather than in a file: Vite's `loadEnv` lets process.env
  // win over `.env`, so this run cannot pick up the operator's real destination
  // or their real token even on a machine that has both.
  process.env["WEB_API_URL"] = `http://127.0.0.1:${upstreamPort}`;
  process.env["OPERATOR_TOKEN"] = "test-operator-token-not-a-real-one";
  vite = await createViteServer({
    configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("../../", import.meta.url)),
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1" },
    // Nothing here asks for a module, so the dependency scanner would only cost
    // seconds and leave work in flight at `close()`. The transport boundary is
    // what is under test; the bundler is not.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await vite.listen();
  const port = (vite.httpServer?.address() as AddressInfo).port;
  webOrigin = `http://127.0.0.1:${port}`;
});

after(async () => {
  await vite?.close();
  await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
});

/** `fetch` does not normalise `/api../tasks` — `api..` is not a dot-segment, so
 *  the WHATWG parser leaves it alone, which is precisely why a browser can send
 *  it and why the proxy saw it verbatim. */
const request = async (path: string, method = "GET"): Promise<Response> =>
  fetch(`${webOrigin}${path}`, { method, headers: { Origin: "http://evil.example" } });

const payloads = [
  "/api../tasks",        // the reviewer's original
  "/api..%2ftasks",
  "/api%2e%2e/tasks",
  "/api%2ftasks",
  "/apix",
  "/api/tasks",          // the shape that was already refused, as the control
];

for (const payload of payloads) {
  for (const method of ["GET", "POST"]) {
    test(`${method} ${payload} from a foreign Origin is refused before the token is attached`, async () => {
      const seen = upstreamCalls.length;
      const response = await request(payload, method);
      assert.equal(response.status, 403, `${method} ${payload} was not refused`);
      const body = await response.text();
      assert.doesNotMatch(body, /Bearer|OPERATOR_TOKEN|test-operator-token/u);
      assert.equal(
        upstreamCalls.length,
        seen,
        `${method} ${payload} reached the control plane as ${JSON.stringify(upstreamCalls.at(-1))}`,
      );
    });
  }
}

test("a same-origin request still reaches the control plane with the token", async () => {
  const seen = upstreamCalls.length;
  const response = await fetch(`${webOrigin}/api/tasks`, { headers: { Origin: webOrigin } });
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, seen + 1);
  const call = upstreamCalls.at(-1);
  assert.equal(call?.target, "/tasks");
  assert.equal(call?.auth, "Bearer test-operator-token-not-a-real-one");
});

test("the guard admits a request with no Origin, which is the local curl case", async () => {
  const seen = upstreamCalls.length;
  const response = await fetch(`${webOrigin}/api/tasks`);
  assert.equal(response.status, 200);
  assert.equal(upstreamCalls.length, seen + 1);
});
