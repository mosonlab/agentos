import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { RUNNER_EXCEPTION_REASON } from "./envelope.js";
import { executeClaim } from "./runner.js";
import { cleanupAgentScratch } from "./workspace.js";

/**
 * What a failed run actually hands the API.
 *
 * Issue #114 is an API-side loss, but the claim it rests on is a runner-side
 * fact: `completeRun` carries the run's own output tail on *every* completion,
 * not only on the ones the API happened to keep. This test drives the real
 * `executeClaim` against a real clone and a real child process, so
 * `packages/api/src/run-output.dbtest.ts` can assert persistence against the
 * shape produced here rather than one invented there. Keep the two in step.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * A stub agent CLI. It answers the runner's real preflight — `--version`, then
 * `auth status` in the shape the CLAUDE adapter greps for — and then, on the
 * run itself, says something worth keeping and dies the way a failing agent
 * does. No stream-json, so `finalOutput` stays null and the tail the runner
 * sends is the raw stdout, which is the failure case exactly.
 */
const failingAgent = [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  '[ -z "$CONFIG_REPORT_PATH" ] || printf \'%s\' "$CLAUDE_CONFIG_DIR" > "$CONFIG_REPORT_PATH"',
  "cat > /dev/null",
  'echo "reproduced the deadlock: workers 3 and 7 both hold the inbox advisory lock"',
  'echo "the fix needs the lock ordering inverted in reconcile.ts"',
  ">&2 echo 'Error: session ended without a result'",
  "exit 1",
].join("\n");

/**
 * The same stub, succeeding: it emits the CLAUDE adapter's terminal `result`
 * event, so `finalOutput` — not stdout — is what the runner sends as the tail.
 * Both cases have to reach the API for a run's own account of itself to be
 * readable afterwards, whichever way the run went.
 */
const succeedingAgent = [
  "#!/bin/sh",
  'case "$1" in',
  '  --version) echo "1.2.3-stub"; exit 0 ;;',
  '  auth) echo \'{"loggedIn": true, "authMethod": "stub"}\'; exit 0 ;;',
  "esac",
  '[ -z "$CONFIG_REPORT_PATH" ] || printf \'%s\' "$CLAUDE_CONFIG_DIR" > "$CONFIG_REPORT_PATH"',
  "cat > /dev/null",
  'echo \'{"type":"result","is_error":false,"terminal_reason":"completed",'
  + '"result":"inverted the lock ordering in reconcile.ts and added the regression test"}\'',
  "exit 0",
].join("\n");

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

const config = (workspaceRoot: string, agentBinary: string): RunnerConfig => ({
  apiUrl: "http://api.invalid",
  runnerToken: "runner-token",
  runnerId: "runner-1",
  daemonVersion: "0.0.0-test",
  pollIntervalMs: 5_000,
  leaseSeconds: 60,
  heartbeatIntervalMs: 60_000,
  path: process.env.PATH ?? "/usr/bin:/bin",
  home: workspaceRoot,
  proxyEnvironment: {},
  claudeCodeOAuthToken: "test-setup-token",
  sessionConfigBaselineRoot: join(import.meta.dirname, "..", "assets", "session-config-baseline"),
  workspaceRoot,
  failedWorkspaceRetention: 0,
  workspaceReclaimIntervalMs: 300_000,
  toolDeadlineMs: 60_000,
  apiTimeoutMs: 5_000,
  runAsPrefix: [],
  binaries: { CLAUDE: agentBinary, CODEX: agentBinary, PI: agentBinary },
});

const claim = (remoteUrl: string, configReportPath?: string, sessionId = "session-114"): ClaimedTask => ({
  executionMode: "agent",
  task: {
    id: "task-114",
    name: "Find the inbox deadlock",
    description: "work",
    repoId: "repo-1",
    targetBranch: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 1,
    templateStep: null,
  },
  agent: {
    id: "agent-1", name: "agent", model: "claude", foundationalPrompt: "f", rolePrompt: "r", disabledTools: [],
  },
  repo: { id: "repo-1", remoteUrl, defaultBranch: "master", mountPath: "/does/not/exist" },
  run: {
    id: "run-114",
    runNumber: 1,
    opensPullRequest: false,
    pullRequestBase: "master",
    maxDurationMin: 30,
    stallTimeoutMin: 10,
    // One run, so nothing in this test depends on a retry being created.
    maxRunsPerTask: 1,
    model: "claude",
    targetBranch: "master",
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    promptHash: "hash",
    workspacePath: null,
    branch: null,
    baseSha: null,
  },
  session: { id: sessionId },
  resume: null,
  nextEventSeq: 0,
  runner: "CLAUDE",
  fencingToken: "fence-1",
  sessionToken: "session-token",
  secrets: configReportPath ? { CONFIG_REPORT_PATH: configReportPath } : {},
  priorOutputs: [],
});

/**
 * The succeeding stub again, with one addition: it drops a sentinel file on its
 * way out. The fetch stub below watches for that file, so a request can be
 * failed *after* the agent has finished and not before — which is the only
 * window in which the runner holds output it could still lose.
 */
const succeedingAgentThatSignalsExit = (sentinel: string): string =>
  succeedingAgent.replace(/exit 0$/u, `touch ${sentinel}\nexit 0`);

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("a failed run's completion carries the output tail the run produced", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "failing-agent.sh");
    await writeFile(agentBinary, failingAgent);
    await chmod(agentBinary, 0o755);
    const configReportPath = join(root, "failed-config-root.txt");

    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await executeClaim(config(join(root, "workspaces"), agentBinary), claim(remote, configReportPath, "session-114-failed"));

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion, "the run must complete even though the agent failed");
    assert.equal(completion.body.terminalSuccess, false, "this is the failing case, not a success in disguise");
    // The two facts issue #114 turns on: the tail exists on the wire, and it is
    // the agent's own account of what it found — the thing that used to be
    // dropped by the handler that received it.
    assert.equal(typeof completion.body.output, "string");
    assert.match(
      String(completion.body.output),
      /reproduced the deadlock: workers 3 and 7 both hold the inbox advisory lock/,
    );
    assert.match(String(completion.body.output), /lock ordering inverted in reconcile\.ts$/);
    const configRoot = await readFile(configReportPath, "utf8");
    assert.match(String(completion.body.failureReason), new RegExp(`session CLI config retained at ${configRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"));
    assert.equal((await stat(configRoot)).isDirectory(), true);
    assert.equal((await stat(join(configRoot, "settings.json"))).isFile(), true);
    await rm(configRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful run's completion carries its final output as the same tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-ok-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "succeeding-agent.sh");
    await writeFile(agentBinary, succeedingAgent);
    await chmod(agentBinary, 0o755);
    const configReportPath = join(root, "successful-config-root.txt");

    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await executeClaim(config(join(root, "workspaces"), agentBinary), claim(remote, configReportPath, "session-114-success"));

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion, "the run must complete");
    assert.equal(completion.body.terminalSuccess, true);
    assert.equal(
      completion.body.output,
      "inverted the lock ordering in reconcile.ts and added the regression test",
    );
    const configRoot = await readFile(configReportPath, "utf8");
    await assert.rejects(stat(configRoot), /ENOENT/u, "successful completion must remove the session CLI config root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WAITING_INBOX resume reuses one session config root and terminal success removes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-config-resume-"));
  try {
    const remote = await seedRemote(root);
    const firstReport = join(root, "first-config.txt");
    const resumedReport = join(root, "resumed-config.txt");
    const agentBinary = join(root, "resume-agent.sh");
    await writeFile(agentBinary, [
      "#!/bin/sh",
      'case "$1" in --version) echo "1.2.3-stub"; exit 0;; auth) echo \'{"loggedIn":true,"authMethod":"stub"}\'; exit 0;; esac',
      'case " $* " in *" --resume "*)',
      '  test -f "$CLAUDE_CONFIG_DIR/session-sentinel" || exit 41',
      `  printf '%s' "$CLAUDE_CONFIG_DIR" > ${resumedReport}`,
      "  ;;",
      "*)",
      '  printf first > "$CLAUDE_CONFIG_DIR/session-sentinel"',
      `  printf '%s' "$CLAUDE_CONFIG_DIR" > ${firstReport}`,
      "  ;;",
      "esac",
      "cat > /dev/null",
      'echo \'{"type":"result","is_error":false,"terminal_reason":"completed","result":"resumed"}\'',
      "exit 0",
    ].join("\n"));
    await chmod(agentBinary, 0o755);

    let suspendNextHeartbeat = true;
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      posts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (suspendNextHeartbeat && path.endsWith("/heartbeat") && existsSync(firstReport)) {
        suspendNextHeartbeat = false;
        return new Response(JSON.stringify({ code: "WAITING_INBOX" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const runnerConfig = config(join(root, "workspaces"), agentBinary);
    const initial = claim(remote, undefined, "session-114-resume");
    await executeClaim(runnerConfig, initial);
    assert.equal(posts.some((post) => post.path.endsWith("/complete")), false);
    const firstConfig = await readFile(firstReport, "utf8");
    assert.equal((await stat(join(firstConfig, "session-sentinel"))).isFile(), true);

    const workspacePath = join(runnerConfig.workspaceRoot, initial.run.id);
    const resumed: ClaimedTask = {
      ...initial,
      run: {
        ...initial.run,
        workspacePath,
        branch: git(workspacePath, "branch", "--show-current"),
        baseSha: git(workspacePath, "rev-parse", "HEAD"),
      },
      resume: { providerConversationId: "conversation-114", input: "continue" },
      fencingToken: "fence-2",
      sessionToken: "session-token-2",
    };
    await executeClaim(runnerConfig, resumed);

    assert.equal(await readFile(resumedReport, "utf8"), firstConfig);
    await assert.rejects(stat(firstConfig), /ENOENT/u);
    const completion = posts.filter((post) => post.path.endsWith("/complete")).at(-1);
    assert.equal(completion?.body.terminalSuccess, true);
    // PI keeps its conversation under workspace/.agentos-pi via --session-dir;
    // this config-home continuity requirement applies to Claude and Codex.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a terminal config cleanup failure changes success into a visible retained failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-config-cleanup-failure-"));
  try {
    const remote = await seedRemote(root);
    const agentBinary = join(root, "succeeding-agent.sh");
    await writeFile(agentBinary, succeedingAgent);
    await chmod(agentBinary, 0o755);
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    let cleanupCalls = 0;
    await executeClaim(
      config(join(root, "workspaces"), agentBinary),
      claim(remote, undefined, "session-114-cleanup-failure"),
      {
        cleanupAgentScratch: async (runnerConfig, scratch, options) => {
          cleanupCalls += 1;
          if (cleanupCalls === 1) throw new Error("EACCES deleting other-uid config root");
          await cleanupAgentScratch(runnerConfig, scratch, options);
        },
      },
    );

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion);
    assert.equal(completion.body.terminalSuccess, false);
    assert.equal(completion.body.cleanupStatus, "FAILED");
    assert.match(String(completion.body.cleanupFailureReason), /EACCES deleting other-uid config root/u);
    const retained = /session CLI config retained at (.+)$/u.exec(String(completion.body.failureReason))?.[1];
    assert.ok(retained);
    assert.equal((await stat(retained)).isDirectory(), true);
    await rm(retained, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output the agent already produced survives a delivery-phase failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-deliver-"));
  try {
    const remote = await seedRemote(root);
    const sentinel = join(root, "agent-exited");
    const agentBinary = join(root, "agent.sh");
    await writeFile(agentBinary, succeedingAgentThatSignalsExit(sentinel));
    await chmod(agentBinary, 0o755);

    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      posts.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      // The event flush the runner performs once the agent is gone, on its way
      // into delivery. A dropped connection there is ordinary — and it throws
      // out of the try block, into the catch that reports the run.
      if (path.endsWith("/events") && existsSync(sentinel)) throw new Error("connection reset by peer");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await executeClaim(config(join(root, "workspaces"), agentBinary), claim(remote, undefined, "session-114-deliver"));

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion, "the run must still be completed");
    // The failure is the runner's own, reported as such: this is the exception
    // path, not the ordinary one.
    assert.equal(completion.body.terminationReason, RUNNER_EXCEPTION_REASON);
    assert.match(String(completion.body.failureReason), /connection reset by peer/);
    // And the agent's work is still in it. This path used to rebuild its
    // evidence from the error message alone, so a run that had produced a real
    // answer reported nothing but the plumbing fault that followed it.
    assert.equal(
      completion.body.output,
      "inverted the lock ordering in reconcile.ts and added the regression test",
    );
    const retained = /session CLI config retained at (.+)$/u.exec(String(completion.body.failureReason))?.[1];
    assert.ok(retained);
    await rm(retained, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run that fails before its agent exists sends no output at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-output-none-"));
  try {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ path: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    // A remote no clone can reach: the run dies in PROVISION, before any agent
    // has run. The carried tail must stay null rather than report an empty
    // string as if the agent had produced nothing.
    await executeClaim(
      config(join(root, "workspaces"), join(root, "never-spawned.sh")),
      claim("/nonexistent/agentos-issue-114-no-such-repo.git"),
    );

    const completion = posts.find((post) => post.path.endsWith("/complete"));
    assert.ok(completion, "a provisioning failure still completes the run");
    assert.equal(completion.body.output ?? null, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
