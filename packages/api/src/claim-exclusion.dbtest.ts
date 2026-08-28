import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  enqueueTaskRun,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "claim-exclusion-runner-token";
const EXECUTOR_TOKEN = "claim-exclusion-executor-token";
const EXECUTOR_RUNNER = "claim-exclusion-merge-executor";
const RUNNER_ID = "claim-exclusion-runner";
const EARLIER = new Date("2026-08-01T00:00:00.000Z");
const LATER = new Date("2026-08-02T00:00:00.000Z");

let db: PrismaClient;
const previousEnvironment = {
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
    ["RUNNER_TOKEN", previousEnvironment.runner],
    ["MERGE_EXECUTOR_TOKEN", previousEnvironment.executorToken],
    ["MERGE_EXECUTOR_RUNNER_IDS", previousEnvironment.executorRunnerIds],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const seedRunner = async () => {
  const suffix = randomUUID();
  const project = await db.project.create({ data: {
    name: `Claim exclusion ${suffix}`,
    slug: `claim-exclusion-${suffix}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "local",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "claim-exclusion-agent",
    title: "Claim exclusion agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "claim-exclusion-repo",
    remoteUrl: "https://example.test/claim-exclusion.git",
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

type RunnerSeed = Awaited<ReturnType<typeof seedRunner>>;

const seedChain = async (
  owner: RunnerSeed,
  layers: number[],
  statuses = layers.map(() => TaskStatus.TODO),
) => {
  assert.equal(layers.length, statuses.length);
  const chainId = `claim-exclusion-${randomUUID()}`;
  const tasks = layers.map((layer, index) => ({
    id: randomUUID(),
    projectId: owner.project.id,
    repoId: owner.repo.id,
    assigneeAgentId: owner.agent.id,
    chainId,
    chainIndex: index,
    chainLayer: layer,
    name: `Claim exclusion step ${index + 1}`,
    description: "Claim exclusion fixture",
    status: statuses[index]!,
  }));
  await db.task.createMany({ data: tasks });
  return { chainId, tasks };
};

const queue = async (taskId: string, readyAt = EARLIER) => db.$transaction((tx) => enqueueTaskRun(tx, taskId, readyAt));

const hold = async (projectId: string, chainId: string, heldLayer: number) => db.chainControl.create({
  data: { projectId, chainId, state: ChainControlState.HELD, heldLayer, holdGeneration: 1 },
});

const release = async (projectId: string, chainId: string) => db.chainControl.update({
  where: { projectId_chainId: { projectId, chainId } },
  data: { state: ChainControlState.RELEASED },
});

const claim = async (
  runnerId = RUNNER_ID,
  token = RUNNER_TOKEN,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(db).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null) as any,
  };
};

test("ordinary runners exclude above-layer held Runs while an unheld Chain remains claimable", async () => {
  const owner = await seedRunner();
  const held = await seedChain(owner, [1, 2]);
  const unheld = await seedChain(owner, [1]);
  const barred = await queue(held.tasks[1]!.id, EARLIER);
  const allowed = await queue(unheld.tasks[0]!.id, LATER);
  await hold(owner.project.id, held.chainId, 1);

  const claimed = await claim();

  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.run.id, allowed.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: barred.id } })).status, RunStatus.QUEUED);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: allowed.id } })).status, RunStatus.CLAIMED);
});

test("ordinary runners still claim held-Chain Runs at or below the held layer", async () => {
  const owner = await seedRunner();
  const chain = await seedChain(owner, [1, 2, 3]);
  const lower = await queue(chain.tasks[0]!.id, EARLIER);
  const heldLayer = await queue(chain.tasks[1]!.id, LATER);
  const barred = await queue(chain.tasks[2]!.id, LATER);
  await hold(owner.project.id, chain.chainId, 2);

  const first = await claim("claim-at-layer-runner-1");
  const second = await claim("claim-at-layer-runner-2");

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.run.id, lower.id);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.run.id, heldLayer.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: barred.id } })).status, RunStatus.QUEUED);
});

test("releasing the authority makes a queued barred Run claimable without creating another Run", async () => {
  const owner = await seedRunner();
  const chain = await seedChain(owner, [1, 2]);
  const barred = await queue(chain.tasks[1]!.id);
  await hold(owner.project.id, chain.chainId, 1);

  const heldPoll = await claim("claim-release-runner-held");
  assert.equal(heldPoll.status, 204);
  assert.equal(await db.run.count(), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: barred.id } })).status, RunStatus.QUEUED);

  await release(owner.project.id, chain.chainId);
  const releasedPoll = await claim("claim-release-runner-released");

  assert.equal(releasedPoll.status, 200, JSON.stringify(releasedPoll.body));
  assert.equal(releasedPoll.body.run.id, barred.id);
  assert.equal(await db.run.count(), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: barred.id } })).status, RunStatus.CLAIMED);
});

test("merge-executor claims apply the same held-layer exclusion and see release without a new Run", async () => {
  const chain = await seedIntegratorChain(db, { label: "claim-exclusion-merge" });
  assert.ok(chain.integratorTask);
  const run = await queue(chain.integratorTask.id);
  const layer = chain.integratorTask.chainLayer ?? chain.integratorTask.chainIndex;
  assert.ok(layer !== null);
  await hold(chain.project.id, chain.chainId, layer - 1);

  const heldPoll = await claim(EXECUTOR_RUNNER, EXECUTOR_TOKEN);
  assert.equal(heldPoll.status, 204);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.QUEUED);

  await release(chain.project.id, chain.chainId);
  const releasedPoll = await claim(EXECUTOR_RUNNER, EXECUTOR_TOKEN);

  assert.equal(releasedPoll.status, 200, JSON.stringify(releasedPoll.body));
  assert.equal(releasedPoll.body.run.id, run.id);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask.id } }), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.CLAIMED);
});

test("filtering barred candidates before the ranked window preserves allowed-run ordering", async () => {
  const owner = await seedRunner();
  // Twenty barred candidates are deliberately earlier than the allowed one.
  // They occupy the raw runner window if the hold predicate is applied after
  // LIMIT, starving both allowed candidates. The two allowed candidates must
  // still be ordered by the ordinary chain-priority/readyAt rules.
  const barredChain = await seedChain(owner, [1, ...Array.from({ length: 20 }, (_, index) => index + 2)]);
  const allowed = await queue(barredChain.tasks[0]!.id, LATER);
  const barredRuns: Array<{ id: string }> = [];
  for (const task of barredChain.tasks.slice(1)) barredRuns.push(await queue(task.id, EARLIER));
  await hold(owner.project.id, barredChain.chainId, 1);

  const secondChain = await seedChain(owner, [1, 2], [TaskStatus.TODO, TaskStatus.TODO]);
  const second = await queue(secondChain.tasks[0]!.id, LATER);

  const first = await claim("claim-ranking-runner-1");
  const next = await claim("claim-ranking-runner-2");

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.run.id, second.id);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.run.id, allowed.id);
  assert.equal(
    await db.run.count({ where: { id: { in: barredRuns.map(({ id }) => id) }, status: RunStatus.QUEUED } }),
    20,
  );
});
