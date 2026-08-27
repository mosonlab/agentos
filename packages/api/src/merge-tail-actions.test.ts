import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@agentos/db";

import {
  openDefenseAuditNotice,
  openMergeTailStopNotice,
} from "./merge-tail-actions.js";

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
