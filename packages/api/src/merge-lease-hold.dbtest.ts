import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { MERGE_TAIL_KIND, PrismaClient } from "@anneal/db";

import {
  recordMergeLeaseHold,
  type MergeLeaseTarget,
} from "./merge-lease-hold.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let sequence = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const unique = (label: string): string => {
  sequence += 1;
  return `${label}-${process.pid}-${Date.now()}-${sequence}`;
};

const seedProjectTask = async (chainId: string, chainIndex: number) => {
  const project = await db.project.create({ data: { name: unique("Lease project"), slug: unique("lease-project") } });
  const task = await db.task.create({ data: {
    projectId: project.id,
    name: "Merge tail",
    description: "lease hold fixture",
    chainId,
    chainIndex,
    chainLayer: chainIndex,
  } });
  return { project, task };
};

const release = (sha: string) => ({
  outcome: "released" as const,
  ref: "refs/merge-lease/holder",
  sha,
  acquiredAt: "2026-08-27T12:00:00.250Z",
});

test("lease hold attribution is project-scoped when projects share a chain id", async () => {
  const chainId = unique("shared-chain");
  const first = await seedProjectTask(chainId, 1);
  const second = await seedProjectTask(chainId, 2);
  const targetOne: MergeLeaseTarget = { projectId: first.project.id, chainId };
  const targetTwo: MergeLeaseTarget = { projectId: second.project.id, chainId };
  const releasedAt = new Date("2026-08-27T12:01:02.999Z");

  assert.equal(await recordMergeLeaseHold(db, targetOne, release("same-lease-sha"), releasedAt), "recorded");
  assert.equal(await recordMergeLeaseHold(db, targetTwo, release("same-lease-sha"), releasedAt), "recorded");

  const rows = await db.taskActivity.findMany({
    where: { metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
    orderBy: { taskId: "asc" },
    select: { taskId: true, metadata: true },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((row) => row.taskId)), new Set([first.task.id, second.task.id]));
  assert.deepEqual(rows.map((row) => (row.metadata as Record<string, unknown>).chainId), [chainId, chainId]);
});

test("replaying one confirmed blob release is idempotent", async () => {
  const chainId = unique("replay-chain");
  const seeded = await seedProjectTask(chainId, 1);
  const target: MergeLeaseTarget = { projectId: seeded.project.id, chainId };
  const first = await recordMergeLeaseHold(db, target, release("replay-sha"), new Date("2026-08-27T12:01:02.999Z"));
  const replay = await recordMergeLeaseHold(db, target, release("replay-sha"), new Date("2026-08-27T12:01:20.999Z"));

  assert.equal(first, "recorded");
  assert.equal(replay, "already-recorded");
  const rows = await db.taskActivity.findMany({
    where: { taskId: seeded.task.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHold } },
  });
  assert.equal(rows.length, 1);
  assert.equal((rows[0]?.metadata as Record<string, unknown>).releasedAt, "2026-08-27T12:01:02.999Z");
});
