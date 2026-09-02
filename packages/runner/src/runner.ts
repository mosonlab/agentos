import { createHash } from "node:crypto";

import { PR_TEMPLATE_NAME, REGRESSION_VERIFICATION_OUTPUT_KIND } from "@anneal/db";

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
  promptHashFor,
  RUNNER_DEFINITIONS,
  type AdapterEvent,
  type CliAdapter,
  type ExitEvidence,
  type RuntimeHandle,
} from "./adapters.js";
import {
  controlPlane as defaultControlPlane,
  isDependencyProvisioning,
  type ClaimedTask,
  type ControlPlane,
  type SessionEventPayload,
  type SessionTaskOutputStatus,
} from "./api.js";
import {
  probeSupportedCliAvailability,
  SUPPORTED_RUNNERS,
  type CliAvailability,
} from "./availability.js";
import { evaluateBudget } from "./budget.js";
import type { RunnerConfig, RunnerKind } from "./config.js";
import { deliverWorkspace, type PrWorkflowOutput } from "./delivery.js";
import { disposeWorkspace, type WorkspaceDisposal } from "./dispose-workspace.js";
import {
  buildFailureEnvelope,
  completionEnvelope,
  type FailurePhase,
  RUNNER_EXCEPTION_REASON,
  runnerExceptionEnvelope,
  summarizeEvidence,
} from "./envelope.js";
import { createRunLease, deliverUnderLease, type RunLease } from "./run-lease.js";
import { openSessionConfig, type SessionConfigLease } from "./session-config-lease.js";
import { readRegressionOutputHandoff } from "./regression-output-handoff.js";
import { readTaskOutputReceipt } from "./task-output-receipt.js";
import { DependencyProvisioningManifestMissingError } from "./dependency-cache.js";
import {
  captureWorkspaceResult, captureWorkspaceSnapshot, cleanupAgentScratch, materializeRuntimeTools, provisionAgentScratch, provisionSessionConfig,
  provisionWorkspace, reuseWorkspace, workspaceEnvironment, writeSessionCredentials,
  type AgentScratch, type Workspace, type WorkspaceSnapshot,
} from "./workspace.js";
import { observeExternalWorktrees } from "./worktree-observer.js";

const serializeTool = (tool: RuntimeHandle["inFlightTool"]): Record<string, unknown> | null => tool ? {
  id: tool.id,
  name: tool.name,
  startedAt: tool.startedAt.toISOString(),
  lastProgressAt: tool.lastProgressAt.toISOString(),
} : null;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const persistRegressionOutputHandoff = async (
  controlPlane: ControlPlane,
  config: RunnerConfig,
  claim: ClaimedTask,
  handoff: Parameters<ControlPlane["persistSessionTaskOutput"]>[2],
  sink: (event: AdapterEvent) => void,
): Promise<void> => {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await controlPlane.persistSessionTaskOutput(config, claim, handoff);
      return;
    } catch (error: unknown) {
      if (attempt === attempts || !controlPlane.retriableStartupError(error)) throw error;
      sink({
        source: "RUNNER",
        type: "REGRESSION_OUTPUT_HANDOFF_RETRYING",
        payload: { attempt, attempts, message: errorMessage(error) },
      });
    }
  }
};

const appendRetainedSessionConfig = (reason: string, path: string | null): string =>
  `${reason}${path ? `; session CLI config retained at ${path}` : ""}`;

const missingOutputRemediationInput = (outputKind: string): string => [
  `Anneal detected that this Run finished its work but did not persist its required '${outputKind}' task output.`,
  "Do not redo the task, edit files, commit, push, open a PR, or run delivery steps.",
  `Using the work and evidence already produced in this conversation, call task_output with kind '${outputKind}' and a body that satisfies the task's exact output contract and current HEAD binding.`,
  "If the write is rejected, correct the body and retry. Then call task_status and finish only after it reports outputPersisted: true for this Run.",
].join("\n");

const sameWorkspaceSnapshot = (left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const workspaceSnapshotEvidence = (snapshot: WorkspaceSnapshot): Record<string, unknown> => ({
  headSha: snapshot.headSha,
  treeDigest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  dirty: snapshot.status.length > 0,
});

const exitEvidencePayload = (evidence: ExitEvidence): Record<string, unknown> => ({
  exitCode: evidence.exitCode,
  signal: evidence.signal,
  terminalEventSeen: evidence.terminalEventSeen,
  terminalSuccess: evidence.terminalSuccess,
  terminationReason: evidence.terminationReason,
  finalOutputTail: summarizeEvidence(evidence.finalOutput),
  providerErrorTail: summarizeEvidence(evidence.providerError),
  stdoutTail: summarizeEvidence(evidence.stdout),
  stderrTail: summarizeEvidence(evidence.stderr),
});

const cleanup = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  workspace: Workspace | null,
  retain: boolean,
  alreadyDurable = false,
  controlPlane: ControlPlane = defaultControlPlane,
): Promise<WorkspaceDisposal> => {
  if (!workspace) return { cleanupStatus: "SUCCEEDED", workspaceRetained: false, salvage: null };
  return disposeWorkspace(config, { source: "runner", claim }, {
    ...workspace,
    pinnedBaseSha: workspace.pinnedBaseSha ?? null,
  }, { retain, alreadyDurable }, controlPlane);
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
  materializeRuntimeTools?: typeof materializeRuntimeTools;
  provisionSessionConfig?: typeof provisionSessionConfig;
  cleanupAgentScratch?: typeof cleanupAgentScratch;
  writeSessionCredentials?: typeof writeSessionCredentials;
  /** The CLI the run is executed through. Defaults to the claim's runner kind. */
  adapter?: CliAdapter;
  controlPlane?: ControlPlane;
};

export const executeClaim = async (
  config: RunnerConfig,
  claim: ClaimedTask,
  dependencies: ExecuteClaimDependencies = {},
): Promise<void> => {
  const adapter = dependencies.adapter ?? adapters[claim.runner];
  const controlPlane = dependencies.controlPlane ?? defaultControlPlane;
  let workspace: Workspace | null = null;
  let scratch: AgentScratch | null = null;
  let handle: RuntimeHandle | null = null;
  let sessionConfigLease: SessionConfigLease | null = null;
  let budgetReason: string | null = null;
  let terminalFailureReason: string | null = null;
  let taskOutputStatusCheckFailed = false;
  let workspacePublicationForbidden = false;
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
  // Collected while the checkout still exists, then reused if a later cleanup
  // or completion write throws into the outer exception path. The observation
  // is report-only: failure to list worktrees is activity evidence, never a
  // different terminal verdict.
  let worktreeContainmentObserved = false;
  let worktreeContainmentViolations: string[] = [];
  const worktreeContainmentReport = async (): Promise<{ worktreeContainmentViolations?: string[] }> => {
    if (!workspace) return {};
    if (!worktreeContainmentObserved) {
      worktreeContainmentObserved = true;
      try {
        worktreeContainmentViolations = await observeExternalWorktrees(
          config,
          workspace.path,
        );
      } catch (error: unknown) {
        await controlPlane.appendActivity(
          config,
          claim,
          `Unable to observe run worktree containment: ${errorMessage(error)}`,
          { stream: "runner" },
        ).catch(() => undefined);
      }
    }
    return worktreeContainmentViolations.length > 0 ? { worktreeContainmentViolations } : {};
  };
  const claimStartedAt = new Date();
  const runLease = createRunLease<RuntimeHandle>({
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    leaseSeconds: config.leaseSeconds,
    initialPhase: { name: "provision", startedAt: claimStartedAt },
    send: (evidence) => controlPlane.heartbeat(config, claim, evidence),
    authorityFor: controlPlane.authorityFor,
    authorityAfterHeartbeat: controlPlane.authorityAfterHeartbeat,
    stopProvider: (target, reason) => adapter.kill(target, reason),
    acknowledgeCancellation: async (request) => controlPlane.acknowledgeCancellation(
      config,
      claim,
      request,
      workspace,
      await worktreeContainmentReport(),
    ),
    onRevocationStopError: (error) => {
      console.error(`Unable to drain fenced Run ${claim.run.id}: ${errorMessage(error)}`);
    },
    onRenewalError: (error) => { console.error("Run Lease renewal failed", error); },
  });
  let seq = claim.nextEventSeq;
  let pendingEvents: SessionEventPayload[] = [];
  let eventFlushPromise: Promise<void> | null = null;
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
  const flushEvents = (): Promise<void> => {
    if (eventFlushPromise) return eventFlushPromise;
    eventFlushPromise = (async () => {
      while (pendingEvents.length > 0 && runLease.held) {
        // Keep the batch in the queue until the API accepts it. A failed append
        // therefore remains the head of the queue for the next flush attempt,
        // while the single worker prevents a later batch overtaking it.
        const batch = pendingEvents.slice(0, 250);
        await controlPlane.appendEvents(config, claim, batch, handle?.providerConversationId);
        pendingEvents.splice(0, batch.length);
      }
    })().finally(() => { eventFlushPromise = null; });
    return eventFlushPromise;
  };

  const adoptAuthorityError = async (error: unknown): Promise<boolean> => {
    return runLease.adoptError(error);
  };

  const observeEventFlush = async (error: unknown): Promise<void> => {
    if (await adoptAuthorityError(error)) console.error("Event flush failed", error);
  };

  const drainEventsUnderLease = async (openLease: RunLease<RuntimeHandle>): Promise<void> => {
    let lastError: unknown = null;
    while (pendingEvents.length > 0 && openLease.held) {
      try {
        // This may first await an active-run flush. Recheck the retained queue
        // after it settles so its rejection can never become the terminal
        // verdict without a fresh delivery-phase attempt.
        await flushEvents();
        lastError = null;
      } catch (error: unknown) {
        lastError = error;
        await observeEventFlush(error);
      }
      if (pendingEvents.length === 0 || !openLease.held) break;
      const remainingMs = openLease.deadline - Date.now();
      if (remainingMs <= 0) throw lastError ?? new Error("Event delivery lease expired with events still pending");
      // Reuse the lease's heartbeat cadence instead of introducing a separate
      // retry budget. Its renewal loop continues independently during the wait.
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(config.heartbeatIntervalMs, remainingMs)));
    }
  };

  try {
    // A template step carries an explicit dependency decision. A missing or
    // malformed value is a protocol violation: no default is safe because it
    // could either strip dependencies from an implementation step or expose a
    // review step to the dependency materializer. Validate before any runner
    // workspace, dependency, adapter, or provider operation.
    const claimedTemplateStep = claim.task.templateStep as {
      provisionDependencies?: unknown;
    } | null | undefined;
    if (claimedTemplateStep === undefined
      || (claimedTemplateStep !== null && typeof claimedTemplateStep.provisionDependencies !== "boolean")) {
      const condition = "template-step-provision-dependencies-missing";
      await controlPlane.completeRun(config, claim, {
        exitCode: null,
        terminalEventSeen: false,
        terminalSuccess: false,
        terminationReason: condition,
        failureClass: "PROTOCOL_ERROR",
        failureReason: condition,
        retryable: false,
        cleanupStatus: "SUCCEEDED",
        workspaceRetained: false,
      });
      return;
    }
    // Dependency provisioning is a required claim contract. A runner build
    // that predates this field must fail closed: treating an omitted value as
    // either policy would silently change whether a repository's dependencies
    // are installed. Validate before any workspace, scratch, child environment
    // or adapter preflight/launch work can happen, and keep the condition in
    // both terminal fields so old and new control planes can expose it.
    if (!isDependencyProvisioning((claim.repo as { dependencyProvisioning?: unknown } | undefined)?.dependencyProvisioning)) {
      const condition = "dependency-provisioning-missing";
      await controlPlane.completeRun(config, claim, {
        exitCode: null,
        terminalEventSeen: false,
        terminalSuccess: false,
        terminationReason: condition,
        failureClass: "PROTOCOL_ERROR",
        failureReason: condition,
        retryable: false,
        cleanupStatus: "SUCCEEDED",
        workspaceRetained: false,
      });
      return;
    }
    // §D-P1 rule 4 — defence in depth behind the claim-side allowlist, and the
    // FIRST execution-mode check this function performs. Everything below it constructs something a
    // merge credential must never be near: a workspace, a prompt, a child
    // environment, an adapter preflight, a spawned CLI, a delivery push. A
    // mechanical run reaching an ordinary runner means the allowlist was
    // misconfigured; the run is failed closed and non-retryable rather than
    // executed, because retrying it here would just repeat the violation.
    if (claim.executionMode === "mechanical") {
      await controlPlane.completeRun(config, claim, {
        exitCode: null,
        terminalEventSeen: false,
        terminalSuccess: false,
        terminationReason: "mechanical run claimed by a model runner",
        failureClass: "PROTOCOL_ERROR",
        failureReason: "This runner does not execute mechanical runs; @anneal/merge-executor does",
        retryable: false,
        cleanupStatus: "SUCCEEDED",
        workspaceRetained: false,
      });
      return;
    }
    // `maxRunsPerTask` is the persisted authorization written by `openRun`;
    // this boot gate consumes that verdict and must not recompute a Task budget.
    if (claim.run.runNumber > claim.run.maxRunsPerTask) {
      const { salvage: _salvage, ...finishedCleanup } = await cleanup(config, claim, workspace, false, false, controlPlane);
      await controlPlane.completeRun(config, claim, {
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

    workspace = claim.resume ? await reuseWorkspace(config, claim) : await provisionWorkspace(config, claim);
    if (claim.task.templateStep?.provisionDependencies === false) {
      // This is deliberately a fenced activity write with no fallback: the
      // reviewer must have durable evidence of the dependency-free checkout
      // before its adapter is preflighted or launched.
      await controlPlane.appendActivity(
        config,
        claim,
        "Dependency provisioning skipped: TaskTemplateStep.provisionDependencies=false",
        { stream: "runner" },
      );
    }
    const prompt = buildPrompt(claim);
    scratch = await provisionAgentScratch(config, claim.session.id);
    await (dependencies.materializeRuntimeTools ?? materializeRuntimeTools)(config, scratch);
    sessionConfigLease = openSessionConfig(config, claim, scratch, dependencies);
    await (dependencies.provisionSessionConfig ?? provisionSessionConfig)(config, claim.runner, scratch, {
      reuse: claim.resume !== null,
    });
    const env = buildChildEnvironment(config, claim, scratch, workspace.path, workspace.commitHooksPath);
    const preflight = await adapter.preflight({ config, runner: claim.runner, model: claim.run.model, env });
    if (!runLease.held) {
      runLease.abandonProviderLaunch();
      const authority = await runLease.checkpoint();
      if (!authority.held && authority.reason === "cancelled") return;
      const cleaned = await cleanup(config, claim, workspace, false, false, controlPlane);
      const { salvage: _salvage, ...cleanupOutcome } = cleaned;
      await controlPlane.recordLeaseIndependentCleanup(config, claim, cleanupOutcome).catch((error: unknown) => {
        console.error(`Unable to record lease-independent cleanup outcome: ${errorMessage(error)}`);
      });
      return;
    }
    if (!preflight.ok) {
      runLease.abandonProviderLaunch();
      const evidence = preflightEvidence(preflight.error ?? "Preflight failed");
      const classified = adapter.classifyError(evidence);
      const worktreeReport = await worktreeContainmentReport();
      const { salvage: _salvage, ...finishedCleanup } = await cleanup(config, claim, workspace, config.failedWorkspaceRetention > 0, false, controlPlane);
      const retainedPath = await sessionConfigLease.retainedPath();
      await controlPlane.completeRun(config, claim, {
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
        ...worktreeReport,
        ...finishedCleanup,
      });
      return;
    }

    const credentialsPath = await (dependencies.writeSessionCredentials ?? writeSessionCredentials)(config, claim, workspace);
    if (!runLease.held) {
      runLease.abandonProviderLaunch();
      await runLease.checkpoint();
      return;
    }
    const spec = { config, claim, workingDirectory: workspace.path, env, prompt, credentialsPath };
    const launchedHandle = await runLease.launch(() => claim.resume
      ? adapter.resume({ ...spec, ...claim.resume }, sink)
      : adapter.start(spec, sink));
    if (!launchedHandle) return;
    handle = launchedHandle;
    phase = "EXECUTE";
    const executionStartedAt = handle.startedAt;
    await runLease.enterPhase({
      name: "execute",
      evidence: async () => {
        if (!handle) throw new Error("Execute heartbeat requires a provider handle");
        const heartbeatHandle = handle;
        const snapshot = await adapter.heartbeat(heartbeatHandle);
        const decision = evaluateBudget({
          now: new Date(),
          startedAt: executionStartedAt,
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
          await runLease.stopProvider(heartbeatHandle, budgetReason);
        }
        return {
          processAlive: snapshot.processAlive,
          lastProgressEventAt: snapshot.lastProgressEventAt,
          inFlightTool: serializeTool(snapshot.inFlightTool),
        };
      },
      // Event delivery remains detached from renewal: a failed or slow append
      // cannot occupy the run Lease renewal loop, and the queue stays ordered.
      afterRenewal: () => { if (runLease.held) void flushEvents().catch(observeEventFlush); },
    });
    // A resume dispatches its continuation input rather than the fresh prompt.
    // Keep the launch manifest and durable Run hash tied to the bytes that this
    // invocation actually handed to the provider.
    const dispatchedPrompt = claim.resume?.input ?? prompt;
    const manifest = manifestFor(spec, dispatchedPrompt);
    await controlPlane.startRun(config, claim, {
      adapterVersion: ADAPTER_VERSION,
      cliVersion: preflight.cliVersion ?? "unknown",
      authMode: preflight.authMode,
      manifest,
      promptHash: promptHashFor(dispatchedPrompt),
      workspacePath: workspace.path,
      branch: workspace.branch,
      baseSha: workspace.baseSha,
      runtimeHandle: handle.pid ? `${config.runnerId}:${handle.pid}` : `${config.runnerId}:pending`,
    });
    // The first append is also best-effort from the heartbeat loop's point of
    // view. If the endpoint is down, keep the batch queued and let the active
    // renewal loop keeps the run Lease live while later flushes retry it.
    void flushEvents().catch(observeEventFlush);

    const completedHandle = handle;
    const evidence = await completedHandle.exit;
    producedOutput = outputTail(evidence);
    let regressionHandoffPersisted = false;
    if (runLease.held) {
      try {
        const handoff = await readRegressionOutputHandoff(config, claim, workspace);
        if (handoff) {
          await persistRegressionOutputHandoff(controlPlane, config, claim, handoff, sink);
          regressionHandoffPersisted = true;
          sink({
            source: "RUNNER",
            type: "REGRESSION_OUTPUT_HANDOFF_PERSISTED",
            payload: { kind: handoff.kind, commitSha: handoff.commitSha },
          });
        }
      } catch (error: unknown) {
        terminalFailureReason = `Regression output handoff failed for Run ${claim.run.id}: ${errorMessage(error)}`;
        sink({
          source: "RUNNER",
          type: "REGRESSION_OUTPUT_HANDOFF_FAILED",
          payload: { message: errorMessage(error) },
        });
      }
    }
    if (adapterExecutionSucceeded(evidence)
      && claim.task.templateStep?.outputKind
      && runLease.held
      && terminalFailureReason === null) {
      const declaredOutputKind = claim.task.templateStep.outputKind;
      let outputStatus: SessionTaskOutputStatus | null = null;
      let statusFailure: string | null = null;
      try {
        outputStatus = await controlPlane.readSessionTaskOutputStatus(config, claim);
      } catch (error: unknown) {
        statusFailure = errorMessage(error);
      }
      if (outputStatus === null) {
        statusFailure ??= "Anneal API returned no task output status";
      }
      if (statusFailure !== null) {
        sink({
          source: "RUNNER",
          type: "TASK_OUTPUT_REMEDIATION_CHECK_FAILED",
          payload: { message: statusFailure },
        });
        taskOutputStatusCheckFailed = true;
        terminalFailureReason = `Task output status could not be established for a step declaring output kind '${declaredOutputKind}' for Run ${claim.run.id}: ${statusFailure}`;
      }
      if (outputStatus?.outputRequired && !outputStatus.outputPersisted) {
        const outputKind = outputStatus.outputKind;
        const providerConversationId = completedHandle.providerConversationId;
        if (claim.task.templateStep.outputKind === REGRESSION_VERIFICATION_OUTPUT_KIND) {
          terminalFailureReason = `Regression verification finished without a current-Run mechanical output handoff for Run ${claim.run.id}`;
          sink({
            source: "RUNNER",
            type: "TASK_OUTPUT_REMEDIATION_UNAVAILABLE",
            payload: {
              outputKind,
              outputRemediationAllowed: false,
              providerConversationIdAvailable: providerConversationId !== null,
              reason: regressionHandoffPersisted ? "mechanical-output-not-visible" : "mechanical-handoff-absent",
            },
          });
        } else if (outputStatus.outputSatisfiedByPriorRun) {
          sink({
            source: "RUNNER",
            type: "TASK_OUTPUT_REMEDIATION_SKIPPED",
            payload: { outputKind, reason: "immutable-output-satisfied-by-prior-run" },
          });
        } else if (outputStatus.outputRemediationAllowed
          && outputKind
          && providerConversationId
          && runLease.held) {
          const beforeRemediation = await captureWorkspaceSnapshot(config, workspace);
          // Snapshotting is asynchronous. Cancellation may have been ACKed
          // against the already-closed first launch while it ran, so no second
          // provider launch may be opened without this fresh fence check.
          if (runLease.held) {
            sink({
              source: "RUNNER",
              type: "TASK_OUTPUT_REMEDIATION_STARTED",
              payload: { outputKind, workspace: workspaceSnapshotEvidence(beforeRemediation) },
            });
            const remediationHandle = await runLease.launch(() => adapter.resume({
              ...spec,
              providerConversationId,
              input: missingOutputRemediationInput(outputKind),
            }, sink));
            if (remediationHandle) {
              handle = remediationHandle;
              const remediationEvidence = await remediationHandle.exit;
              const afterRemediation = await captureWorkspaceSnapshot(config, workspace);
              const workspaceChanged = !sameWorkspaceSnapshot(beforeRemediation, afterRemediation);
              let remediated = false;
              let statusCheckError: string | null = null;
              if (!workspaceChanged) {
                try {
                  const remediatedStatus = await controlPlane.readSessionTaskOutputStatus(config, claim);
                  remediated = remediatedStatus?.outputPersisted === true
                    || remediatedStatus?.outputSatisfiedByPriorRun === true;
                } catch (error: unknown) {
                  statusCheckError = errorMessage(error);
                  sink({
                    source: "RUNNER",
                    type: "TASK_OUTPUT_REMEDIATION_CHECK_FAILED",
                    payload: { message: statusCheckError },
                  });
                }
              }
              if (workspaceChanged) {
                workspacePublicationForbidden = true;
                terminalFailureReason = `Task output remediation changed workspace HEAD or tree for Run ${claim.run.id}`;
              } else if (!remediated) {
                terminalFailureReason = statusCheckError
                  ? `Task output remediation status check failed for Run ${claim.run.id}: ${statusCheckError}`
                  : `Task output remediation finished without persisting ${outputKind} output for Run ${claim.run.id}`;
              }
              sink({
                source: "RUNNER",
                type: "TASK_OUTPUT_REMEDIATION_FINISHED",
                payload: {
                  outputKind,
                  outputPersisted: remediated,
                  terminalSuccess: adapterExecutionSucceeded(remediationEvidence),
                  evidence: exitEvidencePayload(remediationEvidence),
                  workspaceChanged,
                  ...(workspaceChanged ? {
                    workspaceBefore: workspaceSnapshotEvidence(beforeRemediation),
                    workspaceAfter: workspaceSnapshotEvidence(afterRemediation),
                  } : {}),
                  ...(statusCheckError ? { statusCheckError } : {}),
                },
              });
            }
          }
        } else {
          terminalFailureReason = `Task output remediation unavailable for Run ${claim.run.id}: ${
            !outputStatus.outputRemediationAllowed ? "remediation is not allowed"
              : !outputKind ? "output kind is unavailable"
                : "provider conversation id is unavailable"
          }`;
          sink({
            source: "RUNNER",
            type: "TASK_OUTPUT_REMEDIATION_UNAVAILABLE",
            payload: {
              outputKind,
              outputRemediationAllowed: outputStatus.outputRemediationAllowed,
              providerConversationIdAvailable: providerConversationId !== null,
            },
          });
        }
      }
    }
    if (!runLease.authority.held && runLease.authority.reason === "cancelled") {
      await runLease.checkpoint();
      return;
    }
    phase = "DELIVER";
    // The same renewal loop remains live while delivery evidence replaces
    // execute evidence. The opening delivery renewal fixes the deadline from
    // the last attempt known to have landed.
    await runLease.enterPhase({ name: "deliver", startedAt: new Date() });
    let gitResult = { branch: workspace.branch, baseSha: workspace.baseSha, headSha: workspace.baseSha };
    let capturedHeadSha: string | undefined;
    try {
      gitResult = await captureWorkspaceResult(config, workspace);
      capturedHeadSha = gitResult.headSha;
    } catch (error: unknown) {
      const message = `Unable to snapshot git result: ${errorMessage(error)}`;
      sink({ source: "RUNNER", type: "WORKSPACE_RESULT_SNAPSHOT_FAILED", payload: { message } });
      await controlPlane.appendActivity(config, claim, message, { stream: "runner" }).catch((activityError: unknown) => {
        sink({
          source: "RUNNER",
          type: "WORKSPACE_RESULT_SNAPSHOT_REPORT_FAILED",
          payload: { message: errorMessage(activityError) },
        });
      });
    }
    let postDeliveryDisconnectTolerated = false;
    const disconnectCandidate = evidence.exitCode === 0
      && evidence.signal === null
      && evidence.terminationReason === null
      && evidence.terminalEventSeen === false
      && terminalFailureReason === null
      && budgetReason === null
      && runLease.held;
    if (disconnectCandidate) {
      try {
        const outputStatus = await controlPlane.readSessionTaskOutputStatus(config, claim);
        const expectedKind = "result";
        if (outputStatus?.outputPersisted !== true) {
          throw new Error(`No persisted ${expectedKind} output exists for this Run`);
        }
        const output = outputStatus.output;
        if (!output) throw new Error(`Persisted ${expectedKind} output has no server-side identity`);
        if (output.runId !== claim.run.id) {
          throw new Error(`Persisted ${expectedKind} output belongs to Run ${output.runId}`);
        }
        if (output.kind !== expectedKind) {
          throw new Error(`Persisted output kind ${output.kind} is not ${expectedKind}`);
        }
        if (typeof output.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(output.commitSha)) {
          throw new Error(`Persisted ${expectedKind} output has an invalid commit SHA`);
        }
        if (output.commitSha !== capturedHeadSha) {
          throw new Error(`Persisted ${expectedKind} output does not match captured workspace HEAD`);
        }
        postDeliveryDisconnectTolerated = true;
        let localReceipt = null;
        let localReceiptReadError: string | null = null;
        try {
          localReceipt = await readTaskOutputReceipt(config, workspace);
          if (!localReceipt) localReceiptReadError = "Local task output receipt is absent";
        } catch (error: unknown) {
          localReceiptReadError = errorMessage(error);
        }
        sink({
          source: "RUNNER",
          type: "POST_DELIVERY_DISCONNECT_ACCEPTED",
          payload: {
            runId: claim.run.id,
            commitSha: output.commitSha,
            providerError: evidence.providerError,
            terminalEventSeen: evidence.terminalEventSeen,
            localReceipt,
            localReceiptReadError,
          },
        });
      } catch (error: unknown) {
        sink({
          source: "RUNNER",
          type: "POST_DELIVERY_DISCONNECT_CHECK_FAILED",
          payload: { message: errorMessage(error), providerError: evidence.providerError },
        });
      }
    }
    let prWorkflowOutputs: readonly PrWorkflowOutput[] | undefined;
    const templateStep = claim.task.templateStep as (NonNullable<ClaimedTask["task"]["templateStep"]> & {
      taskTemplate?: { name?: string };
    }) | null;
    const canonicalPrDelivery = templateStep?.taskTemplate?.name === PR_TEMPLATE_NAME
      && (templateStep.outputKind === "implementation" || templateStep.outputKind === "fixed-implementation");
    if (canonicalPrDelivery && runLease.held) {
      try {
        const status = await controlPlane.readSessionTaskOutputStatus(config, claim) as (
          SessionTaskOutputStatus & { prWorkflowOutputs?: readonly PrWorkflowOutput[] }
        ) | null;
        if (!status || !Array.isArray(status.prWorkflowOutputs)) {
          throw new Error("session status omitted canonical PR workflow output evidence");
        }
        prWorkflowOutputs = status.prWorkflowOutputs;
      } catch (error: unknown) {
        if (terminalFailureReason === null) {
          terminalFailureReason = `Canonical PR workflow evidence handoff failed for Run ${claim.run.id}: ${errorMessage(error)}`;
        }
        sink({
          source: "RUNNER",
          type: "PR_WORKFLOW_EVIDENCE_HANDOFF_FAILED",
          payload: { message: errorMessage(error) },
        });
      }
    }
    // Flush the handoff failure (if any) before checking authority or entering
    // delivery. This status read happens after the provider's final events, so
    // placing it after the existing drain would leave the new diagnostic event
    // queued and then lose it when the run completes.
    await drainEventsUnderLease(runLease);
    if (!runLease.held) {
      const authority = await runLease.checkpoint();
      if (!authority.held && (authority.reason === "cancelled" || authority.reason === "waiting-inbox")) return;
      const cleaned = await cleanup(config, claim, workspace, false, false, controlPlane);
      const { salvage: _salvage, ...cleanupOutcome } = cleaned;
      await controlPlane.recordLeaseIndependentCleanup(config, claim, cleanupOutcome).catch((error: unknown) => {
        console.error(`Unable to record lease-independent cleanup outcome: ${errorMessage(error)}`);
      });
      return;
    }
    // A validated, fenced Regression handoff is the step's terminal product
    // only when the provider did not explicitly reject the session. Transport
    // loss remains recoverable, but a terminal failure keeps its authority.
    const explicitTerminalFailure = evidence.terminalEventSeen && !evidence.terminalSuccess;
    const regressionMechanicallySettled = regressionHandoffPersisted
      && !explicitTerminalFailure
      && terminalFailureReason === null
      && budgetReason === null;
    const executionSucceeded = (adapterExecutionSucceeded(evidence)
      || regressionMechanicallySettled
      || postDeliveryDisconnectTolerated)
      && terminalFailureReason === null
      && budgetReason === null;
    let delivery: Awaited<ReturnType<typeof deliverWorkspace>> | null = null;
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
        : await deliverUnderLease(runLease, (retryOptions) => deliverWorkspace(
          config,
          claim,
          delivered,
          {
            ...(capturedHeadSha ? { headSha: capturedHeadSha } : {}),
            ...(prWorkflowOutputs ? { prWorkflowOutputs } : {}),
            recordPublication: (branch) => controlPlane.recordPublishedBranch(config, claim, branch),
            retryOptions,
          },
        ));
    }
    const primaryDelivery = delivery;
    const succeeded = executionSucceeded && primaryDelivery?.pushStatus !== "FAILED";
    const worktreeReport = await worktreeContainmentReport();
    const cleaned = await cleanup(
      config,
      claim,
      workspace,
      !succeeded && config.failedWorkspaceRetention > 0,
      // Pinned review/verification checkouts are disposable at every outcome;
      // their stale scratch state must never become chain publication evidence.
      // A failed PR operation can follow a successful, acknowledged push. That
      // branch is already durable even though the run must fail, so salvaging it
      // would publish a second ref and replace the primary delivery evidence.
      succeeded
        || workspacePublicationForbidden
        || Boolean(workspace.pinnedBaseSha)
        || Boolean(primaryDelivery?.pushedBranch),
      controlPlane,
    );
    if (!succeeded && cleaned.salvage) {
      delivery = cleaned.salvage;
      if (cleaned.salvage.headSha) gitResult = { ...gitResult, headSha: cleaned.salvage.headSha };
      await controlPlane.appendActivity(config, claim,
        cleaned.salvage.deliveryInstructions ?? cleaned.salvage.pushError ?? "WIP salvage attempted",
        { stream: "runner" }).catch(() => undefined);
    }
    if (succeeded && postDeliveryDisconnectTolerated) {
      const providerError = summarizeEvidence(evidence.providerError) ?? "no providerError reported";
      await controlPlane.appendActivity(
        config,
        claim,
        `A provider disconnect after delivery was tolerated: ${providerError}`,
        { stream: "runner" },
      ).catch((error: unknown) => {
        sink({
          source: "RUNNER",
          type: "POST_DELIVERY_DISCONNECT_ACTIVITY_FAILED",
          payload: { message: errorMessage(error), providerError },
        });
      });
      await flushEvents().catch(observeEventFlush);
    }
    const sessionDisposal = await sessionConfigLease.settle(succeeded ? "succeeded" : "failed");
    const { salvage: _salvage, ...finishedCleanup } = cleaned;
    const classified = succeeded ? null
      : budgetReason
        ? { failureClass: "BUDGET_EXCEEDED" as const, retryable: false }
        : terminalFailureReason
          ? { failureClass: "PROTOCOL_ERROR" as const, retryable: !taskOutputStatusCheckFailed }
          : primaryDelivery?.failureClass
            ? { failureClass: primaryDelivery.failureClass, retryable: false }
            : adapter.classifyError(evidence);
    // The normal delivery failure remains the failure-envelope evidence even
    // when terminal salvage subsequently succeeds. The wire publication is the
    // salvage result, because it names the ref that actually became durable.
    const { failure: deliveryFailure } = primaryDelivery ?? {};
    const { failure: _deliveryError, ...deliveryPayload } = delivery ?? { pushStatus: "NOT_REQUESTED" as const };
    const retainedPath = sessionDisposal.retainedPath;
    const cleanupFailureReason = [
      finishedCleanup.cleanupFailureReason,
      sessionDisposal.cleanupFailureReason
        ? appendRetainedSessionConfig(`Session CLI config cleanup failed: ${sessionDisposal.cleanupFailureReason}`, retainedPath)
        : null,
    ].filter((reason): reason is string => reason !== undefined && reason !== null).join("; ");
    const completionCleanup = cleanupFailureReason
      ? { ...finishedCleanup, cleanupStatus: "FAILED" as const, cleanupFailureReason }
      : finishedCleanup;
    // Stop renewing before the terminal write: a heartbeat racing a completed
    // run is a guaranteed 409 and pure log noise. The last renewal is at most
    // one heartbeat interval old — half the lease — and the completion call is
    // itself bounded by RUNNER_API_TIMEOUT_MS, so it cannot outlive that.
    await runLease.close();
    const acceptedEvidence = regressionMechanicallySettled || postDeliveryDisconnectTolerated
      ? {
        ...evidence,
        exitCode: 0,
        signal: null,
        terminalEventSeen: true,
        terminalSuccess: true,
        terminationReason: null,
      }
      : evidence;
    // The primary provider may have ended cleanly while the required
    // remediation protocol failed afterwards. Reflect that protocol failure in
    // the structured envelope too; otherwise the API correctly distrusts the
    // runner's asserted class and would classify the clean primary evidence as
    // TASK_FAILED instead of PROTOCOL_ERROR.
    const completionEvidence = terminalFailureReason
      ? { ...acceptedEvidence, terminalSuccess: false }
      : acceptedEvidence;
    await controlPlane.completeRun(config, claim, {
      exitCode: completionEvidence.exitCode,
      signal: completionEvidence.signal,
      terminalEventSeen: completionEvidence.terminalEventSeen,
      terminalSuccess: succeeded && completionEvidence.terminalSuccess,
      terminationReason: budgetReason ?? completionEvidence.terminationReason,
      ...(classified ? { failureClass: classified.failureClass, retryable: classified.retryable } : {}),
      // A salvage push failure must not mask why the run itself failed.
      ...(!succeeded ? {
        failureReason: appendRetainedSessionConfig(
          budgetReason
            ?? terminalFailureReason
            ?? (executionSucceeded ? primaryDelivery?.pushError : null)
            ?? failureReasonFromEvidence(evidence),
          retainedPath,
        ),
      } : {}),
      output: outputTail(evidence),
      // Ordinarily only a failure carries one: the envelope is the account of
      // what went wrong, and `executionSucceeded` decides which side of the
      // agent/plumbing line it went wrong on. A run whose agent finished and
      // whose push failed is a DELIVER failure, and the API must not charge the
      // task for it.
      // The v1 envelope cannot distinguish this terminal control-plane
      // protocol failure from retryable provider protocol drift. Omitting it
      // only for this case lets the API honor the explicit non-retryable
      // completion verdict instead of reclassifying the clean provider exit.
      ...(succeeded || taskOutputStatusCheckFailed ? {} : {
        failureEnvelope: completionEnvelope({
          executionSucceeded,
          evidence: completionEvidence,
          deliveryFailure,
          runnerClass: classified?.failureClass ?? null,
          terminationReason: budgetReason ?? completionEvidence.terminationReason,
        }),
      }),
      ...gitResult,
      ...deliveryPayload,
      ...worktreeReport,
      ...completionCleanup,
    });
    scratch = null;
  } catch (error: unknown) {
    runLease.abandonProviderLaunch();
    await runLease.adoptError(error);
    const authority = await runLease.checkpoint();
    if (!authority.held && (authority.reason === "waiting-inbox" || authority.reason === "cancelled")) return;
    const message = errorMessage(error);
    if (handle && authority.held) {
      await runLease.stopProvider(handle, RUNNER_EXCEPTION_REASON).catch((stopError: unknown) => {
        console.error(`Unable to drain failed Run ${claim.run.id}: ${errorMessage(stopError)}`);
      });
    }
    if (!authority.held && authority.reason === "revoked") {
      if (workspace) {
        const cleaned = await cleanup(config, claim, workspace, false, false, controlPlane);
        const { salvage: _salvage, ...cleanupOutcome } = cleaned;
        await controlPlane.recordLeaseIndependentCleanup(config, claim, cleanupOutcome).catch((reportError: unknown) => {
          console.error(`Unable to record lease-independent cleanup outcome: ${errorMessage(reportError)}`);
        });
      }
      return;
    }
    const evidence = preflightEvidence(message);
    const classified = error instanceof DependencyProvisioningManifestMissingError
      ? { failureClass: "PROTOCOL_ERROR" as const, retryable: false }
      : adapter.classifyError(evidence);
    const worktreeReport = await worktreeContainmentReport();
    const cleaned = await cleanup(config, claim, workspace, config.failedWorkspaceRetention > 0, false, controlPlane);
    const { salvage, ...finishedCleanup } = cleaned;
    const sessionDisposal = sessionConfigLease && scratch
      ? await sessionConfigLease.settle("failed")
      : { retainedPath: null, cleanupFailureReason: null };
    if (sessionDisposal.cleanupFailureReason === null) scratch = null;
    let failureReason = appendRetainedSessionConfig(message, sessionDisposal.retainedPath);
    if (sessionDisposal.cleanupFailureReason) {
      failureReason = `${failureReason}; scratch cleanup failed: ${sessionDisposal.cleanupFailureReason}`;
    }
    await controlPlane.appendActivity(config, claim, message, { stream: "stderr" }).catch(() => undefined);
    await controlPlane.completeRun(config, claim, {
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
      ...worktreeReport,
      ...finishedCleanup,
      ...(sessionDisposal.cleanupFailureReason ? {
        cleanupStatus: "FAILED" as const,
        cleanupFailureReason: [finishedCleanup.cleanupFailureReason, sessionDisposal.cleanupFailureReason].filter(Boolean).join("; "),
      } : {}),
    });
  } finally {
    runLease.abandonProviderLaunch();
    await runLease.close();
    // Throwaway by construction, so losing it costs nothing and leaving it
    // behind would leak a directory per run.
    if (scratch) {
      if (sessionConfigLease) {
        const disposal = await sessionConfigLease.settle("failed");
        if (disposal.cleanupFailureReason) {
          console.error(`Agent scratch cleanup failed${disposal.retainedPath ? `; session config retained at ${disposal.retainedPath}` : ""}: ${disposal.cleanupFailureReason}`);
        }
      } else {
        await (dependencies.cleanupAgentScratch ?? cleanupAgentScratch)(config, scratch, {
          retainConfigRoot: RUNNER_DEFINITIONS[claim.runner].isolatesSessionConfig,
        }).catch((cleanupError: unknown) => console.error("Agent scratch cleanup failed", cleanupError));
      }
    }
  }
};

export const pollForTask = async (
  config: RunnerConfig,
  controlPlane: ControlPlane = defaultControlPlane,
): Promise<boolean> => {
  const claim = await controlPlane.claim(config);
  if (!claim) return false;
  console.log(`Claimed run ${claim.run.id} for task ${claim.task.id} via ${claim.runner.toLowerCase()}`);
  await executeClaim(config, claim, { controlPlane });
  return true;
};

export const STARTUP_REPORT_ATTEMPTS = 5;

export type StartupReportRetryOptions = {
  attempts?: number;
  wait?: (attempt: number) => Promise<void>;
  onRetry?: (runner: RunnerKind, attempt: number, attempts: number) => void;
  onAvailability?: (availability: CliAvailability) => void;
  controlPlane?: ControlPlane;
};

const waitBeforeStartupReportRetry = async (attempt: number): Promise<void> => {
  // 0.5s + 1s + 2s + 4s = 7.5s maximum wait. Together with five API request
  // ceilings this keeps startup below 57.5s with the default 10s API timeout,
  // while covering the ordinary API-after-runner launch ordering race.
  const delayMs = Math.min(4_000, 500 * 2 ** (attempt - 1));
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const reportStartupStateWithRetry = async (
  runner: RunnerKind,
  send: () => Promise<void>,
  options: StartupReportRetryOptions,
): Promise<void> => {
  const controlPlane = options.controlPlane ?? defaultControlPlane;
  const attempts = options.attempts ?? STARTUP_REPORT_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("startup report attempts must be a positive integer");
  const wait = options.wait ?? waitBeforeStartupReportRetry;
  const onRetry = options.onRetry ?? ((kind, attempt, total) => {
    console.error(`Anneal API unavailable during ${kind.toLowerCase()} startup preflight; retrying ${attempt + 1}/${total}`);
  });

  for (let attempt = 1; ; attempt += 1) {
    try {
      await send();
      return;
    } catch (error: unknown) {
      if (attempt >= attempts || !controlPlane.retriableStartupError(error)) throw error;
      onRetry(runner, attempt, attempts);
      await wait(attempt);
    }
  }
};

const reportPreflightWithRetry = async (
  config: RunnerConfig,
  runner: RunnerKind,
  result: Parameters<ControlPlane["reportPreflight"]>[2],
  options: StartupReportRetryOptions,
): Promise<void> => reportStartupStateWithRetry(
  runner, () => (options.controlPlane ?? defaultControlPlane).reportPreflight(config, runner, result), options,
);

const reportAvailabilityWithRetry = async (
  config: RunnerConfig,
  availability: CliAvailability,
  options: StartupReportRetryOptions,
): Promise<void> => reportStartupStateWithRetry(
  availability.runner,
  async () => { await (options.controlPlane ?? defaultControlPlane).reportCliAvailability(config, availability); },
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
    const result = await runBackendPreflight(config, runner, env);
    results[runner] = result.ok;
    await reportPreflightWithRetry(config, runner, result, retryOptions);
  }
  return results;
};

export type AvailabilityHeartbeatOptions = {
  onReportError?: (availability: CliAvailability, error: unknown) => void;
  onPreflightError?: (availability: CliAvailability, error: unknown) => void;
  controlPlane?: ControlPlane;
};

const runBackendPreflight = async (
  config: RunnerConfig,
  runner: RunnerKind,
  env = workspaceEnvironment(config),
) => {
  return adapters[runner].preflight({ config, runner, model: RUNNER_DEFINITIONS[runner].startupPreflightModel, env });
};

/** One cheap daemon heartbeat. Every backend is attempted independently so a
 * missing CLI or a failed report for one kind cannot starve the others. */
export const reportCliAvailabilityHeartbeat = async (
  config: RunnerConfig,
  options: AvailabilityHeartbeatOptions = {},
): Promise<void> => {
  const controlPlane = options.controlPlane ?? defaultControlPlane;
  const availability = await probeSupportedCliAvailability(config);
  const onReportError = options.onReportError ?? ((probe: CliAvailability, error: unknown) => {
    console.error(`Failed to report ${probe.runner.toLowerCase()} runner CLI availability`, error);
  });
  const onPreflightError = options.onPreflightError ?? ((probe: CliAvailability, error: unknown) => {
    console.error(`Failed to revalidate ${probe.runner.toLowerCase()} runner preflight`, error);
  });
  for (const runner of SUPPORTED_RUNNERS) {
    let revalidatePreflight = false;
    try {
      ({ revalidatePreflight } = await controlPlane.reportCliAvailability(config, availability[runner]));
    } catch (error: unknown) {
      onReportError(availability[runner], error);
      continue;
    }
    if (revalidatePreflight && availability[runner].available) {
      try {
        await controlPlane.reportPreflight(config, runner, await runBackendPreflight(config, runner));
      } catch (error: unknown) {
        onPreflightError(availability[runner], error);
      }
    }
  }
};

export const startCliAvailabilityMonitor = (
  config: RunnerConfig,
  options: AvailabilityHeartbeatOptions = {},
): { stop: () => void } => {
  let busy = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    void reportCliAvailabilityHeartbeat(config, options).finally(() => { busy = false; });
  };
  const schedule = cliAvailabilityHeartbeatSchedule(config.runnerId);
  const initial = setTimeout(() => {
    tick();
    interval = setInterval(tick, schedule.intervalMs);
  }, schedule.initialDelayMs);
  return { stop: () => {
    clearTimeout(initial);
    if (interval !== null) clearInterval(interval);
  } };
};

const CLI_AVAILABILITY_INTERVAL_MS = 60_000;
const CLI_AVAILABILITY_JITTER_MS = 15_000;

export const cliAvailabilityHeartbeatSchedule = (runnerId: string): {
  initialDelayMs: number;
  intervalMs: number;
} => {
  let hash = 2_166_136_261;
  for (const character of runnerId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return {
    initialDelayMs: CLI_AVAILABILITY_INTERVAL_MS + (hash % CLI_AVAILABILITY_JITTER_MS),
    intervalMs: CLI_AVAILABILITY_INTERVAL_MS,
  };
};
