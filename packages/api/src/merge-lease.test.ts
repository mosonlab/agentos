import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma, PrismaClient } from "@anneal/db";

import {
  commitWithLeaseOutcome,
  commitWithLeaseOutcomes,
  leaseHandoffsWithoutConsumer,
  leaseHolderFor,
  mergeLeaseScriptPath,
  readMergeLeaseRelease,
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
} from "./merge-lease.js";
import {
  mergeLeaseHold,
  type MergeLeaseRelease,
} from "./merge-lease-hold.js";

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
  $transaction: async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn({
    run: { findUnique: async () => ({ taskId: "tail-task" }) },
    taskActivity: { create: async () => ({}) },
  } as unknown as Prisma.TransactionClient),
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

test("release runtime executes the current release's helper while keeping the Git checkout separate", () => {
  assert.equal(
    mergeLeaseScriptPath({
      AGENTOS_RELEASE_ROOT: "/srv/agentos/current",
      AGENTOS_REPOSITORY_ROOT: "/srv/agentos/source",
    }),
    "/srv/agentos/current/scripts/merge-lease.sh",
  );
  assert.match(
    mergeLeaseScriptPath({ AGENTOS_REPOSITORY_ROOT: "/srv/agentos/source" }),
    /\/scripts\/merge-lease\.sh$/u,
  );
});

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
  let sql = "";
  let parameters: unknown[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql = strings.join("?");
      parameters = values;
      return [{ toRunId: "run-stale", taskId: "task-stale" }];
    },
  } as unknown as Prisma.TransactionClient;

  assert.deepEqual(await leaseHandoffsWithoutConsumer(tx, now), [
    { toRunId: "run-stale", taskId: "task-stale" },
  ]);
  assert.match(sql, /FROM "Run" AS consumer/u);
  assert.match(sql, /JOIN LATERAL/u);
  assert.match(sql, /activity\."createdAt" >= LEAST\(consumer\."createdAt", consumer\."readyAt"\)/u);
  assert.match(sql, /GREATEST\(consumer\."createdAt", consumer\."readyAt"\)/u);
  assert.match(sql, /ORDER BY "staleAt" ASC, "toRunId" ASC/u);
  assert.match(sql, /LIMIT/u);
  assert.ok(parameters.some((value) => value instanceof Date), "the query has a time floor");
  assert.ok(parameters.includes(100), "the query has an explicit row limit");
});

const transactionDb = (tx: Prisma.TransactionClient, events: string[] = []) => ({
  $transaction: async (fn: (client: Prisma.TransactionClient) => Promise<unknown>) => {
    const result = await fn(tx);
    events.push("commit");
    return result;
  },
} as unknown as PrismaClient);

test("commitWithLeaseOutcome releases only after the transaction commits", async () => {
  const events: string[] = [];
  const tx = holderTx({ task: { chainId: "chain-1", projectId: "project-1", templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } } });
  const db = transactionDb(tx, events);

  const value = await commitWithLeaseOutcome(db, async () => {
    events.push("transaction");
    return {
      value: 42,
      leaseOutcome: { kind: "stop", taskId: "task-1" },
    };
  }, { release: async (target) => {
    events.push(`release:${target?.chainId ?? "none"}`);
  } });

  assert.equal(value, 42);
  assert.deepEqual(events, ["transaction", "commit", "release:chain-1"]);
});

test("commitWithLeaseOutcome rolls back without release when the callback fails", async () => {
  let releases = 0;
  const failure = new Error("transaction failed");
  const db = transactionDb(holderTx({ task: { chainId: "chain-1", projectId: "project-1", templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } } }));
  await assert.rejects(commitWithLeaseOutcome(db, async () => {
    throw failure;
  }, { release: async () => { releases += 1; } }), (error: unknown) => error === failure);
  assert.equal(releases, 0);
});

test("commitWithLeaseOutcome surfaces release failure", async () => {
  const failure = new Error("release failed");
  const db = transactionDb(holderTx({ task: { chainId: "chain-1", projectId: "project-1", templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } } }));
  await assert.rejects(commitWithLeaseOutcome(db, async () => ({
    value: null,
    leaseOutcome: { kind: "stop", taskId: "task-1" },
  }), { release: async () => { throw failure; } }), (error: unknown) => error === failure);
});

test("commitWithLeaseOutcomes deduplicates release targets and rolls back without release", async () => {
  const tx = holderTx({ task: { chainId: "chain-1", projectId: "project-1", templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } } });
  const db = transactionDb(tx);
  const releasedTargets: unknown[] = [];
  const value = await commitWithLeaseOutcomes(db, async () => ({
    value: 7,
    leaseOutcomes: [
      { kind: "stop", taskId: "task-1" },
      { kind: "stop", taskId: "task-1" },
    ],
  }), { release: async (target) => { releasedTargets.push(target); } });
  assert.equal(value, 7);
  assert.deepEqual(releasedTargets, [leaseTarget("chain-1")]);

  const failure = new Error("batch transaction failed");
  await assert.rejects(commitWithLeaseOutcomes(db, async () => {
    throw failure;
  }, { release: async (target) => { if (target) releasedTargets.push(target); } }), (error: unknown) => error === failure);
  assert.equal(releasedTargets.length, 1);
});

test("commitWithLeaseOutcomes surfaces release failure", async () => {
  const failure = new Error("batch release failed");
  const db = transactionDb(holderTx({ task: { chainId: "chain-1", projectId: "project-1", templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } } }));
  await assert.rejects(commitWithLeaseOutcomes(db, async () => ({
    value: null,
    leaseOutcomes: [{ kind: "stop", taskId: "task-1" }],
  }), { release: async () => { throw failure; } }), (error: unknown) => (
    error instanceof AggregateError && error.errors.includes(failure)
  ));
});

test("commitWithLeaseOutcome records handoff without release and surfaces record failure", async () => {
  const activities: unknown[] = [];
  const tx = {
    ...holderTx({ task: { chainId: "chain-1", projectId: "project-1", templateStep: { stepIndex: 7, outputKind: "merge-result", taskTemplate: { name: "direct-engineer-workflow" } } } }),
    run: { findUnique: async () => ({ taskId: "task-2" }) },
    taskActivity: { create: async (input: unknown) => { activities.push(input); } },
  } as unknown as Prisma.TransactionClient;
  let releases = 0;
  const db = transactionDb(tx);
  await commitWithLeaseOutcome(db, async () => ({
    value: null,
    leaseOutcome: {
      kind: "hand-off",
      taskId: "task-1",
      handoffRunId: "run-2",
      at: new Date("2026-08-27T12:00:00.000Z"),
    },
  }), { release: async () => { releases += 1; } });
  assert.equal(releases, 0);
  assert.equal(activities.length, 1);

  const recordFailure = new Error("handoff record failed");
  const failingTx = {
    ...tx,
    taskActivity: { create: async () => { throw recordFailure; } },
  } as unknown as Prisma.TransactionClient;
  await assert.rejects(commitWithLeaseOutcome(transactionDb(failingTx), async () => ({
    value: null,
    leaseOutcome: {
      kind: "hand-off",
      taskId: "task-1",
      handoffRunId: "run-2",
      at: new Date("2026-08-27T12:00:00.000Z"),
    },
  })), (error: unknown) => error === recordFailure);
});

test("commitWithLeaseOutcome durably invalidates a handoff without a holder", async () => {
  let releases = 0;
  const invalidActivities: Array<{ data: { metadata: Record<string, unknown> } }> = [];
  const base = holderTx({
    task: {
      chainId: "ordinary-chain",
      projectId: "project-1",
      templateStep: {
        stepIndex: 2,
        outputKind: "implementation",
        taskTemplate: { name: "direct-engineer-workflow" },
      },
    },
  });
  const tx = {
    ...base,
    taskActivity: {
      findMany: async () => [],
      create: async (input: { data: { metadata: Record<string, unknown> } }) => {
        invalidActivities.push(input);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  await commitWithLeaseOutcome(transactionDb(tx), async () => ({
    value: null,
    leaseOutcome: {
      kind: "stop",
      taskId: "task-1",
      releasedHandoff: { toRunId: "run-orphan", at: new Date("2026-08-27T12:00:00.000Z") },
    },
  }), { release: async () => { releases += 1; } });
  assert.equal(releases, 0);
  assert.equal(invalidActivities.length, 1);
  assert.equal(invalidActivities[0]!.data.metadata.state, "invalid");
  assert.equal(invalidActivities[0]!.data.metadata.toRunId, "run-orphan");
});

test("a completed callback releases the merge Lease", async () => {
  const acquiredFor: string[] = [];
  const releasedFor: string[] = [];
  const result = await withMergeLease(leaseTarget("chain-1"), async () => ({
    leaseOutcome: { kind: "stop" },
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

test("continue leaves the merge Lease with its recorded downstream consumer", async () => {
  let releaseCalled = false;
  const result = await withMergeLease(leaseTarget("chain-2"), async () => ({
    leaseOutcome: { kind: "continue" },
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

test("a release-recording failure preserves the callback exception", async () => {
  const callbackFailure = new Error("authorization failed first");
  const recordingFailure = new Error("hold recording failed second");
  const failingDb = {
    task: { findFirst: async () => ({ id: "tail-task" }) },
    taskActivity: { createMany: async () => { throw recordingFailure; } },
  } as unknown as PrismaClient;

  await assert.rejects(
    withMergeLease(leaseTarget("chain-double-failure"), async () => {
      throw callbackFailure;
    }, failingDb, {
      acquire: acquired,
      release: async () => released,
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors[0] === callbackFailure
      && error.errors[1] === recordingFailure,
  );
});

test("a contended merge Lease does not run the callback", async () => {
  let callbackCalled = false;
  let releaseCalled = false;
  const result = await withMergeLease(leaseTarget("chain-4"), async () => {
    callbackCalled = true;
    return { leaseOutcome: { kind: "stop" }, value: null };
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
    return { leaseOutcome: { kind: "stop" }, value: null };
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

test("skipped and refused releases are reported decided outcomes", async (t) => {
  const said: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args.map(String).join(" ")); });

  assert.deepEqual(await withMergeLease(leaseTarget("chain-5"), async () => ({ leaseOutcome: { kind: "stop" }, value: "skipped" }), holdDb, {
    acquire: acquired,
    release: async () => ({ outcome: "skipped", heldFor: "chain-42" }),
  }), { outcome: "ran", value: "skipped" });
  assert.deepEqual(await withMergeLease(leaseTarget("chain-6"), async () => ({ leaseOutcome: { kind: "stop" }, value: "refused" }), holdDb, {
    acquire: acquired,
    release: async () => ({ outcome: "refused", heldBy: "another-host" }),
  }), { outcome: "ran", value: "refused" });

  assert.equal(said.length, 2);
  assert.match(said[0]!, /chain-5/u);
  assert.match(said[0]!, /chain-42/u);
  assert.match(said[1]!, /chain-6/u);
  assert.match(said[1]!, /another-host/u);
});

test("an unreachable release outcome is retryable", async () => {
  assert.deepEqual(await withMergeLease(
    leaseTarget("chain-unreachable-release"),
    async () => ({ leaseOutcome: { kind: "stop" }, value: null }),
    holdDb,
    {
      acquire: acquired,
      release: async () => ({ outcome: "unreachable", detail: "release helper timed out" }),
    },
  ), { outcome: "unreachable", detail: "release helper timed out" });
});

test("a rejected release adapter is an unreachable transport", async () => {
  const releaser: MergeLeaseReleaser = async () => { throw new Error("spawn bash ENOENT"); };

  assert.deepEqual(await withMergeLease(leaseTarget("chain-6"), async () => ({ leaseOutcome: { kind: "stop" }, value: null }), holdDb, {
    acquire: acquired,
    release: releaser,
  }), { outcome: "unreachable", detail: "Merge lease release transport failed: spawn bash ENOENT" });
});

test("a Task without a Chain runs without either Lease adapter", async () => {
  const result = await withMergeLease(null, async () => ({ leaseOutcome: { kind: "stop" }, value: "unleased" }), holdDb, {
    acquire: async () => { throw new Error("the acquirer must not be called"); },
    release: async () => { throw new Error("the releaser must not be called"); },
  });

  assert.deepEqual(result, { outcome: "ran", value: "unleased" });
});
