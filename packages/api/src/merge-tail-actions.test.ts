import assert from "node:assert/strict";
import test from "node:test";

import { type Prisma, TaskStatus } from "@agentos/db";

import {
  createReviewFollowUpCard,
  openMergeTailStopNotice,
  shellQuote,
} from "./merge-tail-actions.js";

test("shellQuote preserves shell metacharacters as literal single-quoted text", () => {
  assert.equal(shellQuote("feature/$branch"), "'feature/$branch'");
  assert.equal(shellQuote("feature/`branch`"), "'feature/`branch`'");
  assert.equal(shellQuote("feature/topic;next"), "'feature/topic;next'");
  assert.equal(shellQuote("feature/reviewer'fix"), "'feature/reviewer'\\''fix'");
});

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

test("createReviewFollowUpCard assembles the backlog card and review marker bodies", async () => {
  let taskData: Record<string, unknown> | undefined;
  let markerData: Record<string, unknown> | undefined;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => (
      strings.join("").includes('FROM "AgentRepoAccess"')
        ? [{ agentId: "senior-dev-1", repoId: "repo-1" }]
        : [{ id: "senior-dev-1" }]
    ),
    agent: {
      findFirst: async () => ({ id: "senior-dev-1" }),
      findUnique: async () => ({ id: "senior-dev-1", archivedAt: null }),
    },
    agentRepoAccess: { count: async () => 1 },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        taskData = data;
        return { id: "follow-up-task-1" };
      },
    },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        markerData = data;
        return { id: "marker-1" };
      },
    },
  } as unknown as Prisma.TransactionClient;

  const result = await createReviewFollowUpCard(tx, {
    projectId: "project-1",
    repoId: "repo-1",
    agentName: "senior-dev",
    reviewTaskId: "review-task-1",
    headSha: "a".repeat(40),
    finding: {
      severity: "follow-up",
      title: "Preserve the review range",
      detail: "Record the exact reviewed range on the follow-up card.",
    },
  });

  assert.deepEqual(result, { taskId: "follow-up-task-1" });
  assert.deepEqual(taskData, {
    projectId: "project-1",
    repoId: "repo-1",
    name: "Merge tail follow-up: Preserve the review range",
    description: [
      "Record the exact reviewed range on the follow-up card.",
      `Raised as a follow-up by the autonomous merge tail independent review review-task-1 at exact head ${"a".repeat(40)}. It did not block that merge.`,
    ].join("\n\n"),
    assigneeType: "AGENT",
    assigneeAgentId: "senior-dev-1",
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.BACKLOG,
  });
  assert.deepEqual(markerData, {
    taskId: "follow-up-task-1",
    actorType: "control-plane",
    body: `Follow-up finding from independent review review-task-1 at ${"a".repeat(40)}`,
    metadata: {
      schemaVersion: 1,
      state: "follow-up",
      reviewTaskId: "review-task-1",
      headSha: "a".repeat(40),
      title: "Preserve the review range",
      kind: "mergeTail.reviewObligation",
    },
  });
});
