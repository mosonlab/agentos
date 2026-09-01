import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const unitTestDatabaseUrl = "postgresql://scratch_role:secret@127.0.0.1:55432/agentos_test_control?schema=isolated";
const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
process.env.TEST_DATABASE_URL = unitTestDatabaseUrl;
const {
  awaitNoConnections,
  ScratchDatabaseManager,
  scratchNameOwnerPid,
  validateScratchDatabaseEnvironment,
} = await import("./testdb.js");
if (previousTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
else process.env.TEST_DATABASE_URL = previousTestDatabaseUrl;

const safeEnvironment = {
  AGENTOS_ALLOW_SCRATCH_DATABASES: "1",
  TEST_DATABASE_URL: unitTestDatabaseUrl,
  TEST_DATABASE_MAINTENANCE_URL: "postgresql://scratch_role:secret@127.0.0.1:55432/postgres_maintenance?schema=isolated",
} satisfies NodeJS.ProcessEnv;

test("DB-HARNESS-GUARD refuses to load without an explicit test database URL", () => {
  const environment = { ...process.env };
  delete environment.TEST_DATABASE_URL;
  const imported = spawnSync(
    process.execPath,
    ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(new URL("./testdb.ts", import.meta.url).href)})`],
    { encoding: "utf8", env: environment },
  );
  assert.notEqual(imported.status, 0);
  assert.match(imported.stderr, /scratch-test-database-url-required/u);
});

test("DB-HARNESS-GUARD requires explicit opt-in and both explicit URLs", () => {
  assert.throws(() => validateScratchDatabaseEnvironment({}), /opt-in-required/u);
  assert.throws(() => validateScratchDatabaseEnvironment({ AGENTOS_ALLOW_SCRATCH_DATABASES: "1" }), /test-database-url-required/u);
  assert.throws(() => validateScratchDatabaseEnvironment({
    AGENTOS_ALLOW_SCRATCH_DATABASES: "1",
    TEST_DATABASE_URL: safeEnvironment.TEST_DATABASE_URL,
  }), /maintenance-url-required/u);
});

test("DB-HARNESS-GUARD refuses default, equal, cross-server, and cross-role targets", () => {
  assert.throws(() => validateScratchDatabaseEnvironment({
    ...safeEnvironment,
    TEST_DATABASE_URL: "postgresql://scratch_role:secret@127.0.0.1:55432/agentos?schema=test",
  }), /default-agentos/u);
  assert.throws(() => validateScratchDatabaseEnvironment({
    ...safeEnvironment,
    TEST_DATABASE_MAINTENANCE_URL: safeEnvironment.TEST_DATABASE_URL,
  }), /must-differ/u);
  assert.throws(() => validateScratchDatabaseEnvironment({
    ...safeEnvironment,
    TEST_DATABASE_MAINTENANCE_URL: "postgresql://scratch_role:secret@localhost:55432/postgres_maintenance",
  }), /server-mismatch/u);
  assert.throws(() => validateScratchDatabaseEnvironment({
    ...safeEnvironment,
    TEST_DATABASE_MAINTENANCE_URL: "postgresql://other_role:secret@127.0.0.1:55432/postgres_maintenance",
  }), /role-mismatch/u);
});

test("DB-HARNESS-GUARD preserves Prisma schema and redacts credentials", () => {
  const config = validateScratchDatabaseEnvironment(safeEnvironment);
  assert.equal(config.schema, "isolated");
  assert.equal(config.redactedServer, "127.0.0.1:55432/postgres_maintenance");
  assert.doesNotMatch(config.redactedServer, /scratch_role|secret/u);
});

test("DB-HARNESS-GUARD cleanup refuses every unrecorded database name before connecting", async () => {
  const manager = new ScratchDatabaseManager(safeEnvironment);
  await assert.rejects(manager.drop("agentos_cp_a_unrecorded_12345678"), /not-allowlisted/u);
  await manager.disconnect();
});

test("DB-HARNESS-TEMPLATE-WAIT outlasts a backend on its way out, and still refuses one that stays", async () => {
  // `prisma migrate deploy` has exited; PostgreSQL has not finished reaping its
  // backend. One question would call that an occupied template.
  const draining = [2n, 1n, 0n];
  const waits: number[] = [];
  await awaitNoConnections(async () => draining.shift() ?? 0n, {
    intervalMs: 7,
    wait: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(waits, [7, 7]);

  let clock = 0;
  await assert.rejects(
    () => awaitNoConnections(async () => 1n, {
      timeoutMs: 30,
      intervalMs: 10,
      now: () => clock,
      wait: async (ms) => { clock += ms; },
    }),
    /scratch-template-has-active-connections/u,
  );
  assert.equal(clock, 30);
});

test("DB-HARNESS-ORPHAN reads the creating process out of the name, and only out of a name it made", () => {
  assert.equal(scratchNameOwnerPid("agentos_cp_a_chain_4242_abcdefabcdef"), 4242);
  // A label with underscores in it must not move where the pid is read from.
  assert.equal(scratchNameOwnerPid("agentos_cp_a_control_plane_77_abcdefabcdef"), 77);
  // Anything this manager did not shape is not something a sweep may reason
  // about, let alone drop: no pid means no evidence that it was abandoned.
  assert.equal(scratchNameOwnerPid("agentos_production"), null);
  assert.equal(scratchNameOwnerPid("agentos_cp_a_chain"), null);
  assert.equal(scratchNameOwnerPid("agentos_cp_a_chain_notapid_abcdefabcdef"), null);
  assert.equal(scratchNameOwnerPid('agentos_cp_a_x_1_"; DROP DATABASE agentos --'), null);
});
