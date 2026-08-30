import assert from "node:assert/strict";
import { test } from "node:test";

import { type PrismaClient, RunStatus } from "@anneal/db";

import {
  appendRunActivity,
  appendRunEvents,
  eventsInput,
  heartbeatInput,
  heartbeatRun,
  publishRun,
  recordRunCleanup,
  startRun,
} from "./run-lifecycle.js";
import type { LockedAuthorityRun } from "./run-fence.js";

const now = new Date("2026-08-30T12:00:00.000Z");

const databaseFor = (tx: Record<string, unknown>, calls: string[] = []): PrismaClient => ({
  $transaction: async (operation: (client: unknown) => Promise<unknown>) => {
    calls.push("transaction");
    return operation(tx);
  },
} as unknown as PrismaClient);

const authorityRun = (overrides: Partial<LockedAuthorityRun> = {}): LockedAuthorityRun => ({
  id: "run-1",
  runnerId: "runner-1",
  fencingToken: "fence-1",
  cancelRequestId: null,
  cancelReason: null,
  cancelRequestedAt: null,
  leaseExpiresAt: new Date(now.getTime() + 60_000),
  status: RunStatus.RUNNING,
  taskId: "task-1",
  repoId: "repo-1",
  runNumber: 1,
  pushedBranch: null,
  branch: "feature/task-1",
  ...overrides,
});

test("start owns the transaction and preserves one Run and Session lifecycle timestamp", async () => {
  const calls: string[] = [];
  const runWrites: Array<Record<string, unknown>> = [];
  const sessionWrites: Array<Record<string, unknown>> = [];
  let fencedRead = 0;
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      calls.push(query.join("?").includes('FROM "Run"') ? "lock.run" : "lock.task");
      return query.join("?").includes('FROM "Run"')
        ? [{ id: "run-1" }]
        : [{ id: "task-1", archivedAt: null }];
    },
    run: {
      findFirst: async () => {
        calls.push("read.run");
        fencedRead += 1;
        return fencedRead === 1 ? { taskId: "task-1" } : { startedAt: null };
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("write.run");
        runWrites.push(data);
        return { count: 1 };
      },
    },
    session: { updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      calls.push("write.session");
      sessionWrites.push(data);
      return { count: 1 };
    } },
  };

  const result = await startRun(databaseFor(tx, calls), {
    runId: "run-1",
    now,
    body: {
      runnerId: "runner-1",
      fencingToken: "fence-1",
      adapterVersion: "adapter-1",
      cliVersion: "cli-1",
      manifest: {},
      workspacePath: "/scratch/run-1",
      promptHash: "a".repeat(64),
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(runWrites[0]?.startedAt, now);
  assert.equal(sessionWrites[0]?.startedAt, now);
  assert.deepEqual(calls, [
    "transaction",
    "lock.run",
    "read.run",
    "lock.task",
    "read.run",
    "write.run",
    "write.session",
  ]);
});

test("start preserves a resumed lifecycle anchor and admits the mechanical null prompt", async () => {
  const originalStartedAt = new Date("2026-08-29T10:00:00.000Z");
  const runWrites: Array<Record<string, unknown>> = [];
  const sessionWrites: Array<Record<string, unknown>> = [];
  let fencedRead = 0;
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    run: {
      findFirst: async () => {
        fencedRead += 1;
        return fencedRead === 1 ? { taskId: "task-1" } : { startedAt: originalStartedAt };
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        runWrites.push(data);
        return { count: 1 };
      },
    },
    session: { updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      sessionWrites.push(data);
      return { count: 1 };
    } },
  };

  const result = await startRun(databaseFor(tx), {
    runId: "run-1",
    now,
    body: {
      runnerId: "merge-executor-1",
      fencingToken: "fence-1",
      adapterVersion: "executor-1",
      cliVersion: "executor-1",
      manifest: { executionMode: "mechanical" },
      workspacePath: null,
      promptHash: null,
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(runWrites[0]?.startedAt, originalStartedAt);
  assert.equal(sessionWrites[0]?.startedAt, originalStartedAt);
  assert.equal(runWrites[0]?.promptHash, null);
});

test("heartbeat observes the runner before refusing stale and WAITING_INBOX Runs", async () => {
  const body = heartbeatInput.parse({
    runnerId: "runner-1",
    fencingToken: "stale-fence",
    leaseSeconds: 60,
    processAlive: true,
  });
  const calls: string[] = [];
  const makeDb = (run: LockedAuthorityRun) => databaseFor({
    $queryRaw: async () => { calls.push("lock.run"); return [{ id: "run-1" }]; },
    run: { findFirst: async () => run },
  }, calls);
  const noteRunner = () => { calls.push("note.runner"); };

  const stale = await heartbeatRun(makeDb(authorityRun()), { runId: "run-1", body, noteRunner, now });
  assert.deepEqual(stale, {
    reason: "conflict",
    message: "Stale fencing token",
    detail: { reason: "stale-fence" },
  });
  assert.equal(calls[0], "note.runner");

  calls.length = 0;
  const waiting = await heartbeatRun(makeDb(authorityRun({
    status: RunStatus.WAITING_INBOX,
    leaseExpiresAt: null,
  })), { runId: "run-1", body: { ...body, fencingToken: "fence-1" }, noteRunner, now });
  assert.deepEqual(waiting, {
    reason: "conflict",
    message: "Run suspended for Inbox",
    detail: { code: "WAITING_INBOX" },
  });
});

test("heartbeat writes through live authority and returns cancellation through the same interface", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const makeDb = (run: LockedAuthorityRun) => databaseFor({
    $queryRaw: async () => [{ id: "run-1" }],
    run: {
      findFirst: async () => run,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { count: 1 };
      },
    },
  });
  const body = heartbeatInput.parse({
    runnerId: "runner-1",
    fencingToken: "fence-1",
    leaseSeconds: 60,
    processAlive: true,
  });
  const live = await heartbeatRun(makeDb(authorityRun()), {
    runId: "run-1", body, noteRunner: () => {}, now,
  });
  assert.deepEqual(live, { ok: true, cancellation: null, mechanicalCancellationPolicy: "refused" });
  assert.equal(writes[0]?.heartbeatAt, now);

  const requestedAt = new Date(now.getTime() - 1_000);
  const cancellation = await heartbeatRun(makeDb(authorityRun({
    cancelRequestId: "cancel-1",
    cancelReason: "stop",
    cancelRequestedAt: requestedAt,
  })), { runId: "run-1", body, noteRunner: () => {}, now });
  assert.deepEqual(cancellation, {
    ok: false,
    mechanicalCancellationPolicy: "refused",
    cancellation: { requestId: "cancel-1", reason: "stop", requestedAt },
  });
});

test("publication admits deterministic salvage after lease loss and keeps Run before Task lock order", async () => {
  const calls: string[] = [];
  const run = authorityRun({
    leaseExpiresAt: new Date(now.getTime() - 1_000),
    status: RunStatus.LOST,
  });
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      const target = query.join("?").includes('FROM "Run"') ? "run" : "task";
      calls.push(`lock.${target}`);
      return [{ id: `${target}-1`, archivedAt: null }];
    },
    run: {
      findFirst: async ({ select }: { select: Record<string, unknown> }) => {
        if (select.runnerId) { calls.push("read.run"); return run; }
        calls.push("read.replacement");
        return null;
      },
      updateMany: async () => { calls.push("write.run"); return { count: 1 }; },
    },
    task: {
      findUnique: async () => { calls.push("read.task-identity"); return { projectId: "project-1", chainId: null }; },
      findUniqueOrThrow: async () => { calls.push("read.task"); return { id: "task-1" }; },
    },
  };

  const result = await publishRun(databaseFor(tx, calls), {
    runId: "run-1",
    now,
    body: {
      runnerId: "runner-1",
      fencingToken: "fence-1",
      pushedBranch: "agentos/task-1/run-1",
    },
  });

  assert.deepEqual(result, { ok: true, replacementRepair: "none" });
  assert.ok(calls.indexOf("lock.run") < calls.indexOf("lock.task"));
});

test("cleanup admits only the owning fence after live authority has ended", async () => {
  const writes: string[] = [];
  const makeDb = (run: LockedAuthorityRun) => databaseFor({
    $queryRaw: async () => [{ id: "run-1" }],
    run: {
      findFirst: async () => run,
      update: async () => { writes.push("run"); return {}; },
    },
    session: { updateMany: async () => { writes.push("session"); return { count: 1 }; } },
  });
  const body = {
    runnerId: "runner-1",
    fencingToken: "fence-1",
    cleanupStatus: "FAILED" as const,
    cleanupFailureReason: "retained",
    workspaceRetained: true,
  };

  const refused = await recordRunCleanup(makeDb(authorityRun()), { runId: "run-1", body, now });
  assert.deepEqual(refused, {
    reason: "conflict",
    message: "Cleanup outcome is not authorized for a live or foreign run",
  });
  assert.deepEqual(writes, []);

  const accepted = await recordRunCleanup(makeDb(authorityRun({ status: RunStatus.LOST })), {
    runId: "run-1", body, now,
  });
  assert.deepEqual(accepted, { ok: true });
  assert.deepEqual(writes, ["run", "session"]);
});

test("events normalize and persist through the lifecycle interface", async () => {
  const stored: Array<Record<string, unknown>> = [];
  let fencedRead = 0;
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    run: { findFirst: async () => {
      fencedRead += 1;
      return fencedRead === 1
        ? { taskId: "task-1" }
        : { session: { id: "session-1", providerConversationId: null } };
    } },
    sessionEvent: { createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      stored.push(...data);
      return { count: data.length };
    } },
    session: { update: async () => ({}) },
  };
  const body = eventsInput.parse({
    runnerId: "runner-1",
    fencingToken: "fence-1",
    events: [{ seq: 1, source: "CLAUDE", type: "NUL\u0000EVENT", payload: { text: "a\u0000b" } }],
  });

  const result = await appendRunEvents(databaseFor(tx), { runId: "run-1", body, now });
  assert.deepEqual(result, { accepted: 1 });
  assert.equal(stored[0]?.type, "NUL\\u0000EVENT");
  assert.deepEqual(stored[0]?.payload, { text: "a\\u0000b" });
});

test("activity persists the authenticated principal through the lifecycle interface", async () => {
  let fencedRead = 0;
  const writes: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => query.join("?").includes('FROM "Run"')
      ? [{ id: "run-1" }]
      : [{ id: "task-1", archivedAt: null }],
    run: { findFirst: async () => {
      fencedRead += 1;
      return fencedRead === 1
        ? { taskId: "task-1" }
        : { taskId: "task-1", leaseGeneration: 1, task: { templateStep: null } };
    } },
    taskActivity: { create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push(data);
      return { id: "activity-1", ...data };
    } },
  };

  const result = await appendRunActivity(databaseFor(tx), {
    runId: "run-1",
    now,
    principal: { kind: "session", runId: "run-1", leaseGeneration: 1 },
    body: { actorType: "operator", fencingToken: "fence-1", body: "progress" },
  });
  assert.equal("message" in result, false);
  assert.deepEqual(writes[0], {
    taskId: "task-1",
    actorType: "session",
    actorId: null,
    body: "progress",
  });
});
