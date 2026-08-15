import {
  ADAPTER_VERSION,
  adapterExecutionSucceeded,
  adapters,
  buildChildEnvironment,
  buildPrompt,
  manifestFor,
  type AdapterEvent,
  type ExitEvidence,
  type RuntimeHandle,
} from "./adapters.js";
import {
  appendActivity,
  appendEvents,
  claimTask,
  completeRun,
  heartbeat as sendHeartbeat,
  reportPreflight,
  startRun,
  type ClaimedTask,
  type CleanupStatus,
  type SessionEventPayload,
} from "./api.js";
import { evaluateBudget } from "./budget.js";
import type { RunnerConfig, RunnerKind } from "./config.js";
import { captureWorkspaceResult, cleanupWorkspace, provisionWorkspace, workspaceEnvironment, type Workspace } from "./workspace.js";

const serializeTool = (tool: RuntimeHandle["inFlightTool"]): Record<string, unknown> | null => tool ? {
  id: tool.id,
  name: tool.name,
  startedAt: tool.startedAt.toISOString(),
  lastProgressAt: tool.lastProgressAt.toISOString(),
} : null;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const cleanup = async (
  config: RunnerConfig,
  workspace: Workspace | null,
  retain: boolean,
): Promise<{ cleanupStatus: CleanupStatus; cleanupFailureReason?: string; workspaceRetained: boolean }> => {
  if (!workspace) return { cleanupStatus: "SUCCEEDED", workspaceRetained: false };
  if (retain) return { cleanupStatus: "RETAINED", workspaceRetained: true };
  try {
    await cleanupWorkspace(config, workspace.path);
    return { cleanupStatus: "SUCCEEDED", workspaceRetained: false };
  } catch (error: unknown) {
    return { cleanupStatus: "FAILED", cleanupFailureReason: errorMessage(error), workspaceRetained: false };
  }
};

const preflightEvidence = (message: string): ExitEvidence => ({
  exitCode: message.includes("No such file") || message.includes("ENOENT") ? 127 : 1,
  signal: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  terminationReason: null,
  stdout: "",
  stderr: message,
});

export const executeClaim = async (config: RunnerConfig, claim: ClaimedTask): Promise<void> => {
  const adapter = adapters[claim.runner];
  let workspace: Workspace | null = null;
  let handle: RuntimeHandle | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatBusy = false;
  let fencingRejected = false;
  let budgetReason: string | null = null;
  let seq = 0;
  let pendingEvents: SessionEventPayload[] = [];
  let eventWrites = Promise.resolve();
  const sink = (event: AdapterEvent): void => {
    pendingEvents.push({
      seq: seq++,
      at: new Date().toISOString(),
      source: event.source,
      type: event.type,
      payload: event.payload,
      ...(event.providerEventId !== undefined ? { providerEventId: event.providerEventId } : {}),
      ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
    });
  };
  const flushEvents = async (): Promise<void> => {
    if (pendingEvents.length === 0 || fencingRejected) return;
    const batch = pendingEvents.splice(0, 250);
    eventWrites = eventWrites.then(() => appendEvents(config, claim, batch, handle?.providerConversationId));
    await eventWrites;
    if (pendingEvents.length > 0) await flushEvents();
  };

  try {
    if (claim.run.runNumber > claim.run.maxRunsPerTask) {
      const finishedCleanup = await cleanup(config, workspace, false);
      await completeRun(config, claim, {
        exitCode: null,
        terminalEventSeen: false,
        terminalSuccess: false,
        terminationReason: "max-runs budget exceeded",
        failureClass: "BUDGET_EXCEEDED",
        failureReason: "Maximum run budget exceeded before launch",
        retryable: false,
        ...finishedCleanup,
      });
      return;
    }

    const provisionStartedAt = new Date();
    heartbeatTimer = setInterval(() => {
      void sendHeartbeat(config, claim, {
        processAlive: true,
        lastProgressEventAt: provisionStartedAt,
        inFlightTool: {
          id: "workspace-provision",
          name: "workspace-provision",
          startedAt: provisionStartedAt.toISOString(),
          lastProgressAt: provisionStartedAt.toISOString(),
        },
      }).catch((error: unknown) => {
        if ((error as { status?: number }).status === 409) fencingRejected = true;
        else console.error("Provisioning heartbeat failed", error);
      });
    }, config.heartbeatIntervalMs);
    workspace = await provisionWorkspace(config, claim);
    const prompt = buildPrompt(claim);
    const env = buildChildEnvironment(config, claim);
    const preflight = await adapter.preflight({ config, runner: claim.runner, model: claim.run.model, env });
    if (fencingRejected) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await cleanup(config, workspace, false);
      return;
    }
    if (!preflight.ok) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const evidence = preflightEvidence(preflight.error ?? "Preflight failed");
      const classified = adapter.classifyError(evidence);
      const finishedCleanup = await cleanup(config, workspace, config.failedWorkspaceRetention > 0);
      await completeRun(config, claim, {
        ...evidence,
        failureClass: classified.failureClass,
        failureReason: preflight.error ?? "Preflight failed",
        retryable: classified.retryable,
        branch: workspace.branch,
        baseSha: workspace.baseSha,
        headSha: workspace.baseSha,
        ...finishedCleanup,
      });
      return;
    }

    const spec = { config, claim, workingDirectory: workspace.path, env, prompt };
    handle = await adapter.start(spec, sink);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await startRun(config, claim, {
      adapterVersion: ADAPTER_VERSION,
      cliVersion: preflight.cliVersion ?? "unknown",
      authMode: preflight.authMode,
      manifest: manifestFor(spec),
      workspacePath: workspace.path,
      branch: workspace.branch,
      baseSha: workspace.baseSha,
      runtimeHandle: handle.pid ? `${config.runnerId}:${handle.pid}` : `${config.runnerId}:pending`,
    });
    await flushEvents();

    heartbeatTimer = setInterval(() => {
      if (!handle || heartbeatBusy || fencingRejected) return;
      heartbeatBusy = true;
      void (async () => {
        const snapshot = await adapter.heartbeat(handle!);
        const decision = evaluateBudget({
          now: new Date(),
          startedAt: handle!.startedAt,
          maxDurationMs: claim.run.maxDurationMin * 60_000,
          currentRunNumber: claim.run.runNumber,
          maxRuns: claim.run.maxRunsPerTask,
          processAlive: snapshot.processAlive,
          lastProgressEventAt: snapshot.lastProgressEventAt,
          stallTimeoutMs: claim.run.stallTimeoutMin * 60_000,
          toolDeadlineMs: config.toolDeadlineMs,
          inFlightTool: snapshot.inFlightTool,
        });
        if (!decision.allowed && snapshot.processAlive) {
          budgetReason = `${decision.gate}: ${decision.reason}`;
          await adapter.kill(handle!, budgetReason);
        }
        await flushEvents();
        await sendHeartbeat(config, claim, {
          processAlive: snapshot.processAlive,
          lastProgressEventAt: snapshot.lastProgressEventAt,
          inFlightTool: serializeTool(snapshot.inFlightTool),
        });
      })().catch(async (error: unknown) => {
        if ((error as { status?: number }).status === 409 && handle) {
          fencingRejected = true;
          await adapter.kill(handle, "fencing token rejected").catch(() => undefined);
        } else console.error("Run heartbeat failed", error);
      }).finally(() => { heartbeatBusy = false; });
    }, config.heartbeatIntervalMs);

    const evidence = await handle.exit;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await flushEvents();
    await eventWrites;
    if (fencingRejected) {
      await cleanup(config, workspace, false);
      return;
    }
    const succeeded = adapterExecutionSucceeded(evidence);
    const classified = succeeded ? null : adapter.classifyError(evidence);
    let gitResult = { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha };
    try { gitResult = await captureWorkspaceResult(config, workspace); } catch (error: unknown) {
      await appendActivity(config, claim, `Unable to snapshot git result: ${errorMessage(error)}`, { stream: "runner" });
    }
    const finishedCleanup = await cleanup(config, workspace, !succeeded && config.failedWorkspaceRetention > 0);
    await completeRun(config, claim, {
      exitCode: evidence.exitCode,
      signal: evidence.signal,
      terminalEventSeen: evidence.terminalEventSeen,
      terminalSuccess: evidence.terminalSuccess,
      terminationReason: budgetReason ?? evidence.terminationReason,
      ...(classified ? { failureClass: budgetReason ? "BUDGET_EXCEEDED" : classified.failureClass, retryable: budgetReason ? false : classified.retryable } : {}),
      ...(!succeeded ? { failureReason: budgetReason ?? (evidence.stderr.trim() || `CLI exited with code ${evidence.exitCode}`) } : {}),
      ...gitResult,
      ...finishedCleanup,
    });
  } catch (error: unknown) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const message = errorMessage(error);
    if (handle) await adapter.kill(handle, "runner exception").catch(() => undefined);
    if (fencingRejected) {
      if (workspace) await cleanup(config, workspace, false);
      return;
    }
    const evidence = preflightEvidence(message);
    const classified = adapter.classifyError(evidence);
    const finishedCleanup = await cleanup(config, workspace, config.failedWorkspaceRetention > 0);
    await appendActivity(config, claim, message, { stream: "stderr" }).catch(() => undefined);
    await completeRun(config, claim, {
      exitCode: evidence.exitCode,
      signal: null,
      terminalEventSeen: false,
      terminalSuccess: false,
      terminationReason: "runner exception",
      failureClass: classified.failureClass,
      failureReason: message,
      retryable: classified.retryable,
      ...(workspace ? { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha } : {}),
      ...finishedCleanup,
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
};

export const pollForTask = async (config: RunnerConfig): Promise<boolean> => {
  const claim = await claimTask(config);
  if (!claim) return false;
  console.log(`Claimed run ${claim.run.id} for task ${claim.task.id} via ${claim.runner.toLowerCase()}`);
  await executeClaim(config, claim);
  return true;
};

export const runStartupPreflight = async (config: RunnerConfig): Promise<Record<RunnerKind, boolean>> => {
  const results = {} as Record<RunnerKind, boolean>;
  const env = workspaceEnvironment(config);
  for (const runner of ["CLAUDE", "CODEX", "PI"] satisfies RunnerKind[]) {
    const model = runner === "PI" ? "openai-codex/gpt-5.6-luna" : runner.toLowerCase();
    const result = await adapters[runner].preflight({ config, runner, model, env });
    results[runner] = result.ok;
    await reportPreflight(config, runner, result);
  }
  return results;
};
