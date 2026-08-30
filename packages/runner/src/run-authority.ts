import type { Authority, CancellationRequest } from "./api.js";

export type RunAuthorityState = "held" | "revoked" | "waiting-inbox" | "cancelled";

type ProviderStopResult = { processAlive: boolean };

export type RunAuthorityOptions<ProviderHandle extends object> = {
  stopProvider: (handle: ProviderHandle, reason: string) => Promise<ProviderStopResult>;
  acknowledgeCancellation: (request: CancellationRequest) => Promise<void>;
  onRevocationStopError?: (error: unknown) => void;
};

export type RunAuthority<ProviderHandle extends object> = {
  readonly state: RunAuthorityState;
  readonly held: boolean;
  adopt: (authority: Authority) => Promise<void>;
  launch: (start: () => Promise<ProviderHandle>) => Promise<ProviderHandle | null>;
  abandonProviderLaunch: () => void;
  stopProvider: (handle: ProviderHandle, reason: string) => Promise<void>;
  checkpoint: () => Promise<RunAuthorityState>;
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

const stopReason = (state: Exclude<RunAuthorityState, "held" | "cancelled">): string =>
  state === "waiting-inbox" ? "waiting for Inbox reply" : "fencing token rejected";

/**
 * Owns the Run's authority over every provider launch. A cancellation ACK is
 * emitted only after the current launch can no longer produce an undrained
 * process group.
 */
export const createRunAuthority = <ProviderHandle extends object>(
  options: RunAuthorityOptions<ProviderHandle>,
): RunAuthority<ProviderHandle> => {
  let state: RunAuthorityState = "held";
  let currentProvider: ProviderHandle | null = null;
  // The initial slot spans provisioning: until the runner either launches or
  // abandons it, a provider process could still appear.
  let currentLaunch: LaunchSlot<ProviderHandle> | null = launchSlot();
  const providerStops = new WeakMap<ProviderHandle, Promise<void>>();
  const pendingTransitions = new Set<Promise<void>>();
  let cancellationTask: Promise<void> | null = null;

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

  const adopt = (authority: Authority): Promise<void> => {
    if (authority.held) return Promise.resolve();
    if (state === "cancelled") return cancellationTask ?? Promise.resolve();

    if (authority.reason === "cancelled") {
      state = "cancelled";
      cancellationTask ??= track((async () => {
        await stopCurrentProvider(authority.request.reason);
        await options.acknowledgeCancellation(authority.request);
      })());
      return cancellationTask;
    }

    if (state === "held" || (state === "revoked" && authority.reason === "waiting-inbox")) {
      state = authority.reason;
    }
    const revokedState = state === "waiting-inbox" ? "waiting-inbox" : "revoked";
    return track(stopCurrentProvider(stopReason(revokedState)).catch((error: unknown) => {
      if (!options.onRevocationStopError) throw error;
      options.onRevocationStopError(error);
    }));
  };

  const launch = async (start: () => Promise<ProviderHandle>): Promise<ProviderHandle | null> => {
    if (state !== "held") {
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

    if (state !== "held") {
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

  const checkpoint = async (): Promise<RunAuthorityState> => {
    if (cancellationTask) await cancellationTask;
    while (pendingTransitions.size > 0) await Promise.all(pendingTransitions);
    return state;
  };

  return {
    get state() { return state; },
    get held() { return state === "held"; },
    adopt,
    launch,
    abandonProviderLaunch,
    stopProvider,
    checkpoint,
  };
};
