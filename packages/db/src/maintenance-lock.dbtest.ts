/**
 * The maintenance lock against a real PostgreSQL.
 *
 * The unit tests say what the client decides; only a server can say whether the
 * decisions are about anything. Everything here is a claim that needs two live
 * sessions to be worth making: that an exclusive holder excludes, that services
 * exclude a migration, that services do not exclude each other, that releasing
 * frees it, and that a lock on one schema is not a lock on another.
 *
 * Requires a scratch server. It takes and releases advisory locks only; it
 * creates no object and drops nothing.
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @agentos/db
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";

import {
  acquireMaintenanceLock,
  type HeldMaintenanceLock,
  inspectMaintenanceLock,
  prismaMaintenanceLockSession,
} from "./maintenance-lock.js";

/** 5432 is where docker-compose.yml puts the operator's database. */
const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

const server = scratchServer();
const token = randomBytes(4).toString("hex");

const targetFor = (name: string): { url: string; schema: string } => {
  const schema = `maintlock_${name}_${token}`;
  const url = new URL(server.href);
  url.searchParams.set("schema", schema);
  return { url: url.href, schema };
};

/** Every lock this file takes, so a failing assertion cannot leave one held. */
const held: HeldMaintenanceLock[] = [];
const take = async (target: { url: string; schema: string }, role: "exclusive" | "shared") => {
  const acquired = await acquireMaintenanceLock(target, role, prismaMaintenanceLockSession);
  if (acquired.ok) held.push(acquired.lock);
  return acquired;
};

after(async () => {
  for (const lock of held) await lock.release();
});

describe("holding", () => {
  const target = targetFor("hold");

  it("is granted on a free key, and the server agrees it is held", async () => {
    const acquired = await take(target, "exclusive");
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    if (!acquired.ok) return;
    assert.equal(acquired.lock.role, "exclusive");
    assert.ok(acquired.lock.backendPid > 0);
    // Not "the call returned true" — the lock is visible in pg_locks, on this
    // backend, under this key.
    assert.equal(await acquired.lock.verifyStillHeld(), true);
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 1,
      shared: 0,
      waiting: 0,
    });
  });

  it("is not a lock on a different schema", async () => {
    // The key names the schema. Two AgentOS schemas in one database are
    // maintained independently, and a migration on one must not be blocked by
    // a service on the other.
    const other = targetFor("hold-other");
    assert.deepEqual(await inspectMaintenanceLock(other, prismaMaintenanceLockSession), {
      exclusive: 0,
      shared: 0,
      waiting: 0,
    });
    const acquired = await take(other, "exclusive");
    assert.equal(acquired.ok, true);
  });
});

describe("contention", () => {
  it("refuses a second exclusive holder, and says which kind of holder has it", async () => {
    const target = targetFor("exclusive-vs-exclusive");
    const first = await take(target, "exclusive");
    assert.equal(first.ok, true);

    const second = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.deepEqual(second, {
      ok: false,
      reason: "exclusive-maintenance-lock-held-by-another-session",
      holders: { exclusive: 1, shared: 0, waiting: 0 },
    });
    // It refused rather than waited: a blocking acquire would still be sitting
    // here, and this assertion is the proof it returned.
    if (first.ok) assert.equal(await first.lock.verifyStillHeld(), true);
  });

  it("refuses a migration while a service holds the shared lock", async () => {
    // The plan's rule, on a real server: `--fresh` refuses if a service holds
    // the shared lock. Two services, to prove the count is the holder count and
    // not a boolean.
    const target = targetFor("shared-blocks-exclusive");
    assert.equal((await take(target, "shared")).ok, true);
    assert.equal((await take(target, "shared")).ok, true);

    const migration = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.deepEqual(migration, {
      ok: false,
      reason: "shared-service-lock-held-by-an-active-service",
      holders: { exclusive: 0, shared: 2, waiting: 0 },
    });
  });

  it("lets services run alongside each other, because they do not exclude each other", async () => {
    const target = targetFor("shared-vs-shared");
    assert.equal((await take(target, "shared")).ok, true);
    assert.equal((await take(target, "shared")).ok, true);
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0,
      shared: 2,
      waiting: 0,
    });
  });

  it("refuses a service that starts while a migration is running", async () => {
    // The other direction, which is what makes the lock a real interface rather
    // than a migrator-only convention: an API told it cannot have the shared
    // lock must not serve the database.
    const target = targetFor("exclusive-blocks-shared");
    assert.equal((await take(target, "exclusive")).ok, true);
    const service = await acquireMaintenanceLock(target, "shared", prismaMaintenanceLockSession);
    assert.deepEqual(service, {
      ok: false,
      reason: "exclusive-maintenance-lock-held-by-another-session",
      holders: { exclusive: 1, shared: 0, waiting: 0 },
    });
  });
});

describe("releasing", () => {
  it("frees the key for the next holder, and stops claiming to hold it", async () => {
    const target = targetFor("release");
    const first = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(first.ok, true);
    if (!first.ok) return;

    await first.lock.release();
    assert.equal(await first.lock.verifyStillHeld(), false);
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0,
      shared: 0,
      waiting: 0,
    });

    const next = await take(target, "exclusive");
    assert.equal(next.ok, true, "the released key did not become available");
  });

  it("frees one service's hold without freeing the other's", async () => {
    const target = targetFor("release-shared");
    const first = await acquireMaintenanceLock(target, "shared", prismaMaintenanceLockSession);
    assert.equal(first.ok, true);
    assert.equal((await take(target, "shared")).ok, true);
    if (!first.ok) return;

    await first.lock.release();
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0,
      shared: 1,
      waiting: 0,
    });
    // One service still up, so a migration still refuses.
    const migration = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(migration.ok, false);
  });

  it("is what ends a session's lock, so a dropped connection cannot leave one behind", async () => {
    // The property that makes this an advisory lock and not a row: nothing to
    // clean up by hand after a killed migrator.
    const target = targetFor("session-scoped");
    const first = await acquireMaintenanceLock(target, "exclusive", prismaMaintenanceLockSession);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await first.lock.release();
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0,
      shared: 0,
      waiting: 0,
    });
  });
});

describe("a lock whose backend is terminated", () => {
  it("stops being held while its holder is still running, and says so when asked", async () => {
    // The #164 review's second finding, at the level of the server. A release
    // migration holds this lock on one connection and mutates on another; if
    // the lock's backend dies mid-migration, PostgreSQL frees the key
    // immediately and tells nobody. The migrator that verified once before the
    // first command would keep writing, and a service or a second migrator
    // could take the key it no longer has. So: the loss is detectable, and it
    // is detectable through the same call the migrator makes between commands.
    const target = targetFor("terminated");
    const acquired = await take(target, "exclusive");
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    if (!acquired.ok) return;
    assert.equal(await acquired.lock.verifyStillHeld(), true);

    const executioner = await prismaMaintenanceLockSession(target.url);
    assert.notEqual(executioner, null);
    if (executioner === null) return;
    try {
      await executioner.query("SELECT pg_terminate_backend($1::int4) AS terminated", [acquired.lock.backendPid]);
    } finally {
      await executioner.close();
    }

    assert.equal(
      await acquired.lock.verifyStillHeld(), false,
      "a holder whose backend is gone must not report that it still holds the key",
    );
    assert.deepEqual(await inspectMaintenanceLock(target, prismaMaintenanceLockSession), {
      exclusive: 0,
      shared: 0,
      waiting: 0,
    });
    // And the window is real: the key is immediately available to exactly the
    // participant the lock was supposed to exclude.
    const service = await take(target, "shared");
    assert.equal(service.ok, true, "the freed key is takeable, which is what makes the undetected loss dangerous");
  });
});
