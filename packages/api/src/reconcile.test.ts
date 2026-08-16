import assert from "node:assert/strict";
import { access, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CleanupStatus, RunStatus, SessionExecutionStatus, TaskStatus, type PrismaClient } from "@agentos/db";

import {
  createArchivedRunNoticeScheduler,
  noteArchivedQueuedRuns,
  reconcileAtStartup,
  reconcileDatabaseRuns,
  reconcileWorkspaces,
  removeWorkspaceDirectory,
} from "./reconcile.js";

type WorkspaceRun = {
  id: string;
  workspacePath: string | null;
  status: RunStatus;
  workspaceRetained: boolean;
  endedAt: Date | null;
};

const workspaceFindMany = (runs: WorkspaceRun[]) => async ({ where }: {
  where: { OR?: Array<{ workspacePath?: { not: null }; id?: { in: string[] } }> };
}) => {
  assert.ok(where.OR, "workspace query must match both persisted paths and clone-window run ids");
  assert.deepEqual(where.OR[0], { workspacePath: { not: null } });
  const directoryNames = where.OR[1]?.id?.in;
  assert.ok(directoryNames, "workspace query must include the directory names read for this GC pass");
  return runs.filter((run) => run.workspacePath !== null || directoryNames.includes(run.id));
};

const workspaceFixture = async (runs: WorkspaceRun[], failedRetentionCount = 2) => {
  const root = await mkdtemp(join(tmpdir(), "agentos-reconcile-"));
  for (const run of runs) await mkdir(join(root, run.id));
  const updates: unknown[] = [];
  const sessionUpdates: unknown[] = [];
  const database = {
    run: {
      findMany: workspaceFindMany(runs),
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
    run: { findMany: workspaceFindMany(runs), update: async ({ where }: { where: { id: string } }) => { updated.push(where.id); return {}; } },
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
  const database = { run: { findMany: workspaceFindMany([run]) }, session: {} } as unknown as PrismaClient;
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

test("retains a preflight-failed clone with no persisted workspacePath when quota has room", async () => {
  const { root, removed } = await workspaceFixture([
    { id: "preflight-failure", workspacePath: null, status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date() },
  ], 1);
  assert.equal(removed, 0);
  await access(join(root, "preflight-failure"));
});

test("treats a retained terminal workspace with null endedAt as newest", async () => {
  const now = new Date();
  const { root, removed, updates } = await workspaceFixture([
    { id: "null-ended", workspacePath: null, status: RunStatus.FAILED, workspaceRetained: true, endedAt: null },
    { id: "dated", workspacePath: null, status: RunStatus.FAILED, workspaceRetained: true, endedAt: now },
  ], 1);
  assert.equal(removed, 1);
  await access(join(root, "null-ended"));
  assert.deepEqual(updates, [{ where: { id: "dated" }, data: { workspaceRetained: false } }]);
});

test("active retained rows never consume the terminal failure quota", async () => {
  const now = Date.now();
  const { root, removed } = await workspaceFixture([
    { id: "active", workspacePath: null, status: RunStatus.RUNNING, workspaceRetained: true, endedAt: new Date(now) },
    { id: "failed", workspacePath: null, status: RunStatus.FAILED, workspaceRetained: true, endedAt: new Date(now - 1_000) },
  ], 1);
  assert.equal(removed, 0);
  await access(join(root, "active"));
  await access(join(root, "failed"));
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

test("workspace removal tolerates a directory disappearing after readdir", async () => {
  await removeWorkspaceDirectory(join(tmpdir(), `agentos-already-removed-${Date.now()}`));
});

test("database reconciliation active status query remains limited to three execution states", async () => {
  let statuses: unknown;
  const database = {
    run: { findMany: async ({ where }: { where: { status: RunStatus | { in: unknown } } }) => {
      if (typeof where.status === "object") statuses = where.status.in;
      return [];
    } },
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

test("archived-run sweep paginates without capping eventual coverage and supports agentId", async () => {
  const archivedAt = new Date("2026-08-16T06:00:00.000Z");
  const seenQueries: Array<Record<string, unknown>> = [];
  const seeded = [
    ...Array.from({ length: 101 }, (_, index) => ({
      id: `queued-${String(index).padStart(3, "0")}`, taskId: `task-${index}`, runNumber: 1,
      status: RunStatus.QUEUED, agentId: "archived-agent", agent: { name: "Archived", archivedAt },
    })),
    { id: "running-1", taskId: "task-2", runNumber: 1, status: RunStatus.RUNNING, agentId: "archived-agent", agent: { name: "Archived", archivedAt } },
    { id: "active-1", taskId: "task-3", runNumber: 1, status: RunStatus.QUEUED, agentId: "active-agent", agent: { name: "Active", archivedAt: null } },
  ];
  const database = {
    run: {
      findMany: async (query: { where: Record<string, unknown>; take: number; cursor?: { id: string }; skip?: number }) => {
        seenQueries.push(query as unknown as Record<string, unknown>);
        const matching = seeded.filter((run) => (
          run.status === query.where.status
          && run.agent.archivedAt !== null
          && (!query.where.agentId || run.agentId === query.where.agentId)
        ));
        const start = query.cursor ? matching.findIndex((run) => run.id === query.cursor?.id) + (query.skip ?? 0) : 0;
        return matching.slice(start, start + query.take);
      },
    },
    taskActivity: { createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }) },
  } as unknown as PrismaClient;
  assert.equal(await noteArchivedQueuedRuns(database), 101);
  assert.equal(await noteArchivedQueuedRuns(database, { agentId: "active-agent" }), 0);
  assert.deepEqual(seenQueries[0]?.where, {
    status: RunStatus.QUEUED,
    taskId: { not: null },
    agent: { archivedAt: { not: null } },
  });
  assert.equal((seenQueries.at(-1)?.where as Record<string, unknown>)?.agentId, "active-agent");
  assert.equal(seenQueries[0]?.take, 100);
  assert.deepEqual(seenQueries[1]?.cursor, { id: "queued-099" });
});

test("claim-time archived-run scheduler coalesces polls and sweeps again after its interval", async () => {
  let sweeps = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const database = {
    run: { findMany: async () => { sweeps += 1; await blocked; return []; } },
  } as unknown as PrismaClient;
  const schedule = createArchivedRunNoticeScheduler(database, 1_000);
  const first = schedule(new Date(1_000));
  const concurrent = schedule(new Date(1_001));
  release?.();
  assert.deepEqual(await Promise.all([first, concurrent]), [0, 0]);
  assert.equal(sweeps, 1);
  assert.equal(await schedule(new Date(1_999)), 0);
  assert.equal(sweeps, 1);
  assert.equal(await schedule(new Date(2_000)), 0);
  assert.equal(sweeps, 2);
});

test("database reconciliation times out expired Inbox waits and makes retained workspace quota-managed", async () => {
  const now = new Date("2026-08-16T07:00:00.000Z");
  const writes: Array<{ target: string; data: Record<string, unknown> }> = [];
  const database = {
    run: {
      findMany: async ({ where }: { where: {
        status: RunStatus | { in: RunStatus[] };
        session?: { is: { resumableUntil: { lt: Date } } };
      } }) => {
        if (where.status !== RunStatus.WAITING_INBOX) return [];
        assert.equal(where.session?.is.resumableUntil.lt, now);
        return [{ id: "waiting-1", taskId: "task-1", session: { id: "session-1", waitingOnMessageId: "message-1" } }];
      },
    },
    $transaction: async (operation: (tx: any) => Promise<unknown>) => operation({
      run: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ target: "run", data }); return { count: 1 }; } },
      session: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ target: "session", data }); return { count: 1 }; } },
      inboxMessage: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ target: "message", data }); return { count: 1 }; } },
      task: { update: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ target: "task", data }); return {}; } },
      taskActivity: { create: async () => ({}) },
    }),
  } as unknown as PrismaClient;
  assert.equal(await reconcileDatabaseRuns(database, now), 1);
  assert.equal(writes.find((write) => write.target === "run")?.data.status, RunStatus.TIMED_OUT);
  assert.equal(writes.find((write) => write.target === "session")?.data.executionStatus, SessionExecutionStatus.TIMED_OUT);
  assert.equal(writes.find((write) => write.target === "session")?.data.cleanupStatus, CleanupStatus.RETAINED);
  assert.equal(writes.find((write) => write.target === "task")?.data.status, TaskStatus.REVIEW);
  assert.equal(writes.find((write) => write.target === "message")?.data.status, "CLOSED");
});

test("startup reconciliation does not fail when archived notice persistence fails", async () => {
  const database = {
    run: { findMany: async ({ where }: { where: { status: RunStatus | { in: RunStatus[] } } }) => {
      if (where.status === RunStatus.QUEUED) throw new Error("audit unavailable");
      return [];
    } },
  } as unknown as PrismaClient;
  const originalError = console.error;
  let logged = "";
  console.error = (...args: unknown[]) => { logged = args.map(String).join(" "); };
  try {
    const result = await reconcileAtStartup(database, join(tmpdir(), `agentos-missing-${Date.now()}`), 2);
    assert.deepEqual(result, { runs: 0, workspaces: 0, archivedNotices: 0 });
    assert.match(logged, /Archived-run startup notice failed.*audit unavailable/);
  } finally {
    console.error = originalError;
  }
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
