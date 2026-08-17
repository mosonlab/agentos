import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const OPERATOR = "operator-db-token";

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
  body?: unknown,
): Promise<{ status: number; body: any }> => asOperator(async () => {
  const response = await createApp(db).request(path, {
    method,
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
});

const seedTask = async (label: string, overrides: Record<string, unknown> = {}) => {
  const project = await db.project.create({ data: { name: label, slug: `${label}-${Date.now()}-${Math.round(performance.now() * 1000)}` } });
  const environment = await db.environment.create({ data: { projectId: project.id, name: "local", allowedHosts: [] } });
  const agent = await db.agent.create({ data: {
    projectId: project.id, environmentId: environment.id, name: "agent", title: "Agent", model: "claude",
    foundationalPrompt: "foundation", rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: { projectId: project.id, name: "repo", remoteUrl: "https://example.test/repo.git", mountPath: "/repo" } });
  await db.agentRepoAccess.create({ data: { projectId: project.id, agentId: agent.id, repoId: repo.id, mountPath: "/repo", permissions: "GIT_WRITE" } });
  const task = await db.task.create({ data: {
    projectId: project.id, assigneeAgentId: agent.id, repoId: repo.id, name: "Step", description: "work", ...overrides,
  } });
  return { project, agent, repo, task };
};

const seedRun = async (
  context: Awaited<ReturnType<typeof seedTask>>,
  runNumber: number,
  status: "QUEUED" | "RUNNING" | "WAITING_INBOX" | "SUCCEEDED" | "FAILED",
) => db.run.create({ data: {
  projectId: context.project.id, taskId: context.task.id, agentId: context.agent.id, repoId: context.repo.id,
  runNumber, dedupeKey: `task:${context.task.id}:run:${runNumber}`, runner: "CLAUDE", model: "claude",
  promptHash: "hash", status, maxRunsPerTask: context.task.maxSessionsPerTask,
} });

// --- POST /tasks/:taskId/start ----------------------------------------------

test("start queues exactly one run and records the operator activity", async () => {
  const context = await seedTask("start-happy");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 201);
  assert.equal(body.runNumber, 1);
  assert.equal(await db.run.count({ where: { taskId: context.task.id, status: "QUEUED" } }), 1);
  assert.equal(await db.taskActivity.count({
    where: { taskId: context.task.id, body: "Started task manually" },
  }), 1);
});

test("unfinished chain predecessor blocks every future start with zero side effects", async () => {
  const chainId = `safe-chain-${Date.now()}`;
  const context = await seedTask("chain-block", { chainId, chainIndex: 0, name: "Step 1", status: "DONE" });
  const createStep = (chainIndex: number, name: string, status: "DONE" | "DOING" | "TODO") => db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    chainId,
    chainIndex,
    name,
    description: "work",
    status,
  } });
  await createStep(1, "Step 2", "DONE");
  await createStep(2, "Step 3", "DONE");
  const blocker = await createStep(3, "Step 4", "DOING");
  const fifth = await createStep(4, "Step 5", "TODO");
  const sixth = await createStep(5, "Step 6", "TODO");
  const before = await db.task.findMany({ where: { chainId }, orderBy: { chainIndex: "asc" }, select: { id: true, status: true, updatedAt: true } });
  for (const target of [fifth, sixth]) {
    const response = await call("POST", `/tasks/${target.id}/start`);
    assert.equal(response.status, 409);
    assert.match(response.body.error, new RegExp(`predecessor ${blocker.name} is not done`));
  }
  assert.deepEqual(await db.task.findMany({ where: { chainId }, orderBy: { chainIndex: "asc" }, select: { id: true, status: true, updatedAt: true } }), before);
  assert.equal(await db.run.count({ where: { taskId: { in: [fifth.id, sixth.id] } } }), 0);
  assert.equal(await db.taskActivity.count({ where: { taskId: { in: [fifth.id, sixth.id] } } }), 0);
  assert.equal(await db.taskStepOutput.count({ where: { taskId: { in: [fifth.id, sixth.id] } } }), 0);
});

test("the dependency-safe next chain step starts or recovers exactly once", async () => {
  for (const status of ["TODO", "BACKLOG"] as const) {
    const chainId = `next-${status}-${Date.now()}-${Math.random()}`;
    const context = await seedTask(`next-${status}`, { chainId, chainIndex: 0, name: "Done predecessor", status: "DONE" });
    const target = await db.task.create({ data: {
      projectId: context.project.id,
      assigneeAgentId: context.agent.id,
      repoId: context.repo.id,
      chainId,
      chainIndex: 1,
      name: `${status} target`,
      description: "work",
      status,
    } });
    assert.equal((await call("POST", `/tasks/${target.id}/start`)).status, 201);
    assert.equal((await call("POST", `/tasks/${target.id}/start`)).status, 409);
    assert.equal(await db.run.count({ where: { taskId: target.id } }), 1);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.id } })).status, "TODO");
    assert.equal(await db.taskActivity.count({ where: {
      taskId: target.id,
      body: status === "BACKLOG" ? "Recovered parked chain step manually" : "Started next chain step manually",
    } }), 1);
  }
});

test("ordinary PATCH cannot rewrite chain gates, skip predecessors, or complete an active task", async () => {
  const chainId = `patch-guard-${Date.now()}`;
  const context = await seedTask("patch-guard", { chainId, chainIndex: 0, name: "Blocking predecessor", status: "DOING", approvalGate: true });
  const future = await db.task.create({ data: {
    projectId: context.project.id,
    assigneeAgentId: context.agent.id,
    repoId: context.repo.id,
    chainId,
    chainIndex: 1,
    name: "Future step",
    description: "work",
    status: "TODO",
  } });
  const gateChange = await call("PATCH", `/tasks/${context.task.id}`, { approvalGate: false });
  assert.equal(gateChange.status, 409);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).approvalGate, true);
  const futureDone = await call("PATCH", `/tasks/${future.id}`, { status: "DONE" });
  assert.equal(futureDone.status, 409);
  assert.match(futureDone.body.error, /predecessor Blocking predecessor is not done/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: future.id } })).status, "TODO");

  await seedRun(context, 1, "WAITING_INBOX");
  const activeDone = await call("PATCH", `/tasks/${context.task.id}`, { status: "DONE" });
  assert.equal(activeDone.status, 409);
  assert.match(activeDone.body.error, /active run/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "DOING");
  assert.equal(await db.taskActivity.count({ where: { taskId: context.task.id, body: { startsWith: "Status changed:" } } }), 0);
});

test("repo-grant revocation and manual start serialize without an unclaimable Run", { timeout: 20_000 }, async () => {
  const context = await seedTask("grant-start-race");
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/start`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => { release(); await gate; return app.request(`/agents/${context.agent.id}/repos/${context.repo.id}/access`, { method: "DELETE", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
  ]));
  const [start, revoke] = responses;
  assert.ok(start!.status === 201 && revoke!.status === 409 || start!.status === 400 && revoke!.status === 204,
    `start=${start!.status} revoke=${revoke!.status}`);
  const runs = await db.run.count({ where: { taskId: context.task.id } });
  const grants = await db.agentRepoAccess.count({ where: { agentId: context.agent.id, repoId: context.repo.id } });
  assert.equal(runs, start!.status === 201 ? 1 : 0);
  assert.equal(grants, runs === 1 ? 1 : 0, `runs=${runs} grants=${grants}`);
});

test("a second start press is 409, not a second run", async () => {
  const context = await seedTask("start-double");
  assert.equal((await call("POST", `/tasks/${context.task.id}/start`)).status, 201);
  const second = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "Task already has an active run");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
});

test("a human step cannot be started", async () => {
  const context = await seedTask("start-human", { assigneeType: "HUMAN", assigneeAgentId: null });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Human steps cannot be started");
});

test("start names the archived assignee rather than failing anonymously", async () => {
  const context = await seedTask("start-archived-agent");
  await db.agent.update({ where: { id: context.agent.id }, data: { archivedAt: new Date() } });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.match(body.error, /agent is archived/);
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 0);
});

test("start refuses a task at its run ceiling even when every run is terminal", async () => {
  const context = await seedTask("start-budget", { maxSessionsPerTask: 2 });
  await seedRun(context, 1, "FAILED");
  await seedRun(context, 2, "FAILED");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Run budget exhausted");
});

test("start on a BACKLOG task queues a run and moves it to TODO", async () => {
  const context = await seedTask("start-backlog", { status: "BACKLOG" });
  assert.equal((await call("POST", `/tasks/${context.task.id}/start`)).status, 201);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "TODO");
});

test("a run parked on an Inbox question still counts as active", async () => {
  // The regression the shared ACTIVE_RUN_STATUSES exists for: WAITING_INBOX
  // resumes the moment the operator answers.
  const context = await seedTask("start-waiting");
  await seedRun(context, 1, "WAITING_INBOX");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Task already has an active run");
});

test("start refuses a done task and an archived task", async () => {
  const done = await seedTask("start-done", { status: "DONE" });
  assert.equal((await call("POST", `/tasks/${done.task.id}/start`)).body.error, "Task is already done");
  const archived = await seedTask("start-arch", { archivedAt: new Date() });
  assert.equal((await call("POST", `/tasks/${archived.task.id}/start`)).body.error, "Cannot start an archived task");
});

// --- archive / unarchive / archive-done -------------------------------------

test("archive and unarchive round-trip, and the board hides the archived task", async () => {
  const context = await seedTask("archive-trip");
  assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}`)).body.length, 0);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}&archived=all`)).body.length, 1);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}&archived=true`)).body.length, 1);
  assert.equal((await call("POST", `/tasks/${context.task.id}/unarchive`)).status, 200);
  assert.equal((await call("GET", `/tasks?projectId=${context.project.id}`)).body.length, 1);
  // Unarchiving an already-live task is a no-op, not an error.
  assert.equal((await call("POST", `/tasks/${context.task.id}/unarchive`)).status, 200);
});

test("archive refuses a task with an active run", async () => {
  const context = await seedTask("archive-busy");
  await seedRun(context, 1, "RUNNING");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/archive`);
  assert.equal(status, 409);
  assert.equal(body.error, "Cannot archive a task with an active run");
});

test("archive refuses a REVIEW task with an open approval gate", async () => {
  const context = await seedTask("archive-gate", { status: "REVIEW", approvalGate: true });
  const run = await seedRun(context, 1, "SUCCEEDED");
  const session = await db.session.create({ data: {
    runId: run.id, projectId: context.project.id, agentId: context.agent.id, taskId: context.task.id, runner: "CLAUDE",
  } });
  await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: context.agent.id, sessionId: session.id, taskId: context.task.id,
    gateTaskId: context.task.id, kind: "MULTIPLE_CHOICE", body: "approve?",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:${context.task.id}`,
  } });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/archive`);
  assert.equal(status, 409);
  assert.equal(body.error, "Decide the approval gate in the Inbox first");
});

test("HUMAN final DONE closes only exact OPEN gate messages even when approvalGate is false", async () => {
  const chainId = `human-final-${Date.now()}`;
  const target = await seedTask("human-final", {
    status: "REVIEW", assigneeType: "HUMAN", assigneeAgentId: null, repoId: null,
    approvalGate: false, chainId, chainIndex: 0,
  });
  const unrelated = await seedTask("human-final-unrelated", { status: "REVIEW" });
  const exactOpen = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: target.task.id, gateTaskId: target.task.id,
    kind: "MULTIPLE_CHOICE", body: "exact open", status: "OPEN",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:exact:${target.task.id}`,
  } });
  const exactClosed = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: target.task.id, gateTaskId: target.task.id,
    kind: "MULTIPLE_CHOICE", body: "exact closed", status: "CLOSED",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:closed:${target.task.id}`,
  } });
  const ordinaryOpen = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: target.task.id, kind: "TEXT", body: "ordinary open",
    status: "OPEN", dedupeKey: `ordinary:${target.task.id}`,
  } });
  const unrelatedOpen = await db.inboxMessage.create({ data: {
    from: "AGENT", taskId: unrelated.task.id, gateTaskId: unrelated.task.id,
    kind: "MULTIPLE_CHOICE", body: "unrelated open", status: "OPEN",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:unrelated:${unrelated.task.id}`,
  } });

  assert.equal((await call("PATCH", `/tasks/${target.task.id}`, { status: "DONE" })).status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.task.id } })).status, "DONE");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: exactOpen.id } })).status, "CLOSED");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: exactClosed.id } })).status, "CLOSED");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: ordinaryOpen.id } })).status, "OPEN");
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: unrelatedOpen.id } })).status, "OPEN");

  // A replay is a no-op, including its activity and chain activation side effects.
  assert.equal((await call("PATCH", `/tasks/${target.task.id}`, { status: "DONE" })).status, 200);
  assert.equal(await db.taskActivity.count({
    where: { taskId: target.task.id, body: { startsWith: "Status changed:" } },
  }), 1);
});

test("archive-done archives every finished task and reports the ones it skipped", async () => {
  const context = await seedTask("archive-done", { status: "DONE" });
  const extra = await Promise.all([1, 2, 3, 4, 5].map((index) => db.task.create({ data: {
    projectId: context.project.id, name: `Done ${index}`, description: "d", status: "DONE",
  } })));
  const busy = await db.task.create({ data: {
    projectId: context.project.id, assigneeAgentId: context.agent.id, repoId: context.repo.id,
    name: "Done but running", description: "d", status: "DONE",
  } });
  await db.run.create({ data: {
    projectId: context.project.id, taskId: busy.id, agentId: context.agent.id, repoId: context.repo.id,
    runNumber: 1, dedupeKey: `task:${busy.id}:run:1`, runner: "CLAUDE", model: "claude", promptHash: "h", status: "RUNNING",
  } });
  await db.task.create({ data: { projectId: context.project.id, name: "Still todo", description: "d" } });

  const { status, body } = await call("POST", `/projects/${context.project.id}/tasks/archive-done`);
  assert.equal(status, 200);
  assert.deepEqual(body, { archived: 6, skipped: 1 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: busy.id } })).archivedAt, null);
  for (const task of [context.task, ...extra]) {
    assert.notEqual((await db.task.findUniqueOrThrow({ where: { id: task.id } })).archivedAt, null);
  }

  // A second press has nothing left to do.
  assert.deepEqual((await call("POST", `/projects/${context.project.id}/tasks/archive-done`)).body, { archived: 0, skipped: 1 });
});

// --- PATCH BACKLOG guard and retry ------------------------------------------

test("PATCH to BACKLOG is refused while a run is active and allowed when none is", async () => {
  const context = await seedTask("patch-backlog");
  await seedRun(context, 1, "RUNNING");
  const refused = await call("PATCH", `/tasks/${context.task.id}`, { status: "BACKLOG" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "Cannot move a task with an active run to Backlog");

  await db.run.updateMany({ where: { taskId: context.task.id }, data: { status: "FAILED" } });
  const allowed = await call("PATCH", `/tasks/${context.task.id}`, { status: "BACKLOG" });
  assert.equal(allowed.status, 200);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "BACKLOG");
});

test("retry refuses an archived task", async () => {
  const context = await seedTask("retry-archived", { archivedAt: new Date() });
  await seedRun(context, 1, "FAILED");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/retry`);
  assert.equal(status, 409);
  assert.equal(body.error, "Cannot retry an archived task");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
});

test("PATCH validates a cron expression server-side and moves runAt into the future", async () => {
  // The Automations page's cron field depends on this: it deliberately ships no
  // client-side validator.
  const context = await seedTask("patch-cron", {
    scheduleKind: "CRON", cron: "0 8 * * *", timezone: "UTC", runAt: new Date("2020-01-01T08:00:00Z"),
  });
  const ok = await call("PATCH", `/tasks/${context.task.id}`, { cron: "0 9 * * *" });
  assert.equal(ok.status, 200);
  const updated = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  assert.ok(updated.runAt!.getTime() > Date.now());

  const bad = await call("PATCH", `/tasks/${context.task.id}`, { cron: "not a cron at all" });
  assert.equal(bad.status, 400);
  assert.ok(typeof bad.body.error === "string" && bad.body.error.length > 0);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).cron,
    "0 9 * * *",
    "a rejected cron changes nothing",
  );
});

// --- synchronised races (two sequential calls would pass without the lock) ---

/** Releases both callers only once both are inside their transaction, so the
 *  lock is what orders them rather than wall-clock luck. */
const synchronised = async <T>(
  operations: Array<(release: () => void, gate: Promise<void>) => Promise<T>>,
): Promise<T[]> => {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const release = () => {
    arrived += 1;
    if (arrived === operations.length) open();
  };
  return Promise.all(operations.map((operation) => operation(release, gate)));
};

test("two simultaneous start presses produce one run and one 409, never a 500", async () => {
  const context = await seedTask("race-start");
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/start`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/start`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
  ]));
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = responses.find((response) => response.status === 409)!;
  assert.equal((await loser.json() as any).error, "Task already has an active run");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
});

test("archive and retry released together leave a consistent state, never both", async () => {
  const context = await seedTask("race-archive-retry", { status: "DONE" });
  await seedRun(context, 1, "SUCCEEDED");
  const app = createApp(db);
  await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/archive`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/retry`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
  ]));
  const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  const runs = await db.run.count({ where: { taskId: context.task.id } });
  // Either archive won (no new run) or retry won (still unarchived). Never both.
  assert.equal((task.archivedAt !== null) !== (runs > 1), true, `archivedAt=${task.archivedAt}, runs=${runs}`);
});

test("archive and archive-done released together double-count nothing and do not deadlock", { timeout: 20_000 }, async () => {
  const context = await seedTask("race-archive-all", { status: "DONE" });
  const sibling = await db.task.create({ data: {
    projectId: context.project.id, name: "Also done", description: "d", status: "DONE",
  } });
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/tasks/${context.task.id}/archive`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => { release(); await gate; return app.request(`/projects/${context.project.id}/tasks/archive-done`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
  ]));
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  for (const taskId of [context.task.id, sibling.id]) {
    assert.notEqual((await db.task.findUniqueOrThrow({ where: { id: taskId } })).archivedAt, null);
  }
  const bulk = await responses[1]!.json() as { archived: number; skipped: number };
  assert.ok(bulk.archived <= 2 && bulk.skipped === 0, `archived=${bulk.archived} skipped=${bulk.skipped}`);
});

test("a lock held by a foreign transaction makes start wait rather than double-run", { timeout: 20_000 }, async () => {
  // Direct proof that lockTask really takes a row lock: holding the Task row in
  // another transaction blocks the route until it commits.
  const context = await seedTask("race-lock-proof");
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let released = false;
  try {
    const held = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${context.task.id} FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 700));
      released = true;
    }, { timeout: 10_000 });
    const start = call("POST", `/tasks/${context.task.id}/start`);
    const [, response] = await Promise.all([held, start]);
    assert.equal(released, true);
    assert.equal(response.status, 201);
  } finally {
    await holder.$disconnect();
  }
});

// --- review fixes: the startable contract (CODE-REVIEW M1) -------------------

test("start refuses a REVIEW step whose approval gate is still open, and creates no run", async () => {
  // The defect: the route re-derived its own guard set instead of calling
  // `startable`, so it accepted a step no human had approved. A run enqueued
  // here has an agent working ahead of the gate, and its completion can open a
  // second gate card for the same task.
  const context = await seedTask("start-gated-review", { status: "REVIEW", approvalGate: true });
  const run = await seedRun(context, 1, "SUCCEEDED");
  const session = await db.session.create({ data: {
    runId: run.id, projectId: context.project.id, agentId: context.agent.id, taskId: context.task.id, runner: "CLAUDE",
  } });
  await db.inboxMessage.create({ data: {
    from: "AGENT", agentId: context.agent.id, sessionId: session.id, taskId: context.task.id,
    gateTaskId: context.task.id, kind: "MULTIPLE_CHOICE", body: "Approve?", status: "OPEN",
    choices: [{ id: "approve", label: "Approve" }], dedupeKey: `gate:${context.task.id}`,
  } });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Only Todo and Backlog steps can be started");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1, "no second run");
  // The gate is untouched: refusing to start must not decide it.
  assert.equal(await db.inboxMessage.count({ where: { gateTaskId: context.task.id, status: "OPEN" } }), 1);
});

test("start refuses a DOING step — that is Retry's territory", async () => {
  const context = await seedTask("start-doing", { status: "DOING" });
  await seedRun(context, 1, "FAILED");
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 409);
  assert.equal(body.error, "Only Todo and Backlog steps can be started");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 1);
});

test("start on a task with no repository is 400, never a 500", async () => {
  // `enqueueTaskRun` throws a plain Error for a missing repo and the route's
  // catch maps only ArchivedAssigneeError and P2002, so this used to be a 500
  // on a documented endpoint.
  const context = await seedTask("start-no-repo");
  await db.task.update({ where: { id: context.task.id }, data: { repoId: null } });
  const { status, body } = await call("POST", `/tasks/${context.task.id}/start`);
  assert.equal(status, 400);
  assert.equal(body.error, "This task has no repository");
  assert.equal(await db.run.count({ where: { taskId: context.task.id } }), 0);
});

// --- review fixes: the Backlog PATCH joins the mutex (SOL-REVIEW M1) ---------

test("start and a Backlog PATCH released together never strand a queued run in Backlog", async () => {
  // The runner claims only unarchived TODO/DOING tasks, so a QUEUED run left on
  // a BACKLOG task is never claimed and never completes — the race does not
  // "resolve on completion" as the old comment claimed.
  const context = await seedTask("race-start-backlog");
  const app = createApp(db);
  const post = (path: string, body?: unknown) => app.request(path, {
    method: body === undefined ? "POST" : "PATCH",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return post(`/tasks/${context.task.id}/start`); },
    async (release, gate) => { release(); await gate; return post(`/tasks/${context.task.id}`, { status: "BACKLOG" }); },
  ]));
  const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  const queued = await db.run.count({ where: { taskId: context.task.id, status: "QUEUED" } });
  // Either the park won (no run) or the start won (not parked). Never both.
  assert.equal(
    (task.status === "BACKLOG") !== (queued > 0),
    true,
    `status=${task.status}, queuedRuns=${queued}`,
  );
});

test("a Backlog PATCH is refused outright while a run is active", async () => {
  const context = await seedTask("backlog-active-run");
  await seedRun(context, 1, "WAITING_INBOX");
  const { status, body } = await call("PATCH", `/tasks/${context.task.id}`, { status: "BACKLOG" });
  assert.equal(status, 409);
  assert.equal(body.error, "Cannot move a task with an active run to Backlog");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "TODO");
});

test("a successful Backlog PATCH still records the status-change activity", async () => {
  const context = await seedTask("backlog-activity");
  assert.equal((await call("PATCH", `/tasks/${context.task.id}`, { status: "BACKLOG" })).status, 200);
  assert.equal(await db.taskActivity.count({
    where: { taskId: context.task.id, body: "Status changed: TODO → BACKLOG" },
  }), 1);
});

// --- review fixes: archive-done re-checks status under the lock (SOL M3) -----

test("archive-done does not archive a task dragged out of Done between selection and lock", async () => {
  // `SELECT … FOR UPDATE` re-applies its own WHERE to the row version it waited
  // for, so restating `status = 'done'` in the locking query is what makes the
  // re-check atomic. Without it the operator's move back to the board is
  // silently undone.
  const context = await seedTask("archive-done-moved", { status: "DONE" });
  const app = createApp(db);
  const responses = await asOperator(() => synchronised([
    async (release, gate) => { release(); await gate; return app.request(`/projects/${context.project.id}/tasks/archive-done`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}` } }); },
    async (release, gate) => {
      release();
      await gate;
      return app.request(`/tasks/${context.task.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "TODO" }),
      });
    },
  ]));
  // archive-done always answers 200; the PATCH is either 200 (it got there
  // first, and the locking query then skipped the row) or 409 (archive-done
  // committed first, and the status write refuses to move an archived task).
  assert.equal(responses[0]!.status, 200);
  assert.ok([200, 409].includes(responses[1]!.status), `patch=${responses[1]!.status}`);
  const task = await db.task.findUniqueOrThrow({ where: { id: context.task.id } });
  // Whichever order won, the invariant holds: an archived task is a DONE task.
  // The failure this pins is `status=TODO, archivedAt=<set>` — work the operator
  // explicitly pulled back onto the board, silently hidden again.
  assert.equal(
    task.archivedAt === null || task.status === "DONE",
    true,
    `status=${task.status}, archivedAt=${task.archivedAt}`,
  );
});

test("an archived task's status cannot be changed until it is unarchived", async () => {
  const context = await seedTask("archived-status-write", { status: "DONE" });
  assert.equal((await call("POST", `/tasks/${context.task.id}/archive`)).status, 200);
  const { status, body } = await call("PATCH", `/tasks/${context.task.id}`, { status: "TODO" });
  assert.equal(status, 409);
  assert.match(body.error, /unarchive it first/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: context.task.id } })).status, "DONE");
  // Unarchive, and the same write is accepted.
  assert.equal((await call("POST", `/tasks/${context.task.id}/unarchive`)).status, 200);
  assert.equal((await call("PATCH", `/tasks/${context.task.id}`, { status: "TODO" })).status, 200);
});

test("archive-done never reaches across projects, even for ids handed to it", async () => {
  const mine = await seedTask("archive-done-scope-a", { status: "DONE" });
  const theirs = await seedTask("archive-done-scope-b", { status: "DONE" });
  const { status, body } = await call("POST", `/projects/${mine.project.id}/tasks/archive-done`);
  assert.equal(status, 200);
  assert.deepEqual(body, { archived: 1, skipped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: theirs.task.id } })).archivedAt, null);
});

// --- review fixes: E1 consistency between list and detail (SOL SS3) ---------

test("E1: a null-chainIndex row reads as its own one-row chain on the board too", async () => {
  const context = await seedTask("e1-list", { chainId: "chain-e1", chainIndex: 0 });
  const broken = await db.task.create({ data: {
    projectId: context.project.id, name: "Broken row", description: "d",
    chainId: "chain-e1", chainIndex: null,
  } });
  const { body } = await call("GET", `/tasks?projectId=${context.project.id}`);
  const real = body.find((task: any) => task.id === context.task.id);
  const orphan = body.find((task: any) => task.id === broken.id);
  // The broken row must not inflate its siblings' totals...
  assert.equal(real.chainProgress.total, 1);
  // ...and must report the same 1/1 the detail route reports for it.
  assert.equal(orphan.chainProgress.total, 1);
  assert.equal(orphan.chainProgress.done, 0);
  const detail = await call("GET", `/tasks/${broken.id}/chain`);
  assert.equal(detail.body.total, orphan.chainProgress.total);
});

test("enrich=false drops the extra fields and keeps the rows", async () => {
  const context = await seedTask("enrich-off", { chainId: "chain-enrich", chainIndex: 0 });
  const { body } = await call("GET", `/tasks?projectId=${context.project.id}&enrich=false`);
  assert.equal(body.length, 1);
  assert.equal(body[0].id, context.task.id);
  assert.equal(body[0].chainProgress, null);
  assert.equal(body[0].recurringFireCount, 0);
});
