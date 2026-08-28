import { createHash } from "node:crypto";

import {
  MERGE_TAIL_KIND,
  MERGE_TAIL_SCHEMA_VERSION,
  type Prisma,
  type PrismaClient,
} from "@anneal/db";

/** The identity needed to attribute one external merge lease to a chain. */
export type MergeLeaseTarget = {
  projectId: string;
  chainId: string;
};

/**
 * The release result consumed by the recorder. Keeping the non-release arms in
 * this type makes the guard at the persistence boundary explicit: only a
 * release that confirmed deletion and returned the blob timestamp is evidence
 * of a held lease.
 */
export type MergeLeaseReleaseForHold =
  | { outcome: "released"; ref: string; sha: string; acquiredAt: string }
  | { outcome: "not-held" }
  | { outcome: "skipped"; heldFor: string }
  | { outcome: "refused"; heldBy: string }
  | { outcome: "unreachable"; detail: string };

export type MergeLeaseHold = {
  acquiredAt: Date;
  releasedAt: Date;
  heldForSeconds: number;
};

export type MergeLeaseHoldRecordResult = "recorded" | "already-recorded" | "ignored";

/**
 * Calculate whole elapsed seconds from the timestamp persisted in a lease blob.
 * Invalid timestamps produce no evidence, and a clock adjustment is clamped to
 * zero so a hold record never claims a negative duration.
 */
export const mergeLeaseHold = (
  acquiredAt: string,
  releasedAt: Date,
): MergeLeaseHold | null => {
  if (typeof acquiredAt !== "string") return null;
  const acquiredAtMs = Date.parse(acquiredAt);
  const releasedAtMs = releasedAt.getTime();
  if (!Number.isFinite(acquiredAtMs) || !Number.isFinite(releasedAtMs)) return null;
  return {
    acquiredAt: new Date(acquiredAtMs),
    releasedAt: new Date(releasedAtMs),
    heldForSeconds: Math.max(0, Math.floor((releasedAtMs - acquiredAtMs) / 1_000)),
  };
};

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
 * A non-release, malformed timestamp, or missing confirmation is deliberately a
 * no-op. Database failures propagate to the caller so a control-plane path
 * cannot report that evidence was stored when the write failed.
 */
export const recordMergeLeaseHold = async (
  db: PrismaClient,
  target: MergeLeaseTarget,
  release: MergeLeaseReleaseForHold,
  releasedAt: Date,
): Promise<MergeLeaseHoldRecordResult> => {
  if (release.outcome !== "released" || !release.ref || !release.sha) return "ignored";
  const hold = mergeLeaseHold(release.acquiredAt, releasedAt);
  if (!hold) return "ignored";

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
