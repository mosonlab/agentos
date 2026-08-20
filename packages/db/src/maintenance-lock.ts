/**
 * The OSS-D maintenance lock: one advisory lock that says "this database's
 * schema is being maintained, stand off".
 *
 * Two shapes of participant, and the asymmetry is the whole point:
 *
 *   - **Shared** — every process that serves the database while it is up. The
 *     API and the runner take this for their database-serving lifetime. Any
 *     number of them may hold it at once; they do not exclude each other.
 *   - **Exclusive** — every process that changes the schema underneath those
 *     services. `db:migrate:release` takes it for the length of a release
 *     migration, and the OSS-D backup takes it for the length of a dump.
 *
 * PostgreSQL's advisory locks give this for free and give it *honestly*: the
 * lock lives in the server, not in a file or a flag, so it cannot survive the
 * process that took it. A migrator that is killed does not leave a lock behind
 * for an operator to discover and clear by hand — the session ends, the lock
 * ends. That property is why this is an advisory lock and not a row.
 *
 * ## What the key names
 *
 * Advisory locks are scoped to a *database*, and their keys are two 32-bit
 * integers with no namespace of their own. So the key here is
 * `(MAINTENANCE_LOCK_CLASS, hash(schema))`:
 *
 *   - the class constant is the ASCII of `AGOS`, so an unrelated application
 *     taking advisory locks in the same database cannot collide with AgentOS
 *     by picking a small integer;
 *   - the second word names the *schema*, because that is what a release
 *     migration targets and what the services read. Two AgentOS schemas in one
 *     database may be maintained independently, which is correct.
 *
 * A consumer whose unit of work is the whole database rather than one schema —
 * the OSS-D backup dumps a database, not a schema — must therefore hold the
 * lock for every AgentOS schema it covers. In the Compose model this plan
 * targets that is exactly one, but it is a real obligation and not an
 * accident, so it is written down here rather than assumed.
 *
 * The hash is computed by the *server*, in `MAINTENANCE_LOCK_KEY_SQL`, so a
 * shell caller and a TypeScript caller derive the same key from the same
 * expression rather than from two implementations that must be kept equal.
 * `hashtext` is an internal function whose value is not guaranteed stable
 * across major versions; that does not matter here, because every participant
 * computes the key on the same server at the same moment and no advisory lock
 * outlives a session. The mask keeps the result non-negative so the key can be
 * compared against `pg_locks`' unsigned `oid` columns without sign games.
 *
 * ## What "held" means
 *
 * A session lock is only as durable as its connection, and a connection pool
 * that quietly recycles a connection would drop the lock without telling
 * anyone. So a held lock here records the backend pid that took it, and
 * `verifyStillHeld()` re-asks the server whether *that* pid still holds *that*
 * key. Callers with a mutating step to protect are expected to ask again
 * immediately before it. This turns an assumption about pool internals into a
 * checked property, which is the only form of it worth having.
 */

export const MAINTENANCE_LOCK_CLASS = 0x41_47_4f_53; // "AGOS"

/**
 * The one definition of the second key word. Every participant — this client,
 * the OSS-D backup script, any future consumer — must derive the key with this
 * expression against the same server.
 */
export const MAINTENANCE_LOCK_KEY_SQL = "(hashtext($2::text) & 2147483647)";

const LOCK_MODE = { exclusive: "ExclusiveLock", shared: "ShareLock" } as const;

const ACQUIRE_SQL = {
  exclusive: `SELECT pg_try_advisory_lock($1::int4, ${MAINTENANCE_LOCK_KEY_SQL}::int4) AS granted, pg_backend_pid() AS pid`,
  shared: `SELECT pg_try_advisory_lock_shared($1::int4, ${MAINTENANCE_LOCK_KEY_SQL}::int4) AS granted, pg_backend_pid() AS pid`,
} as const;

const RELEASE_SQL = {
  exclusive: `SELECT pg_advisory_unlock($1::int4, ${MAINTENANCE_LOCK_KEY_SQL}::int4) AS released`,
  shared: `SELECT pg_advisory_unlock_shared($1::int4, ${MAINTENANCE_LOCK_KEY_SQL}::int4) AS released`,
} as const;

/**
 * Every holder of this key in this database, by mode. `pg_locks` is filtered to
 * the current database because advisory locks are per-database while the view
 * is not, and to `objsubid = 2` because that is how PostgreSQL marks the
 * two-integer key form.
 */
export const MAINTENANCE_LOCK_HOLDERS_SQL = `
  SELECT
    count(*) FILTER (WHERE granted AND mode = 'ExclusiveLock')::int4 AS exclusive,
    count(*) FILTER (WHERE granted AND mode = 'ShareLock')::int4 AS shared,
    count(*) FILTER (WHERE NOT granted)::int4 AS waiting
  FROM pg_locks
  WHERE locktype = 'advisory'
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND classid = $1::oid
    AND objid = ${MAINTENANCE_LOCK_KEY_SQL}::oid
    AND objsubid = 2
`;

const HELD_BY_THIS_SESSION_SQL = `
  SELECT
    pg_backend_pid() AS pid,
    EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = $1::oid
        AND objid = ${MAINTENANCE_LOCK_KEY_SQL}::oid
        AND objsubid = 2
        AND granted
        AND mode = $3::text
        AND pid = pg_backend_pid()
    ) AS held
`;

export type MaintenanceLockRole = "exclusive" | "shared";

/** The target a lock is taken on: a connectable URL and the schema it names. */
export interface MaintenanceLockTarget {
  url: string;
  schema: string;
}

/** Who holds this key right now, counted by mode. */
export interface MaintenanceLockHolders {
  exclusive: number;
  shared: number;
  waiting: number;
}

/**
 * Stable refusal reasons. They are the caller's stop text, so they name what
 * the operator has to do something about — a service that is up, another
 * maintenance session, or a database that could not be reached — rather than
 * repeating driver prose.
 */
export type MaintenanceLockRefusal =
  | "lock-connection-unavailable"
  | "exclusive-maintenance-lock-held-by-another-session"
  | "shared-service-lock-held-by-an-active-service"
  | "lock-not-granted";

export interface HeldMaintenanceLock {
  readonly role: MaintenanceLockRole;
  readonly schema: string;
  /** The backend that took it. A different pid means a different session. */
  readonly backendPid: number;
  /** Re-asks the server whether this session still holds this key. */
  verifyStillHeld(): Promise<boolean>;
  /** Releases and closes the session. Safe to call more than once. */
  release(): Promise<void>;
}

export type MaintenanceLockAcquisition =
  | { ok: true; lock: HeldMaintenanceLock }
  | { ok: false; reason: MaintenanceLockRefusal; holders: MaintenanceLockHolders | null };

/**
 * One connection, for the lifetime of one lock. Injected so the refusals can be
 * tested without a database and so the concrete driver stays replaceable.
 * `query` must return `null` rather than throw: a lock client that turns a
 * driver error into an exception invites a caller to catch it and continue.
 */
export interface MaintenanceLockSession {
  query<T>(sql: string, parameters: readonly (string | number)[]): Promise<T[] | null>;
  close(): Promise<void>;
}

export type MaintenanceLockSessionFactory = (url: string) => Promise<MaintenanceLockSession | null>;

const holdersFrom = (rows: Array<Record<string, unknown>> | null): MaintenanceLockHolders | null => {
  const row = rows?.[0];
  if (!row) return null;
  const count = (value: unknown): number => (typeof value === "bigint" ? Number(value) : Number(value ?? 0));
  return { exclusive: count(row["exclusive"]), shared: count(row["shared"]), waiting: count(row["waiting"]) };
};

/**
 * Reads the lock's current holders without taking it. This is what `--existing`
 * uses to state the lock situation before it decides anything, and what a
 * refusal uses to say *which* kind of holder stood in the way.
 */
export const inspectMaintenanceLock = async (
  target: MaintenanceLockTarget,
  openSession: MaintenanceLockSessionFactory,
): Promise<MaintenanceLockHolders | null> => {
  const session = await openSession(target.url);
  if (session === null) return null;
  try {
    return holdersFrom(await session.query<Record<string, unknown>>(
      MAINTENANCE_LOCK_HOLDERS_SQL,
      [MAINTENANCE_LOCK_CLASS, target.schema],
    ));
  } finally {
    await session.close();
  }
};

/**
 * Takes the lock, or says why it could not, and never waits.
 *
 * Non-blocking is deliberate. A release migration that blocks on a lock held by
 * a running API sits there until someone notices; one that refuses immediately
 * names the holder and hands the decision back to the operator, which is the
 * fail-closed behaviour every other precondition in this command has.
 */
export const acquireMaintenanceLock = async (
  target: MaintenanceLockTarget,
  role: MaintenanceLockRole,
  openSession: MaintenanceLockSessionFactory,
): Promise<MaintenanceLockAcquisition> => {
  const session = await openSession(target.url);
  if (session === null) return { ok: false, reason: "lock-connection-unavailable", holders: null };

  const parameters = [MAINTENANCE_LOCK_CLASS, target.schema] as const;
  const acquired = await session.query<{ granted: boolean; pid: number }>(ACQUIRE_SQL[role], parameters);
  const row = acquired?.[0];
  if (!row || row.granted !== true) {
    // Ask who is in the way *before* closing, so the refusal can name a service
    // rather than a generic contention. A holders read that itself fails leaves
    // `holders` null and the generic reason, which is still a refusal.
    const holders = row
      ? holdersFrom(await session.query<Record<string, unknown>>(MAINTENANCE_LOCK_HOLDERS_SQL, parameters))
      : null;
    await session.close();
    if (holders === null) return { ok: false, reason: row ? "lock-not-granted" : "lock-connection-unavailable", holders: null };
    if (holders.exclusive > 0) {
      return { ok: false, reason: "exclusive-maintenance-lock-held-by-another-session", holders };
    }
    if (holders.shared > 0) return { ok: false, reason: "shared-service-lock-held-by-an-active-service", holders };
    // Refused with nothing visible holding it: a race that resolved between the
    // two statements. Still a refusal — this client never retries a lock it was
    // told it could not have.
    return { ok: false, reason: "lock-not-granted", holders };
  }

  const backendPid = Number(row.pid);
  let released = false;
  const lock: HeldMaintenanceLock = {
    role,
    schema: target.schema,
    backendPid,
    verifyStillHeld: async (): Promise<boolean> => {
      if (released) return false;
      const rows = await session.query<{ pid: number; held: boolean }>(
        HELD_BY_THIS_SESSION_SQL,
        [MAINTENANCE_LOCK_CLASS, target.schema, LOCK_MODE[role]],
      );
      const check = rows?.[0];
      // A different pid means the pool handed us another connection, and the
      // lock went with the old one. Unreadable means we cannot say it is held,
      // which is the same answer.
      return check !== undefined && check.held === true && Number(check.pid) === backendPid;
    },
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      try {
        await session.query(RELEASE_SQL[role], parameters);
      } finally {
        await session.close();
      }
    },
  };
  return { ok: true, lock };
};

/**
 * The concrete session: one PrismaClient pinned to a single connection.
 *
 * `connection_limit=1` is not a performance choice. A session advisory lock
 * belongs to the backend that took it, so a pool free to hand the next
 * statement to a second connection would report a lock that is not there. One
 * connection makes "the session" a well-defined thing; `verifyStillHeld()`
 * checks the claim anyway, because a pool is still free to reconnect.
 *
 * Driver errors become `null` rather than exceptions. Raw driver text can carry
 * the URL and is never returned to a caller that might print it.
 */
export const prismaMaintenanceLockSession: MaintenanceLockSessionFactory = async (url) => {
  const { PrismaClient } = await import("@prisma/client");
  const pinned = new URL(url);
  pinned.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: pinned.href } } });
  try {
    await db.$connect();
  } catch {
    await db.$disconnect().catch(() => undefined);
    return null;
  }
  return {
    query: async <T>(sql: string, parameters: readonly (string | number)[]): Promise<T[] | null> => {
      try {
        return await db.$queryRawUnsafe<T[]>(sql, ...parameters);
      } catch {
        return null;
      }
    },
    close: async (): Promise<void> => {
      await db.$disconnect().catch(() => undefined);
    },
  };
};
