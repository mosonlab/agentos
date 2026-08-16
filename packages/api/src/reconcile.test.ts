import assert from "node:assert/strict";
import { access, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CleanupStatus, RunStatus, type PrismaClient } from "@agentos/db";

import { noteArchivedQueuedRuns, reconcileDatabaseRuns, reconcileWorkspaces } from "./reconcile.js";

type WorkspaceRun = {
  id: string;
  workspacePath: string | null;
  status: RunStatus;
  workspaceRetained: boolean;
  endedAt: Date | null;
};

const workspaceFixture = async (runs: WorkspaceRun[], failedRetentionCount = 2) => {
  const root = await mkdtemp(join(tmpdir(), "agentos-reconcile-"));
  for (const run of runs) await mkdir(join(root, run.id));
  const updates: unknown[] = [];
  const sessionUpdates: unknown[] = [];
  const database = {
    run: {
      findMany: async () => runs,
      update: async (args: unknown) => { updates.push(args); return {}; },
    },
    session: {
      updateMany: async (args: unknown) => { sessionUpdates.push(args); return { count: 1 }; },
    },
  } as unknown as PrismaClient;
  const removed = await reconcileWorkspaces(database, root, failedRetentionCount);
  return { root, removed, updates, sessionUpdates };
};

test("keeps WAITING_INBOX outside failed retention quota and evicts oldest retained failure", async () => {
  const now = Date.now();
  const root = await mkdtemp(join(tmpdir(), "agentos-reconcile-paths-"));
  const runs: WorkspaceRun[] = [
    { id: "waiting", workspacePath: join(root, "waiting"), status: RunStatus.WAITING_INBOX, workspaceRetained: false, endedAt: null },
    { id: "new-failure", workspacePath: join(root, "new-failure"), status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date(now) },
    { id: "mid-failure", workspacePath: join(root, "mid-failure"), status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date(now - 1_000) },
    { id: "old-failure", workspacePath: join(root, "old-failure"), status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date(now - 2_000) },
  ];
  for (const run of runs) await mkdir(join(root, run.id));
  const updated: string[] = [];
  const database = {
    run: { findMany: async () => runs, update: async ({ where }: { where: { id: string } }) => { updated.push(where.id); return {}; } },
    session: { updateMany: async () => ({ count: 1 }) },
  } as unknown as PrismaClient;

  assert.equal(await reconcileWorkspaces(database, root, 2), 1);
  await access(join(root, "waiting"));
  assert.deepEqual(updated, ["old-failure"]);
});

test("keeps resume-pending QUEUED workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-reconcile-queued-"));
  const run: WorkspaceRun = { id: "queued", workspacePath: join(root, "queued"), status: RunStatus.QUEUED, workspaceRetained: false, endedAt: null };
  await mkdir(run.workspacePath!);
  const database = { run: { findMany: async () => [run] }, session: {} } as unknown as PrismaClient;
  assert.equal(await reconcileWorkspaces(database, root, 2), 0);
});

test("keeps CLAIMED and PROVISIONING clone directories before workspacePath is stored", async () => {
  for (const status of [RunStatus.CLAIMED, RunStatus.PROVISIONING]) {
    const { removed } = await workspaceFixture([
      { id: `clone-${status}`, workspacePath: null, status, workspaceRetained: false, endedAt: null },
    ]);
    assert.equal(removed, 0, `${status} clone directory must survive reconciliation`);
  }
});

test("removes terminal workspace past quota and marks cleanup complete", async () => {
  const { removed, updates, sessionUpdates } = await workspaceFixture([
    { id: "failed", workspacePath: null, status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date() },
  ], 0);
  assert.equal(removed, 1);
  assert.deepEqual(updates, [{ where: { id: "failed" }, data: { workspaceRetained: false } }]);
  assert.equal((sessionUpdates[0] as { data: { cleanupStatus: CleanupStatus } }).data.cleanupStatus, CleanupStatus.SUCCEEDED);
});

test("removes directory with no matching run", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentos-reconcile-orphan-"));
  await mkdir(join(root, "orphan"));
  const database = { run: { findMany: async () => [] }, session: {} } as unknown as PrismaClient;
  assert.equal(await reconcileWorkspaces(database, root, 2), 1);
});

test("database reconciliation active status query remains limited to three execution states", async () => {
  let statuses: unknown;
  const database = {
    run: { findMany: async ({ where }: { where: { status: { in: unknown } } }) => { statuses = where.status.in; return []; } },
  } as unknown as PrismaClient;
  assert.equal(await reconcileDatabaseRuns(database), 0);
  assert.deepEqual(statuses, [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING]);
});

test("four concurrent archived-run sweeps use one deterministic idempotency key", async () => {
  const archivedAt = new Date("2026-08-16T06:00:00.000Z");
  const ids = new Set<string>();
  const inserted: Record<string, unknown>[] = [];
  const database = {
    run: {
      findMany: async () => [{
        id: "run-7",
        taskId: "task-7",
        runNumber: 7,
        agent: { name: "Archived Agent", archivedAt },
      }],
    },
    taskActivity: {
      createMany: async ({ data, skipDuplicates }: { data: Record<string, unknown>[]; skipDuplicates: boolean }) => {
        assert.equal(skipDuplicates, true);
        let count = 0;
        for (const row of data) {
          const id = String(row.id);
          if (ids.has(id)) continue;
          ids.add(id);
          inserted.push(row);
          count += 1;
        }
        return { count };
      },
    },
  } as unknown as PrismaClient;
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => noteArchivedQueuedRuns(database))), [1, 0, 0, 0]);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.id, "archived-skip:run-7:2026-08-16T06:00:00.000Z");
});

test("archived-run sweep is uncapped, scoped to queued runs, and supports agentId", async () => {
  const archivedAt = new Date("2026-08-16T06:00:00.000Z");
  const seenWhere: Record<string, unknown>[] = [];
  const seeded = [
    { id: "queued-1", taskId: "task-1", runNumber: 1, status: RunStatus.QUEUED, agentId: "archived-agent", agent: { name: "Archived", archivedAt } },
    { id: "running-1", taskId: "task-2", runNumber: 1, status: RunStatus.RUNNING, agentId: "archived-agent", agent: { name: "Archived", archivedAt } },
    { id: "active-1", taskId: "task-3", runNumber: 1, status: RunStatus.QUEUED, agentId: "active-agent", agent: { name: "Active", archivedAt: null } },
  ];
  const database = {
    run: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        seenWhere.push(where);
        assert.equal(take, undefined);
        return seeded.filter((run) => (
          run.status === where.status
          && run.agent.archivedAt !== null
          && (!where.agentId || run.agentId === where.agentId)
        ));
      },
    },
    taskActivity: { createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }) },
  } as unknown as PrismaClient;
  assert.equal(await noteArchivedQueuedRuns(database), 1);
  assert.equal(await noteArchivedQueuedRuns(database, { agentId: "active-agent" }), 0);
  assert.deepEqual(seenWhere[0], {
    status: RunStatus.QUEUED,
    taskId: { not: null },
    agent: { archivedAt: { not: null } },
  });
  assert.equal(seenWhere[1]?.agentId, "active-agent");
});

test("lease-loss requeue for an archived agent becomes visible through the sweep", async () => {
  const now = new Date("2026-08-16T06:00:00.000Z");
  let queued: Record<string, unknown> | undefined;
  const activities: Record<string, unknown>[] = [];
  const candidate = {
    id: "lost-1", heartbeatAt: new Date(now.getTime() - 20 * 60_000), projectId: "project-1",
    taskId: "task-1", goalId: null, agentId: "agent-1", repoId: "repo-1", runNumber: 1,
    runner: "CLAUDE", model: "model", targetBranch: "main", promptHash: "hash",
    maxDurationMin: 120, stallTimeoutMin: 10, maxRunsPerTask: 3,
  };
  const database = {
    run: {
      findMany: async ({ where }: { where: { status: unknown } }) => typeof where.status === "object" && where.status !== null && "in" in where.status
        ? [candidate]
        : queued ? [{ id: "retry-2", taskId: "task-1", runNumber: 2, agent: { name: "Archived", archivedAt: now } }] : [],
    },
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      run: {
        updateMany: async () => ({ count: 1 }),
        create: async ({ data }: { data: Record<string, unknown> }) => { queued = data; return { id: "retry-2", ...data }; },
      },
      session: { updateMany: async () => ({ count: 1 }) },
      task: { update: async () => ({}) },
      taskActivity: { create: async () => ({}) },
      inboxMessage: { create: async () => ({}) },
    }),
    taskActivity: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => { activities.push(...data); return { count: data.length }; },
    },
  } as unknown as PrismaClient;
  assert.equal(await reconcileDatabaseRuns(database, now), 1);
  assert.equal(await noteArchivedQueuedRuns(database), 1);
  assert.match(String(activities[0]?.body), /Archived.*run 2/);
});
