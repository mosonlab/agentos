/**
 * The executor's control-plane client.
 *
 * It uses exactly the existing runner and session principals — no new token
 * class (SPEC §10). The `MERGE_EXECUTOR_TOKEN` claims and completes; the per-run session
 * token, issued by the claim, reads the chain and writes the fenced records.
 *
 * Note what is NOT here: no workspace, no prompt, no adapter, no delivery, no
 * publication call of any kind. The package's import graph is asserted in
 * `import-graph.test.ts` precisely so that stays true.
 */

import type { MergeOutcome } from "@anneal/db/merge-integrator";

import type { ExecutorConfig } from "./config.js";
import type { ChainEnvelope, IntentRecord } from "./decision-table.js";

export type MechanicalClaim = {
  executionMode: "mechanical" | "agent";
  task: { id: string; name: string; chainIndex?: number | null };
  run: { id: string; runNumber: number; maxRunsPerTask: number };
  session: { id: string };
  fencingToken: string;
  sessionToken: string;
};

export type MechanicalCancellation = {
  requestId: string;
  reason: string;
  requestedAt: string;
};

export type MechanicalHeartbeat = {
  cancellation: MechanicalCancellation | null;
  mechanicalCancellationPolicy: "refused" | null;
};

export type AgentOsClient = ReturnType<typeof makeAgentOsClient>;

const jsonHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

export const makeAgentOsClient = (config: ExecutorConfig, fetchImpl: typeof fetch = fetch) => {
  const request = async (
    path: string,
    init: { method: string; token: string; body?: unknown },
  ): Promise<Response> => {
    const response = await fetchImpl(`${config.apiUrl}${path}`, {
      method: init.method,
      headers: jsonHeaders(init.token),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(config.apiTimeoutMs),
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`AgentOS API ${response.status}: ${await response.text()}`);
    }
    return response;
  };

  const claim = async (): Promise<MechanicalClaim | null> => {
    const response = await request("/runner/tasks/claim", {
      method: "POST",
      token: config.executorToken,
      body: { runnerId: config.runnerId, leaseSeconds: config.leaseSeconds },
    });
    return response.status === 204 ? null : await response.json() as MechanicalClaim;
  };

  const start = async (claimed: MechanicalClaim): Promise<void> => {
    await request(`/runner/runs/${claimed.run.id}/start`, {
      method: "POST",
      token: config.executorToken,
      body: {
        runnerId: config.runnerId,
        fencingToken: claimed.fencingToken,
        adapterVersion: "merge-executor-v1",
        cliVersion: "merge-executor-v1",
        // No workspace exists, and none may: this process provisions nothing.
        workspacePath: null,
        manifest: { executionMode: "mechanical", childProcessCount: 0 },
      },
    });
  };

  const heartbeat = async (claimed: MechanicalClaim): Promise<MechanicalHeartbeat> => {
    const response = await request(`/runner/runs/${claimed.run.id}/heartbeat`, {
      method: "POST",
      token: config.executorToken,
      body: {
        runnerId: config.runnerId,
        fencingToken: claimed.fencingToken,
        leaseSeconds: config.leaseSeconds,
        processAlive: true,
        lastProgressEventAt: null,
        inFlightTool: null,
      },
    });
    if (response.status === 204) return { cancellation: null, mechanicalCancellationPolicy: null };
    const payload = await response.json() as {
      cancellation?: MechanicalCancellation | null;
      mechanicalCancellationPolicy?: string;
    };
    return {
      cancellation: payload.cancellation ?? null,
      mechanicalCancellationPolicy: payload.mechanicalCancellationPolicy === "refused" ? "refused" : null,
    };
  };

  const acknowledgeCancellation = async (
    claimed: MechanicalClaim,
    cancellation: MechanicalCancellation,
  ): Promise<void> => {
    await request(`/runner/runs/${claimed.run.id}/cancel/acknowledge`, {
      method: "POST",
      token: config.executorToken,
      body: {
        runnerId: config.runnerId,
        fencingToken: claimed.fencingToken,
        requestId: cancellation.requestId,
      },
    });
  };

  const readChain = async (claimed: MechanicalClaim, chainIndex: number): Promise<ChainEnvelope> => {
    const response = await request(`/session/runs/${claimed.run.id}/chain/steps/${chainIndex}/activity`, {
      method: "GET",
      token: claimed.sessionToken,
    });
    return await response.json() as ChainEnvelope;
  };

  const readOwnIntents = async (claimed: MechanicalClaim, chainIndex: number): Promise<IntentRecord[]> => {
    const response = await request(`/session/runs/${claimed.run.id}/chain/steps/${chainIndex}/activity`, {
      method: "GET",
      token: claimed.sessionToken,
    });
    const payload = await response.json() as { records?: Array<{ id: string; payload: Record<string, unknown> | null }> };
    return (payload.records ?? []).flatMap((record) => {
      const metadata = record.payload;
      if (!metadata || metadata.kind !== "mergeIntegrator.intent") return [];
      const { idempotencyKey, prNumber, headSha, authorizationActivityId } = metadata as Record<string, unknown>;
      if (typeof idempotencyKey !== "string" || typeof prNumber !== "number") return [];
      if (typeof headSha !== "string" || typeof authorizationActivityId !== "string") return [];
      return [{ activityId: record.id, idempotencyKey, prNumber, headSha, authorizationActivityId }];
    });
  };

  const writeActivity = async (
    claimed: MechanicalClaim,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    await request(`/session/runs/${claimed.run.id}/activity`, {
      method: "POST",
      token: claimed.sessionToken,
      body: { fencingToken: claimed.fencingToken, actorId: config.runnerId, body, metadata },
    });
  };

  const writeOutput = async (claimed: MechanicalClaim, kind: string, body: string): Promise<void> => {
    await request(`/session/runs/${claimed.run.id}/output`, {
      method: "PUT",
      token: claimed.sessionToken,
      body: { fencingToken: claimed.fencingToken, kind, body },
    });
  };

  /**
   * Every *executed* contract ends the run SUCCESS — a recorded stop is a
   * completed execution of the decision table, not a failure. FAILURE is
   * reserved for crashes, so the control plane's automatic retry stays keyed on
   * "the process died", never on "the merge was refused".
   */
  const complete = async (
    claimed: MechanicalClaim,
    completion: { succeeded: boolean; outcome: MergeOutcome | null; failureReason?: string },
  ): Promise<void> => {
    await request(`/runner/runs/${claimed.run.id}/complete`, {
      method: "POST",
      token: config.executorToken,
      body: {
        runnerId: config.runnerId,
        fencingToken: claimed.fencingToken,
        exitCode: completion.succeeded ? 0 : 1,
        terminalEventSeen: true,
        terminalSuccess: completion.succeeded,
        ...(completion.succeeded ? {} : { failureClass: "PROTOCOL_ERROR", failureReason: completion.failureReason ?? "merge executor crashed", retryable: true }),
        pushStatus: "NOT_REQUESTED",
        cleanupStatus: "SUCCEEDED",
        workspaceRetained: false,
      },
    });
  };

  return { claim, start, heartbeat, acknowledgeCancellation, readChain, readOwnIntents, writeActivity, writeOutput, complete };
};
