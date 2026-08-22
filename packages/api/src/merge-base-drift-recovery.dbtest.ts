import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import {
  AUTHORIZED_MERGE_METHOD,
  MERGE_INTEGRATOR_KIND,
  MERGE_TAIL_KIND,
  Prisma,
  PrismaClient,
  TaskStatus,
  authorizationMetadata,
  parseAuthorizationMetadata,
  recordIntegratorStop,
  type StopCondition,
} from "@agentos/db";

import { handleRegressionCompletion } from "./app.js";
import { baseDriftRecoveryTick } from "./merge-base-drift-worker.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { readinessTick } from "./merge-readiness-worker.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import type { GitHubReader, PullRequestSnapshot } from "./github-read.js";
import { createApp } from "./test-app.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const BASE_2 = "c".repeat(40);
const BASE_3 = "d".repeat(40);
const BASE_4 = "e".repeat(40);

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const snapshot = (baseSha: string, overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets", number: 123, state: "OPEN", isDraft: false, merged: false,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "master", baseSha,
  headRefOid: HEAD, headCommitOid: HEAD, autoMergeRequest: null, mergeQueueEntry: null,
  repositoryMergeQueue: null, mergedBy: null, mergeCommit: null, requiredCheckNames: [], checkContexts: [],
  readAt: new Date("2026-08-22T01:00:00.000Z").toISOString(), ...overrides,
});

const reader = (current: PullRequestSnapshot, files: Array<{ filename: string; previousFilename: string | null; patch: string | null }> = []): GitHubReader => ({
  readPullRequest: async () => current,
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files }),
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
  await db.taskActivity.create({ data: {
    taskId: seeded.integratorTask!.id, actorType: "merge-executor", body: "intent",
    metadata: {
      kind: MERGE_INTEGRATOR_KIND.intent, schemaVersion: 1, sourceRunId: run.id,
      idempotencyKey: `123:${HEAD}:${authorizationActivityId}`, prNumber: 123,
      headSha: HEAD, authorizationActivityId,
    },
  } });
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

const seedStopped = async (shape: "legacy-seven-step-direct" | "twelve-step-readiness", label: string) => {
  const seeded = await seedIntegratorChain(db, { label, shape });
  const authorization = await authorize(seeded.readinessTask!.id, BASE);
  await mechanicalStop(seeded, authorization.id, BASE, BASE_2);
  return seeded;
};

const finishRecoveryPass = async (
  seeded: Awaited<ReturnType<typeof seedIntegratorChain>>,
  baseSha: string,
) => {
  const run = await db.run.findFirstOrThrow({ where: { taskId: seeded.gateTask.id }, orderBy: { runNumber: "desc" } });
  await db.run.update({ where: { id: run.id }, data: { status: "SUCCEEDED", headSha: HEAD } });
  await db.taskStepOutput.upsert({ where: { taskId: seeded.gateTask.id }, create: {
    taskId: seeded.gateTask.id, runId: run.id, kind: "regression-verification",
    body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: baseSha, gateVerdict: "PASS" }), commitSha: HEAD,
  }, update: {
    runId: run.id, kind: "regression-verification",
    body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: baseSha, gateVerdict: "PASS" }), commitSha: HEAD,
  } });
  await db.task.update({ where: { id: seeded.gateTask.id }, data: { status: TaskStatus.DONE } });
  const tick = await readinessTick(db, reader(snapshot(baseSha)));
  assert.equal(tick.authorized, 1);
  return db.taskActivity.findFirstOrThrow({
    where: { taskId: seeded.readinessTask!.id, metadata: { path: ["kind"], equals: MERGE_INTEGRATOR_KIND.authorization } },
    orderBy: { createdAt: "desc" },
  });
};

test("eligible direct and compound stops recover once under duplicate ticks and issue a fresh authorization", async () => {
  for (const shape of ["legacy-seven-step-direct", "twelve-step-readiness"] as const) {
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
    assert.equal(await db.taskActivity.count({
      where: { taskId: seeded.integratorTask!.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.baseDriftRecovery } },
    }), 1);
  }
});

test("two distinct executor drifts recover; the third queues no run and notifies once", async () => {
  const seeded = await seedStopped("twelve-step-readiness", "recover-limit");
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
});

test("identity, target-ref, head, and evidence mismatches fail closed without a recovery run", async () => {
  for (const [label, evidence, current] of [
    ["target-ref", JSON.stringify({ observed: "other", authorized: "master" }), snapshot(BASE_2)],
    ["head", JSON.stringify({ observed: BASE_2, authorized: BASE }), snapshot(BASE_2, { headRefOid: "f".repeat(40), headCommitOid: "f".repeat(40) })],
    ["identity", JSON.stringify({ observed: BASE_2, authorized: BASE }), snapshot(BASE_2, { number: 124 })],
    ["evidence", JSON.stringify({ observed: BASE_2, authorized: "f".repeat(40) }), snapshot(BASE_2)],
  ] as const) {
    const seeded = await seedIntegratorChain(db, { label: `refuse-${label}`, shape: "twelve-step-readiness" });
    const authorization = await authorize(seeded.readinessTask!.id, BASE);
    await mechanicalStop(seeded, authorization.id, BASE, BASE_2, "base-drift", evidence);
    assert.equal((await baseDriftRecoveryTick(db, reader(current))).recovered, 0, label);
    assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 1, label);
    assert.equal(await db.inboxMessage.count({ where: { taskId: seeded.integratorTask!.id, kind: "MULTIPLE_CHOICE" } }), 0, label);
    await resetTestDb(db);
  }
});

test("foreign and incident stop conditions never enter automatic base-drift recovery", async () => {
  for (const condition of ["ambiguity", "payload-mismatch", "changed-underneath-me", "base-drift-post-merge"] as const) {
    const seeded = await seedIntegratorChain(db, { label: `foreign-${condition}`, shape: "twelve-step-readiness" });
    const authorization = await authorize(seeded.readinessTask!.id, BASE);
    await mechanicalStop(seeded, authorization.id, BASE, BASE_2, condition, "foreign condition");
    assert.deepEqual(await baseDriftRecoveryTick(db, reader(snapshot(BASE_2))), { examined: 0, recovered: 0, exhausted: 0, ineligible: 0 });
    assert.equal(await db.run.count({ where: { taskId: seeded.gateTask.id } }), 1);
    await resetTestDb(db);
  }
});

test("a recovery regression conflict or gate failure stops without an auxiliary repair task", async () => {
  for (const outcome of ["refresh-conflict", "gate-fail"] as const) {
    const seeded = await seedStopped("twelve-step-readiness", `tail-stop-${outcome}`);
    await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)));
    const run = await db.run.findFirstOrThrow({ where: { taskId: seeded.gateTask.id }, orderBy: { runNumber: "desc" } });
    const body = outcome === "refresh-conflict"
      ? { schemaVersion: 1, outcome, headSha: HEAD, baseHeadSha: BASE_2, summary: "conflict" }
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
    await resetTestDb(db);
  }
});

test("a recovery-cycle independent-review rejection stops once without a review-fix task", async () => {
  const seeded = await seedStopped("twelve-step-readiness", "tail-review-reject");
  await baseDriftRecoveryTick(db, reader(snapshot(BASE_2)));
  const regressionRun = await db.run.findFirstOrThrow({ where: { taskId: seeded.gateTask.id }, orderBy: { runNumber: "desc" } });
  await db.run.update({ where: { id: regressionRun.id }, data: { status: "SUCCEEDED", headSha: HEAD } });
  await db.taskStepOutput.upsert({ where: { taskId: seeded.gateTask.id }, create: {
    taskId: seeded.gateTask.id, runId: regressionRun.id, kind: "regression-verification",
    body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: BASE_2, gateVerdict: "PASS" }), commitSha: HEAD,
  }, update: {
    runId: regressionRun.id,
    body: JSON.stringify({ schemaVersion: 1, outcome: "pass", headSha: HEAD, baseHeadSha: BASE_2, gateVerdict: "PASS" }), commitSha: HEAD,
  } });
  await db.task.update({ where: { id: seeded.gateTask.id }, data: { status: TaskStatus.DONE } });
  const reviewer = await db.agent.create({ data: {
    projectId: seeded.project.id, environmentId: seeded.environment.id, name: "review-coordinator", title: "Reviewer",
    model: "gpt-5.6-sol:medium", foundationalPrompt: "foundation", rolePrompt: "review",
  } });
  await db.agentRepoAccess.create({ data: {
    projectId: seeded.project.id, agentId: reviewer.id, repoId: seeded.repo.id,
    mountPath: "/repo", permissions: "GIT_WRITE",
  } });
  const readiness = await readinessTick(db, reader(snapshot(BASE_2), [{
    filename: "packages/api/src/app.ts", previousFilename: null, patch: "@@ -1 +1 @@\n-old\n+new",
  }]));
  assert.equal(readiness.reviewing, 1);
  const reviewTask = await db.task.findFirstOrThrow({ where: { name: "Autonomous merge tail: independent review" } });
  const reviewRun = await db.run.findFirstOrThrow({ where: { taskId: reviewTask.id } });
  const fence = `1:${reviewTask.id}:1`;
  const session = await db.session.create({ data: {
    runId: reviewRun.id, projectId: seeded.project.id, taskId: reviewTask.id,
    agentId: reviewer.id, runner: reviewRun.runner, executionStatus: "RUNNING",
  } });
  await db.run.update({ where: { id: reviewRun.id }, data: {
    status: "RUNNING", runnerId: "runner-review", fencingToken: fence,
    leaseExpiresAt: new Date(Date.now() + 600_000), headSha: HEAD,
  } });
  await db.task.update({ where: { id: reviewTask.id }, data: { status: TaskStatus.DOING } });
  await db.taskStepOutput.create({ data: {
    taskId: reviewTask.id, runId: reviewRun.id, kind: "review",
    body: JSON.stringify({ schemaVersion: 1, outcome: "rejected", headSha: HEAD, summary: "must fix" }), commitSha: HEAD,
  } });
  const priorToken = process.env.RUNNER_TOKEN;
  process.env.RUNNER_TOKEN = "review-runner-token";
  try {
    const response = await createApp(db).request(`/runner/runs/${reviewRun.id}/complete`, {
      method: "POST",
      headers: { Authorization: "Bearer review-runner-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-review", fencingToken: fence, exitCode: 0, terminalEventSeen: true,
        terminalSuccess: true, cleanupStatus: "SUCCEEDED", pushStatus: "NOT_REQUESTED",
        workspaceRetained: false, headSha: HEAD, branch: reviewRun.branch,
      }),
    });
    assert.equal(response.status, 200);
  } finally {
    if (priorToken === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = priorToken;
  }
  assert.equal(session.executionStatus, "RUNNING");
  assert.equal(await db.task.count({ where: { name: "Autonomous merge tail: review-fix" } }), 0);
  assert.equal(await db.inboxMessage.count({ where: {
    taskId: seeded.gateTask.id, dedupeKey: { startsWith: "merge-base-drift-recovery-tail-stop:" },
  } }), 1);
});
