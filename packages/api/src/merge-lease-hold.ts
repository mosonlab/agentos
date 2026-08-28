import { createHash } from "node:crypto";

import {
  MERGE_TAIL_KIND,
  MERGE_TAIL_SCHEMA_VERSION,
  type Prisma,
  type PrismaClient,
} from "@anneal/db";

/** What one `merge-lease.sh release` did. */
export type MergeLeaseRelease =
  | { outcome: "released"; ref: string; sha: string; acquiredAt: string }
  | { outcome: "not-held" }
  | { outcome: "skipped"; heldFor: string }
  | { outcome: "refused"; heldBy: string }
  | { outcome: "unreachable"; detail: string };

/** The project-scoped identity of a Chain's external merge lease. */
export type MergeLeaseTarget = {
  projectId: string;
  chainId: string;
};

export type MergeLeaseHold = {
  acquiredAt: Date;
  releasedAt: Date;
  heldForSeconds: number;
};

/** Calculate a non-negative whole-second hold from the lease blob timestamp. */
export const mergeLeaseHold = (acquiredAt: string, releasedAt: Date): MergeLeaseHold | null => {
  const acquiredAtMs = Date.parse(acquiredAt);
  const releasedAtMs = releasedAt.getTime();
  if (!Number.isFinite(acquiredAtMs) || !Number.isFinite(releasedAtMs)) return null;
  return {
    acquiredAt: new Date(acquiredAtMs),
    releasedAt: new Date(releasedAtMs),
    // A clock adjustment must not produce a negative hold in the evidence.
    heldForSeconds: Math.max(0, Math.floor((releasedAtMs - acquiredAtMs) / 1_000)),
  };
};

export type MergeLeaseHoldRecordResult = "recorded" | "already-recorded" | "ignored";

/**
 * Stable primary key for a hold marker. TaskActivity has no semantic unique
 * constraint for metadata, so the existing primary key is the atomic replay
 * guard. The project and chain are included because two projects may use the
 * same chain id; the blob SHA is the lease event identity within that scope.
 */
const mergeLeaseHoldActivityId = (target: MergeLeaseTarget, leaseSha: string): string => (
  `merge-lease-hold:${createHash("sha256")
    .update(`${target.projectId}\u0000${target.chainId}\u0000${leaseSha}`)
    .digest("hex")}`
);

/**
 * Persist one confirmed release on the latest chain task in its project.
 *
 * A non-release is deliberately a no-op. Malformed confirmation and database
 * failures propagate so a control-plane path cannot silently lose evidence.
 */
export const recordMergeLeaseHold = async (
  db: PrismaClient,
  target: MergeLeaseTarget,
  release: MergeLeaseRelease,
  releasedAt: Date,
): Promise<MergeLeaseHoldRecordResult> => {
  if (release.outcome !== "released" || !release.ref || !release.sha) return "ignored";
  const hold = mergeLeaseHold(release.acquiredAt, releasedAt);
  if (!hold) {
    throw new Error("Cannot record confirmed merge lease release: invalid acquiredAt or releasedAt");
  }

  const task = await db.task.findFirst({
    where: {
      projectId: target.projectId,
      chainId: target.chainId,
      chainIndex: { not: null },
    },
    orderBy: [{ chainIndex: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!task) {
    throw new Error(`Cannot record merge lease hold: chain ${target.chainId} has no task in project ${target.projectId}`);
  }

  const created = await db.taskActivity.createMany({
    data: [{
      id: mergeLeaseHoldActivityId(target, release.sha),
      taskId: task.id,
      actorType: "control-plane",
      body: `Chain Lease released after ${hold.heldForSeconds} seconds`,
      metadata: {
        kind: MERGE_TAIL_KIND.leaseHold,
        schemaVersion: MERGE_TAIL_SCHEMA_VERSION,
        chainId: target.chainId,
        leaseRef: release.ref,
        leaseSha: release.sha,
        acquiredAt: hold.acquiredAt.toISOString(),
        releasedAt: hold.releasedAt.toISOString(),
        heldForSeconds: hold.heldForSeconds,
      } as Prisma.InputJsonObject,
    }],
    skipDuplicates: true,
  });
  return created.count === 0 ? "already-recorded" : "recorded";
};
