import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma, PrismaClient } from "@anneal/db";

import {
  recordMergeLeaseHold,
  type MergeLeaseTarget,
} from "./merge-lease-hold.js";

const target: MergeLeaseTarget = { projectId: "project-1", chainId: "chain-1" };
const releasedAt = new Date("2026-08-27T12:01:02.999Z");

test("a confirmed-release recording failure propagates and never claims evidence was stored", async () => {
  let writes = 0;
  const tx = {
    task: { findFirst: async () => ({ id: "tail-task" }) },
    mergeLeaseEvent: {
      findUnique: async () => null,
      findFirst: async () => null,
      createMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({
        id: "ledger-1", projectId: "project-1", chainId: "chain-1",
        leaseRef: "refs/merge-lease/holder", leaseSha: "lease-sha", state: "RELEASED",
        owningTaskId: "tail-task", handedOffRunId: null, handedOffAt: null,
        deferredAt: null, settledAt: releasedAt,
        acquiredAt: new Date("2026-08-27T12:00:00.250Z"), failureDetail: null,
        createdAt: releasedAt, updatedAt: releasedAt,
      }),
    },
    taskActivity: {
      create: async () => {
        writes += 1;
        throw new Error("database unavailable");
      },
    },
  } as unknown as Prisma.TransactionClient;
  const db = {
    $transaction: async (operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  await assert.rejects(
    recordMergeLeaseHold(db, target, {
      outcome: "released",
      ref: "refs/merge-lease/holder",
      sha: "lease-sha",
      acquiredAt: "2026-08-27T12:00:00.250Z",
    }, releasedAt),
    /database unavailable/u,
  );
  assert.equal(writes, 1);
});

test("an unconfirmed release performs no lookup or write", async () => {
  let transactions = 0;
  const db = {
    $transaction: async () => { transactions += 1; },
  } as unknown as PrismaClient;

  assert.equal(await recordMergeLeaseHold(db, target, { outcome: "not-held" }, releasedAt), "ignored");
  assert.equal(transactions, 0);
});
