import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  enqueueTaskRun,
  PrismaClient,
} from "@anneal/db";

import { schedulerTick } from "./scheduler.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const seedExecutor = async () => {
  const project = await db.project.create({ data: { name: "Enqueue barrier", slug: `enqueue-barrier-${Date.now()}-${Math.random()}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "agent",
    title: "Agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "repo",
    remoteUrl: "https://example.test/repo.git",
    mountPath: "/repo",
  } });
  return { project, agent, repo };
};

const due = new Date("2026-08-28T12:00:00.000Z");

const scheduledTask = async (
  seed: Awaited<ReturnType<typeof seedExecutor>>,
  options: { chainId?: string | null; chainIndex?: number | null; chainLayer?: number | null } = {},
) => db.task.create({ data: {
  projectId: seed.project.id,
  assigneeAgentId: seed.agent.id,
  repoId: seed.repo.id,
  name: options.chainId ? `${options.chainId}-${options.chainIndex}` : "scheduled",
  description: "scheduled work",
  scheduleKind: "AT",
  runAt: new Date(due.getTime() - 60_000),
  chainId: options.chainId ?? null,
  chainIndex: options.chainIndex ?? null,
  chainLayer: options.chainLayer ?? null,
} });

const hold = async (
  projectId: string,
  chainId: string,
  heldLayer: number,
  state: ChainControlState = ChainControlState.HELD,
) => db.chainControl.create({ data: {
  projectId,
  chainId,
  state,
  heldLayer,
  holdRequestId: state === ChainControlState.HELD ? "hold-test" : null,
  holdGeneration: state === ChainControlState.HELD ? 1 : 0,
} });

test("a due AT task above a held layer stays eligible and creates no run or activity", async () => {
  const seed = await seedExecutor();
  const task = await scheduledTask(seed, { chainId: "held-chain", chainIndex: 2, chainLayer: 2 });
  await hold(seed.project.id, task.chainId!, 1);

  assert.deepEqual(await schedulerTick(db, due), { cronFired: 0, atFired: 0, quarantined: 0 });
  const refreshed = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(refreshed.runAt?.toISOString(), task.runAt?.toISOString(), "the due schedule remains retryable");
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 0, "the barrier refuses before Run creation");
  assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0, "refusal writes no queue narration");
});

test("a due AT task at the held layer queues exactly once, and a released held chain queues its barred successor", async () => {
  const seed = await seedExecutor();
  const current = await scheduledTask(seed, { chainId: "held-chain", chainIndex: 1, chainLayer: 1 });
  const later = await scheduledTask(seed, { chainId: "held-chain", chainIndex: 2, chainLayer: 2 });
  await hold(seed.project.id, current.chainId!, 1);

  assert.deepEqual(await schedulerTick(db, due), { cronFired: 0, atFired: 1, quarantined: 0 });
  assert.equal(await db.run.count({ where: { taskId: current.id } }), 1);
  assert.equal(await db.run.count({ where: { taskId: later.id } }), 0);

  // The current layer remains ordinary work while the hold stands; a second
  // poll cannot mint a duplicate Run for the same one-shot schedule.
  assert.deepEqual(await schedulerTick(db, due), { cronFired: 0, atFired: 0, quarantined: 0 });
  assert.equal(await db.run.count({ where: { taskId: current.id } }), 1);

  await db.chainControl.update({
    where: { projectId_chainId: { projectId: seed.project.id, chainId: current.chainId! } },
    data: { state: ChainControlState.RELEASED, releasedAt: new Date(due.getTime() + 1_000), releaseRequestId: "resume-test" },
  });
  assert.deepEqual(await schedulerTick(db, due), { cronFired: 0, atFired: 1, quarantined: 0 });
  const laterRuns = await db.run.findMany({
    where: { taskId: later.id },
    orderBy: { runNumber: "asc" },
    include: { session: true },
  });
  assert.equal(laterRuns.length, 1, "release creates exactly one new Run");
  const [freshRun] = laterRuns;
  assert.ok(freshRun);
  assert.equal(freshRun.runNumber, 1);
  assert.equal(freshRun.status, "QUEUED");
  assert.equal(freshRun.session, null, "release creates a fresh queued Run, not a provider session");
  assert.equal(await db.session.count({ where: { runId: freshRun.id } }), 0, "the fresh Run has no provider conversation attachment");
  assert.deepEqual(await schedulerTick(db, due), { cronFired: 0, atFired: 0, quarantined: 0 });
  assert.equal(await db.run.count({ where: { taskId: later.id } }), 1, "the released schedule is still one-shot");
});

test("the shared producer gate preserves unheld, released, and chainless scheduled tasks", async () => {
  const seed = await seedExecutor();
  const unheld = await scheduledTask(seed, { chainId: "unheld-chain", chainIndex: 1, chainLayer: 1 });
  const released = await scheduledTask(seed, { chainId: "released-chain", chainIndex: 1, chainLayer: 1 });
  const chainless = await scheduledTask(seed);
  await hold(seed.project.id, released.chainId!, 1, ChainControlState.RELEASED);

  for (const task of [unheld, released, chainless]) {
    const run = await db.$transaction((tx) => enqueueTaskRun(tx, task.id, due));
    assert.equal(run.taskId, task.id);
  }
  assert.equal(await db.run.count({ where: { taskId: unheld.id } }), 1);
  assert.equal(await db.run.count({ where: { taskId: released.id } }), 1);
  assert.equal(await db.run.count({ where: { taskId: chainless.id } }), 1);
});

test("a direct producer cannot bypass the held-layer gate", async () => {
  const seed = await seedExecutor();
  const task = await scheduledTask(seed, { chainId: "held-chain", chainIndex: 3, chainLayer: 3 });
  await hold(seed.project.id, task.chainId!, 2);

  await assert.rejects(
    () => db.$transaction((tx) => enqueueTaskRun(tx, task.id, due)),
    /held.*layer|layer.*held/u,
  );
  assert.equal(await db.run.count({ where: { taskId: task.id } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0);
});

test("a direct producer fails closed when both Chain execution fields are null", async () => {
  const seed = await seedExecutor();
  await db.$executeRawUnsafe('ALTER TABLE "Task" DROP CONSTRAINT "Task_chain_identity_all_or_none_check"');
  try {
    const task = await scheduledTask(seed, { chainId: "held-chain", chainIndex: null, chainLayer: null });
    await hold(seed.project.id, task.chainId!, 1);

    await assert.rejects(
      () => db.$transaction((tx) => enqueueTaskRun(tx, task.id, due)),
      /Chain .* is held; Task .* cannot queue a Run/u,
    );
    assert.equal(await db.run.count({ where: { taskId: task.id } }), 0);
    assert.equal(await db.taskActivity.count({ where: { taskId: task.id } }), 0);
  } finally {
    await resetTestDb(db);
    await db.$executeRawUnsafe(`ALTER TABLE "Task"
      ADD CONSTRAINT "Task_chain_identity_all_or_none_check" CHECK (
        ("chainId" IS NULL AND "chainIndex" IS NULL AND "chainLayer" IS NULL)
        OR
        ("chainId" IS NOT NULL AND "chainIndex" IS NOT NULL AND "chainLayer" IS NOT NULL)
      )`);
  }
});
