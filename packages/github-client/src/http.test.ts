import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_RESPONSE } from "./classify.js";
import { callWithTimeout, type Http, type HttpTrace } from "./http.js";

const request = { url: "https://api.github.test/x", method: "PUT" as const, headers: { Accept: "application/json" }, body: "{}" };

test("a transport failure becomes a recorded absence of a response, not an exception", async () => {
  const http: Http = async () => { throw new Error("unexpected EOF"); };
  const attempt = await callWithTimeout(http, request, 1_000);
  assert.deepEqual(attempt, { status: NO_RESPONSE, body: "unexpected EOF" });
});

test("a request that never answers is aborted at its deadline and reported the same way", async () => {
  const http: Http = ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { reject(new Error("AbortError: aborted")); });
  });
  const attempt = await callWithTimeout(http, request, 5);
  assert.equal(attempt.status, NO_RESPONSE);
  assert.match(attempt.body, /abort/i);
});

test("the timer is cleared on the success path, so a caller is never held open by it", async () => {
  const http: Http = async () => ({ status: 200, body: "{}" });
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  assert.deepEqual(await callWithTimeout(http, request, 60_000), { status: 200, body: "{}" });
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, before);
});

test("the trace records what was sent, before it is sent", async () => {
  const trace: HttpTrace = [];
  const http: Http = async () => {
    // Recorded first, so a request that dies mid-flight is still accounted for.
    assert.equal(trace.length, 1);
    return { status: 200, body: "" };
  };
  await callWithTimeout(http, request, 1_000, trace);
  assert.deepEqual(trace, [{ method: "PUT", url: request.url, body: "{}" }]);

  const bodyless: HttpTrace = [];
  await callWithTimeout(http, { url: request.url, method: "GET", headers: {} }, 1_000, bodyless);
  assert.deepEqual(bodyless, [{ method: "GET", url: request.url }]);
});
