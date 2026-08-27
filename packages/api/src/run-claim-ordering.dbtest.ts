import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, PrismaClient, RunStatus, TaskStatus } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "run-claim-ordering-runner-token";
const EARLIER = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-02T00:00:00.000Z");

let db: PrismaClient;
const priorRunnerToken = process.env.RUNNER_TOKEN;

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

const seedExecutor = async () => {
  const suffix = randomUUID();
  const project = await db.project.create({ data: {
    name: `Run claim ordering ${suffix}`,
    slug: `run-claim-ordering-${suffix}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "ordering-agent",
    title: "Ordering agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "ordering-repo",
    remoteUrl: "https://example.test/run-claim-ordering.git",
    mountPath: "/repo",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  return { project, agent, repo };
};

type Executor = Awaited<ReturnType<typeof seedExecutor>>;

const seedChain = async (
  executor: Executor,
  statuses: TaskStatus[],
  queuedIndex: number,
  readyAt: Date,
) => {
  const chainId = `claim-ordering-${randomUUID()}`;
  const tasks = statuses.map((status, chainIndex) => ({
    id: randomUUID(),
    projectId: executor.project.id,
    repoId: executor.repo.id,
    assigneeAgentId: executor.agent.id,
    chainId,
    chainIndex,
    chainLayer: chainIndex,
    name: `Chain ${chainId} step ${chainIndex + 1}`,
    description: "Run claim priority fixture",
    status,
  }));
  await db.task.createMany({ data: tasks });
  const queuedTask = tasks[queuedIndex];
  assert.ok(queuedTask);
  const run = await db.$transaction((tx) => enqueueTaskRun(tx, queuedTask.id, readyAt));
  return { chainId, tasks, queuedTask, run };
};

const seedChainless = async (executor: Executor, readyAt: Date) => {
  const task = await db.task.create({ data: {
    projectId: executor.project.id,
    repoId: executor.repo.id,
    assigneeAgentId: executor.agent.id,
    name: "Chainless repair",
    description: "One-off run claim priority fixture",
  } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx, task.id, readyAt));
  return { task, run };
};

const claim = async (runnerId: string) => {
  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
  });
  if (response.status !== 200) assert.fail(`claim returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<{ run: { id: string; taskId: string } }>;
};

test("a chain with one unfinished task preempts an earlier-ready chain with six", async () => {
  const executor = await seedExecutor();
  const long = await seedChain(
    executor,
    Array.from({ length: 6 }, () => TaskStatus.TODO),
    0,
    EARLIER,
  );
  const nearlyDone = await seedChain(
    executor,
    [TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.TODO],
    5,
    LATER,
  );

  const claimed = await claim("remaining-work-runner");

  assert.equal(claimed.run.id, nearlyDone.run.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: long.run.id } })).status, RunStatus.QUEUED);
});

test("an early-step rerun inherits the remaining work of its nearly-done chain", async () => {
  const executor = await seedExecutor();
  const fresh = await seedChain(
    executor,
    Array.from({ length: 6 }, () => TaskStatus.TODO),
    0,
    EARLIER,
  );
  const nearlyDone = await seedChain(
    executor,
    [TaskStatus.TODO, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE],
    0,
    LATER,
  );
  await db.run.update({ where: { id: nearlyDone.run.id }, data: {
    status: RunStatus.FAILED,
    endedAt: new Date("2026-01-01T12:00:00.000Z"),
  } });
  const rerun = await db.$transaction((tx) => enqueueTaskRun(tx, nearlyDone.queuedTask.id, LATER));

  const claimed = await claim("rerun-priority-runner");

  assert.equal(rerun.runNumber, 2, "fixture must exercise a rerun of the early task");
  assert.equal(claimed.run.id, rerun.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: fresh.run.id } })).status, RunStatus.QUEUED);
});

test("a chainless run beyond the old 20-candidate window preempts long chains", async () => {
  const executor = await seedExecutor();
  const longRunIds: string[] = [];
  for (let index = 0; index < 21; index += 1) {
    const longChain = await seedChain(
      executor,
      Array.from({ length: 6 }, () => TaskStatus.TODO),
      0,
      EARLIER,
    );
    longRunIds.push(longChain.run.id);
  }
  const chainless = await seedChainless(executor, LATER);

  const claimed = await claim("chainless-priority-runner");

  assert.equal(claimed.run.id, chainless.run.id);
  assert.equal(
    await db.run.count({ where: { id: { in: longRunIds }, status: RunStatus.QUEUED } }),
    longRunIds.length,
  );
});
