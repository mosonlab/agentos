import "../test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  RunStatus,
  RunnerKind,
  type PrismaClient,
} from "@anneal/db";

import { createApp } from "../test-app.js";
import { createApp as createLiveApp } from "../app.js";
import { withTokens } from "./test-support.js";

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

test("merge-executor start maps an omitted promptHash to null and dispatches", async () => {
  await withTokens(async () => {
    let promptHash: unknown = "not-written";
    const tx = {
      $queryRaw: async () => [{ id: "run-1" }],
      run: {
        findFirst: async () => ({ startedAt: null }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          promptHash = data.promptHash;
          return { count: 1 };
        },
      },
      session: { updateMany: async () => ({ count: 1 }) },
    };
    const database = {
      $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/runner/runs/run-1/start", {
      method: "POST",
      headers: { Authorization: "Bearer merge-executor-unit-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerId: "merge-executor-1",
        fencingToken: "1:run-1:current",
        adapterVersion: "executor-1",
        cliVersion: "executor-1",
        manifest: { executionMode: "mechanical" },
        workspacePath: null,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(promptHash, null);
  });
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
      taskActivity: { findMany: async () => [], create: async () => ({}) },
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
    });
    });
  } finally {
    if (previousRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
    else process.env.RUNNER_WORKSPACE_ROOT = previousRoot;
  }
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
        projectId: "project-1",
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
    let claimQuery: string | undefined;
    let claimedId: string | undefined;
    const tx = {
      $queryRaw: async (query: unknown) => {
        const sql = Array.isArray(query)
          ? query.join("?")
          : (query as { strings?: string[] }).strings?.join("?") ?? "";
        if (sql.includes('SELECT candidate."id"')) {
          claimQuery = sql;
          return [{ id: "active" }];
        }
        if (sql.includes('FROM "TaskActivity" AS activity')) return [];
        if (sql.includes('FROM "TaskActivity" AS deferred')) return [];
        return [{ granted: true }];
      },
      // The claim loop brackets every candidate in a savepoint.
      $executeRawUnsafe: async () => 0,
      run: {
        findMany: async ({ where }: { where: Record<string, any> }) => {
          const selectedIds = where.id?.in as string[] | undefined;
          return selectedIds ? seeded.filter((run) => selectedIds.includes(run.id)) : [];
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
      taskActivity: { findMany: async () => [], create: async () => ({}) },
      mergeLeaseEvent: { findMany: async () => [] },
      taskStepOutput: { findMany: async () => [{
        kind: "spec", body: completePriorOutput,
        task: { name: "Approved specification", chainIndex: 0 },
      }] },
    };
    const database = {
      run: { findMany: async () => [] },
      chainControl: { findUnique: async () => null },
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
    assert.ok(claimQuery);
    assert.ok(claimQuery.includes('agent."archivedAt" IS NULL'));
    assert.ok(claimQuery.indexOf('agent."archivedAt" IS NULL') < claimQuery.indexOf("LIMIT 20"));
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
        $queryRaw: async (query: unknown) => {
          const sql = Array.isArray(query)
            ? query.join("?")
            : (query as { strings?: string[] }).strings?.join("?") ?? "";
          if (sql.includes('SELECT candidate."id"')) return [];
          if (sql.includes('FROM "TaskActivity" AS activity')) return [];
          if (sql.includes('FROM "TaskActivity" AS deferred')) return [];
          return [{ granted: true }];
        },
        run: { findMany: async () => [] },
        taskActivity: { findMany: async () => [] },
        mergeLeaseEvent: { findMany: async () => [] },
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
        repo: { id: "repo-1", name: "Repo", defaultBranch: "main" },
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
          findMany: async () => [],
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (data.taskId === successor.id) successorActivity = data;
            return {};
          },
        },
        agent: { findUnique: async () => successor.assigneeAgent },
        chainControl: { findMany: async () => [] },
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
      assert.match(String(successorUpdate?.failureReason), /archived/i);
      assert.equal(successorActivity?.taskId, successor.id);
      assert.equal(successorActivity?.actorType, "control-plane");
      assert.match(String(successorActivity?.body), /predecessor.*complet/i);
      assert.match(String(successorActivity?.body), /Archived Successor/);
      assert.match(String(successorActivity?.body), /archived/i);
    } finally {
      if (previousRoot === undefined) delete process.env.RUNNER_WORKSPACE_ROOT;
      else process.env.RUNNER_WORKSPACE_ROOT = previousRoot;
    }
  });
});
