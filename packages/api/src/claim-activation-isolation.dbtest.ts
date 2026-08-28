import "./test-workspace-root.js";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  enqueueTaskRun,
  FailureClass,
  PrismaClient,
  RunStatus,
  TaskStatus,
} from "@anneal/db";

import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const RUNNER_TOKEN = "claim-activation-isolation-runner";
const IMPLEMENTATION_BASE = "b".repeat(40);
const IMPLEMENTATION_HEAD = "a".repeat(40);
const implementationBody = (headSha = IMPLEMENTATION_HEAD) => JSON.stringify({
  schemaVersion: 1,
  baseSha: IMPLEMENTATION_BASE,
  headSha,
  summary: "preserved implementation evidence",
  testsRun: ["focused"],
});
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

const claim = (runnerId = "claim-activation-runner") => createApp(db).request("/runner/tasks/claim", {
  method: "POST",
  headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ runnerId, leaseSeconds: 60 }),
});

const seedCandidates = async (options: {
  valid?: boolean;
  inconsistent?: boolean;
  validInChain?: boolean;
} = {}) => {
  const project = await db.project.create({ data: {
    name: `claim-activation-${Date.now()}`,
    slug: `claim-activation-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  } });
  const environment = await db.environment.create({ data: {
    projectId: project.id,
    name: "claim-activation",
    allowedHosts: [],
  } });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "claim-activation-agent",
    title: "Claim activation agent",
    model: "claude",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "claim-activation-repo",
    remoteUrl: "https://example.test/claim-activation.git",
    mountPath: "/repo",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id,
    agentId: agent.id,
    repoId: repo.id,
    mountPath: "/repo",
    permissions: "GIT_WRITE",
  } });
  const template = await db.taskTemplate.create({ data: {
    projectId: project.id,
    name: "claim activation template",
    description: "claim activation isolation fixture",
    variables: [],
    steps: { create: [
      {
        stepIndex: 0,
        layer: 0,
        name: "Implementation",
        assigneeType: "AGENT",
        assigneeAgentId: agent.id,
        prompt: "implement",
      },
      {
        stepIndex: 1,
        layer: 1,
        name: "Review",
        assigneeType: "AGENT",
        assigneeAgentId: agent.id,
        prompt: "review",
        baseFromStepIndex: 0,
      },
    ] },
  }, include: { steps: { orderBy: { stepIndex: "asc" } } } });
  const chainId = `claim-activation-chain-${Math.floor(Math.random() * 1e9)}`;
  const sourceTask = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    templateId: template.id,
    templateStepId: template.steps[0]!.id,
    chainId,
    chainIndex: 0,
    chainLayer: 0,
    name: "Source implementation",
    description: "source",
  } });
  const sourceRun = await db.$transaction((tx) => enqueueTaskRun(tx as never, sourceTask.id));
  await db.run.update({
    where: { id: sourceRun.id },
    data: { status: RunStatus.SUCCEEDED, baseSha: IMPLEMENTATION_BASE, endedAt: new Date() },
  });
  await db.task.update({ where: { id: sourceTask.id }, data: { status: TaskStatus.DONE } });
  const originalSourceBody = implementationBody();
  const sourceOutput = await db.taskStepOutput.create({ data: {
    taskId: sourceTask.id,
    runId: sourceRun.id,
    kind: "implementation",
    body: originalSourceBody,
    commitSha: IMPLEMENTATION_HEAD,
  } });
  const poisonTask = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    assigneeAgentId: agent.id,
    templateId: template.id,
    templateStepId: template.steps[1]!.id,
    chainId,
    chainIndex: 1,
    chainLayer: 1,
    name: "Poisoned pinned review",
    description: "poison",
  } });
  const poisonRun = await db.$transaction((tx) => enqueueTaskRun(
    tx as never,
    poisonTask.id,
    new Date("2026-01-01T00:00:00.000Z"),
  ));
  await db.taskStepOutput.update({
    where: { id: sourceOutput.id },
    data: options.inconsistent
      ? { commitSha: "c".repeat(40), body: implementationBody("c".repeat(40)) }
      : { commitSha: null },
  });

  let validTask: Awaited<ReturnType<typeof db.task.create>> | null = null;
  let validRun: Awaited<ReturnType<typeof enqueueTaskRun>> | null = null;
  if (options.valid !== false) {
    validTask = await db.task.create({ data: {
      projectId: project.id,
      repoId: repo.id,
      assigneeAgentId: agent.id,
      ...(options.validInChain ? { chainId, chainIndex: 2, chainLayer: 2 } : {}),
      name: "Valid queued task",
      description: "valid",
    } });
    validRun = await db.$transaction((tx) => enqueueTaskRun(
      tx as never,
      validTask!.id,
      new Date("2026-01-01T00:00:01.000Z"),
    ));
  }
  return {
    project,
    environment,
    agent,
    repo,
    sourceTask,
    sourceRun,
    sourceOutput,
    expectedSourceBody: options.inconsistent ? implementationBody("c".repeat(40)) : originalSourceBody,
    poisonTask,
    poisonRun,
    validTask,
    validRun,
  };
};

const assertPoisonIsolated = async (
  seeded: Awaited<ReturnType<typeof seedCandidates>>,
  failureType: "PinnedBaseCommitError" | "PinnedRunTargetError" = "PinnedBaseCommitError",
) => {
  const [run, task, sessions, activities, notifications, output] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: seeded.poisonRun.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.poisonTask.id } }),
    db.session.count({ where: { runId: seeded.poisonRun.id } }),
    db.taskActivity.findMany({ where: { taskId: seeded.poisonTask.id } }),
    db.inboxMessage.findMany({ where: { taskId: seeded.poisonTask.id } }),
    db.taskStepOutput.findUniqueOrThrow({ where: { id: seeded.sourceOutput.id } }),
  ]);
  const reason = failureType === "PinnedBaseCommitError"
    ? `PinnedBaseCommitError: Pinned task ${seeded.poisonTask.id} cannot activate from step 0: referenced step has no recorded commitSha`
    : `PinnedRunTargetError: Pinned run ${seeded.poisonRun.id} targets ${seeded.poisonRun.targetBranch ?? "no commit"}, but its source step now records ${"c".repeat(40)}`;
  assert.equal(run.status, RunStatus.FAILED);
  assert.equal(run.failureClass, FailureClass.TASK_FAILED);
  assert.equal(run.failureReason, reason);
  assert.equal(run.retryable, false);
  assert.ok(run.endedAt);
  assert.equal(run.runnerId, null);
  assert.equal(run.leaseGeneration, 0);
  assert.equal(run.fencingToken, null);
  assert.equal(run.leaseExpiresAt, null);
  assert.equal(run.sessionTokenHash, null);
  assert.equal(run.claimedAt, null);
  assert.equal(task.status, TaskStatus.BACKLOG);
  assert.equal(task.failureReason, reason);
  assert.equal(sessions, 0);
  assert.equal(activities.length, 1);
  assert.match(activities[0]!.body, new RegExp(`^Queued run activation failed: ${failureType}:`, "u"));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.dedupeKey, `candidate-activation-failed:${seeded.poisonRun.id}`);
  assert.match(notifications[0]!.body, new RegExp(`${failureType}:`, "u"));
  assert.equal(output.body, seeded.expectedSourceBody);
};

test("a chained poison commits without waiting on a later sibling Run", { timeout: 20_000 }, async () => {
  const seeded = await seedCandidates({ validInChain: true });
  let siblingLocked!: () => void;
  let releaseSibling!: () => void;
  const siblingLockHeld = new Promise<void>((resolve) => { siblingLocked = resolve; });
  const releaseSiblingLock = new Promise<void>((resolve) => { releaseSibling = resolve; });
  const blocker = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Run" WHERE "id" = ${seeded.validRun!.id} FOR UPDATE`;
    siblingLocked();
    await releaseSiblingLock;
  });
  await siblingLockHeld;

  const claimRequest = claim();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parked: Response | null = null;
  try {
    parked = await Promise.race([
      claimRequest,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 5_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    releaseSibling();
    await blocker;
  }
  if (!parked) {
    await claimRequest;
    assert.fail("claim waited on a sibling Run after acquiring the full-chain mutex");
  }
  assert.equal(parked.status, 204);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: seeded.validRun!.id } })).status, RunStatus.QUEUED);
  await assertPoisonIsolated(seeded);

  const response = await claim("sibling-runner");
  assert.equal(response.status, 200);
  const claimed = await response.json() as { run: { id: string } };
  assert.equal(claimed.run.id, seeded.validRun!.id);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: seeded.validRun!.id } })).status, RunStatus.CLAIMED);
});

test("all-poison and repeated polls return 204 with one failure activity and notification", async () => {
  const seeded = await seedCandidates({ valid: false });
  const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => claim(`poison-poll-${index}`)));
  assert.deepEqual(responses.map((response) => response.status), [204, 204, 204, 204]);
  assert.equal((await claim("repeat-poll")).status, 204);
  await assertPoisonIsolated(seeded);
});

test("concurrent polls isolate one poison and claim the valid run exactly once", async () => {
  const seeded = await seedCandidates();
  const responses = await Promise.all([
    claim("concurrent-runner-1"),
    claim("concurrent-runner-2"),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 204]);
  const claimedBodies = await Promise.all(responses
    .filter((response) => response.status === 200)
    .map((response) => response.json() as Promise<{ run: { id: string } }>));
  assert.deepEqual(claimedBodies.map((body) => body.run.id), [seeded.validRun!.id]);
  await assertPoisonIsolated(seeded);
  assert.equal(await db.session.count({ where: { runId: seeded.validRun!.id } }), 1);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: seeded.validRun!.id } })).leaseGeneration, 1);
});

test("a queued pinned target inconsistent with its source authority is isolated", async () => {
  const seeded = await seedCandidates({ valid: false, inconsistent: true });
  assert.equal((await claim()).status, 204);
  await assertPoisonIsolated(seeded, "PinnedRunTargetError");
});

test("poisoned authority is isolated before its secret grants are decrypted", async () => {
  const seeded = await seedCandidates({ valid: false });
  const secret = await db.secret.create({ data: {
    name: `poison-secret-${Date.now()}`,
    encryptedValue: "must-not-be-decrypted",
    purpose: "ENV",
  } });
  await db.environmentSecret.create({ data: {
    environmentId: seeded.environment.id,
    secretId: secret.id,
    envVar: "POISON_SECRET",
  } });

  assert.equal((await claim()).status, 204);
  await assertPoisonIsolated(seeded);
});

test("a later unexpected activation error cannot roll back the committed chained park", async () => {
  const seeded = await seedCandidates();
  const secret = await db.secret.create({ data: {
    name: `unexpected-secret-error-${Date.now()}`,
    encryptedValue: "unused-ciphertext",
    purpose: "ENV",
  } });
  await db.environmentSecret.create({ data: {
    environmentId: seeded.environment.id,
    secretId: secret.id,
    envVar: "BROKEN_SECRET",
  } });

  assert.equal((await claim("park-before-unexpected-error")).status, 204);
  await assertPoisonIsolated(seeded);

  const response = await claim("unexpected-error-runner");
  assert.equal(response.status, 500);
  const [valid, sessions] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: seeded.validRun!.id } }),
    db.session.count({ where: { runId: { in: [seeded.poisonRun.id, seeded.validRun!.id] } } }),
  ]);
  assert.equal(valid.status, RunStatus.QUEUED);
  assert.equal(sessions, 0);
  await assertPoisonIsolated(seeded);
});

test("a database read failure is not classified as a candidate activation failure", async () => {
  const seeded = await seedCandidates({ valid: false });
  const failingDb = db.$extends({
    query: {
      taskStepOutput: {
        async findFirst() {
          throw new Error("candidate-authority-database-read-failed");
        },
      },
    },
  });
  const response = await createApp(failingDb as unknown as PrismaClient).request("/runner/tasks/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "database-error-runner", leaseSeconds: 60 }),
  });
  assert.equal(response.status, 500);
  const [run, task, activities, notifications, sessions] = await Promise.all([
    db.run.findUniqueOrThrow({ where: { id: seeded.poisonRun.id } }),
    db.task.findUniqueOrThrow({ where: { id: seeded.poisonTask.id } }),
    db.taskActivity.count({ where: { taskId: seeded.poisonTask.id } }),
    db.inboxMessage.count({ where: { taskId: seeded.poisonTask.id } }),
    db.session.count({ where: { runId: seeded.poisonRun.id } }),
  ]);
  assert.equal(run.status, RunStatus.QUEUED);
  assert.equal(task.status, TaskStatus.TODO);
  assert.equal(activities, 0);
  assert.equal(notifications, 0);
  assert.equal(sessions, 0);
});
