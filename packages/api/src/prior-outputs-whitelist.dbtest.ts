import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, FailureClass, PrismaClient, RunStatus, TaskStatus } from "@agentos/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "prior-output-whitelist-runner-token";
const priorRunnerToken = process.env.RUNNER_TOKEN;
let db: PrismaClient;

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

const claim = () => createApp(db).request("/runner/tasks/claim", {
  method: "POST",
  headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ runnerId: "prior-output-whitelist-runner", leaseSeconds: 60 }),
});

const createFixture = async (steps: Array<{ outputKind: string; priorOutputKinds: string[] }>) => {
  const project = await db.project.create({ data: {
    name: `prior-output-whitelist-${Date.now()}`,
    slug: `prior-output-whitelist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "prior-output-whitelist",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "prior-output-whitelist-agent",
    title: "Prior output whitelist agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "prior-output-whitelist-repo",
    remoteUrl: "https://example.test/prior-output-whitelist.git",
    mountPath: "/repo",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const template = await db.taskTemplate.create({
    data: {
      projectId: project.id,
      name: `toy prior output chain ${steps.length}`,
      description: "toy chain for exact prompt-input selection",
      variables: [],
      steps: { create: steps.map((step, index) => ({
        stepIndex: index + 1,
        layer: index + 1,
        name: `Toy step ${index + 1}`,
        assigneeType: "AGENT",
        assigneeAgentId: agent.id,
        prompt: `perform toy step ${index + 1}`,
        outputKind: step.outputKind,
        priorOutputKinds: step.priorOutputKinds,
        attachmentsFromPrevious: true,
        opensPullRequest: false,
      })) },
    },
    include: { steps: { orderBy: { stepIndex: "asc" } } },
  });
  const chainId = `prior-output-whitelist-chain-${Math.floor(Math.random() * 1e9)}`;
  const tasks = [];
  for (const step of template.steps) {
    tasks.push(await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      assigneeAgentId: agent.id,
      templateId: template.id,
      templateStepId: step.id,
      chainId,
      chainIndex: step.stepIndex,
      chainLayer: step.layer,
      name: step.name,
      description: step.prompt,
      status: TaskStatus.TODO,
    } }));
  }
  return { template, tasks };
};

test("a 12-step toy chain sends every claim exactly its declared prior outputs", async () => {
  const kinds = Array.from({ length: 12 }, (_, index) => `toy-step-${String(index + 1).padStart(2, "0")}`);
  const declarations = [
    [],
    [kinds[0]!],
    [kinds[0]!, kinds[1]!],
    [kinds[0]!, kinds[1]!, kinds[2]!],
    [kinds[3]!],
    [],
    [],
    [kinds[5]!, kinds[6]!],
    [kinds[4]!],
    [kinds[4]!, kinds[5]!, kinds[6]!, kinds[7]!],
    [],
    [],
  ];
  const { template, tasks } = await createFixture(kinds.map((outputKind, index) => ({
    outputKind,
    priorOutputKinds: declarations[index]!,
  })));
  const outputs: Array<{ kind: string; body: string }> = [];
  let savedPromptBytes = 0;

  for (const [index, task] of tasks.entries()) {
    const queued = await db.$transaction((tx) => enqueueTaskRun(tx as never, task.id));
    const response = await claim();
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const claimed = JSON.parse(text) as {
      run: { id: string };
      priorOutputs: Array<{ kind: string; body: string; task: { chainIndex: number | null } }>;
    };
    assert.equal(claimed.run.id, queued.id);
    assert.deepEqual(claimed.priorOutputs.map(({ kind }) => kind), declarations[index]);
    assert.deepEqual(claimed.priorOutputs.map(({ task: source }) => source.chainIndex), declarations[index]!.map((kind) => kinds.indexOf(kind) + 1));
    assert.deepEqual(
      claimed.priorOutputs.map(({ body }) => body),
      outputs.filter(({ kind }) => declarations[index]!.includes(kind)).map(({ body }) => body),
    );

    const allPriorBytes = Buffer.byteLength(outputs.map(({ kind, body }) => `\n## ${kind}\n${body}`).join(""));
    const selectedBytes = Buffer.byteLength(claimed.priorOutputs.map(({ kind, body }) => `\n## ${kind}\n${body}`).join(""));
    if (declarations[index]!.length < outputs.length) assert.ok(selectedBytes < allPriorBytes);
    savedPromptBytes += allPriorBytes - selectedBytes;

    const body = `unique-marker-${index + 1}\n${"x".repeat(index === 0 ? 42_000 : 7_000)}`;
    const headSha = (index + 1).toString(16).padStart(40, "0");
    await db.taskStepOutput.create({ data: {
      taskId: task.id,
      runId: queued.id,
      kind: template.steps[index]!.outputKind,
      body,
      commitSha: headSha,
    } });
    await db.run.update({ where: { id: queued.id }, data: {
      status: RunStatus.SUCCEEDED,
      baseSha: headSha,
      endedAt: new Date(),
    } });
    await db.task.update({ where: { id: task.id }, data: { status: TaskStatus.DONE } });
    outputs.push({ kind: kinds[index]!, body });
  }

  assert.ok(savedPromptBytes >= 80_000, `expected at least 80 KB saved across the toy chain, got ${savedPromptBytes}`);
});

test("a missing declared prior output loudly refuses the claim", async () => {
  const { tasks } = await createFixture([
    { outputKind: "spec", priorOutputKinds: [] },
    { outputKind: "implementation", priorOutputKinds: ["spec", "plan-review"] },
  ]);
  const sourceRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[0]!.id));
  await db.run.update({ where: { id: sourceRun.id }, data: { status: RunStatus.SUCCEEDED, endedAt: new Date() } });
  await db.task.update({ where: { id: tasks[0]!.id }, data: { status: TaskStatus.DONE } });
  await db.taskStepOutput.create({ data: {
    taskId: tasks[0]!.id,
    runId: sourceRun.id,
    kind: "spec",
    body: "available spec",
  } });
  const targetRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, tasks[1]!.id));

  const response = await claim();
  const body = await response.json() as { error: string; reason: string };
  assert.equal(response.status, 409);
  assert.equal(body.reason, "prior-output-missing");
  assert.match(body.error, /plan-review/u);
  const [failedRun, parkedTask, activity, notice] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: targetRun.id } }),
    db.task.findUniqueOrThrow({ where: { id: tasks[1]!.id } }),
    db.taskActivity.findFirstOrThrow({ where: { taskId: tasks[1]!.id, metadata: { path: ["condition"], equals: "prior-output-missing" } } }),
    db.inboxMessage.findUniqueOrThrow({ where: { dedupeKey: `prior-output-missing:${targetRun.id}` } }),
  ]);
  assert.equal(failedRun.status, RunStatus.FAILED);
  assert.equal(failedRun.failureClass, FailureClass.TASK_FAILED);
  assert.equal(failedRun.retryable, false);
  assert.equal(parkedTask.status, TaskStatus.BACKLOG);
  assert.match(activity.body, /prior output/i);
  assert.match(notice.body, /plan-review/u);
});
