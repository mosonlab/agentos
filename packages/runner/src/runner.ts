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
  CODEX_STARTER_MODEL,
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
  reportCliAvailability,
  reportPreflight,
  startRun,
  type ClaimedTask,
  type CleanupStatus,
  type SessionEventPayload,
} from "./api.js";
import {
  probeSupportedCliAvailability,
  SUPPORTED_RUNNERS,
  type CliAvailability,
} from "./availability.js";
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
  captureWorkspaceResult, cleanupAgentScratch, cleanupWorkspace, provisionAgentScratch, provisionSessionConfig,
  provisionWorkspace, reuseWorkspace, sessionConfigRootExists, workspaceEnvironment, writeSessionCredentials,
  type AgentScratch, type Workspace,
} from "./workspace.js";

const serializeTool = (tool: RuntimeHandle["inFlightTool"]): Record<string, unknown> | null => tool ? {
  id: tool.id,
  name: tool.name,
  startedAt: tool.startedAt.toISOString(),
  lastProgressAt: tool.lastProgressAt.toISOString(),
} : null;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const retainedSessionConfigPath = async (runner: RunnerKind, scratch: AgentScratch | null): Promise<string | null> =>
  runner === "CODEX" && scratch && await sessionConfigRootExists(scratch) ? scratch.configRoot : null;

const appendRetainedSessionConfig = (reason: string, path: string | null): string =>
  `${reason}${path ? `; session CLI config retained at ${path}` : ""}`;

const cleanup = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace | null,
  retain: boolean,
  alreadyDurable = false,
): Promise<{
  cleanupStatus: CleanupStatus;
  cleanupFailureReason?: string;
  workspaceRetained: boolean;
  salvage: Awaited<ReturnType<typeof deliverFailedWorkspace>>;
}> => {
  if (!workspace) return { cleanupStatus: "SUCCEEDED", workspaceRetained: false, salvage: null };
  let salvage: Awaited<ReturnType<typeof deliverFailedWorkspace>> = null;
  if (!alreadyDurable && !workspace.pinnedBaseSha) {
    let gitResult = { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha };
    try {
      gitResult = await captureWorkspaceResult(config, workspace);
    } catch (error: unknown) {
      return {
        cleanupStatus: "FAILED",
        cleanupFailureReason: `Salvage preflight failed: ${errorMessage(error)}`,
        workspaceRetained: true,
        salvage: null,
      };
    }
    salvage = await deliverFailedWorkspace(config, claim, { ...workspace, branch: gitResult.branch });
    if (salvage?.pushStatus === "FAILED") {
      return {
        cleanupStatus: "FAILED",
        cleanupFailureReason: salvage.pushError ?? "WIP salvage failed",
        workspaceRetained: true,
        salvage,
      };
    }
    if (salvage?.pushedBranch) {
      try {
        await recordPublishedBranch(config, claim, salvage.pushedBranch);
      } catch (error: unknown) {
        await appendActivity(config, claim,
          `Salvage ref '${salvage.pushedBranch}' is durable, but its publication ACK failed: ${errorMessage(error)}`,
          { stream: "runner" }).catch(() => undefined);
        return {
          cleanupStatus: "FAILED",
          cleanupFailureReason: `Salvage publication ACK failed: ${errorMessage(error)}`,
          workspaceRetained: true,
          salvage,
        };
      }
    } else {
      console.warn(JSON.stringify({
        audit: "workspace-cleanup",
        event: "nothing-to-salvage",
        runId: claim.run.id,
        reason: "clean tree with no commits past the clone base",
      }));
      await appendActivity(config, claim,
        "Workspace cleanup verified there was nothing to salvage: clean tree with no commits past the clone base",
        { stream: "runner" }).catch((error: unknown) => {
        console.error(JSON.stringify({
          audit: "workspace-cleanup",
          event: "nothing-to-salvage-activity-failed",
          runId: claim.run.id,
          error: errorMessage(error),
        }));
      });
    }
  }
  if (retain) return { cleanupStatus: "RETAINED", workspaceRetained: true, salvage };
  try {
    await cleanupWorkspace(config, workspace.path);
    return { cleanupStatus: "SUCCEEDED", workspaceRetained: false, salvage };
  } catch (error: unknown) {
    return { cleanupStatus: "FAILED", cleanupFailureReason: errorMessage(error), workspaceRetained: true, salvage };
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

export type ExecuteClaimDependencies = {
  provisionSessionConfig?: typeof provisionSessionConfig;
  cleanupAgentScratch?: typeof cleanupAgentScratch;
};

export const executeClaim = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  dependencies: ExecuteClaimDependencies = {},
): Promise<void> => {
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
  // Codex's root is retained until the run is known to have succeeded, so a
  // provisioning or execution failure can be inspected and resumed without
  // ever falling back to the host ~/.codex.
  let retainSessionConfig = false;
  let sessionConfigRemoved = false;
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
      const { salvage: _salvage, ...finishedCleanup } = await cleanup(config, claim, workspace, false);
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
    scratch = await provisionAgentScratch(config, claim.session.id);
    retainSessionConfig = claim.runner === "CODEX";
    await (dependencies.provisionSessionConfig ?? provisionSessionConfig)(config, claim.runner, scratch, { reuse: claim.resume !== null });
    const env = buildChildEnvironment(config, claim, scratch, workspace.path);
    const preflight = await adapter.preflight({ config, runner: claim.runner, model: claim.run.model, env });
    if (fencingRejected) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await cleanup(config, claim, workspace, false);
      return;
    }
    if (!preflight.ok) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const evidence = preflightEvidence(preflight.error ?? "Preflight failed");
      const classified = adapter.classifyError(evidence);
      const { salvage: _salvage, ...finishedCleanup } = await cleanup(config, claim, workspace, config.failedWorkspaceRetention > 0);
      const retainedPath = await retainedSessionConfigPath(claim.runner, scratch);
      await completeRun(config, claim, {
        ...evidence,
        failureClass: classified.failureClass,
        failureReason: appendRetainedSessionConfig(preflight.error ?? "Preflight failed", retainedPath),
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
      await cleanup(config, claim, workspace, false);
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
    if (executionSucceeded) {
      // A pinned review started from an object-id-only detached checkout. It
      // produces a platform output, not a branch artifact, so publishing it
      // would either create a forbidden local chain ref or overwrite the chain
      // from an intentionally stale base.
      delivery = workspace.pinnedBaseSha
        ? {
          pushStatus: "SUCCEEDED",
          pushRemote: claim.repo.remoteUrl,
          deliveryInstructions: `Pinned checkout ${workspace.pinnedBaseSha} completed without branch publication.`,
        }
        : await deliverUnderLease(lease, (retryOptions) => deliverWorkspace(
          config,
          claim,
          delivered,
          undefined,
          (branch) => recordPublishedBranch(config, claim, branch),
          retryOptions,
        ));
    }
    const primaryDelivery = delivery;
    const succeeded = executionSucceeded && primaryDelivery?.pushStatus !== "FAILED";
    const cleaned = await cleanup(
      config,
      claim,
      workspace,
      !succeeded && config.failedWorkspaceRetention > 0,
      // Pinned review/verification checkouts are disposable at every outcome;
      // their stale scratch state must never become chain publication evidence.
      succeeded || Boolean(workspace.pinnedBaseSha),
    );
    if (!succeeded && cleaned.salvage) {
      delivery = cleaned.salvage;
      if (cleaned.salvage.headSha) gitResult = { ...gitResult, headSha: cleaned.salvage.headSha };
      await appendActivity(config, claim,
        cleaned.salvage.deliveryInstructions ?? cleaned.salvage.pushError ?? "WIP salvage attempted",
        { stream: "runner" }).catch(() => undefined);
    }
    retainSessionConfig = !succeeded;
    let scratchCleanupFailure: string | null = null;
    if (scratch) {
      try {
        await (dependencies.cleanupAgentScratch ?? cleanupAgentScratch)(config, scratch, { retainConfigRoot: retainSessionConfig });
        sessionConfigRemoved = claim.runner === "CODEX" && !retainSessionConfig;
      } catch (error: unknown) {
        scratchCleanupFailure = errorMessage(error);
        retainSessionConfig = true;
        if (claim.runner === "CODEX" && !await sessionConfigRootExists(scratch)) {
          try {
            await (dependencies.provisionSessionConfig ?? provisionSessionConfig)(config, claim.runner, scratch);
          } catch (restoreError: unknown) {
            scratchCleanupFailure = `${scratchCleanupFailure}; unable to restore session CLI config: ${errorMessage(restoreError)}`;
          }
        }
      }
    }
    const { salvage: _salvage, ...finishedCleanup } = cleaned;
    const classified = succeeded ? null : primaryDelivery?.failureClass
      ? { failureClass: primaryDelivery.failureClass, retryable: false }
      : adapter.classifyError(evidence);
    // The normal delivery failure remains the failure-envelope evidence even
    // when terminal salvage subsequently succeeds. The wire publication is the
    // salvage result, because it names the ref that actually became durable.
    const { failure: deliveryFailure } = primaryDelivery ?? {};
    const { failure: _deliveryError, ...deliveryPayload } = delivery ?? { pushStatus: "NOT_REQUESTED" as const };
    const retainedPath = await retainedSessionConfigPath(claim.runner, scratch);
    const cleanupFailureReason = [
      finishedCleanup.cleanupFailureReason,
      scratchCleanupFailure
        ? appendRetainedSessionConfig(`Session CLI config cleanup failed: ${scratchCleanupFailure}`, retainedPath)
        : null,
    ].filter((reason): reason is string => reason !== undefined && reason !== null).join("; ");
    const completionCleanup = cleanupFailureReason
      ? { ...finishedCleanup, cleanupStatus: "FAILED" as const, cleanupFailureReason }
      : finishedCleanup;
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
      ...(!succeeded ? {
        failureReason: appendRetainedSessionConfig(
          budgetReason ?? (executionSucceeded ? primaryDelivery?.pushError : null) ?? failureReasonFromEvidence(evidence),
          retainedPath,
        ),
      } : {}),
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
      ...completionCleanup,
    });
    scratch = null;
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
      if (workspace) await cleanup(config, claim, workspace, false);
      return;
    }
    const evidence = preflightEvidence(message);
    const classified = adapter.classifyError(evidence);
    const cleaned = await cleanup(config, claim, workspace, config.failedWorkspaceRetention > 0);
    const { salvage, ...finishedCleanup } = cleaned;
    let restorationFailure: string | null = null;
    if (claim.runner === "CODEX" && scratch && sessionConfigRemoved) {
      try {
        await (dependencies.provisionSessionConfig ?? provisionSessionConfig)(config, claim.runner, scratch);
        sessionConfigRemoved = false;
        retainSessionConfig = true;
      } catch (restoreError: unknown) {
        restorationFailure = errorMessage(restoreError);
      }
    }
    let scratchCleanupFailure: string | null = null;
    const retainedPath = await retainedSessionConfigPath(claim.runner, scratch);
    if (scratch) {
      try {
        // An exception is a failed run, so the Codex root must remain available
        // for diagnosis or resume. Claude has no provisioned config root, and
        // cleanupAgentScratch safely removes its absent path.
        await (dependencies.cleanupAgentScratch ?? cleanupAgentScratch)(config, scratch, { retainConfigRoot: claim.runner === "CODEX" });
        scratch = null;
      } catch (cleanupError: unknown) {
        scratchCleanupFailure = errorMessage(cleanupError);
      }
    }
    let failureReason = appendRetainedSessionConfig(message, retainedPath);
    if (restorationFailure) failureReason = `${failureReason}; unable to restore session CLI config after completion failure: ${restorationFailure}`;
    if (scratchCleanupFailure) failureReason = `${failureReason}; scratch cleanup failed: ${scratchCleanupFailure}`;
    await appendActivity(config, claim, message, { stream: "stderr" }).catch(() => undefined);
    await completeRun(config, claim, {
      exitCode: evidence.exitCode,
      signal: null,
      terminalEventSeen: false,
      terminalSuccess: false,
      terminationReason: RUNNER_EXCEPTION_REASON,
      failureClass: classified.failureClass,
      failureReason,
      retryable: classified.retryable,
      externalFailure: true,
      failureEnvelope: runnerExceptionEnvelope({ phase, evidence, runnerClass: classified.failureClass, error }),
      // Null until the agent has exited, so a run that never got that far still
      // sends nothing; past that point this is the agent's own output and it
      // survives whatever went wrong afterwards. `evidence` above cannot supply
      // it — it is reconstructed from the error, not from the process.
      output: producedOutput,
      ...(workspace ? { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha } : {}),
      ...(salvage ?? {}),
      ...finishedCleanup,
      ...(scratchCleanupFailure ? {
        cleanupStatus: "FAILED" as const,
        cleanupFailureReason: [finishedCleanup.cleanupFailureReason, scratchCleanupFailure].filter(Boolean).join("; "),
      } : {}),
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    lease?.close();
    // Throwaway by construction, so losing it costs nothing and leaving it
    // behind would leak a directory per run.
    if (scratch) {
      await (dependencies.cleanupAgentScratch ?? cleanupAgentScratch)(config, scratch, { retainConfigRoot: retainSessionConfig })
        .catch((error: unknown) => console.error(`Agent scratch cleanup failed${claim.runner === "CODEX" ? `; session config ${scratch?.configRoot} retained or may require manual recovery` : ""}`, error));
    }
  }
};

export const pollForTask = async (config: RunnerConfig): Promise<boolean> => {
  const claim = await claimTask(config);
  if (!claim) return false;
  console.log(`Claimed run ${claim.run.id} for task ${claim.task.id} via ${claim.runner.toLowerCase()}`);
  await executeClaim(config, claim);
  return true;
};

export const STARTUP_REPORT_ATTEMPTS = 5;

export type StartupReportRetryOptions = {
  attempts?: number;
  wait?: (attempt: number) => Promise<void>;
  onRetry?: (runner: RunnerKind, attempt: number, attempts: number) => void;
  onAvailability?: (availability: CliAvailability) => void;
};

const waitBeforeStartupReportRetry = async (attempt: number): Promise<void> => {
  // 0.5s + 1s + 2s + 4s = 7.5s maximum wait. Together with five API request
  // ceilings this keeps startup below 57.5s with the default 10s API timeout,
  // while covering the ordinary API-after-runner launch ordering race.
  const delayMs = Math.min(4_000, 500 * 2 ** (attempt - 1));
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const startupApiMayBecomeReady = (error: unknown): boolean => {
  const status = (error as { status?: unknown }).status;
  return status === undefined || (typeof status === "number" && status >= 500);
};

const reportStartupStateWithRetry = async (
  runner: RunnerKind,
  send: () => Promise<void>,
  options: StartupReportRetryOptions,
): Promise<void> => {
  const attempts = options.attempts ?? STARTUP_REPORT_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("startup report attempts must be a positive integer");
  const wait = options.wait ?? waitBeforeStartupReportRetry;
  const onRetry = options.onRetry ?? ((kind, attempt, total) => {
    console.error(`AgentOS API unavailable during ${kind.toLowerCase()} startup preflight; retrying ${attempt + 1}/${total}`);
  });

  for (let attempt = 1; ; attempt += 1) {
    try {
      await send();
      return;
    } catch (error: unknown) {
      if (attempt >= attempts || !startupApiMayBecomeReady(error)) throw error;
      onRetry(runner, attempt, attempts);
      await wait(attempt);
    }
  }
};

const reportPreflightWithRetry = async (
  config: RunnerConfig,
  runner: RunnerKind,
  result: Parameters<typeof reportPreflight>[2],
  options: StartupReportRetryOptions,
): Promise<void> => reportStartupStateWithRetry(
  runner, () => reportPreflight(config, runner, result), options,
);

const reportAvailabilityWithRetry = async (
  config: RunnerConfig,
  availability: CliAvailability,
  options: StartupReportRetryOptions,
): Promise<void> => reportStartupStateWithRetry(
  availability.runner,
  () => reportCliAvailability(config, availability),
  options,
);

export const runStartupPreflight = async (
  config: RunnerConfig,
  retryOptions: StartupReportRetryOptions = {},
): Promise<Record<RunnerKind, boolean>> => {
  const results = {} as Record<RunnerKind, boolean>;
  const availability = await probeSupportedCliAvailability(config);
  const onAvailability = retryOptions.onAvailability ?? ((probe: CliAvailability) => {
    if (probe.available) console.log(`${probe.runner.toLowerCase()} runner CLI available: ${probe.resolvedPath}`);
    else console.error(`${probe.runner.toLowerCase()} runner CLI NOT FOUND: ${probe.binary} is not executable in configured RUNNER_PATH`);
  });
  // Resolve and print every supported backend before any API report or full
  // preflight can fail. Startup remains alive when one backend is absent, and
  // the operator still gets a complete local inventory in the daemon log.
  for (const runner of SUPPORTED_RUNNERS) onAvailability(availability[runner]);
  for (const runner of SUPPORTED_RUNNERS) {
    await reportAvailabilityWithRetry(config, availability[runner], retryOptions);
  }
  const env = workspaceEnvironment(config);
  for (const runner of SUPPORTED_RUNNERS) {
    if (!availability[runner].available) {
      results[runner] = false;
      continue;
    }
    const model = runner === "PI" ? "openai-codex/gpt-5.6-luna"
      : runner === "CODEX" ? CODEX_STARTER_MODEL : runner.toLowerCase();
    const result = await adapters[runner].preflight({ config, runner, model, env });
    results[runner] = result.ok;
    await reportPreflightWithRetry(config, runner, result, retryOptions);
  }
  return results;
};

export type AvailabilityHeartbeatOptions = {
  onReportError?: (availability: CliAvailability, error: unknown) => void;
};

/** One cheap daemon heartbeat. Every backend is attempted independently so a
 * missing CLI or a failed report for one kind cannot starve the others. */
export const reportCliAvailabilityHeartbeat = async (
  config: RunnerConfig,
  options: AvailabilityHeartbeatOptions = {},
): Promise<void> => {
  const availability = await probeSupportedCliAvailability(config);
  const onReportError = options.onReportError ?? ((probe: CliAvailability, error: unknown) => {
    console.error(`Failed to report ${probe.runner.toLowerCase()} runner CLI availability`, error);
  });
  for (const runner of SUPPORTED_RUNNERS) {
    try {
      await reportCliAvailability(config, availability[runner]);
    } catch (error: unknown) {
      onReportError(availability[runner], error);
    }
  }
};

export const startCliAvailabilityMonitor = (
  config: RunnerConfig,
  options: AvailabilityHeartbeatOptions = {},
): { stop: () => void } => {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void reportCliAvailabilityHeartbeat(config, options).finally(() => { busy = false; });
  }, config.heartbeatIntervalMs);
  return { stop: () => clearInterval(timer) };
};
