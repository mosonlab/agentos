import { randomUUID } from "node:crypto";

import {
  RunStatus,
  TaskStatus,
  type Prisma,
  type PrismaClient,
} from "@anneal/db";

import { lockTaskMutationRows } from "./task-write.js";

export const READINESS_CLAIM_LEASE_MS = 60_000;
const READINESS_CLAIM_PREFIX = "merge-readiness-claim:";

export type ReadinessLeaseOwnership = "released" | { retainFor: string };

/**
 * `keep` records work while this Handle remains the Step owner. `finish`
 * atomically applies the terminal transition, records any successor Run handoff,
 * and clears the claim before returning its Merge Lease ownership.
 */
export type ReadinessClaimTransition<T> =
  | {
    kind: "keep";
    apply: (tx: Prisma.TransactionClient) => Promise<T>;
  }
  | {
    kind: "finish";
    at: Date;
    apply: (tx: Prisma.TransactionClient) => Promise<{
      value: T;
      ownership: ReadinessLeaseOwnership;
    }>;
  };

export type ReadinessClaimSettlement<T> =
  | { settled: false; ownership: ReadinessLeaseOwnership }
  | { settled: true; claim: "retained"; value: T }
  | { settled: true; claim: "released"; value: T; ownership: ReadinessLeaseOwnership };

export interface ReadinessClaimHandle {
  /** Replaces the opaque CAS token and extends its expiry. False means ownership was lost. */
  renew(): Promise<boolean>;
  /** Applies work only while this Handle owns the locked readiness Step. */
  settle<T>(
    tx: Prisma.TransactionClient,
    transition: ReadinessClaimTransition<T>,
  ): Promise<ReadinessClaimSettlement<T>>;
  /** Classifies a lost claim; database errors propagate instead of guessing ownership. */
  ownershipAfterLoss(client: PrismaClient | Prisma.TransactionClient): Promise<ReadinessLeaseOwnership>;
}

type ClaimState = {
  token: string;
  expiresAt: Date;
};

const newClaimState = (now: Date): ClaimState => ({
  token: `${READINESS_CLAIM_PREFIX}${randomUUID()}`,
  expiresAt: new Date(now.getTime() + READINESS_CLAIM_LEASE_MS),
});

const expiredLegacyClaim = (reason: string | null, now: Date): boolean => {
  // Remove this bridge after every deployment has crossed the claim-handle
  // migration and its orphaned pre-migration claims have been swept.
  if (!reason?.startsWith(READINESS_CLAIM_PREFIX)) return false;
  const expiry = Date.parse(reason.slice(reason.lastIndexOf("|") + 1));
  return Number.isFinite(expiry) && expiry <= now.getTime();
};

const ownershipAfterLoss = async (
  client: PrismaClient | Prisma.TransactionClient,
  taskId: string,
): Promise<ReadinessLeaseOwnership> => {
  const current = await client.task.findUnique({
    where: { id: taskId },
    select: {
      status: true,
      readinessClaimToken: true,
      projectId: true,
      chainId: true,
      chainIndex: true,
    },
  });
  const activeSuccessor = current?.status === TaskStatus.DONE
    || (current?.status === TaskStatus.DOING && current.readinessClaimToken !== null);
  if (!activeSuccessor || !current.chainId) return "released";

  const handoff = await client.run.findFirst({
    where: {
      task: {
        projectId: current.projectId,
        chainId: current.chainId,
        chainIndex: { gt: current.chainIndex ?? -1 },
      },
      status: {
        in: [RunStatus.QUEUED, RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING],
      },
    },
    select: { id: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return handoff ? { retainFor: handoff.id } : "released";
};

class ReadinessClaim implements ReadinessClaimHandle {
  constructor(
    private readonly db: PrismaClient,
    private readonly taskId: string,
    private state: ClaimState,
  ) {}

  async renew(): Promise<boolean> {
    const renewed = newClaimState(new Date());
    const held = await this.db.$transaction(async (tx) => {
      await lockTaskMutationRows(tx, this.taskId);
      return tx.task.updateMany({
        where: {
          id: this.taskId,
          status: TaskStatus.DOING,
          readinessClaimToken: this.state.token,
        },
        data: {
          readinessClaimToken: renewed.token,
          readinessClaimExpiresAt: renewed.expiresAt,
        },
      });
    });
    if (held.count !== 1) return false;
    this.state = renewed;
    return true;
  }

  async settle<T>(
    tx: Prisma.TransactionClient,
    transition: ReadinessClaimTransition<T>,
  ): Promise<ReadinessClaimSettlement<T>> {
    await lockTaskMutationRows(tx, this.taskId);
    const held = await tx.task.findUnique({
      where: { id: this.taskId },
      select: { status: true, readinessClaimToken: true },
    });
    if (held?.status !== TaskStatus.DOING || held.readinessClaimToken !== this.state.token) {
      return { settled: false, ownership: await this.ownershipAfterLoss(tx) };
    }

    if (transition.kind === "keep") {
      return { settled: true, claim: "retained", value: await transition.apply(tx) };
    }

    const finished = await transition.apply(tx);
    await tx.task.update({
      where: { id: this.taskId },
      data: { readinessClaimToken: null, readinessClaimExpiresAt: null },
    });
    return {
      settled: true,
      claim: "released",
      value: finished.value,
      ownership: finished.ownership,
    };
  }

  ownershipAfterLoss(
    client: PrismaClient | Prisma.TransactionClient,
  ): Promise<ReadinessLeaseOwnership> {
    return ownershipAfterLoss(client, this.taskId);
  }
}

export const claimReadinessStep = async (
  db: PrismaClient,
  taskId: string,
  now: Date,
): Promise<ReadinessClaimHandle | null> => {
  const state = newClaimState(now);
  const claimed = await db.$transaction(async (tx) => {
    await lockTaskMutationRows(tx, taskId);
    const current = await tx.task.findUnique({
      where: { id: taskId },
      select: {
        status: true,
        failureReason: true,
        readinessClaimToken: true,
        readinessClaimExpiresAt: true,
      },
    });
    const legacyClaimAvailable = current?.status === TaskStatus.DOING
      && current.readinessClaimToken === null
      && current.readinessClaimExpiresAt === null
      && expiredLegacyClaim(current.failureReason, now);
    const available = current?.status === TaskStatus.TODO
      || (current?.status === TaskStatus.DOING
        && current.readinessClaimToken !== null
        && current.readinessClaimExpiresAt !== null
        && current.readinessClaimExpiresAt.getTime() <= now.getTime())
      || legacyClaimAvailable;
    if (!available) return false;

    const acquired = await tx.task.updateMany({
      where: current.status === TaskStatus.TODO
        ? { id: taskId, status: TaskStatus.TODO }
        : {
          id: taskId,
          status: TaskStatus.DOING,
          readinessClaimToken: current.readinessClaimToken,
          readinessClaimExpiresAt: current.readinessClaimExpiresAt,
          ...(legacyClaimAvailable ? { failureReason: current.failureReason } : {}),
        },
      data: {
        status: TaskStatus.DOING,
        failureReason: null,
        readinessClaimToken: state.token,
        readinessClaimExpiresAt: state.expiresAt,
      },
    });
    return acquired.count === 1;
  });
  return claimed ? new ReadinessClaim(db, taskId, state) : null;
};
