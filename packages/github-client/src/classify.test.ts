import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyHttpStatus, isDeterministicRefusal, isLostResponse, NO_RESPONSE } from "./classify.js";

test("the errors that actually ended AgentOS GitHub writes are classified as lost", () => {
  // Every string here was produced by a real failed write against
  // github.com from this network, or by our own per-command timeout.
  for (const message of [
    "Post \"https://api.github.com/graphql\": unexpected EOF",
    "LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
    "read ECONNRESET",
    "socket hang up",
    "connection reset by peer",
    "request to https://api.github.com/repos/o/n/pulls/1/merge failed, reason: ETIMEDOUT",
    "gh pr create timed out after 20000ms",
    "HTTP 502 Bad Gateway",
    "HTTP 503 Service Unavailable",
    "status code 504",
    "AbortError: This operation was aborted",
    "getaddrinfo EAI_AGAIN api.github.com",
  ]) {
    assert.equal(isLostResponse(message), true, message);
    assert.equal(isDeterministicRefusal(message), false, message);
  }
});

test("a credential failure is deterministic however transient its wording sounds", () => {
  for (const message of [
    "remote: HTTP 403 Forbidden: permission denied",
    "Bad credentials",
    "fatal: Authentication failed for 'https://github.com/acme/app.git/'",
    "could not read Username for 'https://github.com'",
    "HTTP 401 Unauthorized",
    "Resource not accessible by integration",
  ]) {
    assert.equal(isDeterministicRefusal(message), true, message);
    // The direction that matters: a refusal must never be read as "may have landed".
    assert.equal(isLostResponse(message), false, message);
  }
});

test("a refusal delivered over a dying link is still a refusal", () => {
  // The deterministic patterns are checked first for exactly this case.
  const message = "remote: permission denied; connection reset by peer";
  assert.equal(isDeterministicRefusal(message), true);
  assert.equal(isLostResponse(message), false);
});

test("an ordinary failure is neither lost nor a refusal, and the caller decides", () => {
  for (const message of [
    "Author identity unknown",
    "the branch has no commits",
    "GraphQL: Field 'foo' doesn't exist",
  ]) {
    assert.equal(isLostResponse(message), false, message);
    assert.equal(isDeterministicRefusal(message), false, message);
  }
});

test("an Error is classified by its name as well as its message", () => {
  const timeout = new Error("gh took too long");
  timeout.name = "AbortError";
  assert.equal(isLostResponse(timeout), true);
});

test("only a 2xx says the write happened", () => {
  for (const status of [200, 201, 202, 204]) assert.equal(classifyHttpStatus(status), "applied", String(status));
  for (const status of [400, 401, 403, 404, 405, 409, 410, 422]) {
    assert.equal(classifyHttpStatus(status), "refused", String(status));
  }
  // Not an answer to a write, so it is read back rather than assumed.
  for (const status of [NO_RESPONSE, 0, 301, 302, 408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifyHttpStatus(status), "lost", String(status));
  }
});
