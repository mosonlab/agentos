import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { PrismaClient, TaskStatus } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const OPERATOR = "template-dispatch-binding-operator";
const STEP_COUNT = 13;

let db: PrismaClient;

type Fixture = Awaited<ReturnType<typeof fixture>>;

const fixture = async (label: string) => {
  const project = await db.project.create({
    data: { name: label, slug: `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({
    data: {
      projectId: project.id,
      environmentId: environment.id,
      name: "chain-agent",
      title: "Chain agent",
      model: "claude",
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    },
  });
  const repo = await db.repo.create({
    data: {
      projectId: project.id,
      name: "repo",
      remoteUrl: "https://example.test/repo.git",
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
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: "dispatch-template",
      description: "dispatch fixture",
      variables: [],
      steps: {
        create: Array.from({ length: STEP_COUNT }, (_, offset) => {
          const stepIndex = offset + 1;
          return {
            stepIndex,
            layer: stepIndex,
            name: `Step ${stepIndex}`,
            assigneeType: "AGENT" as const,
            assigneeAgentId: agent.id,
            prompt: `step ${stepIndex} {{chainId}}`,
            outputKind: "result",
            approvalGate: false,
            opensPullRequest: false,
          };
        }),
      },
    },
  });
  return { project, repo, agent, template };
};

const request = async (
  projectId: string,
  templateId: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    const response = await createApp(db).request(
      `/projects/${projectId}/task-templates/${templateId}/instantiate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
};

const instantiate = async (seed: Fixture, autoStart = false) => {
  const result = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    autoStart,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return db.task.findMany({ where: { chainId: result.body.chainId }, orderBy: { chainIndex: "asc" } });
};

const patchTaskStatus = async (taskId: string, status: TaskStatus): Promise<Response> => createApp(db).request(
  `/tasks/${taskId}`,
  {
    method: "PATCH",
    headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  },
);

const rowCounts = async () => ({
  tasks: await db.task.count(),
  activities: await db.taskActivity.count(),
  runs: await db.run.count(),
  fires: await db.triggerFire.count(),
});

const assertNoPartialRows = async (beforeCounts: Awaited<ReturnType<typeof rowCounts>>) => {
  assert.deepEqual(await rowCounts(), beforeCounts);
};

before(() => {
  process.env.OPERATOR_TOKEN = OPERATOR;
  db = setupTestDb();
});

beforeEach(async () => { await resetTestDb(db); });

after(async () => {
  await db.$disconnect();
  delete process.env.OPERATOR_TOKEN;
});

test("afterTaskId binds only the first of thirteen tasks and writes both audit rows", async () => {
  const seed = await fixture("valid-binding");
  const predecessorTasks = await instantiate(seed);
  const predecessor = predecessorTasks.at(-1)!;
  const before = await db.task.findMany({ where: { chainId: predecessor.chainId }, orderBy: { chainIndex: "asc" } });

  const response = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    afterTaskId: predecessor.id,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.tasks.length, STEP_COUNT);
  const successorTasks = await db.task.findMany({ where: { chainId: response.body.chainId }, orderBy: { chainIndex: "asc" } });
  assert.equal(successorTasks.length, STEP_COUNT);
  assert.equal(successorTasks[0]!.dispatchAfterTaskId, predecessor.id);
  assert.ok(successorTasks.slice(1).every((task) => task.dispatchAfterTaskId === null));
  assert.ok(successorTasks.every((task) => task.status === "TODO"));
  assert.equal(await db.run.count({ where: { task: { chainId: response.body.chainId } } }), 0);
  assert.deepEqual(
    await db.task.findMany({ where: { chainId: predecessor.chainId }, orderBy: { chainIndex: "asc" } }),
    before,
    "binding does not mutate predecessor tasks",
  );

  const firstActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: successorTasks[0]!.id },
    orderBy: { id: "asc" },
  });
  assert.equal(firstActivity.body, `Template instantiated; waiting for predecessor ${predecessor.name}`);
  assert.deepEqual(firstActivity.metadata, {
    chainId: response.body.chainId,
    templateId: seed.template.id,
    afterTaskId: predecessor.id,
    dispatchAfterTaskId: predecessor.id,
    predecessorTaskId: predecessor.id,
    predecessorChainId: predecessor.chainId,
  });
  const predecessorActivity = await db.taskActivity.findFirstOrThrow({
    where: { taskId: predecessor.id, body: { contains: "bound to predecessor" } },
  });
  assert.equal((predecessorActivity.metadata as { chainId: string }).chainId, response.body.chainId);
  assert.equal((predecessorActivity.metadata as { successorChainId: string }).successorChainId, response.body.chainId);
});

test("status PATCH cannot move an unresolved bound first task away from TODO", async () => {
  const seed = await fixture("bound-status-patch");
  for (const status of [TaskStatus.DOING, TaskStatus.DONE]) {
    const predecessor = (await instantiate(seed)).at(-1)!;
    const binding = await request(seed.project.id, seed.template.id, {
      repoId: seed.repo.id,
      variables: {},
      afterTaskId: predecessor.id,
    });
    assert.equal(binding.status, 201, JSON.stringify(binding.body));
    const first = await db.task.findFirstOrThrow({
      where: { chainId: binding.body.chainId },
      orderBy: { chainIndex: "asc" },
    });

    const response = await patchTaskStatus(first.id, status);
    const responseBody = await response.json() as { error: string };
    assert.equal(response.status, 409, JSON.stringify(responseBody));
    assert.match(responseBody.error, new RegExp(predecessor.name, "u"));
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: first.id } })).status, TaskStatus.TODO);
    assert.equal(await db.run.count({ where: { task: { chainId: binding.body.chainId } } }), 0);
    assert.equal(
      await db.task.count({ where: { chainId: binding.body.chainId, status: { not: TaskStatus.TODO } } }),
      0,
    );
  }
});

test("afterTaskId plus autoStart is a schema refusal before any database write", async () => {
  const seed = await fixture("auto-start-conflict");
  const predecessorTasks = await instantiate(seed);
  const predecessor = predecessorTasks.at(-1)!;
  const before = await rowCounts();
  const result = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    afterTaskId: predecessor.id,
    autoStart: true,
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, "dispatch_conflicts_with_auto_start");
  await assertNoPartialRows(before);
});

test("after-task refusals are typed and leave no partial chain rows", async () => {
  const seed = await fixture("binding-refusals");
  const missing = "missing-predecessor";
  const foreignProject = await db.project.create({
    data: { name: "foreign", slug: `foreign-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
  });
  const foreign = await db.task.create({
    data: {
      projectId: foreignProject.id,
      name: "Foreign predecessor",
      description: "foreign",
      chainId: "foreign-chain",
      chainIndex: STEP_COUNT,
      chainLayer: STEP_COUNT,
      status: "TODO",
    },
  });
  const manual = await db.task.create({
    data: {
      projectId: seed.project.id,
      repoId: seed.repo.id,
      assigneeAgentId: seed.agent.id,
      name: "Manual task",
      description: "manual",
      status: "TODO",
    },
  });
  const nonTerminal = (await instantiate(seed))[0]!;
  const parallelTasks = await instantiate(seed);
  const parallelTarget = parallelTasks.at(-1)!;
  const parallelSibling = parallelTasks.at(-2)!;
  await db.task.update({ where: { id: parallelSibling.id }, data: { chainLayer: parallelTarget.chainLayer } });
  const archived = (await instantiate(seed)).at(-1)!;
  await db.task.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
  const done = (await instantiate(seed)).at(-1)!;
  await db.task.update({ where: { id: done.id }, data: { status: "DONE" } });

  const cases = [
    { id: missing, code: "after_task_not_found" },
    { id: foreign.id, code: "after_task_not_found" },
    { id: manual.id, code: "after_task_not_chained" },
    { id: nonTerminal.id, code: "after_task_not_terminal" },
    { id: parallelTarget.id, code: "after_task_not_terminal" },
    { id: archived.id, code: "after_task_archived" },
    { id: done.id, code: "after_task_already_done" },
  ];
  for (const { id, code } of cases) {
    const before = await rowCounts();
    const result = await request(seed.project.id, seed.template.id, {
      repoId: seed.repo.id,
      variables: {},
      afterTaskId: id,
    });
    assert.equal(result.status, 400, `${code}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, code, `${code}: ${JSON.stringify(result.body)}`);
    await assertNoPartialRows(before);
  }
});

test("a predecessor can be bound once and the occupied pointer refusal preserves the first chain", async () => {
  const seed = await fixture("occupied-binding");
  const predecessor = (await instantiate(seed)).at(-1)!;
  const first = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    afterTaskId: predecessor.id,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstTasks = await db.task.findMany({ where: { chainId: first.body.chainId }, orderBy: { chainIndex: "asc" } });
  const before = await rowCounts();
  const second = await request(seed.project.id, seed.template.id, {
    repoId: seed.repo.id,
    variables: {},
    afterTaskId: predecessor.id,
  });
  assert.equal(second.status, 400, JSON.stringify(second.body));
  assert.equal(second.body.code, "after_task_already_bound");
  assert.deepEqual(
    await db.task.findMany({ where: { chainId: first.body.chainId }, orderBy: { chainIndex: "asc" } }),
    firstTasks,
  );
  await assertNoPartialRows(before);
});

test("concurrent binds serialize on the predecessor chain and create one successor", { timeout: 30_000 }, async () => {
  const seed = await fixture("concurrent-binding");
  const predecessor = (await instantiate(seed)).at(-1)!;
  const body = { repoId: seed.repo.id, variables: {}, afterTaskId: predecessor.id };
  const results = await Promise.all([
    request(seed.project.id, seed.template.id, body),
    request(seed.project.id, seed.template.id, body),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort((a, b) => a - b), [201, 400]);
  const refusal = results.find((result) => result.status === 400)!;
  assert.equal(refusal.body.code, "after_task_already_bound", JSON.stringify(refusal.body));
  assert.equal(await db.task.count(), STEP_COUNT * 2);
  assert.equal(await db.task.count({ where: { dispatchAfterTaskId: predecessor.id } }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: predecessor.id, body: { contains: "bound to predecessor" } } }), 1);
});
