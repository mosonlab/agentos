import "../test-workspace-root.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  RunnerKind,
  RunnerPreference,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";

export const withTokens = async (callback: () => Promise<void>): Promise<void> => {
  const operator = process.env.OPERATOR_TOKEN;
  const runner = process.env.RUNNER_TOKEN;
  const mergeExecutor = process.env.MERGE_EXECUTOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-unit-token";
  process.env.RUNNER_TOKEN = "runner-unit-token";
  process.env.MERGE_EXECUTOR_TOKEN = "merge-executor-unit-token";
  try {
    await callback();
  } finally {
    if (operator === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = operator;
    if (runner === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = runner;
    if (mergeExecutor === undefined) delete process.env.MERGE_EXECUTOR_TOKEN;
    else process.env.MERGE_EXECUTOR_TOKEN = mergeExecutor;
  }
};

export const lockedAgent = <T extends Record<string, unknown>>(agent: T | null): (T & Record<string, unknown>) | null => agent ? ({
  name: "Agent",
  archivedAt: null,
  codexServiceTier: "DEFAULT",
  ...agent,
}) : null;

/* A merge-tail stop report: agent-authored text, attached to the task it
 * happened on, and nothing resumes on a reply. It is the shape the Inbox is
 * full of, and the old "attached to nothing" rule refused to close it. */
export const stopReport = {
  id: "message-1", status: "OPEN", from: "AGENT", kind: "TEXT", gateTaskId: null, replyToMessageId: null,
};

export const closeRequest = async (app: ReturnType<typeof createApp>, messageId: string): Promise<Response> =>
  await app.request(`/inbox/messages/${messageId}/close`, {
    method: "POST",
    headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: `close-${messageId}` }),
  });

export const retryRequest = async (
  assigneeAgent: {
    id: string;
    model: string;
    runnerPreference: RunnerPreference;
    foundationalPrompt: string;
    rolePrompt: string;
    archivedAt?: Date | null;
    name?: string;
  } | null,
  templateStep: {
    runner: RunnerKind | null;
    stepIndex?: number;
    outputKind?: string;
    taskTemplate?: { name: string };
  } | null = null,
) => {
  let created: Record<string, unknown> | undefined;
  const currentTemplateStep = templateStep
    ? { stepIndex: 1, outputKind: "result", taskTemplate: { name: "direct-engineer-workflow" }, ...templateStep }
    : null;
  const last = {
    id: "run-1",
    projectId: "project-1",
    taskId: "task-1",
    goalId: "goal-1",
    agentId: "old-agent",
    repoId: "repo-previous",
    runNumber: 1,
    status: "FAILED",
    runner: RunnerKind.CLAUDE,
    model: "old-model",
    targetBranch: "main",
    branch: "feature/retry",
    promptHash: createHash("sha256").update("foundation\nrole\nRetry me\nUse current config").digest("hex"),
    maxDurationMin: 90,
    stallTimeoutMin: 7,
    maxRunsPerTask: 4,
    // Nothing granted, so the retry ceiling is the task's configured budget —
    // which is what `maxRunsPerTask: 4` already was.
    budgetGrants: 0,
  };
  const currentTask = {
    id: "task-1",
    projectId: "project-1",
    name: "Retry me",
    description: "Use current config",
    assigneeType: "AGENT",
    assigneeAgentId: assigneeAgent?.id ?? null,
    repoId: "repo-current",
    repo: null,
    templateId: null,
    templateStepId: currentTemplateStep ? "step-1" : null,
    maxSessionsPerTask: 4,
    maxDurationMin: 120,
    stallTimeoutMin: 10,
    opensPullRequest: true,
    chainId: null,
    chainIndex: null,
    targetBranch: "main",
    archivedAt: null,
    dispatchAfterTaskId: null,
    dispatchAfter: null,
    assigneeAgent,
    templateStep: currentTemplateStep,
    runs: [last],
  };
  const database = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      // Retry takes the shared task-row lock before it reads anything else.
      $queryRaw: async () => [{ id: "task-1" }],
      agent: { findUnique: async () => lockedAgent(assigneeAgent as Record<string, unknown> | null) },
      task: {
        findUniqueOrThrow: async () => ({ id: "task-1", status: "TODO", archivedAt: null }),
        findUnique: async () => currentTask,
        findMany: async () => [currentTask],
        update: async () => ({}),
      },
      run: {
        count: async () => 0,
        groupBy: async () => [{
          taskId: "task-1",
          status: "FAILED",
          _count: { _all: 1 },
          _max: { budgetGrants: 0 },
        }],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created = data;
          return { id: "run-2", ...data };
        },
      },
      agentRepoAccess: { count: async () => 1 },
      taskActivity: { create: async () => ({}) },
    }),
  } as unknown as PrismaClient;
  const response = await createApp(database).request("/tasks/task-1/retry", {
    method: "POST",
    headers: { Authorization: "Bearer operator-unit-token" },
  });
  return { response, created, last };
};

/* --------------------------------------------------- GET /tasks, projected */

/** A stub with just enough of `task` for `GET /tasks` to answer: the board row
 *  page, the chain-progress page, and the recurring groupBy the full shape adds. */
/** `related` answers the by-id lookups the board makes for rows that are not on
 *  the page — a bound task's predecessor and a repair task's regression task —
 *  and `activity` the merge-tail markers that name the latter. */
export const boardDatabase = (
  rows: Array<Record<string, unknown>>,
  extras: { related?: Array<Record<string, unknown>>; activity?: Array<Record<string, unknown>> } = {},
): PrismaClient => {
  let call = 0;
  const taskRows = [...rows].sort((left, right) => (
    (right.createdAt as Date).getTime() - (left.createdAt as Date).getTime()
      || String(left.id).localeCompare(String(right.id))
  ));
  return {
    task: {
      findMany: async (args: Record<string, unknown> | undefined) => {
        if ((args?.where as Record<string, unknown> | undefined)?.id !== undefined) return extras.related ?? [];
        if (call++ !== 0) return [];
        assert.deepEqual(args?.orderBy, [{ createdAt: "desc" }, { id: "asc" }]);
        return taskRows;
      },
      groupBy: async () => [],
    },
    agentRepoAccess: { findMany: async () => [] },
    taskActivity: { findMany: async () => extras.activity ?? [] },
  } as unknown as PrismaClient;
};

export const taskRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t1", projectId: "p1", name: "Ship the thing", status: "TODO", assigneeType: "AGENT",
  assigneeAgentId: "a1", repoId: "r1", archivedAt: null, maxSessionsPerTask: 5, failureReason: null,
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null, approvalGate: false,
  templateId: null, source: "MANUAL", chainId: null, chainIndex: null, chainLayer: null, dispatchAfterTaskId: null,
  createdAt: new Date("2026-08-16T00:00:00.000Z"),
  updatedAt: new Date("2026-08-16T00:00:00.000Z"), templateStep: null,
  assigneeAgent: { id: "a1", title: "Senior Developer", model: "gpt-5.6-sol:medium", archivedAt: null },
  runs: [{
    id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", codexServiceTier: "DEFAULT", budgetGrants: 0,
    session: { costUsd: "0.42", inputTokens: null, cachedInputTokens: null, outputTokens: null, startedAt: null, endedAt: null },
  }],
  ...overrides,
});

export const getTasks = async (database: PrismaClient, query: string, headers: Record<string, string> = {}): Promise<Response> =>
  await createApp(database).request(`/tasks${query}`, {
    headers: { Authorization: "Bearer operator-unit-token", ...headers },
  });

export const taskDetailDatabase = (task: Record<string, unknown>): PrismaClient => ({
  task: { findUnique: async () => task, findMany: async () => [task] },
  run: { groupBy: async () => [] },
  agentRepoAccess: { findMany: async () => [{ projectId: task.projectId, agentId: task.assigneeAgentId, repoId: task.repoId }] },
  mergeRecoveryAttempt: { findFirst: async () => null },
} as unknown as PrismaClient);

export const untouchableDatabase = (): PrismaClient => new Proxy({}, {
  get(_target, property) {
    throw new Error(`the database must not be reached: ${String(property)}`);
  },
}) as unknown as PrismaClient;

export const onboardingBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  project: { name: "My Project", slug: "my-project" },
  repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main", mountPath: "repo" },
  acknowledgedHostExecution: true,
  ...overrides,
});

export const postOnboarding = async (database: PrismaClient, body: string): Promise<Response> =>
  createApp(database).request("/onboarding", {
    method: "POST",
    headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
    body,
  });
