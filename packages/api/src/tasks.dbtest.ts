import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./app.js";
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
    where: { taskId: context.task.id, body: "Started manually from the chain view" },
  }), 1);
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
