import { readdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  CleanupStatus,
  FailureClass,
  InboxStatus,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
  type PrismaClient,
} from "@agentos/db";

import { makeDedupeKey } from "./execution.js";

const activeStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] as const;
const terminalStatuses = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.TIMED_OUT, RunStatus.CANCELLED, RunStatus.LOST] as const;
const archivedNoticePageSize = 100;
export const archivedNoticeSweepIntervalMs = 60_000;

export const noteArchivedQueuedRuns = async (
  db: PrismaClient,
  options: { agentId?: string } = {},
): Promise<number> => {
  let cursor: string | undefined;
  let inserted = 0;
  do {
    const stalled = await db.run.findMany({
      where: {
        status: RunStatus.QUEUED,
        taskId: { not: null },
        agent: { archivedAt: { not: null } },
        ...(options.agentId ? { agentId: options.agentId } : {}),
      },
      select: {
        id: true,
        taskId: true,
        runNumber: true,
        agent: { select: { name: true, archivedAt: true } },
      },
      orderBy: { id: "asc" },
      take: archivedNoticePageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const rows = stalled.flatMap((run) => run.taskId && run.agent.archivedAt ? [{
      id: `archived-skip:${run.id}:${run.agent.archivedAt.toISOString()}`,
      taskId: run.taskId,
      actorType: "control-plane",
      body: `Assignee ${run.agent.name} is archived; run ${run.runNumber} stays queued and is not claimed until the agent is unarchived`,
    }] : []);
    if (rows.length > 0) {
      inserted += (await db.taskActivity.createMany({ data: rows, skipDuplicates: true })).count;
    }
    if (stalled.length < archivedNoticePageSize) break;
    cursor = stalled.at(-1)?.id;
  } while (cursor);
  return inserted;
};

export const createArchivedRunNoticeScheduler = (
  db: PrismaClient,
  intervalMs = archivedNoticeSweepIntervalMs,
): ((now?: Date) => Promise<number>) => {
  let nextSweepAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<number> | null = null;
  return async (now = new Date()) => {
    if (inFlight) return inFlight;
    if (now.getTime() < nextSweepAt) return 0;
    nextSweepAt = now.getTime() + intervalMs;
    inFlight = noteArchivedQueuedRuns(db);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
};

export const removeWorkspaceDirectory = async (path: string): Promise<void> => {
  // force makes a concurrent runner cleanup between readdir and rm a harmless no-op.
  await rm(path, { recursive: true, force: true });
};

export const reconcileDatabaseRuns = async (db: PrismaClient, now = new Date()): Promise<number> => {
  const [candidates, expiredInboxRuns] = await Promise.all([
    db.run.findMany({
      where: {
        status: { in: [...activeStatuses] },
        OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
      },
      select: {
        heartbeatAt: true,
        id: true,
        projectId: true,
        taskId: true,
        goalId: true,
        agentId: true,
        repoId: true,
        runNumber: true,
        runner: true,
        model: true,
        targetBranch: true,
        promptHash: true,
        maxDurationMin: true,
        stallTimeoutMin: true,
        maxRunsPerTask: true,
      },
    }),
    db.run.findMany({
      where: {
        status: RunStatus.WAITING_INBOX,
        session: { is: { resumableUntil: { lt: now } } },
      },
      select: {
        id: true,
        taskId: true,
        session: { select: { id: true, waitingOnMessageId: true } },
      },
    }),
  ]);
  // An api restart outlives a lease (60s) but not a heartbeat cycle. A run whose
  // runner is still checking in is alive — it renews its own lease on the next
  // heartbeat — so only silence beyond the stall timeout counts as death.
  const orphans = candidates.filter((run) => !(
    run.heartbeatAt && now.getTime() - run.heartbeatAt.getTime() < run.stallTimeoutMin * 60_000
  ));
  if (orphans.length === 0 && expiredInboxRuns.length === 0) return 0;
  await db.$transaction(async (tx) => {
    for (const run of orphans) {
      // Losing a lease is an external failure: it buys an attempt, never spends one.
      const budgetCeiling = run.maxRunsPerTask + 1;
      const lost = await tx.run.updateMany({
        where: { id: run.id, status: { in: [...activeStatuses] } },
        data: {
          status: RunStatus.LOST,
          endedAt: now,
          leaseExpiresAt: null,
          sessionTokenRevokedAt: now,
          failureClass: FailureClass.TRANSIENT_PROVIDER,
          retryable: true,
          maxRunsPerTask: budgetCeiling,
          failureReason: "Run orphaned or lease expired during startup reconciliation",
        },
      });
      if (lost.count !== 1) continue;
      await tx.session.updateMany({
        where: { runId: run.id },
        data: {
          executionStatus: SessionExecutionStatus.LOST,
          cleanupStatus: CleanupStatus.PENDING,
          endedAt: now,
          failureReason: "Run orphaned or lease expired during startup reconciliation",
        },
      });
      if (!run.taskId) continue;
      if (run.runNumber < budgetCeiling) {
        await tx.run.create({
          data: {
            projectId: run.projectId,
            taskId: run.taskId,
            goalId: run.goalId,
            agentId: run.agentId,
            repoId: run.repoId,
            runNumber: run.runNumber + 1,
            dedupeKey: makeDedupeKey(run.taskId, run.runNumber + 1),
            runner: run.runner,
            model: run.model,
            targetBranch: run.targetBranch,
            promptHash: run.promptHash,
            maxDurationMin: run.maxDurationMin,
            stallTimeoutMin: run.stallTimeoutMin,
            maxRunsPerTask: budgetCeiling,
          },
        });
        await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DOING, failureReason: null } });
        await tx.taskActivity.create({
          data: { taskId: run.taskId, actorType: "control-plane", body: `Run ${run.runNumber} lost; retry ${run.runNumber + 1} queued` },
        });
      } else {
        await tx.task.update({
          where: { id: run.taskId },
          data: { status: TaskStatus.REVIEW, failureReason: `Maximum ${budgetCeiling} runs reached after lease loss` },
        });
        await tx.inboxMessage.create({
          data: {
            from: "AGENT",
            taskId: run.taskId,
            kind: "TEXT",
            body: "Run budget exhausted after lease loss; operator action required.",
          },
        });
      }
    }
    for (const run of expiredInboxRuns) {
      const expired = await tx.run.updateMany({
        where: { id: run.id, status: RunStatus.WAITING_INBOX },
        data: {
          status: RunStatus.TIMED_OUT,
          endedAt: now,
          retryable: false,
          failureClass: FailureClass.CANCELLED_OR_TIMED_OUT,
          failureReason: "Inbox response window expired",
        },
      });
      if (expired.count !== 1) continue;
      if (run.session) {
        await tx.session.updateMany({
          where: { id: run.session.id, executionStatus: SessionExecutionStatus.WAITING_INBOX },
          data: {
            executionStatus: SessionExecutionStatus.TIMED_OUT,
            cleanupStatus: CleanupStatus.RETAINED,
            endedAt: now,
            cleanupEndedAt: now,
            failureReason: "Inbox response window expired",
          },
        });
      }
      if (run.session?.waitingOnMessageId) {
        await tx.inboxMessage.updateMany({
          where: { id: run.session.waitingOnMessageId, status: InboxStatus.OPEN },
          data: { status: InboxStatus.CLOSED },
        });
      }
      if (run.taskId) {
        await tx.task.update({
          where: { id: run.taskId },
          data: { status: TaskStatus.REVIEW, failureReason: "Inbox response window expired" },
        });
        await tx.taskActivity.create({
          data: { taskId: run.taskId, actorType: "control-plane", body: "Inbox response window expired; run moved to review" },
        });
      }
    }
  });
  return orphans.length + expiredInboxRuns.length;
};

const insideRoot = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${sep}`);

export const reconcileWorkspaces = async (
  db: PrismaClient,
  workspaceRoot: string,
  failedRetentionCount: number,
): Promise<number> => {
  const root = resolve(workspaceRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const workspaceKeepStatuses = [
    RunStatus.CLAIMED,
    RunStatus.PROVISIONING,
    RunStatus.RUNNING,
    RunStatus.WAITING_INBOX,
    RunStatus.QUEUED,
  ] as const;
  const directoryNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const runs = await db.run.findMany({
    where: {
      OR: [
        { workspacePath: { not: null } },
        { id: { in: directoryNames } },
      ],
    },
    select: { id: true, workspacePath: true, status: true, workspaceRetained: true, endedAt: true },
  });
  const byPath = new Map(runs.flatMap((run) => run.workspacePath ? [[resolve(run.workspacePath), run] as const] : []));
  const byId = new Map(runs.map((run) => [run.id, run] as const));
  const directoryNameSet = new Set(directoryNames);
  const directoryPaths = new Set(directoryNames.map((name) => resolve(root, name)));
  const retained = runs
    .filter((run) => (
      run.workspaceRetained
      && terminalStatuses.includes(run.status as typeof terminalStatuses[number])
      && (directoryNameSet.has(run.id) || Boolean(run.workspacePath && directoryPaths.has(resolve(run.workspacePath))))
    ))
    .sort((a, b) => {
      if (a.endedAt === null && b.endedAt === null) return a.id.localeCompare(b.id);
      if (a.endedAt === null) return -1;
      if (b.endedAt === null) return 1;
      return b.endedAt.getTime() - a.endedAt.getTime();
    });
  const allowedRetained = new Set(retained.slice(0, Math.max(0, failedRetentionCount)).map(({ id }) => id));
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = resolve(root, entry.name);
    if (!insideRoot(root, path)) continue;
    const pathRun = byPath.get(path);
    const idRun = byId.get(entry.name);
    const matchingRuns = [pathRun, idRun].filter((run): run is NonNullable<typeof run> => run != null);
    const active = matchingRuns.some((run) => workspaceKeepStatuses.includes(run.status as typeof workspaceKeepStatuses[number]));
    const keepFailed = matchingRuns.some((run) => run.workspaceRetained && allowedRetained.has(run.id));
    if (active || keepFailed) continue;
    await removeWorkspaceDirectory(path);
    const run = pathRun ?? idRun;
    if (run) {
      await db.run.update({ where: { id: run.id }, data: { workspaceRetained: false } });
      await db.session.updateMany({
        where: { runId: run.id },
        data: { cleanupStatus: CleanupStatus.SUCCEEDED, cleanupEndedAt: new Date() },
      });
    }
    removed += 1;
  }
  return removed;
};

export const reconcileAtStartup = async (
  db: PrismaClient,
  workspaceRoot: string,
  failedRetentionCount: number,
): Promise<{ runs: number; workspaces: number; archivedNotices: number }> => ({
  runs: await reconcileDatabaseRuns(db),
  workspaces: await reconcileWorkspaces(db, workspaceRoot, failedRetentionCount),
  archivedNotices: await noteArchivedQueuedRuns(db).catch((error: unknown) => {
    console.error("Archived-run startup notice failed", error);
    return 0;
  }),
});
