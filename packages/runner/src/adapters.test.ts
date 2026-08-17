import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  adapterExecutionSucceeded, adapters, argsForRunner, buildChildEnvironment, buildPrompt, failureReasonFromEvidence,
  inputForRunner, mcpConfig, mcpServerPath, piExtensionPath, type ExitEvidence,
} from "./adapters.js";
import type { ClaimedTask } from "./api.js";
import type { RunnerConfig, RunnerKind } from "./config.js";

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
    opensPullRequest: true,
    pullRequestBase: "main",
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
  .replaceAll(piExtensionPath(), "<PI_EXTENSION>"));

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

test("an empty denied set keeps every runner argv byte-identical", () => {
  const spec = runSpec();
  assert.deepEqual(stableArgv(argsForRunner("CLAUDE", spec)), [
    "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose",
    "--model", "codex", "--effort", "high",
    "--mcp-config", "{\"mcpServers\":{\"agentos\":{\"type\":\"stdio\",\"command\":\"<NODE>\",\"args\":[\"<MCP_SERVER>\",\"--credentials\",\"/work/.agentos/session.json\"]}}}",
    "--strict-mcp-config",
  ]);
  assert.deepEqual(stableArgv(argsForRunner("CODEX", spec)), [
    "exec", "--json", "-m", "codex",
    "-c", "mcp_servers.agentos.command=\"<NODE>\"",
    "-c", "mcp_servers.agentos.args=[\"<MCP_SERVER>\",\"--credentials\",\"/work/.agentos/session.json\"]",
    "-c", "mcp_servers.agentos.startup_timeout_sec=30",
    "--dangerously-bypass-approvals-and-sandbox", "-",
  ]);
  assert.deepEqual(stableArgv(argsForRunner("PI", spec)), [
    "-p", "--mode", "json", "--session-dir", "/work/.agentos-pi", "--model", "codex",
    "--extension", "<PI_EXTENSION>",
  ]);
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
