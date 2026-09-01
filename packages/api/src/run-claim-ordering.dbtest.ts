import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { DependencyProvisioning, enqueueTaskRun, PrismaClient, RunStatus, TaskStatus } from "@anneal/db";

import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "run-claim-ordering-runner-token";
const EXECUTOR_TOKEN = "run-claim-ordering-executor-token";
const EXECUTOR_RUNNER = "merge-executor-ordering";
const EARLIER = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-02T00:00:00.000Z");

let db: PrismaClient;
const priorEnvironment = {
  runner: process.env.RUNNER_TOKEN,
  executorToken: process.env.MERGE_EXECUTOR_TOKEN,
  executorRunnerIds: process.env.MERGE_EXECUTOR_RUNNER_IDS,
};

before(() => {
  process.env.RUNNER_TOKEN = RUNNER_TOKEN;
  process.env.MERGE_EXECUTOR_TOKEN = EXECUTOR_TOKEN;
  process.env.MERGE_EXECUTOR_RUNNER_IDS = EXECUTOR_RUNNER;
  db = setupTestDb();
});
beforeEach(async () => { await resetTestDb(db); });
after(async () => {
  await db.$disconnect();
  for (const [key, value] of [
    ["RUNNER_TOKEN", priorEnvironment.runner],
    ["MERGE_EXECUTOR_TOKEN", priorEnvironment.executorToken],
    ["MERGE_EXECUTOR_RUNNER_IDS", priorEnvironment.executorRunnerIds],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
    dependencyProvisioning: DependencyProvisioning.NONE,
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
  return { tasks, queuedTask, run };
};

const seedChainless = async (executor: Executor, readyAt: Date) => {
  const task = await db.task.create({ data: {
    projectId: executor.project.id,
    repoId: executor.repo.id,
    assigneeAgentId: executor.agent.id,
    name: `Chainless ${randomUUID()}`,
    description: "One-off run claim priority fixture",
  } });
  const run = await db.$transaction((tx) => enqueueTaskRun(tx, task.id, readyAt));
  return { task, run };
};

const claim = async (runnerId: string, token = RUNNER_TOKEN) => {
  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
  });
  if (response.status !== 200) assert.fail(`claim returned ${response.status}: ${await response.text()}`);
  return response.json() as Promise<{ run: { id: string; taskId: string } }>;
};

test("a nearly complete chain preempts an earlier-ready new chain", async () => {
  const executor = await seedExecutor();
  const fresh = await seedChain(executor, Array.from({ length: 6 }, () => TaskStatus.TODO), 0, EARLIER);
  const nearlyDone = await seedChain(
    executor,
    [TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.TODO],
    5,
    LATER,
  );

  const claimed = await claim("remaining-work-runner");

  assert.equal(claimed.run.id, nearlyDone.run.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: fresh.run.id } })).status, RunStatus.QUEUED);
});

test("an early-step rerun inherits its owning chain priority", async () => {
  const executor = await seedExecutor();
  const fresh = await seedChain(executor, Array.from({ length: 6 }, () => TaskStatus.TODO), 0, EARLIER);
  const nearlyDone = await seedChain(
    executor,
    [TaskStatus.TODO, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE, TaskStatus.DONE],
    0,
    LATER,
  );
  await db.run.update({
    where: { id: nearlyDone.run.id },
    data: { status: RunStatus.FAILED, endedAt: new Date("2026-01-01T12:00:00.000Z") },
  });
  const rerun = await db.$transaction((tx) => enqueueTaskRun(tx, nearlyDone.queuedTask.id, LATER));

  const claimed = await claim("rerun-priority-runner");

  assert.equal(rerun.runNumber, 2);
  assert.equal(claimed.run.id, rerun.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: fresh.run.id } })).status, RunStatus.QUEUED);
});

test("a chainless task ranks as one unfinished task", async () => {
  const executor = await seedExecutor();
  const twoUnfinished = await seedChain(executor, [TaskStatus.TODO, TaskStatus.TODO], 0, EARLIER);
  const oneUnfinished = await seedChain(executor, [TaskStatus.DONE, TaskStatus.TODO], 1, EARLIER);
  const chainless = await seedChainless(executor, LATER);

  const first = await claim("chainless-priority-runner-1");
  const second = await claim("chainless-priority-runner-2");

  assert.equal(first.run.id, oneUnfinished.run.id, "chainless ties a one-unfinished chain behind FIFO");
  assert.equal(second.run.id, chainless.run.id, "chainless outranks a two-unfinished chain");
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: twoUnfinished.run.id } })).status, RunStatus.QUEUED);
});

test("equal chain priorities retain readyAt then createdAt FIFO ordering", async () => {
  const executor = await seedExecutor();
  const laterReady = await seedChainless(executor, LATER);
  const laterCreated = await seedChainless(executor, EARLIER);
  const earlierCreated = await seedChainless(executor, EARLIER);
  await db.run.update({ where: { id: laterCreated.run.id }, data: { createdAt: LATER } });
  await db.run.update({ where: { id: earlierCreated.run.id }, data: { createdAt: EARLIER } });

  const first = await claim("fifo-runner-1");
  const second = await claim("fifo-runner-2");

  assert.equal(first.run.id, earlierCreated.run.id, "createdAt breaks equal-readyAt ties");
  assert.equal(second.run.id, laterCreated.run.id, "readyAt remains ahead of a later-ready candidate");
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: laterReady.run.id } })).status, RunStatus.QUEUED);
});

test("priority is established before the candidate list is truncated to twenty", async () => {
  const executor = await seedExecutor();
  const earlierRunIds: string[] = [];
  for (let index = 0; index < 21; index += 1) {
    const chain = await seedChain(executor, [TaskStatus.TODO, TaskStatus.TODO], 0, EARLIER);
    earlierRunIds.push(chain.run.id);
  }
  const highPriority = await seedChain(executor, [TaskStatus.TODO], 0, LATER);

  const claimed = await claim("window-priority-runner");

  assert.equal(claimed.run.id, highPriority.run.id);
  assert.equal(
    await db.run.count({ where: { id: { in: earlierRunIds }, status: RunStatus.QUEUED } }),
    earlierRunIds.length,
  );
});

test("merge-executor-only runs cannot consume the general candidate window", async () => {
  const executor = await seedExecutor();
  const agentChain = await seedChain(executor, [TaskStatus.TODO, TaskStatus.TODO], 0, EARLIER);
  const mechanicalRunIds: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const mechanical = await seedIntegratorChain(db, { label: `general-lane-mechanical-${index}` });
    assert.ok(mechanical.integratorTask);
    await db.task.update({ where: { id: mechanical.gateTask.id }, data: { status: TaskStatus.DONE } });
    const run = await db.$transaction((tx) => enqueueTaskRun(tx, mechanical.integratorTask!.id, LATER));
    mechanicalRunIds.push(run.id);
  }

  const claimed = await claim("general-lane-runner");

  assert.equal(claimed.run.id, agentChain.run.id);
  assert.equal(
    await db.run.count({ where: { id: { in: mechanicalRunIds }, status: RunStatus.QUEUED } }),
    mechanicalRunIds.length,
  );
});

test("merge-executor claims retain FIFO ordering instead of chain priority", async () => {
  const earlier = await seedIntegratorChain(db, { label: "executor-fifo-earlier" });
  const later = await seedIntegratorChain(db, { label: "executor-fifo-later" });
  assert.ok(earlier.integratorTask);
  assert.ok(later.integratorTask);
  await db.task.update({ where: { id: later.gateTask.id }, data: { status: TaskStatus.DONE } });
  const earlierRun = await db.$transaction((tx) => enqueueTaskRun(tx, earlier.integratorTask!.id, EARLIER));
  const laterRun = await db.$transaction((tx) => enqueueTaskRun(tx, later.integratorTask!.id, LATER));

  const claimed = await claim(EXECUTOR_RUNNER, EXECUTOR_TOKEN);

  assert.equal(claimed.run.id, earlierRun.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: laterRun.id } })).status, RunStatus.QUEUED);
});
