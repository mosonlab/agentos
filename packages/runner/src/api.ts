import { statfs } from "node:fs/promises";

import type { CleanupStatus, FailureClass, FailureEnvelope, RegressionRepairHandoff } from "@anneal/db";

import type { RunnerConfig, RunnerKind } from "./config.js";

export type { CleanupStatus, FailureClass } from "@anneal/db";
export type CodexServiceTier = "DEFAULT" | "FAST";
/** The only repository dependency-provisioning policies understood by a runner. */
export const DEPENDENCY_PROVISIONING_VALUES = ["NONE", "NPM_CI"] as const;
export type DependencyProvisioning = (typeof DEPENDENCY_PROVISIONING_VALUES)[number];

export const isDependencyProvisioning = (value: unknown): value is DependencyProvisioning =>
  typeof value === "string"
  && (DEPENDENCY_PROVISIONING_VALUES as readonly string[]).includes(value);

export type CancellationRequest = { requestId: string; reason: string; requestedAt: string };
export type HeartbeatResult = { ok: boolean; cancellation: CancellationRequest | null };

export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, responseBody: string, code?: string) {
    super(`Anneal API ${status}: ${responseBody}`);
    this.name = "ControlPlaneError";
    this.status = status;
    this.code = code;
  }
}

/** The runner's domain verdict for whether its current Run authority remains. */
export type Authority =
  | { held: true }
  | { held: false; reason: "revoked" }
  | { held: false; reason: "waiting-inbox" }
  | { held: false; reason: "cancelled"; request: CancellationRequest };

export const authorityFor = (error: unknown): Authority => {
  if (!(error instanceof ControlPlaneError) || error.status !== 409) return { held: true };
  return error.code === "WAITING_INBOX"
    ? { held: false, reason: "waiting-inbox" }
    : { held: false, reason: "revoked" };
};

export const authorityAfterHeartbeat = (result: HeartbeatResult): Authority =>
  result.cancellation
    ? { held: false, reason: "cancelled", request: result.cancellation }
    : { held: true };

/** Startup may retry transport failures and control-plane 5xx responses only. */
export const retriableStartupError = (error: unknown): boolean =>
  !(error instanceof ControlPlaneError) || error.status >= 500;

export type ClaimedTask = {
  /**
   * Server-computed from the claimed task's template step (§D-P1 rule 4).
   * Required, not optional, so a runner build that predates this field fails to
   * compile rather than reading `undefined` as "ordinary" — the one reading that
   * would put a merge step in front of a model CLI.
   *
   * The ordinary runner refuses `"mechanical"` outright. It is claimed by
   * `@anneal/merge-executor`, a different process under a different OS user.
   */
  executionMode: "mechanical" | "agent";
  /** Server-parsed authority for runner-owned direct-chain workspace bootstrap. */
  specificationMaterialization: {
    kind: "direct-implementation";
    path: string;
    body: string;
  } | null;
  task: {
    id: string;
    chainId: string | null;
    chainIndex: number | null;
    name: string;
    description: string;
    repoId: string;
    targetBranch: string | null;
    maxDurationMin: number;
    stallTimeoutMin: number;
    maxSessionsPerTask: number;
    /**
     * The persisted dependency-provisioning decision for this template step.
     * It is required for every non-null template step so a runner cannot
     * silently reinterpret a missing field as either policy.
     */
    templateStep: { name: string; outputKind?: string; provisionDependencies: boolean } | null;
  };
  agent: {
    id: string;
    name: string;
    model: string;
    foundationalPrompt: string;
    rolePrompt: string;
    /**
     * Denied tools, read at claim time. The claim handler returns the agent row
     * whole (packages/api/src/app.ts), so this arrives for free once the column
     * exists — this hand-written mirror is the only thing that needed updating.
     */
    disabledTools: string[];
  };
  repo: {
    id: string;
    remoteUrl: string;
    defaultBranch: string;
    mountPath: string;
    dependencyProvisioning: DependencyProvisioning;
  };
  run: {
    id: string;
    runNumber: number;
    /**
     * Whether this run may open a pull request. Required, so a path in our own
     * code that forgets it is a compile error rather than a silent
     * `undefined → falsy → never open a PR`.
     *
     * It lives on `run` and deliberately NOT on `task`: the run carries the
     * snapshot taken when it was created, so an operator's PATCH of the task
     * cannot change a run that is already queued. The claim route reads the live
     * task row, so reading it from `task` would break that contract — omitting
     * it there makes doing so a compile error.
     */
    opensPullRequest: boolean;
    /** Whether this Run must advance the workspace commit before delivery. */
    requiresCommit: boolean;
    /** The integration branch selected by the chain's first run. Later runs'
     * targetBranch is the shared head and cannot recover this value. */
    pullRequestBase: string;
    maxDurationMin: number;
    stallTimeoutMin: number;
    maxRunsPerTask: number;
    model: string;
    codexServiceTier: CodexServiceTier;
    subagentModel: string | null;
    subagentMaxConcurrent: number | null;
    targetBranch: string | null;
    /** Whether targetBranch was selected from durable Run.pushedBranch evidence.
     * When true, provisioning must not replace it with an older declared head. */
    targetBranchPublished: boolean;
    /** Exact commit selected by baseFromStepIndex. Null means ordinary branch
     * provisioning; a value means fetch-only detached provisioning. */
    pinnedBaseSha: string | null;
    /** Immutable review range exposed without revealing predecessor outputs. */
    implementationBaseSha: string | null;
    implementationHeadSha: string | null;
    promptHash: string | null;
    workspacePath: string | null;
    branch: string | null;
    baseSha: string | null;
  };
  session: { id: string };
  resume: { providerConversationId: string; input: string } | null;
  nextEventSeq: number;
  runner: RunnerKind;
  fencingToken: string;
  sessionToken: string;
  secrets: Record<string, string>;
  priorOutputs: Array<{ kind: string; body: string; task: { name: string; chainIndex: number | null } }>;
  /** Direct operator comments eligible for claim-time prompt delivery. */
  operatorNotes: string[];
  /** Immediate prior attempt evidence for a fresh provider Session. */
  previousRunHandoff: {
    schemaVersion: 1;
    previousRunId: string;
    status: string;
    failureReason: string | null;
    retryReason: "approval-rejected-without-feedback" | "automatic-retry" | "operator-retry" | "retry";
    output: { runId: string; kind: string; body: string; commitSha: string | null } | null;
  } | null;
  /** A control-plane selected, exact-head handoff for a fresh Regression Run.
   * It carries only durable verdict/repair evidence, never provider history. */
  regressionRepairHandoff: RegressionRepairHandoff | null;
};

/** The fenced Run identity consumed by runner-to-control-plane writes. */
export type ControlPlaneRunClaim = Pick<ClaimedTask, "fencingToken"> & {
  run: Pick<ClaimedTask["run"], "id">;
};

/** The session principal consumed by session-authenticated control-plane writes. */
export type ControlPlaneSessionClaim = ControlPlaneRunClaim & Pick<ClaimedTask, "sessionToken">;

export type SessionEventPayload = {
  seq: number;
  at?: string;
  source: "RUNNER" | "CLAUDE" | "CODEX" | "PI";
  type: string;
  providerEventId?: string | null;
  toolCallId?: string | null;
  payload: Record<string, unknown>;
};

const request = async (config: RunnerConfig, path: string, init: RequestInit): Promise<Response> => {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    // Endpoint-specific credentials intentionally come last. Session routes
    // must replace the runner principal rather than sending runner auth.
    headers: { Authorization: `Bearer ${config.runnerToken}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(config.apiTimeoutMs),
  }).catch((error: unknown) => {
    // A connected-but-silent API is indistinguishable from a fast one until it
    // is too late: without this the runner can sit in `await` past its own
    // lease expiry, which is the same lost run the per-command timeout exists
    // to prevent, one layer up.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Anneal API request timed out after ${config.apiTimeoutMs}ms: ${path}`);
    }
    throw error;
  });
  if (!response.ok && response.status !== 204) {
    const responseBody = await response.text();
    let code: string | undefined;
    try { code = (JSON.parse(responseBody) as { code?: string }).code; } catch { /* non-JSON error */ }
    throw new ControlPlaneError(response.status, responseBody, code);
  }
  return response;
};

type StatFs = (path: string) => Promise<{ bavail: number; bsize: number }>;
export type RunnerTelemetryBody = {
  daemonVersion: string;
  pollIntervalMs: number;
  workspaceRoot: string;
  diskFreeBytes?: number;
};

export const runnerTelemetryBody = async (config: RunnerConfig, readStats: StatFs = statfs): Promise<RunnerTelemetryBody> => {
  const base = {
    daemonVersion: config.daemonVersion,
    pollIntervalMs: config.pollIntervalMs,
    workspaceRoot: config.workspaceRoot,
  };
  try {
    const stats = await readStats(config.workspaceRoot);
    return { ...base, diskFreeBytes: stats.bavail * stats.bsize };
  } catch {
    // Telemetry must never stop the runner from claiming or heartbeating.
    return base;
  }
};

export const claimRequestBody = async (config: RunnerConfig, readStats: StatFs = statfs): Promise<Record<string, unknown>> => ({
  runnerId: config.runnerId,
  leaseSeconds: config.leaseSeconds,
  ...await runnerTelemetryBody(config, readStats),
});

export const claimTask = async (config: RunnerConfig): Promise<ClaimedTask | null> => {
  const response = await request(config, "/runner/tasks/claim", {
    method: "POST",
    body: JSON.stringify(await claimRequestBody(config)),
  });
  return response.status === 204 ? null : await response.json() as ClaimedTask;
};

export const startRun = async (
  config: RunnerConfig,
  claim: ControlPlaneRunClaim,
  snapshot: Record<string, unknown> & { promptHash: string },
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/start`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      ...snapshot,
    }),
  });
};

export const heartbeat = async (
  config: RunnerConfig,
  claim: ControlPlaneRunClaim,
  state: { processAlive: boolean; lastProgressEventAt: Date | null; inFlightTool: Record<string, unknown> | null },
): Promise<HeartbeatResult> => {
  const response = await request(config, `/runner/runs/${claim.run.id}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      leaseSeconds: config.leaseSeconds,
      processAlive: state.processAlive,
      lastProgressEventAt: state.lastProgressEventAt?.toISOString() ?? null,
      inFlightTool: state.inFlightTool,
      ...await runnerTelemetryBody(config),
    }),
  });
  return response.json() as Promise<HeartbeatResult>;
};

export const acknowledgeCancellation = async (
  config: RunnerConfig,
  claim: ControlPlaneRunClaim,
  cancellation: CancellationRequest,
  workspace?: { path: string; branch: string; baseSha: string } | null,
  containment: { worktreeContainmentViolations?: string[] } = {},
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/cancel/acknowledge`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      requestId: cancellation.requestId,
      ...(workspace ? { workspacePath: workspace.path, branch: workspace.branch, baseSha: workspace.baseSha } : {}),
      ...containment,
    }),
  });
};

export type SessionTaskOutputStatus = {
  outputKind: string | null;
  outputRequired: boolean;
  outputRemediationAllowed: boolean;
  outputSatisfiedByPriorRun: boolean;
  outputPersisted: boolean;
  output: {
    runId: string;
    kind: string;
    commitSha: string | null;
  } | null;
  /** Persisted canonical PR handoff bodies projected by the session route. */
  prWorkflowOutputs?: SessionPrWorkflowOutput[];
};

export type SessionPrWorkflowOutput = {
  taskId: string;
  chainIndex: number;
  kind: "implementation" | "sol-findings" | "blind-findings" | "fixed-implementation";
  body: string;
  commitSha: string;
};

export type SessionTaskOutput = {
  kind: string;
  body: string;
  commitSha: string;
  metadata?: Record<string, unknown>;
};

/** Persist a mechanically-authored deliverable through the Runner's existing
 * fenced control-plane transport. The script that derives the deliverable
 * never needs control-plane network access or session credentials. */
export const persistSessionTaskOutput = async (
  config: RunnerConfig,
  claim: ControlPlaneSessionClaim,
  output: SessionTaskOutput,
): Promise<void> => {
  await request(config, `/session/runs/${claim.run.id}/output`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${claim.sessionToken}` },
    body: JSON.stringify({ fencingToken: claim.fencingToken, ...output }),
  });
};

/** Read the output fact through the Run's session principal. Completion is too
 * late for recovery: by then the provider process and workspace are gone. */
export const readSessionTaskOutputStatus = async (
  config: RunnerConfig,
  claim: ControlPlaneSessionClaim,
): Promise<SessionTaskOutputStatus | null> => {
  const response = await request(config, `/session/runs/${claim.run.id}/status`, {
    method: "GET",
    headers: { Authorization: `Bearer ${claim.sessionToken}` },
  });
  const payload = await response.json() as {
    task?: {
      outputKind?: unknown;
      outputRequired?: unknown;
      outputRemediationAllowed?: unknown;
      outputSatisfiedByPriorRun?: unknown;
      outputPersisted?: unknown;
      output?: unknown;
      prWorkflowOutputs?: unknown;
    } | null;
  };
  const output = payload.task?.output;
  const prWorkflowOutputs = payload.task?.prWorkflowOutputs;
  const validOutput = output === null || (
    typeof output === "object"
    && !Array.isArray(output)
    && typeof (output as Record<string, unknown>).runId === "string"
    && typeof (output as Record<string, unknown>).kind === "string"
    && (typeof (output as Record<string, unknown>).commitSha === "string"
      || (output as Record<string, unknown>).commitSha === null)
  );
  // Canonical repositories may use SHA-1 (40 hex) or SHA-256 (64 hex).
  const isCanonicalCommitSha = (value: unknown): value is string => (
    typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
  );
  const validPrWorkflowOutputs = prWorkflowOutputs === undefined || (
    Array.isArray(prWorkflowOutputs)
    && prWorkflowOutputs.every((entry: unknown, index: number, entries: unknown[]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const value = entry as Record<string, unknown>;
      const previous = entries[index - 1];
      const previousIndex = previous && typeof previous === "object" && !Array.isArray(previous)
        ? (previous as Record<string, unknown>).chainIndex
        : undefined;
      return typeof value.taskId === "string"
        && value.taskId.trim().length > 0
        && Number.isInteger(value.chainIndex)
        && (value.chainIndex as number) > 0
        && typeof value.body === "string"
        && value.body.trim().length > 0
        && isCanonicalCommitSha(value.commitSha)
        && (value.kind === "implementation"
          || value.kind === "sol-findings"
          || value.kind === "blind-findings"
          || value.kind === "fixed-implementation")
        && (index === 0 || (Number.isInteger(previousIndex)
          && (value.chainIndex as number) > (previousIndex as number)))
        && entries.findIndex((candidate) => candidate
          && typeof candidate === "object"
          && !Array.isArray(candidate)
          && (candidate as Record<string, unknown>).taskId === value.taskId) === index;
    })
  );
  if (payload.task === null) return null;
  if (!payload.task
    || (typeof payload.task.outputKind !== "string" && payload.task.outputKind !== null)
    || typeof payload.task.outputRequired !== "boolean"
    || typeof payload.task.outputRemediationAllowed !== "boolean"
    || typeof payload.task.outputSatisfiedByPriorRun !== "boolean"
    || typeof payload.task.outputPersisted !== "boolean"
    || !validOutput
    || !validPrWorkflowOutputs) {
    throw new Error(`Anneal API returned an invalid task output status for Run ${claim.run.id}`);
  }
  return {
    outputKind: payload.task.outputKind,
    outputRequired: payload.task.outputRequired,
    outputRemediationAllowed: payload.task.outputRemediationAllowed,
    outputSatisfiedByPriorRun: payload.task.outputSatisfiedByPriorRun,
    outputPersisted: payload.task.outputPersisted,
    output: output as SessionTaskOutputStatus["output"],
    ...(prWorkflowOutputs === undefined ? {} : {
      prWorkflowOutputs: prWorkflowOutputs as SessionPrWorkflowOutput[],
    }),
  };
};

/** Durably acknowledge the exact ref immediately after git accepts the push.
 * Terminal completion is intentionally not the first write of this fact: PR
 * work, cleanup, or process loss may happen after publication. */
export const recordPublishedBranch = async (
  config: RunnerConfig,
  claim: ControlPlaneRunClaim,
  pushedBranch: string,
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/publication`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      pushedBranch,
    }),
  });
};

/** Records cleanup after this runner has lost its live lease. The control plane
 * accepts this only from the recorded runner/fence for an expired or terminal
 * run; unlike completion, it carries no authority over run outcome. */
export const recordLeaseIndependentCleanup = async (
  config: RunnerConfig,
  claim: ControlPlaneRunClaim,
  cleanup: { cleanupStatus: CleanupStatus; cleanupFailureReason?: string; workspaceRetained: boolean },
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/cleanup`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      ...cleanup,
    }),
  });
};

export const appendEvents = async (
  config: RunnerConfig,
  claim: ControlPlaneRunClaim,
  events: SessionEventPayload[],
  providerConversationId?: string | null,
): Promise<void> => {
  if (events.length === 0) return;
  await request(config, `/runner/runs/${claim.run.id}/events`, {
    method: "POST",
    body: JSON.stringify({
      runnerId: config.runnerId,
      fencingToken: claim.fencingToken,
      providerConversationId: providerConversationId ?? null,
      events,
    }),
  });
};

export const appendActivity = async (
  config: RunnerConfig,
  claim: ControlPlaneRunClaim,
  body: string,
  metadata: Record<string, unknown> = {},
): Promise<void> => {
  if (!body) return;
  await request(config, `/runner/runs/${claim.run.id}/activity`, {
    method: "POST",
    body: JSON.stringify({
      fencingToken: claim.fencingToken,
      actorId: config.runnerId,
      body,
      metadata,
    }),
  });
};

export type Completion = {
  exitCode: number | null;
  signal?: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  terminationReason?: string | null;
  failureClass?: FailureClass;
  failureReason?: string;
  retryable?: boolean;
  /** The environment failed, not the agent: the attempt must not spend budget. */
  externalFailure?: boolean;
  branch?: string | null;
  /** The ref actually handed to `git push`, which is not always `branch`: a WIP
   *  salvage pushes a per-run branch while `branch` still reports the
   *  workspace's. Declared here rather than left to ride along on a spread, so
   *  the wire contract is visible where the payload is defined. */
  pushedBranch?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  output?: string | null;
  pushStatus?: "NOT_REQUESTED" | "PENDING" | "SUCCEEDED" | "FAILED";
  pushRemote?: string | null;
  pushError?: string | null;
  pullRequestUrl?: string | null;
  pullRequestNumber?: number | null;
  deliveryInstructions?: string | null;
  cleanupStatus: CleanupStatus;
  cleanupFailureReason?: string | null;
  workspaceRetained: boolean;
  /** Absolute worktree paths outside the Run workspace observed at completion.
   *  This is report-only evidence; omission or an empty list is compliant and
   *  does not affect the API's terminal outcome classification. */
  worktreeContainmentViolations?: string[];
  /** Structured account of a failure, from which the API — not this process —
   *  decides the failure class, whether it is retryable and whether it spends
   *  the task's run budget. `failureClass`/`retryable`/`externalFailure` above
   *  are this runner's own verdict; an API that understands the envelope
   *  ignores them, and one that does not keeps using them unchanged. */
  failureEnvelope?: FailureEnvelope;
};

export const completeRun = async (
  config: RunnerConfig,
  claim: ControlPlaneRunClaim,
  completion: Completion,
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/complete`, {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, fencingToken: claim.fencingToken, ...completion }),
  });
};

export type ReclaimOffer = {
  runId: string;
  workspacePath: string | null;
  /** Required wire evidence: null is ordinary, a SHA forbids publication. */
  pinnedBaseSha: string | null;
  taskId?: string | null;
  runNumber?: number;
  baseSha?: string | null;
  pushedBranch?: string | null;
};
export type ReclaimPlan = {
  /** Directories in the reported inventory this runner may remove. */
  reclaim: ReclaimOffer[];
  /**
   * Intents still open for directories the inventory did not list. Removal
   * happens before the report, so a crash in between leaves an intent no later
   * inventory can mention; these are how the runner settles those.
   */
  verify: ReclaimOffer[];
  keep: Array<{ directory: string; reason: string }>;
};
export type ReclaimResult = {
  runId: string;
  outcome: "REMOVED" | "REFUSED" | "FAILED";
  failureReason?: string;
};

/**
 * Asks the control plane which of this runner's own directories it has
 * published a reclaim intent for (issue #115).
 *
 * `null` means the API does not speak this protocol — an older build with no
 * such route. That is not an error worth failing a poll over: the runner keeps
 * its directories, which leaks disk and deletes nothing, and the sweep succeeds
 * again the moment the API is upgraded.
 */
export const fetchReclaimPlan = async (
  config: RunnerConfig,
  inventory: { runnerId: string; workspaceRoot: string; directories: string[] },
): Promise<ReclaimPlan | null> => {
  const response = await request(config, "/runner/workspaces/reclaimable", {
    method: "POST",
    body: JSON.stringify(inventory),
  }).catch((error: unknown) => {
    if (error instanceof ControlPlaneError && error.status === 404) return null;
    throw error;
  });
  return response ? await response.json() as ReclaimPlan : null;
};

export const reportReclaimOutcomes = async (
  config: RunnerConfig,
  report: { runnerId: string; workspaceRoot: string; results: ReclaimResult[] },
): Promise<void> => {
  await request(config, "/runner/workspaces/reclaimed", {
    method: "POST",
    body: JSON.stringify(report),
  }).catch((error: unknown) => {
    if (error instanceof ControlPlaneError && error.status === 404) return null;
    throw error;
  });
};

export const recordReclaimPublication = async (
  config: RunnerConfig,
  body: { runnerId: string; runId: string; pushedBranch: string },
): Promise<void> => {
  await request(config, "/runner/workspaces/salvaged", {
    method: "POST",
    body: JSON.stringify(body),
  });
};

export const reportPreflight = async (
  config: RunnerConfig,
  runner: RunnerKind,
  result: { ok: boolean; cliVersion?: string | null; authMode?: string | null; capabilities: Record<string, unknown>; error?: string | null },
): Promise<void> => {
  await request(config, "/runner/preflight", {
    method: "POST",
    body: JSON.stringify({ runner, ...result }),
  });
};

export const reportCliAvailability = async (
  config: RunnerConfig,
  availability: { runner: RunnerKind; binary: string; available: boolean; resolvedPath: string | null },
): Promise<{ revalidatePreflight: boolean }> => {
  const response = await request(config, "/runner/availability", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, ...availability }),
  });
  // The established endpoint contract did not require a response body. During
  // rollout, an older control plane (and narrow protocol fixtures) may still
  // acknowledge the report with an empty 2xx response. Only a non-empty body
  // carries the additive recovery directive; malformed JSON still fails.
  const responseBody = await response.text();
  if (!responseBody.trim()) return { revalidatePreflight: false };
  const body = JSON.parse(responseBody) as { revalidatePreflight?: boolean };
  return { revalidatePreflight: body.revalidatePreflight === true };
};

/**
 * The runner-to-control-plane seam. The HTTP adapter below owns route paths,
 * fencing envelopes, timeout translation, and error decoding; callers consume
 * domain operations and classify authority through this interface.
 */
export interface ControlPlane {
  claim: typeof claimTask;
  startRun: typeof startRun;
  heartbeat: typeof heartbeat;
  appendEvents: typeof appendEvents;
  appendActivity: typeof appendActivity;
  completeRun: typeof completeRun;
  persistSessionTaskOutput: typeof persistSessionTaskOutput;
  readSessionTaskOutputStatus: typeof readSessionTaskOutputStatus;
  recordPublishedBranch: typeof recordPublishedBranch;
  recordLeaseIndependentCleanup: typeof recordLeaseIndependentCleanup;
  acknowledgeCancellation: typeof acknowledgeCancellation;
  fetchReclaimPlan: typeof fetchReclaimPlan;
  reportReclaimOutcomes: typeof reportReclaimOutcomes;
  recordReclaimPublication: typeof recordReclaimPublication;
  reportPreflight: typeof reportPreflight;
  reportCliAvailability: typeof reportCliAvailability;
  authorityFor(error: unknown): Authority;
  authorityAfterHeartbeat(result: HeartbeatResult): Authority;
  retriableStartupError(error: unknown): boolean;
}

export const controlPlane: ControlPlane = Object.freeze({
  claim: claimTask,
  startRun,
  heartbeat,
  appendEvents,
  appendActivity,
  completeRun,
  persistSessionTaskOutput,
  readSessionTaskOutputStatus,
  recordPublishedBranch,
  recordLeaseIndependentCleanup,
  acknowledgeCancellation,
  fetchReclaimPlan,
  reportReclaimOutcomes,
  recordReclaimPublication,
  reportPreflight,
  reportCliAvailability,
  authorityFor,
  authorityAfterHeartbeat,
  retriableStartupError,
});
