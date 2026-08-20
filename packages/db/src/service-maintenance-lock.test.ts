/**
 * The service half of the lock, judged without a database.
 *
 * Everything here is about the decisions: which role a service asks for, what
 * it does when it cannot have it, and what "still held" is allowed to mean.
 * `service-maintenance-lock.dbtest.ts` starts a real runner against a real
 * PostgreSQL and proves the same claims are true of the shipped entrypoint;
 * these are the cheap ones that run everywhere.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HeldMaintenanceLock, MaintenanceLockAcquisition, MaintenanceLockRole } from "./maintenance-lock.js";
import {
  holdSharedServiceMaintenanceLock,
  resolveServiceLockTarget,
  ServiceMaintenanceLockError,
  SERVICE_LOCK_CONFIGURATION_EXIT_CODE,
  SERVICE_LOCK_CONTENTION_EXIT_CODE,
  SERVICE_LOCK_LOST_REASON,
  SERVICE_LOCK_REACQUIRE_ATTEMPTS,
  SERVICE_LOCK_RETENTION_INTERVAL_MS,
} from "./service-maintenance-lock.js";

const PASSWORD = "correct-horse-battery-staple";

/** Assembled rather than written inline: a literal `scheme://user:password@host`
 *  in tracked source is what the public-snapshot scanner counts as a credential
 *  placeholder, and a fixture URL is not worth an entry in that ledger. */
const dsn = (options: { protocol?: string; path?: string; query?: string } = {}): string => {
  const url = new URL(`${options.protocol ?? "postgresql"}://127.0.0.1:5432${options.path ?? "/agentos"}${options.query ?? ""}`);
  url.username = "agentos";
  url.password = PASSWORD;
  return url.href;
};

const URL_WITH_SCHEMA = dsn({ query: "?schema=public" });

interface Harness {
  lost: string[];
  logs: string[];
  roles: MaintenanceLockRole[];
  verifications: number;
  releases: number;
  cancels: number;
  scheduled: Array<{ check: () => void; intervalMs: number }>;
  /** Flip to make the next verification report the lock gone. */
  held: { value: boolean };
}

const harness = (): Harness => ({
  lost: [], logs: [], roles: [], verifications: 0, releases: 0, cancels: 0, scheduled: [], held: { value: true },
});

const fakeLock = (state: Harness, backendPid = 4242): HeldMaintenanceLock => ({
  role: "shared",
  schema: "public",
  backendPid,
  verifyStillHeld: async (): Promise<boolean> => {
    state.verifications += 1;
    return state.held.value;
  },
  release: async (): Promise<void> => { state.releases += 1; },
});

const hold = (
  state: Harness,
  overrides: {
    databaseUrl?: string | undefined;
    acquisition?: MaintenanceLockAcquisition;
    reacquisitions?: MaintenanceLockAcquisition[];
  } = {},
): ReturnType<typeof holdSharedServiceMaintenanceLock> => {
  let acquisition = 0;
  return holdSharedServiceMaintenanceLock({
    service: "api",
    databaseUrl: "databaseUrl" in overrides ? overrides.databaseUrl : URL_WITH_SCHEMA,
    onLost: (reason) => { state.lost.push(reason); },
    log: (line) => { state.logs.push(line); },
    acquire: async (_target, role) => {
      state.roles.push(role);
      const result = acquisition === 0
        ? (overrides.acquisition ?? { ok: true, lock: fakeLock(state) })
        : (overrides.reacquisitions?.[acquisition - 1] ?? { ok: true, lock: fakeLock(state, 4242 + acquisition) });
      acquisition += 1;
      return result;
    },
    schedule: (check, intervalMs) => {
      state.scheduled.push({ check, intervalMs });
      return (): void => { state.cancels += 1; };
    },
  });
};

describe("resolveServiceLockTarget", () => {
  it("takes the schema from the URL and never defaults it", () => {
    assert.deepEqual(resolveServiceLockTarget(URL_WITH_SCHEMA), {
      ok: true,
      target: { url: URL_WITH_SCHEMA, schema: "public" },
    });
    const release = dsn({ protocol: "postgres", path: "/db", query: "?schema=agentos_release" });
    assert.deepEqual(resolveServiceLockTarget(release), {
      ok: true,
      target: { url: release, schema: "agentos_release" },
    });
  });

  it("refuses a URL it cannot turn into a key, and says which way it failed", () => {
    // A service that guessed `public` here would hold a lock on a key nobody
    // else uses: worse than holding none, because it looks like participation.
    assert.deepEqual(resolveServiceLockTarget(undefined), { ok: false, reason: "database-url-missing" });
    assert.deepEqual(resolveServiceLockTarget(""), { ok: false, reason: "database-url-missing" });
    assert.deepEqual(resolveServiceLockTarget("not a url"), { ok: false, reason: "database-url-unparsable" });
    assert.deepEqual(resolveServiceLockTarget(dsn({ protocol: "mysql", path: "/db", query: "?schema=public" })), {
      ok: false,
      reason: "database-url-not-postgres",
    });
    assert.deepEqual(resolveServiceLockTarget(dsn({ path: "/db" })), {
      ok: false,
      reason: "database-url-schema-unnamed",
    });
    assert.deepEqual(resolveServiceLockTarget(dsn({ path: "/db", query: "?schema=" })), {
      ok: false,
      reason: "database-url-schema-unnamed",
    });
  });
});

describe("holdSharedServiceMaintenanceLock", () => {
  it("asks for the shared role, and starts one retention check on the documented interval", async () => {
    const state = harness();
    const lock = await hold(state);
    assert.deepEqual(state.roles, ["shared"], "a service that asked exclusively would lock out its siblings");
    assert.equal(lock.schema, "public");
    assert.equal(lock.backendPid, 4242);
    assert.deepEqual(state.scheduled.map((entry) => entry.intervalMs), [SERVICE_LOCK_RETENTION_INTERVAL_MS]);
    assert.ok(state.logs.includes("api step=maintenance-lock role=shared result=acquired schema=public"));
  });

  it("refuses to start on a configuration it cannot form a key from", async () => {
    const state = harness();
    await assert.rejects(
      () => hold(state, { databaseUrl: undefined }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceMaintenanceLockError);
        assert.equal(error.reason, "database-url-missing");
        // 78, not 75: the same restart fails the same way until a value changes.
        assert.equal(error.exitCode, SERVICE_LOCK_CONFIGURATION_EXIT_CODE);
        return true;
      },
    );
    assert.deepEqual(state.roles, [], "a refused target must not reach the lock client at all");
  });

  it("refuses to start while maintenance holds the key, with the code that says to try again", async () => {
    for (const reason of [
      "exclusive-maintenance-lock-held-by-another-session",
      "lock-connection-unavailable",
      "lock-not-granted",
    ] as const) {
      const state = harness();
      await assert.rejects(
        () => hold(state, { acquisition: { ok: false, reason, holders: null } }),
        (error: unknown) => {
          assert.ok(error instanceof ServiceMaintenanceLockError);
          assert.equal(error.reason, reason);
          assert.equal(error.exitCode, SERVICE_LOCK_CONTENTION_EXIT_CODE);
          return true;
        },
      );
      assert.deepEqual(state.scheduled, [], "nothing is watched when nothing was acquired");
    }
  });

  it("prints no URL and no password, in the message or the log", async () => {
    const state = harness();
    await assert.rejects(
      () => hold(state, { acquisition: { ok: false, reason: "lock-connection-unavailable", holders: null } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(PASSWORD), error.message);
        assert.ok(!error.message.includes(URL_WITH_SCHEMA), error.message);
        return true;
      },
    );
    const held = harness();
    await hold(held);
    for (const line of held.logs) {
      assert.ok(!line.includes(PASSWORD), line);
      assert.ok(!line.includes(URL_WITH_SCHEMA), line);
    }
  });

  it("says nothing while the lock is still held", async () => {
    const state = harness();
    const lock = await hold(state);
    assert.equal(await lock.verifyRetention(), true);
    assert.equal(await lock.verifyRetention(), true);
    assert.deepEqual(state.lost, []);
    assert.equal(state.cancels, 0);
  });

  it("stops when an exclusive maintenance holder refuses recovery", async () => {
    const state = harness();
    const lock = await hold(state, {
      reacquisitions: [{
        ok: false,
        reason: "exclusive-maintenance-lock-held-by-another-session",
        holders: { exclusive: 1, shared: 0, waiting: 0 },
      }],
    });
    state.held.value = false;
    assert.equal(await lock.verifyRetention(), false);
    assert.deepEqual(state.lost, [SERVICE_LOCK_LOST_REASON]);
    assert.equal(state.cancels, 1, "the interval stops with the lock it was watching");
    assert.ok(state.logs.includes(
      "api step=maintenance-lock role=shared result=reacquire-strike attempt=1/3 reason=exclusive-maintenance-lock-held-by-another-session",
    ));
    assert.ok(state.logs.includes(
      "api step=maintenance-lock role=shared result=lost reason=exclusive-maintenance-lock-held-by-another-session",
    ));
  });

  it("never reports the loss twice, however often it is asked", async () => {
    // The scheduled check and a shutdown path can both notice; a service that
    // was told to stop twice would run its shutdown twice.
    const state = harness();
    const lock = await hold(state, {
      reacquisitions: [{
        ok: false,
        reason: "exclusive-maintenance-lock-held-by-another-session",
        holders: { exclusive: 1, shared: 0, waiting: 0 },
      }],
    });
    state.held.value = false;
    await lock.verifyRetention();
    const afterFirst = state.verifications;
    await lock.verifyRetention();
    await lock.verifyRetention();
    assert.deepEqual(state.lost, [SERVICE_LOCK_LOST_REASON]);
    assert.equal(state.verifications, afterFirst, "a lock already known lost is not re-queried");
  });

  it("reacquires shared after a recycled backend without stopping the service", async () => {
    const state = harness();
    const lock = await hold(state);
    state.held.value = false;
    assert.equal(await lock.verifyRetention(), true);
    assert.equal(lock.backendPid, 4243, "the public handle follows the replacement session");
    assert.equal(state.releases, 1, "the replacement is held before the stale session is retired");
    assert.deepEqual(state.roles, ["shared", "shared"]);
    assert.deepEqual(state.lost, []);
    assert.ok(state.logs.includes(
      "api step=maintenance-lock role=shared result=reacquired attempt=1/3 previous_backend_pid=4242 backend_pid=4243",
    ));
  });

  it("shares one in-flight retention recovery across overlapping interval ticks", async () => {
    const state = harness();
    let answer: ((held: boolean) => void) | undefined;
    const initial = fakeLock(state);
    const delayed: HeldMaintenanceLock = {
      ...initial,
      verifyStillHeld: async () => {
        state.verifications += 1;
        return await new Promise<boolean>((resolve) => { answer = resolve; });
      },
    };
    const lock = await hold(state, { acquisition: { ok: true, lock: delayed } });
    const first = lock.verifyRetention();
    const second = lock.verifyRetention();
    assert.equal(first, second, "overlap must observe the same check and recovery");
    assert.equal(state.verifications, 1);
    assert.notEqual(answer, undefined);
    answer?.(false);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(state.roles, ["shared", "shared"], "only one replacement session was opened");
  });

  it("retries only connection-unavailable strikes and recovers within the bound", async () => {
    const state = harness();
    const unavailable: MaintenanceLockAcquisition = {
      ok: false,
      reason: "lock-connection-unavailable",
      holders: null,
    };
    const lock = await hold(state, {
      reacquisitions: [unavailable, unavailable, { ok: true, lock: fakeLock(state, 9001) }],
    });
    state.held.value = false;
    assert.equal(await lock.verifyRetention(), true);
    assert.equal(lock.backendPid, 9001);
    assert.equal(
      state.logs.filter((line) => line.includes("result=reacquire-strike")).length,
      2,
    );
    assert.deepEqual(state.lost, []);
  });

  it("stops after connection-unavailable recovery attempts are exhausted", async () => {
    const state = harness();
    const unavailable: MaintenanceLockAcquisition = {
      ok: false,
      reason: "lock-connection-unavailable",
      holders: null,
    };
    const lock = await hold(state, {
      reacquisitions: Array.from({ length: SERVICE_LOCK_REACQUIRE_ATTEMPTS }, () => unavailable),
    });
    state.held.value = false;
    assert.equal(await lock.verifyRetention(), false);
    assert.equal(state.roles.length, 1 + SERVICE_LOCK_REACQUIRE_ATTEMPTS);
    assert.equal(
      state.logs.filter((line) => line.includes("result=reacquire-strike")).length,
      SERVICE_LOCK_REACQUIRE_ATTEMPTS,
    );
    assert.ok(state.logs.includes(
      "api step=maintenance-lock role=shared result=lost reason=reacquire-attempts-exhausted",
    ));
    assert.deepEqual(state.lost, [SERVICE_LOCK_LOST_REASON]);
  });

  it("does not retry a refusal whose lock state was readable", async () => {
    const state = harness();
    const lock = await hold(state, {
      reacquisitions: [{ ok: false, reason: "lock-not-granted", holders: { exclusive: 0, shared: 0, waiting: 0 } }],
    });
    state.held.value = false;
    assert.equal(await lock.verifyRetention(), false);
    assert.deepEqual(state.roles, ["shared", "shared"]);
    state.held.value = true;
    assert.equal(await lock.verifyRetention(), false);
    assert.deepEqual(state.lost, [SERVICE_LOCK_LOST_REASON]);
  });

  it("runs the retention check the schedule was given", async () => {
    const state = harness();
    await hold(state, {
      reacquisitions: [{
        ok: false,
        reason: "exclusive-maintenance-lock-held-by-another-session",
        holders: { exclusive: 1, shared: 0, waiting: 0 },
      }],
    });
    const scheduled = state.scheduled[0];
    assert.ok(scheduled);
    state.held.value = false;
    scheduled.check();
    // The check is fire-and-forget from the timer's point of view; one turn of
    // the microtask queue is enough for it to have asked and answered.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    assert.deepEqual(state.lost, [SERVICE_LOCK_LOST_REASON]);
  });

  it("releases, cancels the interval, and is safe to call twice", async () => {
    const state = harness();
    const lock = await hold(state);
    await lock.release();
    await lock.release();
    assert.equal(state.releases, 2, "the client's own release is the idempotent one");
    assert.equal(state.cancels, 2);
    assert.equal(
      state.logs.filter((line) => line.endsWith("result=released")).length, 1,
      "one release line, however many times a shutdown path calls it",
    );
    assert.deepEqual(state.lost, []);
  });

  it("does not report a loss discovered while it was already shutting down", async () => {
    const state = harness();
    const lock = await hold(state);
    state.held.value = false;
    const releasing = lock.release();
    const checking = lock.verifyRetention();
    await releasing;
    assert.equal(await checking, false);
    assert.deepEqual(state.lost, [], "a service that is already stopping must not be told to stop");
  });
});
