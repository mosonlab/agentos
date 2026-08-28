import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import {
  recordMergeLeaseHold,
  type MergeLeaseTarget,
} from "./merge-lease-hold.js";

const target: MergeLeaseTarget = { projectId: "project-1", chainId: "chain-1" };
const releasedAt = new Date("2026-08-27T12:01:02.999Z");

test("a confirmed-release recording failure propagates and never claims evidence was stored", async () => {
  let writes = 0;
  const db = {
    task: { findFirst: async () => ({ id: "tail-task" }) },
    taskActivity: {
      createMany: async () => {
        writes += 1;
        throw new Error("database unavailable");
      },
    },
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
  let lookups = 0;
  let writes = 0;
  const db = {
    task: { findFirst: async () => { lookups += 1; return { id: "tail-task" }; } },
    taskActivity: { createMany: async () => { writes += 1; return { count: 1 }; } },
  } as unknown as PrismaClient;

  assert.equal(await recordMergeLeaseHold(db, target, { outcome: "not-held" }, releasedAt), "ignored");
  assert.equal(lookups, 0);
  assert.equal(writes, 0);
});
