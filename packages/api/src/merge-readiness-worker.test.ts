import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@anneal/db";

import {
  READINESS_CLAIM_LEASE_MS,
  READINESS_READ_BUDGET_MS,
  startReadinessWorker,
} from "./merge-readiness-worker.js";

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("the renewed readiness claim covers both the read budget and a lease acquire timeout", () => {
  assert.equal(READINESS_READ_BUDGET_MS, 20_000);
  assert.equal(READINESS_CLAIM_LEASE_MS, 60_000);
  assert.ok(READINESS_READ_BUDGET_MS + 30_000 < READINESS_CLAIM_LEASE_MS);
});

test("the readiness worker never overlaps ticks in one process", async () => {
  const previousInterval = process.env.MERGE_READINESS_POLL_INTERVAL_MS;
  process.env.MERGE_READINESS_POLL_INTERVAL_MS = "250";
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const db = {
    mergeRecoveryAttempt: { findMany: async () => [] },
    task: {
      findMany: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await wait(350);
        active -= 1;
        return [];
      },
    },
  } as unknown as PrismaClient;
  const timer = startReadinessWorker(db, null);
  try {
    await wait(800);
  } finally {
    clearInterval(timer);
    if (previousInterval === undefined) delete process.env.MERGE_READINESS_POLL_INTERVAL_MS;
    else process.env.MERGE_READINESS_POLL_INTERVAL_MS = previousInterval;
  }
  await wait(400);
  assert.ok(calls >= 2);
  assert.equal(maximumActive, 1);
});
