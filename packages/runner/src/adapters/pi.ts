import { join } from "node:path";

import type { ClaimedTask } from "../api.js";
import type { RunnerConfig } from "../config.js";
import type { AgentScratch } from "../workspace.js";
import {
  asRecord,
  capturePreflight,
  classifyRuntimeError,
  createAdapterState,
  emitAdapterEvent,
  heartbeatRuntime,
  killRuntime,
  modelSpec,
  PI_TOOL_NAMES,
  piExtensionPath,
  PREFLIGHT_REASONS,
  preflightFailure,
  processProviderEvent,
  spawnAdapterRuntime,
  stringField,
  TOOL_ORDER,
  type AdapterImplementation,
  type AdapterState,
  type CliAdapter,
  type PiUsageTotals,
  type PreflightResult,
  type PreflightSpec,
  type ResumeSpec,
  type RunSpec,
  type SessionEventSink,
  type ToolKey,
} from "../adapters.js";
import { provisionIsolatedSessionConfig, type SessionConfigOptions } from "./session-config.js";

const denyArgs = (disabledTools: string[]): string[] => {
  const denied = new Set(disabledTools);
  const names = TOOL_ORDER.flatMap((tool: ToolKey) => {
    const name = denied.has(tool) ? PI_TOOL_NAMES[tool] : undefined;
    return name ? [name] : [];
  });
  return names.length === 0 ? [] : ["--exclude-tools", names.join(",")];
};

export const piArgs = (spec: RunSpec, resume?: ResumeSpec): string[] => {
  const { model, effort } = modelSpec(spec.claim.run.model);
  return [
    "-p", "--mode", "json", "--session-dir", join(spec.workingDirectory, ".agentos-pi"),
    "--model", model,
    ...(effort ? ["--thinking", effort] : []),
    ...denyArgs(spec.claim.agent.disabledTools),
    // Disable PI's $PI_CODING_AGENT_DIR/skills discovery (normally
    // ~/.pi/agent/skills) and the other user resource classes. The config root
    // is fresh, so only the explicit Anneal extension below remains enabled.
    // The reviewer's role prompt supplies its rules, and repository context
    // files remain review material rather than instructions.
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--extension", piExtensionPath(),
    ...(resume ? ["--session", resume.providerConversationId] : []),
  ];
};

/** PI prices per message in USD; the accumulator carries integer nano-USD. */
const NANOS_PER_USD = 1_000_000_000;

const piNumber = (value: unknown, field: string, integral: boolean): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integral || Number.isInteger(value))) return value;
  console.warn(JSON.stringify({ audit: "pi-usage", event: "field-dropped", field, value: String(value) }));
  return null;
};

/**
 * Fold one PI message's usage into the session totals.
 *
 * A captured `pi --mode json` transcript establishes that only assistant
 * `message_end` events contribute: `turn_end` repeats the same usage object.
 * PI's input excludes cacheRead, output includes reasoning, and cost.total is
 * per-message USD. Costs therefore accumulate as integer nano-USD and round
 * only once at the storage boundary.
 */
const harvestUsage = (totals: PiUsageTotals, message: Record<string, unknown>): void => {
  totals.messages += 1;
  const usage = asRecord(message.usage);
  if (!usage) return;
  totals.reported += 1;
  const input = piNumber(usage.input, "input", true);
  if (input !== null) totals.input = (totals.input ?? 0) + input;
  const output = piNumber(usage.output, "output", true);
  if (output !== null) totals.output = (totals.output ?? 0) + output;
  const cacheRead = piNumber(usage.cacheRead, "cacheRead", true);
  if (cacheRead !== null) totals.cacheRead = (totals.cacheRead ?? 0) + cacheRead;
  const cacheWrite = piNumber(usage.cacheWrite, "cacheWrite", true);
  if (cacheWrite !== null) totals.cacheWrite = (totals.cacheWrite ?? 0) + cacheWrite;
  const cost = piNumber(asRecord(usage.cost)?.total, "cost.total", false);
  if (cost !== null) {
    const nanos = Math.round(cost * NANOS_PER_USD);
    if (!Number.isSafeInteger(nanos) || !Number.isSafeInteger((totals.costNanoUsd ?? 0) + nanos)) {
      console.warn(JSON.stringify({ audit: "pi-usage", event: "field-dropped", field: "cost.total", value: String(cost) }));
    } else totals.costNanoUsd = (totals.costNanoUsd ?? 0) + nanos;
  }
};

const usagePayload = (totals: PiUsageTotals): Record<string, unknown> => ({
  messages: totals.messages,
  reported: totals.reported,
  ...(totals.input === null ? {} : { input: totals.input }),
  ...(totals.output === null ? {} : { output: totals.output }),
  ...(totals.cacheRead === null ? {} : { cacheRead: totals.cacheRead }),
  ...(totals.cacheWrite === null ? {} : { cacheWrite: totals.cacheWrite }),
  ...(totals.costNanoUsd === null ? {} : { costNanoUsd: totals.costNanoUsd }),
});

const usageGaps = (totals: PiUsageTotals): string[] => {
  if (totals.messages === 0) return ["PI settled without ending a single assistant message"];
  if (totals.reported === 0) return [`PI reported no usage on any of ${totals.messages} assistant message(s)`];
  const gaps: string[] = [];
  if (totals.reported < totals.messages) {
    gaps.push(`PI reported usage on only ${totals.reported} of ${totals.messages} assistant message(s)`);
  }
  if ((totals.input ?? 0) + (totals.output ?? 0) === 0) gaps.push("PI reported no tokens");
  if ((totals.costNanoUsd ?? 0) === 0) gaps.push("PI reported no cost");
  return gaps;
};

export const parsePiEvent = (
  state: AdapterState,
  event: Record<string, unknown>,
  sink: SessionEventSink,
): void => {
  const type = stringField(event, "type");
  if (type === "session") {
    state.providerConversationId = stringField(event, "id") ?? state.providerConversationId;
    emitAdapterEvent(state, sink, "MODEL_STARTED", event);
  } else if (type === "tool_execution_start") {
    const toolId = stringField(event, "toolCallId") ?? "unknown";
    const now = new Date();
    state.inFlightTool = { id: toolId, name: stringField(event, "toolName") ?? "tool", startedAt: now, lastProgressAt: now };
    emitAdapterEvent(state, sink, "TOOL_STARTED", event, toolId);
  } else if (type === "tool_execution_update") {
    if (state.inFlightTool) state.inFlightTool.lastProgressAt = new Date();
    emitAdapterEvent(state, sink, "TOOL_PROGRESS", event, stringField(event, "toolCallId"));
  } else if (type === "tool_execution_end") {
    state.inFlightTool = null;
    emitAdapterEvent(state, sink, "TOOL_COMPLETED", event, stringField(event, "toolCallId"));
  } else if (type === "turn_end" || type === "message_end") {
    state.piTurnCompleted = true;
    const message = asRecord(event.message);
    if (type === "message_end" && message && stringField(message, "role") === "assistant") {
      harvestUsage(state.piUsage, message);
    }
    if (message && stringField(message, "role") === "assistant" && Array.isArray(message.content)) {
      const text = message.content
        .map((part) => stringField(asRecord(part) ?? {}, "text"))
        .filter((part): part is string => part !== null)
        .join("\n");
      if (text) state.finalOutput = text;
    }
    emitAdapterEvent(state, sink, "MODEL_COMPLETED", event);
  } else if (type === "agent_end") {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const finalMessage = asRecord(messages.at(-1));
    const stopReason = stringField(finalMessage, "stopReason");
    const errorMessage = stringField(finalMessage, "errorMessage");
    state.piFinalAttemptFailed = event.willRetry === true || stopReason === "error" || errorMessage !== null;
    state.providerError = state.piFinalAttemptFailed
      ? errorMessage ?? (stopReason ? `PI stopped with ${stopReason}` : "PI provider retry failed")
      : null;
    emitAdapterEvent(state, sink, "PROVIDER_STATUS", event);
  } else if (type === "agent_settled") {
    state.terminalEventSeen = true;
    state.terminalSuccess = state.piTurnCompleted && !state.piFinalAttemptFailed && !state.sawError;
    const gaps = usageGaps(state.piUsage);
    if (gaps.length > 0) {
      const reason = gaps.join("; ");
      console.warn(JSON.stringify({ audit: "pi-usage", event: "incomplete", runId: state.runId, reason }));
      emitAdapterEvent(state, sink, "ADAPTER_ERROR", { error: `Session cost is incomplete: ${reason}`, ...usagePayload(state.piUsage) });
    }
    emitAdapterEvent(state, sink, "FINAL_OUTPUT", state.piUsage.reported === 0
      ? event
      : { ...event, agentosPiUsage: usagePayload(state.piUsage) });
  } else {
    if (type?.includes("error")) state.sawError = true;
    emitAdapterEvent(state, sink, type?.includes("message") ? "MODEL_DELTA" : "PROVIDER_STATUS", event);
  }
};

export const parsePiTranscript = (
  transcript: readonly unknown[],
  sink: SessionEventSink = () => undefined,
): AdapterState => {
  const state = createAdapterState("PI", "transcript");
  for (const value of transcript) processProviderEvent(state, asRecord(value) ?? { value }, sink, parsePiEvent);
  return state;
};

const helpIsCompatible = (help: string): boolean => [
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
].every((flag) => help.includes(flag));

const preflight = async (spec: PreflightSpec): Promise<PreflightResult> => {
  const capabilities = { structuredEvents: true, resume: true, killProcessGroup: true, heartbeat: true, classifyError: true };
  if (spec.model === null || !spec.model.includes("/")) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: PREFLIGHT_REASONS.unsupportedModel };
  }
  if (spec.model.startsWith("openai-codex/") && spec.env.AGENTOS_RUN_ID
    && spec.env.AGENTOS_CODEX_SERVICE_TIER !== "default" && spec.env.AGENTOS_CODEX_SERVICE_TIER !== "fast") {
    return {
      ok: false,
      cliVersion: null,
      authMode: null,
      capabilities,
      error: "PI openai-codex runs require an explicit Anneal Codex service tier",
    };
  }
  const version = await capturePreflight(spec.config, "PI", ["--version"], spec.env);
  if (version.code !== 0) {
    return { ok: false, cliVersion: null, authMode: null, capabilities, error: preflightFailure(PREFLIGHT_REASONS.cliMissing, version.code) };
  }
  const help = await capturePreflight(spec.config, "PI", ["--help"], spec.env);
  if (help.code !== 0 || !helpIsCompatible(`${help.stdout}\n${help.stderr}`)) {
    return {
      ok: false,
      cliVersion: version.stdout.trim() || version.stderr.trim(),
      authMode: null,
      capabilities,
      error: PREFLIGHT_REASONS.cliIncompatible,
    };
  }
  Object.assign(capabilities, { verifiedModel: spec.model, cliProtocol: "json-stdin-resume-isolated" });
  const provider = spec.model.split("/")[0] ?? "openai-codex";
  const auth = await capturePreflight(spec.config, "PI", ["auth", "check", "--provider", provider], spec.env);
  const ok = auth.code === 0;
  return {
    ok,
    cliVersion: version.stdout.trim() || version.stderr.trim(),
    authMode: provider,
    capabilities,
    ...(!ok ? { error: preflightFailure(PREFLIGHT_REASONS.notAuthenticated, auth.code) } : {}),
  };
};

export const piChildEnvironment = (
  claim: Pick<ClaimedTask, "run">,
  scratch: AgentScratch,
): NodeJS.ProcessEnv => ({
  // PI's other global skill root is $HOME/.agents/skills, independent of
  // PI_CODING_AGENT_DIR. Keep it inside the session as well. Authentication is
  // copied into the explicit config root below, so relocating HOME preserves
  // the existing auth channel.
  HOME: scratch.configRoot,
  PI_CODING_AGENT_DIR: scratch.configRoot,
  ...(claim.run.model.startsWith("openai-codex/") ? { AGENTOS_PI_EXPECTS_OPENAI_CODEX: "1" } : {}),
});

export const provisionPiSessionConfig = (
  config: RunnerConfig,
  scratch: AgentScratch,
  options: SessionConfigOptions = {},
): Promise<void> => provisionIsolatedSessionConfig(config, scratch, {
  label: "PI",
  authFile: join(config.home, ".pi", "agent", "auth.json"),
}, options);

const implementation: AdapterImplementation = {
  runner: "PI",
  args: piArgs,
  parseEvent: parsePiEvent,
};

export const createPiAdapter = (): CliAdapter => Object.freeze<CliAdapter>({
  preflight: (spec) => preflight({ ...spec, runner: "PI" }),
  start: async (spec, sink) => spawnAdapterRuntime(implementation, spec, sink),
  resume: async (spec, sink) => spawnAdapterRuntime(implementation, spec, sink, spec),
  kill: (handle, reason) => killRuntime(handle, reason),
  heartbeat: (handle) => heartbeatRuntime(handle),
  classifyError: (evidence) => classifyRuntimeError(evidence),
});
