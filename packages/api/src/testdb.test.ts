import assert from "node:assert/strict";
import test from "node:test";

import { ScratchDatabaseManager, validateScratchDatabaseEnvironment } from "./testdb.js";

const safeEnvironment = {
  AGENTOS_ALLOW_SCRATCH_DATABASES: "1",
  TEST_DATABASE_URL: "postgresql://scratch_role:secret@127.0.0.1:55432/agentos_test_control?schema=isolated",
  TEST_DATABASE_MAINTENANCE_URL: "postgresql://scratch_role:secret@127.0.0.1:55432/postgres_maintenance?schema=isolated",
} satisfies NodeJS.ProcessEnv;

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
    TEST_DATABASE_MAINTENANCE_URL: "postgresql://scratch_role:secret@127.0.0.2:55432/postgres_maintenance",
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
