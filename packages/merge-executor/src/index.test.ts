import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { test } from "node:test";

import type { MechanicalClaim } from "./agentos.js";
import type { ExecutorConfig } from "./config.js";
import { mintInstallationToken } from "./github-app-auth.js";
import { claimOnce, runClaim } from "./index.js";
import { makeLog, makeRedactor } from "./redaction.js";

const config: ExecutorConfig = {
  apiUrl: "https://agentos.test",
  executorToken: "executor-control-plane-token",
  runnerId: "merge-executor-1",
  leaseSeconds: 120,
  pollIntervalMs: 5_000,
  apiTimeoutMs: 1_000,
  githubRestUrl: "https://api.github.test",
  githubGraphqlUrl: "https://api.github.test/graphql",
  githubTimeoutMs: 1_000,
  githubAppAuthTimeoutMs: 1_000,
  githubAppId: "12345",
  githubAppInstallationId: "67890",
  mergeIdentityLogin: "agentos-merge[bot]",
  mergeabilityPollAttempts: 1,
  mergeabilityPollMs: 1,
  mergeabilityPollBudgetMs: 10,
};

const claimed = (id: string): MechanicalClaim => ({
  executionMode: "mechanical",
  task: { id: `task-${id}`, name: "merge", chainIndex: 7 },
  run: { id, runNumber: 1, maxRunsPerTask: 3 },
  session: { id: `session-${id}` },
  fencingToken: `fence-${id}`,
  sessionToken: `session-token-${id}`,
});

const log = makeLog(makeRedactor(), { log: () => {}, warn: () => {}, error: () => {} });

test("an idle claim poll never enters the run-scoped mint path", async () => {
  let runCalls = 0;
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 204 });
  const result = await claimOnce(config, "/private/app.pem", log, fetchImpl, async () => { runCalls += 1; });
  assert.equal(result, "idle");
  assert.equal(runCalls, 0);
});

test("each claimed Run mints once, immediately before constructing its GitHub surface", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return new Response(null, { status: 204 });
  };
  let mintCalls = 0;
  let surfaceCalls = 0;
  for (const run of [claimed("run-1"), claimed("run-2")]) {
    let mintedForThisRun = false;
    await runClaim(config, "/private/app.pem", run, log, fetchImpl, {
      mintToken: async () => {
        mintCalls += 1;
        mintedForThisRun = true;
        return { ok: true, token: `installation_${"T".repeat(32)}`, expiresAt: new Date(Date.now() + 60 * 60_000) };
      },
      makeGitHub: ((options: { token: string }) => {
        assert.equal(mintedForThisRun, true);
        assert.match(options.token, /^installation_/u);
        surfaceCalls += 1;
        return {};
      }) as never,
      executeDecision: async () => ({ outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" }),
    });
  }
  assert.equal(mintCalls, 2);
  assert.equal(surfaceCalls, 2);
  assert.equal(requests.filter((request) => request.url.endsWith("/start")).length, 2);
  assert.equal(requests.filter((request) => request.url.endsWith("/complete")).length, 2);
});

test("any mint failure completes retryably before a GitHub surface or merge write exists", async () => {
  const secret = `untrusted-${"S".repeat(24)}`;
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return new Response(null, { status: 204 });
  };
  let surfaceCalls = 0;
  let executeCalls = 0;
  await runClaim(config, "/private/app.pem", claimed("failed-run"), log, fetchImpl, {
    mintToken: async () => ({ ok: false, failure: "private-key-read-failed" }),
    makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    executeDecision: (async () => { executeCalls += 1; throw new Error(secret); }) as never,
  });
  assert.equal(surfaceCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://agentos.test/runner/runs/failed-run/start",
    "https://agentos.test/runner/runs/failed-run/complete",
  ]);
  const completion = JSON.parse(requests[1]!.body) as Record<string, unknown>;
  assert.equal(completion.retryable, true);
  assert.match(String(completion.failureReason), /private-key-read-failed/u);
  assert.equal(requests.some((request) => request.body.includes(secret)), false);
});

test("a bounded non-settling key read cannot reach a GitHub surface, activity, or output", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return new Response(null, { status: 204 });
  };
  let surfaceCalls = 0;
  let executeCalls = 0;
  const startedAt = Date.now();
  await runClaim({ ...config, githubAppAuthTimeoutMs: 10 }, "/private/app.pem", claimed("stalled-key-run"), log, fetchImpl, {
    mintToken: async (options) => await mintInstallationToken({
      ...options,
      currentUid: () => 501,
      statPrivateKey: async () => ({ uid: 501, mode: 0o100600, size: 1_700, isFile: () => true } as Stats),
      readPrivateKey: async () => await new Promise<string>(() => {}),
    }),
    makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    executeDecision: (async () => { executeCalls += 1; return {}; }) as never,
  });
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(surfaceCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://agentos.test/runner/runs/stalled-key-run/start",
    "https://agentos.test/runner/runs/stalled-key-run/complete",
  ]);
  assert.equal(requests.some((request) => request.url.includes("/activity") || request.url.includes("/output")), false);
  assert.match(requests[1]!.body, /private-key-read-failed/u);
});

test("escaped malformed token responses cannot enter logs, completion, activity, or output", async () => {
  for (const invalidToken of [`${"A".repeat(24)}\"escaped`, `${"A".repeat(24)}\\escaped`]) {
    const requests: Array<{ url: string; body: string }> = [];
    const lines: string[] = [];
    const capturedLog = makeLog(makeRedactor(), {
      log: (line: string) => lines.push(line),
      warn: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
      return new Response(null, { status: 204 });
    };
    let surfaceCalls = 0;
    await runClaim(config, "/private/app.pem", claimed(`malformed-${requests.length}`), capturedLog, fetchImpl, {
      mintToken: async (options) => await mintInstallationToken({
        ...options,
        currentUid: () => 501,
        statPrivateKey: async () => ({ uid: 501, mode: 0o100600, size: 1_700, isFile: () => true } as Stats),
        readPrivateKey: async () => "private-key-bytes",
        signer: () => "signature",
        now: () => new Date("2026-08-21T12:00:00.000Z"),
        http: async () => ({
          status: 201,
          body: JSON.stringify({ token: invalidToken, expires_at: "2026-08-21T13:00:00.000Z" }),
        }),
      }),
      makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    });
    assert.equal(surfaceCalls, 0);
    assert.ok(lines.every((line) => !line.includes(invalidToken)));
    assert.ok(requests.every((request) => !request.body.includes(invalidToken)));
    assert.equal(requests.some((request) => request.url.includes("/activity") || request.url.includes("/output")), false);
    assert.match(requests.at(-1)!.body, /installation-token-response-malformed/u);
  }
});

test("a minted installation token cannot escape through run evidence or completion errors", async () => {
  const installationToken = `installation_${"X".repeat(32)}`;
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (url.startsWith("https://api.github.test")) {
      return new Response(JSON.stringify({ errors: [{ message: installationToken }] }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  await runClaim(config, "/private/app.pem", claimed("redacted-run"), log, fetchImpl, {
    mintToken: async () => ({ ok: true, token: installationToken, expiresAt: new Date(Date.now() + 60 * 60_000) }),
    makeGitHub: ((options: { http: (request: Record<string, unknown>) => Promise<{ body: string }> }) => ({
      readPullRequest: async () => {
        const response = await options.http({
          url: "https://api.github.test/graphql", method: "POST", headers: { Authorization: `Bearer ${installationToken}` }, signal: AbortSignal.timeout(100),
        });
        throw new Error(response.body);
      },
    })) as never,
    executeDecision: (async (deps: { readPullRequest: (reference: unknown) => Promise<unknown> }) => {
      await deps.readPullRequest({});
      throw new Error(installationToken);
    }) as never,
  });
  assert.ok(requests.every((request) => !request.body.includes(installationToken)));
  const completion = requests.find((request) => request.url.endsWith("/complete"));
  assert.ok(completion);
  assert.equal(completion.body.includes(installationToken), false);
  assert.match(completion.body, /crashed during mechanical execution/u);
});
