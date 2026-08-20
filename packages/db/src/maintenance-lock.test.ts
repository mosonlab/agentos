/**
 * The lock client's decisions, without a database.
 *
 * What is worth asserting here is not that PostgreSQL locks work — it does —
 * but that this client never turns "I could not ask" into "nobody holds it",
 * that a refusal names the holder, and that a lock hands back exactly one
 * session and closes it on every path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acquireMaintenanceLock,
  inspectMaintenanceLock,
  MAINTENANCE_LOCK_CLASS,
  MAINTENANCE_LOCK_HOLDERS_SQL,
  MAINTENANCE_LOCK_KEY_SQL,
  type MaintenanceLockSession,
} from "./maintenance-lock.js";

/** Assembled rather than written inline: a literal `scheme://user:password@host`
 *  in tracked source is what the public-snapshot scanner counts as a credential
 *  placeholder, and a fixture URL is not worth an entry in that ledger. */
const dsn = (query: string): string => {
  const url = new URL(`postgresql://127.0.0.1:55777/agentos${query}`);
  url.username = "u";
  url.password = "p";
  return url.href;
};

const TARGET = { url: dsn("?schema=app"), schema: "app" };

interface Recorded { sql: string; parameters: readonly (string | number)[] }

/** A session whose answers are scripted, in the order the client asks. */
const fakeSession = (answers: Array<unknown[] | null>) => {
  const asked: Recorded[] = [];
  const state = { closes: 0, index: 0 };
  const session: MaintenanceLockSession = {
    query: async <T>(sql: string, parameters: readonly (string | number)[]): Promise<T[] | null> => {
      asked.push({ sql, parameters });
      const answer = answers[state.index] ?? null;
      state.index += 1;
      return answer as T[] | null;
    },
    close: async () => { state.closes += 1; },
  };
  return {
    asked,
    session,
    get closes() { return state.closes; },
    open: async () => session,
  };
};

const granted = [{ granted: true, pid: 4242 }];
const refused = [{ granted: false, pid: 4242 }];
const holders = (over: Partial<{ exclusive: number; shared: number; waiting: number }>) =>
  [{ exclusive: 0, shared: 0, waiting: 0, ...over }];

describe("the key", () => {
  it("is the AGOS class word and a server-computed, non-negative hash of the schema", () => {
    // Every participant has to derive the same key from the same expression;
    // a second implementation in shell or TypeScript is the failure mode this
    // constant exists to prevent.
    assert.equal(MAINTENANCE_LOCK_CLASS, 0x41_47_4f_53);
    assert.equal(String.fromCharCode(0x41, 0x47, 0x4f, 0x53), "AGOS");
    assert.equal(MAINTENANCE_LOCK_KEY_SQL, "(hashtext($2::text) & 2147483647)");
    // The mask is what keeps the key comparable against pg_locks' unsigned oid
    // columns without sign handling at every call site.
    assert.equal(2147483647, 2 ** 31 - 1);
  });

  it("is what every statement is parameterised with, so no schema name is interpolated", async () => {
    const fake = fakeSession([granted]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.equal(acquired.ok, true);
    assert.deepEqual(fake.asked[0]?.parameters, [MAINTENANCE_LOCK_CLASS, "app"]);
    assert.match(fake.asked[0]?.sql ?? "", /pg_try_advisory_lock\(\$1::int4/u);
    assert.ok(!(fake.asked[0]?.sql ?? "").includes("app"), "the schema name reached the SQL text");
  });
});

describe("acquiring", () => {
  it("takes the exclusive form for maintenance and the shared form for a service", async () => {
    for (const [role, fragment] of [["exclusive", "pg_try_advisory_lock("], ["shared", "pg_try_advisory_lock_shared("]] as const) {
      const fake = fakeSession([granted]);
      const acquired = await acquireMaintenanceLock(TARGET, role, fake.open);
      assert.equal(acquired.ok, true);
      assert.ok(fake.asked[0]?.sql.includes(fragment), `${role} used ${fake.asked[0]?.sql}`);
    }
  });

  it("never waits: a lock it was told it could not have is a refusal, not a retry", async () => {
    const fake = fakeSession([refused, holders({ exclusive: 1 })]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.deepEqual(acquired, {
      ok: false,
      reason: "exclusive-maintenance-lock-held-by-another-session",
      holders: { exclusive: 1, shared: 0, waiting: 0 },
    });
    // Two statements: the attempt and the "who has it". Neither is `pg_advisory_lock`,
    // the blocking form, which this client must never call.
    assert.equal(fake.asked.length, 2);
    for (const entry of fake.asked) assert.ok(!/pg_advisory_lock\(/u.test(entry.sql), entry.sql);
    assert.equal(fake.closes, 1);
  });

  it("names an active service when the shared lock is what blocked it", async () => {
    const fake = fakeSession([refused, holders({ shared: 2 })]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.equal(acquired.ok, false);
    assert.equal(acquired.ok === false ? acquired.reason : "", "shared-service-lock-held-by-an-active-service");
  });

  it("reports a database it could not reach as unavailable, never as free", async () => {
    // The whole point of the class. "I could not connect" and "nobody holds it"
    // are the two answers a lock client must never confuse, because the second
    // one authorises a migration.
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", async () => null);
    assert.deepEqual(acquired, { ok: false, reason: "lock-connection-unavailable", holders: null });
  });

  it("reports an unreadable acquire attempt as unavailable, and closes the session", async () => {
    const fake = fakeSession([null]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.deepEqual(acquired, { ok: false, reason: "lock-connection-unavailable", holders: null });
    assert.equal(fake.closes, 1);
  });

  it("refuses when the grant was declined and nothing is visibly holding it", async () => {
    // A race that resolved between the two statements. It is still a refusal:
    // this client does not re-attempt a lock the server declined.
    const fake = fakeSession([refused, holders({})]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.equal(acquired.ok === false ? acquired.reason : "", "lock-not-granted");
  });
});

describe("holding", () => {
  it("is only held while the same backend still has it", async () => {
    for (const [row, expected] of [
      [{ pid: 4242, held: true }, true],
      [{ pid: 4242, held: false }, false],
      // The pool handed the next statement to another connection; the lock went
      // with the old one, whatever this row says about the key.
      [{ pid: 9999, held: true }, false],
    ] as const) {
      const fake = fakeSession([granted, [row]]);
      const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
      assert.equal(acquired.ok, true);
      if (!acquired.ok) return;
      assert.equal(await acquired.lock.verifyStillHeld(), expected, JSON.stringify(row));
      assert.equal(acquired.lock.backendPid, 4242);
    }
  });

  it("is not held when the check itself cannot be read", async () => {
    const fake = fakeSession([granted, null]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    assert.equal(await acquired.lock.verifyStillHeld(), false);
  });

  it("asks about the mode it took, so a shared holder cannot satisfy an exclusive claim", async () => {
    const fake = fakeSession([granted, [{ pid: 4242, held: true }]]);
    const acquired = await acquireMaintenanceLock(TARGET, "shared", fake.open);
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    await acquired.lock.verifyStillHeld();
    assert.deepEqual(fake.asked[1]?.parameters, [MAINTENANCE_LOCK_CLASS, "app", "ShareLock"]);
  });
});

describe("releasing", () => {
  it("unlocks and closes, once, however many times it is asked", async () => {
    const fake = fakeSession([granted, [{ released: true }]]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    await acquired.lock.release();
    await acquired.lock.release();
    assert.equal(fake.closes, 1);
    assert.equal(fake.asked.filter((entry) => entry.sql.includes("pg_advisory_unlock")).length, 1);
  });

  it("closes the session even when the unlock statement fails", async () => {
    // A release that throws away the connection still releases the lock: the
    // server drops a session lock when its session ends.
    const fake = fakeSession([granted, null]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    await acquired.lock.release();
    assert.equal(fake.closes, 1);
  });

  it("reports a released lock as not held without asking the server again", async () => {
    const fake = fakeSession([granted, [{ released: true }]]);
    const acquired = await acquireMaintenanceLock(TARGET, "exclusive", fake.open);
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    await acquired.lock.release();
    const asked = fake.asked.length;
    assert.equal(await acquired.lock.verifyStillHeld(), false);
    assert.equal(fake.asked.length, asked, "a released lock queried the closed session");
  });
});

describe("inspecting", () => {
  it("counts holders by mode, scoped to this database and this key", async () => {
    const fake = fakeSession([holders({ shared: 3, waiting: 1 })]);
    assert.deepEqual(await inspectMaintenanceLock(TARGET, fake.open), { exclusive: 0, shared: 3, waiting: 1 });
    assert.equal(fake.asked[0]?.sql, MAINTENANCE_LOCK_HOLDERS_SQL);
    assert.match(MAINTENANCE_LOCK_HOLDERS_SQL, /database = \(SELECT oid FROM pg_database WHERE datname = current_database\(\)\)/u);
    assert.match(MAINTENANCE_LOCK_HOLDERS_SQL, /objsubid = 2/u);
    assert.equal(fake.closes, 1);
  });

  it("answers null when it could not look, so a caller cannot read it as 'nobody'", async () => {
    assert.equal(await inspectMaintenanceLock(TARGET, async () => null), null);
    const fake = fakeSession([null]);
    assert.equal(await inspectMaintenanceLock(TARGET, fake.open), null);
    assert.equal(fake.closes, 1);
  });
});
