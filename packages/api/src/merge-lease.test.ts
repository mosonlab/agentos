import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma, PrismaClient } from "@anneal/db";

import {
  commitWithLeaseDisposition,
  leaseHandoffsWithoutConsumer,
  leaseHolderFor,
  mergeLeaseHold,
  readMergeLeaseRelease,
  settleLease,
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseRelease,
  type MergeLeaseReleaser,
} from "./merge-lease.js";

const acquired: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
const released: MergeLeaseRelease = {
  outcome: "released",
  ref: "refs/merge-lease/holder",
  sha: "abc",
  acquiredAt: "2026-08-27T12:00:00.000Z",
};

const leaseTarget = (chainId: string) => ({ projectId: "project-1", chainId });
const holdDb = {
  task: { findFirst: async () => ({ id: "tail-task" }) },
  taskActivity: { createMany: async () => ({ count: 1 }) },
} as unknown as PrismaClient;

const holderTx = (input: {
  task: { chainId: string | null; projectId: string; templateStep: { stepIndex: number; outputKind: string; taskTemplate: { name: string } } };
  markers?: unknown[];
  regressionChainId?: string | null;
}): Prisma.TransactionClient => ({
  task: {
    findUnique: async ({ where }: { where: { id: string } }) => where.id === "task-1"
      ? input.task
      : { chainId: input.regressionChainId ?? null, projectId: "project-1" },
  },
  taskActivity: {
    findMany: async () => input.markers ?? [],
  },
} as unknown as Prisma.TransactionClient);

test("leaseHolderFor owns every merge-tail Task shape, including a failed auxiliary", async () => {
  const cases = [
    {
      name: "mechanical",
      tx: holderTx({ task: { chainId: "chain-1", projectId: "project-1", templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } } }),
      expected: { chainId: "chain-1", projectId: "project-1", taskId: "task-1", role: "mechanical" },
    },
    {
      name: "regression",
      tx: holderTx({ task: { chainId: "chain-2", projectId: "project-1", templateStep: { stepIndex: 5, outputKind: "regression-verification-v2", taskTemplate: { name: "direct-engineer-workflow" } } } }),
      expected: { chainId: "chain-2", projectId: "project-1", taskId: "task-1", role: "regression" },
    },
    {
      name: "failed auxiliary reads its repair marker without success gating",
      tx: holderTx({
        task: { chainId: null, projectId: "project-1", templateStep: { stepIndex: 0, outputKind: "result", taskTemplate: { name: "repair" } } },
        markers: [{ metadata: { kind: "mergeTail.repairAttempt", schemaVersion: 1, regressionTaskId: "regression-1" } }],
        regressionChainId: "chain-3",
      }),
      expected: { chainId: "chain-3", projectId: "project-1", taskId: "task-1", role: "auxiliary" },
    },
    {
      name: "ordinary agent Task",
      tx: holderTx({ task: { chainId: "chain-4", projectId: "project-1", templateStep: { stepIndex: 2, outputKind: "implementation", taskTemplate: { name: "direct-engineer-workflow" } } } }),
      expected: null,
    },
  ] as const;

  for (const entry of cases) {
    assert.deepEqual(await leaseHolderFor(entry.tx, "task-1"), entry.expected, entry.name);
  }
});

test("settleLease maps continuation and stop outcomes through the holder record", async () => {
  const tx = holderTx({ task: { chainId: "chain-1", projectId: "project-1", templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } } });
  assert.deepEqual(await settleLease(tx, { taskId: "task-1", outcome: "continue" }), {
    disposition: "retain",
    leaseToRelease: null,
  });
  assert.deepEqual(await settleLease(tx, { taskId: "task-1", outcome: "stop" }), {
    disposition: "release",
    leaseToRelease: leaseTarget("chain-1"),
  });
});

test("release parsing requires the timestamp while leaving duration validation to the calculator", () => {
  assert.deepEqual(
    readMergeLeaseRelease("MERGE LEASE: released refs/merge-lease/holder lease-sha 2026-08-27T12:00:00.000Z"),
    {
      outcome: "released",
      ref: "refs/merge-lease/holder",
      sha: "lease-sha",
      acquiredAt: "2026-08-27T12:00:00.000Z",
    },
  );
  assert.deepEqual(
    readMergeLeaseRelease("MERGE LEASE: released refs/merge-lease/holder lease-sha malformed-timestamp"),
    {
      outcome: "released",
      ref: "refs/merge-lease/holder",
      sha: "lease-sha",
      acquiredAt: "malformed-timestamp",
    },
  );
  assert.equal(readMergeLeaseRelease("MERGE LEASE: released refs/merge-lease/holder lease-sha"), null);
});

test("mergeLeaseHold calculates whole elapsed seconds and clamps invalid or skewed timestamps", () => {
  const acquiredAt = "2026-08-27T12:00:00.250Z";
  assert.deepEqual(mergeLeaseHold(acquiredAt, new Date("2026-08-27T12:01:02.999Z")), {
    acquiredAt: new Date(acquiredAt),
    releasedAt: new Date("2026-08-27T12:01:02.999Z"),
    heldForSeconds: 62,
  });
  assert.equal(mergeLeaseHold(acquiredAt, new Date("2026-08-27T11:59:59.999Z"))?.heldForSeconds, 0);
  assert.equal(mergeLeaseHold("not-a-date", new Date("2026-08-27T12:01:02.999Z")), null);
  assert.equal(mergeLeaseHold(acquiredAt, new Date("not-a-date")), null);
});

test("leaseHandoffsWithoutConsumer returns only stale Runs that never claimed", async () => {
  const now = new Date("2026-08-27T12:02:00.000Z");
  const tx = {
    taskActivity: { findMany: async () => [
      { taskId: "task-stale", task: { projectId: "project-1" }, metadata: { state: "pending", chainId: "chain-stale", toRunId: "run-stale", handedOffAt: "2026-08-27T12:00:00.000Z" } },
      { taskId: "task-active", task: { projectId: "project-1" }, metadata: { state: "pending", chainId: "chain-active", toRunId: "run-active", handedOffAt: "2026-08-27T12:01:30.000Z" } },
      { taskId: "task-done", task: { projectId: "project-1" }, metadata: { state: "released", chainId: "chain-done", toRunId: "run-done" } },
      { taskId: "task-done", task: { projectId: "project-1" }, metadata: { state: "pending", chainId: "chain-done", toRunId: "run-done" } },
    ] },
    run: { findMany: async () => [{ id: "run-stale" }] },
  } as unknown as Prisma.TransactionClient;

  assert.deepEqual(await leaseHandoffsWithoutConsumer(tx, now), [
    { chainId: "chain-stale", projectId: "project-1", toRunId: "run-stale", taskId: "task-stale" },
  ]);
});

test("commitWithLeaseDisposition releases only after the transaction commits", async () => {
  const events: string[] = [];
  const db = {
    $transaction: async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      const result = await fn({} as Prisma.TransactionClient);
      events.push("commit");
      return result;
    },
  } as unknown as Parameters<typeof commitWithLeaseDisposition>[0];

  const value = await commitWithLeaseDisposition(db, async () => {
    events.push("transaction");
    return {
      value: 42,
      lease: { disposition: "release", leaseToRelease: leaseTarget("chain-1") },
    };
  }, async (target) => {
    events.push(`release:${target?.chainId ?? "none"}`);
  });

  assert.equal(value, 42);
  assert.deepEqual(events, ["transaction", "commit", "release:chain-1"]);
});

test("a completed callback releases the merge Lease", async () => {
  const acquiredFor: string[] = [];
  const releasedFor: string[] = [];
  const result = await withMergeLease(leaseTarget("chain-1"), async () => ({
    disposition: { kind: "release" },
    value: 42,
  }), holdDb, {
    acquire: async (chainId) => {
      acquiredFor.push(chainId);
      return { outcome: "acquired" };
    },
    release: async (chainId) => {
      releasedFor.push(chainId);
      return released;
    },
  });

  assert.deepEqual(result, { outcome: "ran", value: 42 });
  assert.deepEqual(acquiredFor, ["chain-1"]);
  assert.deepEqual(releasedFor, ["chain-1"]);
});

test("retain hands the merge Lease to the downstream consumer", async () => {
  let releaseCalled = false;
  const result = await withMergeLease(leaseTarget("chain-2"), async () => ({
    disposition: { kind: "retain", handoffRunId: "run-2" },
    value: "authorized",
  }), holdDb, {
    acquire: acquired,
    release: async () => {
      releaseCalled = true;
      return released;
    },
  });

  assert.deepEqual(result, { outcome: "ran", value: "authorized" });
  assert.equal(releaseCalled, false);
});

test("a callback exception still releases the merge Lease", async () => {
  const releasedFor: string[] = [];
  await assert.rejects(
    withMergeLease(leaseTarget("chain-3"), async () => {
      throw new Error("authorization failed");
    }, holdDb, {
      acquire: acquired,
      release: async (chainId) => {
        releasedFor.push(chainId);
        return released;
      },
    }),
    /authorization failed/u,
  );
  assert.deepEqual(releasedFor, ["chain-3"]);
});

test("a contended merge Lease does not run the callback", async () => {
  let callbackCalled = false;
  let releaseCalled = false;
  const result = await withMergeLease(leaseTarget("chain-4"), async () => {
    callbackCalled = true;
    return { disposition: { kind: "release" }, value: null };
  }, holdDb, {
    acquire: async () => ({ outcome: "contended" }),
    release: async () => {
      releaseCalled = true;
      return released;
    },
  });

  assert.deepEqual(result, { outcome: "contended" });
  assert.equal(callbackCalled, false);
  assert.equal(releaseCalled, false);
});

test("an unreachable merge Lease is a retryable result and does not run the callback", async () => {
  let callbackCalled = false;
  let releaseCalled = false;
  const result = await withMergeLease(leaseTarget("chain-unreachable"), async () => {
    callbackCalled = true;
    return { disposition: { kind: "release" }, value: null };
  }, holdDb, {
    acquire: async () => ({ outcome: "unreachable", detail: "TLS transport failed" }),
    release: async () => {
      releaseCalled = true;
      return released;
    },
  });

  assert.deepEqual(result, { outcome: "unreachable", detail: "TLS transport failed" });
  assert.equal(callbackCalled, false);
  assert.equal(releaseCalled, false);
});

test("the module reports a release anomaly itself", async (t) => {
  const said: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args.map(String).join(" ")); });

  await withMergeLease(leaseTarget("chain-5"), async () => ({ disposition: { kind: "release" }, value: null }), holdDb, {
    acquire: acquired,
    release: async () => ({ outcome: "skipped", heldFor: "chain-42" }),
  });

  assert.equal(said.length, 1);
  assert.match(said[0]!, /chain-5/u);
  assert.match(said[0]!, /chain-42/u);
});

test("a rejected release adapter is reported as unreachable", async (t) => {
  const said: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args.map(String).join(" ")); });
  const releaser: MergeLeaseReleaser = async () => { throw new Error("spawn bash ENOENT"); };

  await withMergeLease(leaseTarget("chain-6"), async () => ({ disposition: { kind: "release" }, value: null }), holdDb, {
    acquire: acquired,
    release: releaser,
  });

  assert.equal(said.length, 1);
  assert.match(said[0]!, /chain-6/u);
  assert.match(said[0]!, /spawn bash ENOENT/u);
});

test("a Task without a Chain runs without either Lease adapter", async () => {
  const result = await withMergeLease(null, async () => ({ disposition: { kind: "release" }, value: "unleased" }), holdDb, {
    acquire: async () => { throw new Error("the acquirer must not be called"); },
    release: async () => { throw new Error("the releaser must not be called"); },
  });

  assert.deepEqual(result, { outcome: "ran", value: "unleased" });
});
