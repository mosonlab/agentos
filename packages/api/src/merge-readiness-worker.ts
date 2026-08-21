import { createHash, randomUUID } from "node:crypto";

import {
  AssigneeType,
  AUTHORIZED_MERGE_METHOD,
  MERGE_TAIL_KIND,
  Prisma,
  RunnerPreference,
  TaskStatus,
  activateChainSuccessor,
  authorizationMetadata,
  defenseTriggers,
  enqueueTaskRun,
  parseRegressionVerdict,
  resolveChainTarget,
  resolutionTestTriggers,
  runnerFor,
  type PrismaClient,
} from "@agentos/db";

import { evidenceFromSnapshot } from "./merge-evidence-worker.js";
import { createGitHubReader, type GitHubReader } from "./github-read.js";

export const readinessPollIntervalMs = (): number => {
  const raw = Number(process.env.MERGE_READINESS_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 250 ? Math.floor(raw) : 2_000;
};

const stopReadiness = async (
  db: PrismaClient,
  input: { readinessTaskId: string; regressionTaskId: string; reason: string },
): Promise<void> => {
  const dedupeKey = `merge-readiness-stop:${input.readinessTaskId}:${createHash("sha256").update(input.reason).digest("hex")}`;
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id: input.readinessTaskId }, data: { status: TaskStatus.REVIEW, failureReason: input.reason } });
    await tx.task.update({ where: { id: input.regressionTaskId }, data: { status: TaskStatus.REVIEW, failureReason: input.reason } });
    await tx.taskActivity.create({ data: {
      taskId: input.regressionTaskId,
      actorType: "control-plane",
      body: `Merge readiness stopped at regression: ${input.reason}`,
      metadata: { kind: MERGE_TAIL_KIND.readiness, schemaVersion: 1, state: "stopped", reason: input.reason },
    } });
    await tx.inboxMessage.upsert({
      where: { dedupeKey },
      create: {
        from: "AGENT",
        taskId: input.regressionTaskId,
        kind: "TEXT",
        body: `Autonomous merge readiness stopped: ${input.reason}`,
        dedupeKey,
      },
      update: {},
    });
  });
};

const latestReviewState = async (db: PrismaClient, readinessTaskId: string, headSha: string) => {
  const rows = await db.taskActivity.findMany({ where: { taskId: readinessTaskId }, orderBy: { createdAt: "desc" }, select: { metadata: true } });
  for (const row of rows) {
    const metadata = row.metadata as Record<string, unknown> | null;
    if (metadata?.kind === MERGE_TAIL_KIND.reviewObligation && metadata.headSha === headSha) return metadata;
  }
  return null;
};

const createReviewObligation = async (
  db: PrismaClient,
  input: {
    readinessTask: { id: string; projectId: string; repoId: string | null };
    regressionTaskId: string;
    branch: string;
    baseSha: string;
    headSha: string;
    triggers: Array<{ path: string; reason: string }>;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> => db.$transaction(async (tx) => {
  if (!input.readinessTask.repoId) return { ok: false as const, reason: "readiness task has no repository" };
  const agent = await tx.agent.findFirst({ where: { projectId: input.readinessTask.projectId, name: "review-coordinator", archivedAt: null } });
  if (!agent) return { ok: false as const, reason: "review-coordinator is absent or archived" };
  const grant = await tx.agentRepoAccess.findFirst({ where: { projectId: input.readinessTask.projectId, repoId: input.readinessTask.repoId, agentId: agent.id } });
  if (!grant) return { ok: false as const, reason: "review-coordinator has no repository grant" };
  const task = await tx.task.create({ data: {
    projectId: input.readinessTask.projectId,
    repoId: input.readinessTask.repoId,
    followUpTaskId: input.readinessTask.id,
    name: "Autonomous merge tail: independent review",
    description: [
      `Blindly review the exact diff ${input.baseSha}..${input.headSha}.`,
      `The server-side trigger set is ${JSON.stringify(input.triggers)}.`,
      "Do not read prior review outputs. Find correctness or safety defects in the triggered merge-tail surface, run focused checks, then persist exactly one JSON object: {\"schemaVersion\":1,\"outcome\":\"approved\",\"headSha\":\"<40 hex>\"} or {\"schemaVersion\":1,\"outcome\":\"rejected\",\"headSha\":\"<40 hex>\",\"summary\":\"<must-fix>\"}.",
    ].join("\n\n"),
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: agent.id,
    approvalGate: false,
    opensPullRequest: false,
    status: TaskStatus.TODO,
    targetBranch: input.branch,
    maxSessionsPerTask: 1,
  } });
  const run = await enqueueTaskRun(tx, task.id);
  await tx.run.update({ where: { id: run.id }, data: {
    branch: input.branch,
    targetBranch: input.branch,
    model: "gpt-5.6-sol:medium",
    runner: runnerFor(RunnerPreference.CODEX, "gpt-5.6-sol:medium"),
  } });
  await tx.taskActivity.createMany({ data: [
    {
      taskId: input.readinessTask.id,
      actorType: "control-plane",
      body: `Independent review obligation opened for ${input.headSha}`,
      metadata: {
        kind: MERGE_TAIL_KIND.reviewObligation,
        schemaVersion: 1,
        state: "open",
        headSha: input.headSha,
        baseSha: input.baseSha,
        reviewTaskId: task.id,
        triggers: input.triggers,
      },
    },
    {
      taskId: task.id,
      actorType: "control-plane",
      body: `Blind review obligation for readiness task ${input.readinessTask.id}`,
      metadata: {
        kind: MERGE_TAIL_KIND.reviewObligation,
        schemaVersion: 1,
        state: "open",
        readinessTaskId: input.readinessTask.id,
        regressionTaskId: input.regressionTaskId,
        headSha: input.headSha,
        baseSha: input.baseSha,
      },
    },
  ] });
  await tx.task.update({ where: { id: input.readinessTask.id }, data: {
    status: TaskStatus.REVIEW,
    failureReason: `independent-review-open:${task.id}:${input.headSha}`,
  } });
  return { ok: true as const };
});

export type ReadinessTickResult = { claimed: number; authorized: number; reviewing: number; stopped: number };

export const readinessTick = async (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
  now = new Date(),
  limit = 5,
): Promise<ReadinessTickResult> => {
  const result: ReadinessTickResult = { claimed: 0, authorized: 0, reviewing: 0, stopped: 0 };
  const candidates = await db.task.findMany({
    where: {
      status: TaskStatus.TODO,
      templateStep: {
        outputKind: "merge-authorization",
        taskTemplate: { name: { in: ["direct-engineer-workflow", "compound-engineer-workflow"] } },
      },
    },
    include: { templateStep: true, repo: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  for (const readiness of candidates) {
    const claimed = await db.task.updateMany({ where: { id: readiness.id, status: TaskStatus.TODO }, data: { status: TaskStatus.DOING, failureReason: null } });
    if (claimed.count !== 1) continue;
    result.claimed += 1;
    const regression = await db.task.findFirst({
      where: {
        projectId: readiness.projectId,
        chainId: readiness.chainId,
        templateId: readiness.templateId,
        templateStep: { outputKind: "regression-verification" },
      },
      include: { stepOutput: true },
    });
    if (!regression?.stepOutput) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression?.id ?? readiness.id, reason: "missing head-bound regression PASS evidence" });
      result.stopped += 1;
      continue;
    }
    const verdict = parseRegressionVerdict(regression.stepOutput.body);
    if (verdict.status !== "ok" || verdict.verdict.outcome !== "pass" || regression.stepOutput.commitSha !== verdict.verdict.headSha) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "missing or stale head-bound regression PASS evidence" });
      result.stopped += 1;
      continue;
    }
    if (!reader?.compareCommits) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "server-side GitHub comparison reader is unavailable" });
      result.stopped += 1;
      continue;
    }
    const target = await db.$transaction((tx) => resolveChainTarget(tx, readiness));
    if (!target.resolved) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: `pull-request target is ${target.unresolvable}` });
      result.stopped += 1;
      continue;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const snapshot = await reader.readPullRequest(target.repository, target.prNumber, readiness.repo?.defaultBranch ?? "main", controller.signal);
      if (snapshot.headRefOid !== verdict.verdict.headSha) {
        clearTimeout(timer);
        await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: `stale PASS evidence ${verdict.verdict.headSha}; current PR head is ${snapshot.headRefOid ?? "missing"}` });
        result.stopped += 1;
        continue;
      }
      if (!snapshot.baseSha || !snapshot.baseRefName) {
        clearTimeout(timer);
        await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "pull request base identity is unavailable" });
        result.stopped += 1;
        continue;
      }
      if (snapshot.baseSha !== verdict.verdict.baseHeadSha) {
        clearTimeout(timer);
        await stopReadiness(db, {
          readinessTaskId: readiness.id,
          regressionTaskId: regression.id,
          reason: `stale PASS base ${verdict.verdict.baseHeadSha}; current pull request base is ${snapshot.baseSha}`,
        });
        result.stopped += 1;
        continue;
      }
      const diff = await reader.compareCommits(target.repository, snapshot.baseSha, verdict.verdict.headSha, controller.signal);
      const triggers = defenseTriggers(diff.files);
      const resolutionRows = await db.taskActivity.findMany({ where: { taskId: regression.id }, select: { metadata: true } });
      for (const row of resolutionRows) {
        const metadata = row.metadata as Record<string, unknown> | null;
        if (metadata?.kind !== MERGE_TAIL_KIND.repairResult || metadata.repairKind !== "refresh-conflict") continue;
        if (typeof metadata.startHeadSha !== "string" || typeof metadata.resolvedHeadSha !== "string") {
          triggers.push({ path: "<resolution-range>", reason: "existing-test-lines-unverifiable" });
          continue;
        }
        const resolution = await reader.compareCommits(target.repository, metadata.startHeadSha, metadata.resolvedHeadSha, controller.signal);
        triggers.push(...resolutionTestTriggers(resolution.files));
      }
      clearTimeout(timer);
      const review = await latestReviewState(db, readiness.id, verdict.verdict.headSha);
      if (triggers.length > 0 && review?.state !== "approved") {
        if (review?.state === "open") {
          await db.task.update({ where: { id: readiness.id }, data: { status: TaskStatus.REVIEW, failureReason: `independent-review-open:${String(review.reviewTaskId)}` } });
          result.reviewing += 1;
          continue;
        }
        const branchRun = await db.run.findFirst({
          where: { task: { projectId: readiness.projectId, chainId: readiness.chainId }, branch: { not: null } },
          select: { branch: true },
          orderBy: { createdAt: "desc" },
        });
        if (!branchRun?.branch) {
          await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: "chain branch is unavailable for independent review" });
          result.stopped += 1;
          continue;
        }
        const opened = await createReviewObligation(db, {
          readinessTask: readiness,
          regressionTaskId: regression.id,
          branch: branchRun.branch,
          baseSha: snapshot.baseSha,
          headSha: verdict.verdict.headSha,
          triggers,
        });
        if (!opened.ok) {
          await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: opened.reason });
          result.stopped += 1;
        } else {
          result.reviewing += 1;
        }
        continue;
      }
      const evidence = evidenceFromSnapshot(snapshot, randomUUID());
      if ("error" in evidence) {
        await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: evidence.error });
        result.stopped += 1;
        continue;
      }
      await db.$transaction(async (tx) => {
        const binding = `mechanical:${readiness.id}`;
        const payload = {
          ...evidence,
          mergeMethod: AUTHORIZED_MERGE_METHOD,
          issuedAt: now.toISOString(),
          decision: { channel: "mechanical" as const, inboxDecisionId: binding, inboxMessageId: binding },
        };
        const activity = await tx.taskActivity.create({ data: {
          taskId: readiness.id,
          actorType: "control-plane",
          body: `Mechanical merge authorized for PR #${target.prNumber} at ${evidence.headSha}`,
          metadata: authorizationMetadata(payload) as Prisma.InputJsonObject,
        } });
        await tx.taskStepOutput.upsert({
          where: { taskId: readiness.id },
          create: { taskId: readiness.id, kind: "merge-authorization", body: JSON.stringify({ authorizationActivityId: activity.id, headSha: evidence.headSha }), commitSha: evidence.headSha },
          update: { kind: "merge-authorization", body: JSON.stringify({ authorizationActivityId: activity.id, headSha: evidence.headSha }), commitSha: evidence.headSha },
        });
        await tx.task.update({ where: { id: readiness.id }, data: { status: TaskStatus.DONE, failureReason: null } });
        await tx.taskActivity.create({ data: {
          taskId: readiness.id,
          actorType: "control-plane",
          body: `Merge readiness authorized exact head ${evidence.headSha}; merge execution queued`,
          metadata: { kind: MERGE_TAIL_KIND.readiness, schemaVersion: 1, state: "authorized", headSha: evidence.headSha, authorizationActivityId: activity.id },
        } });
        await activateChainSuccessor(tx, readiness, {}, now);
      });
      result.authorized += 1;
    } catch (error: unknown) {
      await stopReadiness(db, { readinessTaskId: readiness.id, regressionTaskId: regression.id, reason: `readiness evaluation failed: ${error instanceof Error ? error.message : String(error)}` });
      result.stopped += 1;
    }
  }
  return result;
};

export const startReadinessWorker = (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
): ReturnType<typeof setInterval> => {
  const timer = setInterval(() => {
    void readinessTick(db, reader).catch((error: unknown) => console.error("Merge readiness tick failed", error));
  }, readinessPollIntervalMs());
  timer.unref?.();
  return timer;
};
