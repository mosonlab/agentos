import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  MERGE_INTEGRATOR_KIND,
  MERGE_TAIL_KIND,
  PrismaClient,
  REGRESSION_VERIFICATION_OUTPUT_KIND,
  TaskStatus,
  applyInboxDecisionTx,
  advanceTemplateTask,
} from "@anneal/db";

import type { PullRequestReader, PullRequestSnapshot } from "./github-read.js";
import {
  withMergeLease,
  type ReleaseMergeLease,
  type WithMergeLease,
} from "./merge-lease.js";
import { evidenceTick } from "./merge-evidence-worker.js";
import { readinessTick } from "./merge-readiness-worker.js";
import { patchTask } from "./task-patch.js";
import { seedIntegratorChain } from "./merge-integrator-fixture.js";
import { resetTestDb, setupTestDb } from "./testdb.js";

let db: PrismaClient;
before(() => { db = setupTestDb(); });
beforeEach(async () => { await resetTestDb(db); });
after(async () => { await db.$disconnect(); });

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const NEW_BASE = "d".repeat(40);

const snapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  repository: "acme/widgets",
  number: 123,
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  baseRefName: "master",
  baseSha: BASE,
  headRefOid: HEAD,
  headCommitOid: HEAD,
  autoMergeRequest: null,
  mergeQueueEntry: null,
  repositoryMergeQueue: null,
  mergedBy: null,
  mergeCommit: null,
  requiredCheckNames: ["ci/build"],
  checkContexts: [{ __typename: "CheckRun", name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS" }],
  readAt: new Date("2026-08-31T00:00:00.000Z").toISOString(),
  ...overrides,
});

const reader = (current: Partial<PullRequestSnapshot> = {}): PullRequestReader => ({
  readPullRequest: async () => snapshot(current),
  compareCommits: async () => ({ status: "ahead", behindBy: 0, filesComplete: true, files: [] }),
});

const releaseLease: ReleaseMergeLease = async () => {};
const runWithMergeLease: WithMergeLease = (target, fn, database) => withMergeLease(
  target,
  fn,
  database,
  {
    acquire: async () => ({ outcome: "acquired" }),
    release: async () => ({
      outcome: "released",
      ref: "refs/merge-lease/test",
      sha: "lease-test",
      acquiredAt: "2026-08-31T00:00:00.000Z",
    }),
  },
);

/** Make the fixture's Regression output current-v2 and persist its signature. */
const attestRegression = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
  headSha = HEAD,
  baseHeadSha = BASE,
): Promise<void> => {
  await db.taskTemplateStep.update({
    where: { id: chain.gateStep.id },
    data: { outputKind: REGRESSION_VERIFICATION_OUTPUT_KIND },
  });
  const body = JSON.stringify({
    schemaVersion: 2,
    outcome: "pass",
    headSha,
    baseHeadSha,
    gateVerdict: "PASS",
    gateProof: `MERGE GATE: PASS ${headSha}`,
  });
  await db.taskStepOutput.create({
    data: {
      taskId: chain.gateTask.id,
      runId: chain.gateRun.id,
      kind: REGRESSION_VERIFICATION_OUTPUT_KIND,
      body,
      commitSha: headSha,
    },
  });
  await db.mergeGateAttestation.create({
    data: {
      chainId: chain.chainId,
      taskId: chain.gateTask.id,
      runId: chain.gateRun.id,
      headSha,
      baseHeadSha,
      proof: `MERGE GATE: PASS ${headSha}`,
    },
  });
};

const openGate = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
  now = new Date("2026-08-31T00:00:01.000Z"),
): Promise<{ id: string; body: string }> => {
  assert.ok(chain.readinessTask);
  await db.$transaction((tx) => advanceTemplateTask(
    tx,
    chain.gateTask.id,
    chain.gateRun.id,
    null,
    now,
  ));
  const card = await db.inboxMessage.findFirstOrThrow({
    where: { gateTaskId: chain.readinessTask.id, status: "OPEN" },
  });
  return card;
};

const fillGate = async (
  chain: Awaited<ReturnType<typeof seedIntegratorChain>>,
  current: Partial<PullRequestSnapshot> = {},
): Promise<{ id: string; body: string }> => {
  const card = await openGate(chain);
  await evidenceTick(db, reader(current), new Date("2026-08-31T00:00:02.000Z"));
  return db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } });
};

const approveInbox = (cardId: string, externalEventId: string) => db.$transaction((tx) => (
  applyInboxDecisionTx(tx, {
    inboxMessageId: cardId,
    externalEventId,
    decision: "approve",
    actorOpenId: "operator-1",
  })
));

const authorizationRows = async (taskId: string) => (await db.taskActivity.findMany({ where: { taskId } }))
  .filter((row) => (row.metadata as Record<string, unknown> | null)?.kind === MERGE_INTEGRATOR_KIND.authorization);

test("Inbox approval releases gated readiness only after exact-head authorization", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-approval-inbox",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await attestRegression(chain);
  const card = await fillGate(chain);

  const decision = await approveInbox(card.id, "merge-gate-inbox-approve");
  assert.equal(decision.gateAction, "approved");
  const released = await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } });
  assert.equal(released.status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);
  const authorizations = await authorizationRows(chain.readinessTask.id);
  assert.equal(authorizations.length, 1);
  assert.equal((authorizations[0]!.metadata as Record<string, unknown>).headSha, HEAD);
  assert.equal((authorizations[0]!.metadata as Record<string, unknown>).baseSha, BASE);
  assert.equal(await db.taskActivity.count({
    where: { taskId: chain.readinessTask.id, metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.readiness } },
  }), 1, "approval writes the ordinary queued readiness marker");

  const tick = await readinessTick(
    db,
    reader(),
    new Date("2026-08-31T00:00:03.000Z"),
    5,
    releaseLease,
    runWithMergeLease,
  );
  assert.deepEqual(tick, { claimed: 1, authorized: 1, requeued: 0, stopped: 0 });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.DONE);
  assert.equal((await db.run.count({ where: { taskId: chain.integratorTask!.id } })), 1);
  const mechanical = await authorizationRows(chain.readinessTask.id);
  assert.equal(mechanical.length, 2, "the worker adds the sole downstream mechanical authorization");
  assert.ok(mechanical.some((row) => (
    ((row.metadata as Record<string, unknown>).decision as Record<string, unknown>).channel === "mechanical"
  )));
});

test("task PATCH approval shares the Inbox disposition and leaves readiness worker-owned", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-approval-patch",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  await attestRegression(chain);
  await fillGate(chain);

  const patched = await patchTask(db, chain.readinessTask.id, { status: TaskStatus.DONE });
  assert.ok("task" in patched, JSON.stringify(patched));
  assert.equal(patched.task.status, TaskStatus.TODO);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);
  const authorization = await authorizationRows(chain.readinessTask.id);
  assert.equal(authorization.length, 1);
  assert.equal(((authorization[0]!.metadata as Record<string, unknown>).decision as Record<string, unknown>).channel, "patch");

  const tick = await readinessTick(
    db,
    reader(),
    new Date("2026-08-31T00:00:03.000Z"),
    5,
    releaseLease,
    runWithMergeLease,
  );
  assert.equal(tick.authorized, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.DONE);
  assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 1);
  // The PATCH path consumes the same exact card; a second status write cannot
  // manufacture a second decision or authorization.
  const replay = await patchTask(db, chain.readinessTask.id, { status: TaskStatus.DONE });
  assert.ok("task" in replay);
  assert.equal((await authorizationRows(chain.readinessTask.id)).length, 2);
});

test("head and base drift after approval requeues regression and opens a fresh evidence card", async () => {
  for (const [label, drift] of [
    ["head", { headRefOid: NEW_HEAD, headCommitOid: NEW_HEAD, baseSha: BASE }],
    ["base", { headRefOid: HEAD, headCommitOid: HEAD, baseSha: NEW_BASE }],
  ] as const) {
    const chain = await seedIntegratorChain(db, {
      label: `merge-gate-drift-${label}`,
      shape: "canonical-compound-readiness",
      gatedReadiness: true,
    });
    assert.ok(chain.readinessTask);
    await attestRegression(chain);
    const card = await fillGate(chain);
    await approveInbox(card.id, `merge-gate-drift-approve-${label}`);

    const drifted = await readinessTick(
      db,
      reader(drift),
      new Date("2026-08-31T00:00:03.000Z"),
      5,
      releaseLease,
      runWithMergeLease,
    );
    assert.deepEqual(drifted, { claimed: 1, authorized: 0, requeued: 1, stopped: 0 });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.TODO);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } })).status, TaskStatus.TODO);
    assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0);

    const newRun = await db.run.findFirstOrThrow({ where: { taskId: chain.gateTask.id }, orderBy: { runNumber: "desc" } });
    const newHead = label === "head" ? NEW_HEAD : HEAD;
    const newBase = label === "base" ? NEW_BASE : BASE;
    await db.taskStepOutput.update({
      where: { taskId: chain.gateTask.id },
      data: {
        runId: newRun.id,
        body: JSON.stringify({
          schemaVersion: 2,
          outcome: "pass",
          headSha: newHead,
          baseHeadSha: newBase,
          gateVerdict: "PASS",
          gateProof: `MERGE GATE: PASS ${newHead}`,
        }),
        commitSha: newHead,
      },
    });
    await db.mergeGateAttestation.create({
      data: {
        chainId: chain.chainId,
        taskId: chain.gateTask.id,
        runId: newRun.id,
        headSha: newHead,
        baseHeadSha: newBase,
        proof: `MERGE GATE: PASS ${newHead}`,
      },
    });
    await db.task.update({ where: { id: chain.gateTask.id }, data: { status: TaskStatus.DONE } });
    await db.$transaction((tx) => advanceTemplateTask(
      tx,
      chain.gateTask.id,
      newRun.id,
      null,
      new Date("2026-08-31T00:00:04.000Z"),
    ));
    const fresh = await db.inboxMessage.findFirstOrThrow({
      where: { gateTaskId: chain.readinessTask.id, status: "OPEN" },
      orderBy: { createdAt: "desc" },
    });
    await evidenceTick(db, reader({ headRefOid: newHead, headCommitOid: newHead, baseSha: newBase }), new Date());
    const freshBody = await db.inboxMessage.findUniqueOrThrow({ where: { id: fresh.id } });
    assert.match(freshBody.body, new RegExp(newHead, "u"));
    assert.match(freshBody.body, new RegExp(newBase, "u"));
    assert.notEqual(fresh.id, card.id);
    assert.equal((await authorizationRows(chain.readinessTask.id)).length, 1, "old authorization is not reused");
  }
});

test("missing or mismatched operator approval stops a gated readiness settlement closed", async () => {
  for (const [label, metadata] of [
    ["missing", null],
    ["wrong-head", { headSha: NEW_HEAD, baseSha: BASE }],
    ["wrong-base", { headSha: HEAD, baseSha: NEW_BASE }],
  ] as const) {
    const chain = await seedIntegratorChain(db, {
      label: `merge-gate-auth-${label}`,
      shape: "canonical-compound-readiness",
      gatedReadiness: true,
    });
    assert.ok(chain.readinessTask);
    await attestRegression(chain);
    if (metadata) {
      await db.taskActivity.create({
        data: {
          taskId: chain.readinessTask.id,
          actorType: "operator",
          body: "forged merge gate approval",
          metadata: {
            kind: MERGE_INTEGRATOR_KIND.authorization,
            schemaVersion: 1,
            nonce: "n".repeat(8),
            repository: "acme/widgets",
            prNumber: 123,
            headSha: metadata.headSha,
            baseRef: "master",
            baseSha: metadata.baseSha,
            mergeMethod: "merge",
            requiredChecks: [],
            readAt: new Date().toISOString(),
            issuedAt: new Date().toISOString(),
            decision: { channel: "inbox", inboxDecisionId: `forged-${label}`, inboxMessageId: `forged-${label}` },
          },
        },
      });
    }
    const tick = await readinessTick(
      db,
      reader(),
      new Date("2026-08-31T00:00:03.000Z"),
      5,
      releaseLease,
      runWithMergeLease,
    );
    assert.equal(tick.stopped, 1, label);
    const [readiness, regression] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } }),
      db.task.findUniqueOrThrow({ where: { id: chain.gateTask.id } }),
    ]);
    assert.equal(readiness.status, TaskStatus.REVIEW, label);
    assert.equal(regression.status, TaskStatus.REVIEW, label);
    assert.match(readiness.failureReason ?? "", /merge gate operator authorization/iu, label);
    assert.equal(await db.run.count({ where: { taskId: chain.integratorTask!.id } }), 0, label);
  }
});

test("a merge-gate approval without a regression attestation remains open", async () => {
  const chain = await seedIntegratorChain(db, {
    label: "merge-gate-unattested",
    shape: "canonical-compound-readiness",
    gatedReadiness: true,
  });
  assert.ok(chain.readinessTask);
  const card = await fillGate(chain);
  await assert.rejects(
    () => approveInbox(card.id, "merge-gate-unattested-approve"),
    /no merge gate attestation/iu,
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: chain.readinessTask.id } })).status, TaskStatus.REVIEW);
  assert.equal((await db.inboxMessage.findUniqueOrThrow({ where: { id: card.id } })).status, "OPEN");
  assert.equal((await authorizationRows(chain.readinessTask.id)).length, 0);
});
