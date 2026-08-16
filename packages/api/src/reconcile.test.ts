import assert from "node:assert/strict";
import { access, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CleanupStatus, RunStatus, type PrismaClient } from "@agentos/db";

import { reconcileDatabaseRuns, reconcileWorkspaces } from "./reconcile.js";

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
