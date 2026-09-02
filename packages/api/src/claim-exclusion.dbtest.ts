import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  ChainControlState,
  DependencyProvisioning,
  enqueueTaskRun,
  lockChainRows,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";
import { heldPredicate } from "@anneal/db/chain-hold";

import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

const RUNNER_TOKEN = "claim-exclusion-runner-token";
const EXECUTOR_TOKEN = "claim-exclusion-executor-token";
const EXECUTOR_RUNNER = "claim-exclusion-merge-executor";
const RUNNER_ID = "claim-exclusion-runner";
const EARLIER = new Date("2026-08-01T00:00:00.000Z");
const LATER = new Date("2026-08-02T00:00:00.000Z");

const HOLD_FIXTURES = [
  { name: "stored layer below hold", chainLayer: 1, chainIndex: 99, heldLayer: 2, held: false },
  { name: "stored layer above hold", chainLayer: 3, chainIndex: 0, heldLayer: 2, held: true },
  { name: "legacy index below hold", chainLayer: null, chainIndex: 1, heldLayer: 2, held: false },
  { name: "legacy index above hold", chainLayer: null, chainIndex: 3, heldLayer: 2, held: true },
  { name: "missing layer and index", chainLayer: null, chainIndex: null, heldLayer: 2, held: true },
] as const;

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
  client = db,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(client).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null) as any,
  };
};

const createClient = () => new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });

const instrumentChainLockAttempt = (client: PrismaClient, attempted: () => void): PrismaClient => new Proxy(client, {
  get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumented = new Proxy(tx, {
        get(txTarget, txProperty, txReceiver) {
          if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
          return (...args: unknown[]) => {
            const query = args[0] as string[] | { strings?: string[] } | undefined;
            const sql = Array.isArray(query) ? query.join(" ") : query?.strings?.join(" ") ?? "";
            if (sql.includes('ORDER BY "chainLayer"')) attempted();
            return Reflect.apply(txTarget.$queryRaw, txTarget, args);
          };
        },
      });
      return operation(instrumented);
    }, options as any);
  },
}) as PrismaClient;

const holdWinsClaimRace = async (input: {
  projectId: string;
  chainId: string;
  heldLayer: number;
  runId: string;
  runnerId: string;
  token: string;
}) => {
  const holdClient = createClient();
  const claimClientBase = createClient();
  let releaseHold!: () => void;
  let reportHeld!: () => void;
  let reportClaimAttempt!: () => void;
  const holdGate = new Promise<void>((resolve) => { releaseHold = resolve; });
  const held = new Promise<void>((resolve) => { reportHeld = resolve; });
  const claimAttempt = new Promise<void>((resolve) => { reportClaimAttempt = resolve; });
  const claimClient = instrumentChainLockAttempt(claimClientBase, reportClaimAttempt);
  try {
    const holding = holdClient.$transaction(async (tx) => {
      await lockChainRows(tx, { projectId: input.projectId, chainId: input.chainId });
      await tx.chainControl.create({ data: {
        projectId: input.projectId,
        chainId: input.chainId,
        state: ChainControlState.HELD,
        heldLayer: input.heldLayer,
        holdGeneration: 1,
      } });
      reportHeld();
      await holdGate;
    });
    await held;
    const claiming = claim(input.runnerId, input.token, claimClient);
    await claimAttempt;
    releaseHold();
    const [claimed] = await Promise.all([claiming, holding]);
    assert.equal(claimed.status, 204, JSON.stringify(claimed.body));
  } finally {
    releaseHold();
    await Promise.all([holdClient.$disconnect(), claimClientBase.$disconnect()]);
  }
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: input.runId } })).status, RunStatus.QUEUED);
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

test("the run-claim query excludes stored layer zero under a before-first hold", async () => {
  const owner = await seedRunner();
  const chain = await seedChain(owner, [0]);
  await db.chainControl.create({ data: {
    projectId: owner.project.id,
    chainId: chain.chainId,
    state: ChainControlState.HELD,
    heldLayer: 0,
    heldExecutionLayer: null,
    holdGeneration: 1,
  } });
  const task = chain.tasks[0]!;
  const run = await db.run.create({ data: {
    projectId: owner.project.id,
    taskId: task.id,
    agentId: owner.agent.id,
    repoId: owner.repo.id,
    runNumber: 1,
    dedupeKey: `task:${task.id}:run:1`,
    status: RunStatus.QUEUED,
    runner: "CLAUDE",
    model: "claude",
    readyAt: EARLIER,
  } });

  const result = await claim("claim-before-first-zero");
  assert.equal(result.status, 204, JSON.stringify(result.body));
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.QUEUED);
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

test("shared fixtures agree across the TypeScript, Prisma, and raw SQL hold expressions", async () => {
  await db.$executeRawUnsafe('ALTER TABLE "Task" DROP CONSTRAINT "Task_chain_identity_all_or_none_check"');
  try {
    for (const fixture of HOLD_FIXTURES) {
      await resetTestDb(db);
      const ordinaryOwner = await seedRunner();
      const ordinaryChain = await seedChain(ordinaryOwner, [1]);
      const ordinaryTask = ordinaryChain.tasks[0]!;
      const ordinaryRun = await queue(ordinaryTask.id);
      await db.task.update({
        where: { id: ordinaryTask.id },
        data: { chainLayer: fixture.chainLayer, chainIndex: fixture.chainIndex },
      });
      await hold(ordinaryOwner.project.id, ordinaryChain.chainId, fixture.heldLayer);

      assert.equal(heldPredicate({
        projectId: ordinaryOwner.project.id,
        chainId: ordinaryChain.chainId,
        layer: fixture.chainLayer,
        index: fixture.chainIndex,
      }, {
        projectId: ordinaryOwner.project.id,
        chainId: ordinaryChain.chainId,
        state: ChainControlState.HELD,
        heldLayer: fixture.heldLayer,
      }), fixture.held, `${fixture.name}: TypeScript`);

      const ordinaryClaim = await claim(`raw-${fixture.name.replaceAll(" ", "-")}`);
      assert.equal(ordinaryClaim.status, fixture.held ? 204 : 200, `${fixture.name}: raw SQL`);
      if (!fixture.held) assert.equal(ordinaryClaim.body.run.id, ordinaryRun.id, `${fixture.name}: raw SQL run`);
      assert.equal(
        (await db.run.findUniqueOrThrow({ where: { id: ordinaryRun.id } })).status,
        fixture.held ? RunStatus.QUEUED : RunStatus.CLAIMED,
        `${fixture.name}: raw SQL state`,
      );

      await resetTestDb(db);
      const executorChain = await seedIntegratorChain(db, { label: `fixture-${fixture.name.replaceAll(" ", "-")}` });
      assert.ok(executorChain.integratorTask);
      const executorRun = await queue(executorChain.integratorTask.id);
      await db.task.update({
        where: { id: executorChain.integratorTask.id },
        data: { chainLayer: fixture.chainLayer, chainIndex: fixture.chainIndex },
      });
      await hold(executorChain.project.id, executorChain.chainId, fixture.heldLayer);

      const executorClaim = await claim(EXECUTOR_RUNNER, EXECUTOR_TOKEN);
      assert.equal(executorClaim.status, fixture.held ? 204 : 200, `${fixture.name}: Prisma`);
      if (!fixture.held) assert.equal(executorClaim.body.run.id, executorRun.id, `${fixture.name}: Prisma run`);
      assert.equal(
        (await db.run.findUniqueOrThrow({ where: { id: executorRun.id } })).status,
        fixture.held ? RunStatus.QUEUED : RunStatus.CLAIMED,
        `${fixture.name}: Prisma state`,
      );
    }
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

test("a Hold that wins the Chain mutex bars an ordinary claim selected from a stale candidate scan", async () => {
  const owner = await seedRunner();
  const chain = await seedChain(owner, [1, 2]);
  const run = await queue(chain.tasks[1]!.id);
  await holdWinsClaimRace({
    projectId: owner.project.id,
    chainId: chain.chainId,
    heldLayer: 1,
    runId: run.id,
    runnerId: "claim-race-ordinary",
    token: RUNNER_TOKEN,
  });
});

test("the live claim loop fails closed when a racing Hold finds null Chain execution fields", async () => {
  const owner = await seedRunner();
  const chain = await seedChain(owner, [1]);
  const run = await queue(chain.tasks[0]!.id);
  await db.$executeRawUnsafe('ALTER TABLE "Task" DROP CONSTRAINT "Task_chain_identity_all_or_none_check"');
  try {
    await db.task.update({
      where: { id: chain.tasks[0]!.id },
      data: { chainLayer: null, chainIndex: null },
    });
    await holdWinsClaimRace({
      projectId: owner.project.id,
      chainId: chain.chainId,
      heldLayer: 1,
      runId: run.id,
      runnerId: "claim-race-null-layer",
      token: RUNNER_TOKEN,
    });
  } finally {
    await db.task.update({
      where: { id: chain.tasks[0]!.id },
      data: { chainLayer: 1, chainIndex: 0 },
    });
    await db.$executeRawUnsafe(`ALTER TABLE "Task"
      ADD CONSTRAINT "Task_chain_identity_all_or_none_check" CHECK (
        ("chainId" IS NULL AND "chainIndex" IS NULL AND "chainLayer" IS NULL)
        OR
        ("chainId" IS NOT NULL AND "chainIndex" IS NOT NULL AND "chainLayer" IS NOT NULL)
      )`);
  }
});

test("a Hold that wins the Chain mutex bars a merge-executor claim selected from a stale candidate scan", async () => {
  const chain = await seedIntegratorChain(db, { label: "claim-race-merge" });
  assert.ok(chain.integratorTask);
  const run = await queue(chain.integratorTask.id);
  const layer = chain.integratorTask.chainLayer ?? chain.integratorTask.chainIndex;
  assert.ok(layer !== null);
  await holdWinsClaimRace({
    projectId: chain.project.id,
    chainId: chain.chainId,
    heldLayer: layer - 1,
    runId: run.id,
    runnerId: EXECUTOR_RUNNER,
    token: EXECUTOR_TOKEN,
  });
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
