import { readdir, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  CleanupStatus,
  FailureClass,
  RunStatus,
  SessionExecutionStatus,
  TaskStatus,
  type PrismaClient,
} from "@agentos/db";

import { makeDedupeKey } from "./execution.js";

const activeStatuses = [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING] as const;

export const reconcileDatabaseRuns = async (db: PrismaClient, now = new Date()): Promise<number> => {
  const orphans = await db.run.findMany({
    where: {
      status: { in: [...activeStatuses] },
      OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
    },
    select: {
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
  });
  if (orphans.length === 0) return 0;
  await db.$transaction(async (tx) => {
    for (const run of orphans) {
      const lost = await tx.run.updateMany({
        where: { id: run.id, status: { in: [...activeStatuses] } },
        data: {
          status: RunStatus.LOST,
          endedAt: now,
          leaseExpiresAt: null,
          sessionTokenRevokedAt: now,
          failureClass: FailureClass.TRANSIENT_PROVIDER,
          retryable: true,
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
      if (run.runNumber < run.maxRunsPerTask) {
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
            maxRunsPerTask: run.maxRunsPerTask,
          },
        });
        await tx.task.update({ where: { id: run.taskId }, data: { status: TaskStatus.DOING, failureReason: null } });
        await tx.taskActivity.create({
          data: { taskId: run.taskId, actorType: "control-plane", body: `Run ${run.runNumber} lost; retry ${run.runNumber + 1} queued` },
        });
      } else {
        await tx.task.update({
          where: { id: run.taskId },
          data: { status: TaskStatus.REVIEW, failureReason: `Maximum ${run.maxRunsPerTask} runs reached after lease loss` },
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
  });
  return orphans.length;
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
  const runs = await db.run.findMany({
    where: { workspacePath: { not: null } },
    select: { id: true, workspacePath: true, status: true, workspaceRetained: true, endedAt: true },
  });
  const byPath = new Map(runs.flatMap((run) => run.workspacePath ? [[resolve(run.workspacePath), run] as const] : []));
  const retained = runs
    .filter((run) => run.workspaceRetained && run.workspacePath)
    .sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0));
  const allowedRetained = new Set(retained.slice(0, Math.max(0, failedRetentionCount)).map(({ id }) => id));
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = resolve(root, entry.name);
    if (!insideRoot(root, path)) continue;
    const run = byPath.get(path);
    const active = run && activeStatuses.includes(run.status as typeof activeStatuses[number]);
    const keepFailed = run?.workspaceRetained && allowedRetained.has(run.id);
    if (active || keepFailed) continue;
    await stat(path);
    await rm(path, { recursive: true, force: true });
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
): Promise<{ runs: number; workspaces: number }> => ({
  runs: await reconcileDatabaseRuns(db),
  workspaces: await reconcileWorkspaces(db, workspaceRoot, failedRetentionCount),
});
