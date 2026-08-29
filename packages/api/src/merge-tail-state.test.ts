import assert from "node:assert/strict";
import test from "node:test";

import {
  MergeRecoveryStatus,
  Prisma,
  TaskStatus,
  type RecoveryContext,
} from "@anneal/db";

import {
  awaitAuthorization,
  blockDownstream,
  exhaust,
  reopenAfterHeadAdoption,
} from "./merge-tail-state.js";

const recovery: RecoveryContext = {
  aggregateId: "aggregate-1",
  attempt: 2,
  sourceStopId: "stop-1",
  sourceRunId: "source-run-1",
  authorizationActivityId: "authorization-1",
  repository: "acme/widgets",
  prNumber: 42,
  targetBranch: "main",
  authorizedHeadSha: "a".repeat(40),
  authorizedBaseSha: "b".repeat(40),
  observedBaseSha: "c".repeat(40),
  currentBaseSha: "d".repeat(40),
  readinessTaskId: "readiness-1",
  regressionTaskId: "regression-1",
  integratorTaskId: "integrator-1",
  recoveryRunId: "recovery-run-1",
};

const stateTx = (status: MergeRecoveryStatus, failureReason = "head adoption failed") => {
  const recoveryUpdates: Array<Record<string, any>> = [];
  const taskUpdates: Array<Record<string, any>> = [];
  const outputDeletes: Array<Record<string, any>> = [];
  const activities: Array<Record<string, any>> = [];
  const notices: Array<Record<string, any>> = [];
  const tx = {
    mergeRecoveryAttempt: {
      findUnique: async (args: Record<string, any>) => (
        args.select?.failureReason ? { failureReason } : { status }
      ),
      update: async (args: Record<string, any>) => {
        recoveryUpdates.push(args);
        return { id: recovery.aggregateId, status: args.data.status };
      },
    },
    task: {
      update: async (args: Record<string, any>) => {
        taskUpdates.push(args);
        return {};
      },
    },
    taskStepOutput: {
      deleteMany: async (args: Record<string, any>) => {
        outputDeletes.push(args);
        return { count: 1 };
      },
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, any> }) => {
        activities.push(data);
        return data;
      },
    },
    inboxMessage: {
      upsert: async (args: Record<string, any>) => {
        notices.push(args);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, recoveryUpdates, taskUpdates, outputDeletes, activities, notices };
};

test("awaitAuthorization atomically owns the recovery Task tuple and marker", async () => {
  const observed = stateTx(MergeRecoveryStatus.REPAIRING);

  await awaitAuthorization(observed.tx, recovery);

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.AWAITING_AUTHORIZATION);
  assert.deepEqual(observed.taskUpdates, [
    { where: { id: recovery.regressionTaskId }, data: { status: TaskStatus.DONE, failureReason: null } },
    { where: { id: recovery.readinessTaskId }, data: { status: TaskStatus.TODO, failureReason: null } },
    { where: { id: recovery.integratorTaskId }, data: { status: TaskStatus.REVIEW } },
  ]);
  assert.deepEqual(
    observed.activities.map((activity) => activity.metadata.state),
    ["awaiting-authorization", "awaiting-authorization", "queued"],
  );
});

test("blockDownstream atomically parks all three Tasks and writes its deduped marker", async () => {
  const observed = stateTx(MergeRecoveryStatus.AWAITING_AUTHORIZATION);
  const at = new Date("2026-08-29T12:00:00.000Z");

  await blockDownstream(observed.tx, {
    recovery,
    phase: "readiness",
    reason: "verified head moved",
    at,
  });

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.BLOCKED_DOWNSTREAM);
  assert.deepEqual(
    observed.taskUpdates.map((update) => [update.where.id, update.data.status]),
    [
      [recovery.regressionTaskId, TaskStatus.REVIEW],
      [recovery.readinessTaskId, TaskStatus.REVIEW],
      [recovery.integratorTaskId, TaskStatus.REVIEW],
    ],
  );
  assert.deepEqual(observed.activities.map((activity) => activity.metadata.state), ["tail-stopped", "tail-stopped"]);
  assert.equal(
    observed.notices[0]?.where.dedupeKey,
    `merge-base-drift-recovery-tail-stop:${recovery.sourceStopId}:readiness`,
  );
});

test("reopenAfterHeadAdoption takes the declared BLOCKED_DOWNSTREAM reopen edge", async () => {
  const observed = stateTx(MergeRecoveryStatus.BLOCKED_DOWNSTREAM);

  await reopenAfterHeadAdoption(observed.tx, {
    recovery,
    expectedFailureReason: "head adoption failed",
  });

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.REPAIRING);
  assert.deepEqual(
    observed.taskUpdates.map((update) => [update.where.id, update.data.status]),
    [
      [recovery.regressionTaskId, TaskStatus.DONE],
      [recovery.readinessTaskId, TaskStatus.TODO],
      [recovery.integratorTaskId, TaskStatus.REVIEW],
    ],
  );
  assert.deepEqual(observed.outputDeletes, [{ where: { taskId: recovery.readinessTaskId } }]);
  assert.deepEqual(observed.activities.map((activity) => activity.metadata.state), [
    "reopened-head-adoption",
    "reopened-head-adoption",
  ]);
});

test("exhaust atomically fails validation and parks the integrator", async () => {
  const observed = stateTx(MergeRecoveryStatus.VALIDATING);

  await exhaust(observed.tx, {
    aggregateId: recovery.aggregateId,
    integratorTaskId: recovery.integratorTaskId,
    sourceStopId: recovery.sourceStopId,
    reason: "recovery budget exhausted",
    at: new Date("2026-08-29T12:00:00.000Z"),
    attempt: recovery.attempt,
    state: "exhausted",
    recoveryData: {},
    markerMetadata: {},
  });

  assert.equal(observed.recoveryUpdates[0]?.data.status, MergeRecoveryStatus.FAILED);
  assert.deepEqual(observed.taskUpdates, [{
    where: { id: recovery.integratorTaskId },
    data: { status: TaskStatus.REVIEW, failureReason: "recovery budget exhausted" },
  }]);
  assert.equal(observed.activities[0]?.metadata.state, "exhausted");
  assert.equal(observed.notices.length, 1);
});

test("named migrations reject undeclared recovery edges before Task or marker writes", async () => {
  const observed = stateTx(MergeRecoveryStatus.FAILED);

  await assert.rejects(
    awaitAuthorization(observed.tx, recovery),
    /Illegal merge recovery transition FAILED -> AWAITING_AUTHORIZATION/u,
  );

  assert.deepEqual(observed.recoveryUpdates, []);
  assert.deepEqual(observed.taskUpdates, []);
  assert.deepEqual(observed.activities, []);
});
