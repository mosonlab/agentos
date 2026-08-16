import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@agentos/db";

import { createApp } from "./app.js";
import { completionSucceeded, externalFailure } from "./execution.js";
import { reconcileDatabaseRuns } from "./reconcile.js";

const withTokens = async (callback: () => Promise<void>): Promise<void> => {
  const operator = process.env.OPERATOR_TOKEN;
  const runner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-unit-token";
  process.env.RUNNER_TOKEN = "runner-unit-token";
  try {
    await callback();
  } finally {
    if (operator === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = operator;
    if (runner === undefined) delete process.env.RUNNER_TOKEN;
    else process.env.RUNNER_TOKEN = runner;
  }
};

test("public root reports the execution kernel without touching Prisma", async () => {
  const response = await createApp({} as PrismaClient).request("/");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "AgentOS control plane", phase: "execution-kernel" });
});

test("API routes reject requests without a principal token", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects");
    assert.equal(response.status, 401);
  });
});

test("runner principal cannot cross into operator routes", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects", {
      headers: { Authorization: "Bearer runner-unit-token" },
    });
    assert.equal(response.status, 403);
  });
});

test("operator principal cannot impersonate a runner", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "fake-runner", leaseSeconds: 60 }),
    });
    assert.equal(response.status, 403);
  });
});

test("task status patch does not apply create defaults to other fields", async () => {
  await withTokens(async () => {
    let updateData: unknown;
    const database = {
      task: {
        findUniqueOrThrow: async () => ({ id: "task-1", projectId: "project-1", status: "REVIEW" }),
        update: async ({ data }: { data: unknown }) => { updateData = data; return { id: "task-1", status: "DONE" }; },
      },
      taskActivity: { create: async () => ({ id: "activity-1" }) },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(updateData, { status: "DONE" });
  });
});

test("task create requires chainId and chainIndex together", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Broken chain", chainId: "chain-1" }),
    });
    assert.equal(response.status, 400);
  });
});

test("operator DONE on a chain task closes its open gate and queues the CAS-claimed successor", async () => {
  await withTokens(async () => {
    let closed = false;
    const successor = {
      id: "task-2", projectId: "project-1", name: "Next", description: "next", chainId: "chain-1", chainIndex: 1,
      updatedAt: new Date(), assigneeType: "AGENT", assigneeAgentId: "agent-1", repoId: "repo-1", templateId: null,
      targetBranch: "main", maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 5, runs: [],
      assigneeAgent: { id: "agent-1", model: "claude", runnerPreference: "CLAUDE", foundationalPrompt: "f", rolePrompt: "r" },
      repo: { id: "repo-1", defaultBranch: "main" }, templateStep: null,
    };
    const before = { id: "task-1", projectId: "project-1", name: "Gate", status: "REVIEW", templateId: null, approvalGate: true, chainId: "chain-1", chainIndex: 0, followUpTaskId: null, assigneeAgentId: "agent-1", repoId: "repo-1" };
    const tx = {
      task: {
        update: async () => ({ ...before, status: "DONE" }),
        findFirst: async () => successor,
        updateMany: async () => ({ count: 1 }),
        findUniqueOrThrow: async () => successor,
      },
      inboxMessage: { updateMany: async () => { closed = true; return { count: 1 }; } },
      taskActivity: { create: async () => ({}) },
      run: { create: async () => ({ id: "run-1" }) },
    };
    const database = {
      task: { findUniqueOrThrow: async () => before },
      agentRepoAccess: { findFirst: async () => ({}) },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 200);
    assert.equal(closed, true);
  });
});

test("template approval gate still rejects operator DONE", async () => {
  await withTokens(async () => {
    const database = { task: { findUniqueOrThrow: async () => ({ templateId: "template-1", approvalGate: true }) } } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 409);
  });
});

test("CRON create computes runAt, ignores caller runAt, and creates no immediate run", async () => {
  await withTokens(async () => {
    let stored: Record<string, any> | undefined;
    let runs = 0;
    const agent = { id: "agent-1", runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" };
    const repo = { id: "repo-1", defaultBranch: "main" };
    const tx = {
      task: { create: async ({ data }: { data: Record<string, any> }) => { stored = data; return { id: "task-1", ...data }; } },
      taskActivity: { create: async () => ({}) },
      run: { create: async () => { runs += 1; return {}; } },
    };
    const database = {
      agent: { findFirst: async () => agent }, repo: { findFirst: async () => repo },
      agentRepoAccess: { findFirst: async () => ({}) },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Nightly", assigneeAgentId: "agent-1", repoId: "repo-1", scheduleKind: "CRON",
        cron: "0 2 * * *", timezone: "Asia/Shanghai", runAt: "2000-01-01T00:00:00Z",
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(runs, 0);
    assert.ok(stored?.runAt instanceof Date);
    assert.ok(stored!.runAt.getTime() > Date.now());
  });
});

test("schedule create rejects invalid dialect, timezone, missing fields, and non-agent AT", async () => {
  await withTokens(async () => {
    const database = {
      agent: { findFirst: async () => ({ id: "agent-1" }) }, repo: { findFirst: async () => ({ id: "repo-1" }) },
      agentRepoAccess: { findFirst: async () => ({}) },
    } as unknown as PrismaClient;
    const cases = [
      { scheduleKind: "CRON", cron: "0 */2 * * * *" },
      { scheduleKind: "CRON", cron: "* * * * * *" },
      { scheduleKind: "CRON", cron: "@daily" },
      { scheduleKind: "CRON", cron: "0 2 * * *", timezone: "Mars/Olympus" },
      { scheduleKind: "CRON" },
      { scheduleKind: "AT", assigneeType: "HUMAN", runAt: new Date().toISOString() },
      { scheduleKind: "AT", assigneeAgentId: "agent-1", runAt: null },
    ];
    for (const value of cases) {
      const response = await createApp(database).request("/projects/project-1/tasks", {
        method: "POST", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Invalid", ...value }),
      });
      assert.equal(response.status, 400, JSON.stringify(value));
    }
  });
});

test("AT create waits for the scheduler and merged-view patch cannot remove its executor", async () => {
  await withTokens(async () => {
    let runs = 0;
    const runAt = new Date(Date.now() - 60_000);
    const before = { id: "task-1", projectId: "project-1", status: "TODO", templateId: null, approvalGate: false, chainId: null, followUpTaskId: null, scheduleKind: "AT", runAt, cron: null, timezone: null, assigneeType: "AGENT", assigneeAgentId: "agent-1", repoId: "repo-1" };
    const database = {
      agent: { findFirst: async () => ({ id: "agent-1", runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
      repo: { findFirst: async () => ({ id: "repo-1", defaultBranch: "main" }) },
      agentRepoAccess: { findFirst: async () => ({}) },
      task: { findUniqueOrThrow: async () => before },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        task: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "task-1", ...data }) },
        taskActivity: { create: async () => ({}) }, run: { create: async () => { runs += 1; return {}; } },
      }),
    } as unknown as PrismaClient;
    const created = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Later", scheduleKind: "AT", runAt, assigneeAgentId: "agent-1", repoId: "repo-1" }),
    });
    assert.equal(created.status, 201);
    assert.equal(runs, 0);
    const patched = await createApp(database).request("/tasks/task-1", {
      method: "PATCH", headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeType: "HUMAN", assigneeAgentId: null }),
    });
    assert.equal(patched.status, 400);
  });
});

test("fencing rejects an expired generation token", async () => {
  await withTokens(async () => {
    const currentToken = "2:run-1:current";
    const database = {
      run: {
        updateMany: async ({ where }: { where: { fencingToken: string } }) => ({ count: where.fencingToken === currentToken ? 1 : 0 }),
        findFirst: async () => null,
      },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/runner/runs/run-1/heartbeat", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1",
        fencingToken: "1:run-1:expired",
        leaseSeconds: 60,
        processAlive: true,
      }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Stale fencing token" });
  });
});

test("completion requires both exit zero and a successful terminal event", () => {
  assert.equal(completionSucceeded({
    exitCode: 0,
    signal: null,
    terminalEventSeen: false,
    terminalSuccess: false,
    terminationReason: null,
  }), false);
});

test("only environment failures are external, so agent failures still spend budget", () => {
  assert.equal(externalFailure({ succeeded: true, signal: "SIGTERM" }), false);
  assert.equal(externalFailure({ succeeded: false, signal: "SIGKILL" }), true);
  assert.equal(externalFailure({ succeeded: false, failureClass: "AUTH_REQUIRED" }), true);
  assert.equal(externalFailure({ succeeded: false, reported: true }), true);
  // A budget kill signals the process on purpose; that attempt was really spent.
  assert.equal(externalFailure({ succeeded: false, signal: "SIGTERM", failureClass: "CANCELLED_OR_TIMED_OUT" }), false);
  assert.equal(externalFailure({ succeeded: false, failureClass: "TASK_FAILED" }), false);
});

test("an external failure raises the run ceiling instead of spending an attempt", async () => {
  await withTokens(async () => {
    let closed: Record<string, unknown> | undefined;
    let retry: Record<string, unknown> | undefined;
    const run = {
      id: "run-3", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1", repoId: "repo-1",
      runNumber: 3, maxRunsPerTask: 3, runner: "CLAUDE", model: "claude", targetBranch: "main", branch: "feat/x",
      baseSha: null, promptHash: "hash", maxDurationMin: 120, stallTimeoutMin: 10,
      task: { id: "task-1", templateId: null, templateStep: null }, session: { id: "session-1" },
    };
    const tx = {
      run: {
        findFirst: async () => run,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { closed = data; return { count: 1 }; },
        create: async ({ data }: { data: Record<string, unknown> }) => { retry = data; return { id: "run-4", ...data }; },
      },
      session: { update: async () => ({}) },
      task: { updateMany: async () => ({ count: 1 }) },
      taskActivity: { create: async () => ({}) },
      runnerBackendState: { upsert: async () => ({ consecutiveAuthFailures: 0 }), update: async () => ({}) },
      inboxMessage: { create: async () => ({}) },
    };
    const database = {
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
      run: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/runner/runs/run-3/complete", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1", fencingToken: "1:run-3:token", exitCode: null, signal: "SIGTERM",
        terminalEventSeen: false, terminalSuccess: false, failureClass: "TRANSIENT_PROVIDER",
        cleanupStatus: "SUCCEEDED",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(closed?.maxRunsPerTask, 4);
    // Run 3 of 3 would have been the last attempt; the refunded ceiling requeues it.
    assert.equal(retry?.runNumber, 4);
    assert.equal(retry?.maxRunsPerTask, 4);
  });
});

test("startup reconciliation spares a run whose runner is still heartbeating", async () => {
  const now = new Date("2026-08-15T12:00:00Z");
  const candidates = [
    // Lease expired during an api restart, heartbeat 30s old: still alive.
    { id: "run-live", heartbeatAt: new Date(now.getTime() - 30_000), stallTimeoutMin: 10, taskId: "task-1", runNumber: 1, maxRunsPerTask: 3 },
    // Silent for 20 minutes: really gone.
    { id: "run-dead", heartbeatAt: new Date(now.getTime() - 20 * 60_000), stallTimeoutMin: 10, taskId: "task-2", runNumber: 1, maxRunsPerTask: 3 },
  ];
  const lost: string[] = [];
  const database = {
    run: {
      findMany: async () => candidates,
      updateMany: async ({ where }: { where: { id: string } }) => { lost.push(where.id); return { count: 1 }; },
      create: async () => ({}),
    },
    $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
      run: {
        updateMany: async ({ where }: { where: { id: string } }) => { lost.push(where.id); return { count: 1 }; },
        create: async () => ({}),
      },
      session: { updateMany: async () => ({}) },
      task: { update: async () => ({}) },
      taskActivity: { create: async () => ({}) },
      inboxMessage: { create: async () => ({}) },
    }),
  } as unknown as PrismaClient;
  assert.equal(await reconcileDatabaseRuns(database, now), 1);
  assert.deepEqual(lost, ["run-dead"]);
});
