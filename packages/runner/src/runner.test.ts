import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { adapters, buildPrompt, type CliAdapter } from "./adapters.js";
import type { ClaimedTask, ControlPlane } from "./api.js";
import type { RunnerConfig } from "./config.js";
import {
  cliAvailabilityHeartbeatSchedule,
  executeClaim as executeClaimProduction,
  reportCliAvailabilityHeartbeat as reportCliAvailabilityHeartbeatProduction,
  runStartupPreflight as runStartupPreflightProduction,
} from "./runner.js";
import { createControlPlaneDouble, createRoutedControlPlaneDouble, type ControlPlaneFetchHandler } from "./test-control-plane.js";
import {
  cleanupAgentScratch, provisionSessionConfig, type AgentScratch,
} from "./workspace.js";

const config = (workspaceRoot: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 5_000,
  claimMaxLoadAverage: 1.5,
  leaseSeconds: 60,
  heartbeatIntervalMs: 5_000,
  path: "/usr/bin:/bin",
  home: workspaceRoot,
  gitIdentity: { name: "Runner Test", email: "runner@example.invalid" },
  workspaceRoot,
  hostProofSlots: 3,
  failedWorkspaceRetention: 2,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
});

const testSession = (root: string): ClaimedTask["session"] => ({ id: `test-${basename(root)}` });
const cleanupTestSession = async (root: string): Promise<void> => {
  await rm(join(tmpdir(), "agentos-session-config", testSession(root).id), { recursive: true, force: true });
};

const mechanicalClaim: ClaimedTask = {
  executionMode: "mechanical",
  specificationMaterialization: null,
  task: {
    id: "task-10",
    chainId: null,
    chainIndex: null,
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
    requiresCommit: false,
    pullRequestBase: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxRunsPerTask: 3,
    model: "mechanical/merge-executor-v1",
    codexServiceTier: "DEFAULT",
    subagentModel: null,
    subagentMaxConcurrent: null,
    targetBranch: "master",
    targetBranchPublished: false,
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
  operatorNotes: [],
  previousRunHandoff: null,
  regressionRepairHandoff: null,
};

let injectedControlPlane: ControlPlane = createControlPlaneDouble().controlPlane;
const setControlPlane = (handler: ControlPlaneFetchHandler): void => {
  injectedControlPlane = createRoutedControlPlaneDouble(handler).controlPlane;
};
const executeClaim = (
  ...[runnerConfig, claim, dependencies = {}]: Parameters<typeof executeClaimProduction>
) => executeClaimProduction(runnerConfig, claim, { ...dependencies, controlPlane: injectedControlPlane });
const runStartupPreflight = (
  runnerConfig: Parameters<typeof runStartupPreflightProduction>[0],
  options: Parameters<typeof runStartupPreflightProduction>[1] = {},
) => runStartupPreflightProduction(runnerConfig, { ...options, controlPlane: injectedControlPlane });
const reportCliAvailabilityHeartbeat = (
  runnerConfig: Parameters<typeof reportCliAvailabilityHeartbeatProduction>[0],
  options: Parameters<typeof reportCliAvailabilityHeartbeatProduction>[1] = {},
) => reportCliAvailabilityHeartbeatProduction(runnerConfig, { ...options, controlPlane: injectedControlPlane });

test("a mechanical claim is refused before any adapter, workspace or child environment exists", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "runner-mechanical-"));
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });

  // Any adapter entry point reached at all is the failure this test exists to
  // catch: a merge credential must never be in a process that spawns a CLI.
  const adapter: CliAdapter = {
    ...adapters.CLAUDE,
    start: () => { throw new Error("adapter.start must not be reached for a mechanical claim"); },
    preflight: () => { throw new Error("adapter.preflight must not be reached for a mechanical claim"); },
  };
  await executeClaim(config(workspaceRoot), mechanicalClaim, { adapter });

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
  setControlPlane(async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
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

interface CodexStubOptions {
  authFails?: boolean;
  configReportPath?: string;
  session?: {
    lines: readonly string[];
    exitCode: number;
  };
}

const committedFixtureChange = [
  'printf "delivered fixture change\\n" > runner-fixture.txt',
  "git add runner-fixture.txt",
  'git commit -m "test: create delivered fixture change" >/dev/null',
] as const;

const codexStub = (
  log: string,
  {
    authFails = false,
    configReportPath,
    session = {
      lines: [
        'echo \'{"type":"thread.started","thread_id":"thread-6"}\'',
        'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"installed"}}\'',
        'echo \'{"type":"turn.completed"}\'',
      ],
      exitCode: 0,
    },
  }: CodexStubOptions = {},
): string => [
  "#!/bin/sh",
  `echo "$@" >> ${log}`,
  ...(configReportPath ? [`if [ -n "$CODEX_HOME" ]; then printf '%s' "$CODEX_HOME" > ${configReportPath}; fi`] : []),
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
  ...(session.exitCode === 0 ? committedFixtureChange : []),
  ...session.lines,
  `exit ${session.exitCode}`,
].join("\n");

const failingCodexStub = (log: string, mutation = ":"): string => [
  "#!/bin/sh",
  `echo "$@" >> ${log}`,
  'case "$1" in',
  '  --version) echo "codex-cli 0.147.0"; exit 0 ;;',
  '  exec)',
  '    if [ "$2" = "--help" ]; then echo "resume --json --model --config --dangerously-bypass-approvals-and-sandbox"; exit 0; fi',
  '    if [ "$2" = "resume" ] && [ "$3" = "--help" ]; then echo "SESSION_ID --json --model --config --dangerously-bypass-approvals-and-sandbox read from stdin"; exit 0; fi',
  '    ;;',
  '  login) echo "Logged in using ChatGPT"; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  mutation,
  'echo \'{"type":"error","message":"agent execution failed"}\'',
  "exit 1",
].join("\n");

const successfulCodexMutationStub = (log: string, mutation: string): string => [
  "#!/bin/sh",
  `echo "$@" >> ${log}`,
  'case "$1" in',
  '  --version) echo "codex-cli 0.147.0"; exit 0 ;;',
  '  exec)',
  '    if [ "$2" = "--help" ]; then echo "resume --json --model --config --dangerously-bypass-approvals-and-sandbox"; exit 0; fi',
  '    if [ "$2" = "resume" ] && [ "$3" = "--help" ]; then echo "SESSION_ID --json --model --config --dangerously-bypass-approvals-and-sandbox read from stdin"; exit 0; fi',
  '    ;;',
  '  login) echo "Logged in using ChatGPT"; exit 0 ;;',
  "esac",
  "cat > /dev/null",
  mutation,
  'echo \'{"type":"thread.started","thread_id":"thread-mutation"}\'',
  'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"implemented"}}\'',
  'echo \'{"type":"turn.completed"}\'',
  "exit 0",
].join("\n");

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const seedRemote = async (root: string): Promise<string> => {
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "--initial-branch=master", remote);
  git(root, "init", "--initial-branch=master", seed);
  git(seed, "config", "user.name", "Anneal Test");
  git(seed, "config", "user.email", "runner@agentos.local");
  await writeFile(join(seed, "tree.txt"), "base\n");
  git(seed, "add", "tree.txt");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "master");
  return remote;
};

const commitFixtureChange = async (workspace: string): Promise<void> => {
  await writeFile(join(workspace, "runner-fixture.txt"), "delivered fixture change\n");
  git(workspace, "add", "runner-fixture.txt");
  git(workspace, "commit", "-m", "test: create delivered fixture change");
};

const seedCodexAuth = async (root: string): Promise<void> => {
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(join(root, ".codex", "auth.json"), '{"tokens":"test-only"}\n', { mode: 0o600 });
};

const seedPiAuth = async (root: string): Promise<void> => {
  await mkdir(join(root, ".pi", "agent"), { recursive: true });
  await writeFile(join(root, ".pi", "agent", "auth.json"), '{"openai-codex":{"type":"oauth"}}\n', { mode: 0o600 });
};

const removeRetainedSessionConfig = async (completion: { body: Record<string, unknown> }): Promise<void> => {
  const retained = /session CLI config retained at (.+)$/u.exec(String(completion.body.failureReason))?.[1];
  if (retained) await rm(dirname(retained), { recursive: true, force: true });
};

test("Codex provision auth failure is PROVISION, retains its root, and never spawns the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-provision-failure-"));
  try {
    const remote = await seedRemote(root);
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log")));
    await chmod(binary, 0o755);
    const configured = codexOnly(join(root, "workspaces"), root, binary);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CODEX,
      preflight: async () => { preflightCalls += 1; return { ok: true } as never; },
      start: async () => { startCalls += 1; throw new Error("CLI must not spawn"); },
    };
    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, { adapter });
    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal((completion.body.failureEnvelope as { phase?: string }).phase, "PROVISION");
    assert.match(String(completion.body.failureReason), /Unable to establish Codex authentication/u);
    const retained = /session CLI config retained at (.+)$/u.exec(String(completion.body.failureReason))?.[1];
    assert.ok(retained);
    assert.equal((await stat(retained)).isDirectory(), true);
    await rm(dirname(retained), { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex baseline-copy failure is PROVISION and never reaches preflight or the host config", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-baseline-failure-"));
  try {
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const configured = {
      ...codexOnly(join(root, "workspaces"), root, join(root, "codex-must-not-start")),
      sessionConfigBaselineRoot: join(root, "missing-baseline"),
    };
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CODEX,
      preflight: async () => { preflightCalls += 1; return { ok: true } as never; },
      start: async () => { startCalls += 1; throw new Error("host ~/.codex must never be used"); },
    };
    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, { adapter });
    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal((completion.body.failureEnvelope as { phase?: string }).phase, "PROVISION");
    assert.match(String(completion.body.failureReason), /Unable to create session CLI config root/u);
    assert.match(String(completion.body.failureReason), /missing-baseline/u);
    await removeRetainedSessionConfig(completion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex rejects a run-as config-root symlink in PROVISION without copying host auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-config-symlink-"));
  const sessionId = `session-codex-config-symlink-${root.slice(-6)}`;
  const sessionParent = join(await realpath(tmpdir()), "agentos-session-config", sessionId);
  try {
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const plantedTarget = join(root, "planted-target");
    await mkdir(plantedTarget);
    const launcher = join(root, "run-as.sh");
    await writeFile(launcher, [
      "#!/bin/sh",
      `planted_target=${JSON.stringify(plantedTarget)}`,
      'if [ "$1" = "/bin/sh" ] && [ "$4" = "agentos-codex-config" ]; then',
      '  ln -s "$planted_target" "$5"',
      'elif [ "$1" = "/bin/mkdir" ] && [ "$2" = "-m" ] && [ "$3" = "700" ]; then',
      '  case "$4" in */agentos-session-config/*/config) ln -s "$planted_target" "$4" ;; esac',
      "fi",
      'exec "$@"',
    ].join("\n"));
    await chmod(launcher, 0o755);
    const workspaceRoot = join(root, "workspaces");
    await mkdir(workspaceRoot);
    const configured = {
      ...codexOnly(workspaceRoot, root, join(root, "codex-must-not-start")),
      runAsPrefix: [launcher],
    };
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    let preflightCalls = 0;
    let startCalls = 0;
    const adapter: CliAdapter = {
      ...adapters.CODEX,
      preflight: async () => { preflightCalls += 1; return { ok: true } as never; },
      start: async () => { startCalls += 1; throw new Error("host ~/.codex must never be used"); },
    };
    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: { id: sessionId },
    }, { adapter });
    assert.equal(preflightCalls, 0);
    assert.equal(startCalls, 0);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal((completion.body.failureEnvelope as { phase?: string }).phase, "PROVISION");
    assert.match(String(completion.body.failureReason), /Unable to create session CLI config root/u);
    assert.match(String(completion.body.failureReason), /mkdir/u);
    assert.deepEqual(await readdir(plantedTarget), [], "neither baseline nor host auth may reach the symlink target");
    assert.equal((await stat(sessionParent)).mode & 0o777, 0o711, "the writable parent window must close after mkdir fails");
  } finally {
    await rm(sessionParent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/** The config the two tests below share: a real Codex stub, and nothing at all
 *  where the other two CLIs would be. */
const codexOnly = (workspaceRoot: string, root: string, codexBinary: string): RunnerConfig => ({
  ...config(workspaceRoot),
  home: root,
  path: process.env.PATH ?? "/usr/bin:/bin",
  binaries: { CLAUDE: join(root, "no-claude-here"), CODEX: codexBinary, PI: join(root, "no-pi-here") },
});

test("event delivery failures do not starve heartbeats and recover in seq order", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-event-heartbeat-isolation-"));
  try {
    const remote = await seedRemote(root);
    const configured = {
      ...config(join(root, "workspaces")),
      home: root,
      heartbeatIntervalMs: 20,
      apiTimeoutMs: 100,
      failedWorkspaceRetention: 0,
      binaries: { CLAUDE: join(root, "unused-claude"), CODEX: join(root, "unused-codex"), PI: join(root, "unused-pi") },
    };
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    let started = false;
    let heartbeatAttempts = 0;
    let eventAttempts = 0;
    let eventFailures = 0;
    let processExited = false;
    let recoverEvents = false;
    let resolveExit!: (evidence: Record<string, unknown>) => void;
    let resolveActiveFailures!: () => void;
    let resolveDeliveryHeartbeat!: () => void;
    let resolvePostExitFailure!: () => void;
    const exit = new Promise<Record<string, unknown>>((resolve) => { resolveExit = resolve; });
    const activeFailures = new Promise<void>((resolve) => { resolveActiveFailures = resolve; });
    const deliveryHeartbeat = new Promise<void>((resolve) => { resolveDeliveryHeartbeat = resolve; });
    const postExitFailure = new Promise<void>((resolve) => { resolvePostExitFailure = resolve; });
    const acceptedBatches: number[][] = [];
    const maybeResolveActiveFailures = (): void => {
      if (heartbeatAttempts >= 2 && eventFailures >= 2) resolveActiveFailures();
    };
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      posts.push({ path, body });
      if (path.endsWith("/start")) started = true;
      if (started && path.endsWith("/heartbeat")) {
        heartbeatAttempts += 1;
        if ((body.inFlightTool as { name?: string } | null)?.name === "delivery") resolveDeliveryHeartbeat();
        maybeResolveActiveFailures();
      }
      if (started && path.endsWith("/events")) {
        eventAttempts += 1;
        if (!recoverEvents) {
          eventFailures += 1;
          maybeResolveActiveFailures();
          if (processExited) resolvePostExitFailure();
          return new Response(JSON.stringify({ error: "events temporarily unavailable" }), { status: 503 });
        }
        acceptedBatches.push((body.events as Array<{ seq: number }>).map((event) => event.seq));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const adapter: CliAdapter = {
      ...adapters.CLAUDE,
      preflight: async () => ({ ok: true, cliVersion: "test", authMode: "test", capabilities: {} }),
      start: async (spec, sink) => {
        await commitFixtureChange(spec.workingDirectory);
        const now = new Date();
        sink({ source: "CLAUDE", type: "EVENT_A", payload: { text: "first" } });
        sink({ source: "CLAUDE", type: "EVENT_B", providerEventId: "provider-b", toolCallId: "tool-b", payload: { text: "second" } });
        sink({ source: "CLAUDE", type: "EVENT_C", payload: { text: "third" } });
        return {
          runner: "CLAUDE",
          child: { exitCode: null, signalCode: null } as never,
          pid: null,
          startedAt: now,
          lastProcessAliveAt: now,
          lastProgressEventAt: now,
          inFlightTool: null,
          providerConversationId: null,
          terminalEventSeen: true,
          terminalSuccess: true,
          terminationReason: null,
          sawError: false,
          providerError: null,
          piTurnCompleted: false,
          finalOutput: null,
          stdout: "",
          stderr: "",
          exit,
        } as never;
      },
      heartbeat: async (handle) => ({
        processAlive: true,
        lastProcessAliveAt: handle.lastProcessAliveAt,
        lastProgressEventAt: handle.lastProgressEventAt,
        inFlightTool: null,
      }),
      kill: async () => ({ signal: null, processAlive: false }),
    };

    const execution = executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CLAUDE",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, { adapter });

    await activeFailures;
    processExited = true;
    resolveExit({
      exitCode: 0,
      signal: null,
      terminalEventSeen: true,
      terminalSuccess: true,
      terminationReason: null,
      finalOutput: null,
      providerError: null,
      stdout: "",
      stderr: "",
    });
    await Promise.all([deliveryHeartbeat, postExitFailure]);
    recoverEvents = true;
    await execution;

    assert.ok(heartbeatAttempts >= 3, `expected active heartbeats plus a delivery heartbeat, got ${heartbeatAttempts}`);
    assert.ok(eventFailures >= 3, `expected failures across two active intervals and after exit, got ${eventFailures}`);
    assert.ok(eventAttempts > eventFailures, "the recovered endpoint must receive a retry");
    assert.deepEqual(acceptedBatches, [[0, 1, 2]], "the accepted retry must preserve order and carry each event once");
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(completion?.body.terminalSuccess, true, "event recovery must preserve successful completion");
    assert.equal(completion?.body.pushStatus, "SUCCEEDED", "the successful branch must still be delivered");
    const startIndex = posts.findIndex((post) => post.path.endsWith("/start"));
    const firstActiveHeartbeat = posts.findIndex((post, index) => index > startIndex && post.path.endsWith("/heartbeat") && post.body.processAlive === true);
    const eventAfterHeartbeat = posts.findIndex((post, index) => index > firstActiveHeartbeat && post.path.endsWith("/events"));
    assert.ok(firstActiveHeartbeat >= 0 && eventAfterHeartbeat > firstActiveHeartbeat, "heartbeat must be attempted before the interval event flush");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup reports Claude and Pi blocked, keeps their telemetry, and passes Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-gate-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log));
    await chmod(binary, 0o755);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

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

test("startup blocks a Codex CLI that lacks the exec protocol Anneal invokes", async () => {
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
    setControlPlane(async (_input: string | URL | Request, init?: RequestInit) => {
      posts.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    assert.deepEqual(
      await runStartupPreflight(codexOnly(join(root, "workspaces"), root, binary)),
      { CLAUDE: false, CODEX: false, PI: false },
    );
    const codex = posts.find((post) => post.body.runner === "CODEX" && "error" in post.body)!;
    assert.equal(codex.body.error, "cli-incompatible: the CLI does not expose the required Anneal exec protocol");
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
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls <= 2) throw new TypeError("fetch failed");
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
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
    setControlPlane(async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    });

    await assert.rejects(
      runStartupPreflight(codexOnly(join(root, "workspaces"), root, join(root, "codex")), {
        wait: async (attempt) => { waits.push(attempt); },
        onRetry: () => assert.fail("a deterministic refusal must not be retried"),
      }),
      /Anneal API 401/u,
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
    const configReportPath = join(root, "successful-config-root.txt");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log, { configReportPath }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const configured = codexOnly(join(root, "workspaces"), root, binary);
    // Startup first, exactly as `index.ts` orders it: the claim below runs on a
    // process that has just reported two of three backends blocked.
    assert.deepEqual(await runStartupPreflight(configured), { CLAUDE: false, CODEX: true, PI: false });
    const codexClaim = {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    } satisfies ClaimedTask;
    await executeClaim(configured, codexClaim);

    const started = posts.find((post) => post.path.endsWith("/start"));
    assert.ok(started, "a blocked Claude and Pi must not keep a Codex run from starting");
    assert.equal(started.body.cliVersion, "codex-cli 0.147.0");
    assert.equal(started.body.authMode, "chatgpt");
    const expectedPromptHash = createHash("sha256").update(buildPrompt(codexClaim)).digest("hex");
    assert.equal(started.body.promptHash, expectedPromptHash);
    assert.equal((started.body.manifest as Record<string, unknown>).promptHash, expectedPromptHash);
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(completion.body.terminalSuccess, true);
    assert.equal(completion.body.failureClass ?? null, null);
    assert.equal(completion.body.worktreeContainmentViolations, undefined);
    const configRoot = await readFile(configReportPath, "utf8");
    await assert.rejects(stat(configRoot), /ENOENT/u, "successful Codex runs must remove CODEX_HOME");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an outside worktree is reported without changing a successful run outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-worktree-containment-"));
  try {
    const workspaces = join(root, "workspaces");
    const outsideWorktree = join(root, "outside-worktree");
    const binary = join(root, "codex.sh");
    await writeFile(binary, successfulCodexMutationStub(
      join(root, "argv.log"),
      `git worktree add --detach '${outsideWorktree}' HEAD >/dev/null 2>&1; printf "delivered work\\n" > delivered.txt; git add delivered.txt; git commit -m "test: create delivered change" >/dev/null`,
    ));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(completion.body.terminalSuccess, true);
    assert.equal(completion.body.failureClass, undefined);
    assert.equal(completion.body.pushStatus, "SUCCEEDED");
    assert.equal(completion.body.cleanupStatus, "SUCCEEDED");
    assert.deepEqual(completion.body.worktreeContainmentViolations, [await realpath(outsideWorktree)]);
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex records success after reconnecting and reaching terminal completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-reconnect-recovered-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), {
      session: {
        lines: [
          'echo \'{"type":"error","message":"Reconnecting... 1/5"}\'',
          'echo \'{"type":"error","message":"Reconnecting... 2/5"}\'',
          'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"output persisted"}}\'',
          'echo \'{"type":"turn.completed"}\'',
        ],
        exitCode: 0,
      },
    }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(join(root, "workspaces"), root, binary), failedWorkspaceRetention: 0 }, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(completion.body.terminalSuccess, true);
    assert.equal(completion.body.failureReason ?? null, null);
    assert.equal(completion.body.output, "output persisted");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex preserves reconnect evidence when the stream ends before terminal completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-reconnect-interrupted-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), {
      session: {
        lines: ['echo \'{"type":"error","message":"Reconnecting... 3/5"}\''],
        exitCode: 1,
      },
    }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(join(root, "workspaces"), root, binary), failedWorkspaceRetention: 0 }, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(completion.body.terminalSuccess, false);
    assert.match(String(completion.body.failureReason), /Reconnecting\.\.\. 3\/5/u);
    await removeRetainedSessionConfig({ body: completion.body });
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex preserves reconnect evidence when terminal completion is followed by a nonzero exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-reconnect-nonzero-"));
  try {
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), {
      session: {
        lines: [
          'echo \'{"type":"error","message":"Reconnecting... 2/5"}\'',
          'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"not persisted"}}\'',
          'echo \'{"type":"turn.completed"}\'',
        ],
        exitCode: 1,
      },
    }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(join(root, "workspaces"), root, binary), failedWorkspaceRetention: 0 }, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(completion.body.terminalSuccess, false);
    assert.match(String(completion.body.failureReason), /Reconnecting\.\.\. 2\/5/u);
    await removeRetainedSessionConfig({ body: completion.body });
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed first completion request restores and retains CODEX_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-completion-failure-"));
  try {
    const configReportPath = join(root, "config-root.txt");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), { configReportPath }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    let completionAttempts = 0;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const post = { path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
      posts.push(post);
      if (post.path.endsWith("/complete") && completionAttempts++ === 0) {
        return new Response(JSON.stringify({ error: "completion unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim(codexOnly(join(root, "workspaces"), root, binary), {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    });

    const completions = posts.filter((post) => post.path.endsWith("/complete"));
    assert.equal(completions.length, 2);
    assert.equal(completions[0]!.body.terminalSuccess, true);
    assert.equal(completions[1]!.body.terminalSuccess, false);
    const configRoot = await readFile(configReportPath, "utf8");
    assert.match(String(completions[1]!.body.failureReason), new RegExp(`session CLI config retained at ${configRoot.replaceAll("/", "\\/")}$`, "u"));
    assert.equal((await stat(configRoot)).isDirectory(), true);
    await removeRetainedSessionConfig(completions[1]!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a suspended PI claim retains the session config root for reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-pi-waiting-inbox-"));
  const observed: { scratch?: AgentScratch } = {};
  try {
    const remote = await seedRemote(root);
    await seedPiAuth(root);
    const configured = config(join(root, "workspaces"));
    configured.home = root;

    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "PI",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "openai-codex/gpt-5.1-codex-max" },
      run: { ...mechanicalClaim.run, model: "openai-codex/gpt-5.1-codex-max", maxRunsPerTask: 3 },
      session: testSession(root),
    }, {
      provisionSessionConfig: async (runnerConfig, runner, provisionedScratch, options) => {
        observed.scratch = provisionedScratch;
        await provisionSessionConfig(runnerConfig, runner, provisionedScratch, options);
        throw Object.assign(new Error("run suspended for Inbox reply"), { status: 409, code: "WAITING_INBOX" });
      },
    });

    assert.ok(observed.scratch);
    assert.equal((await stat(observed.scratch.configRoot)).isDirectory(), true);
    await provisionSessionConfig(configured, "PI", observed.scratch, { reuse: true });
  } finally {
    if (observed.scratch) await cleanupAgentScratch(config(join(root, "workspaces")), observed.scratch).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("session-config cleanup failure does not turn delivered work into a failed run", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-codex-cleanup-failure-"));
  try {
    const configReportPath = join(root, "config-root.txt");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(join(root, "argv.log"), { configReportPath }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim(codexOnly(join(root, "workspaces"), root, binary), {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
      session: testSession(root),
    }, {
      cleanupAgentScratch: async (runnerConfig, scratch) => {
        await cleanupAgentScratch(runnerConfig, scratch, { retainConfigRoot: true });
        throw new Error("simulated config cleanup refusal");
      },
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(completion.body.terminalSuccess, true);
    assert.equal(completion.body.failureClass ?? null, null);
    assert.equal(completion.body.failureReason ?? null, null);
    assert.equal(completion.body.cleanupStatus, "FAILED");
    const configRoot = await readFile(configReportPath, "utf8");
    assert.match(String(completion.body.cleanupFailureReason), /simulated config cleanup refusal/u);
    assert.match(String(completion.body.cleanupFailureReason), /session CLI config retained at/u);
    assert.equal((await stat(configRoot)).isDirectory(), true);
    await rm(dirname(configRoot), { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default failed-workspace retention still salvages and records the exact durable ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, 'printf "work\\n" > recovered.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = codexOnly(workspaces, root, binary);

    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const salvage = "agentos/task-10/run-1";
    const publication = posts.find((post) => post.path.endsWith("/publication"));
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(publication?.body.pushedBranch, salvage);
    assert.equal(completion?.body.pushedBranch, salvage);
    assert.equal(completion?.body.cleanupStatus, "RETAINED");
    assert.equal(completion?.body.workspaceRetained, true);
    assert.ok(posts.indexOf(publication!) < posts.indexOf(completion!), "publication must precede terminal completion");
    assert.match(git(root, `--git-dir=${remote}`, "show-ref", `refs/heads/${salvage}`), new RegExp(`refs/heads/${salvage}$`, "u"));
    await access(join(workspaces, "run-10", "recovered.txt"));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead delivery lease still salvages before cleanup without terminal API authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dead-lease-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, 'printf "work\\n" > recovered.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    let started = false;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      posts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      if (path.endsWith("/start")) started = true;
      if (started && path.endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ error: "Stale fencing token" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 };

    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const salvage = "agentos/task-10/run-1";
    assert.equal(posts.find((post) => post.path.endsWith("/publication"))?.body.pushedBranch, salvage);
    assert.equal(posts.some((post) => post.path.endsWith("/complete")), false);
    assert.match(git(root, `--git-dir=${remote}`, "show-ref", `refs/heads/${salvage}`), new RegExp(`refs/heads/${salvage}$`, "u"));
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a heartbeat cancellation kills the provider group, acknowledges once, and retains the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-active-cancellation-"));
  try {
    const workspaces = join(root, "workspaces");
    const outsideWorktree = join(root, "outside-worktree");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, successfulCodexMutationStub(
      log,
      `git worktree add --detach '${outsideWorktree}' HEAD >/dev/null 2>&1; touch '${outsideWorktree}/ready'; sleep 30`,
    ));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    let started = false;
    let cancellationSent = false;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      posts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      if (path.endsWith("/start")) started = true;
      if (started && path.endsWith("/heartbeat") && !cancellationSent) {
        try {
          await access(join(outsideWorktree, "ready"));
        } catch {
          return new Response(JSON.stringify({ ok: true, cancellation: null }), { status: 200, headers: { "content-type": "application/json" } });
        }
        cancellationSent = true;
        return new Response(JSON.stringify({
          ok: false,
          cancellation: { requestId: "cancel-1", reason: "operator stop", requestedAt: new Date(0).toISOString() },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, cancellation: null }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), heartbeatIntervalMs: 20 };

    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const acknowledgements = posts.filter((post) => post.path.endsWith("/cancel/acknowledge"));
    assert.equal(acknowledgements.length, 1);
    assert.equal(acknowledgements[0]?.body.requestId, "cancel-1");
    assert.equal(acknowledgements[0]?.body.workspacePath, join(workspaces, "run-10"));
    assert.equal(acknowledgements[0]?.body.branch, "agentos/task-10/run-1");
    assert.deepEqual(acknowledgements[0]?.body.worktreeContainmentViolations, [await realpath(outsideWorktree)]);
    assert.equal(posts.some((post) => post.path.endsWith("/complete")), false);
    assert.equal(posts.some((post) => post.path.endsWith("/publication")), false);
    await access(join(workspaces, "run-10"));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean failed run records that there is nothing to salvage before cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-clean-failure-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 };

    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    assert.equal(posts.some((post) => post.path.endsWith("/publication")), false);
    assert.ok(posts.some((post) => post.path.endsWith("/activity")
      && String(post.body.body).includes("nothing to salvage")));
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(completion?.body.cleanupStatus, "SUCCEEDED");
    assert.equal(completion?.body.workspaceRetained, false);
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed-run salvage excludes worktrees created at the instructed in-workspace location", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-salvage-contained-worktree-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, [
      "mkdir -p .agentos/worktrees",
      "git worktree add --detach .agentos/worktrees/spike HEAD >/dev/null 2>&1",
      'printf "work\\n" > recovered.txt',
    ].join("; ")));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const salvage = "agentos/task-10/run-1";
    const salvagedPaths = git(root, `--git-dir=${remote}`, "ls-tree", "--name-only", salvage).split("\n");
    assert.ok(salvagedPaths.includes("recovered.txt"));
    assert.equal(salvagedPaths.some((path) => path.startsWith(".agentos")), false);
    assert.equal(posts.find((post) => post.path.endsWith("/complete"))?.body.worktreeContainmentViolations, undefined);
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed salvage keeps the workspace and reports cleanup failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-salvage-failure-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    const missingRemote = join(root, "missing-origin.git");
    await writeFile(binary, failingCodexStub(log,
      `printf "work\\n" > recovered.txt; git remote set-url origin ${missingRemote}`));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 };

    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(completion?.body.cleanupStatus, "FAILED");
    assert.equal(completion?.body.workspaceRetained, true);
    assert.match(String(completion?.body.cleanupFailureReason), /WIP salvage failed/u);
    await access(join(workspaces, "run-10", "recovered.txt"));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("successful execution with failed delivery salvages before removing the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-delivery-failure-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, successfulCodexMutationStub(log, 'printf "delivered work\\n" > recovered.txt; git add recovered.txt; git commit -m "test: create delivered change" >/dev/null'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, [
      "#!/bin/sh",
      "while read old new ref; do",
      '  [ "$ref" = "refs/heads/declared/head" ] && exit 1',
      "done",
      "exit 0",
    ].join("\n"));
    await chmod(hook, 0o755);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = { ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 };
    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: {
        ...mechanicalClaim.run,
        model: "gpt-5.6-sol",
        maxRunsPerTask: 3,
        branch: "declared/head",
      },
    });
    const salvage = "agentos/task-10/run-1";
    const publication = posts.find((post) => post.path.endsWith("/publication"));
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(completion?.body.terminalSuccess, false);
    assert.match(String(completion?.body.failureReason), /push|remote|receive/u);
    assert.equal(completion?.body.pushedBranch, salvage);
    assert.equal(completion?.body.cleanupStatus, "SUCCEEDED");
    assert.ok(posts.indexOf(publication!) < posts.indexOf(completion!), "salvage publication must precede cleanup completion");
    assert.match(git(root, `--git-dir=${remote}`, "show-ref", `refs/heads/${salvage}`), new RegExp(`refs/heads/${salvage}$`, "u"));
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a pull-request failure after publication keeps the primary delivery evidence and skips salvage", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-pr-failure-after-push-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    const gh = join(root, "gh");
    const githubRemote = "git@github.com:owner/name.git";
    await writeFile(binary, successfulCodexMutationStub(log, 'printf "delivered work\\n" > delivered.txt; git add delivered.txt; git commit -m "test: create delivered change" >/dev/null'));
    await chmod(binary, 0o755);
    await writeFile(gh, [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "GraphQL: Base branch was not found" 1>&2; exit 1; fi',
      "exit 1",
    ].join("\n"));
    await chmod(gh, 0o755);
    const remote = await seedRemote(root);
    git(root, "config", "--file", join(root, ".gitconfig"), `url.${remote}.insteadOf`, githubRemote);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = {
      ...codexOnly(workspaces, root, binary),
      path: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      failedWorkspaceRetention: 0,
    };

    await executeClaim(configured, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: githubRemote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: {
        ...mechanicalClaim.run,
        model: "gpt-5.6-sol",
        maxRunsPerTask: 3,
        opensPullRequest: true,
        branch: "declared/head",
      },
    });

    const publications = posts.filter((post) => post.path.endsWith("/publication"));
    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.deepEqual(publications.map((post) => post.body.pushedBranch), ["declared/head"]);
    assert.equal(completion?.body.terminalSuccess, false);
    assert.equal(completion?.body.pushStatus, "FAILED");
    assert.equal(completion?.body.pushedBranch, "declared/head");
    assert.match(String(completion?.body.failureReason), /Base branch was not found/u);
    assert.match(String(completion?.body.deliveryInstructions), /PR creation failed/u);
    assert.equal((completion?.body.failureEnvelope as { phase?: string }).phase, "DELIVER");
    assert.equal(git(root, `--git-dir=${remote}`, "branch", "--list", "agentos/task-10/run-1"), "");
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful pinned review never publishes its dirty detached checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-pinned-no-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, successfulCodexMutationStub(log, 'printf "review scratch\\n" > review.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const pinned = git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/master");
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: {
        ...mechanicalClaim.run,
        model: "gpt-5.6-sol",
        targetBranch: pinned,
        pinnedBaseSha: pinned,
        implementationBaseSha: pinned,
        implementationHeadSha: pinned,
      },
    });
    assert.equal(posts.some((post) => post.path.endsWith("/publication")), false);
    assert.equal(posts.find((post) => post.path.endsWith("/complete"))?.body.terminalSuccess, true);
    assert.throws(() => git(root, `--git-dir=${remote}`, "show-ref", "refs/heads/agentos/task-10/run-1"));
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed pinned review reports failure without publishing its dirty detached checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-failed-pinned-no-salvage-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, 'printf "review scratch\\n" > review.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const pinned = git(root, `--git-dir=${remote}`, "rev-parse", "refs/heads/master");
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: {
        ...mechanicalClaim.run,
        model: "gpt-5.6-sol",
        targetBranch: pinned,
        pinnedBaseSha: pinned,
        implementationBaseSha: pinned,
        implementationHeadSha: pinned,
      },
    });

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.equal(completion?.body.terminalSuccess, false);
    assert.match(String(completion?.body.failureReason), /agent execution failed/u);
    assert.equal(completion?.body.pushedBranch, undefined);
    assert.equal(posts.some((post) => post.path.endsWith("/publication")), false);
    assert.throws(() => git(root, `--git-dir=${remote}`, "show-ref", "refs/heads/agentos/task-10/run-1"));
    await assert.rejects(access(join(workspaces, "run-10")));
  } finally {
    await cleanupTestSession(root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead-lease salvage failure is durably reported and retains the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-dead-lease-salvage-failure-"));
  try {
    const workspaces = join(root, "workspaces");
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, failingCodexStub(log, 'printf "work\\n" > recovered.txt'));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const posts: Array<{ path: string; body: Record<string, any> }> = [];
    let started = false;
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      posts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, any> });
      if (path.endsWith("/start")) started = true;
      if (started && path.endsWith("/heartbeat")) {
        return new Response(JSON.stringify({ error: "Stale fencing token" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await executeClaim({ ...codexOnly(workspaces, root, binary), failedWorkspaceRetention: 0 }, {
      ...mechanicalClaim,
      executionMode: "agent",
      runner: "CODEX",
      session: testSession(root),
      repo: { ...mechanicalClaim.repo, remoteUrl: remote, defaultBranch: "master" },
      agent: { ...mechanicalClaim.agent, model: "gpt-5.6-sol" },
      run: { ...mechanicalClaim.run, model: "gpt-5.6-sol", maxRunsPerTask: 3 },
    });
    const cleanup = posts.find((post) => post.path.endsWith("/cleanup"));
    assert.equal(cleanup?.body.cleanupStatus, "FAILED");
    assert.equal(cleanup?.body.workspaceRetained, true);
    assert.match(String(cleanup?.body.cleanupFailureReason), /WIP salvage failed/u);
    assert.equal(posts.some((post) => post.path.endsWith("/complete")), false);
    await access(join(workspaces, "run-10", "recovered.txt"));
  } finally {
    await cleanupTestSession(root);
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
    const configReportPath = join(root, "failed-config-root.txt");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log, { authFails: true, configReportPath }));
    await chmod(binary, 0o755);
    const remote = await seedRemote(root);
    await seedCodexAuth(root);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

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
      session: testSession(root),
    });
    const completion = posts.find((post) => post.path.endsWith("/complete"))!;
    assert.equal(completion.body.terminalSuccess, false);
    assert.equal(completion.body.failureClass, "AUTH_REQUIRED");
    const configRoot = await readFile(configReportPath, "utf8");
    assert.equal((await stat(configRoot)).isDirectory(), true, "failed Codex runs retain CODEX_HOME");

    // Nothing the CLI printed is anywhere in what this process sent — not in the
    // preflight report, not in the run's failure envelope, not in its events.
    const wire = JSON.stringify(posts);
    for (const secret of SECRETS) assert.ok(!wire.includes(secret), `${secret} reached the control plane`);
    // And the login check itself is still the official one, unchanged.
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n").slice(0, 4), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
    await removeRetainedSessionConfig(completion);
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
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });

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
      session: testSession(root),
    });
    const completion = posts.find((post) => post.path.endsWith("/complete"))!;
    assert.equal(completion.body.failureClass, "BINARY_NOT_FOUND");
    assert.ok(!JSON.stringify(posts).includes("ENOENT"));
    await removeRetainedSessionConfig(completion);
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
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(null, { status: 200 });
    });

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

test("CLI availability uses an independent one-minute cadence with stable runner jitter", () => {
  const first = cliAvailabilityHeartbeatSchedule("runner-1");
  const same = cliAvailabilityHeartbeatSchedule("runner-1");
  const other = cliAvailabilityHeartbeatSchedule("runner-2");
  assert.deepEqual(first, same);
  assert.equal(first.intervalMs, 60_000);
  assert.ok(first.initialDelayMs >= 60_000 && first.initialDelayMs < 75_000);
  assert.notEqual(first.initialDelayMs, other.initialDelayMs);
});

test("an availability heartbeat runs one requested preflight and reports its recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-auth-recovery-"));
  try {
    const log = join(root, "codex-argv.log");
    const binary = join(root, "codex.sh");
    await writeFile(binary, codexStub(log));
    await chmod(binary, 0o755);
    const configured = codexOnly(join(root, "workspaces"), root, binary);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    setControlPlane(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path, body });
      const revalidatePreflight = path.endsWith("/runner/availability") && body.runner === "CODEX";
      return new Response(JSON.stringify({ revalidatePreflight }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await reportCliAvailabilityHeartbeat(configured);

    assert.ok(posts.filter((post) => post.path.endsWith("/runner/availability"))
      .every((post) => post.body.runnerId === configured.runnerId));
    const reports = posts.filter((post) => post.path.endsWith("/runner/preflight"));
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.body.runner, "CODEX");
    assert.equal(reports[0]?.body.ok, true);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "--version", "exec --help", "exec resume --help", "login status",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
