import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Prisma, RunnerKind, RunnerPreference, type PrismaClient } from "@agentos/db";

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
      task: { update: async () => ({}) },
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

const retryRequest = async (
  assigneeAgent: {
    id: string;
    model: string;
    runnerPreference: RunnerPreference;
    foundationalPrompt: string;
    rolePrompt: string;
  } | null,
  templateStep: { runner: RunnerKind | null } | null = null,
) => {
  let created: Record<string, unknown> | undefined;
  const last = {
    id: "run-1",
    projectId: "project-1",
    taskId: "task-1",
    goalId: "goal-1",
    agentId: "old-agent",
    repoId: "repo-1",
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
  };
  const database = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      task: {
        findUnique: async () => ({
          id: "task-1",
          name: "Retry me",
          description: "Use current config",
          assigneeAgent,
          templateStep,
          runs: [last],
        }),
        update: async () => ({}),
      },
      run: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created = data;
          return { id: "run-2", ...data };
        },
      },
      taskActivity: { create: async () => ({}) },
    }),
  } as unknown as PrismaClient;
  const response = await createApp(database).request("/tasks/task-1/retry", {
    method: "POST",
    headers: { Authorization: "Bearer operator-unit-token" },
  });
  return { response, created, last };
};

test("operator retry re-derives runner, model, promptHash and current agent id", async () => {
  await withTokens(async () => {
    const { response, created, last } = await retryRequest({
      id: "current-agent",
      model: "deepseek-current",
      runnerPreference: RunnerPreference.PI,
      foundationalPrompt: "new foundation",
      rolePrompt: "new role",
    });
    assert.equal(response.status, 201);
    assert.equal(created?.agentId, "current-agent");
    assert.equal(created?.runner, RunnerKind.PI);
    assert.equal(created?.model, "deepseek-current");
    assert.notEqual(created?.promptHash, last.promptHash);
    assert.equal(created?.branch, last.branch);
    assert.equal(created?.targetBranch, last.targetBranch);
    assert.equal(created?.maxRunsPerTask, last.maxRunsPerTask);
  });
});

test("operator retry with unchanged agent preserves the previously derived config", async () => {
  await withTokens(async () => {
    const { response, created, last } = await retryRequest({
      id: "old-agent",
      model: "old-model",
      runnerPreference: RunnerPreference.CLAUDE,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    });
    assert.equal(response.status, 201);
    assert.deepEqual({
      agentId: created?.agentId,
      runner: created?.runner,
      model: created?.model,
      branch: created?.branch,
      targetBranch: created?.targetBranch,
      maxDurationMin: created?.maxDurationMin,
      stallTimeoutMin: created?.stallTimeoutMin,
      maxRunsPerTask: created?.maxRunsPerTask,
      promptHash: created?.promptHash,
    }, {
      agentId: "old-agent",
      runner: RunnerKind.CLAUDE,
      model: "old-model",
      branch: "feature/retry",
      targetBranch: "main",
      maxDurationMin: 90,
      stallTimeoutMin: 7,
      maxRunsPerTask: 4,
      promptHash: last.promptHash,
    });
  });
});

test("operator retry honors a template-step runner override", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
      id: "agent-1",
      model: "deepseek-current",
      runnerPreference: RunnerPreference.PI,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    }, { runner: RunnerKind.CODEX });
    assert.equal(response.status, 201);
    assert.equal(created?.runner, RunnerKind.CODEX);
  });
});

test("operator retry returns 409 when the task assignee no longer exists", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest(null);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Task assignee no longer exists; assign an agent before retrying",
    });
    assert.equal(created, undefined);
  });
});

test("agent archive and unarchive are idempotent and preserve the original archive timestamp", async () => {
  await withTokens(async () => {
    let archivedAt: Date | null = null;
    const updates: Array<Date | null> = [];
    const database = {
      agent: {
        findUnique: async () => ({ id: "agent-1", name: "Agent", archivedAt }),
        update: async ({ data }: { data: { archivedAt: Date | null } }) => {
          archivedAt = data.archivedAt;
          updates.push(archivedAt);
          return { id: "agent-1", name: "Agent", archivedAt };
        },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = (path: string) => app.request(path, {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token" },
    });

    const archived = await request("/agents/agent-1/archive");
    assert.equal(archived.status, 200);
    assert.ok(updates[0] instanceof Date);
    const originalTimestamp = archivedAt;
    assert.equal((await request("/agents/agent-1/archive")).status, 200);
    assert.equal(archivedAt, originalTimestamp);
    assert.equal(updates.length, 1);

    const unarchived = await request("/agents/agent-1/unarchive");
    assert.equal(unarchived.status, 200);
    assert.equal(archivedAt, null);
    assert.equal((await request("/agents/agent-1/unarchive")).status, 200);
    assert.deepEqual(updates, [originalTimestamp, null]);
  });
});

test("archive and unarchive return 404 for a missing agent", async () => {
  await withTokens(async () => {
    const database = { agent: { findUnique: async () => null } } as unknown as PrismaClient;
    const app = createApp(database);
    for (const action of ["archive", "unarchive"]) {
      const response = await app.request(`/agents/missing/${action}`, {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token" },
      });
      assert.equal(response.status, 404);
    }
  });
});

test("deleting an agent with task history maps Prisma P2003 to a guided 409", async () => {
  await withTokens(async () => {
    const database = {
      agent: {
        delete: async () => {
          throw new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
            code: "P2003",
            clientVersion: "6.19.0",
          });
        },
      },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/agents/agent-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Agent has task history; archive it instead" });
  });
});

test("deleting a history-free agent still returns 204", async () => {
  await withTokens(async () => {
    let deleted = false;
    const database = {
      agent: { delete: async () => { deleted = true; return {}; } },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/agents/agent-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(response.status, 204);
    assert.equal(deleted, true);
  });
});
