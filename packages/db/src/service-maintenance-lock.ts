/**
 * The service half of the OSS-D maintenance lock (plan Step 3, line 143).
 *
 * `maintenance-lock.ts` describes an asymmetry: maintenance takes the key
 * exclusively, services take it shared. Until both halves exist the asymmetry
 * is a description of nothing — an exclusive lock that nobody contends is
 * always granted, so a release migration would take it while the API is serving
 * the very schema it is about to rewrite, see no holder, and be right by
 * accident. This module is the other half: what an AgentOS service does so that
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
 * lock is re-verified on an interval, and a service that cannot prove it still
 * holds the lock stops serving. It does not try to retake it: retaking races
 * the maintenance session that may already have started, and a supervisor
 * restart re-enters this same acquisition with the same refusal.
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
 * participation. Every AgentOS `DATABASE_URL` names its schema already: the API
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
  /** The backend that took it; a different one means a different session. */
  readonly backendPid: number;
  /**
   * Runs one retention check now, returning whether the lock is still held and
   * firing `onLost` if it is not. The interval calls this; a fixture calls it to
   * avoid sleeping through one.
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
  const lock = acquired.lock;
  log(`${options.service} step=maintenance-lock role=shared result=acquired schema=${lock.schema}`);

  const state = { finished: false, cancel: (): void => undefined };
  const verifyRetention = async (): Promise<boolean> => {
    if (state.finished) return false;
    const held = await lock.verifyStillHeld();
    // `finished` is re-read after the await: a release that happened while the
    // server was answering makes this check's answer irrelevant, and reporting
    // a loss then would shut down a service that is already shutting down.
    if (state.finished) return false;
    if (held) return true;
    state.finished = true;
    state.cancel();
    log(`${options.service} step=maintenance-lock role=shared result=lost`);
    options.onLost(SERVICE_LOCK_LOST_REASON);
    return false;
  };

  state.cancel = (options.schedule ?? defaultSchedule)(
    () => { void verifyRetention(); },
    options.retentionIntervalMs ?? SERVICE_LOCK_RETENTION_INTERVAL_MS,
  );

  return {
    schema: lock.schema,
    backendPid: lock.backendPid,
    verifyRetention,
    release: async (): Promise<void> => {
      const alreadyFinished = state.finished;
      state.finished = true;
      state.cancel();
      await lock.release();
      if (!alreadyFinished) log(`${options.service} step=maintenance-lock role=shared result=released`);
    },
  };
};
