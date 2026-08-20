import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { adapters } from "./adapters.js";
import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { executeClaim, runStartupPreflight } from "./runner.js";

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

/** The config the two tests below share: a real Codex stub, and nothing at all
 *  where the other two CLIs would be. */
const codexOnly = (workspaceRoot: string, root: string, codexBinary: string): RunnerConfig => ({
  ...config(workspaceRoot),
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

    const results = await runStartupPreflight(codexOnly(join(root, "workspaces"), root, binary));

    assert.deepEqual(results, { CLAUDE: false, CODEX: true, PI: false });
    // Telemetry for the absent backends is not dropped: someone does use them,
    // and a silent gap is worse than a reported failure.
    assert.deepEqual(posts.map((post) => post.body.runner), ["CLAUDE", "CODEX", "PI"]);
    assert.deepEqual(posts.map((post) => post.path), Array<string>(3).fill("http://api.invalid/runner/preflight"));
    const codex = posts.find((post) => post.body.runner === "CODEX")!;
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
    const claude = posts.find((post) => post.body.runner === "CLAUDE")!;
    assert.equal(claude.body.ok, false);
    assert.deepEqual(Object.keys(claude.body).sort(), ["authMode", "capabilities", "cliVersion", "error", "ok", "runner"]);
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
    const codex = posts.find((post) => post.body.runner === "CODEX")!;
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
    assert.equal(calls, 5, "two failed sends plus one successful report per backend");
    assert.deepEqual(waits, [1, 2]);
    assert.deepEqual(retries, [
      { runner: "CLAUDE", attempt: 1, attempts: 5 },
      { runner: "CLAUDE", attempt: 2, attempts: 5 },
    ]);
    assert.deepEqual(posts.map((post) => post.body.runner), ["CLAUDE", "CODEX", "PI"]);
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
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const configured = codexOnly(join(root, "workspaces"), root, binary);
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: false, PI: false });
    const codex = posts.find((post) => post.body.runner === "CODEX")!;
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex CLI that is not installed is a class of its own, and still reads as a missing binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-absent-"));
  try {
    const remote = await seedRemote(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const configured = codexOnly(join(root, "workspaces"), root, join(root, "no-codex-here"));
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: false, PI: false });
    const codex = posts.find((post) => post.body.runner === "CODEX")!;
    assert.equal(codex.body.error, "cli-missing: the CLI did not answer --version (exit 127)");
    // The spawn error's own wording — a path, an errno — is not the message any
    // more, so the missing-binary verdict is now read from the class instead.
    assert.equal(codex.body.cliVersion, null);

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
