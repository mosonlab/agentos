import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { ClaimedTask, FailureClass } from "./api.js";
import type { RunnerConfig, RunnerKind } from "./config.js";
import type { InFlightTool } from "./budget.js";
import { workspaceEnvironment } from "./workspace.js";

export const ADAPTER_VERSION = "2.0.0";

export const buildPrompt = (claim: ClaimedTask): string => [
  claim.agent.foundationalPrompt,
  "",
  `Role (${claim.agent.name}): ${claim.agent.rolePrompt}`,
  "",
  `Task: ${claim.task.name}`,
  claim.task.description,
  ...(claim.priorOutputs.length > 0 ? [
    "",
    "Persisted outputs from prior template steps:",
    ...claim.priorOutputs.map((output) => `\n## ${output.task.name} (${output.kind})\n${output.body}`),
  ] : []),
].join("\n");

export const buildChildEnvironment = (
  config: Pick<RunnerConfig, "path" | "home" | "apiUrl">,
  claim: Pick<ClaimedTask, "secrets" | "sessionToken" | "fencingToken" | "run">,
): NodeJS.ProcessEnv => ({
  ...claim.secrets,
  ...workspaceEnvironment(config),
  AGENTOS_API_URL: config.apiUrl,
  AGENTOS_SESSION_TOKEN: claim.sessionToken,
  AGENTOS_RUN_ID: claim.run.id,
  AGENTOS_FENCING_TOKEN: claim.fencingToken,
});

export type AdapterEvent = {
  source: "RUNNER" | "CLAUDE" | "CODEX" | "PI";
  type: string;
  providerEventId?: string | null;
  toolCallId?: string | null;
  payload: Record<string, unknown>;
};

export type SessionEventSink = (event: AdapterEvent) => void;

export type ExitEvidence = {
  exitCode: number | null;
  signal: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  terminationReason: string | null;
  finalOutput: string | null;
  stdout: string;
  stderr: string;
};

export type ClassifiedFailure = {
  failureClass: FailureClass;
  retryable: boolean;
  operatorAction?: string;
};

export type HeartbeatSnapshot = {
  processAlive: boolean;
  lastProcessAliveAt: Date;
  lastProgressEventAt: Date;
  inFlightTool: InFlightTool | null;
};

export type RuntimeHandle = {
  runner: RunnerKind;
  child: ChildProcess;
  pid: number | null;
  startedAt: Date;
  lastProcessAliveAt: Date;
  lastProgressEventAt: Date;
  inFlightTool: InFlightTool | null;
  providerConversationId: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  terminationReason: string | null;
  sawError: boolean;
  piTurnCompleted: boolean;
  finalOutput: string | null;
  stdout: string;
  stderr: string;
  exit: Promise<ExitEvidence>;
};

export type PreflightSpec = {
  config: RunnerConfig;
  runner: RunnerKind;
  model: string;
  env: NodeJS.ProcessEnv;
};

export type PreflightResult = {
  ok: boolean;
  cliVersion: string | null;
  authMode: string | null;
  capabilities: Record<string, unknown>;
  error?: string;
};

export type RunSpec = {
  config: RunnerConfig;
  claim: ClaimedTask;
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
};

export type ResumeSpec = RunSpec & { providerConversationId: string; input: string };

export type KillResult = { signal: "SIGTERM" | "SIGKILL" | null; processAlive: boolean };

export interface CliAdapter {
  preflight(spec: PreflightSpec): Promise<PreflightResult>;
  start(spec: RunSpec, sink: SessionEventSink): Promise<RuntimeHandle>;
  resume(spec: ResumeSpec, sink: SessionEventSink): Promise<RuntimeHandle>;
  kill(handle: RuntimeHandle, reason: string): Promise<KillResult>;
  heartbeat(handle: RuntimeHandle): Promise<HeartbeatSnapshot>;
  classifyError(evidence: ExitEvidence): ClassifiedFailure;
}

const cap = (value: string, limit = 1_000_000): string => value.length <= limit ? value : value.slice(value.length - limit);

const sourceFor = (runner: RunnerKind): AdapterEvent["source"] => runner;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const stringField = (object: Record<string, unknown> | null, field: string): string | null =>
  typeof object?.[field] === "string" ? object[field] as string : null;

const emit = (handle: RuntimeHandle, sink: SessionEventSink, type: string, payload: Record<string, unknown>, toolCallId?: string | null): void => {
  handle.lastProgressEventAt = new Date();
  sink({ source: sourceFor(handle.runner), type, payload, ...(toolCallId !== undefined ? { toolCallId } : {}) });
};

const parseClaude = (handle: RuntimeHandle, event: Record<string, unknown>, sink: SessionEventSink): void => {
  const type = stringField(event, "type");
  if (type === "system") {
    handle.providerConversationId = stringField(event, "session_id") ?? handle.providerConversationId;
    emit(handle, sink, "MODEL_STARTED", event);
  } else if (type === "assistant") {
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      const part = asRecord(item);
      if (stringField(part, "type") === "tool_use") {
        const toolId = stringField(part, "id") ?? "unknown";
        const now = new Date();
        handle.inFlightTool = { id: toolId, name: stringField(part, "name") ?? "tool", startedAt: now, lastProgressAt: now };
        emit(handle, sink, "TOOL_STARTED", part ?? {}, toolId);
      }
    }
    emit(handle, sink, "MODEL_DELTA", event);
  } else if (type === "user") {
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      const part = asRecord(item);
      if (stringField(part, "type") === "tool_result") {
        const toolId = stringField(part, "tool_use_id");
        handle.inFlightTool = null;
        emit(handle, sink, "TOOL_COMPLETED", part ?? {}, toolId);
      }
    }
  } else if (type === "result") {
    handle.terminalEventSeen = true;
    handle.terminalSuccess = event.is_error === false && event.terminal_reason === "completed";
    if (!handle.terminalSuccess) handle.sawError = true;
    handle.finalOutput = stringField(event, "result") ?? handle.finalOutput;
    emit(handle, sink, "FINAL_OUTPUT", event);
  } else {
    emit(handle, sink, "PROVIDER_STATUS", event);
  }
};

const parseCodex = (handle: RuntimeHandle, event: Record<string, unknown>, sink: SessionEventSink): void => {
  const type = stringField(event, "type");
  if (type === "thread.started") {
    handle.providerConversationId = stringField(event, "thread_id") ?? handle.providerConversationId;
    emit(handle, sink, "MODEL_STARTED", event);
  } else if (type === "item.started") {
    const item = asRecord(event.item);
    if (stringField(item, "type") === "command_execution") {
      const toolId = stringField(item, "id") ?? "unknown";
      const now = new Date();
      handle.inFlightTool = { id: toolId, name: "command_execution", startedAt: now, lastProgressAt: now };
      emit(handle, sink, "TOOL_STARTED", item ?? {}, toolId);
    } else emit(handle, sink, "MODEL_DELTA", event);
  } else if (type === "item.completed") {
    const item = asRecord(event.item);
    if (stringField(item, "type") === "command_execution") {
      handle.inFlightTool = null;
      emit(handle, sink, "TOOL_COMPLETED", item ?? {}, stringField(item, "id"));
    } else {
      if (item && stringField(item, "type") === "agent_message") handle.finalOutput = stringField(item, "text") ?? handle.finalOutput;
      emit(handle, sink, "MODEL_DELTA", event);
    }
    if (item?.status === "failed" || item?.error) handle.sawError = true;
  } else if (type === "error") {
    handle.sawError = true;
    emit(handle, sink, "ADAPTER_ERROR", event);
  } else if (type === "turn.completed") {
    handle.terminalEventSeen = true;
    handle.terminalSuccess = !handle.sawError;
    emit(handle, sink, "FINAL_OUTPUT", event);
  } else emit(handle, sink, "PROVIDER_STATUS", event);
};

const parsePi = (handle: RuntimeHandle, event: Record<string, unknown>, sink: SessionEventSink): void => {
  const type = stringField(event, "type");
  if (type === "session") {
    handle.providerConversationId = stringField(event, "id") ?? handle.providerConversationId;
    emit(handle, sink, "MODEL_STARTED", event);
  } else if (type === "tool_execution_start") {
    const toolId = stringField(event, "toolCallId") ?? "unknown";
    const now = new Date();
    handle.inFlightTool = { id: toolId, name: stringField(event, "toolName") ?? "tool", startedAt: now, lastProgressAt: now };
    emit(handle, sink, "TOOL_STARTED", event, toolId);
  } else if (type === "tool_execution_update") {
    if (handle.inFlightTool) handle.inFlightTool.lastProgressAt = new Date();
    emit(handle, sink, "TOOL_PROGRESS", event, stringField(event, "toolCallId"));
  } else if (type === "tool_execution_end") {
    handle.inFlightTool = null;
    if (event.isError === true) handle.sawError = true;
    emit(handle, sink, "TOOL_COMPLETED", event, stringField(event, "toolCallId"));
  } else if (type === "turn_end" || type === "message_end") {
    handle.piTurnCompleted = true;
    const message = asRecord(event.message);
    if (message && stringField(message, "role") === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .map((part) => stringField(asRecord(part) ?? {}, "text"))
        .filter((part): part is string => part !== null)
        .join("\n");
      if (text) handle.finalOutput = text;
    }
    emit(handle, sink, "MODEL_COMPLETED", event);
  } else if (type === "agent_end") {
    if (event.willRetry === true) handle.sawError = true;
    emit(handle, sink, "PROVIDER_STATUS", event);
  } else if (type === "agent_settled") {
    handle.terminalEventSeen = true;
    handle.terminalSuccess = handle.piTurnCompleted && !handle.sawError;
    emit(handle, sink, "FINAL_OUTPUT", event);
  } else {
    if (type?.includes("error")) handle.sawError = true;
    emit(handle, sink, type?.includes("message") ? "MODEL_DELTA" : "PROVIDER_STATUS", event);
  }
};

const processLine = (handle: RuntimeHandle, line: string, sink: SessionEventSink): void => {
  if (!line.trim()) return;
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    event = asRecord(parsed) ?? { value: parsed };
  } catch {
    handle.sawError = true;
    emit(handle, sink, "ADAPTER_ERROR", { error: "invalid-json", line });
    return;
  }
  sink({ source: sourceFor(handle.runner), type: "PROVIDER_RAW", payload: event });
  if (handle.runner === "CLAUDE") parseClaude(handle, event, sink);
  else if (handle.runner === "CODEX") parseCodex(handle, event, sink);
  else parsePi(handle, event, sink);
};

const argsFor = (runner: RunnerKind, spec: RunSpec, resume?: ResumeSpec): string[] => {
  const input = resume?.input ?? spec.prompt;
  if (runner === "CLAUDE") return [
    "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose",
    ...(resume ? ["--resume", resume.providerConversationId] : []), input,
  ];
  if (runner === "CODEX") return resume
    ? ["exec", "resume", "--json", resume.providerConversationId, input]
    : ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", input];
  return [
    "-p", "--mode", "json", "--session-dir", join(spec.workingDirectory, ".agentos-pi"),
    "--model", spec.claim.run.model,
    ...(resume ? ["--session", resume.providerConversationId] : []), input,
  ];
};

const spawnRuntime = (runner: RunnerKind, spec: RunSpec, sink: SessionEventSink, resume?: ResumeSpec): RuntimeHandle => {
  const binary = spec.config.binaries[runner];
  const args = argsFor(runner, spec, resume);
  const prefixed = spec.config.runAsPrefix.length > 0;
  const executable = prefixed ? spec.config.runAsPrefix[0]! : binary;
  const fullArgs = prefixed ? [...spec.config.runAsPrefix.slice(1), binary, ...args] : args;
  const startedAt = new Date();
  const child = spawn(executable, fullArgs, {
    cwd: spec.workingDirectory,
    env: spec.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle: RuntimeHandle = {
    runner,
    child,
    pid: child.pid ?? null,
    startedAt,
    lastProcessAliveAt: startedAt,
    lastProgressEventAt: startedAt,
    inFlightTool: null,
    providerConversationId: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
    sawError: false,
    piTurnCompleted: false,
    finalOutput: null,
    stdout: "",
    stderr: "",
    exit: Promise.resolve({} as ExitEvidence),
  };
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    handle.stdout = cap(handle.stdout + chunk);
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(handle, line, sink);
  });
  child.stderr!.on("data", (chunk: string) => {
    handle.stderr = cap(handle.stderr + chunk);
    sink({ source: sourceFor(runner), type: "STDERR", payload: { text: chunk } });
  });
  handle.exit = new Promise<ExitEvidence>((resolvePromise) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (buffer.trim()) processLine(handle, buffer, sink);
      resolvePromise({
        exitCode,
        signal,
        terminalEventSeen: handle.terminalEventSeen,
        terminalSuccess: handle.terminalSuccess,
        terminationReason: handle.terminationReason,
        finalOutput: handle.finalOutput,
        stdout: handle.stdout,
        stderr: handle.stderr,
      });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      handle.sawError = true;
      handle.stderr = cap(`${handle.stderr}\n${error.message}`);
      finish(error.code === "ENOENT" ? 127 : 1, null);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
  sink({ source: "RUNNER", type: "PROCESS_STARTED", payload: { pid: handle.pid, binary, args, promptHash: spec.claim.run.promptHash } });
  return handle;
};

const capture = async (config: RunnerConfig, runner: RunnerKind, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const binary = config.binaries[runner];
    const prefixed = config.runAsPrefix.length > 0;
    const child = spawn(prefixed ? config.runAsPrefix[0]! : binary, prefixed ? [...config.runAsPrefix.slice(1), binary, ...args] : args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr: `${stderr}${extra}` });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1, "\npreflight timed out after 15 seconds");
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? 127 : 1, `\n${error.message}`));
    child.once("close", (code) => finish(code));
  });

const preflight = async (spec: PreflightSpec): Promise<PreflightResult> => {
  const capabilities = { structuredEvents: true, resume: true, killProcessGroup: true, heartbeat: true, classifyError: true };
  if (spec.runner === "PI" && !spec.model.includes("/")) {
    return {
      ok: false,
      cliVersion: null,
      authMode: null,
      capabilities,
      error: "Pi requires an explicit provider/model; drifting default providers are forbidden",
    };
  }
  const version = await capture(spec.config, spec.runner, ["--version"], spec.env);
  if (version.code !== 0) return { ok: false, cliVersion: null, authMode: null, capabilities, error: version.stderr || "CLI missing" };
  const authArgs = spec.runner === "CLAUDE" ? ["auth", "status"]
    : spec.runner === "CODEX" ? ["login", "status"]
      : ["auth", "check", "--provider", spec.model.split("/")[0] ?? "openai-codex"];
  const auth = await capture(spec.config, spec.runner, authArgs, spec.env);
  const text = `${auth.stdout}\n${auth.stderr}`;
  const ok = auth.code === 0 && (spec.runner !== "CLAUDE" || /"loggedIn"\s*:\s*true/u.test(text));
  return {
    ok,
    cliVersion: version.stdout.trim() || version.stderr.trim(),
    authMode: spec.runner === "CLAUDE" ? (/"authMethod"\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? null)
      : spec.runner === "CODEX" ? (text.includes("ChatGPT") ? "chatgpt" : null) : spec.model.split("/")[0] ?? null,
    capabilities,
    ...(!ok ? { error: text.trim() || "Authentication preflight failed" } : {}),
  };
};

export const adapterExecutionSucceeded = (evidence: ExitEvidence): boolean =>
  evidence.exitCode === 0
  && evidence.signal === null
  && evidence.terminationReason === null
  && evidence.terminalEventSeen
  && evidence.terminalSuccess;

const classifyError = (evidence: ExitEvidence): ClassifiedFailure => {
  const text = `${evidence.stdout}\n${evidence.stderr}`;
  if (evidence.terminationReason) return { failureClass: "CANCELLED_OR_TIMED_OUT", retryable: false };
  if (evidence.exitCode === 127 || /ENOENT|No such file or directory/u.test(text)) {
    return { failureClass: "BINARY_NOT_FOUND", retryable: false, operatorAction: "Install the configured CLI or repair RUNNER_PATH" };
  }
  if (/authentication_failed|\b401\b|Missing authentication|No API key found|not logged in/iu.test(text)) {
    return { failureClass: "AUTH_REQUIRED", retryable: false, operatorAction: "Log the runner account into the CLI" };
  }
  if (/\b429\b|rate.?limit|usage.?limit|quota/iu.test(text)) return { failureClass: "RATE_LIMITED", retryable: true };
  if (/\b5\d\d\b|ECONNRESET|ETIMEDOUT|provider outage/iu.test(text)) return { failureClass: "TRANSIENT_PROVIDER", retryable: true };
  if (/"isError"\s*:\s*true|"command_execution"[\s\S]{0,500}"status"\s*:\s*"failed"/u.test(text)) {
    return { failureClass: "TOOL_FAILED", retryable: false };
  }
  if (evidence.exitCode === 0 && (!evidence.terminalEventSeen || !evidence.terminalSuccess)) {
    return { failureClass: "PROTOCOL_ERROR", retryable: true, operatorAction: "Check CLI protocol/version drift" };
  }
  return { failureClass: "TASK_FAILED", retryable: false };
};

const kill = async (handle: RuntimeHandle, reason: string): Promise<KillResult> => {
  handle.terminationReason = reason;
  const pid = handle.pid;
  if (!pid || handle.child.exitCode !== null || handle.child.signalCode !== null) return { signal: null, processAlive: false };
  try { process.kill(-pid, "SIGTERM"); } catch { return { signal: null, processAlive: false }; }
  const closed = await Promise.race([
    handle.exit.then(() => true),
    new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 5_000)),
  ]);
  if (closed) return { signal: "SIGTERM", processAlive: false };
  try { process.kill(-pid, "SIGKILL"); } catch { return { signal: "SIGTERM", processAlive: false }; }
  await handle.exit;
  return { signal: "SIGKILL", processAlive: false };
};

const heartbeat = async (handle: RuntimeHandle): Promise<HeartbeatSnapshot> => {
  const processAlive = handle.child.exitCode === null && handle.child.signalCode === null;
  if (processAlive) handle.lastProcessAliveAt = new Date();
  return {
    processAlive,
    lastProcessAliveAt: handle.lastProcessAliveAt,
    lastProgressEventAt: handle.lastProgressEventAt,
    inFlightTool: handle.inFlightTool,
  };
};

const makeAdapter = (runner: RunnerKind): CliAdapter => ({
  preflight: (spec) => preflight({ ...spec, runner }),
  start: async (spec, sink) => spawnRuntime(runner, spec, sink),
  resume: async (spec, sink) => spawnRuntime(runner, spec, sink, spec),
  kill,
  heartbeat,
  classifyError,
});

export const adapters: Record<RunnerKind, CliAdapter> = {
  CLAUDE: makeAdapter("CLAUDE"),
  CODEX: makeAdapter("CODEX"),
  PI: makeAdapter("PI"),
};

export const manifestFor = (spec: RunSpec): Record<string, unknown> => ({
  adapterVersion: ADAPTER_VERSION,
  runner: spec.claim.runner,
  binary: spec.config.binaries[spec.claim.runner],
  runAsPrefix: spec.config.runAsPrefix,
  model: spec.claim.run.model,
  promptHash: createHash("sha256").update(spec.prompt).digest("hex"),
  structuredEvents: true,
});
