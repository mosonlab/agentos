import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { RunOutcome } from "@anneal/db";
import { RUN_COMPLETION_CONTRACT_VERSION } from "@anneal/db/claim-contract";

import { makeAgentOsClient, type MechanicalClaim } from "./agentos.js";
import type { ExecutorConfig } from "./config.js";
import { mintInstallationToken } from "./github-app-auth.js";
import { claimOnce, pollClaims, runClaim } from "./index.js";
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

const compatibleAgentOsResponse = (input: string | URL | Request): Response =>
  String(input).endsWith("/heartbeat")
    ? new Response(JSON.stringify({ ok: true, cancellation: null, mechanicalCancellationPolicy: "refused" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    : new Response(null, { status: 204 });

test("an idle claim poll never enters the run-scoped mint path", async () => {
  let runCalls = 0;
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 204 });
  const result = await claimOnce(config, "/private/app.pem", log, fetchImpl, async () => { runCalls += 1; });
  assert.equal(result, "idle");
  assert.equal(runCalls, 0);
});

test("a completion-contract mismatch stops claim polling with one error and no retry", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const errors: string[] = [];
  const capturedLog = makeLog(makeRedactor(), {
    log: () => {},
    warn: () => {},
    error: (line: string) => errors.push(line),
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({
      error: `Mechanical completion contract mismatch: executor version ${RUN_COMPLETION_CONTRACT_VERSION - 1}; API version ${RUN_COMPLETION_CONTRACT_VERSION}`,
      code: "mechanical_contract_mismatch",
      expectedVersion: RUN_COMPLETION_CONTRACT_VERSION,
      receivedVersion: RUN_COMPLETION_CONTRACT_VERSION - 1,
    }), { status: 409, headers: { "content-type": "application/json" } });
  };
  let runCalls = 0;

  const result = await claimOnce(config, "/private/app.pem", capturedLog, fetchImpl, async () => { runCalls += 1; });

  assert.equal(result, "contract-mismatch");
  assert.equal(runCalls, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0]!.body), {
    runnerId: "merge-executor-1",
    leaseSeconds: 120,
    contractVersion: RUN_COMPLETION_CONTRACT_VERSION,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, new RegExp(`executorVersion.*${RUN_COMPLETION_CONTRACT_VERSION - 1}`, "u"));
  assert.match(errors[0]!, new RegExp(`apiVersion.*${RUN_COMPLETION_CONTRACT_VERSION}`, "u"));
});

test("a completion-contract mismatch parks the daemon until shutdown", async () => {
  const controller = new AbortController();
  let claimCalls = 0;
  let settled = false;
  const polling = pollClaims({
    signal: controller.signal,
    pollIntervalMs: 1,
    log,
    claim: async () => {
      claimCalls += 1;
      return "contract-mismatch";
    },
  }).then(() => { settled = true; });

  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(claimCalls, 1);
  assert.equal(settled, false);

  controller.abort();
  await polling;
  assert.equal(settled, true);
});

test("the mechanical start request matches the promptless API contract", async () => {
  let startBody: unknown;
  const fetchImpl: typeof fetch = async (_input, init) => {
    startBody = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  };
  await makeAgentOsClient(config, fetchImpl).start(claimed("contract-run"));
  assert.deepEqual(startBody, {
    runnerId: "merge-executor-1",
    fencingToken: "fence-contract-run",
    adapterVersion: "merge-executor-v1",
    cliVersion: "merge-executor-v1",
    workspacePath: null,
    manifest: { executionMode: "mechanical", childProcessCount: 0 },
  });
});

test("a persisted mechanical cancellation is acknowledged before GitHub authority is minted", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/heartbeat")) {
      return new Response(JSON.stringify({
        ok: false,
        cancellation: { requestId: "legacy-cancel", reason: "operator stop", requestedAt: new Date(0).toISOString() },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return compatibleAgentOsResponse(input);
  };
  let mintCalls = 0;
  let surfaceCalls = 0;
  let executeCalls = 0;
  await runClaim(config, "/private/app.pem", claimed("legacy-cancelled-run"), log, fetchImpl, {
    mintToken: async () => {
      mintCalls += 1;
      return { ok: false, failure: "private-key-read-failed" };
    },
    makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    executeDecision: (async () => { executeCalls += 1; return {}; }) as never,
  });
  assert.equal(mintCalls, 0);
  assert.equal(surfaceCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(requests, [
    "https://agentos.test/runner/runs/legacy-cancelled-run/start",
    "https://agentos.test/runner/runs/legacy-cancelled-run/heartbeat",
    "https://agentos.test/runner/runs/legacy-cancelled-run/cancel/acknowledge",
  ]);
});

test("a control plane without the mechanical-cancellation policy cannot reach GitHub", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return new Response(null, { status: 204 });
  };
  let mintCalls = 0;
  let surfaceCalls = 0;
  let executeCalls = 0;
  await runClaim(config, "/private/app.pem", claimed("old-control-plane"), log, fetchImpl, {
    mintToken: async () => {
      mintCalls += 1;
      return { ok: false, failure: "private-key-read-failed" };
    },
    makeGitHub: (() => { surfaceCalls += 1; return {}; }) as never,
    executeDecision: (async () => { executeCalls += 1; return {}; }) as never,
  });
  assert.equal(mintCalls, 0);
  assert.equal(surfaceCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(requests.map((request) => request.url), [
    "https://agentos.test/runner/runs/old-control-plane/start",
    "https://agentos.test/runner/runs/old-control-plane/heartbeat",
    "https://agentos.test/runner/runs/old-control-plane/complete",
  ]);
  assert.match(requests[2]!.body, /does not enforce mechanical cancellation refusal/u);
});

test("each claimed Run mints once, immediately before constructing its GitHub surface", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return compatibleAgentOsResponse(input);
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
    return compatibleAgentOsResponse(input);
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
    "https://agentos.test/runner/runs/failed-run/heartbeat",
    "https://agentos.test/runner/runs/failed-run/complete",
  ]);
  const { outcome } = JSON.parse(requests[2]!.body) as { outcome: RunOutcome };
  // A crashed executor persists no merge result, so the deliverable is absent
  // rather than unverifiable: retryable, and the next attempt can still make it.
  assert.equal(outcome.case, "required-output-unsatisfied");
  assert.match("reason" in outcome ? outcome.reason : "", /private-key-read-failed/u);
  assert.equal(requests.some((request) => request.body.includes(secret)), false);
});

test("a bounded non-settling key read cannot reach a GitHub surface, activity, or output", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    return compatibleAgentOsResponse(input);
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
    "https://agentos.test/runner/runs/stalled-key-run/heartbeat",
    "https://agentos.test/runner/runs/stalled-key-run/complete",
  ]);
  assert.equal(requests.some((request) => request.url.includes("/activity") || request.url.includes("/output")), false);
  assert.match(requests[2]!.body, /private-key-read-failed/u);
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
      return compatibleAgentOsResponse(input);
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
    return compatibleAgentOsResponse(input);
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

test("a rejected completion is recorded once and is not submitted again", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const errors: string[] = [];
  const responseBody = JSON.stringify({ error: "completion payload is incompatible" });
  const capturedLog = makeLog(makeRedactor(), {
    log: () => {},
    warn: () => {},
    error: (line: string) => errors.push(line),
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/complete")) {
      return new Response(responseBody, { status: 400, headers: { "content-type": "application/json" } });
    }
    return compatibleAgentOsResponse(input);
  };

  await runClaim(config, "/private/app.pem", claimed("rejected-completion"), capturedLog, fetchImpl, {
    mintToken: async () => ({ ok: true, token: `installation_${"R".repeat(32)}`, expiresAt: new Date(Date.now() + 60 * 60_000) }),
    makeGitHub: (() => ({})) as never,
    executeDecision: async () => ({ outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" }),
  });

  assert.equal(requests.filter(({ url }) => url.endsWith("/complete")).length, 1);
  const rejectionActivities = requests.filter(({ url, body }) => url.endsWith("/activity") && body.includes("completionRejected"));
  assert.equal(rejectionActivities.length, 1);
  const activity = JSON.parse(rejectionActivities[0]!.body) as { body: string; metadata: Record<string, unknown> };
  assert.equal(activity.metadata.status, 400);
  assert.equal(activity.metadata.responseBody, responseBody);
  assert.match(activity.body, /HTTP 400/u);
  assert.match(activity.body, /completion payload is incompatible/u);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /HTTP 400/u);
  assert.match(errors[0]!, /completion payload is incompatible/u);
});

test("a completion network failure is retried exactly once", async () => {
  let completionAttempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/complete")) {
      completionAttempts += 1;
      if (completionAttempts === 1) throw new TypeError("network disconnected");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return compatibleAgentOsResponse(input);
  };

  await makeAgentOsClient(config, fetchImpl).complete(claimed("network-retry"), {
    succeeded: true,
    outcome: { outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" },
  }, makeRedactor());

  assert.equal(completionAttempts, 2);
});

test("a non-network completion exception is not retried", async () => {
  let completionAttempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/complete")) {
      completionAttempts += 1;
      throw new Error("programming failure in fetch adapter");
    }
    return compatibleAgentOsResponse(input);
  };

  await assert.rejects(
    makeAgentOsClient(config, fetchImpl).complete(claimed("no-programming-retry"), {
      succeeded: true,
      outcome: { outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" },
    }, makeRedactor()),
    /programming failure/u,
  );
  assert.equal(completionAttempts, 1);
});

test("completion rejection evidence redacts the run-scoped installation token", async () => {
  const installationToken = `installation_${"Z".repeat(32)}`;
  const requests: Array<{ url: string; body: string }> = [];
  const lines: string[] = [];
  const capturedLog = makeLog(makeRedactor(), {
    log: (line: string) => lines.push(line),
    warn: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/complete")) {
      return new Response(JSON.stringify({ error: `rejected ${installationToken}` }), { status: 400 });
    }
    return compatibleAgentOsResponse(input);
  };

  await runClaim(config, "/private/app.pem", claimed("redacted-rejection"), capturedLog, fetchImpl, {
    mintToken: async () => ({ ok: true, token: installationToken, expiresAt: new Date(Date.now() + 60 * 60_000) }),
    makeGitHub: (() => ({})) as never,
    executeDecision: async () => ({ outcome: "stopped", condition: "unresolved-mergeability", evidence: "fixture" }),
  });

  assert.equal(requests.some(({ body }) => body.includes(installationToken)), false);
  assert.equal(lines.some((line) => line.includes(installationToken)), false);
  assert.ok(requests.some(({ body }) => body.includes("[redacted-merge-credential]")));
  assert.ok(lines.some((line) => line.includes("[redacted-merge-credential]")));
});

test("the daemon still starts when it is reached through a symlinked release directory", () => {
  // The operator runbook installs versioned releases and starts the daemon
  // through a `current` -> releases/<oid> symlink. ESM resolves that before it
  // sets import.meta.url, so an entrypoint guard comparing raw strings skipped
  // `main` entirely: node exited 0 with no output at all and the service
  // manager respawned the silence forever. Assert the loud behaviour, because
  // silence is the failure this is standing in front of.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "merge-executor-entrypoint-"));
  try {
    const link = join(scratch, "current");
    symlinkSync(here, link, "dir");
    const started = spawnSync(
      process.execPath,
      ["--conditions=development", "--import", import.meta.resolve("tsx"), join(link, "index.ts")],
      {
        // No configuration and an empty working directory, so the startup gate
        // refuses immediately and this never reaches a control plane.
        cwd: scratch,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      },
    );
    assert.match(started.stderr, /merge-executor startup refused:/u, `stderr was ${JSON.stringify(started.stderr)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
