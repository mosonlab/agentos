import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Prisma, RunStatus, RunnerKind, RunnerPreference, type PrismaClient } from "@agentos/db";

import { createApp } from "./app.js";
import { completionSucceeded, externalFailure } from "./execution.js";
import { noteArchivedQueuedRuns, reconcileDatabaseRuns } from "./reconcile.js";

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

test("filesystem grant CRUD accepts root/canonical paths and rejects non-canonical paths", async () => {
  await withTokens(async () => {
    const saved: string[] = [];
    const database = {
      filesystemGrant: {
        upsert: async ({ create }: { create: { folderPath: string } }) => { saved.push(create.folderPath); return create; },
        findFirst: async () => ({ id: "grant-1", agentId: "agent-1" }),
        findMany: async () => saved.map((folderPath, index) => ({ id: `grant-${index}`, folderPath })),
        update: async ({ data }: { data: { folderPath?: string } }) => { if (data.folderPath !== undefined) saved.push(data.folderPath); return data; },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = (folderPath: string) => app.request("/agents/agent-1/filesystem-grants", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath, canRead: true }),
    });
    assert.equal((await request("")).status, 201);
    for (const path of ["/abs", "a/../b", "a/"]) assert.equal((await request(path)).status, 400, path);
    assert.equal((await request("  _global  ")).status, 201);
    // Whitespace-only must not trim down to the whole-Files-Root sentinel.
    for (const blank of [" ", "   ", "\t\n "]) assert.equal((await request(blank)).status, 400, JSON.stringify(blank));
    const patchResponse = await app.request("/agents/agent-1/filesystem-grants/grant-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: "patched", canWrite: true }),
    });
    assert.equal(patchResponse.status, 200);
    assert.deepEqual(saved, ["", "_global", "patched"]);
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

test("an archived assignee's automatic retry is queued, audited, and does not spend an external-failure attempt", async () => {
  const previousRoot = process.env.RUNNER_WORKSPACE_ROOT;
  process.env.RUNNER_WORKSPACE_ROOT = `/tmp/agentos-missing-${Date.now()}`;
  try {
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
    const notices: Record<string, unknown>[] = [];
    const auditDb = {
      run: {
        findMany: async () => [{
          id: "run-4", taskId: "task-1", runNumber: retry?.runNumber,
          agent: { name: "Archived Retry Agent", archivedAt: new Date("2026-08-16T06:00:00.000Z") },
        }],
      },
      taskActivity: {
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => { notices.push(...data); return { count: data.length }; },
      },
    } as unknown as PrismaClient;
    assert.equal(await noteArchivedQueuedRuns(auditDb), 1);
    assert.match(String(notices[0]?.body), /Archived Retry Agent.*run 4/);
    });
  } finally {
    if (previousRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
    else process.env.RUNNER_WORKSPACE_ROOT = previousRoot;
  }
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
      findMany: async ({ where }: { where: { status: RunStatus | { in: RunStatus[] } } }) => (
        typeof where.status === "object" ? candidates : []
      ),
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
    archivedAt?: Date | null;
    name?: string;
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
  };
  const database = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      task: {
        findUnique: async () => ({
          id: "task-1",
          name: "Retry me",
          description: "Use current config",
          repoId: "repo-current",
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
    assert.equal(created?.repoId, "repo-current");
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
      repoId: created?.repoId,
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
      repoId: "repo-current",
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
    const noticeIds = new Set<string>();
    const database = {
      agent: {
        findUnique: async () => ({ id: "agent-1", name: "Agent", archivedAt }),
        update: async ({ data }: { data: { archivedAt: Date | null } }) => {
          archivedAt = data.archivedAt;
          updates.push(archivedAt);
          return { id: "agent-1", name: "Agent", archivedAt };
        },
      },
      run: {
        findMany: async () => archivedAt ? [{
          id: "run-queued", taskId: "task-1", runNumber: 1,
          agent: { name: "Agent", archivedAt },
        }] : [],
      },
      taskActivity: {
        createMany: async ({ data }: { data: Array<{ id: string }> }) => {
          let count = 0;
          for (const row of data) {
            if (noticeIds.has(row.id)) continue;
            noticeIds.add(row.id);
            count += 1;
          }
          return { count };
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
    assert.equal(noticeIds.size, 1);
    assert.match([...noticeIds][0]!, /^archived-skip:run-queued:/);

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

test("task create and patch reject an archived assignee with a named 400", async () => {
  await withTokens(async () => {
    const archived = { id: "agent-archived", name: "Archived Ada", archivedAt: new Date() };
    const createDb = {
      agent: { findFirst: async () => archived },
    } as unknown as PrismaClient;
    const created = await createApp(createDb).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Blocked", assigneeAgentId: archived.id, repoId: "repo-1" }),
    });
    assert.equal(created.status, 400);
    assert.deepEqual(await created.json(), { error: "Assignee Archived Ada is archived" });

    const patchDb = {
      task: { findUniqueOrThrow: async () => ({ id: "task-1", projectId: "project-1", assigneeAgentId: null, repoId: null }) },
      agent: { findFirst: async () => archived },
    } as unknown as PrismaClient;
    const patched = await createApp(patchDb).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeAgentId: archived.id }),
    });
    assert.equal(patched.status, 400);
    assert.deepEqual(await patched.json(), { error: "Assignee Archived Ada is archived" });
  });
});

test("operator retry rejects an archived assignee with a named 409", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
      id: "agent-archived",
      model: "model",
      runnerPreference: RunnerPreference.CLAUDE,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
      archivedAt: new Date(),
      name: "Archived Ada",
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Assignee Archived Ada is archived; unarchive it to retry" });
    assert.equal(created, undefined);
  });
});

test("template instantiate route maps an archived step agent to a named 400", async () => {
  await withTokens(async () => {
    const database = {
      taskTemplate: {
        findFirst: async () => ({
          id: "template-1",
          name: "Template",
          variables: [],
          steps: [{
            id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work", outputKind: "result",
            attachmentsFromPrevious: false, assigneeType: "AGENT", assigneeAgentId: "agent-1",
            assigneeAgent: { id: "agent-1", name: "Archived Ada", archivedAt: new Date() },
            approvalGate: false, runner: null,
          }],
        }),
      },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/task-templates/template-1/instantiate", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ repoId: "repo-1", variables: {} }),
    });
    assert.equal(response.status, 400);
    assert.match(String((await response.json() as { error: string }).error), /Implementation.*Archived Ada.*archived/);
  });
});

test("claim query filters archived agents before take so active work cannot starve", async () => {
  await withTokens(async () => {
    const candidate = (id: string, archivedAt: Date | null, offset: number) => ({
      id,
      projectId: "project-1",
      taskId: `task-${id}`,
      goalId: null,
      agentId: archivedAt ? "agent-archived" : "agent-active",
      repoId: "repo-1",
      runNumber: 1,
      runner: RunnerKind.CLAUDE,
      leaseGeneration: 0,
      maxDurationMin: 120,
      stallTimeoutMin: 10,
      readyAt: new Date(Date.now() + offset),
      createdAt: new Date(Date.now() + offset),
      session: null,
      task: { id: `task-${id}`, status: "TODO", chainId: null, chainIndex: null, templateStep: null },
      repo: { id: "repo-1" },
      agent: {
        id: archivedAt ? "agent-archived" : "agent-active",
        archivedAt,
        repoAccess: [{ repoId: "repo-1", projectId: "project-1" }],
        environment: { secrets: [] },
        secretGrants: [],
      },
    });
    const old = new Date("2026-08-16T06:00:00.000Z");
    const seeded = [
      ...Array.from({ length: 20 }, (_, index) => candidate(`archived-${index}`, old, index)),
      candidate("active", null, 100),
    ];
    let claimWhere: Record<string, unknown> | undefined;
    let claimedId: string | undefined;
    const tx = {
      run: {
        findMany: async ({ where, take }: { where: Record<string, any>; take: number }) => {
          claimWhere = where;
          const filtered = where.agent
            ? seeded.filter((run) => run.agent.archivedAt === where.agent.archivedAt)
            : seeded;
          return filtered.slice(0, take);
        },
        updateMany: async ({ where }: { where: { id: string } }) => { claimedId = where.id; return { count: 1 }; },
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id, status: RunStatus.CLAIMED }),
      },
      runnerBackendState: { findUnique: async () => null },
      session: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "session-1", ...data }) },
      sessionEvent: { aggregate: async () => ({ _max: { seq: null } }) },
      task: { update: async () => ({}) },
      taskActivity: { create: async () => ({}) },
      taskStepOutput: { findMany: async () => [] },
    };
    const database = {
      run: { findMany: async () => [] },
      taskActivity: { createMany: async () => ({ count: 0 }) },
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", leaseSeconds: 60 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(claimWhere?.agent, { archivedAt: null });
    assert.equal(claimedId, "active");
  });
});

test("claim polling throttles the archived-run audit sweep per API process", async () => {
  await withTokens(async () => {
    let auditQueries = 0;
    const database = {
      run: {
        findMany: async ({ where }: { where: { status: RunStatus | { in: RunStatus[] } } }) => {
          if (where.status === RunStatus.QUEUED) auditQueries += 1;
          return [];
        },
      },
      taskActivity: { createMany: async () => ({ count: 0 }) },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
        run: { findMany: async () => [] },
      }),
    } as unknown as PrismaClient;
    const app = createApp(database);
    const request = () => app.request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", leaseSeconds: 60 }),
    });
    assert.equal((await request()).status, 204);
    assert.equal((await request()).status, 204);
    assert.equal(auditQueries, 1);
  });
});

test("successful completion commits output and parks an archived chain successor without enqueueing", async () => {
  await withTokens(async () => {
    const previousRoot = process.env.RUNNER_WORKSPACE_ROOT;
    process.env.RUNNER_WORKSPACE_ROOT = `/tmp/agentos-missing-${Date.now()}`;
    try {
      let closed = false;
      let outputCreated = false;
      let successorUpdate: Record<string, unknown> | undefined;
      let successorActivity: Record<string, unknown> | undefined;
      let runCreates = 0;
      const successor = {
        id: "task-2",
        assigneeType: "AGENT",
        assigneeAgentId: "agent-2",
        repoId: "repo-1",
        approvalGate: false,
        updatedAt: new Date(),
        runs: [],
        assigneeAgent: { id: "agent-2", name: "Archived Successor", archivedAt: new Date() },
      };
      const run = {
        id: "run-1", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1",
        repoId: "repo-1", runNumber: 1, maxRunsPerTask: 3, runner: RunnerKind.CLAUDE,
        model: "model", targetBranch: "main", branch: "feature/chain", baseSha: "base",
        promptHash: "hash", maxDurationMin: 120, stallTimeoutMin: 10,
        task: { id: "task-1", templateId: "template-1", templateStep: { outputKind: "result" } },
        session: { id: "session-1" },
      };
      const tx = {
        run: {
          findFirst: async () => run,
          updateMany: async () => { closed = true; return { count: 1 }; },
          create: async () => { runCreates += 1; return {}; },
        },
        session: { update: async () => ({}) },
        taskStepOutput: {
          findUnique: async () => null,
          create: async () => { outputCreated = true; return {}; },
        },
        task: {
          findUniqueOrThrow: async () => ({
            id: "task-1", name: "Predecessor", templateId: "template-1", approvalGate: false,
            followUpTaskId: successor.id, followUpTask: successor,
          }),
          findUnique: async () => successor,
          updateMany: async () => ({ count: 1 }),
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            if (where.id === successor.id) successorUpdate = data;
            return {};
          },
        },
        taskActivity: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (data.taskId === successor.id) successorActivity = data;
            return {};
          },
        },
        runnerBackendState: { upsert: async () => ({ consecutiveAuthFailures: 0 }) },
      };
      const database = {
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
        run: { findMany: async () => [] },
      } as unknown as PrismaClient;
      const response = await createApp(database).request("/runner/runs/run-1/complete", {
        method: "POST",
        headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          runnerId: "runner-1",
          fencingToken: "1:run-1:token",
          exitCode: 0,
          terminalEventSeen: true,
          terminalSuccess: true,
          cleanupStatus: "SUCCEEDED",
          pushStatus: "NOT_REQUESTED",
          output: "done",
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(closed, true);
      assert.equal(outputCreated, true);
      assert.equal(runCreates, 0);
      assert.equal(successorUpdate?.status, "REVIEW");
      assert.match(String(successorUpdate?.failureReason), /Archived Successor/);
      assert.match(String(successorActivity?.body), /Archived Successor.*not queued/);
    } finally {
      if (previousRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
      else process.env.RUNNER_WORKSPACE_ROOT = previousRoot;
    }
  });
});

test("archived successor errors from gate approve and reject map to named 409 responses", async () => {
  await withTokens(async () => {
    const gateResponse = async (decision: "approve" | "reject") => {
      const targetId = decision === "approve" ? "successor-1" : "gate-1";
      const executable = {
        id: targetId,
        projectId: "project-1",
        name: decision === "approve" ? "Successor step" : "Redo step",
        description: "work",
        assigneeType: "AGENT",
        assigneeAgentId: "agent-archived",
        repoId: "repo-1",
        templateId: "template-1",
        targetBranch: "main",
        updatedAt: new Date(),
        maxDurationMin: 120,
        stallTimeoutMin: 10,
        maxSessionsPerTask: 3,
        runs: [],
        assigneeAgent: {
          id: "agent-archived",
          name: "Archived Gate Agent",
          archivedAt: new Date(),
          model: "model",
          runnerPreference: RunnerPreference.CLAUDE,
          foundationalPrompt: "foundation",
          rolePrompt: "role",
        },
        repo: { id: "repo-1", defaultBranch: "main" },
        templateStep: null,
      };
      const gateTask = {
        id: "gate-1",
        assigneeType: "AGENT",
        followUpTaskId: "successor-1",
        previousTask: null,
      };
      const tx = {
        inboxMessage: {
          findUnique: async () => ({
            id: "message-1", kind: "MULTIPLE_CHOICE", gateTaskId: gateTask.id,
            agentId: "agent-1", sessionId: "session-1", taskId: gateTask.id,
            goalId: null, threadId: "thread-1",
            session: { id: "session-1", run: { id: "run-1", status: RunStatus.SUCCEEDED } },
            gateTask,
          }),
          updateMany: async () => ({ count: 1 }),
          create: async () => ({ id: "reply-1" }),
        },
        inboxDecision: { create: async () => ({}) },
        task: {
          update: async () => ({}),
          findUniqueOrThrow: async () => executable,
          // approve now routes through activateChainSuccessor, which reads the
          // successor itself and CAS-claims it before the archived check
          findUnique: async () => executable,
          updateMany: async () => ({ count: 1 }),
        },
        taskActivity: { create: async () => ({}) },
        run: { create: async () => { throw new Error("must not create"); } },
      };
      const database = {
        $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      } as unknown as PrismaClient;
      return createApp(database).request("/inbox/messages/message-1/decision", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ decision, requestId: `request-${decision}` }),
      });
    };

    for (const decision of ["approve", "reject"] as const) {
      const response = await gateResponse(decision);
      assert.equal(response.status, 409);
      assert.match(String((await response.json() as { error: string }).error), /Archived Gate Agent.*archived/);
    }
  });
});

test("GET /sessions is project-scoped, clamped, cursored, and reachable by the operator", async () => {
  await withTokens(async () => {
    const calls: Array<Record<string, unknown>> = [];
    const database = {
      session: {
        findMany: async (args: Record<string, unknown>) => { calls.push(args); return []; },
      },
    } as unknown as PrismaClient;
    const app = createApp(database);
    const get = (query: string) => app.request(`/sessions${query}`, { headers: { Authorization: "Bearer operator-unit-token" } });

    // The route is one character from "/session/", which principalMayAccess
    // denies the operator. Pin the 200 so a rename cannot silently 403.
    const scoped = await get("?projectId=p&limit=5&before=2026-08-16T00:00:00.000Z");
    assert.equal(scoped.status, 200);
    const args = calls[0] as { where: { projectId: string; requestedAt: { lt: Date } }; take: number; orderBy: { requestedAt: string }; include: Record<string, unknown> };
    assert.equal(args.where.projectId, "p");
    assert.ok(args.where.requestedAt.lt instanceof Date);
    assert.equal(args.take, 5);
    assert.equal(args.orderBy.requestedAt, "desc");
    assert.deepEqual(Object.keys(args.include).sort(), ["agent", "goal", "run", "task"]);
    // Without remoteUrl the detail page's Branch field could never be a link.
    const run = args.include.run as { select: { repo: { select: Record<string, boolean> } } };
    assert.deepEqual(Object.keys(run.select.repo.select).sort(), ["id", "name", "remoteUrl"]);

    await get("?limit=9999");
    assert.equal((calls[1] as { take: number }).take, 200);
    await get("?limit=abc");
    assert.equal((calls[2] as { take: number }).take, 50);
    await get("?before=not-a-date");
    assert.equal((calls[3] as { where: Record<string, unknown> }).where.requestedAt, undefined);
  });
});

test("GET /sessions/:sessionId 404s cleanly and carries the repo remote URL", async () => {
  await withTokens(async () => {
    const calls: Array<Record<string, unknown>> = [];
    const database = {
      session: { findUnique: async (args: Record<string, unknown>) => { calls.push(args); return null; } },
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/sessions/unknown", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Session not found" });
    const include = (calls[0] as { include: { run: { select: { repo: { select: Record<string, boolean> } } } } }).include;
    assert.equal(include.run.select.repo.select.remoteUrl, true);
  });
});

test("GET /runs/:runId/events pages by seq and reports hasMore without a second count", async () => {
  await withTokens(async () => {
    const rows = (count: number, from: number) => Array.from({ length: count }, (_, index) => ({ id: `e${from + index}`, seq: from + index }));
    const findManyArgs: Array<Record<string, unknown>> = [];
    const makeApp = (returned: Array<{ seq: number }>) => createApp({
      sessionEvent: {
        findMany: async (args: Record<string, unknown>) => { findManyArgs.push(args); return returned; },
        count: async () => 12,
      },
    } as unknown as PrismaClient);

    const more = await makeApp(rows(3, 8)).request("/runs/r1/events?afterSeq=7&limit=2", { headers: { Authorization: "Bearer operator-unit-token" } });
    const body = await more.json() as { events: Array<{ seq: number }>; hasMore: boolean; nextAfterSeq: number; total: number };
    assert.equal(body.events.length, 2);
    assert.equal(body.hasMore, true);
    assert.equal(body.nextAfterSeq, 9);
    assert.equal(body.total, 12);
    assert.deepEqual((findManyArgs[0] as { where: { seq: { gt: number } } }).where.seq, { gt: 7 });
    assert.equal((findManyArgs[0] as { take: number }).take, 3);

    const done = await makeApp(rows(2, 8)).request("/runs/r1/events?afterSeq=7&limit=2", { headers: { Authorization: "Bearer operator-unit-token" } });
    assert.equal((await done.json() as { hasMore: boolean }).hasMore, false);

    await makeApp([]).request("/runs/r1/events?limit=99999", { headers: { Authorization: "Bearer operator-unit-token" } });
    const clamped = findManyArgs.at(-1) as { take: number; where: Record<string, unknown> };
    assert.equal(clamped.take, 2001);
    assert.equal(clamped.where.seq, undefined);
  });
});

/* --------------------------------- the usage recompute's ingest wiring */

/** A CLAUDE terminal `result` line, trimmed to the fields `extractUsage` reads.
 *  Values are the captured shape from `spikes/cli-capabilities/samples/`. */
const finalOutputPayload = {
  type: "result",
  total_cost_usd: 0.049117,
  usage: { input_tokens: 4, output_tokens: 77, cache_read_input_tokens: 8_700, cache_creation_input_tokens: 120 },
};

/** The stub the three wiring tests share: one live run with a session, a
 *  `createMany` that accepts anything, and a recording `session.update`.
 *  `onUpdate` lets a test make the derived-cache write fail. */
const ingestDatabase = (
  updates: Array<Record<string, unknown>>,
  finalOutputRows: Array<{ payload: unknown }>,
  onUpdate?: () => never,
): PrismaClient => ({
  run: {
    findFirst: async () => ({ id: "run-1", session: { id: "ses-1", providerConversationId: "conv-1" } }),
  },
  sessionEvent: {
    createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
    findMany: async () => finalOutputRows,
  },
  session: {
    findUnique: async () => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, costUsd: null }),
    update: async (args: Record<string, unknown>) => { onUpdate?.(); updates.push(args); return {}; },
  },
} as unknown as PrismaClient);

const postEvents = async (database: PrismaClient, types: string[]): Promise<Response> =>
  createApp(database).request("/runner/runs/run-1/events", {
    method: "POST",
    headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerId: "runner-1",
      fencingToken: "1:run-1:current",
      events: types.map((type, index) => ({
        seq: index + 1,
        source: "CLAUDE",
        type,
        payload: type === "FINAL_OUTPUT" ? finalOutputPayload : { text: "hello" },
      })),
    }),
  });

test("ingesting a FINAL_OUTPUT writes the derived usage columns", async () => {
  await withTokens(async () => {
    const updates: Array<Record<string, unknown>> = [];
    const response = await postEvents(ingestDatabase(updates, [{ payload: finalOutputPayload }]), ["MODEL_COMPLETED", "FINAL_OUTPUT"]);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: 2 });
    assert.equal(updates.length, 1);
    const write = updates[0] as { where: { id: string }; data: Record<string, unknown> };
    assert.equal(write.where.id, "ses-1");
    assert.equal(write.data.inputTokens, 4);
    assert.equal(write.data.outputTokens, 77);
    assert.equal(write.data.cachedInputTokens, 8_820);
    // totalTokens is input + output by definition (spec §4.6); cache is stored
    // separately rather than folded in.
    assert.equal(write.data.totalTokens, 81);
    assert.equal(String(write.data.costUsd), "0.0491");
  });
});

test("a batch with no FINAL_OUTPUT does not touch the usage columns", async () => {
  await withTokens(async () => {
    const updates: Array<Record<string, unknown>> = [];
    const response = await postEvents(ingestDatabase(updates, [{ payload: finalOutputPayload }]), ["MODEL_COMPLETED", "TOOL_STARTED"]);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: 2 });
    assert.equal(updates.length, 0);
  });
});

test("a failing usage recompute does not fail the ingest", async () => {
  await withTokens(async () => {
    // The derived cache must never be fatal to the write path it decorates:
    // `appendEvents` has no retry, so a 500 here would reject the runner's
    // terminal flush, skip deliverWorkspace/completeRun, record a successful
    // run as failed and delete its workspace unpushed.
    const updates: Array<Record<string, unknown>> = [];
    const database = ingestDatabase(updates, [{ payload: finalOutputPayload }], () => {
      throw new Error("value out of range for type integer");
    });
    const errors: unknown[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const response = await postEvents(database, ["FINAL_OUTPUT"]);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { accepted: 1 });
    } finally {
      console.error = consoleError;
    }
    assert.equal(updates.length, 0);
    assert.equal(errors.length, 1);
  });
});
