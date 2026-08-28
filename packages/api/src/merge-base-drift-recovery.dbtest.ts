import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AUTHORIZED_MERGE_METHOD,
  applyInboxDecisionTx,
  enqueueTaskRun,
  MERGE_INTEGRATOR_KIND,
  Prisma,
  PrismaClient,
  TaskStatus,
  authorizationMetadata,
  parseAuthorizationMetadata,
  readMarkerHistory,
  writeMarker,
  recordIntegratorStop,
  type StopCondition,
} from "@anneal/db";

import { handleRegressionCompletion } from "./merge-tail-actions.js";
import { baseDriftRecoveryTick } from "./merge-base-drift-worker.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import {
  withMergeLease,
  type MergeLeaseAcquirer,
  type MergeLeaseReleaser,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { readinessTick, reopenRecoveryHeadAdoptionFailures } from "./merge-readiness-worker.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const HEAD = "a".repeat(40);
const HEAD_2 = "f".repeat(40);
const BASE = "b".repeat(40);
const BASE_2 = "c".repeat(40);
const BASE_3 = "d".repeat(40);
const BASE_4 = "e".repeat(40);
const OPERATOR = "base-drift-recovery-operator";
const acquireChainLease: MergeLeaseAcquirer = async () => ({ outcome: "acquired" });
const releaseLeaseAdapter: MergeLeaseReleaser = async () => ({ outcome: "not-held" });
const releaseChainLease: ReleaseMergeLease = async () => {};
const runWithMergeLease: WithMergeLease = (target, fn, db) => withMergeLease(target, fn, db, {
  acquire: acquireChainLease,
  release: releaseLeaseAdapter,
});

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const operatorRequest = async (path: string, method: "GET" | "PATCH" | "POST", body?: unknown) => {
  const prior = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = OPERATOR;
  try {
    return await createApp(db).request(path, {
      method,
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = prior;
  }
};

const assertIntegratorGuarded = async (integratorTaskId: string) => {
  assert.equal((await operatorRequest(`/tasks/${integratorTaskId}`, "PATCH", { status: "DONE" })).status, 409);
  assert.equal((await operatorRequest(`/tasks/${integratorTaskId}/retry`, "POST")).status, 409);
  await assert.rejects(
    db.$transaction((tx) => enqueueTaskRun(tx, integratorTaskId)),
    /stopped on base-drift/u,
  );
};

const snapshot = (baseSha: string, overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 123, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "master", baseSha,
  headRefOid: HEAD, headCommitOid: HEAD, autoMergeRequest: null, mergeQueueEntry: null,
  repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: [], checkContexts: [],
  readAt: new Date("2026-08-22T01:00:00.000Z").toISOString(), ...overrides,
});

const reader = (
  current: PullRequestSnapshot,
  files: Array<{ filename: string; previousFilename: string | null; patch: string | null }> = [],
  filesComplete = true,
): PullRequestReader => ({
  readPullRequest: async () => current,
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete, files }),
});

const authorize = async (readinessTaskId: string, baseSha: string) => {
  const binding = `mechanical:${readinessTaskId}:${randomUUID()}`;
  const activity = await db.taskActivity.create({ data: {
    taskId: readinessTaskId, actorType: "control-plane", body: `authorized ${baseSha}`,
    metadata: authorizationMetadata({
      schemaVersion: 1, nonce: randomUUID(), repository: "acme/widgets", prNumber: 123,
      headSha: HEAD, baseRef: "master", baseSha, mergeMethod: AUTHORIZED_MERGE_METHOD,
      requiredChecks: [], readAt: new Date().toISOString(), issuedAt: new Date().toISOString(),
      decision: { channel: "mechanical", inboxDecisionId: binding, inboxMessageId: binding },
    }) as Prisma.InputJsonObject,
  } });
  await db.taskStepOutput.upsert({ where: { taskId: readinessTaskId }, create: {
    taskId: readinessTaskId, kind: "merge-authorization",
    body: JSON.stringify({ authorizationActivityId: activity.id, headSha: HEAD }), commitSha: HEAD,
  }, update: {
    kind: "merge-authorization", body: JSON.stringify({ authorizationActivityId: activity.id, headSha: HEAD }), commitSha: HEAD,
  } });
  return activity;
};

const mechanicalStop = async (
  seeded: Awaited<ReturnType<typeof seedIntegratorChain>>,
  authorizationActivityId: string,
  authorizedBaseSha: string,
  observedBaseSha: string,
  condition: StopCondition = "base-drift",
  evidence = JSON.stringify({ observed: observedBaseSha, authorized: authorizedBaseSha }),
  recordIntent = true,
) => {
  const previous = await db.run.findFirst({ where: { taskId: seeded.integratorTask!.id }, orderBy: { runNumber: "desc" } });
  const run = previous?.status === "QUEUED"
    ? await db.run.update({ where: { id: previous.id }, data: { status: "SUCCEEDED" } })
    : await db.run.create({ data: {
        projectId: seeded.project.id, taskId: seeded.integratorTask!.id, agentId: seeded.integratorAgent.id,
        repoId: seeded.repo.id, runNumber: (previous?.runNumber ?? 0) + 1,
        dedupeKey: `task:${seeded.integratorTask!.id}:run:${(previous?.runNumber ?? 0) + 1}`,
        runner: "CLAUDE", model: "mechanical/merge-executor-v1", promptHash: "mechanical",
        status: "SUCCEEDED", opensPullRequest: false, maxRunsPerTask: 5, targetBranch: "master",
      } });
  const session = await db.session.create({ data: {
    runId: run.id, projectId: seeded.project.id, taskId: seeded.integratorTask!.id,
    agentId: seeded.integratorAgent.id, runner: "CLAUDE", executionStatus: "SUCCEEDED",
  } });
  if (recordIntent) {
    await db.taskActivity.create({ data: {
      taskId: seeded.integratorTask!.id, actorType: "merge-executor", body: "intent",
      metadata: {
        kind: MERGE_INTEGRATOR_KIND.intent, schemaVersion: 1, sourceRunId: run.id,
        idempotencyKey: `123:${HEAD}:${authorizationActivityId}`, prNumber: 123,
        headSha: HEAD, authorizationActivityId,
      },
    } });
  }
  const outputBody = JSON.stringify({ outcome: "stopped", condition, evidence });
  await db.taskStepOutput.upsert({ where: { taskId: seeded.integratorTask!.id }, create: {
    taskId: seeded.integratorTask!.id, runId: run.id, kind: "merge-result", body: outputBody,
  }, update: { runId: run.id, kind: "merge-result", body: outputBody } });
  await db.$transaction((tx) => recordIntegratorStop(tx, {
    integratorTaskId: seeded.integratorTask!.id, condition, evidence,
    agentId: seeded.integratorAgent.id, sessionId: session.id, sourceRunId: run.id,
  }));
  return run;
};

const seedStopped = async (shape: "canonical-direct" | "canonical-compound-readiness", label: string) => {
  const seeded = await seedIntegratorChain(db, { label, shape });
  const authorization = await authorize(seeded.readinessTask!.id, BASE);
  await mechanicalStop(seeded, authorization.id, BASE, BASE_2);
  return seeded;
};

const recordRecoveryPass = async (
  seeded: Awaited<ReturnType<typeof seedIntegratorChain>>,
  baseSha: string,
  headSha = HEAD,
) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: seeded.gateTask.id }, orderBy: { runNumber: "desc" } });
  await db.run.update({ where: { id: run.id }, data: { status: "SUCCEEDED", headSha } });
  await db.taskStepOutput.upsert({ where: { taskId: seeded.gateTask.id }, create: {
    taskId: seeded.gateTask.id, runId: run.id, kind: "regression-verification",
    body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha, baseHeadSha: baseSha, gateVerdict: "PASS" }), commitSha: headSha,
  }, update: {
    runId: run.id, kind: "regression-verification",
    body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha, baseHeadSha: baseSha, gateVerdict: "PASS" }), commitSha: headSha,
  } });
  await db.task.update({ where: { id: seeded.gateTask.id }, data: { status: TaskStatus.DONE } });
  return run;
};

const finishRecoveryPass = async (
  seeded: Awaited<ReturnType<typeof seedIntegratorChain>>,
  baseSha: string,
) => {
  await recordRecoveryPass(seeded, baseSha);
  const tick = await readinessTick(db, reader(snapshot(baseSha)), new Date(), 5, releaseChainLease, runWithMergeLease);
  assert.equal(tick.authorized, 1);
  return db.taskActivity.findFirstOrThrow({
    where: { taskId: seeded.readinessTask!.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization } },
    orderBy: { createdAt: "desc" },
  });
};

test("queued recovery keeps generic PATCH, retry, and enqueue blocked until readiness completes", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "queued-recovery-guard");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);

  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({ where: { integratorTaskId: seeded.integratorTask!.id } });
  assert.equal(aggregate.status, "REPAIRING");
  assert.equal(aggregate.recoveryRunId !== null, true);
  const detail = await operatorRequest(`/tasks/${seeded.gateTask.id}`, "GET");
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as any).mergeRecovery.phase, "repair");

  await assertIntegratorGuarded(seeded.integratorTask!.id);
  assert.equal(await db.run.count({ where: { taskId: seeded.integratorTask!.id } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.integratorTask!.id } })).status, TaskStatus.REVIEW);
});

test("fresh server-owned readiness authorization alone activates the recovery merge executor", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "readiness-recovery-activation");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  await assertIntegratorGuarded(seeded.integratorTask!.id);

  const authorization = await finishRecoveryPass(seeded, BASE_2);
  const parsed = parseAuthorizationMetadata(authorization.metadata);
  assert.equal(parsed.status, "ok");
  if (parsed.status === "ok") {
    assert.equal(parsed.payload.baseSha, BASE_2);
    assert.equal(parsed.payload.headSha, HEAD);
    assert.equal(parsed.payload.decision.channel, "mechanical");
  }
  assert.equal(typeof (authorization.metadata as any).recoverySourceStopId, "string");
  const runs = await db.run.findMany({
    where: { taskId: seeded.integratorTask!.id },
    orderBy: { runNumber: "asc" },
  });
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.status, "QUEUED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.integratorTask!.id } })).status, TaskStatus.TODO);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({ where: { integratorTaskId: seeded.integratorTask!.id } });
  assert.equal(aggregate.status, "SUCCEEDED");
  assert.equal(aggregate.authorizationActivityId, authorization.id);
  assert.equal(aggregate.endedAt !== null, true);
});

test("recovery adopts the verified head produced by merging the current base before authorization", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "readiness-recovery-adopts-regression-head");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);

  await recordRecoveryPass(seeded, BASE_2, HEAD_2);
  const tick = await readinessTick(
    db,
    reader(snapshot(BASE_2, { headRefOid: HEAD_2, headCommitOid: HEAD_2 })),
    new Date(),
    5,
    releaseChainLease,
    runWithMergeLease,
  );
  assert.equal(tick.authorized, 1);

  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: seeded.integratorTask!.id },
  });
  assert.equal(aggregate.status, "SUCCEEDED");
  assert.equal(aggregate.authorizedHeadSha, HEAD_2);
  const authorization = await db.taskActivity.findFirstOrThrow({
    where: { taskId: seeded.readinessTask!.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization } },
    orderBy: { createdAt: "desc" },
  });
  const parsed = parseAuthorizationMetadata(authorization.metadata);
  assert.equal(parsed.status, "ok");
  if (parsed.status === "ok") assert.equal(parsed.payload.headSha, HEAD_2);
  assert.equal(await db.run.count({ where: { taskId: seeded.integratorTask!.id, status: "QUEUED" } }), 1);
});

test("the deployed head-adoption fix reopens its exact legacy downstream stop once", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "readiness-recovery-reopens-head-adoption-stop");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  await recordRecoveryPass(seeded, BASE_2, HEAD_2);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: seeded.integratorTask!.id },
  });
  const failure = "readiness evaluation failed: Recovery activation authorization is not fresh for the recovered exact head and current base";
  await db.mergeRecoveryAttempt.update({ where: { id: aggregate.id }, data: {
    status: "BLOCKED_DOWNSTREAM", failureReason: failure, endedAt: new Date(),
  } });
  await db.task.updateMany({
    where: { id: { in: [seeded.gateTask.id, seeded.readinessTask!.id, seeded.integratorTask!.id] } },
    data: { status: TaskStatus.REVIEW, failureReason: failure },
  });

  assert.equal(await reopenRecoveryHeadAdoptionFailures(db), 1);
  assert.equal(await reopenRecoveryHeadAdoptionFailures(db), 0);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.gateTask.id } })).status, TaskStatus.DONE);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.readinessTask!.id } })).status, TaskStatus.TODO);
  assert.equal((await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } })).status, "REPAIRING");

  const tick = await readinessTick(
    db,
    reader(snapshot(BASE_2, { headRefOid: HEAD_2, headCommitOid: HEAD_2 })),
    new Date(),
    5,
    releaseChainLease,
    runWithMergeLease,
  );
  assert.equal(tick.authorized, 1);
  const completed = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: aggregate.id } });
  assert.equal(completed.status, "SUCCEEDED");
  assert.equal(completed.authorizedHeadSha, HEAD_2);
});

test("recovery holds the full chain mutex before mutation and a concurrent chain writer completes without deadlock or lost recovery", { timeout: 20_000 }, async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "recovery-lock-order");

  let lockObserved!: () => void;
  let releaseRecovery!: () => void;
  const recoveryHasChain = new Promise<void>((resolve) => { lockObserved = resolve; });
  const release = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  let paused = false;
  const recoveryDb = new Proxy(db, { get(target, property, receiver) {
    if (property !== "$transaction") {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
    return (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) => target.$transaction(async (tx) => {
      const instrumented = new Proxy(tx, { get(txTarget, txProperty, txReceiver) {
        if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const result = await (tx.$queryRaw as (...args: unknown[]) => Promise<unknown>)(strings, ...values);
          if (!paused && strings.join("?").includes('ORDER BY "chainLayer"')) {
            paused = true;
            lockObserved();
            await release;
          }
          return result;
        };
      } });
      return operation(instrumented);
    }, options as never);
  } }) as PrismaClient;
  const writerDb = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL! } } });
  const priorToken = process.env.OPERATOR_TOKEN;
  try {
    const recovery = baseDriftRecoveryTick(recoveryDb, reader(snapshot(BASE_2)));
    await recoveryHasChain;
    process.env.OPERATOR_TOKEN = OPERATOR;
    const writer = createApp(writerDb).request(`/tasks/${seeded.integratorTask!.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "concurrent writer completed after recovery" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRecovery();
    const [tick, response] = await Promise.all([recovery, writer]);
    assert.equal(tick.recovered, 1);
    assert.equal(response.status, 200, await response.text());
  } finally {
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = priorToken;
    await writerDb.$disconnect();
  }
  assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id, status: "QUEUED" } }), 1);
  assert.equal((await db.mergeRecoveryAttempt.findFirstOrThrow({ where: { integratorTaskId: seeded.integratorTask!.id } })).status, "REPAIRING");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.integratorTask!.id } })).description, "concurrent writer completed after recovery");
});

test("recovery freshness requeue preserves the run binding through fresh authorization and executor activation", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "readiness-recovery-second-freshness");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);

  const firstRecoveryRun = await recordRecoveryPass(seeded, BASE_2);

  assert.equal((await readinessTick(db, reader(snapshot(BASE_3)), new Date(), 5, releaseChainLease, runWithMergeLease)).requeued, 1);
  const secondRecoveryRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.gateTask.id },
    orderBy: { runNumber: "desc" },
  });
  assert.notEqual(secondRecoveryRun.id, firstRecoveryRun.id);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({ where: { integratorTaskId: seeded.integratorTask!.id } });
  assert.equal(aggregate.status, "REPAIRING");
  assert.equal(aggregate.recoveryRunId, secondRecoveryRun.id);
  assert.equal(aggregate.currentBaseSha, BASE_3);
  const integratorBinding = await db.taskActivity.findFirst({
    where: {
      taskId: seeded.integratorTask!.id,
      actorType: "control-plane",
      metadata: { path: ["recoveryRunId"], equals: secondRecoveryRun.id },
    },
  });
  assert.ok(integratorBinding, "the canonical integrator recovery surface binds the requeued run");
  assert.equal((integratorBinding.metadata as Record<string, unknown>).currentBaseSha, BASE_3);
  const queuedBindings = await db.taskActivity.findMany({
    where: {
      taskId: seeded.integratorTask!.id,
      actorType: "control-plane",
      metadata: { path: ["state"], equals: "queued" },
    },
    select: { metadata: true },
  });
  assert.deepEqual(
    [...new Set(queuedBindings.map(({ metadata }) => (metadata as Record<string, unknown>).attempt))],
    [1],
    "a readiness refresh appends evidence without spending another executor-drift attempt",
  );
  await assertIntegratorGuarded(seeded.integratorTask!.id);

  const authorization = await finishRecoveryPass(seeded, BASE_3);
  const parsed = parseAuthorizationMetadata(authorization.metadata);
  assert.equal(parsed.status, "ok");
  if (parsed.status === "ok") assert.equal(parsed.payload.baseSha, BASE_3);
  const executorRuns = await db.run.findMany({
    where: { taskId: seeded.integratorTask!.id },
    orderBy: { runNumber: "asc" },
  });
  assert.equal(executorRuns.length, 2);
  assert.equal(executorRuns[1]!.status, "QUEUED");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.integratorTask!.id } })).status, TaskStatus.TODO);
});

test("eligible direct and compound stops recover once under duplicate ticks and issue a fresh authorization", async () => {
  for (const shape of ["canonical-direct", "canonical-compound-readiness"] as const) {
    const seeded = await seedStopped(shape, `recover-${shape}`);
    assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.integratorTask!.id } }), 0);
    const ticks = await Promise.all(Array.from({ length: 6 }, () => baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))));
    assert.equal(ticks.reduce((sum, tick) => sum + tick.recovered, 0), 1);
    assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 2);
    assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.integratorTask!.id } }), 0);
    const replayed = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seeded.integratorTask!.id } });
    await db.taskStepOutput.update({ where: { id: replayed.id }, data: { body: replayed.body } });
    await reconcileDatabaseRuns(db, new Date());
    await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)));
    assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 2,
      "task-output replay and reconciliation do not duplicate recovery");

    const fresh = await finishRecoveryPass(seeded, BASE_2);
    const parsed = parseAuthorizationMetadata(fresh.metadata);
    assert.equal(parsed.status, "ok");
    if (parsed.status === "ok") {
      assert.equal(parsed.payload.headSha, HEAD);
      assert.equal(parsed.payload.baseSha, BASE_2);
    }
    assert.equal(await db.run.count({ where: { taskId: seeded.integratorTask!.id } }), 2);
    assert.equal(
      (await readMarkerHistory(db, seeded.integratorTask!.id))
        .filter((entry) => entry.kind === "baseDriftRecovery").length,
      1,
    );
  }
});

test("pre-intent base drift recovers without inventing an intent while duplicate intents fail closed", async () => {
  const preIntent = await seedIntegratorChain(db, { label: "recover-pre-intent", shape: "canonical-compound-readiness" });
  const authorization = await authorize(preIntent.readinessTask!.id, BASE);
  const sourceRun = await mechanicalStop(
    preIntent,
    authorization.id,
    BASE,
    BASE_2,
    "base-drift",
    JSON.stringify({ observed: BASE_2, authorized: BASE }),
    false,
  );

  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  const aggregate = await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: preIntent.integratorTask!.id },
  });
  assert.equal(aggregate.status, "REPAIRING");
  assert.equal(aggregate.boundSourceRunId, sourceRun.id);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: preIntent.integratorTask!.id,
    metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.intent },
  } }), 0, "recovery does not fabricate irreversible-operation evidence");

  await resetTestDb(db);
  const ambiguous = await seedStopped("canonical-compound-readiness", "refuse-duplicate-intent");
  const intent = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: ambiguous.integratorTask!.id,
    metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.intent },
  } });
  await db.taskActivity.create({ data: {
    taskId: intent.taskId,
    actorType: intent.actorType,
    actorId: intent.actorId,
    body: intent.body,
    metadata: intent.metadata as Prisma.InputJsonValue,
  } });

  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 0);
  assert.equal((await db.mergeRecoveryAttempt.findFirstOrThrow({
    where: { integratorTaskId: ambiguous.integratorTask!.id },
  })).failureReason, "source executor run has multiple server-bound merge intents");
  assert.equal(await db.run.count({ where: { taskId: ambiguous.gateTask.id } }), 1);
});

test("a legacy zero-intent validation failure reopens the same aggregate and recovers", async () => {
  const seeded = await seedIntegratorChain(db, { label: "recover-legacy-pre-intent", shape: "canonical-compound-readiness" });
  const authorization = await authorize(seeded.readinessTask!.id, BASE);
  const sourceRun = await mechanicalStop(
    seeded,
    authorization.id,
    BASE,
    BASE_2,
    "base-drift",
    JSON.stringify({ observed: BASE_2, authorized: BASE }),
    false,
  );
  const stop = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.integratorTask!.id,
    actorType: "control-plane",
    metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.result },
  } });
  const legacy = await db.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: seeded.integratorTask!.id,
    sourceStopId: stop.id,
    attempt: 1,
    status: "FAILED",
    failureReason: "source executor run does not have exactly one server-bound merge intent",
    endedAt: new Date(),
  } });

  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  const aggregate = await db.mergeRecoveryAttempt.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(aggregate.status, "REPAIRING");
  assert.equal(aggregate.boundSourceRunId, sourceRun.id);
  assert.equal(aggregate.failureReason, null);
  assert.equal(aggregate.endedAt, null);
  assert.equal(await db.mergeRecoveryAttempt.count({ where: {
    integratorTaskId: seeded.integratorTask!.id,
  } }), 1, "the durable failed aggregate is reopened instead of replaced");
});

test("two distinct executor drifts recover; the third queues no run and notifies once", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "recover-limit");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  let authorization = await finishRecoveryPass(seeded, BASE_2);
  await mechanicalStop(seeded, authorization.id, BASE_2, BASE_3);
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_3)))).recovered, 1);
  authorization = await finishRecoveryPass(seeded, BASE_3);
  await mechanicalStop(seeded, authorization.id, BASE_3, BASE_4);

  const duplicate = await Promise.all(Array.from({ length: 5 }, () => baseDriftRecoveryTick(db, reader(snapshot(BASE_4)))));
  assert.equal(duplicate.reduce((sum, tick) => sum + tick.exhausted, 0), 1);
  assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 3);
  assert.equal(await db.inboxMessage.count({ where: {
    taskId: seeded.integratorTask!.id, dedupeKey: { startsWith: "merge-base-drift-recovery:exhausted:" },
  } }), 1);
  const question = await db.inboxMessage.findFirstOrThrow({ where: {
    taskId: seeded.integratorTask!.id, kind: "MULTIPLE_CHOICE", status: "OPEN",
  } });
  assert.deepEqual((question.choices as Array<{ id: string }>).map((choice) => choice.id), ["abandon"]);
  await assert.rejects(
    db.$transaction((tx) => applyInboxDecisionTx(tx, {
      inboxMessageId: question.id,
      externalEventId: "exhausted-reauthorize-refused",
      decision: "re-authorize",
    })),
    /must match an Inbox choice id/u,
  );
  await db.$transaction((tx) => applyInboxDecisionTx(tx, {
    inboxMessageId: question.id,
    externalEventId: "exhausted-abandon",
    decision: "abandon",
  }));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: seeded.integratorTask!.id } })).status, TaskStatus.DONE);
});

test("identity, target-ref, head, and evidence mismatches fail closed without a recovery run", async () => {
  for (const [label, evidence, current] of [
    ["target-ref", JSON.stringify({ observed: BASE_2, authorized: BASE }), snapshot(BASE_2, { baseRefName: "release" })],
    ["head", JSON.stringify({ observed: BASE_2, authorized: BASE }), snapshot(BASE_2, { headRefOid: "f".repeat(40), headCommitOid: "f".repeat(40) })],
    ["identity", JSON.stringify({ observed: BASE_2, authorized: BASE }), snapshot(BASE_2, { number: 124 })],
    ["evidence", JSON.stringify({ observed: BASE_2, authorized: "f".repeat(40) }), snapshot(BASE_2)],
  ] as const) {
    const seeded = await seedIntegratorChain(db, { label: `refuse-${label}`, shape: "canonical-compound-readiness" });
    const authorization = await authorize(seeded.readinessTask!.id, BASE);
    await mechanicalStop(seeded, authorization.id, BASE, BASE_2, "base-drift", evidence);
    assert.equal((await baseDriftRecoveryTick(db, reader(current))).recovered, 0, label);
    assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 1, label);
    const question = await db.inboxMessage.findFirstOrThrow({ where: {
      taskId: seeded.integratorTask!.id, kind: "MULTIPLE_CHOICE", status: "OPEN",
    } });
    assert.deepEqual((question.choices as Array<{ id: string }>).map((choice) => choice.id), ["abandon"], label);
    assert.equal(await db.inboxMessage.count({ where: {
      taskId: seeded.integratorTask!.id,
      dedupeKey: { startsWith: "merge-base-drift-recovery:ineligible:" },
    } }), 1, label);
    await resetTestDb(db);
  }
});

test("a chain target branch that disagrees with the authorization fails closed", async () => {
  const seeded = await seedIntegratorChain(db, { label: "refuse-chain-target", shape: "canonical-compound-readiness" });
  const authorization = await authorize(seeded.readinessTask!.id, BASE);
  await mechanicalStop(seeded, authorization.id, BASE, BASE_2);
  await db.run.update({ where: { id: seeded.gateRun.id }, data: { targetBranch: "release" } });
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 0);
  assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 1);
  const question = await db.inboxMessage.findFirstOrThrow({ where: {
    taskId: seeded.integratorTask!.id, kind: "MULTIPLE_CHOICE", status: "OPEN",
  } });
  assert.deepEqual((question.choices as Array<{ id: string }>).map((choice) => choice.id), ["abandon"]);
});

test("foreign and incident stop conditions never enter automatic base-drift recovery", async () => {
  for (const condition of ["ambiguity", "payload-mismatch", "changed-underneath-me", "base-drift-post-merge"] as const) {
    const seeded = await seedIntegratorChain(db, { label: `foreign-${condition}`, shape: "canonical-compound-readiness" });
    const authorization = await authorize(seeded.readinessTask!.id, BASE);
    await mechanicalStop(seeded, authorization.id, BASE, BASE_2, condition, "foreign condition");
    assert.deepEqual(await baseDriftRecoveryTick(db, reader(snapshot(BASE_2))), { examined: 0, recovered: 0, exhausted: 0, ineligible: 0 });
    assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 1);
    await resetTestDb(db);
  }
});

test("a transient reader outage is retried and later recovers", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "transient-reader-outage");
  assert.deepEqual(await baseDriftRecoveryTick(db, null), {
    examined: 1, recovered: 0, exhausted: 0, ineligible: 0,
  });
  assert.equal(await db.inboxMessage.count({ where: {
    taskId: seeded.integratorTask!.id, kind: "MULTIPLE_CHOICE",
  } }), 0);
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 2);
});

test("older irrelevant REVIEW integrators cannot starve a later eligible stop", async () => {
  const prefix = await seedIntegratorChain(db, { label: "starvation-prefix", shape: "canonical-compound-readiness" });
  await db.task.createMany({ data: Array.from({ length: 55 }, (_, index) => ({
    projectId: prefix.project.id,
    repoId: prefix.repo.id,
    templateId: prefix.template.id,
    templateStepId: prefix.integratorStep!.id,
    name: `Old irrelevant integrator ${index}`,
    description: "parked without a base-drift stop",
    assigneeType: "AGENT" as const,
    assigneeAgentId: prefix.integratorAgent.id,
    approvalGate: false,
    opensPullRequest: false,
    chainId: `old-irrelevant-${index}`,
    chainIndex: 12,
    chainLayer: 12,
    status: TaskStatus.REVIEW,
    targetBranch: "master",
  })) });
  const eligible = await seedStopped("canonical-compound-readiness", "starvation-eligible");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)), new Date(), 1)).recovered, 1);
  assert.equal(await db.run.count({ where: { taskId: eligible.gateTask.id } }), 2);
});

test("operator-authored recovery metadata cannot clear the stop guard or suppress recovery", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "forged-integrator-marker");
  const stop = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.integratorTask!.id,
    metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.result },
  }, orderBy: { createdAt: "desc" } });
  const source = await db.taskStepOutput.findUniqueOrThrow({ where: { taskId: seeded.integratorTask!.id } });
  const authorization = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.readinessTask!.id,
    metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization },
  }, orderBy: { createdAt: "desc" } });
  await writeMarker(db, seeded.integratorTask!.id, "baseDriftRecovery", {
    actorType: "operator",
    body: "forged queued recovery marker",
    metadata: {
      state: "queued", attempt: 1,
      sourceStopId: stop.id, sourceRunId: source.runId!, recoveryRunId: "forged-recovery-run",
      readinessTaskId: seeded.readinessTask!.id, regressionTaskId: seeded.gateTask.id,
      integratorTaskId: seeded.integratorTask!.id, authorizationActivityId: authorization.id,
      repository: "acme/widgets", prNumber: 123, targetBranch: "master",
      authorizedHeadSha: HEAD, authorizedBaseSha: BASE, observedBaseSha: BASE_2, currentBaseSha: BASE_2,
    },
  });
  assert.equal(await db.mergeRecoveryAttempt.count({ where: { integratorTaskId: seeded.integratorTask!.id } }), 0,
    "legacy activity is not backfilled or treated as aggregate authority");
  assert.equal((await operatorRequest(`/tasks/${seeded.integratorTask!.id}`, "PATCH", { status: "DONE" })).status, 409);
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 2);
});

test("the aggregate rejects a duplicate source-stop attempt identity", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "aggregate-unique");
  const stop = await db.taskActivity.findFirstOrThrow({ where: {
    taskId: seeded.integratorTask!.id,
    metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.result },
  }, orderBy: { createdAt: "desc" } });
  await db.mergeRecoveryAttempt.create({ data: {
    integratorTaskId: seeded.integratorTask!.id,
    sourceStopId: stop.id,
    attempt: 1,
  } });
  await assert.rejects(
    db.mergeRecoveryAttempt.create({ data: {
      integratorTaskId: seeded.integratorTask!.id,
      sourceStopId: stop.id,
      attempt: 1,
    } }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
  );
});

test("operator-authored recovery metadata cannot suppress an ordinary gate repair", async () => {
  const seeded = await seedIntegratorChain(db, { label: "forged-regression-marker", shape: "canonical-compound-readiness" });
  await db.agent.update({ where: { id: seeded.agent.id }, data: { name: "senior-dev" } });
  await db.run.update({ where: { id: seeded.gateRun.id }, data: { headSha: HEAD } });
  await db.taskStepOutput.create({ data: {
    taskId: seeded.gateTask.id,
    runId: seeded.gateRun.id,
    kind: "regression-verification",
    body: JSON.stringify({
      schemaVersion: 1, outcome: "gate-fail", headSha: HEAD, baseHeadSha: BASE,
      gateVerdict: "FAIL", summary: "ordinary gate failure",
    }),
    commitSha: HEAD,
  } });
  await writeMarker(db, seeded.gateTask.id, "baseDriftRecovery", {
    actorType: "operator",
    body: "forged recovery context",
    metadata: {
      state: "queued", attempt: 1,
      sourceStopId: "forged-stop", sourceRunId: seeded.gateRun.id, recoveryRunId: seeded.gateRun.id,
      readinessTaskId: seeded.readinessTask!.id, regressionTaskId: seeded.gateTask.id,
      integratorTaskId: seeded.integratorTask!.id, authorizationActivityId: "forged-authorization",
      repository: "acme/widgets", prNumber: 123, targetBranch: "master",
      authorizedHeadSha: HEAD, authorizedBaseSha: BASE, observedBaseSha: BASE_2, currentBaseSha: BASE_2,
    },
  });
  await db.$transaction((tx) => handleRegressionCompletion(tx, {
    task: seeded.gateTask,
    run: {
      id: seeded.gateRun.id, agentId: seeded.agent.id, branch: "agentos/chain/demo",
      headSha: HEAD, sessionId: seeded.gateSession.id,
    },
    now: new Date(),
  }));
  assert.equal(await db.task.count({ where: { name: "Autonomous merge tail: gate-fix" } }), 1);
  assert.equal(await db.inboxMessage.count({ where: {
    dedupeKey: { startsWith: "merge-base-drift-recovery-tail-stop:" },
  } }), 0);
});

test("a recovery regression conflict, semantic failure, or gate failure stops without an auxiliary repair task", async () => {
  for (const outcome of ["refresh-conflict", "review-fail", "gate-fail"] as const) {
    const seeded = await seedStopped("canonical-compound-readiness", `tail-stop-${outcome}`);
    await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)));
    const run = await db.run.findFirstOrThrow({ where: { taskId: seeded.gateTask.id }, orderBy: { runNumber: "desc" } });
    const body = outcome === "refresh-conflict"
      ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE_2, summary: "conflict" }
      : outcome === "review-fail"
        ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE_2, summary: "MF-2 remains open" }
        : { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE_2, gateVerdict: "FAIL", summary: "gate failed" };
    await db.taskStepOutput.upsert({ where: { taskId: seeded.gateTask.id }, create: {
      taskId: seeded.gateTask.id, runId: run.id, kind: "regression-verification", body: JSON.stringify(body), commitSha: HEAD,
    }, update: { runId: run.id, body: JSON.stringify(body), commitSha: HEAD } });
    await db.$transaction((tx) => handleRegressionCompletion(tx, {
      task: seeded.gateTask,
      run: { id: run.id, agentId: run.agentId, branch: run.branch, headSha: HEAD, sessionId: seeded.gateSession.id },
      now: new Date(),
    }));
    assert.equal(await db.task.count({ where: { name: { startsWith: "Autonomous merge tail:" } } }), 0);
    assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.gateTask.id } }), 1);
    await assertIntegratorGuarded(seeded.integratorTask!.id);
    assert.equal((await db.mergeRecoveryAttempt.findFirstOrThrow({
      where: { integratorTaskId: seeded.integratorTask!.id },
    })).status, "BLOCKED_DOWNSTREAM");
    await resetTestDb(db);
  }
});

test("a recovery-cycle readiness failure restores the integrator stop guard", async () => {
  const seeded = await seedStopped("canonical-compound-readiness", "tail-readiness-stop");
  assert.equal((await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)))).recovered, 1);
  const regressionRun = await db.run.findFirstOrThrow({
    where: { taskId: seeded.gateTask.id },
    orderBy: { runNumber: "desc" },
  });
  const verdict = JSON.stringify({
    schemaVersion: 1,
    outcome: "pass",
    headSha: HEAD,
    baseHeadSha: BASE_2,
    gateVerdict: "PASS",
  });
  await db.run.update({ where: { id: regressionRun.id }, data: { status: "SUCCEEDED", headSha: HEAD } });
  await db.taskStepOutput.upsert({
    where: { taskId: seeded.gateTask.id },
    create: {
      taskId: seeded.gateTask.id,
      runId: regressionRun.id,
      kind: "regression-verification",
      body: verdict,
      commitSha: HEAD,
    },
    update: { runId: regressionRun.id, body: verdict, commitSha: HEAD },
  });
  await db.task.update({ where: { id: seeded.gateTask.id }, data: { status: TaskStatus.DONE } });

  const readiness = await readinessTick(db, reader(snapshot(BASE_2), [], false), new Date(), 5, releaseChainLease, runWithMergeLease);
  assert.equal(readiness.stopped, 1);
  assert.equal(await db.taskActivity.count({ where: {
    taskId: seeded.integratorTask!.id,
    metadata: { path: ["state"], equals: "tail-stopped" },
  } }), 1);
  await assertIntegratorGuarded(seeded.integratorTask!.id);
  assert.equal(await db.run.count({ where: { taskId: seeded.integratorTask!.id } }), 1);
});
