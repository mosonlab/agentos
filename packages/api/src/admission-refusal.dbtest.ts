import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { ChainControlState, DependencyProvisioning, PrismaClient } from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-admission-db-token";

const asOperator = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await operation();
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prior;
  }
};

const call = async (
  method: string,
  path: string,
): Promise<{ status: number; body: any }> => asOperator(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}` },
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

const seedChain = async (label: string, count = 3) => {
  const project = await db.project.create({
    data: { name: label, slug: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}` },
  });
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
  const repo = await db.repo.create({
    data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo", dependencyProvisioning: DependencyProvisioning.NONE },
  });
  await db.agentRepoAccess.create({
    data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" },
  });
  const chainId = `${label}-chain`;
  const tasks = [];
  for (let index = 0; index < count; index += 1) {
    tasks.push(await db.task.create({ data: {
      projectId: project.id,
      assigneeAgentId: agent.id,
      repoId: repo.id,
      name: `Step ${index + 1}`,
      description: "work",
      status: index === 0 ? "DONE" : "TODO",
      chainId,
      chainIndex: index,
      chainLayer: index + 1,
    } }));
  }
  return { project, agent, repo, chainId, tasks };
};

const seedControl = async (
  chain: Awaited<ReturnType<typeof seedChain>>,
  state: ChainControlState,
  heldLayer: number | null,
) => db.chainControl.create({ data: {
  projectId: chain.project.id,
  chainId: chain.chainId,
  state,
  heldLayer,
  holdRequestId: state === ChainControlState.HELD ? "seed-hold" : null,
  holdReason: state === ChainControlState.HELD ? "wait for review" : null,
  holdGeneration: state === ChainControlState.HELD ? 1 : 2,
} });

const seedRun = async (
  chain: Awaited<ReturnType<typeof seedChain>>,
  taskId: string,
  status: "FAILED" | "SUCCEEDED",
) => db.run.create({ data: {
  projectId: chain.project.id,
  taskId,
  agentId: chain.agent.id,
  repoId: chain.repo.id,
  runNumber: 1,
  dedupeKey: `task:${taskId}:run:1`,
  runner: "CLAUDE",
  model: "claude",
  promptHash: "hash",
  status,
  maxRunsPerTask: 5,
} });

const release = async (chain: Awaited<ReturnType<typeof seedChain>>) => {
  await db.chainControl.update({
    where: { projectId_chainId: { projectId: chain.project.id, chainId: chain.chainId } },
    data: { state: ChainControlState.RELEASED, releasedAt: new Date(), releaseRequestId: "seed-release" },
  });
};

test("Start refuses a later held step, then uses the ordinary path after release", async () => {
  const chain = await seedChain("admission-start", 3);
  await seedControl(chain, ChainControlState.HELD, 1);
  const target = chain.tasks[1]!;
  const beforeRuns = await db.run.count({ where: { taskId: target.id } });
  const beforeActivities = await db.taskActivity.count({ where: { taskId: target.id } });

  const refused = await call("POST", `/tasks/${target.id}/start`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Chain is held after layer 1/u);
  assert.equal(await db.run.count({ where: { taskId: target.id } }), beforeRuns);
  assert.equal(await db.taskActivity.count({ where: { taskId: target.id } }), beforeActivities);

  await release(chain);
  const started = await call("POST", `/tasks/${target.id}/start`);
  assert.equal(started.status, 201);
  assert.equal(await db.run.count({ where: { taskId: target.id } }), 1);
});

test("Retry consumes the hold refusal without inheriting Start-only terminal/status refusals", async () => {
  const chain = await seedChain("admission-retry", 3);
  const target = chain.tasks[1]!;
  await db.task.update({ where: { id: target.id }, data: { status: "DONE" } });
  await seedRun(chain, target.id, "FAILED");
  await seedControl(chain, ChainControlState.HELD, 1);
  const beforeActivities = await db.taskActivity.count({ where: { taskId: target.id } });

  const refused = await call("POST", `/tasks/${target.id}/retry`);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Chain is held after layer 1/u);
  assert.equal(await db.run.count({ where: { taskId: target.id } }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: target.id } }), beforeActivities);

  await release(chain);
  const retried = await call("POST", `/tasks/${target.id}/retry`);
  assert.equal(retried.status, 201);
  assert.equal(await db.run.count({ where: { taskId: target.id } }), 2);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.id } })).status, "TODO");
  assert.equal(await db.taskActivity.count({ where: { taskId: target.id, body: { contains: "queued by operator retry" } } }), 1);
});

test("Chain and standalone startability agree on held layers while the admission read stays batched", async () => {
  const chain = await seedChain("admission-read", 3);
  await seedControl(chain, ChainControlState.HELD, 2);
  const heldLayer = chain.tasks[1]!;
  const later = chain.tasks[2]!;

  const chainRead = await call("GET", `/tasks/${heldLayer.id}/chain`);
  assert.equal(chainRead.status, 200);
  const byTask = new Map<string, { taskId: string; startable: boolean }>(
    chainRead.body.steps.map((step: { taskId: string; startable: boolean }) => [step.taskId, step]),
  );
  assert.equal(byTask.get(heldLayer.id)!.startable, true);
  assert.equal(byTask.get(later.id)!.startable, false);

  const atLayer = await call("GET", `/tasks/${heldLayer.id}/startability`);
  const aboveLayer = await call("GET", `/tasks/${later.id}/startability`);
  assert.equal(atLayer.status, 200);
  assert.equal(atLayer.body.startable, true);
  assert.equal(aboveLayer.status, 200);
  assert.equal(aboveLayer.body.startable, false);
  // Layer 2 is intentionally still TODO so its ordinary predecessor guard
  // correctly keeps layer 3 from being startable. The hold is a separate
  // control refusal, not a StartabilityChecklist entry; Start and Retry above
  // assert its hold-naming refusal directly.
  assert.equal(aboveLayer.body.checklist.predecessorsDone, false);
  assert.deepEqual(Object.keys(aboveLayer.body.checklist).sort(), [
    "agentAssignee", "budgetRemaining", "noActiveRun", "predecessorsDone", "repoAccessGrant", "repoBound",
  ]);

  const loggedDb = new PrismaClient({
    datasources: { db: { url: testDatabaseUrl } },
    log: [{ emit: "event", level: "query" }],
  });
  const controlQueries: string[] = [];
  loggedDb.$on("query", (event) => {
    if (event.query.includes('"ChainControl"')) controlQueries.push(event.query);
  });
  try {
    const response = await asOperator(() => createApp(loggedDb).request(`/tasks/${chain.tasks[0]!.id}/chain`, {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    }));
    assert.equal(response.status, 200);
    // Three chain steps still require one control query. The reader is keyed
    // by Chain, not by each admitted Task.
    assert.equal(controlQueries.length, 1);
  } finally {
    await loggedDb.$disconnect();
  }
});

test("admission reads ChainControl for a malformed chain row with a null chainIndex", async () => {
  const chain = await seedChain("admission-null-index", 2);
  const target = chain.tasks[1]!;
  // The contracted schema prevents new partial identities. Temporarily remove
  // that fence to exercise the admission reader's defensive legacy-row path,
  // then restore both the row and constraint before this test returns.
  await db.$executeRawUnsafe('ALTER TABLE "Task" DROP CONSTRAINT "Task_chain_identity_all_or_none_check"');
  try {
    await db.task.update({ where: { id: target.id }, data: { chainIndex: null } });
    await seedControl(chain, ChainControlState.HELD, 1);

    const startability = await call("GET", `/tasks/${target.id}/startability`);
    assert.equal(startability.status, 200);
    assert.equal(startability.body.startable, false);

    const chainRead = await call("GET", `/tasks/${target.id}/chain`);
    assert.equal(chainRead.status, 200);
    assert.equal(chainRead.body.steps.length, 1);
    assert.equal(chainRead.body.steps[0].startable, false);
    assert.match(chainRead.body.steps[0].holdRefusal, /Chain is held after layer 1/u);
  } finally {
    await db.task.update({ where: { id: target.id }, data: { chainIndex: 1 } });
    await db.$executeRawUnsafe(`ALTER TABLE "Task"
      ADD CONSTRAINT "Task_chain_identity_all_or_none_check" CHECK (
        ("chainId" IS NULL AND "chainIndex" IS NULL AND "chainLayer" IS NULL)
        OR
        ("chainId" IS NOT NULL AND "chainIndex" IS NOT NULL AND "chainLayer" IS NOT NULL)
      )`);
  }
});

test("unheld, released, and chainless Tasks retain ordinary admission", async () => {
  const unheld = await seedChain("admission-unheld", 2);
  const unheldRead = await call("GET", `/tasks/${unheld.tasks[1]!.id}/startability`);
  assert.equal(unheldRead.status, 200);
  assert.equal(unheldRead.body.startable, true);

  const released = await seedChain("admission-released", 2);
  await seedControl(released, ChainControlState.RELEASED, null);
  const releasedRead = await call("GET", `/tasks/${released.tasks[1]!.id}/startability`);
  assert.equal(releasedRead.status, 200);
  assert.equal(releasedRead.body.startable, true);

  const standalone = await db.task.create({
    data: { projectId: unheld.project.id, assigneeAgentId: unheld.agent.id, repoId: unheld.repo.id, name: "Standalone", description: "work" },
  });
  const standaloneRead = await call("GET", `/tasks/${standalone.id}/startability`);
  assert.equal(standaloneRead.status, 200);
  assert.equal(standaloneRead.body.startable, true);
});
