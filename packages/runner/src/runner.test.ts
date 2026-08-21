import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { adapters } from "./adapters.js";
import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { executeClaim, reportCliAvailabilityHeartbeat, runStartupPreflight } from "./runner.js";

const config = (workspaceRoot: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 5_000,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home: workspaceRoot,
  proxyEnvironment: {},
  sessionConfigBaselineRoot: join(import.meta.dirname, "..", "assets", "session-config-baseline"),
  workspaceRoot,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const mechanicalClaim: ClaimedTask = {
  executionMode: "mechanical",
  task: {
    id: "task-10",
    name: "Merge execution",
    description: "Execute the authorized merge",
    repoId: "repo-1",
    targetBranch: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 3,
    templateStep: { name: "Merge execution" },
  },
  agent: {
    id: "agent-merge",
    name: "merge-integrator",
    model: "mechanical/merge-executor-v1",
    foundationalPrompt: "",
    rolePrompt: "",
    disabledTools: [],
  },
  repo: { id: "repo-1", remoteUrl: "git@github.com:owner/name.git", defaultBranch: "master", mountPath: "/does/not/exist" },
  run: {
    id: "run-10",
    runNumber: 1,
    opensPullRequest: false,
    pullRequestBase: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxRunsPerTask: 3,
    model: "mechanical/merge-executor-v1",
    targetBranch: "master",
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    promptHash: "hash",
    workspacePath: null,
    branch: null,
    baseSha: null,
  },
  session: { id: "session-10" },
  resume: null,
  nextEventSeq: 0,
  runner: "CLAUDE",
  fencingToken: "fence-1",
  sessionToken: "session-token",
  secrets: {},
  priorOutputs: [],
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("a mechanical claim is refused before any adapter, workspace or child environment exists", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "runner-mechanical-"));
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  // Any adapter entry point reached at all is the failure this test exists to
  // catch: a merge credential must never be in a process that spawns a CLI.
  const started = adapters.CLAUDE.start;
  const preflighted = adapters.CLAUDE.preflight;
  adapters.CLAUDE.start = (() => { throw new Error("adapter.start must not be reached for a mechanical claim"); }) as typeof started;
  adapters.CLAUDE.preflight = (() => { throw new Error("adapter.preflight must not be reached for a mechanical claim"); }) as typeof preflighted;
  try {
    await executeClaim(config(workspaceRoot), mechanicalClaim);
  } finally {
    adapters.CLAUDE.start = started;
    adapters.CLAUDE.preflight = preflighted;
  }

  assert.deepEqual(calls.map((call) => call.path), ["http://api.invalid/runner/runs/run-10/complete"]);
  assert.equal(calls[0]!.body.terminationReason, "mechanical run claimed by a model runner");
  assert.equal(calls[0]!.body.retryable, false);
  assert.equal(calls[0]!.body.exitCode, null);
  // No workspace was provisioned: `provisionWorkspace` creates its run directory
  // under the workspace root, and nothing else in this path writes there.
  assert.deepEqual(await readdir(workspaceRoot), []);
});

test("an ordinary claim is not short-circuited by the mechanical refusal", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "runner-agent-"));
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // Over budget, so it exits on the very next guard — enough to prove the
  // mechanical branch did not swallow it, without provisioning anything.
  await executeClaim(config(workspaceRoot), {
    ...mechanicalClaim,
    executionMode: "agent",
    run: { ...mechanicalClaim.run, runNumber: 9, maxRunsPerTask: 3 },
  });
  assert.deepEqual(calls, ["http://api.invalid/runner/runs/run-10/complete"]);
});

/* ------------------------------------- Codex is the only backend v0.1 needs */

/**
 * Plan Step 6, evidence row E11. A clean install has one CLI on it: the
 * official Codex one. Claude and Pi are optional, and the property that makes
 * them optional is not a message in the UI — it is that this process reports
 * them blocked, keeps their telemetry, and goes on to run a Codex claim
 * anyway.
 *
 * The stub answers the two official checks and nothing else, and it records
 * what it was asked, so "preserve exact official checks" is asserted rather
 * than assumed: `codex --version`, then `codex login status`. Neither is
 * automated away and nothing reads a credential store.
 */
/**
 * What an unauthenticated CLI actually prints.
 *
 * These are not decoration. A real `codex login status` on a signed-out machine
 * prints whatever it likes — the environment variable it looked for, the remote
 * it tried, the path of the credential file it could not read. That output used
 * to be forwarded verbatim into `RunnerBackendState.circuitReason`, which is
 * returned by `GET /runners` and rendered on the first screen a new operator
 * sees. So the stub prints the three shapes that matter and every assertion
 * below looks for them by name.
 */
const SECRETS = [
  "sk-live-CODEXLEAK9",
  "https://user:hunter2@git.example.test/x.git",
  // Assembled rather than written out: a literal home-directory path is exactly
  // what `snapshot:scan` flags in public source, and a test about not shipping
  // private paths should not ship one.
  ["", "Users", "someone", ".codex", "auth.json"].join("/"),
] as const;

const codexStub = (log: string, authFails = false): string => [
  "#!/bin/sh",
  `echo "$@" >> ${log}`,
  'case "$1" in',
  '  --version) echo "codex-cli 0.147.0"; exit 0 ;;',
  '  exec)',
  '    if [ "$2" = "--help" ]; then echo "resume --json --model --config --dangerously-bypass-approvals-and-sandbox"; exit 0; fi',
  '    if [ "$2" = "resume" ] && [ "$3" = "--help" ]; then echo "SESSION_ID --json --model --config --dangerously-bypass-approvals-and-sandbox read from stdin"; exit 0; fi',
  '    ;;',
  authFails
    ? `  login) echo "${SECRETS[0]}"; echo "${SECRETS[1]}" 1>&2; echo "${SECRETS[2]}" 1>&2; exit 1 ;;`
    : '  login) echo "Logged in using ChatGPT"; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  'echo \'{"type":"thread.started","thread_id":"thread-6"}\'',
  'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"installed"}}\'',
  'echo \'{"type":"turn.completed"}\'',
  "exit 0",
].join("\n");

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const seedRemote = async (root: string): Promise<string> => {
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=master", remote);
  git(root, "init", "--initial-branch=master", seed);
  git(seed, "config", "user.name", "AgentOS Test");
  git(seed, "config", "user.email", "runner@agentos.local");
  await writeFile(join(seed, "tree.txt"), "base\n");
  git(seed, "add", "tree.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "master");
  return remote;
};

const seedCodexAuth = async (root: string): Promise<void> => {
  const directory = join(root, ".codex");
  await mkdir(directory);
  await writeFile(join(directory, "auth.json"), '{"tokens":"test-only"}\n', { mode: 0o600 });
};

const removeRetainedConfig = async (completion: { body: Record<string, unknown> }): Promise<void> => {
  const retained = /session CLI config retained at (.+)$/u.exec(String(completion.body.failureReason))?.[1];
  if (retained) await rm(retained, { recursive: true, force: true });
};

test("a session config creation failure completes in PROVISION without reaching a CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-config-provision-failure-"));
  try {
    const remote = await seedRemote(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    let preflightCalls = 0;
    let startCalls = 0;
    const originalPreflight = adapters.CLAUDE.preflight;
    const originalStart = adapters.CLAUDE.start;
    adapters.CLAUDE.preflight = (async () => { preflightCalls += 1; return { ok: true } as never; }) as typeof originalPreflight;
    adapters.CLAUDE.start = (async () => { startCalls += 1; throw new Error("CLI must not spawn"); }) as typeof originalStart;
    let configRoot = "";
    try {
      await executeClaim(
        config(join(root, "workspaces")),
        {
          ...mechanicalClaim,
          executionMode: "agent",
          runner: "CLAUDE",
          repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
          agent: { ...mechanicalClaim.agent, model: "claude" },
          run: { ...mechanicalClaim.run, model: "claude", maxRunsPerTask: 3 },
        },
        {
          provisionSessionConfig: async (_config, _runner, scratch) => {
            configRoot = scratch.configRoot;
            await mkdir(configRoot);
            throw new Error("EACCES while seeding repository baseline");
          },
        },
      );
    } finally {
      adapters.CLAUDE.preflight = originalPreflight;
      adapters.CLAUDE.start = originalStart;
    }

    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal((completion.body.failureEnvelope as { phase?: string }).phase, "PROVISION");
    assert.match(String(completion.body.failureReason), /EACCES while seeding repository baseline/u);
    assert.match(String(completion.body.failureReason), new RegExp(`${configRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
    assert.equal((await stat(configRoot)).isDirectory(), true);
    await rm(configRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real provisioner reports Codex auth and baseline failures in PROVISION without spawning a CLI", async () => {
  const originalPreflight = adapters.CODEX.preflight;
  const originalStart = adapters.CODEX.start;
  let preflightCalls = 0;
  let startCalls = 0;
  adapters.CODEX.preflight = (async () => { preflightCalls += 1; return { ok: true } as never; }) as typeof originalPreflight;
  adapters.CODEX.start = (async () => { startCalls += 1; throw new Error("CLI must not spawn"); }) as typeof originalStart;
  try {
    for (const scenario of ["missing-auth", "unreadable-auth", "unreadable-baseline"] as const) {
      const root = await mkdtemp(join(tmpdir(), `runner-real-provision-${scenario}-`));
      try {
        const remote = await seedRemote(root);
        const home = join(root, "runner-home");
        await mkdir(join(home, ".codex"), { recursive: true });
        const auth = join(home, ".codex", "auth.json");
        if (scenario !== "missing-auth") await writeFile(auth, '{"tokens":"test-only"}\n', { mode: 0o600 });
        if (scenario === "unreadable-auth") await chmod(auth, 0o000);

        const runnerConfig = { ...config(join(root, "workspaces")), home, failedWorkspaceRetention: 0 };
        if (scenario === "unreadable-baseline") {
          const baselineRoot = join(root, "baseline");
          const codexBaseline = join(baselineRoot, "codex");
          await mkdir(codexBaseline, { recursive: true });
          await writeFile(join(codexBaseline, "config.toml"), "model_provider = 'openai'\n");
          await chmod(codexBaseline, 0o000);
          runnerConfig.sessionConfigBaselineRoot = baselineRoot;
        }

        const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
        const sessionId = `session-real-${scenario}`;
        await executeClaim(runnerConfig, {
          ...mechanicalClaim,
          executionMode: "agent",
          runner: "CODEX",
          repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
          agent: { ...mechanicalClaim.agent, model: "codex" },
          run: { ...mechanicalClaim.run, id: `run-real-${scenario}`, model: "codex", maxRunsPerTask: 3 },
          session: { id: sessionId },
        });

        const completion = posts.find((post) => post.path.endsWith("/complete"));
        assert.ok(completion, scenario);
        assert.equal((completion.body.failureEnvelope as { phase?: string }).phase, "PROVISION");
        assert.match(String(completion.body.failureReason), scenario === "unreadable-baseline"
          ? /Unable to create session CLI config root/u
          : /Unable to establish Codex authentication/u);
        const retained = /session CLI config retained at (.+)$/u.exec(String(completion.body.failureReason))?.[1];
        assert.ok(retained);
        assert.equal(retained.startsWith(home), false, "host HOME must never become CODEX_HOME");
        await rm(retained, { recursive: true, force: true });
      } finally {
        await chmod(join(root, "runner-home", ".codex", "auth.json"), 0o600).catch(() => undefined);
        await chmod(join(root, "baseline", "codex"), 0o700).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    adapters.CODEX.preflight = originalPreflight;
    adapters.CODEX.start = originalStart;
  }
  assert.equal(preflightCalls, 0);
  assert.equal(startCalls, 0);
});

/** The config the two tests below share: a real Codex stub, and nothing at all
 *  where the other two CLIs would be. */
const codexOnly = (workspaceRoot: string, root: string, codexBinary: string): RunnerConfig => ({
  ...config(workspaceRoot),
  home: root,
  path: process.env.PATH ?? "/usr/bin:/bin",
  binaries: { CLAUDE: join(root, "no-claude-here"), CODEX: codexBinary, PI: join(root, "no-pi-here") },
});

test("startup reports Claude and Pi blocked, keeps their telemetry, and passes Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-gate-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log));
    await chmod(binary, 0o755);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const availability: Array<{ runner: string; available: boolean; resolvedPath: string | null }> = [];
    const results = await runStartupPreflight(codexOnly(join(root, "workspaces"), root, binary), {
      onAvailability: (probe) => { availability.push(probe); },
    });

    assert.deepEqual(results, { CLAUDE: false, CODEX: true, PI: false });
    // Telemetry for the absent backends is not dropped: someone does use them,
    // and a silent gap is worse than a reported failure.
    assert.deepEqual(availability.map(({ runner, available }) => ({ runner, available })), [
      { runner: "CLAUDE", available: false },
      { runner: "CODEX", available: true },
      { runner: "PI", available: false },
    ]);
    assert.equal(availability[1]?.resolvedPath, binary);
    assert.deepEqual(posts.map((post) => post.body.runner), ["CLAUDE", "CODEX", "PI", "CODEX"]);
    assert.deepEqual(posts.map((post) => post.path), [
      ...Array<string>(3).fill("http://api.invalid/runner/availability"),
      "http://api.invalid/runner/preflight",
    ]);
    const codex = posts.find((post) => post.path.endsWith("/preflight") && post.body.runner === "CODEX")!;
    assert.equal(codex.body.ok, true);
    assert.equal(codex.body.cliVersion, "codex-cli 0.147.0");
    assert.equal(codex.body.authMode, "chatgpt");
    // The two official checks, in order, and nothing else — no `login --api-key`,
    // no credential file read, no attempt to authenticate on the operator's
    // behalf.
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
    // What is reported about a blocked backend is a verdict and a message, never
    // an environment or a credential.
    const claude = posts.find((post) => post.path.endsWith("/availability") && post.body.runner === "CLAUDE")!;
    assert.equal(claude.body.available, false);
    assert.equal(claude.body.binary, join(root, "no-claude-here"));
    assert.equal(claude.body.resolvedPath, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup blocks a Codex CLI that lacks the exec protocol AgentOS invokes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-incompatible-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.1.0"; exit 0; fi',
      'if [ "$1" = "exec" ]; then echo "legacy exec help"; exit 0; fi',
      'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      "exit 1",
    ].join("\n"));
    await chmod(binary, 0o755);
    const posts: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      posts.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    assert.deepEqual(
      await runStartupPreflight(codexOnly(join(root, "workspaces"), root, binary)),
      { CLAUDE: false, CODEX: false, PI: false },
    );
    const codex = posts.find((post) => post.body.runner === "CODEX" && "error" in post.body)!;
    assert.equal(codex.body.error, "cli-incompatible: the CLI does not expose the required AgentOS exec protocol");
    assert.equal(codex.body.cliVersion, "codex-cli 0.1.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup retries a temporarily unavailable API without rerunning CLI probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-startup-retry-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log));
    await chmod(binary, 0o755);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls <= 2) throw new TypeError("fetch failed");
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const waits: number[] = [];
    const retries: Array<{ runner: string; attempt: number; attempts: number }> = [];

    const results = await runStartupPreflight(codexOnly(join(root, "workspaces"), root, binary), {
      wait: async (attempt) => { waits.push(attempt); },
      onRetry: (runner, attempt, attempts) => { retries.push({ runner, attempt, attempts }); },
    });

    assert.deepEqual(results, { CLAUDE: false, CODEX: true, PI: false });
    assert.equal(calls, 6, "two failed sends plus availability for each backend and one Codex preflight");
    assert.deepEqual(waits, [1, 2]);
    assert.deepEqual(retries, [
      { runner: "CLAUDE", attempt: 1, attempts: 5 },
      { runner: "CLAUDE", attempt: 2, attempts: 5 },
    ]);
    assert.deepEqual(posts.map((post) => post.body.runner), ["CLAUDE", "CODEX", "PI", "CODEX"]);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup does not retry an API authentication refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-startup-refused-"));
  try {
    const waits: number[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await assert.rejects(
      runStartupPreflight(codexOnly(join(root, "workspaces"), root, join(root, "codex")), {
        wait: async (attempt) => { waits.push(attempt); },
        onRetry: () => assert.fail("a deterministic refusal must not be retried"),
      }),
      /AgentOS API 401/u,
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex claim passes its own preflight and starts while the others stay blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-claim-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const configured = codexOnly(join(root, "workspaces"), root, binary);
    // Startup first, exactly as `index.ts` orders it: the claim below runs on a
    // process that has just reported two of three backends blocked.
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: true, PI: false });
    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const started = posts.find((post) => post.path.endsWith("/start"));
    assert.ok(started, "a blocked Claude and Pi must not keep a Codex run from starting");
    assert.equal(started.body.cliVersion, "codex-cli 0.147.0");
    assert.equal(started.body.authMode, "chatgpt");
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(completion.body.terminalSuccess, true);
    assert.equal(completion.body.failureClass ?? null, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Plan Step 6's security condition: no credential material in telemetry or UI.
 *
 * The channel this closes is specific. A failed preflight's `error` is posted to
 * `POST /runner/preflight`, stored as `RunnerBackendState.circuitReason`,
 * returned by `GET /runners`, and rendered — so a signed-out CLI's stdout became
 * telemetry and then became a screenshot in a bug report. Nothing about that
 * text is bounded, so nothing about it can be sanitised downstream; what is
 * reported is a class this repository authors, plus an exit code.
 *
 * The failure class the run system assigns must survive that, which is the
 * second half of the test: an operator whose Codex is signed out still gets
 * AUTH_REQUIRED and the action that goes with it.
 */
test("a signed-out Codex reports a class and an exit code, never what the CLI printed", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-secret-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log, true));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const configured = codexOnly(join(root, "workspaces"), root, binary);
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: false, PI: false });
    const codex = posts.find((post) => post.path.endsWith("/preflight") && post.body.runner === "CODEX")!;
    assert.equal(codex.body.ok, false);
    assert.equal(codex.body.error, "not-authenticated: the CLI's own login check did not pass (exit 1)");
    // The version was read before the login check and is this repository's own
    // reading of `--version`, so it is still reported.
    assert.equal(codex.body.cliVersion, "codex-cli 0.147.0");

    // A claim on the same machine: the run fails, and it fails as AUTH_REQUIRED
    // rather than as a generic task failure, which is what tells the operator to
    // go and run `codex login`.
    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });
    const completion = posts.find((post) => post.path.endsWith("/complete"))!;
    assert.equal(completion.body.terminalSuccess, false);
    assert.equal(completion.body.failureClass, "AUTH_REQUIRED");

    // Nothing the CLI printed is anywhere in what this process sent — not in the
    // preflight report, not in the run's failure envelope, not in its events.
    const wire = JSON.stringify(posts);
    for (const secret of SECRETS) assert.ok(!wire.includes(secret), `${secret} reached the control plane`);
    // And the login check itself is still the official one, unchanged.
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").slice(0, 4), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
    await removeRetainedConfig(completion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex CLI that is not installed is a class of its own, and still reads as a missing binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-absent-"));
  try {
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const configured = codexOnly(join(root, "workspaces"), root, join(root, "no-codex-here"));
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: false, PI: false });
    const codex = posts.find((post) => post.path.endsWith("/availability") && post.body.runner === "CODEX")!;
    assert.equal(codex.body.available, false);
    assert.equal(codex.body.binary, join(root, "no-codex-here"));
    assert.equal(codex.body.resolvedPath, null);

    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });
    const completion = posts.find((post) => post.path.endsWith("/complete"))!;
    assert.equal(completion.body.failureClass, "BINARY_NOT_FOUND");
    assert.ok(!JSON.stringify(posts).includes("ENOENT"));
    await removeRetainedConfig(completion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an availability heartbeat reports a CLI recovery without restarting the runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-cli-recovery-"));
  try {
    const binary = join(root, "codex");
    const configured = codexOnly(join(root, "workspaces"), root, binary);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await reportCliAvailabilityHeartbeat(configured);
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o755);
    await reportCliAvailabilityHeartbeat(configured);

    const codexReports = posts.filter((post) => post.body.runner === "CODEX");
    assert.deepEqual(codexReports.map((post) => post.body.available), [false, true]);
    assert.deepEqual(codexReports.map((post) => post.body.resolvedPath), [null, binary]);
    assert.ok(posts.every((post) => post.path === "http://api.invalid/runner/availability"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
