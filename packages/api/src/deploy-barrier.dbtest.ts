import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  DEPLOY_BARRIER_CLASS,
  DEPLOY_BARRIER_KEY,
  deployBarrierAllowsClaim,
  PrismaClient,
} from "@anneal/db";

import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
let deploy: PrismaClient;

before(async () => {
  db = setupTestDb();
  const pinned = new URL(testDatabaseUrl);
  pinned.searchParams.set("connection_limit", "1");
  deploy = new PrismaClient({ datasources: { db: { url: pinned.href } } });
  await deploy.$connect();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await Promise.all([db.$disconnect(), deploy.$disconnect()]); });

const takeDeployBarrier = async (): Promise<boolean> => {
  const rows = await deploy.$queryRawUnsafe<Array<{ granted: boolean }>>(
    "SELECT pg_try_advisory_lock($1::int4, $2::int4) AS granted",
    DEPLOY_BARRIER_CLASS,
    DEPLOY_BARRIER_KEY,
  );
  return rows[0]?.granted === true;
};

const releaseDeployBarrier = async (): Promise<void> => {
  await deploy.$queryRawUnsafe(
    "SELECT pg_advisory_unlock($1::int4, $2::int4)",
    DEPLOY_BARRIER_CLASS,
    DEPLOY_BARRIER_KEY,
  );
};

test("exclusive deploy barrier makes every later claim fail closed", async () => {
  assert.equal(await takeDeployBarrier(), true);
  try {
    assert.equal(await db.$transaction((tx) => deployBarrierAllowsClaim(tx as never)), false);
    assert.equal(await db.$transaction((tx) => deployBarrierAllowsClaim(tx as never)), false);
  } finally {
    await releaseDeployBarrier();
  }
  assert.equal(await db.$transaction((tx) => deployBarrierAllowsClaim(tx as never)), true);
});

test("an in-flight claim transaction serializes before deploy acquisition", async () => {
  let releaseClaim = (): void => undefined;
  const holdClaim = new Promise<void>((resolve) => { releaseClaim = resolve; });
  let claimReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => { claimReady = resolve; });
  const claim = db.$transaction(async (tx) => {
    assert.equal(await deployBarrierAllowsClaim(tx as never), true);
    claimReady();
    await holdClaim;
  });
  await ready;
  assert.equal(await takeDeployBarrier(), false);
  releaseClaim();
  await claim;
  assert.equal(await takeDeployBarrier(), true);
  await releaseDeployBarrier();
});
