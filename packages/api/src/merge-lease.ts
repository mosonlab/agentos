import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  executionModeFor,
  isRegressionVerificationOutputKind,
  latestMarker,
  MERGE_TAIL_KIND,
  readMarkers,
  type Prisma,
  type PrismaClient,
} from "@anneal/db";
import {
  recordMergeLeaseHold,
  type MergeLeaseRelease,
  type MergeLeaseTarget,
} from "./merge-lease-hold.js";
import { DONE_TASK_ARCHIVE_AGE_MS } from "./scheduler.js";

const execFileAsync = promisify(execFile);

export const mergeLeaseScriptPath = (environment: NodeJS.ProcessEnv = process.env): string =>
  environment.AGENTOS_RELEASE_ROOT
    ? join(resolve(environment.AGENTOS_RELEASE_ROOT), "scripts/merge-lease.sh")
    : fileURLToPath(new URL("../../../scripts/merge-lease.sh", import.meta.url));

const mergeLeaseScript = mergeLeaseScriptPath();

/**
 * What one `merge-lease.sh release` did. The script has four outcomes and three
 * of them exit 0, so the exit code cannot tell them apart -- and the one that
 * matters, a lease left standing because it is held for another task, looked
 * exactly like a lease this caller had freed. `unreachable` is the fifth: the
 * release never got far enough to say anything.
 */
export type MergeLeaseReleaser = (chainId: string) => Promise<MergeLeaseRelease>;

// The line scripts/merge-lease.sh prints beside its prose for the operator.
const MACHINE_LINE = /^MERGE LEASE: (.+)$/mu;

/** Parse the machine-readable result emitted after a release attempt. */
export const readMergeLeaseRelease = (output: string): MergeLeaseRelease | null => {
  const spoken = MACHINE_LINE.exec(output)?.[1]?.trim();
  if (!spoken) return null;
  const [outcome, ...tokens] = spoken.split(" ");
  switch (outcome) {
    case "released": {
      const [ref, sha, acquiredAt, ...extra] = tokens;
      if (ref === undefined || sha === undefined || acquiredAt === undefined || extra.length > 0) return null;
      return { outcome: "released", ref, sha, acquiredAt };
    }
    case "not-held":
      return tokens.length === 0 ? { outcome: "not-held" } : null;
    case "skipped":
      return tokens.length === 1 && tokens[0] !== undefined ? { outcome: "skipped", heldFor: tokens[0] } : null;
    case "refused":
      return tokens.length === 1 && tokens[0] !== undefined ? { outcome: "refused", heldBy: tokens[0] } : null;
    default:
      return null;
  }
};

const releaseMergeLeaseAdapter: MergeLeaseReleaser = async (chainId) => {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [mergeLeaseScript, "release", "--task", chainId], {
      timeout: 90_000,
      encoding: "utf8",
    });
    const detail = `${stdout}${stderr}`.trim();
    if (detail) console.log(detail);
    return readMergeLeaseRelease(detail) ?? { outcome: "unreachable", detail: detail || "the release printed nothing" };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string };
    const detail = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    console.error(`Merge lease release failed for chain ${chainId}${detail ? `: ${detail}` : ""}`);
    // A refusal is the one non-zero exit the script means: it read the lease and
    // declined to break it. Anything else never got that far, so the state of
    // the lock on main is unknown rather than decided.
    const spoken = readMergeLeaseRelease(detail);
    if (spoken?.outcome === "refused") return spoken;
    return { outcome: "unreachable", detail: detail || String(error) };
  }
};

const releaseMergeLeaseWith = async (
  releaser: MergeLeaseReleaser,
  target: MergeLeaseTarget | null,
): Promise<MergeLeaseRelease | null> => {
  if (!target) return null;
  const release = await releaser(target.chainId);
  reportMergeLeaseAnomaly(target.chainId, release);
  if (release.outcome === "unreachable") {
    throw new Error(`Merge lease release for chain ${target.chainId} failed with outcome ${release.outcome}`);
  }
  return release;
};

export type ReleaseMergeLease = (target: MergeLeaseTarget | null, db: PrismaClient) => Promise<void>;

export const releaseMergeLease: ReleaseMergeLease = async (target, db) => {
  const release = await releaseMergeLeaseWith(releaseMergeLeaseAdapter, target);
  if (target && release?.outcome === "released") {
    await recordMergeLeaseHold(db, target, release, new Date());
  }
};

/**
 * Say out loud that a release did not free the lock it was asked to free.
 * `released` and `not-held` are the ordinary answers. The other three are
 * anomalies on the Lease that serialises the merge window on main -- the Lease is
 * still standing, or nobody knows whether it is -- and they arrive on a path
 * that otherwise reports nothing at all. The caller has no reporting
 * obligation: every release adapter result is consumed inside this module.
 */
const reportMergeLeaseAnomaly = (chainId: string, release: MergeLeaseRelease): void => {
  switch (release.outcome) {
    case "released":
    case "not-held":
      return;
    case "skipped":
      console.error(
        `Merge lease anomaly: the release for chain ${chainId} was skipped because the lease is held for task ${release.heldFor}. The merge window on main is still locked and this chain is not the holder.`,
      );
      return;
    case "refused":
      console.error(
        `Merge lease anomaly: the release for chain ${chainId} was refused because the lease is held by ${release.heldBy}. The merge window on main is still locked by another machine.`,
      );
      return;
    case "unreachable":
      console.error(
        `Merge lease anomaly: the release for chain ${chainId} could not be carried out: ${release.detail}. Whether the merge window on main is still locked is unknown.`,
      );
  }
};

/**
 * The chain whose merge lease a Task's run holds, or null when that Task is not
 * part of the merge tail. This mirrors the completion path's `tailLeaseChainId`:
 * the mechanical merge step consumes the current readiness handoff. Regression
 * and auxiliary shapes remain here as cleanup identities for older retained
 * handoffs and interrupted generations; their release is idempotent when the
 * current readiness-owned protocol holds no Lease yet. An auxiliary task
 * answers for the Regression chain it serves rather than for a chain of its
 * own. It reads the same marker window the completion path reads because it is
 * the same question, which is why the window no longer needs restating here.
 */
export type LeaseHolder = {
  chainId: string;
  projectId: string;
  taskId: string;
  role: "mechanical" | "regression" | "auxiliary";
};

export const leaseHolderFor = async (
  tx: Prisma.TransactionClient,
  taskId: string | null,
): Promise<LeaseHolder | null> => {
  if (!taskId) return null;
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      chainId: true,
      projectId: true,
      templateStep: { select: {
        stepIndex: true,
        outputKind: true,
        taskTemplate: { select: { name: true } },
      } },
    },
  });
  if (!task) return null;
  const directRole = executionModeFor(task.templateStep) === "mechanical"
    ? "mechanical" as const
    : isRegressionVerificationOutputKind(task.templateStep?.outputKind)
      ? "regression" as const
      : null;
  if (directRole) {
    return task.chainId
      ? { chainId: task.chainId, projectId: task.projectId, taskId, role: directRole }
      : null;
  }
  const markers = await readMarkers(tx, taskId);
  const auxiliaryRegressionTaskId = latestMarker(markers, "repairAttempt")?.regressionTaskId ?? null;
  if (!auxiliaryRegressionTaskId) return null;
  const regression = await tx.task.findUnique({
    where: { id: auxiliaryRegressionTaskId },
    select: { chainId: true, projectId: true },
  });
  return regression?.chainId
    ? { chainId: regression.chainId, projectId: regression.projectId, taskId, role: "auxiliary" }
    : null;
};

export type LeaseOutcome =
  | { kind: "continue" }
  | {
    kind: "stop";
    taskId: string | null;
    releasedHandoff?: { toRunId: string; at: Date };
  }
  | { kind: "hand-off"; taskId: string | null; handoffRunId: string; at: Date };

type LeaseSettlement = {
  target: MergeLeaseTarget | null;
  releasedHandoff: { chainId: string; toRunId: string; taskId: string; at: Date } | null;
};

/** Resolve one declared outcome to the module-owned holder and persistence. */
const settleLease = async (
  tx: Prisma.TransactionClient,
  outcome: LeaseOutcome,
): Promise<LeaseSettlement> => {
  if (outcome.kind === "continue") return { target: null, releasedHandoff: null };
  const holder = await leaseHolderFor(tx, outcome.taskId);
  if (outcome.kind === "hand-off") {
    if (!holder) throw new Error(`Cannot hand off a Merge Lease from Task ${outcome.taskId ?? "without a Task"}`);
    await noteLeaseHandoff(tx, {
      chainId: holder.chainId,
      toRunId: outcome.handoffRunId,
      at: outcome.at,
    });
    return { target: null, releasedHandoff: null };
  }
  if (outcome.releasedHandoff && !holder) {
    throw new Error(`Cannot settle a Merge Lease handoff from Task ${outcome.taskId ?? "without a Task"}`);
  }
  return {
    target: holder
      ? { chainId: holder.chainId, projectId: holder.projectId }
      : null,
    releasedHandoff: holder && outcome.releasedHandoff
      ? {
        chainId: holder.chainId,
        toRunId: outcome.releasedHandoff.toRunId,
        taskId: holder.taskId,
        at: outcome.releasedHandoff.at,
      }
      : null,
  };
};

const LEASE_HANDOFF_GRACE_MS = 60_000;
const LEASE_HANDOFF_QUERY_LIMIT = 100;

/** Persist the queued Run that must consume a retained Chain Lease. */
const noteLeaseHandoff = async (
  tx: Prisma.TransactionClient,
  input: { chainId: string; toRunId: string; at: Date },
): Promise<void> => {
  const run = await tx.run.findUnique({ where: { id: input.toRunId }, select: { taskId: true, readyAt: true } });
  if (!run?.taskId) throw new Error(`Lease handoff target Run ${input.toRunId} has no Task`);
  await tx.taskActivity.create({ data: {
    taskId: run.taskId,
    actorType: "control-plane",
    body: `Chain Lease handed to queued Run ${input.toRunId}`,
    metadata: {
      kind: MERGE_TAIL_KIND.leaseHandoff,
      schemaVersion: 1,
      state: "pending",
      chainId: input.chainId,
      toRunId: input.toRunId,
      handedOffAt: input.at.toISOString(),
      consumerReadyAt: run.readyAt.toISOString(),
    },
  } });
};

/** Find retained handoffs whose queued Run never became a Lease consumer. */
export const leaseHandoffsWithoutConsumer = async (
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<Array<{ toRunId: string; taskId: string }>> => {
  const activityFloor = new Date(now.getTime() - DONE_TASK_ARCHIVE_AGE_MS);
  const staleBefore = new Date(now.getTime() - LEASE_HANDOFF_GRACE_MS).toISOString();
  return tx.$queryRaw<Array<{ toRunId: string; taskId: string }>>`
    WITH unresolved AS (
      SELECT DISTINCT ON (pending.metadata->>'toRunId')
        pending.metadata->>'toRunId' AS "toRunId",
        pending."taskId" AS "taskId",
        pending."createdAt" AS "createdAt",
        pending.id
      FROM "TaskActivity" AS pending
      JOIN "Run" AS consumer ON consumer.id = pending.metadata->>'toRunId'
      WHERE pending."createdAt" >= ${activityFloor}
        AND pending."actorType" = 'control-plane'
        AND pending.metadata->>'kind' = ${MERGE_TAIL_KIND.leaseHandoff}
        AND pending.metadata->>'state' = 'pending'
        AND pending.metadata->>'chainId' IS NOT NULL
        AND pending.metadata->>'toRunId' IS NOT NULL
        AND GREATEST(
          pending.metadata->>'handedOffAt',
          COALESCE(pending.metadata->>'consumerReadyAt', pending.metadata->>'handedOffAt')
        ) < ${staleBefore}
        AND consumer.status = 'queued'::"RunStatus"
        AND consumer."claimedAt" IS NULL
        AND consumer."startedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "TaskActivity" AS released
          WHERE released."createdAt" >= ${activityFloor}
            AND released."actorType" = 'control-plane'
            AND released.metadata->>'kind' = ${MERGE_TAIL_KIND.leaseHandoff}
            AND released.metadata->>'state' = 'released'
            AND released.metadata->>'toRunId' = pending.metadata->>'toRunId'
            AND (released."createdAt", released.id) > (pending."createdAt", pending.id)
        )
      ORDER BY pending.metadata->>'toRunId', pending."createdAt" DESC, pending.id DESC
    )
    SELECT "toRunId", "taskId"
    FROM unresolved
    ORDER BY "createdAt" ASC, id ASC
    LIMIT ${LEASE_HANDOFF_QUERY_LIMIT}
  `;
};

/** Record a completed orphan-handoff release after the external release attempt. */
const noteLeaseHandoffReleased = async (
  tx: Prisma.TransactionClient,
  input: { chainId: string; toRunId: string; taskId: string; at: Date },
): Promise<void> => {
  await tx.taskActivity.create({ data: {
    taskId: input.taskId,
    actorType: "control-plane",
    body: `Queued Run ${input.toRunId} did not consume its Chain Lease handoff`,
    metadata: {
      kind: MERGE_TAIL_KIND.leaseHandoff,
      schemaVersion: 1,
      state: "released",
      chainId: input.chainId,
      toRunId: input.toRunId,
      releasedAt: input.at.toISOString(),
    },
  } });
};

export type TransactionLeaseOutcome<T> = {
  value: T;
  leaseOutcome: LeaseOutcome;
};

export type CommitWithLeaseOutcomeOptions = {
  release?: ReleaseMergeLease | undefined;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

type CommittedLeaseOutcome<T> = {
  value: T;
  settlement: LeaseSettlement;
};

const releaseCommittedLeaseOutcomes = async (
  db: PrismaClient,
  committed: Array<CommittedLeaseOutcome<unknown>>,
  release: ReleaseMergeLease,
  aggregateFailures: boolean,
): Promise<void> => {
  const targets = new Map<string, {
    target: MergeLeaseTarget;
    handoffs: Array<NonNullable<LeaseSettlement["releasedHandoff"]>>;
  }>();
  for (const entry of committed) {
    const target = entry.settlement.target;
    if (!target) continue;
    const key = JSON.stringify([target.projectId, target.chainId]);
    const existing = targets.get(key) ?? { target, handoffs: [] };
    if (entry.settlement.releasedHandoff) existing.handoffs.push(entry.settlement.releasedHandoff);
    targets.set(key, existing);
  }

  const failures: unknown[] = [];
  for (const entry of targets.values()) {
    try {
      await release(entry.target, db);
      if (entry.handoffs.length > 0) {
        await db.$transaction(async (tx) => {
          for (const handoff of entry.handoffs) await noteLeaseHandoffReleased(tx, handoff);
        });
      }
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length === 1 && !aggregateFailures) throw failures[0];
  if (failures.length > 0) throw new AggregateError(failures, "One or more Merge Lease releases or records failed");
};

/** Commit database state before carrying out its one post-commit Lease release. */
export const commitWithLeaseOutcome = async <T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<TransactionLeaseOutcome<T> | null>,
  options: CommitWithLeaseOutcomeOptions = {},
): Promise<T | null> => {
  const committed = await db.$transaction(async (tx) => {
    const result = await fn(tx);
    if (result === null) return null;
    return {
      value: result.value,
      settlement: await settleLease(tx, result.leaseOutcome),
    };
  }, options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined);
  if (committed === null) return null;
  await releaseCommittedLeaseOutcomes(db, [committed], options.release ?? releaseMergeLease, false);
  return committed.value;
};

/** Commit a reconciliation batch, deduplicating its post-commit Lease targets. */
export const commitWithLeaseOutcomes = async <T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<{ value: T; leaseOutcomes: LeaseOutcome[] }>,
  options: CommitWithLeaseOutcomeOptions = {},
): Promise<T> => {
  const committed = await db.$transaction(async (tx) => {
    const result = await fn(tx);
    const settlements: LeaseSettlement[] = [];
    for (const outcome of result.leaseOutcomes) settlements.push(await settleLease(tx, outcome));
    return {
      value: result.value,
      settlements,
    };
  }, options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined);
  await releaseCommittedLeaseOutcomes(
    db,
    committed.settlements.map((settlement) => ({ value: undefined, settlement })),
    options.release ?? releaseMergeLease,
    true,
  );
  return committed.value;
};

/**
 * What one `merge-lease.sh acquire --timeout-minutes 0` did. Unlike release,
 * the exit code alone separates these, so there is no machine line to read: 0
 * means this chain holds the lease -- freshly taken, or already held for the
 * same task id, which is what its own regression run leaves behind -- and 75
 * means somebody else holds it. Anything else never got far enough to say.
 */
export type MergeLeaseAcquisition =
  | { outcome: "acquired" }
  | { outcome: "contended" }
  | { outcome: "unreachable"; detail: string };

export type MergeLeaseAcquirer = (chainId: string) => Promise<MergeLeaseAcquisition>;

const CONTENDED_EXIT = 75;

/**
 * One attempt, never a poll. The caller is the readiness tick, which cannot
 * block on a lock another delivery line may hold for minutes; a tick that
 * cannot take the lease leaves its step claimed and comes back. The reason
 * string matches the one the chain's own regression run writes, so an operator
 * reading `merge-lease.sh status` sees the same lease either way.
 */
const acquireMergeLease: MergeLeaseAcquirer = async (chainId) => {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [
      mergeLeaseScript,
      "acquire",
      "--task",
      chainId,
      "--reason",
      `chain merge tail ${chainId}`,
      "--timeout-minutes",
      "0",
    ], { timeout: 30_000, encoding: "utf8" });
    const detail = `${stdout}${stderr}`.trim();
    if (detail) console.log(detail);
    return { outcome: "acquired" };
  } catch (error: unknown) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (failure.code === CONTENDED_EXIT) return { outcome: "contended" };
    const detail = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    console.error(`Merge lease acquire failed for chain ${chainId}${detail ? `: ${detail}` : ""}`);
    return { outcome: "unreachable", detail: detail || String(error) };
  }
};

export type HeldLeaseOutcome =
  | { kind: "continue" }
  | { kind: "stop" };

export type MergeLeaseDependencies = {
  acquire: MergeLeaseAcquirer;
  release: MergeLeaseReleaser;
  now?: () => Date;
};

export type WithMergeLease = <T>(
  target: MergeLeaseTarget | null,
  fn: () => Promise<{ leaseOutcome: HeldLeaseOutcome; value: T }>,
  db: PrismaClient,
  dependencies?: MergeLeaseDependencies,
) => Promise<
  | { outcome: "contended" }
  | { outcome: "unreachable"; detail: string }
  | { outcome: "ran"; value: T }
>;

/**
 * Run one authorization attempt under the Chain's merge Lease. A successful
 * authorization continues the Lease for mechanical merge after its handoff
 * was persisted by commitWithLeaseOutcome; every stop or exceptional callback
 * path gives it back here.
 * A Task without a Chain has no Lease to acquire or release, but still runs the
 * callback through the same interface.
 */
export const withMergeLease = async <T>(
  target: MergeLeaseTarget | null,
  fn: () => Promise<{ leaseOutcome: HeldLeaseOutcome; value: T }>,
  db: PrismaClient,
  dependencies: MergeLeaseDependencies = {
    acquire: acquireMergeLease,
    release: releaseMergeLeaseAdapter,
  },
): Promise<
  | { outcome: "contended" }
  | { outcome: "unreachable"; detail: string }
  | { outcome: "ran"; value: T }
> => {
  if (target === null) {
    const result = await fn();
    return { outcome: "ran", value: result.value };
  }

  const acquisition = await dependencies.acquire(target.chainId);
  if (acquisition.outcome === "contended") return { outcome: "contended" };
  if (acquisition.outcome === "unreachable") {
    return { outcome: "unreachable", detail: acquisition.detail };
  }

  let leaseOutcome: HeldLeaseOutcome = { kind: "stop" };
  let callbackFailed = false;
  let callbackError: unknown;
  let result: { leaseOutcome: HeldLeaseOutcome; value: T } | undefined;
  try {
    result = await fn();
    leaseOutcome = result.leaseOutcome;
  } catch (error: unknown) {
    callbackFailed = true;
    callbackError = error;
  }
  if (leaseOutcome.kind === "stop") {
    try {
      const release = await releaseMergeLeaseWith(dependencies.release, target);
      if (release?.outcome === "released") {
        await recordMergeLeaseHold(db, target, release, dependencies.now?.() ?? new Date());
      }
    } catch (releaseError: unknown) {
      if (callbackFailed) {
        throw new AggregateError(
          [callbackError, releaseError],
          "Merge lease callback and confirmed-release recording both failed",
        );
      }
      throw releaseError;
    }
  }
  if (callbackFailed) throw callbackError;
  return { outcome: "ran", value: result!.value };
};
