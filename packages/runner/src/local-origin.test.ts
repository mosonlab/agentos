import assert from "node:assert/strict";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadRunnerConfig, DEFAULT_API_URL } from "./config.js";
import {
  LocalApiDestinationError,
  parseLocalApiDestination,
  requireLocalApiDestination,
  type LocalApiDestinationRefusal,
} from "./local-origin.js";

type OriginCases = {
  reasonPrecedence: string[];
  accepted: Array<{ description: string; value: string; port: number }>;
  rejected: Array<{ description: string; value: string | null; reason: LocalApiDestinationRefusal }>;
};

/** The one table. `apps/web` drives its own parser with the same file; that is
 *  the whole point of reading it from disk instead of restating the cases. */
const casesPath = fileURLToPath(new URL("../../../scripts/fixtures/local-api-origin-cases.json", import.meta.url));
const cases = JSON.parse(readFileSync(casesPath, "utf8")) as OriginCases;

/** Every observable way this process could reach the network, replaced by a
 *  recorder. `parseLocalApiDestination` is pure, so the count must stay 0 — and
 *  the recorder is installed for the whole file, so it also covers the
 *  `loadRunnerConfig` cases below, where the point is that a refusal happens
 *  before the runner builds a client. */
const attempts: string[] = [];
const spy = <T extends object, K extends keyof T>(target: T, key: K, label: string): void => {
  const original = target[key];
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      attempts.push(`${label}:${String(args[0])}`);
      throw new Error(`network I/O attempted during destination validation: ${label}`);
    },
  });
  // Keep the original reachable so a later, deliberate restore is possible; no
  // test in this file wants one.
  void original;
};

spy(dns, "lookup", "dns.lookup");
spy(dns.promises, "lookup", "dns.promises.lookup");
spy(dns, "resolve", "dns.resolve");
spy(http, "request", "http.request");
spy(https, "request", "https.request");
spy(net, "connect", "net.connect");
spy(net.Socket.prototype, "connect", "socket.connect");
spy(globalThis as { fetch: typeof fetch }, "fetch", "fetch");

const withApiUrl = (value: string | undefined, body: () => void): void => {
  const previous = process.env.RUNNER_API_URL;
  if (value === undefined) delete process.env.RUNNER_API_URL;
  else process.env.RUNNER_API_URL = value;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.RUNNER_API_URL;
    else process.env.RUNNER_API_URL = previous;
  }
};

test("the shared table is the policy: every accepted case parses to its exact origin and port", () => {
  assert.ok(cases.accepted.length > 0, "the shared table lists no accepted destination");
  for (const accepted of cases.accepted) {
    const parsed = parseLocalApiDestination(accepted.value);
    assert.ok(parsed.accepted, `${accepted.description}: ${accepted.value} was refused`);
    assert.equal(parsed.port, accepted.port, accepted.description);
    assert.equal(parsed.origin, accepted.value.trim(), accepted.description);
  }
});

test("the shared table is the policy: every rejected case is refused with its exact reason", () => {
  assert.ok(cases.rejected.length > 0, "the shared table lists no rejected destination");
  for (const rejected of cases.rejected) {
    const parsed = parseLocalApiDestination(rejected.value);
    assert.equal(parsed.accepted, false, `${rejected.description}: ${String(rejected.value)} was accepted`);
    if (parsed.accepted) continue;
    assert.equal(parsed.reason, rejected.reason, rejected.description);
  }
});

test("every reason the table uses is declared in the shared precedence list", () => {
  const declared = new Set(cases.reasonPrecedence);
  for (const rejected of cases.rejected) assert.ok(declared.has(rejected.reason), `undeclared reason ${rejected.reason}`);
});

test("the table covers each refusal class the Developer Preview policy names", () => {
  const covered = new Set(cases.rejected.map((rejected) => rejected.reason));
  for (const reason of cases.reasonPrecedence) {
    assert.ok(covered.has(reason as LocalApiDestinationRefusal), `no case exercises ${reason}`);
  }
});

test("validating every case in the table performs no network I/O of any kind", () => {
  for (const accepted of cases.accepted) parseLocalApiDestination(accepted.value);
  for (const rejected of cases.rejected) parseLocalApiDestination(rejected.value);
  assert.deepEqual(attempts, []);
});

test("an absent variable falls back to the validated loopback default; an empty one is refused", () => {
  assert.equal(requireLocalApiDestination("RUNNER_API_URL", undefined, DEFAULT_API_URL), DEFAULT_API_URL);
  assert.throws(
    () => requireLocalApiDestination("RUNNER_API_URL", "", DEFAULT_API_URL),
    (error: unknown) => error instanceof LocalApiDestinationError && error.reason === "destination-empty",
  );
});

test("the shipped default is itself an accepted destination", () => {
  const parsed = parseLocalApiDestination(DEFAULT_API_URL);
  assert.ok(parsed.accepted);
  assert.equal(parsed.origin, "http://127.0.0.1:3000");
});

test("the refusal names the variable and the reason, and never echoes the value", () => {
  const secretBearing = "http://operator:s3cr3t-token-value@10.0.0.9:3000";
  const error = new LocalApiDestinationError("RUNNER_API_URL", "userinfo-present");
  assert.match(error.message, /RUNNER_API_URL/u);
  assert.match(error.message, /userinfo-present/u);
  assert.doesNotMatch(error.message, /s3cr3t-token-value/u);
  assert.doesNotMatch(error.message, /10\.0\.0\.9/u);
  // And the thrown error from the real path behaves the same way.
  withApiUrl(secretBearing, () => {
    assert.throws(loadRunnerConfig, (thrown: unknown) => {
      assert.ok(thrown instanceof LocalApiDestinationError);
      assert.doesNotMatch(thrown.message, /s3cr3t-token-value/u);
      assert.doesNotMatch(thrown.message, /10\.0\.0\.9/u);
      return true;
    });
  });
});

test("loadRunnerConfig refuses every rejected destination before it builds anything", () => {
  for (const rejected of cases.rejected) {
    if (rejected.value === null) continue;
    withApiUrl(rejected.value, () => {
      assert.throws(
        loadRunnerConfig,
        (error: unknown) => error instanceof LocalApiDestinationError && error.reason === rejected.reason,
        `${rejected.description}: ${rejected.value} did not refuse with ${rejected.reason}`,
      );
    });
  }
  // The runner's index.ts turns this config into a client, a preflight and a
  // poll loop. Nothing reached the network while every one of those refusals
  // was produced.
  assert.deepEqual(attempts, []);
});

test("loadRunnerConfig accepts the exact loopback destination and keeps it verbatim", () => {
  withApiUrl("http://127.0.0.1:3100", () => {
    assert.equal(loadRunnerConfig().apiUrl, "http://127.0.0.1:3100");
  });
  withApiUrl(undefined, () => {
    assert.equal(loadRunnerConfig().apiUrl, DEFAULT_API_URL);
  });
  assert.deepEqual(attempts, []);
});
