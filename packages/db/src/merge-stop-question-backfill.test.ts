import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@prisma/client";

import { MERGE_INTEGRATOR_KIND, MERGE_INTEGRATOR_SCHEMA_VERSION } from "./merge-integrator.js";
import {
  backfillMergeStopQuestions,
  runBackfillMergeStopQuestionsCli,
  type MergeStopQuestionBackfillDatabase,
} from "./merge-stop-question-backfill.js";

type MemoryTask = {
  id: string;
  archivedAt: Date | null;
  assigneeAgentId: string | null;
  templateStep: { stepIndex: number; outputKind: string; taskTemplate: { name: string } };
};

type MemoryActivity = {
  id: string;
  taskId: string;
  actorType: string;
  actorId: string | null;
  body: string;
  metadata: unknown;
  createdAt: Date;
};

type MemoryCard = {
  id: string;
  dedupeKey: string;
  taskId: string;
  kind: string;
  choices: unknown;
};

type MemoryFixture = {
  db: MergeStopQuestionBackfillDatabase;
  tasks: MemoryTask[];
  activities: MemoryActivity[];
  cards: MemoryCard[];
};

const stopActivity = (
  taskId: string,
  id: string,
  condition: string,
  sourceRunId = "run-1",
): MemoryActivity => ({
  id,
  taskId,
  actorType: "session",
  actorId: "runner-1",
  body: `Mechanical merge stopped: ${condition}`,
  metadata: {
    kind: MERGE_INTEGRATOR_KIND.result,
    schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
    outcome: "stopped",
    condition,
    evidence: "merge evidence",
    sourceRunId,
  },
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
});

const fixture = (rows: Array<{
  id: string;
  archivedAt?: Date | null;
  condition: string;
  terminal?: boolean;
  canonical?: boolean;
}>): MemoryFixture => {
  const tasks: MemoryTask[] = rows.map((row) => ({
    id: row.id,
    archivedAt: row.archivedAt ?? null,
    assigneeAgentId: "agent-1",
    templateStep: {
      stepIndex: 12,
      outputKind: "merge-result",
      taskTemplate: { name: row.canonical === false ? "custom-workflow" : "compound-engineer-workflow" },
    },
  }));
  const activities: MemoryActivity[] = rows.flatMap((row) => {
    const stop = stopActivity(row.id, `${row.id}-stop`, row.condition);
    return row.terminal
      ? [stop, {
        id: `${row.id}-answer`,
        taskId: row.id,
        actorType: "operator",
        actorId: null,
        body: "accepted",
        metadata: {
          kind: MERGE_INTEGRATOR_KIND.stopAnswer,
          schemaVersion: MERGE_INTEGRATOR_SCHEMA_VERSION,
          stopId: stop.id,
          condition: row.condition,
          choice: row.condition === "base-drift-post-merge" ? "accept" : "abandon",
          disposition: "terminal-done",
        },
        createdAt: new Date("2026-09-01T00:01:00.000Z"),
      } satisfies MemoryActivity]
      : [stop];
  });
  const cards: MemoryCard[] = [];
  const tx = {
    $queryRaw: async (_query: unknown, taskId: string) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      return task ? [{ id: task.id, archivedAt: task.archivedAt }] : [];
    },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) => tasks.find((task) => task.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<MemoryTask> }) => {
        const task = tasks.find((candidate) => candidate.id === where.id);
        if (!task) throw new Error(`missing task ${where.id}`);
        Object.assign(task, data);
        return task;
      },
    },
    taskActivity: {
      findMany: async ({ where }: { where: { taskId: string } }) => activities
        .filter((activity) => activity.taskId === where.taskId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      findUnique: async ({ where }: { where: { id: string } }) => activities.find((activity) => activity.id === where.id) ?? null,
    },
    inboxMessage: {
      findUnique: async ({ where }: { where: { dedupeKey: string } }) => cards.find((card) => card.dedupeKey === where.dedupeKey) ?? null,
      findFirst: async ({ where }: { where: { dedupeKey: string } }) => cards.find((card) => card.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: { data: Omit<MemoryCard, "id"> }) => {
        const card = { ...data, id: `card-${cards.length + 1}` };
        cards.push(card);
        return card;
      },
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const source = activities.find((activity) => (
          (activity.metadata as Record<string, unknown>)?.sourceRunId === where.id
        ));
        return { taskId: source?.taskId ?? "unknown", agentId: "agent-1", session: { id: "session-1" } };
      },
    },
  } as unknown as Prisma.TransactionClient;

  const db: MergeStopQuestionBackfillDatabase = {
    task: {
      findMany: async () => tasks.map((task) => ({ id: task.id })),
    },
    $transaction: async <T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
      const before = cards.length;
      try {
        return await operation(tx);
      } catch (error) {
        cards.splice(before);
        throw error;
      }
    },
  };
  return { db, tasks, activities, cards };
};

test("backfill opens one result-bound question and is idempotent", async () => {
  const target = fixture([{ id: "incident", condition: "base-drift-post-merge" }]);

  const first = await backfillMergeStopQuestions(target.db);
  assert.deepEqual(first, {
    scanned: 1,
    created: 1,
    alreadyPresent: 0,
    deferredOrdinaryBaseDrift: 0,
    skipped: 0,
    failed: 0,
  });
  assert.equal(target.cards.length, 1);
  assert.equal(target.cards[0]!.dedupeKey, "merge-stop:incident-stop");
  assert.deepEqual((target.cards[0]!.choices as Array<{ id: string }>).map((choice) => choice.id), ["accept", "revert"]);

  const second = await backfillMergeStopQuestions(target.db);
  assert.deepEqual(second, {
    scanned: 1,
    created: 0,
    alreadyPresent: 1,
    deferredOrdinaryBaseDrift: 0,
    skipped: 0,
    failed: 0,
  });
  assert.equal(target.cards.length, 1);
});

test("archived and terminal stops skip while ordinary canonical base-drift remains deferred", async () => {
  const target = fixture([
    { id: "archived", condition: "base-drift-post-merge", archivedAt: new Date() },
    { id: "terminal", condition: "base-drift-post-merge", terminal: true },
    { id: "ordinary", condition: "base-drift" },
  ]);

  const result = await backfillMergeStopQuestions(target.db);
  assert.deepEqual(result, {
    scanned: 3,
    created: 0,
    alreadyPresent: 0,
    deferredOrdinaryBaseDrift: 1,
    skipped: 2,
    failed: 0,
  });
  assert.equal(target.cards.length, 0);
});

test("a repair failure returns a non-zero CLI result and a later pass repairs it", async () => {
  const target = fixture([{ id: "failed", condition: "base-drift-post-merge" }]);
  const lines: string[] = [];
  const errors: string[] = [];
  // Fail before the repair callback, which models a database/Inbox error and
  // proves the scan remains fail-closed while returning a non-zero exit code.
  const failingDb: MergeStopQuestionBackfillDatabase = {
    task: target.db.task,
    $transaction: async () => { throw new Error("forced Inbox write failure"); },
  };
  assert.equal(await runBackfillMergeStopQuestionsCli({
    db: failingDb,
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  }), 1);
  assert.match(lines[0] ?? "", /scanned 1, created 0, already-present 0, deferred-ordinary-base-drift 0, skipped 0, failed 1/u);
  assert.match(errors[0] ?? "", /failed/u);
  assert.equal(target.cards.length, 0);

  const repairedLines: string[] = [];
  assert.equal(await runBackfillMergeStopQuestionsCli({
    db: target.db,
    log: (line) => repairedLines.push(line),
  }), 0);
  assert.match(repairedLines[0] ?? "", /created 1/u);
  assert.equal(target.cards.length, 1);
});
