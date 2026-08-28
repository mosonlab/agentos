import assert from "node:assert/strict";
import { test } from "node:test";

import type { Prisma, PrismaClient } from "@anneal/db";

import { authenticate, mergeExecutorTokenIsDistinct, principalMayAccess } from "./auth.js";
import { activeRunStatuses } from "./run-fence.js";

const withEnv = async (env: Record<string, string | undefined>, body: () => Promise<void> | void): Promise<void> => {
  const prior = Object.keys(env).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
};

/** No session lookup happens on any of these paths, so the db is never touched. */
const db = null as never;

test("the merge executor is a principal of its own, minted only from its own token", async () => {
  await withEnv({ OPERATOR_TOKEN: "op", RUNNER_TOKEN: "run", MERGE_EXECUTOR_TOKEN: "exec" }, async () => {
    assert.deepEqual(await authenticate(db, "Bearer exec"), { kind: "merge-executor" });
    assert.deepEqual(await authenticate(db, "Bearer run"), { kind: "runner" });
    assert.deepEqual(await authenticate(db, "Bearer op"), { kind: "operator" });
  });
});

test("an unset or aliased MERGE_EXECUTOR_TOKEN mints no executor principal", async () => {
  // Fail closed twice over: with the variable unset there is no executor at
  // all, and with it aliased onto an existing credential the caller is whatever
  // that credential already was — never an executor. A deployment cannot
  // acquire mechanical authority by accident.
  await withEnv({ OPERATOR_TOKEN: "op", RUNNER_TOKEN: "run", MERGE_EXECUTOR_TOKEN: undefined }, async () => {
    assert.equal(mergeExecutorTokenIsDistinct(), false);
    assert.deepEqual(await authenticate(db, "Bearer run"), { kind: "runner" });
  });
  await withEnv({ OPERATOR_TOKEN: "op", RUNNER_TOKEN: "run", MERGE_EXECUTOR_TOKEN: "run" }, async () => {
    assert.equal(mergeExecutorTokenIsDistinct(), false);
    assert.deepEqual(await authenticate(db, "Bearer run"), { kind: "runner" });
  });
  await withEnv({ OPERATOR_TOKEN: "op", RUNNER_TOKEN: "run", MERGE_EXECUTOR_TOKEN: "op" }, async () => {
    assert.equal(mergeExecutorTokenIsDistinct(), false);
    assert.deepEqual(await authenticate(db, "Bearer op"), { kind: "operator" });
  });
  await withEnv({ OPERATOR_TOKEN: "op", RUNNER_TOKEN: "run", MERGE_EXECUTOR_TOKEN: "" }, async () => {
    assert.equal(mergeExecutorTokenIsDistinct(), false);
  });
});

test("the executor speaks the runner protocol and nothing else", () => {
  const executor = { kind: "merge-executor" } as const;
  assert.equal(principalMayAccess(executor, "/runner/tasks/claim"), true);
  assert.equal(principalMayAccess(executor, "/runner/runs/abc/complete"), true);
  assert.equal(principalMayAccess(executor, "/tasks"), false);
  assert.equal(principalMayAccess(executor, "/session/runs/abc/output"), false);
});

test("session authentication uses the run-fence live status set", async () => {
  await withEnv({ OPERATOR_TOKEN: "op", RUNNER_TOKEN: "run", MERGE_EXECUTOR_TOKEN: "exec" }, async () => {
    let where: Prisma.RunWhereInput | undefined;
    const sessionDb = { run: { findFirst: async (input: { where: Prisma.RunWhereInput }) => {
      where = input.where;
      return { id: "run-1", leaseGeneration: 3 };
    } } } as unknown as PrismaClient;

    assert.deepEqual(
      await authenticate(sessionDb, "Bearer agos_session_current", new Date("2026-08-26T12:00:00.000Z")),
      { kind: "session", runId: "run-1", leaseGeneration: 3 },
    );
    assert.equal((where?.status as { in: unknown }).in, activeRunStatuses);
  });
});
