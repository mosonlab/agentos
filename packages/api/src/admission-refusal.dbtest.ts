import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  activateChainSuccessor,
  ChainControlState,
  DependencyProvisioning,
  INTEGRATOR_AGENT_NAME,
  PrismaClient,
  recordIntegratorStop,
  ScheduleKind,
  TaskStatus,
} from "@anneal/db";

import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { fireAtTask } from "./scheduler.js";
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

const seedChain = async (label: string, count = 3, agentName = "agent") => {
  const project = await db.project.create({
    data: { name: label, slug: `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}` },
  });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: agentName,
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

// ---------------------------------------------------------------------------
// Disposition of a refused Run birth
//
// `openRun` answers with one of three dispositions, and each caller states its
// policy for the three rather than for all fifteen codes. One case per
// disposition per caller class, plus the savepoint the attempt is wrapped in.
// ---------------------------------------------------------------------------

const activityBodies = async (taskId: string): Promise<string[]> =>
  (await db.taskActivity.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } }))
    .map((row) => row.body);

test("held: the scheduler leaves an AT schedule due and fires it after release", async () => {
  const chain = await seedChain("disposition-held-at", 2);
  await seedControl(chain, ChainControlState.HELD, 1);
  const target = chain.tasks[1]!;
  const runAt = new Date("2026-09-02T10:00:00Z");
  const scheduled = await db.task.update({
    where: { id: target.id },
    data: { scheduleKind: ScheduleKind.AT, runAt },
  });

  assert.equal(await fireAtTask(db, scheduled, runAt), false);
  const held = await db.task.findUniqueOrThrow({ where: { id: target.id } });
  assert.deepEqual(
    { runAt: held.runAt?.toISOString(), status: held.status, runs: await db.run.count({ where: { taskId: target.id } }) },
    { runAt: runAt.toISOString(), status: TaskStatus.TODO, runs: 0 },
  );
  assert.deepEqual(await activityBodies(target.id), []);

  await release(chain);
  assert.equal(await fireAtTask(db, held, runAt), true);
  assert.equal(await db.run.count({ where: { taskId: target.id } }), 1);
});

test("fault: the scheduler quarantines an AT schedule whose assignee was archived", async () => {
  const chain = await seedChain("disposition-fault-at", 2);
  const target = chain.tasks[1]!;
  const runAt = new Date("2026-09-02T10:00:00Z");
  const scheduled = await db.task.update({
    where: { id: target.id },
    data: { scheduleKind: ScheduleKind.AT, runAt },
  });
  await db.agent.update({ where: { id: chain.agent.id }, data: { archivedAt: new Date() } });

  assert.equal(await fireAtTask(db, scheduled, runAt), false);
  const quarantined = await db.task.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(quarantined.runAt, null);
  assert.equal(await db.run.count({ where: { taskId: target.id } }), 0);
  const activity = await db.taskActivity.findFirstOrThrow({ where: { taskId: target.id } });
  assert.match(activity.body, /Schedule quarantined after Run birth refusal/u);
  assert.deepEqual(activity.metadata, { refusal: "assignee-archived" });
});

/**
 * A successor bound to a predecessor in another Chain. The bound dispatch owns
 * no stop record and no hold of its own, so every refusal it can reach is a
 * fault and parks the successor.
 */
const seedBound = async (label: string, agentName = "agent") => {
  const base = await seedChain(label, 1, agentName);
  const successor = await db.task.create({ data: {
    projectId: base.project.id,
    repoId: base.repo.id,
    assigneeAgentId: base.agent.id,
    name: "Bound successor",
    description: "work",
    status: TaskStatus.TODO,
    chainId: `${label}-successor-chain`,
    chainIndex: 0,
    chainLayer: 0,
    dispatchAfterTaskId: base.tasks[0]!.id,
  } });
  return { ...base, successor };
};

test("fault: a bound dispatch parks the successor in REVIEW under the refusal code", async () => {
  const bound = await seedBound("disposition-fault-bound", INTEGRATOR_AGENT_NAME);

  await db.$transaction((tx) => activateChainSuccessor(tx, bound.tasks[0]!, {}, new Date()));

  const parked = await db.task.findUniqueOrThrow({ where: { id: bound.successor.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.match(parked.failureReason ?? "", /may bind only a merge-execution step/u);
  assert.equal(await db.run.count({ where: { taskId: bound.successor.id } }), 0);
  const parkedActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: bound.successor.id, body: { contains: "parked in REVIEW" } },
  });
  assert.equal(
    (parkedActivity.metadata as Record<string, unknown>).refusal,
    "integrator-binding-invalid",
  );
});

test("fault: layer activation parks the successor in REVIEW under the refusal code", async () => {
  const chain = await seedChain("disposition-fault-layer", 2, INTEGRATOR_AGENT_NAME);
  const successor = chain.tasks[1]!;

  await db.$transaction((tx) => activateChainSuccessor(tx, chain.tasks[0]!, {}, new Date()));

  const parked = await db.task.findUniqueOrThrow({ where: { id: successor.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.match(parked.failureReason ?? "", /may bind only a merge-execution step/u);
  assert.equal(await db.run.count({ where: { taskId: successor.id } }), 0);
  const refused = await db.taskActivity.findFirstOrThrow({
    where: { taskId: successor.id, body: { contains: "Run birth was refused" } },
  });
  assert.deepEqual(refused.metadata, { refusal: "integrator-binding-invalid" });
});

test("fault: layer activation asked to raise rolls its whole transaction back", async () => {
  const chain = await seedChain("disposition-raise-layer", 2, INTEGRATOR_AGENT_NAME);
  const successor = chain.tasks[1]!;

  await assert.rejects(
    db.$transaction((tx) => activateChainSuccessor(tx, chain.tasks[0]!, { onRefusal: "raise" }, new Date())),
    /may bind only a merge-execution step/u,
  );

  // The refusal is raised instead of absorbed, so nothing the activation wrote
  // survives: the caller's own decision rolls back with it.
  const untouched = await db.task.findUniqueOrThrow({ where: { id: successor.id } });
  assert.deepEqual(
    { status: untouched.status, failureReason: untouched.failureReason },
    { status: TaskStatus.TODO, failureReason: null },
  );
  assert.deepEqual(await activityBodies(successor.id), []);
});

test("stopped: layer activation parks a stopped integrator under its stop record", async () => {
  const seeded = await seedIntegratorChain(db, { label: "disposition-stopped", shape: "canonical-direct" });
  const integratorTask = seeded.integratorTask!;
  // `head-drift` rather than `base-drift`: the drift condition defers its
  // question to a recovery Run owned by the integrator Task itself, which this
  // case has no reason to seed.
  await db.$transaction((tx) => recordIntegratorStop(tx, {
    integratorTaskId: integratorTask.id,
    condition: "head-drift",
    evidence: "head moved",
    sourceRunId: seeded.gateRun.id,
  }));

  await db.$transaction((tx) => activateChainSuccessor(tx, seeded.readinessTask!, {}, new Date()));

  const parked = await db.task.findUniqueOrThrow({ where: { id: integratorTask.id } });
  assert.equal(parked.status, TaskStatus.REVIEW);
  assert.match(
    parked.failureReason ?? "",
    /Merge integrator stopped on head-drift; predecessor success preserved and successor not activated/u,
  );
  assert.equal(await db.run.count({ where: { taskId: integratorTask.id } }), 0);
});

test("the savepoint around one birth keeps the rest of the layer's transaction usable", async () => {
  const chain = await seedChain("disposition-savepoint", 2);
  const colliding = chain.tasks[1]!;
  const sibling = await db.task.create({ data: {
    projectId: chain.project.id,
    assigneeAgentId: chain.agent.id,
    repoId: chain.repo.id,
    name: "Step 2b",
    description: "work",
    status: TaskStatus.TODO,
    chainId: chain.chainId,
    chainIndex: 2,
    chainLayer: 2,
  } });
  // A terminal Run whose dedupe key is the one the next birth will derive. The
  // birth reaches `Run.create` and loses the unique key exactly as a concurrent
  // activation would, which is the only refusal that aborts the transaction.
  await db.run.create({ data: {
    projectId: chain.project.id,
    taskId: colliding.id,
    agentId: chain.agent.id,
    repoId: chain.repo.id,
    runNumber: 1,
    dedupeKey: `task:${colliding.id}:run:2`,
    runner: "CLAUDE",
    model: "claude",
    promptHash: "hash",
    status: "SUCCEEDED",
    maxRunsPerTask: 5,
  } });

  await db.$transaction((tx) => activateChainSuccessor(tx, chain.tasks[0]!, {}, new Date()));

  // Without the rollback the collision poisons the transaction and the sibling
  // never gets its Run.
  assert.equal(await db.run.count({ where: { taskId: sibling.id } }), 1);
  assert.equal(await db.run.count({ where: { taskId: colliding.id } }), 1);
  const untouched = await db.task.findUniqueOrThrow({ where: { id: colliding.id } });
  assert.equal(untouched.status, TaskStatus.TODO);
  assert.equal(untouched.failureReason, null);
});
