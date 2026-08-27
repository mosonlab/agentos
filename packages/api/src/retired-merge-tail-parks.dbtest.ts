import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, InboxStatus, PrismaClient, RunStatus, TaskStatus } from "@agentos/db";

import {
  reconcileRetiredMergeTailParks,
  RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX,
  RETIRED_AUTHORITY_RESIGN_OPEN_PREFIX,
  RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX,
  RETIRED_INDEPENDENT_REVIEW_TASK_NAME,
} from "./retired-merge-tail-parks.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
let seedCounter = 0;

const seedProject = async () => {
  const seedId = `${Date.now()}-${(seedCounter += 1)}`;
  const project = await db.project.create({ data: { name: "Parks", slug: `parks-${seedId}` } });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: "local", allowedHosts: [] },
  });
  const agent = await db.agent.create({ data: {
    projectId: project.id,
    environmentId: environment.id,
    name: "review-coordinator",
    title: "review-coordinator",
    model: "gpt-5.6-sol:high",
    runnerPreference: "CODEX",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  } });
  const repo = await db.repo.create({ data: {
    projectId: project.id,
    name: "widgets",
    remoteUrl: "https://github.com/acme/widgets.git",
    mountPath: "/repo",
    defaultBranch: "main",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: project.id, repoId: repo.id, agentId: agent.id, mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  return { project, agent, repo };
};

test("a readiness step parked on the retired independent review returns to the queue", async () => {
  const { project, agent, repo } = await seedProject();
  const review = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    name: RETIRED_INDEPENDENT_REVIEW_TASK_NAME,
    description: "blind review",
    status: TaskStatus.TODO,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
  } });
  const queuedRun = await enqueueTaskRun(db, review.id);
  const readiness = await db.task.create({ data: {
    projectId: project.id,
    name: "Merge readiness",
    description: "readiness",
    status: TaskStatus.REVIEW,
    failureReason: `${RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX}${review.id}:${HEAD}`,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
  } });

  const result = await reconcileRetiredMergeTailParks(db);

  assert.equal(result.unparkedReviews, 1);
  assert.equal(result.archivedReviewTasks, 1);
  assert.equal(result.cancelledReviewRuns, 1);
  assert.equal(result.reviewTasksWithActiveRuns, 0);

  const unparked = await db.task.findUniqueOrThrow({ where: { id: readiness.id } });
  assert.equal(unparked.status, TaskStatus.TODO);
  assert.equal(unparked.failureReason, null);

  const archived = await db.task.findUniqueOrThrow({ where: { id: review.id } });
  assert.ok(archived.archivedAt, "the orphaned review task is archived");
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: queuedRun.id } })).status, RunStatus.CANCELLED);

  // The unpark is visible on the task rather than silent.
  const activity = await db.taskActivity.findFirst({ where: { taskId: readiness.id } });
  assert.match(activity?.body ?? "", /independent blind review was retired/u);
});

test("a regression step parked on the retired re-signature returns to the queue and its message closes", async () => {
  const { project, agent } = await seedProject();
  const regression = await db.task.create({ data: {
    projectId: project.id,
    name: "Regression verification",
    description: "regression",
    status: TaskStatus.REVIEW,
    failureReason: `${RETIRED_AUTHORITY_RESIGN_OPEN_PREFIX}${HEAD}`,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
  } });
  await db.inboxMessage.create({ data: {
    from: "AGENT",
    taskId: regression.id,
    kind: "TEXT",
    body: "re-sign release-authority.json",
    dedupeKey: `${RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX}${regression.id}:${HEAD}`,
  } });

  const result = await reconcileRetiredMergeTailParks(db);

  assert.equal(result.unparkedResigns, 1);
  assert.equal(result.closedResignMessages, 1);

  const unparked = await db.task.findUniqueOrThrow({ where: { id: regression.id } });
  assert.equal(unparked.status, TaskStatus.TODO);
  assert.equal(unparked.failureReason, null);

  const message = await db.inboxMessage.findFirstOrThrow({ where: { taskId: regression.id } });
  assert.equal(message.status, InboxStatus.CLOSED);
});

test("a review task with an active run is left for that run rather than archived", async () => {
  const { project, agent, repo } = await seedProject();
  const review = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    name: RETIRED_INDEPENDENT_REVIEW_TASK_NAME,
    description: "blind review",
    status: TaskStatus.DOING,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
  } });
  const active = await enqueueTaskRun(db, review.id);
  await db.run.update({ where: { id: active.id }, data: { status: RunStatus.RUNNING } });

  const result = await reconcileRetiredMergeTailParks(db);

  assert.equal(result.reviewTasksWithActiveRuns, 1);
  assert.equal(result.archivedReviewTasks, 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: review.id } })).archivedAt, null);
});

test("the sweep is idempotent: a second pass finds nothing left to move", async () => {
  const { project, agent, repo } = await seedProject();
  const review = await db.task.create({ data: {
    projectId: project.id,
    repoId: repo.id,
    name: RETIRED_INDEPENDENT_REVIEW_TASK_NAME,
    description: "blind review",
    status: TaskStatus.TODO,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
  } });
  await db.task.create({ data: {
    projectId: project.id,
    name: "Merge readiness",
    description: "readiness",
    status: TaskStatus.REVIEW,
    failureReason: `${RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX}${review.id}`,
    assigneeType: "AGENT",
    assigneeAgentId: agent.id,
  } });

  const first = await reconcileRetiredMergeTailParks(db);
  assert.equal(first.unparkedReviews, 1);
  assert.equal(first.archivedReviewTasks, 1);

  const second = await reconcileRetiredMergeTailParks(db);
  assert.deepEqual(second, {
    unparkedReviews: 0,
    unparkedResigns: 0,
    archivedReviewTasks: 0,
    cancelledReviewRuns: 0,
    closedResignMessages: 0,
    reviewTasksWithActiveRuns: 0,
  });
});
