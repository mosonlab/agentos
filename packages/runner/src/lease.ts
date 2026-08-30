import {
  authorityFor as defaultAuthorityFor,
  authorityAfterHeartbeat as defaultAuthorityAfterHeartbeat,
  heartbeat as sendHeartbeat,
  type Authority,
  type CancellationRequest,
  type ControlPlaneRunClaim,
} from "./api.js";
import type { RunnerConfig } from "./config.js";
import { deliveryDeadline, type RetryOptions } from "./network-retry.js";

export type LeaseHeartbeat = typeof sendHeartbeat;

/** The fenced Run identity renewed during delivery. */
export type DeliveryLeaseClaim = ControlPlaneRunClaim;

/**
 * The runner's authority over a run during the phase that follows the agent
 * process: publish, open the pull request, clean up, complete.
 *
 * That phase used to run with nothing renewing the lease, so a delivery that
 * merely took a while was reconciled as LOST while it was still working. It
 * also ran with nothing *checking* the lease, which is the more dangerous half:
 * a 409 means the control plane has taken the run away — reassigned it,
 * suspended it for Inbox, or expired it — and a runner that keeps going pushes
 * to a shared branch and opens a pull request on behalf of a run it no longer
 * owns. Connectivity failures are survivable; a revoked lease is not.
 */
export type DeliveryLease = {
  /** Absolute deadline every external command in the phase draws on. Fixed
   *  when the phase opens: later renewals extend the lease, but they must not
   *  extend how long a hung command may hold the claim. */
  readonly deadline: number;
  /** True once the control plane has answered 409. */
  readonly rejected: boolean;
  /** The 409 was WAITING_INBOX: the run is suspended, not lost. */
  readonly waitingInbox: boolean;
  /** Durable operator cancellation returned by the renewal, when present. */
  readonly cancellation: CancellationRequest | null;
  /** Timestamp of the last renewal known to have landed, measured at *send*. */
  readonly renewedAt: number;
  close: () => void;
};

/**
 * Renew once up front, then keep renewing, and report whether this runner may
 * still act. The opening renewal is awaited so the phase deadline starts from
 * a real renewal instead of a timestamp that may already be half a lease old.
 */
export const openDeliveryLease = async (
  config: RunnerConfig,
  claim: DeliveryLeaseClaim,
  lastKnownRenewalAt: number,
  options: {
    send?: LeaseHeartbeat;
    authorityFor?: (error: unknown) => Authority;
    authorityAfterHeartbeat?: (result: Awaited<ReturnType<LeaseHeartbeat>>) => Authority;
    now?: () => number;
    startedAt?: Date;
  } = {},
): Promise<DeliveryLease> => {
  const send = options.send ?? sendHeartbeat;
  const authorityFor = options.authorityFor ?? defaultAuthorityFor;
  const authorityAfterHeartbeat = options.authorityAfterHeartbeat ?? defaultAuthorityAfterHeartbeat;
  const now = options.now ?? (() => Date.now());
  const startedAt = options.startedAt ?? new Date(now());
  const tool = {
    id: "delivery",
    name: "delivery",
    startedAt: startedAt.toISOString(),
    lastProgressAt: startedAt.toISOString(),
  };
  const state: { renewedAt: number; rejected: boolean; waitingInbox: boolean; cancellation: CancellationRequest | null } = {
    renewedAt: lastKnownRenewalAt, rejected: false, waitingInbox: false, cancellation: null,
  };
  const renew = async (): Promise<void> => {
    // Stamped before the request, not after: the API sets leaseExpiresAt from
    // its own clock at or after this moment, so measuring from the response
    // would silently spend the round trip out of the reserve.
    const sentAt = now();
    try {
      const result = await send(config, claim, {
        // Reads the same way it does in the provisioning heartbeat, where no
        // CLI process exists either: the runner is working this run.
        processAlive: true,
        lastProgressEventAt: startedAt,
        inFlightTool: tool,
      });
      const authority = authorityAfterHeartbeat(result);
      if (!authority.held && authority.reason === "cancelled") {
        state.rejected = true;
        state.cancellation = authority.request;
        return;
      }
      state.renewedAt = sentAt;
    } catch (error: unknown) {
      const authority = authorityFor(error);
      if (!authority.held) {
        state.rejected = true;
        state.waitingInbox = authority.reason === "waiting-inbox";
      } else console.error("Delivery lease renewal failed", error);
    }
  };
  await renew();
  // Derived from the renewal that just landed — or, if it did not, from the
  // last one that did, which is a smaller budget but an honest one.
  const deadline = deliveryDeadline(state.renewedAt, config.leaseSeconds, now());
  const timer = setInterval(() => { void renew(); }, config.heartbeatIntervalMs);
  return {
    deadline,
    get rejected() { return state.rejected; },
    get waitingInbox() { return state.waitingInbox; },
    get cancellation() { return state.cancellation; },
    get renewedAt() { return state.renewedAt; },
    close: () => clearInterval(timer),
  };
};

/**
 * The single seam where both questions about an external delivery command are
 * answered: may this runner still act, and for how long. Routing every remote
 * mutation through here is what keeps "we lost the lease" from being a check
 * one call site can forget.
 */
export const deliverUnderLease = async <T>(
  lease: DeliveryLease,
  deliver: (options: RetryOptions) => Promise<T>,
): Promise<T | null> => lease.rejected ? null : deliver({ deadline: lease.deadline });
