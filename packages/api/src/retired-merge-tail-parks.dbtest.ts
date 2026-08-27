import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { enqueueTaskRun, InboxStatus, PrismaClient, RunStatus, TaskStatus } from "@agentos/db";

import {
  reconcileRetiredMergeTailParks,
  RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX,
  RETIRED_AUTHORITY_RESIGN_OPEN_PREFIX,
  RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX,
  RETIRED_INDEPENDENT_REVIEW_TASK_NAME,
  RETIRED_REVIEW_OBLIGATION_MARKER_KIND,
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

/** A review task carrying the control-plane obligation marker its opener wrote. */
const seedReviewTask = async (
  seed: Awaited<ReturnType<typeof seedProject>>,
  options: { marker?: boolean } = {},
) => {
  const review = await db.task.create({ data: {
    projectId: seed.project.id,
    repoId: seed.repo.id,
    name: RETIRED_INDEPENDENT_REVIEW_TASK_NAME,
    description: "blind review",
    status: TaskStatus.TODO,
    assigneeType: "AGENT",
    assigneeAgentId: seed.agent.id,
  } });
  if (options.marker ?? true) {
    await db.taskActivity.create({ data: {
      taskId: review.id,
      actorType: "control-plane",
      body: "Blind review obligation",
      metadata: { kind: RETIRED_REVIEW_OBLIGATION_MARKER_KIND, schemaVersion: 1, state: "open" },
    } });
  }
  return review;
};

const seedReadinessPark = async (
  seed: Awaited<ReturnType<typeof seedProject>>,
  reviewTaskId: string,
) => db.task.create({ data: {
  projectId: seed.project.id,
  repoId: seed.repo.id,
  name: "Merge readiness",
  description: "readiness",
  status: TaskStatus.REVIEW,
  failureReason: `${RETIRED_INDEPENDENT_REVIEW_OPEN_PREFIX}${reviewTaskId}:${HEAD}`,
  assigneeType: "AGENT",
  assigneeAgentId: seed.agent.id,
} });

const seedResignPark = async (seed: Awaited<ReturnType<typeof seedProject>>) => db.task.create({ data: {
  projectId: seed.project.id,
  repoId: seed.repo.id,
  name: "Regression verification",
  description: "regression",
  status: TaskStatus.REVIEW,
  failureReason: `${RETIRED_AUTHORITY_RESIGN_OPEN_PREFIX}${HEAD}`,
  assigneeType: "AGENT",
  assigneeAgentId: seed.agent.id,
} });

test("a readiness park returns to the queue for the server worker, with no run opened", async () => {
  const seed = await seedProject();
  const review = await seedReviewTask(seed);
  const queuedRun = await enqueueTaskRun(db, review.id);
  const readiness = await seedReadinessPark(seed, review.id);

  const result = await reconcileRetiredMergeTailParks(db);
  assert.equal(result.unparkedReviews, 1);
  assert.equal(result.archivedReviewTasks, 1);
  assert.equal(result.cancelledReviewRuns, 1);

  const unparked = await db.task.findUniqueOrThrow({ where: { id: readiness.id } });
  assert.equal(unparked.status, TaskStatus.TODO);
  assert.equal(unparked.failureReason, null);
  // The readiness worker claims TODO itself; opening a run here would create a
  // second executor for a server-owned step.
  assert.equal(await db.run.count({ where: { taskId: readiness.id } }), 0);

  const archived = await db.task.findUniqueOrThrow({ where: { id: review.id } });
  assert.ok(archived.archivedAt);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: queuedRun.id } })).status, RunStatus.CANCELLED);
});

test("a resign park returns to the queue with a fresh run, and its message closes", async () => {
  const seed = await seedProject();
  const regression = await seedResignPark(seed);
  await db.inboxMessage.create({ data: {
    from: "AGENT",
    taskId: regression.id,
    kind: "TEXT",
    body: "re-sign release-authority.json",
    dedupeKey: `${RETIRED_AUTHORITY_RESIGN_DEDUPE_PREFIX}${regression.id}:${HEAD}`,
  } });

  const result = await reconcileRetiredMergeTailParks(db);
  assert.equal(result.unparkedResigns, 1);
  assert.equal(result.queuedResignRuns, 1);
  assert.equal(result.closedResignMessages, 1);

  const unparked = await db.task.findUniqueOrThrow({ where: { id: regression.id } });
  assert.equal(unparked.status, TaskStatus.TODO);
  assert.equal(unparked.failureReason, null);

  // Nothing claims an agent step from TODO on its own: without this run the
  // step would simply be invisible in a different state.
  const runs = await db.run.findMany({ where: { taskId: regression.id } });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, RunStatus.QUEUED);

  const message = await db.inboxMessage.findFirstOrThrow({ where: { taskId: regression.id } });
  assert.equal(message.status, InboxStatus.CLOSED);
  assert.ok(message.answeredAt);
});

test("a review task with an active run is left for that run rather than archived", async () => {
  const seed = await seedProject();
  const review = await seedReviewTask(seed);
  const active = await enqueueTaskRun(db, review.id);
  await db.run.update({ where: { id: active.id }, data: { status: RunStatus.RUNNING } });

  const result = await reconcileRetiredMergeTailParks(db);
  assert.equal(result.reviewTasksWithActiveRuns, 1);
  assert.equal(result.archivedReviewTasks, 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: review.id } })).archivedAt, null);
});

test("a task merely named like a review task is never archived without control-plane evidence", async () => {
  const seed = await seedProject();
  // Same name, no obligation marker and no park pointing at it: an operator's
  // own task, which this sweep must not touch.
  const impostor = await seedReviewTask(seed, { marker: false });
  const run = await enqueueTaskRun(db, impostor.id);

  const result = await reconcileRetiredMergeTailParks(db);
  assert.equal(result.archivedReviewTasks, 0);
  assert.equal(result.cancelledReviewRuns, 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: impostor.id } })).archivedAt, null);
  assert.equal((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status, RunStatus.QUEUED);
});

test("a park whose review task carries no marker is still archived, on the park's evidence", async () => {
  const seed = await seedProject();
  const review = await seedReviewTask(seed, { marker: false });
  await seedReadinessPark(seed, review.id);

  const result = await reconcileRetiredMergeTailParks(db);
  assert.equal(result.archivedReviewTasks, 1);
  assert.ok((await db.task.findUniqueOrThrow({ where: { id: review.id } })).archivedAt);
});

test("the sweep is idempotent and does not restack notes on a non-convergent branch", async () => {
  const seed = await seedProject();
  const review = await seedReviewTask(seed);
  const active = await enqueueTaskRun(db, review.id);
  await db.run.update({ where: { id: active.id }, data: { status: RunStatus.RUNNING } });
  const readiness = await seedReadinessPark(seed, review.id);

  const first = await reconcileRetiredMergeTailParks(db);
  assert.equal(first.unparkedReviews, 1);
  assert.equal(first.reviewTasksWithActiveRuns, 1);

  const second = await reconcileRetiredMergeTailParks(db);
  assert.equal(second.unparkedReviews, 0);
  assert.equal(second.reviewTasksWithActiveRuns, 1);

  // The active-run branch reports rather than changes anything, so it sees the
  // same row on every start. It must not stack a note per restart.
  assert.equal(await db.taskActivity.count({
    where: { taskId: review.id, actorType: "control-plane", body: { contains: "left unarchived on purpose" } },
  }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: readiness.id, actorType: "control-plane" } }), 1);
});

test("two instances starting at once release each park exactly once", async () => {
  const seed = await seedProject();
  const review = await seedReviewTask(seed);
  await enqueueTaskRun(db, review.id);
  const readiness = await seedReadinessPark(seed, review.id);
  const regression = await seedResignPark(seed);

  // Both API hosts run this sweep against the one database on start. Each of
  // them reads the same snapshot; only one may act on it.
  const [left, right] = await Promise.all([
    reconcileRetiredMergeTailParks(db),
    reconcileRetiredMergeTailParks(db),
  ]);

  assert.equal(left.unparkedReviews + right.unparkedReviews, 1);
  assert.equal(left.unparkedResigns + right.unparkedResigns, 1);
  assert.equal(left.archivedReviewTasks + right.archivedReviewTasks, 1);
  assert.ok(left.alreadyResolved + right.alreadyResolved > 0, "the loser records that someone else moved the row");

  // One resume means one run, not two: a double unpark would spend a second
  // agent session on the same step.
  assert.equal(await db.run.count({ where: { taskId: regression.id } }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: readiness.id, actorType: "control-plane" } }), 1);
  assert.equal(await db.taskActivity.count({ where: { taskId: regression.id, actorType: "control-plane" } }), 1);
  assert.equal(await db.run.count({ where: { taskId: review.id, status: RunStatus.CANCELLED } }), 1);
});
