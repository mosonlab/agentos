import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  adapterExecutionSucceeded, adapters, argsForRunner, buildChildEnvironment, buildPrompt, failureReasonFromEvidence,
  claudePlatformSettingsPath, inputForRunner, launchArgv, mcpConfig, mcpServerPath, nodeBinaryPath, piExtensionPath,
  runtimeDescriptor, type ExitEvidence,
} from "./adapters.js";
import type { ClaimedTask } from "./api.js";
import type { RunnerConfig, RunnerKind } from "./config.js";
import { cleanupAgentScratch, provisionAgentScratch } from "./workspace.js";

const claim: ClaimedTask = {
  executionMode: "agent",
  task: {
    id: "task-1",
    name: "Ship it",
    description: "Do the work",
    repoId: "repo-1",
    targetBranch: "main",
    maxDurationMin: 120,
    stallTimeoutMin: 10,
    maxSessionsPerTask: 3,
  },
  agent: { id: "agent-1", name: "senior-dev", model: "codex", foundationalPrompt: "Foundation", rolePrompt: "Implement", disabledTools: [] },
  repo: { id: "repo-1", remoteUrl: "/repo", defaultBranch: "main", mountPath: "repo" },
  run: {
    id: "run-1",
    runNumber: 1,
    opensPullRequest: true,
    pullRequestBase: "main",
    maxDurationMin: 120,
    stallTimeoutMin: 10,
    maxRunsPerTask: 3,
    model: "codex",
    codexServiceTier: "DEFAULT",
    subprocessModel: null,
    subprocessCodexServiceTier: null,
    elevatedSubprocessModel: null,
    elevatedSubprocessCodexServiceTier: null,
    targetBranch: "main",
    targetBranchPublished: false,
    pinnedBaseSha: null,
    implementationBaseSha: null,
    implementationHeadSha: null,
    promptHash: "hash",
    workspacePath: null,
    branch: null,
    baseSha: null,
  },
  session: { id: "session-1" },
  resume: null,
  nextEventSeq: 0,
  runner: "CODEX",
  fencingToken: "1:run-1:token",
  sessionToken: "agos_session_secret",
  secrets: { ALLOWED_SECRET: "secret" },
  priorOutputs: [],
  previousRunHandoff: null,
  regressionRepairHandoff: null,
};

const scratch = {
  base: "/scratch/run-1",
  workspaceRoot: "/scratch/run-1/workspaces",
  stateDir: "/scratch/run-1/control-plane",
  configRoot: "/scratch/run-1/codex-config",
};
const productionRoot = join(homedir(), ".agentos", "runs");

const runSpec = (disabledTools: string[] = []) => ({
  config: { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix: [] } as unknown as RunnerConfig,
  claim: { ...claim, agent: { ...claim.agent, disabledTools } },
  workingDirectory: "/work",
  env: {},
  prompt: "prompt",
  credentialsPath: "/work/.agentos/session.json",
});

const stableArgv = (args: string[]): string[] => args.map((arg) => arg
  .replaceAll(process.execPath, "<NODE>")
  .replaceAll(mcpServerPath(), "<MCP_SERVER>")
  .replaceAll(piExtensionPath(), "<PI_EXTENSION>")
  .replaceAll(claudePlatformSettingsPath(), "<CLAUDE_SETTINGS>"));

test("buildPrompt combines foundational, role, and task context", () => {
  assert.match(buildPrompt(claim), /Foundation[\s\S]*Role \(senior-dev\): Implement[\s\S]*Task: Ship it[\s\S]*Do the work/);
});

test("buildPrompt makes the platform-pinned pull request base comparison and merge authority", () => {
  const retriedClaim = {
    ...claim,
    task: { ...claim.task, targetBranch: "stale-task-value", description: "Refresh onto the current target branch." },
    run: { ...claim.run, runNumber: 2, pullRequestBase: "release/1.x" },
  };
  const prompt = buildPrompt(retriedClaim);
  assert.match(prompt, /Platform-pinned run authority \(not task-authored text\):/u);
  assert.match(prompt, /run\.pullRequestBase: release\/1\.x/u);
  assert.match(prompt, /run\.pullRequestBase is authoritative for comparison and merge authorization/u);
  assert.match(prompt, /not authority to rewrite the checked-out branch/u);
  assert.doesNotMatch(prompt, /fetch and refresh/u);
  assert.doesNotMatch(prompt, /Template-chain append-only handoff contract:/u);
  assert.doesNotMatch(prompt, /checked-out starting commit is append-only shared lineage and handoff state/u);
  assert.match(prompt, /Task: Ship it[\s\S]*Refresh onto the current target branch\./u);
});

test("buildPrompt protects template-chain handoff lineage from contradictory task instructions", () => {
  const templateClaim = {
    ...claim,
    task: {
      ...claim.task,
      templateStep: { name: "Review implementation" },
      description: "Fetch and refresh onto the current target branch; rebase and force-push if needed.",
    },
    run: { ...claim.run, pullRequestBase: "release/1.x" },
  };
  const prompt = buildPrompt(templateClaim);
  assert.match(prompt, /Template-chain append-only handoff contract:/u);
  assert.match(prompt, /checked-out starting commit is append-only shared lineage and handoff state/u);
  assert.match(prompt, /Final HEAD must descend from it and remain fast-forward publishable/u);
  assert.match(prompt, /Fetch origin\/<run\.pullRequestBase> for comparison only by default/u);
  assert.match(prompt, /a normal merge commit into the checked-out branch is permitted/u);
  assert.match(prompt, /because it preserves the starting commit and fast-forward publishability/u);
  assert.match(prompt, /Task-authored instructions to rewrite the starting commit[\s\S]*are a workflow error: stop and report the conflict/u);
  assert.match(prompt, /Task: Ship it[\s\S]*Fetch and refresh onto the current target branch; rebase and force-push if needed\./u);
});

test("buildPrompt exposes a pinned implementation range without predecessor outputs", () => {
  const pinned = {
    ...claim,
    run: {
      ...claim.run,
      pinnedBaseSha: "b".repeat(40),
      implementationBaseSha: "a".repeat(40),
      implementationHeadSha: "b".repeat(40),
    },
  };
  const prompt = buildPrompt(pinned);
  assert.match(prompt, new RegExp(`implementationBaseSha: ${"a".repeat(40)}`));
  assert.match(prompt, new RegExp(`implementationHeadSha: ${"b".repeat(40)}`));
  assert.doesNotMatch(prompt, /Persisted outputs from prior template steps/u);
});

test("buildPrompt gives a fresh Regression session only the head-bound repair handoff", () => {
  const repaired = {
    ...claim,
    priorOutputs: [{ kind: "must-fix", body: "MF-2", task: { name: "Adjudication", chainIndex: 3 } }],
    regressionRepairHandoff: {
      schemaVersion: 1 as const,
      trigger: {
        kind: "regression-verdict" as const,
        verdict: {
          schemaVersion: 1 as const,
          outcome: "review-fail" as const,
          headSha: "a".repeat(40),
          baseHeadSha: "b".repeat(40),
          summary: "MF-2 remains open",
        },
      },
      repair: {
        kind: "review-fix" as const,
        taskId: "repair-1",
        startHeadSha: "a".repeat(40),
        targetHeadSha: "b".repeat(40),
        resolvedHeadSha: "c".repeat(40),
        outputKind: "result",
        outputBody: "Closed MF-2 and reran its focused regression.",
      },
    },
  };
  const prompt = buildPrompt(repaired);
  assert.match(prompt, /Persisted outputs from prior template steps:[\s\S]*MF-2[\s\S]*Platform-pinned regression repair handoff:/u);
  assert.match(prompt, /fresh provider session; do not assume any prior conversation state/u);
  assert.match(prompt, /MF-2 remains open/u);
  assert.match(prompt, new RegExp(`resolvedHeadSha":"${"c".repeat(40)}`));
  assert.match(prompt, /Closed MF-2 and reran its focused regression/u);
  assert.match(prompt, /verify the checked-out starting HEAD equals repair\.resolvedHeadSha/u);
});

test("buildPrompt gives a retry the immediate prior output without reusing provider context", () => {
  const prompt = buildPrompt({
    ...claim,
    previousRunHandoff: {
      schemaVersion: 1,
      previousRunId: "run-1",
      status: "SUCCEEDED",
      failureReason: null,
      retryReason: "approval-rejected-without-feedback",
      output: { kind: "plan", body: "Prior plan body", commitSha: "a".repeat(40) },
    },
  });
  assert.match(prompt, /Platform-pinned previous-run handoff:[\s\S]*Prior plan body/u);
  assert.match(prompt, /fresh provider Session/u);
  assert.match(prompt, /approval-rejected-without-feedback/u);
  assert.match(prompt, /Use inbox_ask to obtain the required change/u);
});

test("the prompt manifest names the AgentOS tools the session actually got", () => {
  const prompt = buildPrompt(claim);
  // All eight, not the original four: tools/list advertises eight, and a session that is
  // told about four cannot know what it was actually granted.
  for (const tool of [
    "task_activity_log", "task_output", "task_status", "inbox_ask",
    "files_list", "files_read", "files_write", "files_delete",
  ]) assert.match(prompt, new RegExp(tool));
  assert.match(prompt, /without a grant they return 403/);
  // codex/claude see MCP tool names; pi gets the same tools as extension tools.
  assert.match(prompt, /MCP server 'agentos'/);
  assert.match(buildPrompt({ ...claim, runner: "PI" }), /pi extension tools/);
});

test("every CLI is launched with the AgentOS tool surface attached", () => {
  const spec = runSpec();
  const claude = argsForRunner("CLAUDE", spec);
  const config = JSON.parse(claude[claude.indexOf("--mcp-config") + 1]!) as ReturnType<typeof mcpConfig>;
  assert.deepEqual(config.mcpServers.agentos!.args, [
    ...[config.mcpServers.agentos!.args[0]!], "--credentials", "/work/.agentos/session.json",
  ]);
  // Strict config keeps the operator's personal MCP servers out of agent sessions.
  assert.ok(claude.includes("--strict-mcp-config"));

  // codex scrubs the environment of MCP servers, so the credentials file is the
  // only channel that reaches it; the tokens themselves stay out of argv.
  const codex = argsForRunner("CODEX", spec).join(" ");
  assert.match(codex, /mcp_servers\.agentos\.command=/);
  assert.match(codex, /--credentials/);
  assert.equal(codex.includes(claim.sessionToken), false);

  assert.ok(argsForRunner("PI", spec).includes("--extension"));
  // Resumed sessions keep the tools; a resume without them silently drops them.
  const resumed = argsForRunner("CODEX", spec, { ...spec, providerConversationId: "thread-1", input: "again" });
  assert.match(resumed.join(" "), /mcp_servers\.agentos\.command=/);
});

test("Claude excludes host settings and auto-memory with the versioned platform settings file", async () => {
  const spec = runSpec();
  const claude = argsForRunner("CLAUDE", spec);
  assert.deepEqual(claude.slice(claude.indexOf("--setting-sources"), claude.indexOf("--setting-sources") + 2), [
    "--setting-sources", "project,local",
  ]);
  const settingsIndex = claude.indexOf("--settings");
  assert.ok(settingsIndex >= 0);
  assert.equal(claude[settingsIndex + 1], claudePlatformSettingsPath());
  assert.deepEqual(JSON.parse(await readFile(claudePlatformSettingsPath(), "utf8")), { autoMemoryEnabled: false });
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [] },
    { ...claim, runner: "CLAUDE", secrets: { ...claim.secrets, CLAUDE_CONFIG_DIR: "/host/.claude" } },
    scratch,
    "/work",
  );
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.HOME, "/runner", "Claude keeps the runner's existing HOME/authentication path");
});

test("Claude's staged platform settings path is overridable and published", () => {
  const previous = process.env.RUNNER_CLAUDE_SETTINGS_PATH;
  try {
    process.env.RUNNER_CLAUDE_SETTINGS_PATH = "/opt/agentos/lib/claude-platform-settings.json";
    assert.equal(claudePlatformSettingsPath(), "/opt/agentos/lib/claude-platform-settings.json");
    assert.equal(JSON.parse(runtimeDescriptor("runner-1", [])).claudeSettingsPath, "/opt/agentos/lib/claude-platform-settings.json");
  } finally {
    if (previous === undefined) delete process.env.RUNNER_CLAUDE_SETTINGS_PATH;
    else process.env.RUNNER_CLAUDE_SETTINGS_PATH = previous;
  }
});

test("runner proxy environment wins over task secrets for Claude, Codex, and Pi", () => {
  const config = {
    path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [],
    proxyEnvironment: { HTTP_PROXY: "http://runner-http", HTTPS_PROXY: "http://runner-https", NO_PROXY: "localhost" },
  };
  for (const runner of ["CLAUDE", "CODEX", "PI"] as const) {
    const env = buildChildEnvironment(
      config,
      { ...claim, runner, secrets: { ...claim.secrets, HTTP_PROXY: "http://task-http", HTTPS_PROXY: "http://task-https", NO_PROXY: "task" } },
      scratch,
      "/work",
    );
    assert.equal(env.HTTP_PROXY, "http://runner-http");
    assert.equal(env.HTTPS_PROXY, "http://runner-https");
    assert.equal(env.NO_PROXY, "localhost");
  }
});

test("a credential-bearing runner proxy stays in env and out of run-as argv", () => {
  const proxyUrl = ["http://proxy-user:", "proxy-pass@", "proxy.invalid:7897"].join("");
  const config = {
    path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: ["sudo", "-E", "--"],
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    proxyEnvironment: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl },
  };
  const env = buildChildEnvironment(config, { ...claim, runner: "PI" }, scratch, "/work");
  const launch = launchArgv(config, "PI", ["--version"], env);
  const argv = [launch.executable, ...launch.args].join(" ");
  assert.equal(env.HTTP_PROXY, proxyUrl);
  assert.equal(env.HTTPS_PROXY, proxyUrl);
  assert.equal(argv.includes(proxyUrl), false);
  assert.equal(argv.includes("proxy-pass"), false);
  assert.match(argv, /RUNNER_WORKSPACE_ROOT=/u);
  assert.match(argv, /CONTROL_PLANE_STATE_DIR=/u);
});

test("the interpreter the CLI is told to run the MCP server with is overridable and published", () => {
  // process.execPath is a *resolved* path — a Homebrew Cellar or nvm directory,
  // not the symlink on RUNNER_PATH. Under a run-as prefix the CLI is a different
  // account, and if that account cannot traverse the resolved path the failure
  // arrives as an MCP protocol error inside an agent session. The override lets a
  // deployment name an interpreter both principals can execute; the descriptor
  // publishes whichever one is in force so it can be checked from outside.
  const previous = process.env.RUNNER_NODE_BINARY;
  try {
    delete process.env.RUNNER_NODE_BINARY;
    assert.equal(nodeBinaryPath(), process.execPath);
    assert.equal(mcpConfig("/work/.agentos/session.json").mcpServers.agentos!.command, process.execPath);

    process.env.RUNNER_NODE_BINARY = "/opt/agentos/bin/node";
    assert.equal(nodeBinaryPath(), "/opt/agentos/bin/node");
    // Both CLIs, not just claude: codex builds its command through a separate path.
    assert.equal(mcpConfig("/work/.agentos/session.json").mcpServers.agentos!.command, "/opt/agentos/bin/node");
    assert.ok(argsForRunner("CODEX", runSpec()).includes("mcp_servers.agentos.command=\"/opt/agentos/bin/node\""));

    const descriptor = JSON.parse(runtimeDescriptor("runner-1", ["sudo", "-u", "_agentos1", "-E", "--"]));
    assert.equal(descriptor.runtime, "agentos-runner");
    assert.equal(descriptor.nodeBinary, "/opt/agentos/bin/node");
    // The real execPath stays visible too: verify.sh checks the override is in
    // force rather than inferring it from a path that happens to be readable.
    assert.equal(descriptor.nodeExecPath, process.execPath);
    assert.equal(descriptor.mcpServerPath, mcpServerPath());
    assert.equal(descriptor.piExtensionPath, piExtensionPath());
    assert.equal(descriptor.claudeSettingsPath, claudePlatformSettingsPath());
    assert.match(descriptor.codexBaselinePath, /session-config-baseline\/codex\/config\.toml$/u);
    assert.equal(descriptor.runAsPrefix, "sudo -u _agentos1 -E --");
  } finally {
    if (previous === undefined) delete process.env.RUNNER_NODE_BINARY;
    else process.env.RUNNER_NODE_BINARY = previous;
  }
});

test("an empty denied set keeps every runner argv byte-identical", () => {
  const spec = runSpec();
  assert.deepEqual(stableArgv(argsForRunner("CLAUDE", spec)), [
    "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose",
    "--model", "codex", "--effort", "high",
    "--setting-sources", "project,local", "--settings", "<CLAUDE_SETTINGS>",
    "--mcp-config", "{\"mcpServers\":{\"agentos\":{\"type\":\"stdio\",\"command\":\"<NODE>\",\"args\":[\"<MCP_SERVER>\",\"--credentials\",\"/work/.agentos/session.json\"]}}}",
    "--strict-mcp-config",
  ]);
  assert.deepEqual(stableArgv(argsForRunner("CODEX", spec)), [
    "exec", "--json", "-m", "codex",
    "-c", "service_tier=\"default\"",
    "-c", "mcp_servers.agentos.command=\"<NODE>\"",
    "-c", "mcp_servers.agentos.args=[\"<MCP_SERVER>\",\"--credentials\",\"/work/.agentos/session.json\"]",
    "-c", "mcp_servers.agentos.startup_timeout_sec=30",
    "--dangerously-bypass-approvals-and-sandbox", "-",
  ]);
  assert.deepEqual(stableArgv(argsForRunner("PI", spec)), [
    "-p", "--mode", "json", "--session-dir", "/work/.agentos-pi", "--model", "codex",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--extension", "<PI_EXTENSION>",
  ]);
});

test("Codex fresh and resume launches pin the Run service tier explicitly", () => {
  const fast = runSpec();
  fast.claim = {
    ...fast.claim,
    run: { ...fast.claim.run, model: "gpt-5.6-luna:max", codexServiceTier: "FAST" },
  };
  const resume = { ...fast, providerConversationId: "thread-fast", input: "continue" };
  for (const args of [argsForRunner("CODEX", fast), argsForRunner("CODEX", fast, resume)]) {
    assert.ok(args.includes('service_tier="fast"'));
    assert.ok(args.includes('model_reasoning_effort="max"'));
    assert.ok(args.includes("gpt-5.6-luna"));
  }
});

test("executioner child environment exposes both snapshotted subprocess profiles", () => {
  const executioner = {
    ...claim,
    agent: { ...claim.agent, name: "implementation-plan-executioner" },
    run: {
      ...claim.run,
      subprocessModel: "gpt-5.6-luna:max",
      subprocessCodexServiceTier: "FAST" as const,
      elevatedSubprocessModel: "gpt-5.6-sol:high",
      elevatedSubprocessCodexServiceTier: "DEFAULT" as const,
    },
    secrets: {
      ...claim.secrets,
      AGENTOS_ORDINARY_CODEX_SUBPROCESS_SERVICE_TIER: "default",
    },
  };
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [] },
    executioner,
    scratch,
    "/work",
  );
  assert.equal(env.AGENTOS_ORDINARY_CODEX_SUBPROCESS_MODEL, "gpt-5.6-luna");
  assert.equal(env.AGENTOS_ORDINARY_CODEX_SUBPROCESS_REASONING_EFFORT, "max");
  assert.equal(env.AGENTOS_ORDINARY_CODEX_SUBPROCESS_SERVICE_TIER, "fast");
  assert.equal(env.AGENTOS_ELEVATED_CODEX_SUBPROCESS_MODEL, "gpt-5.6-sol");
  assert.equal(env.AGENTOS_ELEVATED_CODEX_SUBPROCESS_REASONING_EFFORT, "high");
  assert.equal(env.AGENTOS_ELEVATED_CODEX_SUBPROCESS_SERVICE_TIER, "default");
  assert.match(buildPrompt(executioner), /service tier: fast/u);
  assert.throws(
    () => buildPrompt({ ...executioner, run: { ...claim.run } }),
    /missing its Codex subprocess snapshot/u,
  );
  assert.throws(
    () => buildPrompt({
      ...executioner,
      run: {
        ...executioner.run,
        elevatedSubprocessModel: null,
        elevatedSubprocessCodexServiceTier: null,
      },
    }),
    /incomplete Codex subprocess snapshot/u,
  );
});

test("the PI extension injects the explicit tier only into openai-codex requests", async () => {
  type ProviderContext = { model?: { provider?: string }; abort(): void; shutdown(): void };
  const loaded = await import(pathToFileURL(piExtensionPath()).href) as {
    default: (pi: {
      registerTool(tool: Record<string, unknown>): void;
      on(event: "before_provider_request", handler: (event: { type: "before_provider_request"; payload: unknown }, context: ProviderContext) => unknown): void;
    }) => void;
  };
  let handler: ((event: { type: "before_provider_request"; payload: unknown }, context: ProviderContext) => unknown) | undefined;
  loaded.default({
    registerTool: () => undefined,
    on: (_event, next) => { handler = next; },
  });
  assert.ok(handler);
  const previous = process.env.AGENTOS_CODEX_SERVICE_TIER;
  const previousExpectedProvider = process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX;
  let aborted = 0;
  let shutdown = 0;
  const context = (provider: string): ProviderContext => ({
    model: { provider },
    abort: () => { aborted += 1; },
    shutdown: () => { shutdown += 1; },
  });
  try {
    process.env.AGENTOS_CODEX_SERVICE_TIER = "fast";
    assert.deepEqual(handler({ type: "before_provider_request", payload: { model: "gpt-5.6-luna" } }, context("openai-codex")), {
      model: "gpt-5.6-luna",
      service_tier: "priority",
    });
    assert.equal(handler({ type: "before_provider_request", payload: {} }, context("anthropic")), undefined);
    process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX = "1";
    assert.deepEqual(handler({ type: "before_provider_request", payload: {} }, {
      abort: () => { aborted += 1; },
      shutdown: () => { shutdown += 1; },
    }), { service_tier: "agentos-provider-mismatch" });
    delete process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX;
    process.env.AGENTOS_CODEX_SERVICE_TIER = "default";
    assert.deepEqual(handler({ type: "before_provider_request", payload: {} }, context("openai-codex")), {
      service_tier: "default",
    });
    delete process.env.AGENTOS_CODEX_SERVICE_TIER;
    assert.deepEqual(handler({ type: "before_provider_request", payload: {} }, context("openai-codex")), {
      service_tier: "agentos-invalid-service-tier",
    });
    assert.equal(aborted, 2);
    assert.equal(shutdown, 2);
  } finally {
    if (previousExpectedProvider === undefined) delete process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX;
    else process.env.AGENTOS_PI_EXPECTS_OPENAI_CODEX = previousExpectedProvider;
    if (previous === undefined) delete process.env.AGENTOS_CODEX_SERVICE_TIER;
    else process.env.AGENTOS_CODEX_SERVICE_TIER = previous;
  }
});

test("PI runtime preflight rejects an openai-codex Run whose explicit service tier is absent", async () => {
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [] },
    {
      ...claim,
      runner: "PI",
      run: { ...claim.run, model: "openai-codex/gpt-5.6-sol:high" },
      secrets: { ...claim.secrets, AGENTOS_PI_EXPECTS_OPENAI_CODEX: "0" },
    },
    scratch,
    "/work",
  );
  assert.equal(env.AGENTOS_PI_EXPECTS_OPENAI_CODEX, "1");
  const result = await adapters.PI.preflight({
    config: {} as RunnerConfig,
    runner: "PI",
    model: "openai-codex/gpt-5.6-sol:high",
    env: { AGENTOS_RUN_ID: "run-1" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "PI openai-codex runs require an explicit AgentOS Codex service tier");
});

test("Pi relies on its isolated config root while retaining the explicit AgentOS extension", () => {
  const args = argsForRunner("PI", runSpec());
  assert.equal(args.includes("--no-extensions"), false, "the global extension kill switch would cancel the AgentOS extension");
  for (const flag of ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"]) {
    assert.equal(args.filter((arg) => arg === flag).length, 1, `${flag} must be unconditional`);
  }
  assert.equal(args.filter((arg) => arg === "--extension").length, 1);
  assert.equal(args[args.indexOf("--extension") + 1], piExtensionPath());
});

test("no runner carries the prompt or the resume input in argv", () => {
  const spec = runSpec();
  const resume = { ...spec, providerConversationId: "thread-1", input: "again" };
  for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
    for (const args of [argsForRunner(runner, spec), argsForRunner(runner, spec, resume)]) {
      assert.equal(args.includes("prompt"), false, `${runner} put the prompt in argv`);
      assert.equal(args.includes("again"), false, `${runner} put the resume input in argv`);
    }
  }
  // codex needs the positional `-`, which is what tells it to read stdin.
  assert.equal(argsForRunner("CODEX", spec).at(-1), "-");
  assert.equal(argsForRunner("CODEX", spec, resume).at(-1), "-");
  // Resume still names the conversation to resume; only the input moved.
  assert.deepEqual(argsForRunner("CLAUDE", spec, resume).slice(-2), ["--resume", "thread-1"]);
  assert.deepEqual(argsForRunner("PI", spec, resume).slice(-2), ["--session", "thread-1"]);
  assert.deepEqual(argsForRunner("CODEX", spec, resume).slice(0, 2), ["exec", "resume"]);
  assert.equal(argsForRunner("CODEX", spec, resume).includes("thread-1"), true);
  assert.equal(inputForRunner(spec), "prompt");
  assert.equal(inputForRunner(spec, resume), "again");
});

test("denied tools map in canonical order without consuming the prompt", () => {
  const spec = runSpec(["BASH", "WEB_SEARCH"]);
  const claude = argsForRunner("CLAUDE", spec);
  const pi = argsForRunner("PI", spec);
  assert.deepEqual(claude.slice(claude.indexOf("--disallowedTools"), claude.indexOf("--disallowedTools") + 2), ["--disallowedTools", "Bash,WebSearch"]);
  assert.deepEqual(pi.slice(pi.indexOf("--exclude-tools"), pi.indexOf("--exclude-tools") + 2), ["--exclude-tools", "bash"]);
  assert.equal(argsForRunner("CODEX", spec).includes("--disallowedTools"), false);
  assert.deepEqual(argsForRunner("CODEX", spec), argsForRunner("CODEX", runSpec()));
  assert.ok(claude.indexOf("--disallowedTools") <= claude.length - 4);
  assert.equal(claude.at(-1), "--strict-mcp-config");
});

test("all eight denied tools use each CLI's supported canonical subset", () => {
  const spec = runSpec(["WEB_SEARCH", "GREP", "EDIT", "GLOB", "WRITE", "BASH", "WEB_FETCH", "READ"]);
  const claude = argsForRunner("CLAUDE", spec);
  const pi = argsForRunner("PI", spec);
  assert.equal(claude[claude.indexOf("--disallowedTools") + 1], "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch");
  assert.equal(pi[pi.indexOf("--exclude-tools") + 1], "bash,read,write,edit");
});

test("resume invocations preserve supported deny flags", () => {
  const spec = runSpec(["BASH", "READ"]);
  const resume = { ...spec, providerConversationId: "thread-1", input: "again" };
  assert.equal(argsForRunner("CLAUDE", spec, resume).includes("--disallowedTools"), true);
  assert.equal(argsForRunner("PI", spec, resume).includes("--exclude-tools"), true);
  assert.equal(argsForRunner("CODEX", spec, resume).some((arg) => arg.includes("Tools")), false);
});

// --- launch boundary: the largest prompt a legal chain can produce -----------
//
// `POST /runner/tasks/claim` hands the runner every prior step output verbatim,
// and the write endpoint caps one output at 500k characters. The canonical
// template chain is nine steps, so the last step's claim legally carries eight
// of them. Put that in argv and the run dies at `spawn` with E2BIG — Linux
// refuses any single argument over MAX_ARG_STRLEN (128 KiB), macOS refuses an
// argument block over ~1 MiB — before the provider is ever contacted. These
// tests spawn real processes, so they fail the same way the runner would.
const MAX_STEP_OUTPUT_CHARS = 500_000;
const MAX_PRIOR_OUTPUTS = 8;
const MAX_ARG_STRLEN = 128 * 1024;

const priorOutput = (index: number): ClaimedTask["priorOutputs"][number] => {
  const head = `step-${index}-start\n`;
  const tail = `\nstep-${index}-end`;
  return {
    kind: "spec",
    body: `${head}${"x".repeat(MAX_STEP_OUTPUT_CHARS - head.length - tail.length)}${tail}`,
    task: { name: `Step ${index}`, chainIndex: index },
  };
};

// The child these tests spawn is this stub, not the vendor CLI: `runAsPrefix`
// replaces the binary. So everything below is evidence about *AgentOS's* side of
// the process boundary — the bytes it writes to the child's stdin and the argv it
// builds — and deliberately claims nothing about what a real `claude`, `codex` or
// `pi` process does with what it reads. The vendor CLIs are free to normalise the
// outer whitespace of a piped prompt, and that is acceptable: `buildPrompt`
// carries no significant leading or trailing whitespace, only interior structure,
// which no CLI rewrites.
//
// It reports a digest rather than only a length because a byte count alone would
// pass on reordered or corrupted content.
const stubScript = [
  "const { createHash } = require('node:crypto');",
  "let bytes = 0;",
  "const digest = createHash('sha256');",
  "process.stdin.on('data', (chunk) => { bytes += chunk.length; digest.update(chunk); });",
  "process.stdin.on('end', () => {",
  "  const longestArg = process.argv.slice(1).reduce((max, arg) => Math.max(max, Buffer.byteLength(arg)), 0);",
  "  process.stdout.write(JSON.stringify({ type: 'turn.completed', bytes, longestArg, sha256: digest.digest('hex') }) + '\\n');",
  "});",
].join("");

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const launch = async (
  runner: RunnerKind,
  claimed: ClaimedTask,
  resume?: { providerConversationId: string; input: string },
): Promise<{ evidence: ExitEvidence; report: { bytes: number; longestArg: number; sha256: string }; events: Array<{ type: string; payload: Record<string, unknown> }> }> => {
  const config = {
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    runAsPrefix: [process.execPath, "-e", stubScript],
  } as unknown as RunnerConfig;
  const spec = {
    config,
    claim: { ...claimed, runner },
    workingDirectory: process.cwd(),
    env: process.env,
    prompt: buildPrompt(claimed),
    credentialsPath: "/tmp/session.json",
  };
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sink = (event: { type: string; payload: Record<string, unknown> }): void => { events.push(event); };
  const handle = resume
    ? await adapters[runner].resume({ ...spec, ...resume }, sink)
    : await adapters[runner].start(spec, sink);
  const evidence = await handle.exit;
  const line = evidence.stdout.trim().split("\n").at(-1) ?? "{}";
  return { evidence, report: JSON.parse(line) as { bytes: number; longestArg: number; sha256: string }, events };
};

test("every runner launches with the largest legal chain prompt and receives all of it", { timeout: 60_000 }, async () => {
  const maximal: ClaimedTask = {
    ...claim,
    priorOutputs: Array.from({ length: MAX_PRIOR_OUTPUTS }, (_, index) => priorOutput(index)),
    regressionRepairHandoff: null,
  };
  const prompt = buildPrompt(maximal);
  assert.ok(prompt.length > MAX_PRIOR_OUTPUTS * MAX_STEP_OUTPUT_CHARS, "the fixture must exceed every argv limit");
  for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
    const { evidence, report } = await launch(runner, maximal);
    assert.equal(evidence.exitCode, 0, `${runner} failed to launch: ${evidence.stderr}`);
    assert.equal(evidence.signal, null);
    assert.equal(report.bytes, Buffer.byteLength(prompt), `${runner} did not receive the whole prompt`);
    assert.equal(report.sha256, sha256(prompt), `${runner} received the right byte count but not the right bytes`);
    assert.ok(report.longestArg < MAX_ARG_STRLEN, `${runner} argv element of ${report.longestArg} bytes risks E2BIG`);
  }
});

test("every runner is handed the prompt and the resume input byte-exact at the process boundary", { timeout: 30_000 }, async () => {
  // Scope, stated once: the child is the stub above, so this proves what AgentOS
  // writes and spawns — the full prompt on stdin, digest-identical, and an argv
  // that never carries it. Whether the vendor CLI then trims a trailing newline
  // of its own is outside this boundary and outside what AgentOS controls.
  const prompt = buildPrompt(claim);
  const resumeInput = "operator answered: approve";
  // What makes the tolerance above safe, kept checkable instead of asserted in a
  // comment: if a prompt ever grows outer whitespace, a CLI trimming it would be
  // dropping something AgentOS meant to send.
  assert.equal(prompt, prompt.trim(), "buildPrompt must keep no significant outer whitespace");
  assert.equal(resumeInput, resumeInput.trim());
  for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
    const started = await launch(runner, claim);
    assert.equal(started.evidence.exitCode, 0);
    assert.equal(started.report.bytes, Buffer.byteLength(prompt));
    assert.equal(started.report.sha256, sha256(prompt), `${runner} altered the prompt on the way to stdin`);
    const processStarted = started.events.find((event) => event.type === "PROCESS_STARTED");
    assert.equal(processStarted?.payload.promptTransport, "stdin");
    assert.equal(processStarted?.payload.promptBytes, Buffer.byteLength(prompt));
    assert.equal((processStarted?.payload.args as string[]).some((arg) => arg.includes("Do the work")), false);

    const resumed = await launch(runner, claim, { providerConversationId: "thread-1", input: resumeInput });
    assert.equal(resumed.evidence.exitCode, 0);
    assert.equal(resumed.report.bytes, Buffer.byteLength(resumeInput));
    assert.equal(resumed.report.sha256, sha256(resumeInput), `${runner} altered the resume input on the way to stdin`);
  }
});

// A run's checkout may predate any given safety fix (chain and salvage runs
// are pinned to old bases), so the runner — always current code — has to point
// the session's roots at throwaway directories itself. Both 2026-08-18
// production wipes were old checkouts resolving the production default.
test("agent session environment pins both roots inside the run's disposable scratch", () => {
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [] },
    // A task secret must not be able to aim a session at the production root.
    { ...claim, secrets: { ...claim.secrets, RUNNER_WORKSPACE_ROOT: productionRoot, CONTROL_PLANE_STATE_DIR: productionRoot } },
    scratch,
    "/work",
  );
  assert.equal(env.RUNNER_WORKSPACE_ROOT, scratch.workspaceRoot);
  assert.equal(env.CONTROL_PLANE_STATE_DIR, scratch.stateDir);
  assert.notEqual(env.RUNNER_WORKSPACE_ROOT, productionRoot);
  assert.notEqual(env.CONTROL_PLANE_STATE_DIR, productionRoot);
});

test("PI config overrides are stripped and the isolated config root is runner-pinned", () => {
  const env = buildChildEnvironment(
    { path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [] },
    {
      ...claim,
      runner: "PI",
      secrets: {
        ...claim.secrets,
        PI_CODING_AGENT_DIR: "/hostile/pi-agent",
        PI_CODING_AGENT_SESSION_DIR: "/hostile/pi-sessions",
      },
    },
    scratch,
    "/work",
  );
  assert.equal(env.PI_CODING_AGENT_DIR, scratch.configRoot);
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, undefined);
  assert.notEqual(env.PI_CODING_AGENT_DIR, "/hostile/pi-agent");
});

test("child environment is an explicit allowlist and excludes host variables", () => {
  const previous = process.env.HOST_ONLY_CREDENTIAL;
  process.env.HOST_ONLY_CREDENTIAL = "must-not-leak";
  try {
    const env = buildChildEnvironment({ path: "/bin", home: "/runner", apiUrl: "http://api", runAsPrefix: [] }, claim, scratch, "/work");
    assert.equal(env.HOST_ONLY_CREDENTIAL, undefined);
    assert.equal(env.ALLOWED_SECRET, "secret");
    assert.equal(env.AGENTOS_SESSION_TOKEN, "agos_session_secret");
    assert.equal(env.AGENTOS_FENCING_TOKEN, claim.fencingToken);
  } finally {
    if (previous === undefined) delete process.env.HOST_ONLY_CREDENTIAL;
    else process.env.HOST_ONLY_CREDENTIAL = previous;
  }
});

// The launcher named by RUNNER_RUN_AS_PREFIX is an arbitrary command that may
// scrub the environment it was handed — `sudo` resets it by policy, and #126
// wants OS isolation built on precisely this prefix. `/usr/bin/env -i` is that
// worst case made deterministic: nothing the runner put in the launcher's
// environment survives to the CLI. Asserting on the env object handed to
// spawn() cannot see this, so the stub below reports what the *final* process
// actually got. PATH is empty on the far side of `env -i`, so the stub is
// invoked by absolute path and uses only shell builtins.
const rootReportingStub = [
  "#!/bin/sh",
  // Drain the prompt so the parent never sees EPIPE instead of the report.
  "while read -r _line; do :; done",
  'printf \'{"type":"turn.completed","workspaceRoot":"%s","stateDir":"%s","piConfigRoot":"%s"}\\n\' "$RUNNER_WORKSPACE_ROOT" "$CONTROL_PLANE_STATE_DIR" "$PI_CODING_AGENT_DIR"',
  "",
].join("\n");

test("a scrubbing run-as launcher cannot strip the isolation roots from any session", { timeout: 60_000 }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-runas-scrub-"));
  const stub = join(fixture, "agent-stub.sh");
  await writeFile(stub, rootReportingStub);
  await chmod(stub, 0o755);
  const config = {
    binaries: { CLAUDE: stub, CODEX: stub, PI: stub },
    // The launcher hands the CLI an empty environment, exactly as a locked-down
    // sudoers policy would for anything it has not been told to preserve.
    runAsPrefix: ["/usr/bin/env", "-i"],
    workspaceRoot: productionRoot,
    path: "/bin",
    home: fixture,
    apiUrl: "http://api",
  } as unknown as RunnerConfig;
  const runScratch = await provisionAgentScratch(config);
  try {
    for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
      const runnerClaim = { ...claim, runner };
      const env = buildChildEnvironment(config, runnerClaim, runScratch, fixture);
      const spec = {
        config,
        claim: runnerClaim,
        workingDirectory: fixture,
        env,
        prompt: buildPrompt(claim),
        credentialsPath: join(fixture, "session.json"),
      };
      const sessions = {
        start: () => adapters[runner].start(spec, () => undefined),
        resume: () => adapters[runner].resume(
          { ...spec, providerConversationId: "thread-1", input: "continue" },
          () => undefined,
        ),
      };
      for (const [mode, launchSession] of Object.entries(sessions)) {
        const evidence = await (await launchSession()).exit;
        assert.equal(evidence.exitCode, 0, `${runner} ${mode} failed to launch: ${evidence.stderr}`);
        const report = JSON.parse(evidence.stdout.trim().split("\n").at(-1) ?? "{}") as {
          workspaceRoot?: string;
          stateDir?: string;
          piConfigRoot?: string;
        };
        assert.equal(report.workspaceRoot, runScratch.workspaceRoot, `${runner} ${mode} lost RUNNER_WORKSPACE_ROOT across the launcher`);
        assert.equal(report.stateDir, runScratch.stateDir, `${runner} ${mode} lost CONTROL_PLANE_STATE_DIR across the launcher`);
        assert.notEqual(report.workspaceRoot, config.workspaceRoot);
        assert.notEqual(report.workspaceRoot, productionRoot);
        assert.notEqual(report.stateDir, productionRoot);
        if (runner === "PI") assert.equal(report.piConfigRoot, runScratch.configRoot, `${mode} lost PI_CODING_AGENT_DIR across the launcher`);
      }
    }
  } finally {
    await cleanupAgentScratch(config, runScratch);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("PI preflight fails closed when the CLI omits an isolation capability", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-pi-capability-"));
  const stub = join(fixture, "pi-stub.sh");
  await writeFile(stub, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "0.1.0"; exit 0; fi',
    'if [ "$1" = "--help" ]; then echo "--no-skills --no-prompt-templates --no-themes --no-approve"; exit 0; fi',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    "exit 1",
    "",
  ].join("\n"));
  await chmod(stub, 0o755);
  try {
    const config = {
      binaries: { CLAUDE: stub, CODEX: stub, PI: stub },
      runAsPrefix: [],
    } as unknown as RunnerConfig;
    const result = await adapters.PI.preflight({ config, runner: "PI", model: "openai-codex/gpt-5.6-sol:high", env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.error, "cli-incompatible: the CLI does not expose the required AgentOS exec protocol");
    assert.equal(result.authMode, null);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("PI preflight verifies every isolation capability before authentication", { timeout: 30_000 }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agentos-pi-capability-"));
  const stub = join(fixture, "pi-stub.sh");
  await writeFile(stub, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "0.84.2"; exit 0; fi',
    'if [ "$1" = "--help" ]; then echo "--no-skills --no-prompt-templates --no-themes --no-context-files --no-approve"; exit 0; fi',
    'if [ "$1" = "auth" ]; then exit 0; fi',
    "exit 1",
    "",
  ].join("\n"));
  await chmod(stub, 0o755);
  try {
    const config = {
      binaries: { CLAUDE: stub, CODEX: stub, PI: stub },
      runAsPrefix: [],
    } as unknown as RunnerConfig;
    const result = await adapters.PI.preflight({ config, runner: "PI", model: "openai-codex/gpt-5.6-sol:high", env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.authMode, "openai-codex");
    assert.equal(result.capabilities.cliProtocol, "json-stdin-resume-isolated");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("exit code zero without a provider terminal event is failure", () => {
  const evidence: ExitEvidence = {
    exitCode: 0,
    signal: null,
    terminalEventSeen: false,
    finalOutput: null,
    providerError: null,
    terminalSuccess: false,
    terminationReason: null,
    stdout: "",
    stderr: "",
  };
  assert.equal(adapterExecutionSucceeded(evidence), false);
  assert.equal(adapterExecutionSucceeded({ ...evidence, terminalEventSeen: true, terminalSuccess: true }), true);
});

test("Codex structured errors take precedence over stderr warnings", async () => {
  const script = "process.stdout.write(JSON.stringify({type:'error',message:'policy denied'})+'\\n')";
  const config = {
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    runAsPrefix: [process.execPath, "-e", script],
  } as unknown as RunnerConfig;
  const handle = await adapters.CODEX.start({
    config, claim, workingDirectory: process.cwd(), env: process.env, prompt: "prompt",
    credentialsPath: "/tmp/session.json",
  }, () => undefined);
  const evidence = await handle.exit;

  assert.equal(evidence.providerError, "policy denied");
  assert.equal(failureReasonFromEvidence({ ...evidence, stderr: "models cache warning" }), "policy denied");
});

test("PI terminal success follows the final provider attempt after an internal retry", async () => {
  const script = [
    "const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "emit({type:'turn_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'fetch failed'}});",
    "emit({type:'agent_end',messages:[{role:'assistant',stopReason:'error',errorMessage:'fetch failed'}],willRetry:true});",
    "emit({type:'turn_end',message:{role:'assistant',content:[{type:'text',text:'final PASS'}],stopReason:'stop'}});",
    "emit({type:'agent_end',messages:[{role:'assistant',stopReason:'stop'}],willRetry:false});",
    "emit({type:'agent_settled'});",
  ].join("");
  const config = {
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    runAsPrefix: [process.execPath, "-e", script],
  } as unknown as RunnerConfig;
  const handle = await adapters.PI.start({
    config, claim, workingDirectory: process.cwd(), env: process.env, prompt: "prompt",
    credentialsPath: "/tmp/session.json",
  }, () => undefined);

  const evidence = await handle.exit;
  assert.equal(evidence.terminalSuccess, true);
  assert.equal(evidence.providerError, null);
  assert.equal(evidence.finalOutput, "final PASS");
  assert.equal(adapterExecutionSucceeded(evidence), true);
});

test("PI exposes the exhausted provider error instead of a generic protocol failure", async () => {
  const script = [
    "const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "emit({type:'turn_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'fetch failed'}});",
    "emit({type:'agent_end',messages:[{role:'assistant',stopReason:'error',errorMessage:'fetch failed'}],willRetry:false});",
    "emit({type:'agent_settled'});",
  ].join("");
  const config = {
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    runAsPrefix: [process.execPath, "-e", script],
  } as unknown as RunnerConfig;
  const handle = await adapters.PI.start({
    config, claim, workingDirectory: process.cwd(), env: process.env, prompt: "prompt",
    credentialsPath: "/tmp/session.json",
  }, () => undefined);

  const evidence = await handle.exit;
  assert.equal(evidence.terminalEventSeen, true);
  assert.equal(evidence.terminalSuccess, false);
  assert.equal(evidence.providerError, "fetch failed");
  assert.deepEqual(adapters.PI.classifyError(evidence), { failureClass: "TRANSIENT_PROVIDER", retryable: true });
});

test("Codex agent progress renews an open command deadline while stderr does not", async () => {
  const script = [
    "const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "emit({type:'item.started',item:{id:'command-1',type:'command_execution',status:'in_progress'}});",
    "setTimeout(() => process.stderr.write('models manager warning\\n'), 20);",
    "setTimeout(() => emit({type:'item.completed',item:{id:'message-1',type:'agent_message',text:'database gate is still advancing'}}), 60);",
    "setTimeout(() => emit({type:'item.completed',item:{id:'command-1',type:'command_execution',status:'completed',exit_code:0}}), 100);",
    "setTimeout(() => emit({type:'turn.completed'}), 120);",
  ].join("");
  const config = {
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    runAsPrefix: [process.execPath, "-e", script],
  } as unknown as RunnerConfig;

  let resolveStarted!: () => void;
  let resolveStderr!: () => void;
  let resolveProgress!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const stderr = new Promise<void>((resolve) => { resolveStderr = resolve; });
  const progress = new Promise<void>((resolve) => { resolveProgress = resolve; });
  const handle = await adapters.CODEX.start({
    config, claim, workingDirectory: process.cwd(), env: process.env, prompt: "prompt",
    credentialsPath: "/tmp/session.json",
  }, (event) => {
    if (event.type === "TOOL_STARTED") resolveStarted();
    if (event.type === "STDERR") resolveStderr();
    if (event.type === "MODEL_DELTA" && event.payload.item && (event.payload.item as { type?: string }).type === "agent_message") resolveProgress();
  });

  await started;
  const initialProgress = (await adapters.CODEX.heartbeat(handle)).inFlightTool?.lastProgressAt;
  assert.ok(initialProgress);

  await stderr;
  assert.equal((await adapters.CODEX.heartbeat(handle)).inFlightTool?.lastProgressAt.getTime(), initialProgress.getTime());

  await progress;
  const renewedProgress = (await adapters.CODEX.heartbeat(handle)).inFlightTool?.lastProgressAt;
  assert.ok(renewedProgress);
  assert.ok(renewedProgress.getTime() > initialProgress.getTime());

  const evidence = await handle.exit;
  assert.equal(evidence.terminalSuccess, true);
  assert.equal((await adapters.CODEX.heartbeat(handle)).inFlightTool, null);
});

test("source text cannot misclassify a provider failure as a missing binary", () => {
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: "request rejected by provider policy",
    stdout: "throw new Error('No such file or directory')",
    stderr: "models cache warning",
  };

  assert.equal(adapters.CODEX.classifyError(evidence).failureClass, "TASK_FAILED");
});

test("workspace TLS failures remain retryable after command retries are exhausted", () => {
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stdout: "",
    stderr: "git failed (128): LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
  };

  assert.deepEqual(adapters.CODEX.classifyError(evidence), {
    failureClass: "TRANSIENT_PROVIDER",
    retryable: true,
  });
});

test("a mid-response connection loss classifies TRANSIENT_PROVIDER, not AUTH_REQUIRED", () => {
  // Exact strings observed on run cmsy26f2s0ibqmpmx8t6gyltg (2026-08-18):
  // the provider result event carried this error while stdout held 19 minutes
  // of agent work on auth-adjacent code.
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: true,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: "API Error: Connection lost mid-response. The response above may be incomplete.",
    providerError: "API Error: Connection lost mid-response. The response above may be incomplete.",
    stdout: "",
    stderr: "",
  };
  assert.deepEqual(adapters.CLAUDE.classifyError(evidence), {
    failureClass: "TRANSIENT_PROVIDER",
    retryable: true,
  });
});

test("a literal 401 in agent stdout does not classify as AUTH_REQUIRED", () => {
  // Run-2 evidence shape: providerError and stderr empty, stdout full of the
  // agent's own work — including HTTP status literals from code under edit.
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stdout: 'return context.json({ error: "Stale fencing token" }, 401);',
    stderr: "",
  };
  assert.notEqual(adapters.CLAUDE.classifyError(evidence).failureClass, "AUTH_REQUIRED");
});

test("an auth failure that also mentions a dropped connection is AUTH_REQUIRED, not retried", () => {
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: true,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: "authentication_failed: connection lost while refreshing credentials",
    stdout: "",
    stderr: "",
  };
  assert.equal(adapters.CLAUDE.classifyError(evidence).failureClass, "AUTH_REQUIRED");
});

test("a genuine auth failure on stderr still classifies AUTH_REQUIRED", () => {
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stdout: "",
    stderr: "authentication_failed: not logged in",
  };
  assert.equal(adapters.CLAUDE.classifyError(evidence).failureClass, "AUTH_REQUIRED");
});

test("an is_error result event is captured as providerError and classifies transient", { timeout: 30_000 }, async () => {
  const message = "API Error: Connection lost mid-response. The response above may be incomplete.";
  const errorStub = [
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    `  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: ${JSON.stringify(message)} }) + '\\n');`,
    "  process.exit(1);",
    "});",
  ].join("");
  const config = {
    binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" },
    runAsPrefix: [process.execPath, "-e", errorStub],
  } as unknown as RunnerConfig;
  const handle = await adapters.CLAUDE.start({
    config,
    claim: { ...claim, runner: "CLAUDE" },
    workingDirectory: process.cwd(),
    env: process.env,
    prompt: buildPrompt(claim),
    credentialsPath: "/tmp/session.json",
  }, () => undefined);
  const evidence = await handle.exit;
  assert.equal(evidence.providerError, message);
  assert.deepEqual(adapters.CLAUDE.classifyError(evidence), {
    failureClass: "TRANSIENT_PROVIDER",
    retryable: true,
  });
});

test("a local CLI preflight timeout stays a deterministic failure, not a provider blip", () => {
  // capture() in this module emits this exact wording for a binary that never
  // answers `--version`. The per-command timeout added for hung git/gh work
  // must not reach in here and make a broken CLI look retryable.
  const evidence: ExitEvidence = {
    exitCode: 1,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    finalOutput: null,
    providerError: null,
    stderr: "\npreflight timed out after 30 seconds",
    stdout: "",
  };
  const classified = adapters.CLAUDE.classifyError(evidence);
  assert.notEqual(classified.failureClass, "TRANSIENT_PROVIDER");
  assert.equal(classified.retryable, false);
});
