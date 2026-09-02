import { authorityFor, type Authority, type CancellationRequest } from "./api.js";
import { deliveryDeadline, type RetryOptions } from "./network-retry.js";

export type RunLeaseEvidence = {
  processAlive: boolean;
  lastProgressEventAt: Date | null;
  inFlightTool: Record<string, unknown> | null;
};

export type RunLeasePhase =
  | { name: "provision"; startedAt: Date }
  | {
    name: "execute";
    evidence: () => Promise<RunLeaseEvidence>;
    afterRenewal?: () => void;
  }
  | { name: "deliver"; startedAt: Date };

export type RunLeaseClock = {
  now: () => number;
  setInterval: (callback: () => void | Promise<void>, intervalMs: number) => unknown;
  clearInterval: (timer: unknown) => void;
};

type ProviderStopResult = { processAlive: boolean };

export type RunLeaseOptions<ProviderHandle extends object> = {
  heartbeatIntervalMs: number;
  leaseSeconds: number;
  initialPhase: Extract<RunLeasePhase, { name: "provision" }>;
  /** Renews the lease and reports the Run authority the control plane returned. */
  send: (evidence: RunLeaseEvidence) => Promise<Authority>;
  stopProvider: (handle: ProviderHandle, reason: string) => Promise<ProviderStopResult>;
  acknowledgeCancellation: (request: CancellationRequest) => Promise<void>;
  onRevocationStopError?: (error: unknown) => void;
  onRenewalError?: (error: unknown) => void;
  clock?: RunLeaseClock;
};

export type RunLease<ProviderHandle extends object> = {
  readonly authority: Authority;
  readonly held: boolean;
  readonly deadline: number;
  enterPhase: (phase: RunLeasePhase) => Promise<void>;
  adoptError: (error: unknown) => Promise<boolean>;
  launch: (start: () => Promise<ProviderHandle>) => Promise<ProviderHandle | null>;
  abandonProviderLaunch: () => void;
  stopProvider: (handle: ProviderHandle, reason: string) => Promise<void>;
  checkpoint: () => Promise<Authority>;
  close: () => Promise<void>;
};

type LaunchSlot<ProviderHandle> = {
  readonly settled: Promise<ProviderHandle | null>;
  readonly settle: (handle: ProviderHandle | null) => void;
  started: boolean;
};

const launchSlot = <ProviderHandle>(): LaunchSlot<ProviderHandle> => {
  let settle!: (handle: ProviderHandle | null) => void;
  const settled = new Promise<ProviderHandle | null>((resolve) => { settle = resolve; });
  return { settled, settle, started: false };
};

const defaultClock: RunLeaseClock = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => setInterval(() => { void callback(); }, intervalMs),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

const evidenceFor = async (phase: RunLeasePhase): Promise<RunLeaseEvidence> => {
  if (phase.name === "execute") return phase.evidence();
  const toolName = phase.name === "provision" ? "workspace-provision" : "delivery";
  return {
    processAlive: true,
    lastProgressEventAt: phase.startedAt,
    inFlightTool: {
      id: toolName,
      name: toolName,
      startedAt: phase.startedAt.toISOString(),
      lastProgressAt: phase.startedAt.toISOString(),
    },
  };
};

const stopReason = (authority: Exclude<Authority, { held: true } | { reason: "cancelled" }>): string =>
  authority.reason === "waiting-inbox" ? "waiting for Inbox reply" : "fencing token rejected";

/**
 * Owns one run Lease from claim through terminal delivery. Phase changes only
 * select the evidence carried by the next renewal; they never replace or pause
 * the renewal loop.
 */
export const createRunLease = <ProviderHandle extends object>(
  options: RunLeaseOptions<ProviderHandle>,
): RunLease<ProviderHandle> => {
  const clock = options.clock ?? defaultClock;
  let phase: RunLeasePhase = options.initialPhase;
  let authority: Authority = { held: true };
  let renewedAt = clock.now();
  let deadline: number | null = null;
  let currentProvider: ProviderHandle | null = null;
  let currentLaunch: LaunchSlot<ProviderHandle> | null = launchSlot();
  const providerStops = new WeakMap<ProviderHandle, Promise<void>>();
  const pendingTransitions = new Set<Promise<void>>();
  let cancellationTask: Promise<void> | null = null;
  let renewalTask: Promise<void> | null = null;
  let closed = false;

  const stopProvider = (handle: ProviderHandle, reason: string): Promise<void> => {
    const active = providerStops.get(handle);
    if (active) return active;
    const stopping = options.stopProvider(handle, reason).then((result) => {
      if (result.processAlive) throw new Error("Run still owns a live provider process");
    });
    providerStops.set(handle, stopping);
    return stopping;
  };

  const track = (task: Promise<void>): Promise<void> => {
    const tracked = task.finally(() => { pendingTransitions.delete(tracked); });
    pendingTransitions.add(tracked);
    return tracked;
  };

  const providerForCurrentLaunch = async (): Promise<ProviderHandle | null> => {
    const launch = currentLaunch;
    return launch ? launch.settled : currentProvider;
  };

  const stopCurrentProvider = async (reason: string): Promise<void> => {
    const provider = await providerForCurrentLaunch();
    if (provider) await stopProvider(provider, reason);
  };

  const adopt = (next: Authority): Promise<void> => {
    if (next.held) return Promise.resolve();
    if (!authority.held && authority.reason === "cancelled") {
      return cancellationTask ?? Promise.resolve();
    }

    if (next.reason === "cancelled") {
      authority = next;
      cancellationTask ??= track((async () => {
        await stopCurrentProvider(next.request.reason);
        await options.acknowledgeCancellation(next.request);
      })());
      return cancellationTask;
    }

    if (authority.held || (authority.reason === "revoked" && next.reason === "waiting-inbox")) {
      authority = next;
    }
    const revoked = authority.held ? next : authority;
    return track(stopCurrentProvider(stopReason(revoked)).catch((error: unknown) => {
      if (!options.onRevocationStopError) throw error;
      options.onRevocationStopError(error);
    }));
  };

  const performRenewal = async (renewalPhase: RunLeasePhase): Promise<void> => {
    if (!authority.held || closed) return;
    const sentAt = clock.now();
    try {
      const next = await options.send(await evidenceFor(renewalPhase));
      await adopt(next);
      if (next.held && authority.held) renewedAt = sentAt;
    } catch (error: unknown) {
      const next = authorityFor(error);
      await adopt(next);
      if (next.held && authority.held) options.onRenewalError?.(error);
    } finally {
      if (authority.held && renewalPhase.name === "execute") renewalPhase.afterRenewal?.();
    }
  };

  const renew = (): Promise<void> => {
    if (renewalTask) return renewalTask;
    const task = performRenewal(phase).finally(() => {
      if (renewalTask === task) renewalTask = null;
    });
    renewalTask = task;
    return task;
  };

  const timer = clock.setInterval(renew, options.heartbeatIntervalMs);

  const checkpoint = async (): Promise<Authority> => {
    if (renewalTask) await renewalTask;
    if (cancellationTask) await cancellationTask;
    while (pendingTransitions.size > 0) await Promise.all(pendingTransitions);
    return authority;
  };

  const enterPhase = async (next: RunLeasePhase): Promise<void> => {
    if (closed) throw new Error("Cannot change phase after the run Lease is closed");
    phase = next;
    if (next.name !== "deliver") return;
    if (renewalTask) await renewalTask;
    await renew();
    deadline = deliveryDeadline(renewedAt, options.leaseSeconds, clock.now());
  };

  const launch = async (start: () => Promise<ProviderHandle>): Promise<ProviderHandle | null> => {
    if (!authority.held) {
      if (currentLaunch && !currentLaunch.started) {
        currentLaunch.settle(null);
        currentLaunch = null;
      }
      await checkpoint();
      return null;
    }

    const slot = currentLaunch ?? launchSlot<ProviderHandle>();
    currentLaunch = slot;
    slot.started = true;
    let launchedProvider: ProviderHandle;
    try {
      launchedProvider = await start();
      currentProvider = launchedProvider;
      slot.settle(launchedProvider);
    } catch (error: unknown) {
      slot.settle(null);
      throw error;
    } finally {
      if (currentLaunch === slot) currentLaunch = null;
    }

    if (!authority.held) {
      await checkpoint();
      return null;
    }
    return launchedProvider;
  };

  const abandonProviderLaunch = (): void => {
    if (!currentLaunch) return;
    if (currentLaunch.started) throw new Error("Cannot abandon a provider launch after it started");
    currentLaunch.settle(null);
    currentLaunch = null;
  };

  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      clock.clearInterval(timer);
    }
    if (renewalTask) await renewalTask;
  };

  return {
    get authority() { return authority; },
    get held() { return authority.held; },
    get deadline() {
      if (deadline === null) throw new Error("Delivery deadline is unavailable before the deliver phase");
      return deadline;
    },
    enterPhase,
    adoptError: async (error) => {
      await adopt(authorityFor(error));
      return authority.held;
    },
    launch,
    abandonProviderLaunch,
    stopProvider,
    checkpoint,
    close,
  };
};

/** Runs a remote delivery mutation only while this runner still owns the Run. */
export const deliverUnderLease = async <T>(
  lease: Pick<RunLease<object>, "held" | "deadline">,
  deliver: (options: RetryOptions) => Promise<T>,
): Promise<T | null> => lease.held ? deliver({ deadline: lease.deadline }) : null;
