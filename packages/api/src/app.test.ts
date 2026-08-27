import "./test-workspace-root.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
  Prisma,
  RunStatus,
  RunnerKind,
  RunnerPreference,
  type PrismaClient,
} from "@agentos/db";

import { createApp, partitionArchivable } from "./test-app.js";
import { createApp as createLiveApp } from "./app.js";
import { LOOPBACK_BROWSER_ORIGINS } from "./local-origin.js";
import { completionSucceeded, externalFailure } from "./execution.js";
import { isStarterMountPath, isValidBranchName, onboardingInput, parseRepoRemote, slugify } from "./onboarding.js";
import { RepositoryPreflightError } from "./onboarding-preflight.js";
import { reconcileDatabaseRuns } from "./reconcile.js";
import { activeRunStatuses } from "./run-fence.js";

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

const lockedAgent = <T extends Record<string, unknown>>(agent: T | null): (T & Record<string, unknown>) | null => agent ? ({
  name: "Agent",
  archivedAt: null,
  codexServiceTier: "DEFAULT",
  ...agent,
}) : null;

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

/* A merge-tail stop report: agent-authored text, attached to the task it
 * happened on, and nothing resumes on a reply. It is the shape the Inbox is
 * full of, and the old "attached to nothing" rule refused to close it. */
const stopReport = {
  id: "message-1", status: "OPEN", from: "AGENT", kind: "TEXT", gateTaskId: null, replyToMessageId: null,
};

const closeRequest = async (app: ReturnType<typeof createApp>, messageId: string): Promise<Response> =>
  await app.request(`/inbox/messages/${messageId}/close`, {
    method: "POST",
    headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: `close-${messageId}` }),
  });

test("operator can close a notification attached to a task when no run waits on it", async () => {
  await withTokens(async () => {
    let updateWhere: unknown;
    const database = {
      inboxMessage: {
        findUnique: async () => stopReport,
        updateMany: async ({ where }: { where: unknown }) => { updateWhere = where; return { count: 1 }; },
      },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const response = await closeRequest(createApp(database), "message-1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { closed: true, duplicate: false, requestId: "close-message-1" });
    // The conditional update guards what the row itself can prove; the waiting
    // session is checked above it, and cannot appear for an existing card.
    assert.deepEqual(updateWhere, {
      id: "message-1", status: "OPEN", from: "AGENT", kind: "TEXT",
      gateTaskId: null, replyToMessageId: null,
    });
  });
});

test("operator cannot close a gate, nor a card a suspended run resumes on", async () => {
  await withTokens(async () => {
    const gateDatabase = {
      inboxMessage: { findUnique: async () => ({ ...stopReport, gateTaskId: "gate-1" }) },
      session: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const gate = await closeRequest(createApp(gateDatabase), "message-2");
    assert.equal(gate.status, 409);
    assert.match(String((await gate.json() as { error: string }).error), /no run is waiting on/u);

    const waitingDatabase = {
      inboxMessage: { findUnique: async () => stopReport },
      session: { findMany: async () => [{ waitingOnMessageId: "message-1" }] },
    } as unknown as PrismaClient;
    const waiting = await closeRequest(createApp(waitingDatabase), "message-1");
    assert.equal(waiting.status, 409);
    assert.match(String((await waiting.json() as { error: string }).error), /no run is waiting on/u);
  });
});

test("live claim reconciliation asserts root ownership before touching database state", async () => {
  await withTokens(async () => {
    let databaseTouched = false;
    const database = {
      run: { findMany: async () => { databaseTouched = true; return []; } },
    } as unknown as PrismaClient;
    const app = createLiveApp(database, {
      ownership: { assertHeld: () => { throw new Error("ownership-poisoned-for-test"); } },
    });
    const response = await app.request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", leaseSeconds: 60 }),
    });
    assert.equal(response.status, 500);
    assert.equal(databaseTouched, false);
  });
});

test("task status patch does not apply create defaults to other fields", async () => {
  await withTokens(async () => {
    let updateData: unknown;
    // A status write now runs under the Task-row mutex, so the mock supplies
    // `$transaction` and the `FOR UPDATE` read the route takes first.
    const tx = {
      $queryRaw: async (_strings: unknown, taskId: string) => [{ id: taskId, status: "REVIEW", archivedAt: null }],
      task: {
        findUniqueOrThrow: async () => ({ id: "task-1", projectId: "project-1", status: "REVIEW", archivedAt: null }),
        // §D-P7's stop-state guard loads the task with its template step before
        // any status write. An ordinary task has no step, and the guard is then
        // a no-op — but it still asks.
        findUnique: async () => ({ id: "task-1", projectId: "project-1", status: "REVIEW", archivedAt: null, templateStep: null }),
        update: async ({ data }: { data: unknown }) => { updateData = data; return { id: "task-1", status: "DONE" }; },
      },
      run: { count: async () => 0 },
      inboxMessage: { findFirst: async () => null, updateMany: async () => ({ count: 0 }), count: async () => 0 },
      taskActivity: { create: async () => ({ id: "activity-1" }) },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
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

test("task PATCH names and rejects an invalid compound implementation assignee before writing", async () => {
  await withTokens(async () => {
    let updates = 0;
    const before = {
      id: "implementation-1",
      projectId: "project-1",
      name: "Implementation",
      description: "execute the plan",
      status: "TODO",
      archivedAt: null,
      assigneeType: "AGENT",
      assigneeAgentId: "executioner-1",
      repoId: "repo-1",
      templateStepId: "step-5",
      chainId: "chain-1",
      approvalGate: false,
    };
    const senior = {
      id: "senior-1",
      projectId: before.projectId,
      name: "senior-dev-high",
      archivedAt: null,
    };
    const database = {
      task: {
        findUniqueOrThrow: async () => before,
        update: async () => { updates += 1; return before; },
      },
      agent: { findFirst: async () => senior },
      taskTemplateStep: { findUnique: async () => ({
        stepIndex: 5,
        outputKind: "implementation",
        taskTemplate: { name: "compound-engineer-workflow" },
      }) },
    } as unknown as PrismaClient;
    const response = await createApp(database).request(`/tasks/${before.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeAgentId: senior.id }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Compound implementation step must remain assigned to the active in-project Agent implementation-plan-executioner",
      code: COMPOUND_IMPLEMENTATION_ASSIGNEE_ERROR_CODE,
    });
    assert.equal(updates, 0);
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

test("public task creation assigns a linear layer and rejects layer/dependency inputs", async () => {
  await withTokens(async () => {
    let stored: Record<string, unknown> | undefined;
    const database = {
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
        task: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            stored = data;
            return { id: "task-1", ...data };
          },
        },
        taskActivity: { create: async () => ({}) },
      }),
    } as unknown as PrismaClient;
    const created = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Layered API task", assigneeType: "HUMAN", chainId: "chain-1", chainIndex: 4,
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(stored?.chainLayer, 4);

    for (const field of ["layer", "chainLayer", "dependencies", "blockedBy"]) {
      const response = await createApp({} as PrismaClient).request("/projects/project-1/tasks", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Rejected", assigneeType: "HUMAN", [field]: field === "layer" ? 2 : [] }),
      });
      assert.equal(response.status, 400, field);
    }
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
      repo: { id: "repo-1", defaultBranch: "main" }, templateStep: null, archivedAt: null,
    };
    const before = { id: "task-1", projectId: "project-1", name: "Gate", status: "REVIEW", templateId: null, approvalGate: true, chainId: "chain-1", chainIndex: 0, assigneeAgentId: "agent-1", repoId: "repo-1", archivedAt: null };
    const tx = {
      // The status write takes the Task-row mutex before advancing the chain.
      $queryRaw: async (_strings: unknown, taskId: string) => [{ id: taskId }],
      task: {
        update: async () => ({ ...before, status: "DONE" }),
        findFirst: async () => successor,
        findMany: async () => [before],
        findUnique: async ({ where }: { where: { id: string } }) => where.id === before.id ? before : successor,
        updateMany: async () => ({ count: 1 }),
        findUniqueOrThrow: async () => successor,
      },
      inboxMessage: {
        findFirst: async () => null,
        updateMany: async () => { closed = true; return { count: 1 }; },
        count: async () => 1,
      },
      taskActivity: { create: async () => ({}) },
      // findFirst answers resolveRunBranches' publication query: nothing in this
      // chain has pushed the shared branch, so the successor bases on the default.
      run: { create: async () => ({ id: "run-1" }), findFirst: async () => null, count: async () => 0 },
      agent: { findUnique: async () => lockedAgent(successor.assigneeAgent) },
    };
    const database = {
      task: { findUniqueOrThrow: async () => before },
      agentRepoAccess: { findFirst: async () => ({}) },
      // §D-P4 resolves the effective assignee's *name* before allowing a
      // reassignment, because the invariant is stated over the name.
      agent: { findUnique: async () => ({ name: "senior-dev" }) },
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

test("a template HUMAN final step closes its exact OPEN gate even when approvalGate is false", async () => {
  await withTokens(async () => {
    let closedWhere: unknown;
    const before = {
      id: "task-1", projectId: "project-1", name: "Human final", status: "REVIEW", templateId: "template-1",
      approvalGate: false, chainId: "chain-1", chainIndex: 2,
      assigneeType: "HUMAN", assigneeAgentId: null, repoId: null, archivedAt: null,
    };
    const tx = {
      $queryRaw: async () => [{ id: before.id }],
      task: {
        findUniqueOrThrow: async () => before,
        findUnique: async () => before,
        findMany: async () => [before],
        update: async () => ({ ...before, status: "DONE" }),
        findFirst: async () => null,
      },
      run: { count: async () => 0 },
      inboxMessage: {
        findFirst: async () => null,
        updateMany: async ({ where }: { where: unknown }) => { closedWhere = where; return { count: 1 }; },
        count: async () => 1,
      },
      taskActivity: { create: async () => ({}) },
    };
    const database = {
      task: { findUniqueOrThrow: async () => before },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/tasks/task-1", {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DONE" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(closedWhere, { gateTaskId: before.id, status: "OPEN" });
  });
});

test("CRON create computes runAt, ignores caller runAt, and creates no immediate run", async () => {
  await withTokens(async () => {
    let stored: Record<string, any> | undefined;
    let runs = 0;
    const agent = { id: "agent-1", runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" };
    const repo = { id: "repo-1", defaultBranch: "main" };
    const tx = {
      $queryRaw: async () => [{ id: agent.id, archivedAt: null }],
      agent: { findUnique: async () => lockedAgent(agent) },
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
    const before = { id: "task-1", projectId: "project-1", status: "TODO", templateId: null, approvalGate: false, chainId: null, scheduleKind: "AT", runAt, cron: null, timezone: null, assigneeType: "AGENT", assigneeAgentId: "agent-1", repoId: "repo-1" };
    const database = {
      agent: { findFirst: async () => ({ id: "agent-1", runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
      repo: { findFirst: async () => ({ id: "repo-1", defaultBranch: "main" }) },
      agentRepoAccess: { findFirst: async () => ({}) },
      task: { findUniqueOrThrow: async () => before },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "agent-1", archivedAt: null }],
        agent: { findUnique: async () => lockedAgent({ id: "agent-1", runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
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
        // The refusal is explained from the row, not guessed from the miss.
        findUnique: async () => ({
          runnerId: "runner-1",
          fencingToken: currentToken,
          cancelRequestedAt: null,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          status: RunStatus.RUNNING,
        }),
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
    assert.deepEqual(await response.json(), { error: "Stale fencing token", reason: "stale-fence" });
  });
});

test("session output authorization cannot introduce a second fence instant", async () => {
  const fencedPredicates: Prisma.RunWhereInput[] = [];
  const task = {
    id: "task-1",
    projectId: "project-1",
    chainId: null,
    chainIndex: null,
    chainLayer: null,
    status: "IN_PROGRESS",
    templateStep: {
      stepIndex: 1,
      outputKind: "implementation",
      baseFromStepIndex: null,
      taskTemplate: { name: "direct-engineer-workflow" },
    },
  };
  const database: Record<string, unknown> = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    run: { findFirst: async ({ where }: { where: Prisma.RunWhereInput }) => {
      if ("sessionTokenHash" in where) return { id: "run-1", leaseGeneration: 1 };
      fencedPredicates.push(where);
      return { taskId: "task-1", runnerId: "runner-1", task };
    } },
  };
  database.$transaction = async (operation: (tx: unknown) => Promise<unknown>) => operation(database);

  const response = await createApp(database as unknown as PrismaClient).request("/session/runs/run-1/output", {
    method: "PUT",
    headers: { Authorization: "Bearer agos_session_current", "Content-Type": "application/json" },
    body: JSON.stringify({
      fencingToken: "1:run-1:current",
      kind: "wrong-kind",
      body: "not persisted",
      commitSha: "a".repeat(40),
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "task_output kind must be implementation for this canonical step" });
  assert.equal(fencedPredicates.length, 4);
  const instants = fencedPredicates.map((where) => (where.leaseExpiresAt as { gt: Date }).gt);
  assert.ok(instants.every((at) => at === instants[0]));
  assert.ok(fencedPredicates.every((where) => (
    where.status as { in: RunStatus[] }
  ).in === activeRunStatuses));
});

test("resuming a run preserves its original Run and Session start timestamps", async () => {
  await withTokens(async () => {
    const originalStartedAt = new Date("2026-08-21T00:00:00.000Z");
    const resumedPromptHash = createHash("sha256").update("exact continuation input").digest("hex");
    const runWrites: Array<Record<string, unknown>> = [];
    const sessionWrites: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: async () => [{ id: "run-1" }],
      run: {
        findUnique: async () => ({ startedAt: originalStartedAt, session: { startedAt: originalStartedAt } }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          runWrites.push(data);
          return { count: 1 };
        },
      },
      session: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          sessionWrites.push(data);
          return { count: 1 };
        },
      },
    };
    const database = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/runner/runs/run-1/start", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1",
        fencingToken: "1:run-1:current",
        adapterVersion: "test",
        cliVersion: "test",
        promptHash: resumedPromptHash,
        manifest: {},
        workspacePath: "/scratch/resumed",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(runWrites[0]?.startedAt, originalStartedAt);
    assert.equal(runWrites[0]?.promptHash, resumedPromptHash);
    assert.equal(sessionWrites[0]?.startedAt, originalStartedAt);
  });
});

test("starting a fresh run stamps the same new timestamp on its Run and Session", async () => {
  await withTokens(async () => {
    const runWrites: Array<Record<string, unknown>> = [];
    const sessionWrites: Array<Record<string, unknown>> = [];
    const dispatchedPromptHash = createHash("sha256").update("the exact dispatched prompt").digest("hex");
    const tx = {
      $queryRaw: async () => [{ id: "run-1" }],
      run: {
        findUnique: async () => ({ startedAt: null, session: { startedAt: null } }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          runWrites.push(data);
          return { count: 1 };
        },
      },
      session: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          sessionWrites.push(data);
          return { count: 1 };
        },
      },
    };
    const database = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const before = Date.now();
    const response = await createApp(database).request("/runner/runs/run-1/start", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1",
        fencingToken: "1:run-1:current",
        adapterVersion: "test",
        cliVersion: "test",
        promptHash: dispatchedPromptHash,
        manifest: {},
        workspacePath: "/scratch/fresh",
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(runWrites[0]?.startedAt instanceof Date);
    assert.equal(sessionWrites[0]?.startedAt, runWrites[0]?.startedAt);
    assert.ok((runWrites[0]?.startedAt as Date).getTime() >= before);
    assert.equal(runWrites[0]?.promptHash, dispatchedPromptHash);
  });
});

test("starting a run without an exact dispatched prompt hash is refused before database access", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/runner/runs/run-1/start", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1",
        fencingToken: "1:run-1:current",
        adapterVersion: "test",
        cliVersion: "test",
        manifest: {},
        workspacePath: "/scratch/fresh",
      }),
    });
    assert.equal(response.status, 400);
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

test("completion refunds an external failure but refuses an automatic retry for an archived Agent", async () => {
  const previousRoot = process.env.RUNNER_WORKSPACE_ROOT;
  process.env.RUNNER_WORKSPACE_ROOT = `/tmp/agentos-missing-${Date.now()}`;
  try {
    await withTokens(async () => {
    let closed: Record<string, unknown> | undefined;
    let retry: Record<string, unknown> | undefined;
    const taskWrites: Record<string, unknown>[] = [];
    const inbox: Record<string, unknown>[] = [];
    const archivedAt = new Date("2026-08-16T06:00:00.000Z");
    const run = {
      id: "run-3", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1", repoId: "repo-1",
      runNumber: 3, maxRunsPerTask: 3, runner: "CLAUDE", model: "claude", targetBranch: "main", branch: "feat/x",
      codexServiceTier: "DEFAULT", subagentModel: null, subagentMaxConcurrent: null, budgetGrants: 0,
      baseSha: null, promptHash: "hash", maxDurationMin: 120, stallTimeoutMin: 10,
      task: {
        id: "task-1", projectId: "project-1", name: "Archived retry", description: "retry",
        assigneeType: "AGENT", assigneeAgentId: "agent-1",
        assigneeAgent: { id: "agent-1", name: "Archived Retry Agent", archivedAt },
        repoId: "repo-1", chainId: null, chainIndex: null,
        templateId: null, templateStep: null, repo: null, targetBranch: "main", opensPullRequest: true,
        maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 3,
        status: "DOING", archivedAt: null, templateStepId: null,
      }, session: { id: "session-1" },
    };
    const tx = {
      $queryRaw: async () => [{ id: "task-1", archivedAt: null }],
      run: {
        findFirst: async () => run,
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { closed = data; return { count: 1 }; },
        create: async ({ data }: { data: Record<string, unknown> }) => { retry = data; return { id: "run-4", ...data }; },
      },
      agent: { findUnique: async () => run.task.assigneeAgent },
      session: { update: async () => ({}) },
      task: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { taskWrites.push(data); return { count: 1 }; },
        findUnique: async () => ({
          ...run.task,
          runs: [{ ...run, task: undefined, session: undefined, maxRunsPerTask: 4, budgetGrants: 1 }],
        }),
        findUniqueOrThrow: async () => run.task,
      },
      taskActivity: { create: async () => ({}) },
      runnerBackendState: { upsert: async () => ({ consecutiveAuthFailures: 0 }), update: async () => ({}) },
      inboxMessage: { create: async ({ data }: { data: Record<string, unknown> }) => { inbox.push(data); return {}; } },
    };
    const database = {
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation(tx),
      // The completion route reads the run's step binding before the
      // transaction, to bind a mechanical completion to the merge-executor
      // principal (§D-P1 rule 3). An ordinary run has no template step.
      run: { findFirst: async () => null, findUnique: async () => ({ runnerId: "runner-1", task: { templateStep: null } }) },
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
    assert.equal(retry, undefined);
    assert.match(String(taskWrites.at(-1)?.failureReason), /Automatic retry refused.*Archived Retry Agent/);
    assert.match(String(inbox.at(-1)?.body), /Automatic retry refused.*Archived Retry Agent/);
    assert.deepEqual(await response.json(), {
      taskId: "task-1",
      succeeded: false,
      retryCreated: false,
      failureClass: "TRANSIENT_PROVIDER",
      releaseMergeLeaseTask: null,
    });
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
    { id: "run-live", heartbeatAt: new Date(now.getTime() - 30_000), stallTimeoutMin: 10, taskId: "task-1", runNumber: 1, maxRunsPerTask: 3, cancelRequestId: null, cancelReason: null, cancelRequestedAt: null },
    // Silent for 20 minutes: really gone.
    { id: "run-dead", heartbeatAt: new Date(now.getTime() - 20 * 60_000), stallTimeoutMin: 10, taskId: "task-2", runNumber: 1, maxRunsPerTask: 3, cancelRequestId: null, cancelReason: null, cancelRequestedAt: null },
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
      $queryRaw: async () => [{ id: "task-2", archivedAt: null }],
      run: {
        findFirst: async () => ({ cancelRequestId: null, cancelReason: null, cancelRequestedAt: null }),
        updateMany: async ({ where }: { where: { id: string } }) => { lost.push(where.id); return { count: 1 }; },
        create: async () => ({}),
      },
      session: { updateMany: async () => ({}) },
      // The requeue loads the task to decide whether to recompute a chain
      // step's branches; a null row keeps the lost run's fields verbatim.
      task: {
        update: async () => ({}),
        findUnique: async () => null,
        findUniqueOrThrow: async () => ({ id: "task-2", archivedAt: null }),
      },
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
  const database = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      // Retry takes the shared task-row lock before it reads anything else.
      $queryRaw: async () => [{ id: "task-1" }],
      agent: { findUnique: async () => lockedAgent(assigneeAgent as Record<string, unknown> | null) },
      task: {
        findUniqueOrThrow: async () => ({ id: "task-1", status: "TODO", archivedAt: null }),
        findUnique: async () => ({
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
          assigneeAgent,
          templateStep: currentTemplateStep,
          runs: [last],
        }),
        update: async () => ({}),
      },
      run: {
        count: async () => 0,
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

test("operator retry re-derives runtime configuration and clears promptHash until dispatch", async () => {
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
    assert.equal(created?.promptHash, null);
    assert.equal(created?.branch, last.branch);
    assert.equal(created?.targetBranch, last.targetBranch);
    assert.equal(created?.maxRunsPerTask, last.maxRunsPerTask);
  });
});

test("operator retry with unchanged agent preserves runtime config but not a prior dispatch hash", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
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
      promptHash: null,
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

test("operator retry refuses a compound implementation Step assigned to a non-executioner Agent", async () => {
  await withTokens(async () => {
    const { response, created } = await retryRequest({
      id: "agent-1",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
      name: "senior-dev",
    }, {
      runner: RunnerKind.CODEX,
      stepIndex: 5,
      outputKind: "implementation",
      taskTemplate: { name: "compound-engineer-workflow" },
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Compound implementation step must remain assigned to the active in-project Agent implementation-plan-executioner",
      code: "COMPOUND_IMPLEMENTATION_ASSIGNEE_INVALID",
    });
    assert.equal(created, undefined);
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
    const agentRow = () => ({ id: "agent-1", name: "Agent", archivedAt });
    const agentClient = {
      findUnique: async () => agentRow(),
      findUniqueOrThrow: async () => agentRow(),
      update: async ({ data }: { data: { archivedAt: Date | null } }) => {
        archivedAt = data.archivedAt;
        updates.push(archivedAt);
        return agentRow();
      },
    };
    const database = {
      agent: agentClient,
      // Archive now runs under the Agent-row mutex and fails closed on live
      // references, so the transaction client answers the lock and both
      // reference reads. Nothing is queued or in flight here.
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "agent-1", archivedAt }],
        agent: agentClient,
        // The completion route reads the run's step binding before the
      // transaction, to bind a mechanical completion to the merge-executor
      // principal (§D-P1 rule 3). An ordinary run has no template step.
      run: { findFirst: async () => null, findUnique: async () => ({ runnerId: "runner-1", task: { templateStep: null } }) },
        task: { findFirst: async () => null },
      }),
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

test("archiving an agent fails closed on a live run or any live task", async () => {
  await withTokens(async () => {
    // Both references are the same defect one step apart: a run queued for an
    // archived agent is filtered out of every claim, so it never runs and its
    // task never completes. Refusing the archive keeps the operator's options.
    // A task reference does not need a run to be live — TODO and REVIEW rows
    // are exactly the ones no run exists for yet, and archiving under them is
    // what strands the step that would have created it.
    const cases = [
      {
        run: { runNumber: 2, status: "QUEUED", task: { name: "Ship it" } },
        task: null,
        expected: "Cannot archive an agent with a QUEUED run on Ship it; finish or cancel run 2 first",
      },
      {
        run: null,
        task: { name: "Ship it", status: "DOING" },
        expected: "Cannot archive an agent assigned to DOING task Ship it; finish, park, archive, or reassign that task first",
      },
      {
        run: null,
        task: { name: "Tomorrow's sweep", status: "TODO" },
        expected: "Cannot archive an agent assigned to TODO task Tomorrow's sweep; finish, park, archive, or reassign that task first",
      },
      {
        run: null,
        task: { name: "Awaiting the gate", status: "REVIEW" },
        expected: "Cannot archive an agent assigned to REVIEW task Awaiting the gate; finish, park, archive, or reassign that task first",
      },
    ];
    for (const { run, task, expected } of cases) {
      let updates = 0;
      const database = {
        agent: {
          findUniqueOrThrow: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
          update: async () => { updates += 1; return {}; },
        },
        $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
          $queryRaw: async () => [{ id: "agent-1", archivedAt: null }],
          agent: {
            findUnique: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
            findUniqueOrThrow: async () => ({ id: "agent-1", name: "Agent", archivedAt: null }),
            update: async () => { updates += 1; return {}; },
          },
          run: { findFirst: async () => run },
          task: { findFirst: async () => task },
        }),
      } as unknown as PrismaClient;
      const response = await createApp(database).request("/agents/agent-1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token" },
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: expected });
      assert.equal(updates, 0, "a refused archive writes nothing");
    }
  });
});

test("a task creation that loses the Agent-row race writes neither task nor run", async () => {
  await withTokens(async () => {
    // The unlocked check above the transaction sees a live agent; the archive
    // commits; the locked re-read inside the transaction is what decides.
    let taskCreates = 0;
    const database = {
      agent: { findFirst: async () => ({ id: "agent-1", name: "Agent", archivedAt: null, runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
      repo: { findFirst: async () => ({ id: "repo-1", defaultBranch: "main" }) },
      agentRepoAccess: { findFirst: async () => ({}) },
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [{ id: "agent-1", archivedAt: new Date() }],
        agent: { findUnique: async () => lockedAgent({ id: "agent-1", name: "Agent", archivedAt: new Date(), runnerPreference: "CLAUDE", model: "claude", foundationalPrompt: "f", rolePrompt: "r" }) },
        task: { create: async () => { taskCreates += 1; return { id: "task-1" }; } },
        taskActivity: { create: async () => ({}) },
        run: { create: async () => { throw new Error("must not create run"); } },
      }),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Race", description: "race", assigneeAgentId: "agent-1", repoId: "repo-1" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Assignee Agent is archived" });
    assert.equal(taskCreates, 0);
  });
});

test("archive and unarchive return 404 for a missing agent", async () => {
  await withTokens(async () => {
    const database = {
      agent: { findUnique: async () => null },
      // No row to lock is the archive route's 404.
      $transaction: async (operation: (value: unknown) => Promise<unknown>) => operation({
        $queryRaw: async () => [],
      }),
    } as unknown as PrismaClient;
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

test("Agent API refuses Fast for a non-Codex model", async () => {
  await withTokens(async () => {
    const response = await createApp({} as PrismaClient).request("/projects/project-1/agents", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        environmentId: "environment-1",
        name: "claude-fast",
        title: "Claude Fast",
        model: "claude-opus-5:medium",
        rolePrompt: "work",
        runnerPreference: "CLAUDE",
        codexServiceTier: "FAST",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Fast service tier requires a Codex gpt-* model or a PI openai-codex/* model",
    });
  });
});

test("Agent API refuses an executioner rename", async () => {
  await withTokens(async () => {
    let updated = false;
    const executioner = lockedAgent({
      id: "agent-executioner",
      projectId: "project-1",
      environmentId: "environment-1",
      name: "implementation-plan-executioner",
      title: "Implementation Plan Executioner",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    });
    const tx = {
      $queryRaw: async () => [{ id: executioner!.id }],
      agent: {
        findUnique: async () => executioner,
        update: async () => { updated = true; return executioner; },
      },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request(`/agents/${executioner!.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed-executioner" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "implementation-plan-executioner is a canonical Agent name and cannot be changed",
    });
    assert.equal(updated, false);
  });
});

test("Agent API refuses a non-Codex executioner runtime", async () => {
  await withTokens(async () => {
    let updated = false;
    const executioner = lockedAgent({
      id: "agent-executioner",
      projectId: "project-1",
      environmentId: "environment-1",
      name: "implementation-plan-executioner",
      title: "Implementation Plan Executioner",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    });
    const tx = {
      $queryRaw: async () => [{ id: executioner!.id }],
      agent: {
        findUnique: async () => executioner,
        update: async () => { updated = true; return executioner; },
      },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request(`/agents/${executioner!.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5:medium", runnerPreference: RunnerPreference.CLAUDE }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "implementation-plan-executioner requires a Codex gpt-* model",
    });
    assert.equal(updated, false);
  });
});

test("Agent API does not mark unchanged runtime fields as an operator override", async () => {
  await withTokens(async () => {
    let updateData: Record<string, unknown> | null = null;
    const executioner = lockedAgent({
      id: "agent-executioner",
      projectId: "project-1",
      environmentId: "environment-1",
      name: "implementation-plan-executioner",
      title: "Implementation Plan Executioner",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
      runtimeConfigCustomized: false,
    });
    const tx = {
      $queryRaw: async () => [{ id: executioner!.id }],
      agent: {
        findUnique: async () => executioner,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updateData = data;
          return { ...executioner, ...data };
        },
      },
    };
    const database = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request(`/agents/${executioner!.id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Renamed title",
        model: executioner!.model,
        runnerPreference: executioner!.runnerPreference,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(updateData, {
      title: "Renamed title",
      model: "gpt-5.6-sol:high",
      runnerPreference: RunnerPreference.CODEX,
    });
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
      body: JSON.stringify({ repoId: "repo-1", variables: {}, autoStart: false }),
    });
    assert.equal(response.status, 400);
    assert.match(String((await response.json() as { error: string }).error), /Implementation.*Archived Ada.*archived/);
  });
});

test("template instantiate route rejects blank variables and invalid Git refs before database access", async () => {
  await withTokens(async () => {
    const database = new Proxy({}, {
      get: () => { throw new Error("database must not be read for invalid input"); },
    }) as unknown as PrismaClient;
    const cases = [
      { branchName: "" },
      { branchName: "   " },
      { branchName: "bad..branch" },
      { branchName: "refs/heads/main" },
      { branchName: "feature/.hidden" },
      { branchName: "feature/main.lock" },
      { branchName: "bad\nbranch" },
    ];
    for (const variables of cases) {
      const response = await createApp(database).request("/projects/project-1/task-templates/template-1/instantiate", {
        method: "POST",
        headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: "repo-1", variables, autoStart: false }),
      });
      assert.equal(response.status, 400, JSON.stringify(variables));
    }
  });
});

test("claim query filters archived agents before take so active work cannot starve", async () => {
  await withTokens(async () => {
    const completePriorOutput = `schema-start\n${"x".repeat(50_000)}\nstate-machine-end`;
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
      task: {
        id: `task-${id}`, status: "TODO",
        chainId: archivedAt ? null : "chain-1", chainIndex: archivedAt ? null : 1,
        templateStep: null,
      },
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
      $queryRaw: async () => [{ granted: true }],
      // The claim loop brackets every candidate in a savepoint.
      $executeRawUnsafe: async () => 0,
      run: {
        findMany: async ({ where, take }: { where: Record<string, any>; take: number }) => {
          claimWhere = where;
          const filtered = where.agent
            ? seeded.filter((run) => run.agent.archivedAt === where.agent.archivedAt)
            : seeded;
          return filtered.slice(0, take);
        },
        updateMany: async ({ where }: { where: { id: string } }) => { claimedId = where.id; return { count: 1 }; },
        findFirst: async () => null,
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id, status: RunStatus.CLAIMED }),
      },
      runnerBackendState: { findUnique: async () => null },
      session: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "session-1", ...data }) },
      sessionEvent: { aggregate: async () => ({ _max: { seq: null } }) },
      task: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const found = seeded.find((entry) => entry.task.id === where.id)?.task;
          return found ? { ...found, projectId: "project-1", archivedAt: null, assigneeAgentId: null } : null;
        },
        update: async () => ({}),
      },
      taskActivity: { create: async () => ({}) },
      taskStepOutput: { findMany: async () => [{
        kind: "spec", body: completePriorOutput,
        task: { name: "Approved specification", chainIndex: 0 },
      }] },
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
    const claim = await response.json() as { priorOutputs: Array<{ body: string }> };
    assert.deepEqual(claimWhere?.agent, { archivedAt: null });
    assert.equal(claimedId, "active");
    assert.equal(claim.priorOutputs[0]?.body, completePriorOutput);
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
        $queryRaw: async () => [{ granted: true }],
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
        projectId: "project-1",
        name: "Archived Successor",
        chainId: "chain-1",
        chainIndex: 2,
        chainLayer: 2,
        status: "TODO",
        assigneeType: "AGENT",
        assigneeAgentId: "agent-2",
        repoId: "repo-1",
        templateId: "template-1",
        templateStepId: null,
        approvalGate: false,
        archivedAt: null,
        failureReason: null,
        updatedAt: new Date(),
        runs: [],
        assigneeAgent: { id: "agent-2", name: "Archived Successor", archivedAt: new Date() },
      };
      const predecessor = {
        id: "task-1",
        projectId: "project-1",
        name: "Predecessor",
        templateId: "template-1",
        chainId: "chain-1",
        chainIndex: 1,
        chainLayer: 1,
        status: "DOING",
        approvalGate: false,
        archivedAt: null,
        assigneeType: "AGENT",
        assigneeAgentId: "agent-1",
        repoId: "repo-1",
        templateStepId: null,
        failureReason: null,
      };
      const run = {
        id: "run-1", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1",
        repoId: "repo-1", runNumber: 1, maxRunsPerTask: 3, runner: RunnerKind.CLAUDE,
        model: "model", targetBranch: "main", branch: "feature/chain", baseSha: "base",
        promptHash: "hash", maxDurationMin: 120, stallTimeoutMin: 10,
        task: {
          ...predecessor,
          templateStep: { outputKind: "result" },
          repo: { defaultBranch: "main" },
        },
        session: { id: "session-1" },
      };
      const tx = {
        $queryRaw: async () => [{ id: "locked" }],
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
          findUniqueOrThrow: async () => predecessor,
          findUnique: async () => successor,
          findMany: async () => [predecessor, successor],
          updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            if (where.id === predecessor.id && typeof data.status === "string") predecessor.status = data.status;
            return { count: 1 };
          },
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
        // The completion route's pre-transaction principal binding read.
        run: { findMany: async () => [], findUnique: async () => ({ runnerId: "runner-1", task: { templateStep: null } }) },
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
        chainId: "chain-1",
        chainIndex: decision === "approve" ? 2 : 1,
        chainLayer: decision === "approve" ? 2 : 1,
        status: "TODO",
        assigneeType: "AGENT",
        assigneeAgentId: "agent-archived",
        repoId: "repo-1",
        templateId: "template-1",
        templateStepId: null,
        targetBranch: "main",
        updatedAt: new Date(),
        maxDurationMin: 120,
        stallTimeoutMin: 10,
        maxSessionsPerTask: 3,
        approvalGate: false,
        archivedAt: null,
        failureReason: null,
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
        projectId: "project-1",
        name: "Gate",
        chainId: "chain-1",
        chainIndex: 1,
        chainLayer: 1,
        status: "REVIEW",
        archivedAt: null,
        approvalGate: true,
        assigneeType: "AGENT",
        assigneeAgentId: "agent-archived",
        repoId: "repo-1",
        templateId: "template-1",
        templateStepId: null,
        templateStep: null,
        runs: [],
        assigneeAgent: executable.assigneeAgent,
      };
      const tx = {
        // The reject path locks the redo row before queueing it. This task is
        // unarchived — the archived *assignee* is what must produce the 409.
        $queryRaw: async (_strings: unknown, taskId: string) => [{ id: taskId, archivedAt: null }],
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
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            if (where.id === gateTask.id && typeof data.status === "string") gateTask.status = data.status;
            return {};
          },
          findUniqueOrThrow: async () => executable,
          // Both approval and rejection resolve the target through the real
          // layered chain rows; no linked-list relation is available.
          findUnique: async () => executable,
          findFirst: async () => null,
          findMany: async () => decision === "approve" ? [gateTask, executable] : [],
          updateMany: async () => ({ count: 1 }),
        },
        taskActivity: { create: async () => ({}) },
        agent: { findUnique: async () => lockedAgent(executable.assigneeAgent) },
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
 *  Values are the captured shape from `spikes/cli-capabilities/samples/`.
 *
 *  It stays trimmed ON PURPOSE, and specifically it carries no `modelUsage`:
 *  these three tests are what keep `extractUsage`'s top-level snake_case
 *  fallback branch covered — the branch CODEX and PI always take. The complete
 *  captures, `modelUsage` included, live in `usage.test.ts`. */
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
): PrismaClient => {
  const database: Record<string, unknown> = {
    // `recomputeSessionUsage` now opens one interactive transaction and takes an
    // advisory lock inside it. These three answer that scaffolding inertly; the
    // lock itself is proven against a real PostgreSQL in `usage.dbtest.ts`.
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(database),
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
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
  };
  return database as unknown as PrismaClient;
};

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

test("event ingestion makes literal NULs visible without changing seq order", async () => {
  await withTokens(async () => {
    const nul = "\u0000";
    const visibleNul = "\\u0000";
    const stored: Array<Record<string, unknown>> = [];
    const database = {
      $queryRaw: async () => [{ id: "run-1" }],
      run: {
        findFirst: async () => ({ session: { id: "ses-1", providerConversationId: null } }),
      },
      sessionEvent: {
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          stored.push(...data);
          return { count: data.length };
        },
        findMany: async (): Promise<Array<Record<string, unknown>>> => {
          const rows = stored.map((event, index) => ({ id: `event-${index}`, ...event })) as Array<Record<string, unknown>>;
          rows.sort((left, right) => Number(left.seq) - Number(right.seq));
          return rows;
        },
        count: async () => stored.length,
      },
    } as Record<string, unknown>;
    database.$transaction = async (operation: (tx: unknown) => Promise<unknown>) => operation(database);
    const app = createApp(database as unknown as PrismaClient);
    const response = await app.request("/runner/runs/run-1/events", {
      method: "POST",
      headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "runner-1",
        fencingToken: "1:run-1:current",
        events: [
          {
            seq: 4,
            source: "CLAUDE",
            type: `EVENT${nul}TYPE`,
            providerEventId: `provider${nul}id`,
            toolCallId: `tool${nul}id`,
            payload: {
              unchanged: "plain text",
              nested: { message: `left${nul}right`, list: [`a${nul}b`, { deep: "value" }] },
              [`field${visibleNul}`]: "literal key value",
              [`field${nul}`]: "NUL key value",
              [`key${nul}`]: "key value",
            },
          },
          { seq: 9, source: "CLAUDE", type: "VALID", payload: { unchanged: "still exact" } },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: 2 });

    const read = await app.request("/runs/run-1/events", {
      headers: { Authorization: "Bearer operator-unit-token" },
    });
    assert.equal(read.status, 200);
    const body = await read.json() as { events: Array<Record<string, any>>; total: number };
    assert.deepEqual(body.events.map((event) => event.seq), [4, 9]);
    assert.equal(body.total, 2);
    assert.equal(body.events[0]?.type, `EVENT${visibleNul}TYPE`);
    assert.equal(body.events[0]?.providerEventId, `provider${visibleNul}id`);
    assert.equal(body.events[0]?.toolCallId, `tool${visibleNul}id`);
    assert.deepEqual(body.events[0]?.payload, {
      unchanged: "plain text",
      nested: { message: `left${visibleNul}right`, list: [`a${visibleNul}b`, { deep: "value" }] },
      [`field${visibleNul}`]: "literal key value",
      [`field${visibleNul}${visibleNul}`]: "NUL key value",
      [`key${visibleNul}`]: "key value",
    });
    assert.deepEqual(body.events[1]?.payload, { unchanged: "still exact" });
    assert.equal(JSON.stringify(body).includes(nul), false);
  });
});

test("partitionArchivable keeps the busy tasks out of the archive set and counts them as skipped", () => {
  assert.deepEqual(partitionArchivable(["a", "b", "c"], ["b"]), { archive: ["a", "c"], skipped: 1 });
  assert.deepEqual(partitionArchivable(["a", "b"], []), { archive: ["a", "b"], skipped: 0 });
  assert.deepEqual(partitionArchivable([], ["b"]), { archive: [], skipped: 0 });
  // A busy id that is not a candidate cannot inflate the skipped count.
  assert.deepEqual(partitionArchivable(["a"], ["z"]), { archive: ["a"], skipped: 0 });
});

/* --------------------------------------------------- GET /tasks, projected */

/** A stub with just enough of `task` for `GET /tasks` to answer: the board row
 *  page, the chain-progress page, and the recurring groupBy the full shape adds. */
/** `related` answers the by-id lookups the board makes for rows that are not on
 *  the page — a bound task's predecessor and a repair task's regression task —
 *  and `activity` the merge-tail markers that name the latter. */
const boardDatabase = (
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
    taskActivity: { findMany: async () => extras.activity ?? [] },
  } as unknown as PrismaClient;
};

const taskRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t1", projectId: "p1", name: "Ship the thing", status: "TODO", failureReason: null,
  scheduleKind: "NOW", runAt: null, cron: null, timezone: null, approvalGate: false,
  templateId: null, source: "MANUAL", chainId: null, chainIndex: null,
  createdAt: new Date("2026-08-16T00:00:00.000Z"),
  updatedAt: new Date("2026-08-16T00:00:00.000Z"), templateStep: null,
  assigneeAgent: { id: "a1", title: "Senior Developer", model: "gpt-5.6-sol:medium" },
  runs: [{
    id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5",
    session: { costUsd: "0.42", inputTokens: null, cachedInputTokens: null, outputTokens: null, startedAt: null, endedAt: null },
  }],
  ...overrides,
});

const getTasks = async (database: PrismaClient, query: string, headers: Record<string, string> = {}): Promise<Response> =>
  await createApp(database).request(`/tasks${query}`, {
    headers: { Authorization: "Bearer operator-unit-token", ...headers },
  });

test("GET /tasks?view=board answers with the card projection, not the whole row", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase([taskRow()]), "?view=board");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<Record<string, unknown>>;
    assert.equal(body.length, 1);
    // The fields the board reads survive...
    assert.equal(body[0]!.name, "Ship the thing");
    assert.equal(body[0]!.displayName, "Ship the thing");
    assert.deepEqual(body[0]!.latestRun, { id: "r1", runNumber: 1, status: "SUCCEEDED", model: "claude-opus-5", costUsd: "0.42", startedAt: null, endedAt: null });
    assert.deepEqual(body[0]!.taskCost, {
      costUsd: "0.42", estimated: false, inputTokens: null, cachedInputTokens: null, outputTokens: null,
    });
    // ...and the ones it does not are gone, which is the entire point.
    for (const dropped of ["description", "repo", "runs", "maxDurationMin", "workingDirectory"]) {
      assert.equal(dropped in body[0]!, false, `${dropped} must not ride along`);
    }
  });
});

test("the board derives a shared title and badge for API-created chains", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase([
      taskRow({ id: "build", chainId: "direct", chainIndex: 0, name: "Release: Build", templateStep: null }),
      taskRow({ id: "review", chainId: "direct", chainIndex: 1, name: "Release: Review", templateStep: null }),
    ]), "?view=board");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string; name: string; displayName: string; chainName: string | null }>;
    assert.deepEqual(body.map(({ id, name, displayName, chainName }) => ({ id, name, displayName, chainName })), [
      { id: "build", name: "Release: Build", displayName: "Build", chainName: "Release" },
      { id: "review", name: "Release: Review", displayName: "Review", chainName: "Release" },
    ]);
  });
});

test("the board binds a chain-detached repair task to the chain its marker names", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase(
      [
        taskRow({ id: "regression", chainId: "c1", chainIndex: 1, name: "Release: Regression", templateStep: { name: "Regression" } }),
        taskRow({ id: "repair", name: "Autonomous merge tail: gate-fix", templateStep: null }),
      ],
      {
        related: [{ id: "regression", projectId: "p1", chainId: "c1" }],
        activity: [{ taskId: "repair", metadata: {
          schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: "regression",
        } }],
      },
    ), "?view=board");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string; chainId: string | null; repairOf: unknown }>;
    const repair = body.find((card) => card.id === "repair")!;
    // The repair task stays chain-detached on the wire — the binding is the
    // read side's answer to where the card belongs, not a chain column.
    assert.equal(repair.chainId, null);
    assert.deepEqual(repair.repairOf, { chainId: "c1", chainName: "Release", repairKind: "gate-fix" });
    assert.equal(body.find((card) => card.id === "regression")!.repairOf, null);
  });
});

test("a global board keeps two projects' same-named chains apart when it binds their repairs", async () => {
  await withTokens(async () => {
    // `chainId` is unique per project, not globally, so a board that spans
    // projects can hold the same one twice. A repair card must be named by its
    // own project's chain, not by whichever came first on the page.
    const response = await getTasks(boardDatabase(
      [
        taskRow({ id: "regression-1", chainId: "c1", chainIndex: 1, name: "Release: Regression", templateStep: { name: "Regression" } }),
        taskRow({ id: "repair-1", name: "Autonomous merge tail: gate-fix", templateStep: null }),
        taskRow({ id: "regression-2", projectId: "p2", chainId: "c1", chainIndex: 1, name: "Hotfix: Regression", templateStep: { name: "Regression" } }),
        taskRow({ id: "repair-2", projectId: "p2", name: "Autonomous merge tail: review-fix", templateStep: null }),
      ],
      {
        related: [
          { id: "regression-1", projectId: "p1", chainId: "c1" },
          { id: "regression-2", projectId: "p2", chainId: "c1" },
        ],
        activity: [
          { taskId: "repair-1", metadata: {
            schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "gate-fix", regressionTaskId: "regression-1",
          } },
          { taskId: "repair-2", metadata: {
            schemaVersion: 1, kind: "mergeTail.repairAttempt", repairKind: "review-fix", regressionTaskId: "regression-2",
          } },
        ],
      },
    ), "?view=board");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string; repairOf: unknown }>;
    assert.deepEqual(body.find((card) => card.id === "repair-1")!.repairOf, {
      chainId: "c1", chainName: "Release", repairKind: "gate-fix",
    });
    assert.deepEqual(body.find((card) => card.id === "repair-2")!.repairOf, {
      chainId: "c1", chainName: "Hotfix", repairKind: "review-fix",
    });
  });
});

test("GET /tasks?enrich=false keeps creation ordering without enrichment queries", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase([
      taskRow({ id: "older", createdAt: new Date("2026-08-15T00:00:00Z") }),
      taskRow({ id: "newer", createdAt: new Date("2026-08-16T00:00:00Z") }),
    ]), "?enrich=false");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string }>;
    assert.deepEqual(body.map(({ id }) => id), ["newer", "older"]);
  });
});

test("board and full task views order by createdAt descending with a stable id tie-break", async () => {
  await withTokens(async () => {
    const rows = [
      taskRow({ id: "older-recently-updated", createdAt: new Date("2026-08-15T00:00:00Z"), updatedAt: new Date("2026-08-20T00:00:00Z") }),
      taskRow({ id: "b-tie", createdAt: new Date("2026-08-16T00:00:00Z"), updatedAt: new Date("2026-08-18T00:00:00Z") }),
      taskRow({ id: "newest", createdAt: new Date("2026-08-17T00:00:00Z"), updatedAt: new Date("2026-08-17T00:00:00Z") }),
      taskRow({ id: "a-tie", createdAt: new Date("2026-08-16T00:00:00Z"), updatedAt: new Date("2026-08-19T00:00:00Z") }),
    ];
    for (const query of ["?view=board", ""]) {
      const response = await getTasks(boardDatabase(rows), query);
      assert.equal(response.status, 200);
      const body = await response.json() as Array<{ id: string }>;
      assert.deepEqual(body.map(({ id }) => id), ["newest", "a-tie", "b-tie", "older-recently-updated"]);
    }
  });
});

test("an unknown view is refused rather than silently served as the full shape", async () => {
  await withTokens(async () => {
    const response = await getTasks(boardDatabase([]), "?view=compact");
    assert.equal(response.status, 400);
  });
});

test("GET /tasks carries a validator, and an unchanged poll costs a header exchange", async () => {
  await withTokens(async () => {
    const first = await getTasks(boardDatabase([taskRow()]), "?view=board");
    const tag = first.headers.get("etag");
    assert.ok(tag, "no ETag");
    assert.equal(first.headers.get("cache-control"), "no-cache");

    // Same rows, same bytes: 304 and an empty body instead of the payload.
    const second = await getTasks(boardDatabase([taskRow()]), "?view=board", { "If-None-Match": tag! });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), "");
    assert.equal(second.headers.get("etag"), tag);

    // One row moved: the validator changes and the payload comes back.
    const third = await getTasks(boardDatabase([taskRow({ status: "DONE" })]), "?view=board", { "If-None-Match": tag! });
    assert.equal(third.status, 200);
    assert.notEqual(third.headers.get("etag"), tag);
  });
});

test("the full shape is validated too, and its two shapes never share a tag", async () => {
  await withTokens(async () => {
    const full = await getTasks(boardDatabase([taskRow()]), "");
    assert.equal(full.status, 200);
    const body = await full.json() as Array<Record<string, unknown>>;
    assert.equal("runs" in body[0]!, true, "the full shape keeps the Run rows");
    assert.equal(body[0]!.chainProgress, null);
    const board = await getTasks(boardDatabase([taskRow()]), "?view=board");
    assert.notEqual(full.headers.get("etag"), board.headers.get("etag"));
  });
});

test("only the exact loopback browser origins are answered cross-origin", async () => {
  const app = createApp({} as PrismaClient);
  for (const origin of LOOPBACK_BROWSER_ORIGINS) {
    const response = await app.request("/", { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
  // Every other origin — including the `localhost` spelling of the same port,
  // which is a different origin to a browser and a DNS name to this process.
  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:5173.evil.example",
    "http://127.0.0.2:5173",
    "https://127.0.0.1:5173",
    "http://evil.example",
    "null",
  ]) {
    const response = await app.request("/", { headers: { Origin: origin } });
    const allowed = response.headers.get("access-control-allow-origin");
    assert.notEqual(allowed, "*", `${origin} was answered with a wildcard`);
    assert.notEqual(allowed, origin, `${origin} was allowed`);
  }
});

test("no wildcard CORS origin survives anywhere in the app", () => {
  const source = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /origin:\s*"\*"/u);
});

/**
 * Review S-2, adopted: CORS decides what a browser may *read*, and lets the
 * request run either way. So the control plane refuses a foreign `Origin`
 * itself, before authentication and before any handler — a second barrier that
 * does not depend on the dev server's proxy guard being whole (S-1 is what
 * happened when it was not).
 */
test("a request from a foreign origin is refused before it reaches a handler", async () => {
  const app = createApp(untouchableDatabase());
  for (const origin of [
    "http://evil.example",
    "https://evil.example",
    "http://localhost:5173",     // a name, not the numeric loopback
    "http://127.0.0.1:5173.evil.example",
    "http://127.0.0.2:5173",
    "https://127.0.0.1:5173",
    "http://127.0.0.1",          // no port is not an origin this server serves
    "http://127.0.0.1:99999",    // not a port
    "null",                      // an opaque origin: a sandboxed frame or a data: URL
  ]) {
    for (const path of ["/", "/health", "/version", "/tasks"]) {
      const response = await app.request(path, { method: "POST", headers: { Origin: origin } });
      assert.equal(response.status, 403, `${origin} reached ${path}`);
      assert.equal((await response.json() as { error: string }).error, "Forbidden origin");
    }
  }
});

test("a loopback origin on any port is admitted, because `vite --port` is a supported way to start the dev server", async () => {
  await withTokens(async () => {
    const app = createApp({} as PrismaClient);
    for (const origin of ["http://127.0.0.1:5173", "http://127.0.0.1:4173", "http://127.0.0.1:5199", "http://127.0.0.1:39322"]) {
      assert.equal((await app.request("/", { headers: { Origin: origin } })).status, 200, `${origin} was refused`);
      // Past the origin check and into the ordinary principal check, not past it.
      assert.equal((await app.request("/projects", { headers: { Origin: origin } })).status, 401, `${origin} was refused`);
    }
    // And a request with no Origin at all — the runner, the CLI, a local curl.
    assert.equal((await app.request("/")).status, 200);
  });
});

test("the public surface and the 401/403 boundary are unchanged by the origin allowlist", async () => {
  await withTokens(async () => {
    const app = createApp({} as PrismaClient);
    const origin = "http://127.0.0.1:5173";
    // Public routes stay public: the origin check is a boundary, not authentication.
    assert.equal((await app.request("/", { headers: { Origin: origin } })).status, 200);
    // Protected routes still answer 401 without a principal...
    assert.equal((await app.request("/projects", { headers: { Origin: origin } })).status, 401);
    // Principal separation is untouched: an operator token cannot reach a runner
    // route and a runner token cannot reach an operator route.
    const runnerRoute = await app.request("/runner/tasks/claim", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(runnerRoute.status, 403);
    const operatorRoute = await app.request("/projects", { headers: { Authorization: "Bearer runner-unit-token" } });
    assert.equal(operatorRoute.status, 403);
  });
});

/**
 * OSS-B0 Step 4 validation, at the boundary where it has to hold: everything
 * below refuses before a database is touched, which is why each case runs
 * against a client that throws if anything reaches it.
 */
const untouchableDatabase = (): PrismaClient => new Proxy({}, {
  get(_target, property) {
    throw new Error(`the database must not be reached: ${String(property)}`);
  },
}) as unknown as PrismaClient;

const onboardingBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  project: { name: "My Project", slug: "my-project" },
  repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "main", mountPath: "repo" },
  acknowledgedHostExecution: true,
  ...overrides,
});

const postOnboarding = async (database: PrismaClient, body: string): Promise<Response> =>
  createApp(database).request("/onboarding", {
    method: "POST",
    headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
    body,
  });

test("a repo remote may be a location and may never be a credential", () => {
  for (const remote of [
    "https://github.com/owner/name.git",
    "ssh://git@github.com/owner/name.git",
    "git@github.com:owner/name.git",
    "github.com:owner/name.git",
    "file:///tmp/agentos-rehearsal/origin.git",
  ]) {
    assert.deepEqual(parseRepoRemote(remote), { ok: true, remoteUrl: remote }, remote);
  }
  for (const [remote, reason] of [
    ["https://user:password@github.com/owner/name.git", "embedded-credentials"],
    ["https://ghp_exampletoken@github.com/owner/name.git", "embedded-credentials"],
    ["https://x-access-token:token@github.com/owner/name.git", "embedded-credentials"],
    ["ssh://git:secret@github.com/owner/name.git", "embedded-credentials"],
    ["https://github.com/owner/name.git?access_token=abc", "query-or-fragment"],
    ["https://github.com/owner/name.git#token", "query-or-fragment"],
    ["http://github.com/owner/name.git", "unsupported-scheme"],
    ["git://github.com/owner/name.git", "unsupported-scheme"],
    ["ext::sh -c evil", "whitespace"],
    ["https://github.com/owner/name.git\nrm -rf /", "control-characters"],
    ["https://github.com/", "missing-path"],
    ["file://host/tmp/origin.git", "missing-host"],
    ["-oProxyCommand=evil:path", "option-like"],
    ["--upload-pack=evil:path", "option-like"],
    // A token pasted where a login belongs is still a token in the column, in
    // the manifest and in `git remote -v`, whether or not SSH would accept it.
    ["ghp_exampletoken@github.com:owner/name.git", "unsupported-ssh-account"],
    ["ssh://ghp_exampletoken@github.com/owner/name.git", "unsupported-ssh-account"],
    ["ssh://x-access-token@github.com/owner/name.git", "unsupported-ssh-account"],
    ["oauth2@gitlab.com:owner/name.git", "unsupported-ssh-account"],
    // Leading and trailing, not only interior: trimming first would accept both.
    ["\nhttps://github.com/owner/name.git", "control-characters"],
    ["https://github.com/owner/name.git\t", "control-characters"],
    [" https://github.com/owner/name.git", "whitespace"],
    ["https://github.com/owner/name.git ", "whitespace"],
    [`https://github.com/${"a".repeat(4096)}`, "too-long"],
  ] as const) {
    assert.deepEqual(parseRepoRemote(remote), { ok: false, reason }, remote);
  }
});

test("the shared remote table is the one the control plane enforces", () => {
  // The browser has its own copy of this policy so a bad remote is explained
  // beside the field instead of becoming a 400 — and so a remote carrying a
  // credential never leaves the page at all. Two implementations drift unless
  // something holds them to one table: both suites read this file and compare
  // the exact reason code, not merely accepted-or-not.
  const cases = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../../scripts/fixtures/onboarding-remote-cases.json", import.meta.url)), "utf8",
  )) as {
    accepted: Array<{ description: string; value: string }>;
    rejected: Array<{ description: string; value: string; reason: string }>;
  };
  assert.ok(cases.accepted.length > 0 && cases.rejected.length > 0);
  for (const accepted of cases.accepted) {
    assert.deepEqual(parseRepoRemote(accepted.value), { ok: true, remoteUrl: accepted.value }, accepted.description);
  }
  for (const rejected of cases.rejected) {
    assert.deepEqual(parseRepoRemote(rejected.value), { ok: false, reason: rejected.reason }, rejected.description);
  }
});

test("a first-run installation mounts only at repo, and branch names stay Git-legal", () => {
  // Not "any safe relative path": plan Step 4 fixes the created shape down to
  // this one mount, so a well-formed alternative is still not an installation.
  assert.equal(isStarterMountPath("repo"), true);
  for (const mount of ["src/repo", "a.b-c_d", "/repo", "../repo", "repo/..", ".", "", "repo//app", "C:\\repo"]) {
    assert.equal(isStarterMountPath(mount), false, mount);
  }
  for (const branch of ["main", "master", "release/v0.1.0"]) assert.equal(isValidBranchName(branch), true, branch);
  for (const branch of ["-main", "main..next", "main~1", "feature/.hidden", "main.lock", "with space", "a@{0}", ""]) {
    assert.equal(isValidBranchName(branch), false, branch);
  }
});

test("onboarding input derives a missing slug and refuses one it cannot", () => {
  const derived = onboardingInput.safeParse(JSON.parse(onboardingBody({ project: { name: "My Project" } })));
  assert.equal(derived.success, true);
  assert.equal(derived.success && derived.data.project.slug, undefined);
  assert.equal(slugify("My Project"), "my-project");
  const undeclarable = onboardingInput.safeParse(JSON.parse(onboardingBody({ project: { name: "!!!" } })));
  assert.equal(undeclarable.success, false);
});

test("onboarding refuses an unacknowledged host-execution disclosure before any write", async () => {
  await withTokens(async () => {
    const response = await postOnboarding(untouchableDatabase(), onboardingBody({ acknowledgedHostExecution: false }));
    assert.equal(response.status, 400);
  });
});

test("onboarding refuses a credential-bearing remote, an illegal mount and an illegal branch before any write", async () => {
  await withTokens(async () => {
    for (const body of [
      onboardingBody({ repo: { name: "app", remoteUrl: "https://token@github.com/owner/name.git" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", mountPath: "../escape" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", mountPath: "src/repo" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "ghp_exampletoken@github.com:owner/name.git" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "\nhttps://github.com/owner/name.git" } }),
      onboardingBody({ repo: { name: "app", remoteUrl: "https://github.com/owner/name.git", defaultBranch: "bad branch" } }),
    ]) {
      const response = await postOnboarding(untouchableDatabase(), body);
      assert.equal(response.status, 400);
      const payload = await response.json() as { error: string };
      assert.equal(payload.error, "Validation failed");
      // The rejected remote is never echoed: an error body is evidence, and that
      // string is the one most likely to hold a token.
      assert.equal(JSON.stringify(payload).includes("token@github.com"), false);
    }
  });
});

test("onboarding reports a repository preflight refusal before any database write", async () => {
  await withTokens(async () => {
    const response = await createApp(untouchableDatabase(), {
      onboardingRepositoryPreflight: async () => { throw new RepositoryPreflightError("push-not-authorized"); },
    }).request("/onboarding", {
      method: "POST",
      headers: { Authorization: "Bearer operator-unit-token", "Content-Type": "application/json" },
      body: onboardingBody(),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: "Repository preflight failed",
      code: "repository-preflight-failed",
      reason: "push-not-authorized",
    });
  });
});

test("a runner principal cannot read or create an installation", async () => {
  await withTokens(async () => {
    for (const method of ["GET", "POST"]) {
      const response = await createApp(untouchableDatabase()).request("/onboarding", {
        method,
        headers: { Authorization: "Bearer runner-unit-token", "Content-Type": "application/json" },
        ...(method === "POST" ? { body: onboardingBody() } : {}),
      });
      assert.equal(response.status, 403);
    }
  });
});

test("a serialization or unique failure from a concurrent installer becomes the same stable 409", async () => {
  await withTokens(async () => {
    for (const code of ["P2034", "P2002"]) {
      const database = {
        $transaction: async () => {
          throw new Prisma.PrismaClientKnownRequestError("concurrent installation", { code, clientVersion: "6.19.0" });
        },
      } as unknown as PrismaClient;
      const response = await postOnboarding(database, onboardingBody());
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "An installation already exists", code: "existing-installation" });
    }
  });
});
