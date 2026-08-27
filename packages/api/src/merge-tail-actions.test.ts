import assert from "node:assert/strict";
import test from "node:test";

import { MergeRecoveryStatus, type Prisma, type RecoveryContext } from "@agentos/db";

import {
  openDefenseAuditNotice,
  openMergeTailStopNotice,
  stopMergeTail,
  type StopMergeTailInput,
} from "./merge-tail-actions.js";

const recoveryContext: RecoveryContext = {
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

const stopTx = (recoveryStatus: MergeRecoveryStatus) => {
  const activities: Array<Record<string, any>> = [];
  const notices: Array<Record<string, any>> = [];
  const recoveryUpdates: Array<Record<string, any>> = [];
  const tx = {
    mergeRecoveryAttempt: {
      findUnique: async () => ({ status: recoveryStatus }),
      update: async (args: Record<string, any>) => {
        recoveryUpdates.push(args);
        return {};
      },
    },
    task: {
      findUnique: async () => ({
        chainId: "chain-1",
        templateStep: {
          stepIndex: 5,
          outputKind: "regression-verification-v2",
          taskTemplate: { name: "direct-engineer-workflow" },
        },
      }),
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, any> }) => {
        activities.push(data);
        return {};
      },
    },
    inboxMessage: {
      upsert: async (args: Record<string, any>) => {
        notices.push(args);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, activities, notices, recoveryUpdates };
};

test("openMergeTailStopNotice derives its dedupe key from the task and reason", async () => {
  let upsert: Record<string, unknown> | undefined;
  const tx = {
    inboxMessage: {
      upsert: async (args: Record<string, unknown>) => {
        upsert = args;
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;

  await openMergeTailStopNotice(tx, {
    taskId: "regression-task-1",
    agentId: "regression-verifier-1",
    sessionId: "session-1",
    reason: "merge gate proof no longer matches exact head",
  });

  const dedupeKey = "merge-tail-stop:regression-task-1:9f7b7769875b76f39403dda876c8cc7accdde7037d36052fd9633675f668e6e9";
  assert.deepEqual(upsert, {
    where: { dedupeKey },
    create: {
      from: "AGENT",
      agentId: "regression-verifier-1",
      sessionId: "session-1",
      taskId: "regression-task-1",
      kind: "TEXT",
      body: "Autonomous merge tail stopped: merge gate proof no longer matches exact head",
      dedupeKey,
    },
    update: {},
  });
});

test("openDefenseAuditNotice records the triggered paths against the readiness task", async () => {
  let upsert: Record<string, unknown> | undefined;
  const tx = {
    inboxMessage: {
      upsert: async (args: Record<string, unknown>) => {
        upsert = args;
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;

  await openDefenseAuditNotice(tx, {
    readinessTaskId: "readiness-task-1",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    triggers: [
      { path: "packages/api/src/app.ts", reason: "merge-tail-machinery" },
      { path: "scripts/gate-worker/run.sh", reason: "gate-worker" },
    ],
  });

  const dedupeKey = `defense-audit:readiness-task-1:${"a".repeat(40)}`;
  assert.deepEqual(upsert, {
    where: { dedupeKey },
    create: {
      from: "AGENT",
      taskId: "readiness-task-1",
      kind: "TEXT",
      body: [
        "Merge proceeded with defense-list changes",
        `Exact range ${"b".repeat(40)}..${"a".repeat(40)}.`,
        "- packages/api/src/app.ts (merge-tail-machinery)\n- scripts/gate-worker/run.sh (gate-worker)",
      ].join("\n\n"),
      dedupeKey,
    },
    update: {},
  });
});

test("stopMergeTail owns the phase by recovery matrix", async () => {
  const at = new Date("2026-08-27T12:00:00.000Z");
  const cases: Array<{
    name: string;
    status: MergeRecoveryStatus;
    input: StopMergeTailInput;
    markerStates: string[];
    noticeKey: RegExp;
    recoveryTarget: MergeRecoveryStatus | null;
    leaseToRelease: string | null;
  }> = [
    {
      name: "regression without recovery",
      status: MergeRecoveryStatus.REPAIRING,
      input: { phase: "regression", regressionTaskId: "regression-1", reason: "bad verdict", at, recovery: null, agentId: "agent-1" },
      markerStates: ["stopped"],
      noticeKey: /^merge-tail-stop:regression-1:/u,
      recoveryTarget: null,
      leaseToRelease: "chain-1",
    },
    {
      name: "regression during recovery",
      status: MergeRecoveryStatus.REPAIRING,
      input: { phase: "regression", regressionTaskId: "regression-1", reason: "bad verdict", at, recovery: recoveryContext, agentId: "agent-1" },
      markerStates: ["tail-stopped", "tail-stopped"],
      noticeKey: /:stop-1:regression$/u,
      recoveryTarget: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
      leaseToRelease: "chain-1",
    },
    {
      name: "readiness without recovery",
      status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      input: { phase: "readiness", readinessTaskId: "readiness-1", regressionTaskId: "regression-1", reason: "head drift", at, recovery: null },
      markerStates: ["stopped"],
      noticeKey: /^merge-readiness-stop:readiness-1:/u,
      recoveryTarget: null,
      leaseToRelease: "chain-1",
    },
    {
      name: "readiness during recovery",
      status: MergeRecoveryStatus.AWAITING_AUTHORIZATION,
      input: { phase: "readiness", readinessTaskId: "readiness-1", regressionTaskId: "regression-1", reason: "head drift", at, recovery: recoveryContext },
      markerStates: ["tail-stopped", "tail-stopped", "stopped"],
      noticeKey: /:stop-1:readiness$/u,
      recoveryTarget: MergeRecoveryStatus.BLOCKED_DOWNSTREAM,
      leaseToRelease: "chain-1",
    },
    {
      name: "recovery validation",
      status: MergeRecoveryStatus.VALIDATING,
      input: {
        phase: "recovery-validation", aggregateId: "aggregate-1", integratorTaskId: "integrator-1",
        sourceStopId: "stop-1", reason: "identity mismatch", at, attempt: 1,
        recoveryData: { repository: "acme/widgets" }, markerMetadata: { repository: "acme/widgets" },
      },
      markerStates: ["ineligible"],
      noticeKey: /:ineligible:stop-1$/u,
      recoveryTarget: MergeRecoveryStatus.FAILED,
      leaseToRelease: null,
    },
    {
      name: "recovery exhausted",
      status: MergeRecoveryStatus.VALIDATING,
      input: {
        phase: "recovery-exhausted", aggregateId: "aggregate-1", integratorTaskId: "integrator-1",
        sourceStopId: "stop-1", reason: "attempt limit", at, attempt: 2,
        recoveryData: { repository: "acme/widgets" }, markerMetadata: { repository: "acme/widgets" },
      },
      markerStates: ["exhausted"],
      noticeKey: /:exhausted:stop-1$/u,
      recoveryTarget: MergeRecoveryStatus.FAILED,
      leaseToRelease: null,
    },
    {
      name: "repair",
      status: MergeRecoveryStatus.REPAIRING,
      input: {
        phase: "repair", regressionTaskId: "regression-1", repairTaskId: "repair-1", repairKind: "gate-fix",
        startHeadSha: "a".repeat(40), targetHeadSha: "b".repeat(40), resolvedHeadSha: null,
        reason: "repair failed", at, agentId: "agent-1",
      },
      markerStates: ["failed"],
      noticeKey: /^merge-tail-stop:regression-1:/u,
      recoveryTarget: null,
      leaseToRelease: "chain-1",
    },
  ];

  for (const entry of cases) {
    const observed = stopTx(entry.status);
    assert.deepEqual(await stopMergeTail(observed.tx, entry.input), { leaseToRelease: entry.leaseToRelease }, entry.name);
    assert.deepEqual(
      observed.activities.map((activity) => (activity.metadata as Record<string, unknown>).state),
      entry.markerStates,
      entry.name,
    );
    assert.match(String(observed.notices[0]?.where?.dedupeKey), entry.noticeKey, entry.name);
    assert.equal(observed.recoveryUpdates[0]?.data?.status ?? null, entry.recoveryTarget, entry.name);
  }
});

test("stopMergeTail refuses an illegal recovery transition before writing it", async () => {
  const observed = stopTx(MergeRecoveryStatus.VALIDATING);
  await assert.rejects(
    stopMergeTail(observed.tx, {
      phase: "readiness",
      readinessTaskId: "readiness-1",
      regressionTaskId: "regression-1",
      reason: "cannot skip repair",
      at: new Date(),
      recovery: recoveryContext,
    }),
    /Illegal merge recovery transition VALIDATING -> BLOCKED_DOWNSTREAM/u,
  );
  assert.deepEqual(observed.recoveryUpdates, []);
});
