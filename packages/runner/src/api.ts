import type { RunnerConfig, RunnerKind } from "./config.js";

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
    maxDurationMin: number;
    stallTimeoutMin: number;
    maxRunsPerTask: number;
    model: string;
    targetBranch: string | null;
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

export const claimTask = async (config: RunnerConfig): Promise<ClaimedTask | null> => {
  const response = await request(config, "/runner/tasks/claim", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, leaseSeconds: config.leaseSeconds }),
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
};

export const completeRun = async (config: RunnerConfig, claim: ClaimedTask, completion: Completion): Promise<void> => {
  await request(config, `/runner/runs/${claim.run.id}/complete`, {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, fencingToken: claim.fencingToken, ...completion }),
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
