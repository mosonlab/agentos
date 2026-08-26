/**
 * The other side of the release-authority park.
 *
 * `handleRegressionCompletion` parks a regression-verification step and opens
 * an inbox message when the branch moved attested release-path files without
 * re-signing `release-authority.json`. The signature is the operator's to
 * produce, so nothing in the chain can resolve that park — but nothing has to
 * ask the operator to press a button either. This worker watches the pull
 * request and returns the step to the queue the moment the re-signed
 * attestation is on the branch. Whether the new signature is actually good is
 * not decided here: the re-run gate decides it, and a signature that still does
 * not cover the tree parks the step again, up to `MAX_AUTHORITY_RESIGN_ROUNDS`.
 */
import {
  AUTHORITY_RESIGN_OPEN_PREFIX,
  InboxStatus,
  MERGE_TAIL_KIND,
  Prisma,
  RELEASE_AUTHORITY_FILE,
  TaskStatus,
  asJsonObject,
  enqueueTaskRun,
  lockChainRows,
  lockTaskRow,
  resolveChainTarget,
  type PrismaClient,
} from "@agentos/db";

import { createGitHubReader, type GitHubReader } from "./github-read.js";

/**
 * Slower than the readiness poll on purpose: what this waits for is a person
 * fetching a branch and running a signing command, so a tighter loop would only
 * spend GitHub reads to learn the same thing.
 */
export const authorityResignPollIntervalMs = (): number => {
  const raw = Number(process.env.AUTHORITY_RESIGN_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : 30_000;
};

export const AUTHORITY_RESIGN_READ_BUDGET_MS = 20_000;

export type AuthorityResignTickResult = { resumed: number; waiting: number; unwatchable: number };

type ParkedRequest = { headSha: string; baseHeadSha: string; branch: string; round: number };

const latestOpenRequest = (rows: Array<{ metadata: Prisma.JsonValue | null }>): ParkedRequest | null => {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const metadata = asJsonObject(rows[index]?.metadata ?? null);
    if (metadata?.kind !== MERGE_TAIL_KIND.authorityResign || metadata.state !== "open") continue;
    if (typeof metadata.headSha !== "string" || typeof metadata.baseHeadSha !== "string"
      || typeof metadata.branch !== "string" || typeof metadata.round !== "number") return null;
    return {
      headSha: metadata.headSha,
      baseHeadSha: metadata.baseHeadSha,
      branch: metadata.branch,
      round: metadata.round,
    };
  }
  return null;
};

export const authorityResignTick = async (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
  now = new Date(),
  limit = 5,
): Promise<AuthorityResignTickResult> => {
  const result: AuthorityResignTickResult = { resumed: 0, waiting: 0, unwatchable: 0 };
  const parked = await db.task.findMany({
    where: {
      status: TaskStatus.REVIEW,
      failureReason: { startsWith: AUTHORITY_RESIGN_OPEN_PREFIX },
      templateStep: { outputKind: "regression-verification" },
    },
    include: { repo: { select: { defaultBranch: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  for (const task of parked) {
    const parkReason = task.failureReason;
    if (!parkReason) continue;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const activities = await db.taskActivity.findMany({
        where: { taskId: task.id }, select: { metadata: true }, orderBy: { createdAt: "asc" },
      });
      const request = latestOpenRequest(activities);
      if (!request) {
        // The park and the request that explains it are written in one
        // transaction, so this cannot happen without something having rewritten
        // the history. Say so instead of guessing a head to watch.
        console.error(`Authority resign park on task ${task.id} has no open request activity`);
        result.unwatchable += 1;
        continue;
      }
      if (!reader?.compareCommits) {
        console.error(`Authority resign park on task ${task.id} cannot be watched: no GitHub comparison reader`);
        result.unwatchable += 1;
        continue;
      }
      const target = await db.$transaction((tx) => resolveChainTarget(tx, task));
      if (!target.resolved) {
        console.error(`Authority resign park on task ${task.id} cannot be watched: pull-request target is ${target.unresolvable}`);
        result.unwatchable += 1;
        continue;
      }
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), AUTHORITY_RESIGN_READ_BUDGET_MS);
      const snapshot = await reader.readPullRequest(target.repository, target.prNumber, task.repo?.defaultBranch ?? "main", controller.signal);
      if (!snapshot.headRefOid || snapshot.headRefOid === request.headSha) {
        result.waiting += 1;
        continue;
      }
      if (!snapshot.baseSha) {
        result.waiting += 1;
        continue;
      }
      const diff = await reader.compareCommits(target.repository, snapshot.baseSha, snapshot.headRefOid, controller.signal);
      // The whole range, not the new commits: the attestation has to be
      // re-signed relative to the base this branch merges into, and a truncated
      // file list cannot show that it was.
      if (!diff.filesComplete || !diff.files.some((file) => file.filename === RELEASE_AUTHORITY_FILE)) {
        result.waiting += 1;
        continue;
      }
      const resumedHead = snapshot.headRefOid;
      const resumed = await db.$transaction(async (tx) => {
        const identity = await tx.task.findUnique({ where: { id: task.id }, select: { projectId: true, chainId: true } });
        if (!identity) return false;
        if (identity.chainId) await lockChainRows(tx, { projectId: identity.projectId, chainId: identity.chainId });
        else await lockTaskRow(tx, task.id);
        const claimed = await tx.task.updateMany({
          where: { id: task.id, status: TaskStatus.REVIEW, failureReason: parkReason },
          data: { status: TaskStatus.TODO, failureReason: null },
        });
        if (claimed.count !== 1) return false;
        await enqueueTaskRun(tx, task.id, now);
        await tx.taskActivity.create({ data: {
          taskId: task.id,
          actorType: "control-plane",
          body: `Re-signed ${RELEASE_AUTHORITY_FILE} observed on ${request.branch}; regression verification re-queued at ${resumedHead}`,
          metadata: {
            kind: MERGE_TAIL_KIND.authorityResign,
            schemaVersion: 1,
            state: "resumed",
            parkedHeadSha: request.headSha,
            headSha: resumedHead,
            branch: request.branch,
            round: request.round,
          },
        } });
        await tx.inboxMessage.updateMany({
          where: { dedupeKey: `authority-resign:${task.id}:${request.headSha}`, status: InboxStatus.OPEN },
          data: { status: InboxStatus.CLOSED, answeredAt: now },
        });
        return true;
      });
      if (resumed) result.resumed += 1;
      else result.waiting += 1;
    } catch (error: unknown) {
      // One unreadable pull request must not starve the other parks in this
      // tick. The park is left exactly as it is and the next tick tries again;
      // a condition that never clears keeps saying so, once per tick.
      console.error(`Authority resign park on task ${task.id} could not be evaluated`, error);
      result.unwatchable += 1;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return result;
};

export const startAuthorityResignWorker = (
  db: PrismaClient,
  reader: GitHubReader | null = createGitHubReader(),
): ReturnType<typeof setInterval> => {
  const timer = setInterval(() => {
    void authorityResignTick(db, reader).catch((error: unknown) => console.error("Authority resign tick failed", error));
  }, authorityResignPollIntervalMs());
  timer.unref?.();
  return timer;
};
