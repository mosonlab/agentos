import assert from "node:assert/strict";
import test from "node:test";

import {
  assignmentFor,
  connectionLimit,
  derivedMaintenanceUrl,
  environmentForAssignment,
  fileDirectoryName,
  fileLabel,
  maximumConnectionLimit,
  maximumDefaultConcurrency,
  minimumConnectionLimit,
  perFileDatabaseUrl,
  provisioningAvailable,
  provisioningRequested,
  resolveConcurrency,
} from "./dbtest-plan.js";
import { fixtureDatabaseUrl } from "./dbtest-url-fixture.js";

test("DBTEST-PLAN-CONCURRENCY leaves a core free and refuses a nonsense override", () => {
  // The gate's worker is four vCPU, which is the number this default exists for.
  assert.equal(resolveConcurrency({}, 4), 3);
  assert.equal(resolveConcurrency({}, 1), 1);
  assert.equal(resolveConcurrency({}, 2), 1);
  assert.equal(resolveConcurrency({}, 64), maximumDefaultConcurrency);
  assert.equal(resolveConcurrency({}, 10), maximumDefaultConcurrency);
  assert.equal(resolveConcurrency({ AGENTOS_DBTEST_CONCURRENCY: "1" }, 64), 1);
  assert.equal(resolveConcurrency({ AGENTOS_DBTEST_CONCURRENCY: "12" }, 4), 12);
  assert.equal(resolveConcurrency({ AGENTOS_DBTEST_CONCURRENCY: "" }, 4), 3);
  for (const bad of ["0", "-2", "3.5", "many", " 3"]) {
    assert.throws(() => resolveConcurrency({ AGENTOS_DBTEST_CONCURRENCY: bad }, 4), /positive integer/u);
  }
});

test("DBTEST-PLAN-OPT-IN hands out databases only where the scratch opt-in already allows it", () => {
  const opted = { AGENTOS_ALLOW_SCRATCH_DATABASES: "1", TEST_DATABASE_URL: fixtureDatabaseUrl("a", "b", "127.0.0.1:5455/t?schema=s") };
  assert.equal(provisioningAvailable(opted), true);
  assert.equal(provisioningAvailable({ ...opted, AGENTOS_ALLOW_SCRATCH_DATABASES: "0" }), false);
  assert.equal(provisioningAvailable({ AGENTOS_ALLOW_SCRATCH_DATABASES: "1" }), false);
  assert.equal(provisioningAvailable({}), false);
  assert.equal(provisioningRequested({}), true);
  assert.equal(provisioningRequested({ AGENTOS_DBTEST_PROVISION: "0" }), false);
});

test("DBTEST-PLAN-MAINTENANCE derives the maintenance URL on the same server, never a schema of its own", () => {
  assert.equal(
    derivedMaintenanceUrl(fixtureDatabaseUrl("agentos", "agentos", "127.0.0.1:55777/agentos_gate?schema=agentos_gate")),
    fixtureDatabaseUrl("agentos", "agentos", "127.0.0.1:55777/postgres"),
  );
  const derived = new URL(derivedMaintenanceUrl(fixtureDatabaseUrl("u", "p", "db.internal:6543/agentos_test?schema=x&sslmode=require")));
  assert.equal(derived.host, "db.internal:6543");
  assert.equal(derived.pathname, "/postgres");
  assert.equal(derived.search, "");
  assert.equal(derived.username, "u");
});

test("DBTEST-PLAN-LABELS keep one file's database and directories distinct from another's", () => {
  assert.equal(fileLabel("/repo/packages/api/src/chain-branch.dbtest.ts"), "chain-branch");
  assert.equal(fileLabel("merge-integrator-seed.dbtest.ts"), "merge-integrator-seed");
  assert.equal(fileDirectoryName("/repo/src/chain.dbtest.ts"), "chain");
  assert.equal(fileDirectoryName("/repo/src/../src/we ird$.dbtest.ts"), "we-ird-");
});

test("DBTEST-PLAN-ASSIGNMENT moves DATABASE_URL with the test URL and only the roots the caller set", () => {
  const plan = {
    files: {
      "/repo/src/chain.dbtest.ts": {
        databaseUrl: fixtureDatabaseUrl("agentos", "agentos", "127.0.0.1:55777/agentos_cp_a_chain_1_abc?schema=agentos_gate"),
        workspaceRoot: "/tmp/roots/ws/chain",
      },
    },
  };
  // Fail closed, both ways: a plan exists only when files run at the same time,
  // so a process that cannot find its own assignment would otherwise inherit
  // the database and the roots every other file is using.
  assert.throws(() => assignmentFor(plan, undefined), /entry-missing/u);
  assert.throws(() => assignmentFor(plan, ""), /entry-missing/u);
  assert.throws(() => assignmentFor(plan, "/repo/src/tasks.dbtest.ts"), /assignment-missing/u);
  const assignment = assignmentFor(plan, "/repo/src/chain.dbtest.ts");
  assert.ok(assignment);
  const environment = environmentForAssignment(assignment);
  assert.deepEqual(environment, {
    TEST_DATABASE_URL: assignment.databaseUrl,
    // The gate keeps these equal so that a subprocess reading DATABASE_URL can
    // only reach the throwaway server; parallel files must not break that.
    DATABASE_URL: assignment.databaseUrl,
    // Only a file that got a database of its own may skip the migration step.
    AGENTOS_DBTEST_PREMIGRATED: "1",
    RUNNER_WORKSPACE_ROOT: "/tmp/roots/ws/chain",
  });
});

test("DBTEST-PLAN-POOL keeps every file's ceiling adding up to less than the server's", () => {
  // The stock server and this machine's default: eight files at Prisma's own
  // ceiling would be 168 connections against 100.
  assert.equal(connectionLimit(100, 8), 5);
  assert.equal(connectionLimit(100, 4), maximumConnectionLimit);
  assert.equal(connectionLimit(100, 3), maximumConnectionLimit);
  assert.equal(connectionLimit(100, 1), maximumConnectionLimit);
  assert.equal(connectionLimit(500, 8), maximumConnectionLimit);
  // Never below the floor, even on a server too small to honour it: a pool of
  // one deadlocks a test that holds a transaction and opens a second query.
  assert.equal(connectionLimit(20, 16), minimumConnectionLimit);
  for (const concurrency of [1, 2, 3, 4, 8, 16]) {
    assert.ok(connectionLimit(100, concurrency) >= minimumConnectionLimit);
    assert.ok(connectionLimit(100, concurrency) <= maximumConnectionLimit);
  }
});

test("DBTEST-PLAN-URL carries the pool ceiling and the patience, and keeps the schema", () => {
  const url = new URL(perFileDatabaseUrl(
    fixtureDatabaseUrl("agentos", "agentos", "127.0.0.1:55777/agentos_cp_a_chain_1_ab?schema=agentos_gate"),
    5,
  ));
  assert.equal(url.searchParams.get("schema"), "agentos_gate");
  assert.equal(url.searchParams.get("connection_limit"), "5");
  assert.equal(url.searchParams.get("connect_timeout"), "20");
  assert.equal(url.pathname, "/agentos_cp_a_chain_1_ab");
});
