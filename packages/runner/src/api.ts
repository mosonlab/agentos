import { statfs } from "node:fs/promises";

import type { RunnerConfig, RunnerKind } from "./config.js";
import type { FailureEnvelope } from "./envelope.js";

export type FailureClass =
  | "BINARY_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "CANCELLED_OR_TIMED_OUT"
  | "TOOL_FAILED"
  | "TRANSIENT_PROVIDER"
  | "PROTOCOL_ERROR"
  | "TASK_FAILED"
  | "BUDGET_EXCEEDED";

export type CleanupStatus = "SUCCEEDED" | "FAILED" | "RETAINED";

export type ClaimedTask = {
  /**
   * Server-computed from the claimed task's template step (§D-P1 rule 4).
   * Required, not optional, so a runner build that predates this field fails to
   * compile rather than reading `undefined` as "ordinary" — the one reading that
   * would put a merge step in front of a model CLI.
   *
   * The ordinary runner refuses `"mechanical"` outright. It is claimed by
   * `@agentos/merge-executor`, a different process under a different OS user.
   */
  executionMode: "mechanical" | "agent";
  task: {
    id: string;
    name: string;
    description: string;
    repoId: string;
    targetBranch: string | null;
    maxDurationMin: number;
    stallTimeoutMin: number;
    maxSessionsPerTask: number;
    templateStep?: { name: string } | null;
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
    /** The integration branch selected by the chain's first run. Later runs'
     * targetBranch is the shared head and cannot recover this value. */
    pullRequestBase: string;
    maxDurationMin: number;
    stallTimeoutMin: number;
    maxRunsPerTask: number;
    model: string;
    targetBranch: string | null;
    /** Exact commit selected by baseFromStepIndex. Null means ordinary branch
     * provisioning; a value means fetch-only detached provisioning. */
    pinnedBaseSha: string | null;
    /** Immutable review range exposed without revealing predecessor outputs. */
    implementationBaseSha: string | null;
    implementationHeadSha: string | null;
    promptHash: string;
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
};

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
    headers: { Authorization: `Bearer ${config.runnerToken}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(config.apiTimeoutMs),
  }).catch((error: unknown) => {
    // A connected-but-silent API is indistinguishable from a fast one until it
    // is too late: without this the runner can sit in `await` past its own
    // lease expiry, which is the same lost run the per-command timeout exists
    // to prevent, one layer up.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`AgentOS API request timed out after ${config.apiTimeoutMs}ms: ${path}`);
    }
    throw error;
  });
  if (!response.ok && response.status !== 204) {
    const responseBody = await response.text();
    let code: string | undefined;
    try { code = (JSON.parse(responseBody) as { code?: string }).code; } catch { /* non-JSON error */ }
    const error = new Error(`AgentOS API ${response.status}: ${responseBody}`);
    Object.assign(error, { status: response.status, code });
    throw error;
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
  claim: ClaimedTask,
  snapshot: Record<string, unknown>,
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
  claim: ClaimedTask,
  state: { processAlive: boolean; lastProgressEventAt: Date | null; inFlightTool: Record<string, unknown> | null },
): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/heartbeat`, {
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
};

/** Durably acknowledge the exact ref immediately after git accepts the push.
 * Terminal completion is intentionally not the first write of this fact: PR
 * work, cleanup, or process loss may happen after publication. */
export const recordPublishedBranch = async (
  config: RunnerConfig,
  claim: ClaimedTask,
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

export const appendEvents = async (
  config: RunnerConfig,
  claim: ClaimedTask,
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
  claim: ClaimedTask,
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
  /** Structured account of a failure, from which the API — not this process —
   *  decides the failure class, whether it is retryable and whether it spends
   *  the task's run budget. `failureClass`/`retryable`/`externalFailure` above
   *  are this runner's own verdict; an API that understands the envelope
   *  ignores them, and one that does not keeps using them unchanged. */
  failureEnvelope?: FailureEnvelope;
};

export const completeRun = async (config: RunnerConfig, claim: ClaimedTask, completion: Completion): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/complete`, {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, fencingToken: claim.fencingToken, ...completion }),
  });
};

export type ReclaimOffer = { runId: string; workspacePath: string | null };
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
    if ((error as { status?: number }).status === 404) return null;
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
    if ((error as { status?: number }).status === 404) return null;
    throw error;
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
): Promise<void> => {
  await request(config, "/runner/availability", {
    method: "POST",
    body: JSON.stringify(availability),
  });
};
