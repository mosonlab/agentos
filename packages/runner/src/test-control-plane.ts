import {
  authorityFor,
  authorityAfterHeartbeat,
  ControlPlaneError,
  retriableStartupError,
  type ClaimedTask,
  type Completion,
  type ControlPlane,
  type ReclaimResult,
  type SessionEventPayload,
  type SessionTaskOutputStatus,
} from "./api.js";
import type { RunnerKind } from "./config.js";

type AsyncMethodName = {
  [K in keyof ControlPlane]: ControlPlane[K] extends (...args: never[]) => Promise<unknown> ? K : never
}[keyof ControlPlane];

export type ControlPlaneOverrides = Partial<Pick<ControlPlane, AsyncMethodName>>;

export type ControlPlaneDouble = {
  controlPlane: ControlPlane;
  completions: Completion[];
  starts: Array<Record<string, unknown> & { promptHash: string }>;
  eventBatches: SessionEventPayload[][];
  activities: Array<{ body: string; metadata: Record<string, unknown> }>;
  publishedBranches: string[];
  leaseIndependentCleanups: Array<{ cleanupStatus: string; cleanupFailureReason?: string; workspaceRetained: boolean }>;
  reclaimReports: ReclaimResult[][];
  reclaimPublications: string[];
  preflightReports: Array<{ runner: RunnerKind; result: Parameters<ControlPlane["reportPreflight"]>[2] }>;
  availabilityReports: Parameters<ControlPlane["reportCliAvailability"]>[1][];
  heartbeatCount: () => number;
  outputStatusReadCount: () => number;
};

/** In-memory adapter for tests that need runner domain outcomes, not HTTP routes. */
export const createControlPlaneDouble = (
  overrides: ControlPlaneOverrides = {},
): ControlPlaneDouble => {
  const completions: Completion[] = [];
  const starts: Array<Record<string, unknown> & { promptHash: string }> = [];
  const eventBatches: SessionEventPayload[][] = [];
  const activities: Array<{ body: string; metadata: Record<string, unknown> }> = [];
  const publishedBranches: string[] = [];
  const leaseIndependentCleanups: Array<{ cleanupStatus: string; cleanupFailureReason?: string; workspaceRetained: boolean }> = [];
  const reclaimReports: ReclaimResult[][] = [];
  const reclaimPublications: string[] = [];
  const preflightReports: ControlPlaneDouble["preflightReports"] = [];
  const availabilityReports: ControlPlaneDouble["availabilityReports"] = [];
  let heartbeats = 0;
  let outputStatusReads = 0;

  const controlPlane: ControlPlane = {
    claim: async (config) => overrides.claim?.(config) ?? null,
    startRun: async (config, claim, snapshot) => {
      starts.push(snapshot);
      await overrides.startRun?.(config, claim, snapshot);
    },
    heartbeat: async (config, claim, state) => {
      heartbeats += 1;
      return await overrides.heartbeat?.(config, claim, state) ?? { ok: true, cancellation: null };
    },
    appendEvents: async (config, claim, events, providerConversationId) => {
      eventBatches.push(events);
      await overrides.appendEvents?.(config, claim, events, providerConversationId);
    },
    appendActivity: async (config, claim, body, metadata) => {
      activities.push({ body, metadata: metadata ?? {} });
      await overrides.appendActivity?.(config, claim, body, metadata);
    },
    completeRun: async (config, claim, completion) => {
      completions.push(completion);
      await overrides.completeRun?.(config, claim, completion);
    },
    readSessionTaskOutputStatus: async (config, claim) => {
      outputStatusReads += 1;
      return await overrides.readSessionTaskOutputStatus?.(config, claim) ?? null;
    },
    recordPublishedBranch: async (config, claim, branch) => {
      publishedBranches.push(branch);
      await overrides.recordPublishedBranch?.(config, claim, branch);
    },
    recordLeaseIndependentCleanup: async (config, claim, cleanup) => {
      leaseIndependentCleanups.push(cleanup);
      await overrides.recordLeaseIndependentCleanup?.(config, claim, cleanup);
    },
    acknowledgeCancellation: async (config, claim, cancellation, workspace, containment) => {
      await overrides.acknowledgeCancellation?.(config, claim, cancellation, workspace, containment);
    },
    fetchReclaimPlan: async (config, inventory) => overrides.fetchReclaimPlan?.(config, inventory) ?? null,
    reportReclaimOutcomes: async (config, report) => {
      reclaimReports.push(report.results);
      await overrides.reportReclaimOutcomes?.(config, report);
    },
    recordReclaimPublication: async (config, body) => {
      reclaimPublications.push(body.pushedBranch);
      await overrides.recordReclaimPublication?.(config, body);
    },
    reportPreflight: async (config, runner, result) => {
      preflightReports.push({ runner, result });
      await overrides.reportPreflight?.(config, runner, result);
    },
    reportCliAvailability: async (config, availability) => {
      availabilityReports.push(availability);
      return await overrides.reportCliAvailability?.(config, availability) ?? { revalidatePreflight: false };
    },
    authorityFor,
    authorityAfterHeartbeat,
    retriableStartupError,
  };

  return {
    controlPlane,
    completions,
    starts,
    eventBatches,
    activities,
    publishedBranches,
    leaseIndependentCleanups,
    reclaimReports,
    reclaimPublications,
    preflightReports,
    availabilityReports,
    heartbeatCount: () => heartbeats,
    outputStatusReadCount: () => outputStatusReads,
  };
};

export const controlPlaneClaim = (claim: ClaimedTask): ControlPlaneOverrides => ({
  claim: async () => claim,
});

export type ControlPlaneFetchHandler = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Migration adapter for older runner tests whose scenarios were expressed as
 * synthetic HTTP responses. The production code still receives a ControlPlane
 * double; this adapter keeps those fixtures local while newer tests use direct
 * operation overrides above.
 */
export const createRoutedControlPlaneDouble = (
  handler: ControlPlaneFetchHandler,
): ControlPlaneDouble => {
  const request = async <T>(
    config: Parameters<ControlPlane["completeRun"]>[0],
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> => {
    const response = await handler(`${config.apiUrl}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const responseBody = await response.text();
    if (!response.ok) {
      let code: string | undefined;
      try { code = (JSON.parse(responseBody) as { code?: string }).code; } catch { /* non-JSON error */ }
      throw new ControlPlaneError(response.status, responseBody, code);
    }
    return (responseBody.trim() ? JSON.parse(responseBody) : {}) as T;
  };

  return createControlPlaneDouble({
    startRun: async (config, claim, snapshot) => {
      await request(config, `/runner/runs/${claim.run.id}/start`, {
        runnerId: config.runnerId, fencingToken: claim.fencingToken, ...snapshot,
      });
    },
    heartbeat: async (config, claim, state) => request(config, `/runner/runs/${claim.run.id}/heartbeat`, {
      runnerId: config.runnerId, fencingToken: claim.fencingToken, ...state,
    }),
    appendEvents: async (config, claim, events, providerConversationId) => {
      await request(config, `/runner/runs/${claim.run.id}/events`, {
        runnerId: config.runnerId, fencingToken: claim.fencingToken, providerConversationId: providerConversationId ?? null, events,
      });
    },
    appendActivity: async (config, claim, body, metadata) => {
      await request(config, `/runner/runs/${claim.run.id}/activity`, {
        fencingToken: claim.fencingToken, actorId: config.runnerId, body, metadata: metadata ?? {},
      });
    },
    completeRun: async (config, claim, completion) => {
      await request(config, `/runner/runs/${claim.run.id}/complete`, {
        runnerId: config.runnerId, fencingToken: claim.fencingToken, ...completion,
      });
    },
    readSessionTaskOutputStatus: async (config, claim) => {
      const payload = await request<{ task: SessionTaskOutputStatus | null }>(
        config,
        `/session/runs/${claim.run.id}/status`,
        {},
      );
      return payload.task;
    },
    recordPublishedBranch: async (config, claim, pushedBranch) => {
      await request(config, `/runner/runs/${claim.run.id}/publication`, {
        runnerId: config.runnerId, fencingToken: claim.fencingToken, pushedBranch,
      });
    },
    recordLeaseIndependentCleanup: async (config, claim, cleanup) => {
      await request(config, `/runner/runs/${claim.run.id}/cleanup`, {
        runnerId: config.runnerId, fencingToken: claim.fencingToken, ...cleanup,
      });
    },
    acknowledgeCancellation: async (config, claim, cancellation, workspace, containment) => {
      await request(config, `/runner/runs/${claim.run.id}/cancel/acknowledge`, {
        runnerId: config.runnerId,
        fencingToken: claim.fencingToken,
        requestId: cancellation.requestId,
        ...(workspace ? { workspacePath: workspace.path, branch: workspace.branch, baseSha: workspace.baseSha } : {}),
        ...containment,
      });
    },
    reportPreflight: async (config, runner, result) => {
      await request(config, "/runner/preflight", { runner, ...result });
    },
    reportCliAvailability: async (config, availability) => {
      const body = await request<{ revalidatePreflight?: boolean }>(config, "/runner/availability", {
        runnerId: config.runnerId, ...availability,
      });
      return { revalidatePreflight: body.revalidatePreflight === true };
    },
  });
};
