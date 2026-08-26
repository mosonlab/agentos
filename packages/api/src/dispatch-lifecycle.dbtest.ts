import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb, testDatabaseUrl } from "./testdb.js";

const OPERATOR = "dispatch-lifecycle-operator-token";
const RUNNER = "dispatch-lifecycle-runner-token";

let db: PrismaClient;
const priorOperatorToken = process.env.OPERATOR_TOKEN;
const priorRunnerToken = process.env.RUNNER_TOKEN;

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Task = Awaited<ReturnType<typeof db.task.findUniqueOrThrow>>;
type RunningRun = {
  run: Awaited<ReturnType<typeof db.run.findUniqueOrThrow>>;
  runnerId: string;
  fencingToken: string;
};

const fixture = async (label: string) => {
  const suffix = `${label}-${randomUUID()}`;
  const project = await db.project.create({
    data: { name: `Dispatch lifecycle ${suffix}`, slug: `dispatch-lifecycle-${suffix}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: `dispatch-agent-${suffix}`,
      title: "Dispatch lifecycle agent",
      model: "claude",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: `dispatch-repo-${suffix}`,
      remoteUrl: "https://example.test/dispatch-lifecycle.git",
      mountPath: "/repo",
    },
  });
  await db.agentRepoAccess.create({
    data: {
      projectId: project.id,
      agentId: agent.id,
      repoId: repo.id,
      mountPath: "/repo",
      permissions: "GIT_WRITE",
    },
  });

  const makeTemplate = async (name: string, stepCount: number) => db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: `${name}-${suffix}`,
      description: "dispatch lifecycle fixture",
      variables: [],
      steps: {
        create: Array.from({ length: stepCount }, (_, offset) => ({
          stepIndex: offset + 1,
          layer: offset,
          name: `Step ${offset + 1}`,
          assigneeType: "AGENT" as const,
          assigneeAgentId: agent.id,
          prompt: `step ${offset + 1} {{chainId}}`,
          outputKind: "result",
          approvalGate: false,
          opensPullRequest: false,
        })),
      },
    },
  });

  // The predecessor is one step so its auto-started Run can reach the terminal
  // completion path without hand-writing any binding state. The successor has
  // two steps so the assertion that only its first task carries the binding is
  // meaningful rather than vacuous.
  const predecessorTemplate = await makeTemplate("predecessor", 1);
  const successorTemplate = await makeTemplate("successor", 2);
  return { project, agent, repo, predecessorTemplate, successorTemplate };
};

const instantiateRequest = async (
  client: PrismaClient,
  seed: Pick<Fixture, "project" | "repo"> & { template: { id: string } },
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await createApp(client).request(
    `/projects/${seed.project.id}/task-templates/${seed.template.id}/instantiate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: await response.json() };
};

const instantiate = async (
  seed: Fixture,
  template: "predecessorTemplate" | "successorTemplate",
  autoStart = false,
  client = db,
  afterTaskId?: string,
) => {
  const result = await instantiateRequest(client, {
    project: seed.project,
    repo: seed.repo,
    template: seed[template],
  }, {
    repoId: seed.repo.id,
    variables: {},
    autoStart,
    ...(afterTaskId ? { afterTaskId } : {}),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const tasks = await db.task.findMany({
    where: { chainId: result.body.chainId },
    orderBy: { chainIndex: "asc" },
  });
  assert.ok(tasks.length > 0, "the route must materialize the chain before returning");
  return { response: result, tasks };
};

const prepareRunningRun = async (task: Task): Promise<RunningRun> => {
  const queued = await db.run.findFirstOrThrow({
    where: { taskId: task.id, status: "QUEUED" },
    orderBy: { runNumber: "asc" },
  });
  const runnerId = `dispatch-lifecycle-runner-${randomUUID()}`;
  const fencingToken = `dispatch-lifecycle-fence-${randomUUID()}`;
  await db.run.update({
    where: { id: queued.id },
    data: {
      status: "RUNNING",
      runnerId,
      fencingToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  await db.session.create({
    data: {
      runId: queued.id,
      projectId: task.projectId,
      agentId: task.assigneeAgentId!,
      taskId: task.id,
      runner: "CLAUDE",
      executionStatus: "RUNNING",
    },
  });
  return { run: queued, runnerId, fencingToken };
};

const completeViaRoute = async (client: PrismaClient, running: RunningRun): Promise<Response> => createApp(client).request(
  `/runner/runs/${running.run.id}/complete`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: running.runnerId,
      fencingToken: running.fencingToken,
      exitCode: 0,
      terminalEventSeen: true,
      terminalSuccess: true,
      cleanupStatus: "SUCCEEDED",
      commitSha: "a".repeat(40),
      output: "predecessor completed",
    }),
  },
);

const rawSql = (args: unknown[]): string => {
  const template = args[0];
  return Array.isArray(template) ? template.join(" ") : String(template ?? "");
};

const isChainMutexQuery = (sql: string): boolean => (
  sql.includes('FROM "Task"') && sql.includes('"chainId"') && sql.includes("FOR UPDATE")
);

type TransactionHooks = {
  beforeQuery?: (sql: string) => void;
  afterQuery?: (sql: string) => Promise<void> | void;
};

/**
 * The lock-order tests use the real route clients, but pause only at the
 * production full-chain mutex. This keeps the race deterministic without
 * reaching into the binding column or replacing the completion implementation.
 */
const instrumentTransactions = (client: PrismaClient, hooks: TransactionHooks): PrismaClient => new Proxy(client, {
  get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: any) => Promise<unknown>, options: unknown) => target.$transaction(async (tx) => {
      const instrumentedTx = new Proxy(tx, {
        get(txTarget, txProperty, txReceiver) {
          if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
          return (...args: unknown[]) => {
            const sql = rawSql(args);
            const pending = Reflect.apply(txTarget.$queryRaw, txTarget, args);
            if (isChainMutexQuery(sql)) hooks.beforeQuery?.(sql);
            if (!hooks.afterQuery || !isChainMutexQuery(sql)) return pending;
            return pending.then(async (result: unknown) => {
              await hooks.afterQuery?.(sql);
              return result;
            });
          };
        },
      });
      return operation(instrumentedTx);
    }, options as any);
  },
}) as PrismaClient;

const bindingMetadata = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
};

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR;
  process.env.RUNNER_TOKEN = RUNNER;
  db = setupTestDb();
});

beforeEach(async () => { await resetTestDb(db); });

after(async () => {
  await db.$disconnect();
  if (priorOperatorToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = priorOperatorToken;
  if (priorRunnerToken === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = priorRunnerToken;
});

test("public instantiate route binds an inert chain and terminal completion dispatches it exactly once", async () => {
  const seed = await fixture("lifecycle");
  const predecessor = await instantiate(seed, "predecessorTemplate", true);
  const predecessorTask = predecessor.tasks.at(-1)!;
  const successor = await instantiate(seed, "successorTemplate", false, db, predecessorTask.id);
  const successorTasks = successor.tasks;

  assert.equal(successor.response.body.tasks[0].dispatchAfterTaskId, predecessorTask.id);
  assert.equal(successor.response.body.tasks[1].dispatchAfterTaskId, null);
  assert.equal(successorTasks[0]!.dispatchAfterTaskId, predecessorTask.id);
  assert.ok(successorTasks.slice(1).every((task) => task.dispatchAfterTaskId === null));
  assert.ok(successorTasks.every((task) => task.status === "TODO"));
  assert.equal(await db.run.count({ where: { task: { chainId: successor.response.body.chainId } } }), 0);

  const waiting = await db.taskActivity.findFirstOrThrow({
    where: { taskId: successorTasks[0]!.id, body: `Template instantiated; waiting for predecessor ${predecessorTask.name}` },
  });
  assert.deepEqual(bindingMetadata(waiting.metadata), {
    chainId: successor.response.body.chainId,
    templateId: seed.successorTemplate.id,
    afterTaskId: predecessorTask.id,
    dispatchAfterTaskId: predecessorTask.id,
    predecessorTaskId: predecessorTask.id,
    predecessorChainId: predecessor.response.body.chainId,
  });

  const running = await prepareRunningRun(predecessorTask);
  const completion = await completeViaRoute(db, running);
  assert.equal(completion.status, 200, await completion.text());
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: predecessorTask.id } })).status, "DONE");

  const dispatchedRuns = await db.run.findMany({ where: { taskId: successorTasks[0]!.id }, orderBy: { runNumber: "asc" } });
  assert.equal(dispatchedRuns.length, 1);
  assert.equal(dispatchedRuns[0]!.runNumber, 1);
  assert.equal(await db.run.count({ where: { taskId: successorTasks[1]!.id } }), 0);
  assert.equal(
    (await db.task.findUniqueOrThrow({ where: { id: successorTasks[0]!.id } })).dispatchAfterTaskId,
    predecessorTask.id,
    "binding remains as dispatch history",
  );

  const successorActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: successorTasks[0]!.id, body: "Bound predecessor completed; first step queued" },
    orderBy: { id: "desc" },
  });
  const predecessorActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: predecessorTask.id, body: "Bound chain dispatched" },
    orderBy: { id: "desc" },
  });
  for (const activity of [successorActivity, predecessorActivity]) {
    assert.deepEqual(bindingMetadata(activity.metadata), {
      predecessorTaskId: predecessorTask.id,
      predecessorChainId: predecessor.response.body.chainId,
      successorTaskId: successorTasks[0]!.id,
      successorChainId: successor.response.body.chainId,
      state: "queued",
      runId: dispatchedRuns[0]!.id,
    });
  }
});

test("instantiate wins the predecessor mutex and the following completion sees its committed binding", { timeout: 30_000 }, async () => {
  const seed = await fixture("instantiate-wins");
  const predecessor = await instantiate(seed, "predecessorTemplate", true);
  const predecessorTask = predecessor.tasks.at(-1)!;
  const running = await prepareRunningRun(predecessorTask);
  const instantiateClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const completionClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let bindingLocked!: () => void;
  let completionAttempted!: () => void;
  let releaseBinding!: () => void;
  const bindingHasLock = new Promise<void>((resolve) => { bindingLocked = resolve; });
  const completionReachedMutex = new Promise<void>((resolve) => { completionAttempted = resolve; });
  const release = new Promise<void>((resolve) => { releaseBinding = resolve; });
  let bindingIntercepted = false;
  let completionIntercepted = false;
  const boundDb = instrumentTransactions(instantiateClient, {
    afterQuery: async () => {
      if (bindingIntercepted) return;
      bindingIntercepted = true;
      bindingLocked();
      await release;
    },
  });
  const completingDb = instrumentTransactions(completionClient, {
    beforeQuery: () => {
      if (completionIntercepted) return;
      completionIntercepted = true;
      completionAttempted();
    },
  });
  try {
    const binding = instantiate(seed, "successorTemplate", false, boundDb, predecessorTask.id);
    await bindingHasLock;
    const completion = completeViaRoute(completingDb, running);
    await completionReachedMutex;
    releaseBinding();
    const [bound, completed] = await Promise.all([binding, completion]);
    assert.equal(bound.response.status, 201, JSON.stringify(bound.response.body));
    assert.equal(completed.status, 200, await completed.text());
    const successorTask = (await db.task.findMany({ where: { chainId: bound.response.body.chainId }, orderBy: { chainIndex: "asc" } }))[0]!;
    assert.equal(successorTask.dispatchAfterTaskId, predecessorTask.id);
    const successorRuns = await db.run.findMany({ where: { taskId: successorTask.id }, orderBy: { runNumber: "asc" } });
    assert.equal(successorRuns.length, 1);
    assert.equal(successorRuns[0]!.runNumber, 1);
  } finally {
    releaseBinding();
    await Promise.all([instantiateClient.$disconnect(), completionClient.$disconnect()]);
  }
});

test("completion wins the predecessor mutex and a later instantiate is refused without attempted-chain rows", { timeout: 30_000 }, async () => {
  const seed = await fixture("completion-wins");
  const predecessor = await instantiate(seed, "predecessorTemplate", true);
  const predecessorTask = predecessor.tasks.at(-1)!;
  const running = await prepareRunningRun(predecessorTask);
  const instantiateClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const completionClient = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  let completionLocked!: () => void;
  let bindingAttempted!: () => void;
  let releaseCompletion!: () => void;
  const completionHasLock = new Promise<void>((resolve) => { completionLocked = resolve; });
  const bindingReachedMutex = new Promise<void>((resolve) => { bindingAttempted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  let completionIntercepted = false;
  let bindingIntercepted = false;
  const completingDb = instrumentTransactions(completionClient, {
    afterQuery: async () => {
      if (completionIntercepted) return;
      completionIntercepted = true;
      completionLocked();
      await release;
    },
  });
  const boundDb = instrumentTransactions(instantiateClient, {
    beforeQuery: () => {
      if (bindingIntercepted) return;
      bindingIntercepted = true;
      bindingAttempted();
    },
  });
  try {
    const completion = completeViaRoute(completingDb, running);
    await completionHasLock;
    const binding = instantiateRequest(boundDb, {
      project: seed.project,
      repo: seed.repo,
      template: seed.successorTemplate,
    }, {
      repoId: seed.repo.id,
      variables: {},
      autoStart: false,
      afterTaskId: predecessorTask.id,
    });
    await bindingReachedMutex;
    releaseCompletion();
    const [completed, refused] = await Promise.all([completion, binding]);
    assert.equal(completed.status, 200, await completed.text());
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "after_task_already_done");

    const attemptedTasks = await db.task.findMany({ where: { templateId: seed.successorTemplate.id }, select: { id: true } });
    assert.equal(attemptedTasks.length, 0);
    const attemptedTaskIds = attemptedTasks.map((task) => task.id);
    assert.equal(await db.taskActivity.count({ where: { taskId: { in: attemptedTaskIds } } }), 0);
    assert.equal(await db.run.count({ where: { taskId: { in: attemptedTaskIds } } }), 0);
    assert.equal(await db.triggerFire.count({ where: { templateId: seed.successorTemplate.id } }), 0);
  } finally {
    releaseCompletion();
    await Promise.all([instantiateClient.$disconnect(), completionClient.$disconnect()]);
  }
});
