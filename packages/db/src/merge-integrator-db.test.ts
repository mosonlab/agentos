import assert from "node:assert/strict";
import { test } from "node:test";

import { Prisma } from "@prisma/client";

import {
  landIntegratorStop,
  recordIntegratorStop,
  type IntegratorStopLandingInput,
} from "./merge-integrator-db.js";

type Activity = {
  id: string;
  taskId: string;
  actorType: string;
  actorId: string | null;
  body: string;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
};

type Question = {
  id: string;
  taskId: string;
  dedupeKey: string;
  kind: string;
  agentId: string | null;
  sessionId: string | null;
  body: string;
  choices: Prisma.JsonValue;
};

const makeTransaction = (overrides: {
  templateOutputKind?: string;
  sourceRun?: { taskId: string | null; agentId: string; session: { id: string } | null } | null;
  activities?: Activity[];
} = {}) => {
  const task = {
    id: "integrator-task",
    assigneeAgentId: "task-agent",
    status: "TODO",
    templateStep: {
      stepIndex: 12,
      outputKind: overrides.templateOutputKind ?? "merge-result",
      taskTemplate: { name: "compound-engineer-workflow" },
    },
  } as any;
  const activities = [...(overrides.activities ?? [])];
  const questions: Question[] = [];
  let activityNumber = activities.length + 1;
  let questionNumber = 1;
  const tx = {
    $queryRaw: async () => [{ id: task.id }],
    task: {
      findUnique: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(task, data);
        return task;
      },
    },
    taskActivity: {
      findMany: async () => [...activities].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
      findUnique: async ({ where }: { where: { id: string } }) => activities.find((row) => row.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const row: Activity = {
          id: `activity-${activityNumber++}`,
          taskId: data.taskId,
          actorType: data.actorType,
          actorId: data.actorId ?? null,
          body: data.body,
          metadata: data.metadata,
          createdAt: new Date(2026, 8, 1, 0, 0, activityNumber),
        };
        activities.push(row);
        return row;
      },
    },
    run: {
      findUnique: async () => overrides.sourceRun ?? null,
    },
    inboxMessage: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) =>
        questions.find((question) => question.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const question: Question = {
          id: `question-${questionNumber++}`,
          taskId: data.taskId,
          dedupeKey: data.dedupeKey,
          kind: data.kind,
          agentId: data.agentId,
          sessionId: data.sessionId,
          body: data.body,
          choices: data.choices,
        };
        questions.push(question);
        return question;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, task, activities, questions };
};

const stopInput = (overrides: Partial<IntegratorStopLandingInput> = {}): IntegratorStopLandingInput => ({
  integratorTaskId: "integrator-task",
  condition: "base-drift-post-merge",
  evidence: "landed commit 8bfa2f08",
  sourceRunId: "source-run",
  agentId: "caller-agent",
  sessionId: "caller-session",
  ...overrides,
});

test("landing creates one result and one condition-specific question, then adopts the exact activity", async () => {
  const { tx, task, activities, questions } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });

  const landed = await landIntegratorStop(tx, stopInput());
  assert.equal(landed.resultCreated, true);
  assert.equal(landed.questionDeferred, false);
  assert.equal(activities.length, 1);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.dedupeKey, `merge-stop:${landed.stopId}`);
  assert.equal(questions[0]!.kind, "MULTIPLE_CHOICE");
  assert.deepEqual((questions[0]!.choices as Array<{ id: string }>).map((choice) => choice.id), ["accept", "revert"]);
  assert.equal(questions[0]!.agentId, "run-agent");
  assert.equal(questions[0]!.sessionId, "run-session");
  assert.equal(task.status, "REVIEW");
  assert.equal(task.failureReason, "Mechanical merge stopped: base-drift-post-merge");

  const replay = await landIntegratorStop(tx, stopInput({
    resultActivityId: landed.stopId,
    condition: "head-drift",
    evidence: "must not replace the recorded evidence",
    agentId: "wrong-agent",
    sessionId: "wrong-session",
  }));
  assert.equal(replay.stopId, landed.stopId);
  assert.equal(replay.resultCreated, false);
  assert.equal(activities.length, 1);
  assert.equal(questions.length, 1);
  assert.match(questions[0]!.body, /landed commit 8bfa2f08/u);
});

test("recordIntegratorStop adopts the newest same-source stopped result", async () => {
  const { tx, activities, questions } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });
  const first = await landIntegratorStop(tx, stopInput());
  const replay = await recordIntegratorStop(tx, {
    integratorTaskId: "integrator-task",
    condition: "head-drift",
    evidence: "different completion envelope",
    agentId: "caller-agent",
    sessionId: "caller-session",
    sourceRunId: "source-run",
  });
  assert.deepEqual(replay, { stopId: first.stopId, questionId: null });
  assert.equal(activities.length, 1);
  assert.equal(questions.length, 1);
  assert.equal((activities[0]!.metadata as Record<string, unknown>).condition, "base-drift-post-merge");
  assert.equal((activities[0]!.metadata as Record<string, unknown>).evidence, "landed commit 8bfa2f08");
});

test("a terminally answered stop is not reopened by a replay", async () => {
  const { tx, task, activities, questions } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });
  const first = await landIntegratorStop(tx, stopInput());
  task.status = "DONE";
  task.failureReason = null;
  activities.push({
    id: "answer-activity",
    taskId: task.id,
    actorType: "operator",
    actorId: null,
    body: "accept",
    metadata: {
      kind: "mergeIntegrator.stopAnswer",
      schemaVersion: 1,
      stopId: first.stopId,
      condition: "base-drift-post-merge",
      choice: "accept",
      disposition: "terminal-done",
    },
    createdAt: new Date(2026, 8, 1, 0, 1),
  });

  const replay = await landIntegratorStop(tx, stopInput({ resultActivityId: first.stopId }));
  assert.equal(replay.stopId, first.stopId);
  assert.equal(task.status, "DONE");
  assert.equal(task.failureReason, null);
  assert.equal(questions.length, 1);
});

test("question-eligible source Runs must carry a Session", async () => {
  const { tx } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: null },
  });
  await assert.rejects(
    landIntegratorStop(tx, stopInput()),
    /has no Session identity/u,
  );
});

test("canonical ordinary base drift lands REVIEW but defers its abandon question", async () => {
  const { tx, task, questions } = makeTransaction({
    sourceRun: { taskId: "integrator-task", agentId: "run-agent", session: { id: "run-session" } },
  });
  const landed = await landIntegratorStop(tx, stopInput({ condition: "base-drift" }));
  assert.equal(landed.questionDeferred, true);
  assert.equal(landed.questionId, null);
  assert.equal(questions.length, 0);
  assert.equal(task.status, "REVIEW");
});
