import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  MERGE_TAIL_KIND,
  PrismaClient,
  recordLeaseDeferral,
  recordLeaseHandoff,
  RunStatus,
  settleLeaseEvent,
} from "@anneal/db";

import { deferredLeaseReleases, leaseHandoffsWithoutConsumer } from "./merge-lease.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
let sequence = 0;

before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const seedProject = async () => {
  sequence += 1;
  const suffix = `${process.pid}-${sequence}`;
  const project = await db.project.create({
    data: { name: `Lease ledger ${suffix}`, slug: `lease-ledger-${suffix}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: `agent-${suffix}`,
    title: "Ledger agent",
    model: "claude-opus-5:high",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  return { project, agent, suffix };
};

const seedTask = async (
  fixture: Awaited<ReturnType<typeof seedProject>>,
  label: string,
) => {
  const chainId = `${label}-${fixture.suffix}`;
  const task = await db.task.create({ data: {
    projectId: fixture.project.id,
    name: label,
    description: "merge Lease ledger fixture",
    chainId,
    chainIndex: 1,
    chainLayer: 1,
  } });
  return { task, target: { projectId: fixture.project.id, chainId } };
};

const seedRun = async (
  fixture: Awaited<ReturnType<typeof seedProject>>,
  taskId: string,
  label: string,
  at: Date,
  status: RunStatus = RunStatus.QUEUED,
) => db.run.create({ data: {
  projectId: fixture.project.id,
  taskId,
  agentId: fixture.agent.id,
  runNumber: 1,
  dedupeKey: `${label}-${fixture.suffix}`,
  status,
  runner: "CLAUDE",
  model: fixture.agent.model,
  readyAt: at,
  createdAt: at,
  ...(status === RunStatus.QUEUED ? {} : {
    runnerId: `runner-${label}`,
    fencingToken: `fence-${label}-${fixture.suffix}`,
    leaseGeneration: 1,
    claimedAt: at,
  }),
} });

test("ledger readers drive both bounded sweeps with real rows and strict staleness floors", async () => {
  const fixture = await seedProject();
  const now = new Date("2026-08-29T12:02:00.000Z");
  const handoffFloor = new Date(now.getTime() - 60_000);
  const old = new Date("2026-08-29T12:00:00.000Z");

  const stranded = await seedTask(fixture, "stranded");
  const strandedRun = await seedRun(fixture, stranded.task.id, "stranded", old);
  const strandedEvent = await db.$transaction((tx) => recordLeaseHandoff(tx, {
    target: stranded.target,
    toRunId: strandedRun.id,
    at: new Date(handoffFloor.getTime() - 1),
  }));

  const consumed = await seedTask(fixture, "consumed");
  const consumedRun = await seedRun(fixture, consumed.task.id, "consumed", old, RunStatus.CLAIMED);
  await db.$transaction((tx) => recordLeaseHandoff(tx, {
    target: consumed.target,
    toRunId: consumedRun.id,
    at: new Date(handoffFloor.getTime() - 1),
  }));

  const edge = await seedTask(fixture, "edge");
  const edgeRun = await seedRun(fixture, edge.task.id, "edge", old);
  await db.$transaction((tx) => recordLeaseHandoff(tx, {
    target: edge.target,
    toRunId: edgeRun.id,
    at: handoffFloor,
  }));

  const deferred = await seedTask(fixture, "deferred");
  const deferredEvent = await db.$transaction((tx) => recordLeaseDeferral(tx, {
    target: deferred.target,
    taskId: deferred.task.id,
    failureDetail: "release transport unreachable",
    at: new Date(now.getTime() - 1),
  }));

  const settled = await seedTask(fixture, "settled");
  const settledEvent = await db.$transaction((tx) => recordLeaseDeferral(tx, {
    target: settled.target,
    taskId: settled.task.id,
    failureDetail: "release transport unreachable",
    at: old,
  }));
  await db.$transaction((tx) => settleLeaseEvent(tx, {
    eventId: settledEvent.event.id,
    state: "released",
    at: new Date("2026-08-29T12:00:30.000Z"),
  }));

  const deferredEdge = await seedTask(fixture, "deferred-edge");
  await db.$transaction((tx) => recordLeaseDeferral(tx, {
    target: deferredEdge.target,
    taskId: deferredEdge.task.id,
    failureDetail: "edge",
    at: now,
  }));

  assert.deepEqual(await db.$transaction((tx) => leaseHandoffsWithoutConsumer(tx, now)), [{
    eventId: strandedEvent.event.id,
    target: stranded.target,
    taskId: stranded.task.id,
    toRunId: strandedRun.id,
  }]);
  assert.deepEqual(await db.$transaction((tx) => deferredLeaseReleases(tx, now)), [{
    eventId: deferredEvent.event.id,
    target: deferred.target,
    taskId: deferred.task.id,
  }]);
});

test("recording the same handoff twice is a no-op on semantic keys", async () => {
  const fixture = await seedProject();
  const seeded = await seedTask(fixture, "replay");
  const run = await seedRun(fixture, seeded.task.id, "replay", new Date("2026-08-29T12:00:00.000Z"));
  const input = { target: seeded.target, toRunId: run.id, at: new Date("2026-08-29T12:00:30.000Z") };

  const first = await db.$transaction((tx) => recordLeaseHandoff(tx, input));
  const replay = await db.$transaction((tx) => recordLeaseHandoff(tx, input));

  assert.equal(first.recorded, true);
  assert.equal(replay.recorded, false);
  assert.equal(replay.event.id, first.event.id);
  assert.equal(await db.mergeLeaseEvent.count({ where: seeded.target }), 1);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: seeded.task.id,
    metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHandoff },
  } }), 1);
  assert.doesNotMatch(first.event.id, /^merge-lease-hold:/u);
});

test("one settlement cannot have both an open handoff and an open deferral", async () => {
  const fixture = await seedProject();
  const seeded = await seedTask(fixture, "exclusive");
  const run = await seedRun(fixture, seeded.task.id, "exclusive", new Date("2026-08-29T12:00:00.000Z"));
  await db.$transaction((tx) => recordLeaseHandoff(tx, {
    target: seeded.target,
    toRunId: run.id,
    at: new Date("2026-08-29T12:00:30.000Z"),
  }));

  await assert.rejects(
    db.$transaction((tx) => recordLeaseDeferral(tx, {
      target: seeded.target,
      taskId: seeded.task.id,
      failureDetail: "must not coexist",
      at: new Date("2026-08-29T12:00:40.000Z"),
    })),
    /already has another unresolved event/u,
  );
  assert.equal(await db.mergeLeaseEvent.count({ where: seeded.target }), 1);
});
