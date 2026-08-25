import "./test-workspace-root.js";
import assert from "node:assert/strict";
import test from "node:test";

import { RunStatus, RunnerKind, type PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
import { createRunnerRegistry, RUNNER_MAX_ENTRIES } from "./runners.js";

test("runner online windows use the 30s floor and three poll intervals", () => {
  const registry = createRunnerRegistry();
  const start = new Date("2026-08-17T00:00:00.000Z");
  registry.note("fast", { pollIntervalMs: 5_000 }, start);
  registry.note("slow", { pollIntervalMs: 20_000 }, start);
  assert.equal(registry.snapshot(new Date(start.getTime() + 29_000)).find((row) => row.runnerId === "fast")?.online, true);
  assert.equal(registry.snapshot(new Date(start.getTime() + 31_000)).find((row) => row.runnerId === "fast")?.online, false);
  assert.equal(registry.snapshot(new Date(start.getTime() + 59_000)).find((row) => row.runnerId === "slow")?.online, true);
  assert.equal(registry.snapshot(new Date(start.getTime() + 61_000)).find((row) => row.runnerId === "slow")?.online, false);
});

test("runner observations replace omitted telemetry", () => {
  const registry = createRunnerRegistry();
  const now = new Date("2026-08-17T00:00:00.000Z");
  registry.note("runner-a", { daemonVersion: "1.0.0", diskFreeBytes: 42, pollIntervalMs: 5_000, workspaceRoot: "/tmp" }, now);
  registry.note("runner-a", {}, new Date(now.getTime() + 1_000));
  assert.deepEqual(registry.snapshot(new Date(now.getTime() + 2_000))[0], {
    runnerId: "runner-a", lastSeenAt: new Date(now.getTime() + 1_000), online: true,
    daemonVersion: null, diskFreeBytes: null, pollIntervalMs: null, workspaceRoot: null,
  });
});

test("stale incarnations retire and the registry cap keeps the newest entries", () => {
  const registry = createRunnerRegistry();
  const start = new Date("2026-08-17T00:00:00.000Z");
  registry.note("host-1", {}, start);
  registry.note("host-2", {}, new Date(start.getTime() + 16 * 60_000));
  registry.note("host-3", {}, new Date(start.getTime() + 32 * 60_000));
  assert.deepEqual(registry.snapshot(new Date(start.getTime() + 32 * 60_000)).map((row) => row.runnerId), ["host-3"]);

  const capped = createRunnerRegistry();
  for (let index = 0; index < 20; index += 1) capped.note(`runner-${String(index).padStart(2, "0")}`, {}, new Date(start.getTime() + index));
  const kept = capped.snapshot(new Date(start.getTime() + 20));
  assert.equal(kept.length, RUNNER_MAX_ENTRIES);
  assert.deepEqual(kept.map((row) => row.runnerId), Array.from({ length: 16 }, (_, index) => `runner-${String(index + 4).padStart(2, "0")}`));

  const concurrent = createRunnerRegistry();
  for (let index = 1; index <= 3; index += 1) concurrent.note(`host-${index}`, {}, new Date(start.getTime() + index * 10_000));
  assert.equal(concurrent.snapshot(new Date(start.getTime() + 60_000)).length, 3);
});

const withTokens = async (operation: () => Promise<void>): Promise<void> => {
  const operator = process.env.OPERATOR_TOKEN;
  const runner = process.env.RUNNER_TOKEN;
  process.env.OPERATOR_TOKEN = "runners-test-operator";
  process.env.RUNNER_TOKEN = "runners-test-runner";
  try { await operation(); } finally {
    if (operator === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = operator;
    if (runner === undefined) delete process.env.RUNNER_TOKEN; else process.env.RUNNER_TOKEN = runner;
  }
};

const makeDatabase = (
  candidates: Record<string, unknown>[] = [],
  barrierGranted = true,
  onCandidateRead: () => void = () => undefined,
): PrismaClient => {
  const tx = {
    $queryRaw: async () => [{ granted: barrierGranted }],
    run: {
      findMany: async () => { onCandidateRead(); return candidates; },
      findFirst: async () => null,
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ id: where.id, status: RunStatus.CLAIMED }),
    },
    runnerBackendState: { findUnique: async () => null },
    session: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "session-1", ...data }) },
    sessionEvent: { aggregate: async () => ({ _max: { seq: null } }) },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = candidates.find((candidate) => (candidate.task as { id?: string } | undefined)?.id === where.id);
        const task = found?.task as { id: string; chainId: string | null; status?: string } | undefined;
        return task ? {
          ...task,
          projectId: "project-1",
          archivedAt: null,
          assigneeAgentId: null,
          status: task.status ?? "TODO",
        } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const found = candidates.find((candidate) => (candidate.task as { id?: string } | undefined)?.id === where.id);
        const task = found?.task as { id: string; chainId: string | null; status?: string } | undefined;
        if (!task) throw new Error(`Task ${where.id} not found`);
        return {
          ...task,
          projectId: "project-1",
          archivedAt: null,
          assigneeAgentId: null,
          status: task.status ?? "TODO",
        };
      },
      update: async () => ({}),
    },
    taskActivity: { create: async () => ({}) },
    taskStepOutput: { findMany: async () => [] },
  };
  return {
    run: {
      findMany: async () => [],
      groupBy: async ({ where }: { where: { status: { in: RunStatus[] } } }) => {
        assert.deepEqual(where.status.in, [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX]);
        assert.ok(!(where.status.in as RunStatus[]).includes(RunStatus.QUEUED));
        return [{ runnerId: "runner-a", _count: { _all: 1 } }];
      },
    },
    runnerBackendState: { findMany: async () => [{ runner: RunnerKind.CLAUDE, cliVersion: "1.2.3", authMode: "subscription", lastPreflightAt: new Date(), lastPreflightOk: true, circuitOpen: false, circuitReason: null }] },
    taskActivity: { createMany: async () => ({ count: 0 }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
};

test("deploy barrier refuses claims before candidate reads", async () => {
  await withTokens(async () => {
    let candidateRead = false;
    const database = makeDatabase([], false, () => { candidateRead = true; });
    assert.equal((await runnerRequest(createApp(database), {})).status, 204);
    assert.equal(candidateRead, false);
  });
});

const runnerRequest = async (app: ReturnType<typeof createApp>, body: Record<string, unknown>): Promise<Response> => app.request("/runner/tasks/claim", {
  method: "POST",
  headers: { Authorization: "Bearer runners-test-runner", "Content-Type": "application/json" },
  body: JSON.stringify({ runnerId: "runner-a", leaseSeconds: 60, ...body }),
});

test("GET /runners is operator-only, includes all backends, and ages a 204 claim", async () => {
  await withTokens(async () => {
    const app = createApp(makeDatabase());
    assert.equal((await app.request("/runners")).status, 401);
    assert.equal((await app.request("/runners", { headers: { Authorization: "Bearer runners-test-runner" } })).status, 403);
    assert.equal((await runnerRequest(app, {})).status, 204);
    const response = await app.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { checkedAt: string; online: number; total: number; daemons: Array<{ busy: boolean; activeRuns: number }>; backends: Array<{ runner: RunnerKind; cliVersion: string | null }> };
    assert.ok(Date.parse(body.checkedAt));
    assert.equal(body.online, 1);
    assert.equal(body.total, 1);
    assert.deepEqual(body.daemons.map(({ busy, activeRuns }) => ({ busy, activeRuns })), [{ busy: true, activeRuns: 1 }]);
    assert.deepEqual(body.backends.map((backend) => backend.runner).sort(), Object.values(RunnerKind).sort());
    assert.equal(body.backends.find((backend) => backend.runner === RunnerKind.CLAUDE)?.cliVersion, "1.2.3");
    assert.equal(body.backends.find((backend) => backend.runner === RunnerKind.CODEX)?.cliVersion, null);
  });
});

test("two runner observations can share one reported API workspace root", async () => {
  await withTokens(async () => {
    const app = createApp(makeDatabase());
    const workspaceRoot = "/isolated/shared-runner-root";
    assert.equal((await runnerRequest(app, { runnerId: "runner-a", workspaceRoot })).status, 204);
    assert.equal((await runnerRequest(app, { runnerId: "runner-b", workspaceRoot })).status, 204);
    const response = await app.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const body = await response.json() as { total: number; daemons: Array<{ runnerId: string; workspaceRoot: string | null }> };
    assert.equal(body.total, 2);
    assert.deepEqual(body.daemons.map(({ runnerId, workspaceRoot: root }) => ({ runnerId, root })), [
      { runnerId: "runner-a", root: workspaceRoot },
      { runnerId: "runner-b", root: workspaceRoot },
    ]);
  });
});

test("invalid optional telemetry cannot block empty or successful claims", async () => {
  await withTokens(async () => {
    const emptyApp = createApp(makeDatabase());
    assert.equal((await runnerRequest(emptyApp, { diskFreeBytes: -1 })).status, 204);
    assert.equal((await runnerRequest(emptyApp, { runnerId: "" })).status, 400);
    const emptyStatus = await emptyApp.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const emptyBody = await emptyStatus.json() as { daemons: Array<{ diskFreeBytes: number | null }> };
    assert.equal(emptyBody.daemons[0]?.diskFreeBytes, null);

    const candidate = {
      id: "run-1", projectId: "project-1", taskId: "task-1", goalId: null, agentId: "agent-1", repoId: "repo-1",
      runner: RunnerKind.CLAUDE, runNumber: 1, leaseGeneration: 0, maxDurationMin: 120, session: null,
      task: { id: "task-1", chainId: null, chainIndex: null, templateStep: null }, repo: { id: "repo-1" },
      agent: { id: "agent-1", repoAccess: [{ repoId: "repo-1", projectId: "project-1" }], environment: { secrets: [] }, secretGrants: [] },
    };
    const claimedApp = createApp(makeDatabase([candidate]));
    const claimed = await runnerRequest(claimedApp, { diskFreeBytes: -1, daemonVersion: "0.0.0", pollIntervalMs: 5_000, workspaceRoot: "/tmp/runs" });
    assert.equal(claimed.status, 200);
    const claimedStatus = await claimedApp.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const claimedBody = await claimedStatus.json() as { daemons: Array<{ diskFreeBytes: number | null; daemonVersion: string | null; workspaceRoot: string | null }> };
    assert.deepEqual(claimedBody.daemons.map(({ diskFreeBytes, daemonVersion, workspaceRoot }) => ({ diskFreeBytes, daemonVersion, workspaceRoot })), [
      { diskFreeBytes: null, daemonVersion: "0.0.0", workspaceRoot: "/tmp/runs" },
    ]);
  });
});

test("a stale heartbeat still records that the daemon is alive", async () => {
  await withTokens(async () => {
    const database = makeDatabase() as unknown as { run: Record<string, unknown> };
    database.run = { ...database.run, updateMany: async () => ({ count: 0 }), findFirst: async () => null };
    const app = createApp(database as unknown as PrismaClient);
    const response = await app.request("/runner/runs/run-1/heartbeat", {
      method: "POST", headers: { Authorization: "Bearer runners-test-runner", "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "heartbeat-runner", fencingToken: "1:run-1:fence", leaseSeconds: 60, processAlive: true, daemonVersion: "0.0.0" }),
    });
    assert.equal(response.status, 409);
    const status = await app.request("/runners", { headers: { Authorization: "Bearer runners-test-operator" } });
    const body = await status.json() as { daemons: Array<{ runnerId: string }> };
    assert.equal(body.daemons[0]?.runnerId, "heartbeat-runner");
  });
});
