import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterExecutionSucceeded, adapters, argsForRunner, buildChildEnvironment, buildPrompt, failureReasonFromEvidence,
  mcpConfig, type ExitEvidence,
} from "./adapters.js";
import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";

const claim: ClaimedTask = {
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
    maxDurationMin: 120,
    stallTimeoutMin: 10,
    maxRunsPerTask: 3,
    model: "codex",
    targetBranch: "main",
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
};

test("buildPrompt combines foundational, role, and task context", () => {
  assert.match(buildPrompt(claim), /Foundation[\s\S]*Role \(senior-dev\): Implement[\s\S]*Task: Ship it[\s\S]*Do the work/);
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
  const spec = {
    config: { binaries: { CLAUDE: "claude", CODEX: "codex", PI: "pi" }, runAsPrefix: [] } as unknown as RunnerConfig,
    claim, workingDirectory: "/work", env: {}, prompt: "prompt",
    credentialsPath: "/work/.agentos/session.json",
  };
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

test("child environment is an explicit allowlist and excludes host variables", () => {
  const previous = process.env.HOST_ONLY_CREDENTIAL;
  process.env.HOST_ONLY_CREDENTIAL = "must-not-leak";
  try {
    const env = buildChildEnvironment({ path: "/bin", home: "/runner", apiUrl: "http://api" }, claim);
    assert.equal(env.HOST_ONLY_CREDENTIAL, undefined);
    assert.equal(env.ALLOWED_SECRET, "secret");
    assert.equal(env.AGENTOS_SESSION_TOKEN, "agos_session_secret");
    assert.equal(env.AGENTOS_FENCING_TOKEN, claim.fencingToken);
  } finally {
    if (previous === undefined) delete process.env.HOST_ONLY_CREDENTIAL;
    else process.env.HOST_ONLY_CREDENTIAL = previous;
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
