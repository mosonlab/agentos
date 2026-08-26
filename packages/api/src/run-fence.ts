import { Prisma, RunStatus } from "@agentos/db";

/**
 * The statuses a lease can still be live under. Distinct from the database
 * package's `ACTIVE_RUN_STATUSES`, which answers "does this task already have a
 * run?" and therefore includes QUEUED -- a queued run has no runner, no fencing
 * token and no lease, so it can never satisfy a fence.
 */
export const activeRunStatuses: RunStatus[] = [
  RunStatus.CLAIMED,
  RunStatus.PROVISIONING,
  RunStatus.RUNNING,
  RunStatus.WAITING_INBOX,
];

/**
 * One request's claim to still own a run.
 *
 * `at` is required, and that is the point: the instant a fence is asked about
 * is a decision the caller has to make once, at route entry, rather than a
 * `new Date()` evaluated wherever a `where` happens to be built. Two fencing
 * predicates in one request used to be able to disagree about whether a lease
 * expiring between them was live; with `at` there is nowhere to write the
 * second instant.
 *
 * `runnerId` is absent for the session-principal routes, whose caller holds a
 * session token rather than a runner identity.
 *
 * `statuses` narrows the fence for a route that acts on a subset of the live
 * statuses -- `/runner/runs/:runId/start` admits only a run that has not
 * started yet. It lives on the fence so that the predicate and its explanation
 * cannot disagree about which statuses were required.
 */
export type RunFence = {
  runId: string;
  runnerId?: string;
  fencingToken: string;
  at: Date;
  statuses?: RunStatus[];
};

/** Why a fenced query matched nothing. Ordered from the most specific cause to
 *  the least: a run that does not exist is `unknown-run`, never `stale-fence`. */
export type FenceRefusal =
  | "unknown-run"
  | "wrong-runner"
  | "stale-fence"
  | "cancel-requested"
  | "lease-expired"
  | "not-active";

/** The six clauses that make a run this request's to write. */
export const fencedRunWhere = (fence: RunFence): Prisma.RunWhereInput => ({
  id: fence.runId,
  ...(fence.runnerId === undefined ? {} : { runnerId: fence.runnerId }),
  fencingToken: fence.fencingToken,
  cancelRequestedAt: null,
  leaseExpiresAt: { gt: fence.at },
  status: { in: fence.statuses ?? activeRunStatuses },
});

/**
 * Names which clause of the fence the run failed.
 *
 * Runs on the miss path only, where the request is already being refused and
 * one more read costs nothing. Calling it on the hit path both wastes a query
 * and answers a question nobody asked.
 *
 * The fallback is `stale-fence`: every enumerated cause has been ruled out, so
 * either the row changed between the refusal and this read, or the route added
 * a clause of its own on top of the fence -- the session routes' fence on
 * `leaseGeneration`, which is a superseded fence by another name.
 */
export const explainFenceRefusal = async (
  tx: Prisma.TransactionClient,
  fence: RunFence,
): Promise<FenceRefusal> => {
  const run = await tx.run.findUnique({
    where: { id: fence.runId },
    select: { runnerId: true, fencingToken: true, cancelRequestedAt: true, leaseExpiresAt: true, status: true },
  });
  if (!run) return "unknown-run";
  if (fence.runnerId !== undefined && run.runnerId !== fence.runnerId) return "wrong-runner";
  if (run.fencingToken !== fence.fencingToken) return "stale-fence";
  if (run.cancelRequestedAt !== null) return "cancel-requested";
  if (run.leaseExpiresAt === null || run.leaseExpiresAt <= fence.at) return "lease-expired";
  if (!(fence.statuses ?? activeRunStatuses).includes(run.status)) return "not-active";
  return "stale-fence";
};
