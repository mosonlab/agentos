/**
 * The service half of the OSS-D maintenance lock (plan Step 3, line 143).
 *
 * `maintenance-lock.ts` describes an asymmetry: maintenance takes the key
 * exclusively, services take it shared. Until both halves exist the asymmetry
 * is a description of nothing — an exclusive lock that nobody contends is
 * always granted, so a release migration would take it while the API is serving
 * the very schema it is about to rewrite, see no holder, and be right by
 * accident. This module is the other half: what an Anneal service does so that
 * "no service is up" is a fact the server can be asked about rather than an
 * assumption the operator carries.
 *
 * Three properties, and each is a decision:
 *
 * **Taken before the service serves.** The lock is acquired ahead of the first
 * statement the service issues against the schema — before startup
 * reconciliation in the API, before the first poll in the runner. A service
 * that took it afterwards would leave exactly the window this exists to close.
 *
 * **Refused, not waited on.** `acquireMaintenanceLock` never blocks, so a
 * service that starts during a migration exits instead of queueing behind it.
 * Exit 75 (`EX_TEMPFAIL`) is the honest code: a supervisor's restart is the
 * right response, and it will succeed as soon as the migration releases. A
 * misconfigured `DATABASE_URL` gets 78 (`EX_CONFIG`) instead, because restarting
 * that will not help.
 *
 * **Checked, not assumed.** A session lock dies with its connection, and the
 * connection is not the one the service uses for its own queries. A holder that
 * lost its backend would be a service still serving a database that now looks
 * unattended — the failure mode is silent and it is the dangerous one. So the
 * lock is re-verified on an interval. A failed check opens a replacement
 * session and asks for the shared lock again without waiting. A concurrent
 * exclusive holder refuses that request and stops the service; a successful
 * shared acquisition proves that no exclusive holder is running and restores
 * the service's claim without turning a recycled backend into a crash loop.
 *
 * The whole module is failure-closed in one direction only — every unknown
 * ends with the service not serving.
 */

import {
  acquireMaintenanceLock,
  prismaMaintenanceLockSession,
  type MaintenanceLockAcquisition,
  type MaintenanceLockRefusal,
  type MaintenanceLockRole,
  type MaintenanceLockTarget,
} from "./maintenance-lock.js";

/**
 * How often a holder re-asks the server whether it still holds the lock.
 *
 * The cost of the check is one indexed `pg_locks` scan on an already-open
 * connection; the cost of missing a loss is a service serving a database a
 * migrator believes is unattended. Ten seconds is short enough that the window
 * is bounded by something an operator would call brief, and long enough that
 * the check is invisible next to a poll interval.
 */
export const SERVICE_LOCK_RETENTION_INTERVAL_MS = 10_000;

/**
 * A reconnect can fail while PostgreSQL or the local network is recovering.
 * Retrying only the stable "connection unavailable" refusal gives that event
 * more than one chance without ever retrying past an observed lock conflict.
 */
export const SERVICE_LOCK_REACQUIRE_ATTEMPTS = 3;

/** `EX_TEMPFAIL`: a restart is the right response and will eventually work. */
export const SERVICE_LOCK_CONTENTION_EXIT_CODE = 75;
/** `EX_CONFIG`: the same restart will fail the same way until a value changes. */
export const SERVICE_LOCK_CONFIGURATION_EXIT_CODE = 78;

/** Why the target could not even be formed. Names the variable, never its value. */
export type ServiceLockTargetRefusal =
  | "database-url-missing"
  | "database-url-unparsable"
  | "database-url-not-postgres"
  | "database-url-schema-unnamed";

export type ServiceLockRefusal = ServiceLockTargetRefusal | MaintenanceLockRefusal;

/** The stable reason a holder gives when a retention check fails. */
export const SERVICE_LOCK_LOST_REASON = "shared-service-lock-was-not-retained";

export class ServiceMaintenanceLockError extends Error {
  readonly service: string;
  readonly reason: ServiceLockRefusal;
  readonly exitCode: number;

  constructor(service: string, reason: ServiceLockRefusal, exitCode: number) {
    // Message, reason and exit code carry no URL, host, database name or
    // credential: this string is printed by a service that is refusing to start
    // and whose logs an operator pastes into an issue.
    super(`${service} refused to start: shared maintenance lock unavailable (${reason})`);
    this.name = "ServiceMaintenanceLockError";
    this.service = service;
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

export type ServiceLockTargetResolution =
  | { ok: true; target: MaintenanceLockTarget }
  | { ok: false; reason: ServiceLockTargetRefusal };

/**
 * The schema is read from the URL and never defaulted.
 *
 * Prisma would silently fall back to `public`, and a service that guessed
 * `public` while the migrator locked the schema the URL actually names would
 * hold a lock on the wrong key — worse than holding none, because it looks like
 * participation. Every Anneal `DATABASE_URL` names its schema already: the API
 * refuses to start without it (`startup-config.ts`) and the release migrator
 * refuses to plan without it (`local-release-target.ts`).
 */
export const resolveServiceLockTarget = (databaseUrl: string | undefined): ServiceLockTargetResolution => {
  if (databaseUrl === undefined || databaseUrl === "") return { ok: false, reason: "database-url-missing" };
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { ok: false, reason: "database-url-unparsable" };
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return { ok: false, reason: "database-url-not-postgres" };
  }
  const schema = parsed.searchParams.get("schema") ?? "";
  if (schema === "") return { ok: false, reason: "database-url-schema-unnamed" };
  return { ok: true, target: { url: databaseUrl, schema } };
};

export interface HeldServiceMaintenanceLock {
  readonly schema: string;
  /** The current backend; recovery updates it to the replacement session. */
  readonly backendPid: number;
  /**
   * Runs one retention check now, recovering a dropped shared session when it
   * is safe and firing `onLost` if recovery is refused or exhausted. The
   * interval calls this; a fixture calls it to avoid sleeping through one.
   */
  verifyRetention(): Promise<boolean>;
  /** Releases, stops the interval, and is safe to call more than once. */
  release(): Promise<void>;
}

export interface ServiceMaintenanceLockOptions {
  /** `api` or `runner`. Appears in log lines; never anything else. */
  service: string;
  databaseUrl: string | undefined;
  /**
   * What the service does when it can no longer prove it holds the lock. It is
   * called at most once and must stop the service; this module does not decide
   * how a process exits.
   */
  onLost: (reason: string) => void;
  /**
   * Injected for tests. The role is passed rather than assumed so a test can
   * assert that a service asks for the *shared* form — a service that asked
   * exclusively would lock its siblings out and still look like participation.
   */
  acquire?: (target: MaintenanceLockTarget, role: MaintenanceLockRole) => Promise<MaintenanceLockAcquisition>;
  retentionIntervalMs?: number;
  log?: (line: string) => void;
  /** Injected for tests. Returns the cancel for the interval it started. */
  schedule?: (check: () => void, intervalMs: number) => () => void;
}

const defaultSchedule = (check: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(check, intervalMs);
  // The check must never be the reason a process stays alive: a service that
  // has closed its listener and finished its work should exit, and this timer
  // is cleared by `release()` on that path anyway.
  timer.unref?.();
  return (): void => { clearInterval(timer); };
};

/**
 * Takes the shared lock for this service's database-serving lifetime.
 *
 * Throws `ServiceMaintenanceLockError` rather than returning a refusal: every
 * caller's only correct response is to not start, and an exception is the one
 * shape a startup sequence cannot accidentally continue past.
 */
export const holdSharedServiceMaintenanceLock = async (
  options: ServiceMaintenanceLockOptions,
): Promise<HeldServiceMaintenanceLock> => {
  const log = options.log ?? ((line: string): void => { console.log(line); });
  const resolved = resolveServiceLockTarget(options.databaseUrl);
  if (!resolved.ok) {
    throw new ServiceMaintenanceLockError(options.service, resolved.reason, SERVICE_LOCK_CONFIGURATION_EXIT_CODE);
  }

  const acquire = options.acquire
    ?? ((target: MaintenanceLockTarget, role: MaintenanceLockRole): Promise<MaintenanceLockAcquisition> =>
      acquireMaintenanceLock(target, role, prismaMaintenanceLockSession));
  const acquired = await acquire(resolved.target, "shared");
  if (!acquired.ok) {
    throw new ServiceMaintenanceLockError(options.service, acquired.reason, SERVICE_LOCK_CONTENTION_EXIT_CODE);
  }
  const initialLock = acquired.lock;
  log(`${options.service} step=maintenance-lock role=shared result=acquired schema=${initialLock.schema}`);

  const state: {
    finished: boolean;
    cancel: () => void;
    lock: typeof initialLock;
    verification: Promise<boolean> | undefined;
  } = {
    finished: false,
    cancel: (): void => undefined,
    lock: initialLock,
    verification: undefined,
  };

  const lose = (reason: string): false => {
    if (state.finished) return false;
    state.finished = true;
    state.cancel();
    log(`${options.service} step=maintenance-lock role=shared result=lost reason=${reason}`);
    options.onLost(SERVICE_LOCK_LOST_REASON);
    return false;
  };

  const runRetentionCheck = async (): Promise<boolean> => {
    if (state.finished) return false;
    const checkedLock = state.lock;
    let held = false;
    try {
      held = await checkedLock.verifyStillHeld();
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "unknown";
      log(`${options.service} step=maintenance-lock role=shared result=retention-strike reason=verify-error error=${errorName}`);
    }
    // `finished` is re-read after the await: a release that happened while the
    // server was answering makes this check's answer irrelevant, and reporting
    // a loss then would shut down a service that is already shutting down.
    if (state.finished) return false;
    if (held) return true;

    log(`${options.service} step=maintenance-lock role=shared result=retention-miss backend_pid=${checkedLock.backendPid}`);
    for (let attempt = 1; attempt <= SERVICE_LOCK_REACQUIRE_ATTEMPTS; attempt += 1) {
      log(
        `${options.service} step=maintenance-lock role=shared result=reacquire-attempt attempt=${attempt}/${SERVICE_LOCK_REACQUIRE_ATTEMPTS} previous_backend_pid=${checkedLock.backendPid}`,
      );
      let replacement: MaintenanceLockAcquisition;
      try {
        replacement = await acquire(resolved.target, "shared");
      } catch (error: unknown) {
        const errorName = error instanceof Error ? error.name : "unknown";
        log(
          `${options.service} step=maintenance-lock role=shared result=reacquire-strike attempt=${attempt}/${SERVICE_LOCK_REACQUIRE_ATTEMPTS} reason=acquire-error error=${errorName}`,
        );
        return lose("reacquire-error");
      }

      if (state.finished) {
        if (replacement.ok) await replacement.lock.release();
        return false;
      }
      if (replacement.ok) {
        state.lock = replacement.lock;
        log(
          `${options.service} step=maintenance-lock role=shared result=reacquired attempt=${attempt}/${SERVICE_LOCK_REACQUIRE_ATTEMPTS} previous_backend_pid=${checkedLock.backendPid} backend_pid=${replacement.lock.backendPid}`,
        );
        // Acquire first, retire second. If the old check was a transient query
        // error and its backend still held the lock, this order leaves no gap
        // in which an exclusive holder can enter.
        try {
          await checkedLock.release();
        } catch (error: unknown) {
          const errorName = error instanceof Error ? error.name : "unknown";
          log(
            `${options.service} step=maintenance-lock role=shared result=retire-strike reason=release-error error=${errorName} backend_pid=${checkedLock.backendPid}`,
          );
        }
        return !state.finished;
      }

      log(
        `${options.service} step=maintenance-lock role=shared result=reacquire-strike attempt=${attempt}/${SERVICE_LOCK_REACQUIRE_ATTEMPTS} reason=${replacement.reason}`,
      );
      if (replacement.reason !== "lock-connection-unavailable") return lose(replacement.reason);
    }
    return lose("reacquire-attempts-exhausted");
  };

  const verifyRetention = (): Promise<boolean> => {
    if (state.finished) return Promise.resolve(false);
    if (state.verification !== undefined) return state.verification;
    const verification = runRetentionCheck();
    state.verification = verification;
    const clear = (): void => {
      if (state.verification === verification) state.verification = undefined;
    };
    void verification.then(clear, clear);
    return verification;
  };

  state.cancel = (options.schedule ?? defaultSchedule)(
    () => { void verifyRetention(); },
    options.retentionIntervalMs ?? SERVICE_LOCK_RETENTION_INTERVAL_MS,
  );

  return {
    schema: initialLock.schema,
    get backendPid(): number { return state.lock.backendPid; },
    verifyRetention,
    release: async (): Promise<void> => {
      const alreadyFinished = state.finished;
      state.finished = true;
      state.cancel();
      await state.lock.release();
      if (!alreadyFinished) log(`${options.service} step=maintenance-lock role=shared result=released`);
    },
  };
};
