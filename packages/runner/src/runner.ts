import {
  ADAPTER_VERSION,
  adapterExecutionSucceeded,
  adapters,
  buildChildEnvironment,
  buildPrompt,
  failureReasonFromEvidence,
  manifestFor,
  outputTail,
  PREFLIGHT_CLASS,
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
  recordPublishedBranch,
  reportPreflight,
  startRun,
  type ClaimedTask,
  type CleanupStatus,
  type SessionEventPayload,
} from "./api.js";
import { evaluateBudget } from "./budget.js";
import type { RunnerConfig, RunnerKind } from "./config.js";
import { deliverFailedWorkspace, deliverWorkspace } from "./delivery.js";
import {
  buildFailureEnvelope,
  completionEnvelope,
  type FailurePhase,
  RUNNER_EXCEPTION_REASON,
  runnerExceptionEnvelope,
} from "./envelope.js";
import { deliverUnderLease, openDeliveryLease, type DeliveryLease } from "./lease.js";
import {
  captureWorkspaceResult, cleanupAgentScratch, cleanupWorkspace, provisionAgentScratch, provisionWorkspace,
  reuseWorkspace, workspaceEnvironment, writeSessionCredentials, type AgentScratch, type Workspace,
} from "./workspace.js";

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
  // 127 is what "the CLI is not there" means downstream (BINARY_NOT_FOUND). The
  // preflight now names that case itself rather than leaving it to be read out
  // of a spawn error's wording, which is also CLI output nobody bounded.
  exitCode: message.startsWith(PREFLIGHT_CLASS.cliMissing) || message.includes("No such file") || message.includes("ENOENT") ? 127 : 1,
  signal: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  finalOutput: null,
  providerError: null,
  terminationReason: null,
  stdout: "",
  stderr: message,
});

export const executeClaim = async (config: RunnerConfig, claim: ClaimedTask): Promise<void> => {
  const adapter = adapters[claim.runner];
  let workspace: Workspace | null = null;
  let scratch: AgentScratch | null = null;
  let handle: RuntimeHandle | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let lease: DeliveryLease | null = null;
  let heartbeatBusy = false;
  let fencingRejected = false;
  let waitingInbox = false;
  let budgetReason: string | null = null;
  // Where the run is, for the failure envelope. The API reads this to decide
  // whether a failed attempt spends the task's budget: only EXECUTE is the
  // agent's own work, everything else is this process's plumbing.
  let phase: FailurePhase = "PROVISION";
  // What the agent produced, saved the moment its process exits and before any
  // of the DELIVER-phase work that can throw. The catch path rebuilds its
  // evidence out of an error message alone, so a lease, an event flush or a
  // cleanup that fails after a finished agent would otherwise complete the run
  // with the exception text and nothing else — discarding the account of a run
  // that had already produced one, which is the exact loss issue #114 is about,
  // one stage further along.
  let producedOutput: string | null = null;
  // The lease the claim granted; every successful heartbeat below moves it.
  // Delivery derives its deadline from this, not from "now", because by the
  // time the agent exits the last renewal can already be half a lease old.
  let leaseRenewedAt = Date.now();
  let seq = claim.nextEventSeq;
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
    // §D-P1 rule 4 — defence in depth behind the claim-side allowlist, and the
    // FIRST thing this function does. Everything below it constructs something a
    // merge credential must never be near: a workspace, a prompt, a child
    // environment, an adapter preflight, a spawned CLI, a delivery push. A
    // mechanical run reaching an ordinary runner means the allowlist was
    // misconfigured; the run is failed closed and non-retryable rather than
    // executed, because retrying it here would just repeat the violation.
    if (claim.executionMode === "mechanical") {
      await completeRun(config, claim, {
        exitCode: null,
        terminalEventSeen: false,
        terminalSuccess: false,
        terminationReason: "mechanical run claimed by a model runner",
        failureClass: "PROTOCOL_ERROR",
        failureReason: "This runner does not execute mechanical runs; @agentos/merge-executor does",
        retryable: false,
        cleanupStatus: "SUCCEEDED",
        workspaceRetained: false,
      });
      return;
    }
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
        failureEnvelope: buildFailureEnvelope({
          phase,
          evidence: { ...preflightEvidence("Maximum run budget exceeded before launch"), exitCode: null },
          agentExited: false,
          runnerClass: "BUDGET_EXCEEDED",
          terminationReason: "max-runs budget exceeded",
        }),
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
      }).then(() => { leaseRenewedAt = Date.now(); }).catch((error: unknown) => {
        if ((error as { status?: number; code?: string }).status === 409) {
          waitingInbox = (error as { code?: string }).code === "WAITING_INBOX";
          fencingRejected = true;
        }
        else console.error("Provisioning heartbeat failed", error);
      });
    }, config.heartbeatIntervalMs);
    workspace = claim.resume ? await reuseWorkspace(config, claim) : await provisionWorkspace(config, claim);
    const prompt = buildPrompt(claim);
    scratch = await provisionAgentScratch(config);
    const env = buildChildEnvironment(config, claim, scratch);
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
        externalFailure: true,
        failureEnvelope: buildFailureEnvelope({
          phase,
          evidence,
          agentExited: false,
          runnerClass: classified.failureClass,
        }),
        branch: workspace.branch,
        baseSha: workspace.baseSha,
        headSha: workspace.baseSha,
        ...finishedCleanup,
      });
      return;
    }

    const credentialsPath = await writeSessionCredentials(config, claim, workspace);
    const spec = { config, claim, workingDirectory: workspace.path, env, prompt, credentialsPath };
    handle = claim.resume
      ? await adapter.resume({ ...spec, ...claim.resume }, sink)
      : await adapter.start(spec, sink);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    phase = "EXECUTE";
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
        if (snapshot.processAlive) leaseRenewedAt = Date.now();
      })().catch(async (error: unknown) => {
        if ((error as { status?: number; code?: string }).status === 409 && handle) {
          waitingInbox = (error as { code?: string }).code === "WAITING_INBOX";
          fencingRejected = true;
          await adapter.kill(handle, waitingInbox ? "waiting for Inbox reply" : "fencing token rejected").catch(() => undefined);
        } else console.error("Run heartbeat failed", error);
      }).finally(() => { heartbeatBusy = false; });
    }, config.heartbeatIntervalMs);

    const evidence = await handle.exit;
    producedOutput = outputTail(evidence);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    phase = "DELIVER";
    // The agent process is gone, but the runner is not done: it still has to
    // flush events, snapshot git, push, talk to GitHub, clean up the workspace
    // and record terminal completion — and the API requires a live lease for
    // the publication and completion writes. lease.ts owns that phase: it
    // renews the lease across it, refuses to let the phase outlive the lease,
    // and — the part a bare heartbeat loop would miss — reports when the
    // control plane has revoked this runner's authority.
    lease = await openDeliveryLease(config, claim, leaseRenewedAt);
    const adoptLeaseVerdict = (openLease: DeliveryLease): void => {
      if (!openLease.rejected) return;
      fencingRejected = true;
      waitingInbox = openLease.waitingInbox;
    };
    adoptLeaseVerdict(lease);
    await flushEvents();
    await eventWrites;
    // Re-read: a periodic renewal may have been rejected while the events above
    // were still draining, and everything past this point writes to a remote.
    adoptLeaseVerdict(lease);
    if (fencingRejected) {
      if (waitingInbox) return;
      await cleanup(config, workspace, false);
      return;
    }
    const executionSucceeded = adapterExecutionSucceeded(evidence);
    let delivery: Awaited<ReturnType<typeof deliverWorkspace>> | null = null;
    let gitResult = { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha };
    try { gitResult = await captureWorkspaceResult(config, workspace); } catch (error: unknown) {
      await appendActivity(config, claim, `Unable to snapshot git result: ${errorMessage(error)}`, { stream: "runner" });
    }
    // Bound outside the closures below: `workspace` is nullable at the top of
    // this function, and the narrowing does not survive into a callback.
    const delivered = { ...workspace, branch: gitResult.branch };
    if (executionSucceeded) delivery = await deliverUnderLease(lease, (retryOptions) => deliverWorkspace(
      config,
      claim,
      delivered,
      undefined,
      (branch) => recordPublishedBranch(config, claim, branch),
      retryOptions,
    ));
    else {
      // The workspace is about to be destroyed; commit and salvage its trackable changes.
      const salvage = await deliverUnderLease(lease, (retryOptions) =>
        deliverFailedWorkspace(config, claim, delivered, undefined, retryOptions))
        .catch((error: unknown) => {
          void appendActivity(config, claim, `WIP salvage failed: ${errorMessage(error)}`, { stream: "runner" }).catch(() => undefined);
          return null;
        });
      if (salvage) {
        delivery = salvage;
        if (salvage.headSha) gitResult = { ...gitResult, headSha: salvage.headSha };
        await appendActivity(config, claim, salvage.deliveryInstructions ?? salvage.pushError ?? "WIP salvage attempted", { stream: "runner" })
          .catch(() => undefined);
      }
    }
    const succeeded = executionSucceeded && delivery?.pushStatus !== "FAILED";
    const classified = succeeded ? null : delivery?.failureClass
      ? { failureClass: delivery.failureClass, retryable: false }
      : adapter.classifyError(evidence);
    // Destructured off rather than spread: `failure` holds a live error object
    // for the envelope builder, and everything else in a DeliveryResult goes on
    // the wire. TypeScript does not flag excess properties introduced by a
    // spread, so nothing but this line keeps it out of the completion payload.
    const { failure: deliveryFailure, ...deliveryPayload } = delivery ?? { pushStatus: "NOT_REQUESTED" as const };
    const finishedCleanup = await cleanup(config, workspace, !succeeded && config.failedWorkspaceRetention > 0);
    // Stop renewing before the terminal write: a heartbeat racing a completed
    // run is a guaranteed 409 and pure log noise. The last renewal is at most
    // one heartbeat interval old — half the lease — and the completion call is
    // itself bounded by RUNNER_API_TIMEOUT_MS, so it cannot outlive that.
    lease.close();
    await completeRun(config, claim, {
      exitCode: evidence.exitCode,
      signal: evidence.signal,
      terminalEventSeen: evidence.terminalEventSeen,
      terminalSuccess: succeeded && evidence.terminalSuccess,
      terminationReason: budgetReason ?? evidence.terminationReason,
      ...(classified ? { failureClass: budgetReason ? "BUDGET_EXCEEDED" : classified.failureClass, retryable: budgetReason ? false : classified.retryable } : {}),
      // A salvage push failure must not mask why the run itself failed.
      ...(!succeeded ? { failureReason: budgetReason ?? (executionSucceeded ? delivery?.pushError : null) ?? failureReasonFromEvidence(evidence) } : {}),
      output: outputTail(evidence),
      // Only a failure carries one: the envelope is the account of what went
      // wrong, and `executionSucceeded` decides which side of the agent/plumbing
      // line it went wrong on. A run whose agent finished and whose push failed
      // is a DELIVER failure, and the API must not charge the task for it.
      ...(succeeded ? {} : {
        failureEnvelope: completionEnvelope({
          executionSucceeded,
          evidence,
          deliveryFailure,
          runnerClass: budgetReason ? "BUDGET_EXCEEDED" : classified?.failureClass ?? null,
          terminationReason: budgetReason ?? evidence.terminationReason,
        }),
      }),
      ...gitResult,
      ...deliveryPayload,
      ...finishedCleanup,
    });
  } catch (error: unknown) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if ((error as { status?: number; code?: string }).status === 409 && (error as { code?: string }).code === "WAITING_INBOX") {
      waitingInbox = true;
      fencingRejected = true;
      if (handle) await adapter.kill(handle, "waiting for Inbox reply").catch(() => undefined);
      return;
    }
    const message = errorMessage(error);
    if (handle) await adapter.kill(handle, RUNNER_EXCEPTION_REASON).catch(() => undefined);
    if (fencingRejected) {
      if (waitingInbox) return;
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
      terminationReason: RUNNER_EXCEPTION_REASON,
      failureClass: classified.failureClass,
      failureReason: message,
      retryable: classified.retryable,
      externalFailure: true,
      failureEnvelope: runnerExceptionEnvelope({ phase, evidence, runnerClass: classified.failureClass, error }),
      // Null until the agent has exited, so a run that never got that far still
      // sends nothing; past that point this is the agent's own output and it
      // survives whatever went wrong afterwards. `evidence` above cannot supply
      // it — it is reconstructed from the error, not from the process.
      output: producedOutput,
      ...(workspace ? { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha } : {}),
      ...finishedCleanup,
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    lease?.close();
    // Throwaway by construction, so losing it costs nothing and leaving it
    // behind would leak a directory per run.
    if (scratch) await cleanupAgentScratch(config, scratch).catch(() => undefined);
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
