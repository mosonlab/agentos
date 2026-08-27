import type { ClaimedTask } from "../api.js";
import type { RunnerConfig } from "../config.js";
import type { AgentScratch } from "../workspace.js";
import {
  asRecord,
  CLAUDE_TOOL_NAMES,
  capturePreflight,
  claudePlatformSettingsPath,
  classifyRuntimeError,
  createAdapterState,
  emitAdapterEvent,
  heartbeatRuntime,
  killRuntime,
  mcpConfig,
  modelSpec,
  PREFLIGHT_REASONS,
  preflightFailure,
  processProviderEvent,
  spawnAdapterRuntime,
  stringField,
  TOOL_ORDER,
  type AdapterImplementation,
  type AdapterState,
  type CliAdapter,
  type PreflightResult,
  type PreflightSpec,
  type ResumeSpec,
  type RunSpec,
  type SessionEventSink,
  type ToolKey,
} from "../adapters.js";
import type { SessionConfigOptions } from "./session-config.js";

const denyArgs = (disabledTools: string[]): string[] => {
  const denied = new Set(disabledTools);
  const names = TOOL_ORDER.flatMap((tool: ToolKey) => denied.has(tool) ? [CLAUDE_TOOL_NAMES[tool]] : []);
  return names.length === 0 ? [] : ["--disallowedTools", names.join(",")];
};

export const claudeArgs = (spec: RunSpec, resume?: ResumeSpec): string[] => {
  const { model, effort } = modelSpec(spec.claim.run.model);
  return [
    "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose",
    // Model must be pinned explicitly; the CLI otherwise inherits the
    // operator's personal default, which is reserved quota.
    "--model", model, "--effort", effort ?? "high",
    ...denyArgs(spec.claim.agent.disabledTools),
    // Excluding the user source prevents host CLAUDE.md, settings, hooks,
    // plugins, memory, and ~/.claude/skills from entering the session.
    // Authentication remains the CLI's existing Keychain flow: no
    // CLAUDE_CONFIG_DIR or HOME override is supplied here.
    "--setting-sources", "project,local", "--settings", claudePlatformSettingsPath(),
    // strict keeps the operator's personal MCP servers out of an agent session:
    // the manifest is supposed to be the whole tool surface.
    "--mcp-config", JSON.stringify(mcpConfig(spec.credentialsPath)), "--strict-mcp-config",
    ...(resume ? ["--resume", resume.providerConversationId] : []),
  ];
};

export const parseClaudeEvent = (
  state: AdapterState,
  event: Record<string, unknown>,
  sink: SessionEventSink,
): void => {
  const type = stringField(event, "type");
  if (type === "system") {
    state.providerConversationId = stringField(event, "session_id") ?? state.providerConversationId;
    emitAdapterEvent(state, sink, "MODEL_STARTED", event);
  } else if (type === "assistant") {
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      const part = asRecord(item);
      if (stringField(part, "type") === "tool_use") {
        const toolId = stringField(part, "id") ?? "unknown";
        const now = new Date();
        state.inFlightTool = { id: toolId, name: stringField(part, "name") ?? "tool", startedAt: now, lastProgressAt: now };
        emitAdapterEvent(state, sink, "TOOL_STARTED", part ?? {}, toolId);
      }
    }
    emitAdapterEvent(state, sink, "MODEL_DELTA", event);
  } else if (type === "user") {
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      const part = asRecord(item);
      if (stringField(part, "type") === "tool_result") {
        const toolId = stringField(part, "tool_use_id");
        state.inFlightTool = null;
        emitAdapterEvent(state, sink, "TOOL_COMPLETED", part ?? {}, toolId);
      }
    }
  } else if (type === "result") {
    state.terminalEventSeen = true;
    state.terminalSuccess = event.is_error === false && event.terminal_reason === "completed";
    if (!state.terminalSuccess) state.sawError = true;
    if (event.is_error === true) state.providerError = stringField(event, "result") ?? state.providerError;
    state.finalOutput = stringField(event, "result") ?? state.finalOutput;
    emitAdapterEvent(state, sink, "FINAL_OUTPUT", event);
  } else {
    emitAdapterEvent(state, sink, "PROVIDER_STATUS", event);
  }
};

export const parseClaudeTranscript = (
  transcript: readonly unknown[],
  sink: SessionEventSink = () => undefined,
): AdapterState => {
  const state = createAdapterState("CLAUDE", "transcript");
  for (const value of transcript) processProviderEvent(state, asRecord(value) ?? { value }, sink, parseClaudeEvent);
  return state;
};

const preflight = async (spec: PreflightSpec): Promise<PreflightResult> => {
  const capabilities = { structuredEvents: true, resume: true, killProcessGroup: true, heartbeat: true, classifyError: true };
  const version = await capturePreflight(spec.config, "CLAUDE", ["--version"], spec.env);
  if (version.code !== 0) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: preflightFailure(PREFLIGHT_REASONS.cliMissing, version.code) };
  }
  const help = await capturePreflight(spec.config, "CLAUDE", ["--help"], spec.env);
  if (help.code !== 0 || !`${help.stdout}\n${help.stderr}`.includes("--setting-sources")) {
    return {
      ok: false,
      cliVersion: version.stdout.trim() || version.stderr.trim(),
      authMode: null,
      capabilities,
      error: PREFLIGHT_REASONS.cliIncompatible,
    };
  }
  Object.assign(capabilities, { verifiedModel: spec.model, cliProtocol: "print-stream-json-user-source-isolated" });
  const auth = await capturePreflight(spec.config, "CLAUDE", ["auth", "status"], spec.env);
  const text = `${auth.stdout}\n${auth.stderr}`;
  const ok = auth.code === 0 && /"loggedIn"\s*:\s*true/u.test(text);
  return {
    ok,
    cliVersion: version.stdout.trim() || version.stderr.trim(),
    authMode: /"authMethod"\s*:\s*"([^"]+)"/u.exec(text)?.[1] ?? null,
    capabilities,
    ...(!ok ? { error: preflightFailure(PREFLIGHT_REASONS.notAuthenticated, auth.code) } : {}),
  };
};

export const claudeChildEnvironment = (
  _claim: Pick<ClaimedTask, "run">,
  _scratch: AgentScratch,
): NodeJS.ProcessEnv => ({});

/** Claude deliberately has no config-root strategy; authentication stays in Keychain. */
export const provisionClaudeSessionConfig = async (
  _config: RunnerConfig,
  _scratch: AgentScratch,
  _options: SessionConfigOptions = {},
): Promise<void> => undefined;

const implementation: AdapterImplementation = {
  runner: "CLAUDE",
  args: claudeArgs,
  parseEvent: parseClaudeEvent,
};

export const createClaudeAdapter = (): CliAdapter => Object.freeze<CliAdapter>({
  preflight: (spec) => preflight({ ...spec, runner: "CLAUDE" }),
  start: async (spec, sink) => spawnAdapterRuntime(implementation, spec, sink),
  resume: async (spec, sink) => spawnAdapterRuntime(implementation, spec, sink, spec),
  kill: (handle, reason) => killRuntime(handle, reason),
  heartbeat: (handle) => heartbeatRuntime(handle),
  classifyError: (evidence) => classifyRuntimeError(evidence),
});
