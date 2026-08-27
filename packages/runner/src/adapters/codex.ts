import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClaimedTask } from "../api.js";
import type { RunnerConfig, RunnerKind } from "../config.js";
import type { AgentScratch } from "../workspace.js";
import {
  asRecord,
  capturePreflight,
  classifyRuntimeError,
  createAdapterState,
  emitAdapterEvent,
  eventErrorMessage,
  heartbeatRuntime,
  killRuntime,
  markInFlightToolProgress,
  mcpServerArgs,
  modelSpec,
  nodeBinaryPath,
  PREFLIGHT_REASONS,
  preflightFailure,
  processProviderEvent,
  spawnAdapterRuntime,
  stringField,
  type AdapterImplementation,
  type AdapterState,
  type CliAdapter,
  type PreflightResult,
  type PreflightSpec,
  type ResumeSpec,
  type RunSpec,
  type SessionEventSink,
} from "../adapters.js";
import { provisionIsolatedSessionConfig, type SessionConfigOptions } from "./session-config.js";

export const CODEX_STARTER_MODEL = "gpt-5.6-sol:medium";

export const codexNativeSubagentProfile = (run: ClaimedTask["run"], runner: RunnerKind): {
  model: string;
  effort: string;
  maxConcurrent: number;
} | null => {
  if (run.subagentModel === null && run.subagentMaxConcurrent === null) return null;
  if (run.subagentModel === null || run.subagentMaxConcurrent === null) {
    throw new Error("Run contains an incomplete native subagent snapshot");
  }
  if (runner !== "CODEX") throw new Error("Native implementation subagents require a Codex root Run");
  const { model, effort } = modelSpec(run.subagentModel);
  if (model !== "gpt-5.6-luna" || effort !== "max" || run.subagentMaxConcurrent !== 8) {
    throw new Error("Native implementation subagents must use gpt-5.6-luna:max with concurrency 8");
  }
  return { model, effort, maxConcurrent: run.subagentMaxConcurrent };
};

export const codexSessionConfigBaselineRoot = (): string =>
  fileURLToPath(new URL("../../assets/session-config-baseline", import.meta.url));

export const codexPlatformBaselinePath = (): string => join(
  process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT ?? codexSessionConfigBaselineRoot(),
  "codex",
  "config.toml",
);

const mcpArgs = (credentialsPath: string): string[] => [
  "-c", `mcp_servers.agentos.command=${JSON.stringify(nodeBinaryPath())}`,
  "-c", `mcp_servers.agentos.args=${JSON.stringify(mcpServerArgs(credentialsPath))}`,
  "-c", "mcp_servers.agentos.startup_timeout_sec=30",
];

const nativeSubagentArgs = (run: ClaimedTask["run"]): string[] => {
  const profile = codexNativeSubagentProfile(run, "CODEX");
  if (!profile) return [];
  return [
    "--enable", "multi_agent_v2",
    "-c", `agents.default_subagent_model=${JSON.stringify(profile.model)}`,
    "-c", `agents.default_subagent_reasoning_effort=${JSON.stringify(profile.effort)}`,
    "-c", `agents.max_concurrent_threads_per_session=${profile.maxConcurrent}`,
  ];
};

export const codexArgs = (spec: RunSpec, resume?: ResumeSpec): string[] => {
  const { model, effort } = modelSpec(spec.claim.run.model);
  const serviceTier = spec.claim.run.codexServiceTier.toLowerCase();
  // Codex exposes no supported per-tool deny flags. CliAdapter's interface
  // makes this limitation explicit; disabledTools remains policy metadata and
  // the console marks every Codex tool toggle as not enforced.
  return resume
    ? [
      "exec", "resume", "--json", "-m", model,
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      "-c", `service_tier="${serviceTier}"`,
      ...nativeSubagentArgs(spec.claim.run),
      ...mcpArgs(spec.credentialsPath), resume.providerConversationId, "-",
    ]
    : [
      "exec", "--json", "-m", model,
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
      "-c", `service_tier="${serviceTier}"`,
      ...nativeSubagentArgs(spec.claim.run),
      ...mcpArgs(spec.credentialsPath),
      "--dangerously-bypass-approvals-and-sandbox", "-",
    ];
};

const isReconnectStatus = (message: string | null): boolean =>
  /^Reconnecting\.\.\. \d+\/\d+$/u.test(message?.trim() ?? "");

export const parseCodexEvent = (
  state: AdapterState,
  event: Record<string, unknown>,
  sink: SessionEventSink,
): void => {
  const type = stringField(event, "type");
  if (type === "thread.started") {
    state.providerConversationId = stringField(event, "thread_id") ?? state.providerConversationId;
    emitAdapterEvent(state, sink, "MODEL_STARTED", event);
  } else if (type === "item.started") {
    const item = asRecord(event.item);
    if (stringField(item, "type") === "command_execution") {
      const toolId = stringField(item, "id") ?? "unknown";
      const now = new Date();
      state.inFlightTool = { id: toolId, name: "command_execution", startedAt: now, lastProgressAt: now };
      emitAdapterEvent(state, sink, "TOOL_STARTED", item ?? {}, toolId);
    } else emitAdapterEvent(state, sink, "MODEL_DELTA", event);
  } else if (type === "item.completed") {
    const item = asRecord(event.item);
    if (stringField(item, "type") === "command_execution") {
      state.inFlightTool = null;
      emitAdapterEvent(state, sink, "TOOL_COMPLETED", item ?? {}, stringField(item, "id"));
    } else {
      if (item && stringField(item, "type") === "agent_message") {
        // Codex may report an agent progress message while a long-running
        // command_execution remains open. Raw stderr deliberately does not
        // reach this path, so background warnings cannot renew a stuck tool.
        markInFlightToolProgress(state);
        state.finalOutput = stringField(item, "text") ?? state.finalOutput;
      }
      emitAdapterEvent(state, sink, "MODEL_DELTA", event);
    }
    // A nonzero shell command inside the session is normal agent behavior;
    // only item-level errors count as a run failure.
    if (item?.error) state.sawError = true;
  } else if (type === "error") {
    const message = eventErrorMessage(event);
    // Codex emits reconnect progress through the same `error` event used for
    // terminal provider failures. Keep the latest message as evidence while
    // the stream is disconnected, but do not make it an irreversible verdict:
    // a later turn.completed proves the reconnect recovered. Every other error
    // remains latched, including an unrecognised error with no message.
    if (!isReconnectStatus(message)) state.sawError = true;
    state.providerError = message ?? state.providerError;
    emitAdapterEvent(state, sink, "ADAPTER_ERROR", event);
  } else if (type === "turn.completed") {
    state.terminalEventSeen = true;
    state.terminalSuccess = !state.sawError;
    emitAdapterEvent(state, sink, "FINAL_OUTPUT", event);
  } else emitAdapterEvent(state, sink, "PROVIDER_STATUS", event);
};

export const parseCodexTranscript = (
  transcript: readonly unknown[],
  sink: SessionEventSink = () => undefined,
): AdapterState => {
  const state = createAdapterState("CODEX", "transcript");
  for (const value of transcript) processProviderEvent(state, asRecord(value) ?? { value }, sink, parseCodexEvent);
  return state;
};

const execHelpIsCompatible = (help: string, resumeHelp: string): boolean => [
  "--json",
  "--model",
  "--config",
  "--dangerously-bypass-approvals-and-sandbox",
].every((flag) => help.includes(flag) && resumeHelp.includes(flag))
  && help.includes("resume")
  && resumeHelp.includes("SESSION_ID")
  && resumeHelp.includes("read from stdin");

const preflight = async (spec: PreflightSpec): Promise<PreflightResult> => {
  const capabilities = { structuredEvents: true, resume: true, killProcessGroup: true, heartbeat: true, classifyError: true };
  if (spec.model === null) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: PREFLIGHT_REASONS.unsupportedModel };
  }
  const version = await capturePreflight(spec.config, "CODEX", ["--version"], spec.env);
  if (version.code !== 0) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: preflightFailure(PREFLIGHT_REASONS.cliMissing, version.code) };
  }
  const help = await capturePreflight(spec.config, "CODEX", ["exec", "--help"], spec.env);
  const resumeHelp = await capturePreflight(spec.config, "CODEX", ["exec", "resume", "--help"], spec.env);
  if (help.code !== 0 || resumeHelp.code !== 0 || !execHelpIsCompatible(help.stdout, resumeHelp.stdout)) {
    return {
      ok: false,
      cliVersion: version.stdout.trim() || version.stderr.trim(),
      authMode: null,
      capabilities,
      error: PREFLIGHT_REASONS.cliIncompatible,
    };
  }
  Object.assign(capabilities, { verifiedModel: spec.model, cliProtocol: "exec-json-stdin-resume" });
  const auth = await capturePreflight(spec.config, "CODEX", ["login", "status"], spec.env);
  const text = `${auth.stdout}\n${auth.stderr}`;
  const ok = auth.code === 0;
  return {
    ok,
    cliVersion: version.stdout.trim() || version.stderr.trim(),
    authMode: text.includes("ChatGPT") ? "chatgpt" : null,
    capabilities,
    ...(!ok ? { error: preflightFailure(PREFLIGHT_REASONS.notAuthenticated, auth.code) } : {}),
  };
};

export const codexChildEnvironment = (
  _claim: Pick<ClaimedTask, "run">,
  scratch: AgentScratch,
): NodeJS.ProcessEnv => ({
  // Codex discovers user skills through both $CODEX_HOME/skills and the
  // cross-agent $HOME/.agents/skills root. Keep both inside this session's
  // provisioned config root; auth.json and the platform baseline already live
  // there, so relocating HOME does not change the authentication channel.
  HOME: scratch.configRoot,
  CODEX_HOME: scratch.configRoot,
});

export const provisionCodexSessionConfig = (
  config: RunnerConfig,
  scratch: AgentScratch,
  options: SessionConfigOptions = {},
): Promise<void> => provisionIsolatedSessionConfig(config, scratch, {
  label: "Codex",
  authFile: join(config.home, ".codex", "auth.json"),
  baselineFile: join(config.sessionConfigBaselineRoot ?? codexSessionConfigBaselineRoot(), "codex", "config.toml"),
}, options);

const implementation: AdapterImplementation = {
  runner: "CODEX",
  args: codexArgs,
  parseEvent: parseCodexEvent,
};

export const createCodexAdapter = (): CliAdapter => Object.freeze<CliAdapter>({
  preflight: (spec) => preflight({ ...spec, runner: "CODEX" }),
  start: async (spec, sink) => spawnAdapterRuntime(implementation, spec, sink),
  resume: async (spec, sink) => spawnAdapterRuntime(implementation, spec, sink, spec),
  kill: (handle, reason) => killRuntime(handle, reason),
  heartbeat: (handle) => heartbeatRuntime(handle),
  classifyError: (evidence) => classifyRuntimeError(evidence),
});
