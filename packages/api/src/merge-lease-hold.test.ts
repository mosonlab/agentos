import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import {
  mergeLeaseHold,
  recordMergeLeaseHold,
  type MergeLeaseTarget,
} from "./merge-lease-hold.js";

const target: MergeLeaseTarget = { projectId: "project-1", chainId: "chain-1" };
const releasedAt = new Date("2026-08-27T12:01:02.999Z");

test("mergeLeaseHold records whole elapsed seconds and clamps clock skew", () => {
  const acquiredAt = "2026-08-27T12:00:00.250Z";
  assert.deepEqual(mergeLeaseHold(acquiredAt, releasedAt), {
    acquiredAt: new Date(acquiredAt),
    releasedAt,
    heldForSeconds: 62,
  });
  assert.equal(
    mergeLeaseHold(acquiredAt, new Date("2026-08-27T11:59:59.999Z"))?.heldForSeconds,
    0,
  );
  assert.equal(mergeLeaseHold("not-a-date", releasedAt), null);
  assert.equal(mergeLeaseHold(acquiredAt, new Date(Number.NaN)), null);
});

test("recordMergeLeaseHold ignores unsuccessful releases but surfaces malformed confirmation", async () => {
  let taskLookups = 0;
  let writes = 0;
  const db = {
    task: { findFirst: async () => { taskLookups += 1; return { id: "tail-task" }; } },
    taskActivity: { createMany: async () => { writes += 1; return { count: 1 }; } },
  } as unknown as PrismaClient;

  assert.equal(await recordMergeLeaseHold(db, target, { outcome: "not-held" }, releasedAt), "ignored");
  assert.equal(await recordMergeLeaseHold(db, target, { outcome: "skipped", heldFor: "chain-2" }, releasedAt), "ignored");
  assert.equal(await recordMergeLeaseHold(db, target, { outcome: "refused", heldBy: "other" }, releasedAt), "ignored");
  assert.equal(await recordMergeLeaseHold(db, target, { outcome: "unreachable", detail: "offline" }, releasedAt), "ignored");
  await assert.rejects(
    recordMergeLeaseHold(db, target, {
      outcome: "released", ref: "refs/merge-lease/holder", sha: "lease-sha", acquiredAt: "invalid",
    }, releasedAt),
    /confirmed merge lease release.*invalid acquiredAt/u,
  );
  assert.equal(taskLookups, 0);
  assert.equal(writes, 0);
});

test("recordMergeLeaseHold writes the project-scoped marker payload", async () => {
  const writes: Array<Record<string, unknown>> = [];
  let query: Record<string, unknown> | undefined;
  const db = {
    task: { findFirst: async (input: Record<string, unknown>) => {
      query = input;
      return { id: "tail-task" };
    } },
    taskActivity: { createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      writes.push(...data);
      return { count: 1 };
    } },
  } as unknown as PrismaClient;

  assert.equal(await recordMergeLeaseHold(db, target, {
    outcome: "released",
    ref: "refs/merge-lease/holder",
    sha: "lease-sha",
    acquiredAt: "2026-08-27T12:00:00.250Z",
  }, releasedAt), "recorded");
  assert.deepEqual(query, {
    where: { projectId: "project-1", chainId: "chain-1", chainIndex: { not: null } },
    orderBy: [{ chainIndex: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.taskId, "tail-task");
  assert.equal(writes[0]?.actorType, "control-plane");
  assert.equal(writes[0]?.body, "Chain Lease released after 62 seconds");
  assert.deepEqual(writes[0]?.metadata, {
    kind: "mergeTail.leaseHold",
    schemaVersion: 1,
    chainId: "chain-1",
    leaseRef: "refs/merge-lease/holder",
    leaseSha: "lease-sha",
    acquiredAt: "2026-08-27T12:00:00.250Z",
    releasedAt: "2026-08-27T12:01:02.999Z",
    heldForSeconds: 62,
  });
});
