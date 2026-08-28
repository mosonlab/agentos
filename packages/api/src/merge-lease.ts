import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  executionModeFor,
  isRegressionVerificationOutputKind,
  latestMarker,
  MERGE_TAIL_KIND,
  readMarkers,
  RunStatus,
  type Prisma,
  type PrismaClient,
} from "@anneal/db";

const execFileAsync = promisify(execFile);

const mergeLeaseScript = fileURLToPath(new URL("../../../scripts/merge-lease.sh", import.meta.url));

/**
 * What one `merge-lease.sh release` did. The script has four outcomes and three
 * of them exit 0, so the exit code cannot tell them apart -- and the one that
 * matters, a lease left standing because it is held for another task, looked
 * exactly like a lease this caller had freed. `unreachable` is the fifth: the
 * release never got far enough to say anything.
 */
export type MergeLeaseRelease =
  | { outcome: "released"; ref: string; sha: string }
  | { outcome: "not-held" }
  | { outcome: "skipped"; heldFor: string }
  | { outcome: "refused"; heldBy: string }
  | { outcome: "unreachable"; detail: string };

export type MergeLeaseReleaser = (chainId: string) => Promise<MergeLeaseRelease>;

// The line scripts/merge-lease.sh prints beside its prose for the operator.
const MACHINE_LINE = /^MERGE LEASE: (.+)$/mu;

const readOutcome = (output: string): MergeLeaseRelease | null => {
  const spoken = MACHINE_LINE.exec(output)?.[1]?.trim();
  if (!spoken) return null;
  const [outcome, first, second, ...extra] = spoken.split(" ");
  if (extra.length > 0) return null;
  switch (outcome) {
    case "released":
      return first !== undefined && second !== undefined ? { outcome: "released", ref: first, sha: second } : null;
    case "not-held":
      return first === undefined ? { outcome: "not-held" } : null;
    case "skipped":
      return first !== undefined && second === undefined ? { outcome: "skipped", heldFor: first } : null;
    case "refused":
      return first !== undefined && second === undefined ? { outcome: "refused", heldBy: first } : null;
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
    return readOutcome(detail) ?? { outcome: "unreachable", detail: detail || "the release printed nothing" };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string };
    const detail = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    console.error(`Merge lease release failed for chain ${chainId}${detail ? `: ${detail}` : ""}`);
    // A refusal is the one non-zero exit the script means: it read the lease and
    // declined to break it. Anything else never got that far, so the state of
    // the lock on main is unknown rather than decided.
    const spoken = readOutcome(detail);
    if (spoken?.outcome === "refused") return spoken;
    return { outcome: "unreachable", detail: detail || String(error) };
  }
};

const releaseMergeLeaseWith = async (
  releaser: MergeLeaseReleaser,
  chainId: string | null,
): Promise<void> => {
  if (!chainId) return;
  let release: MergeLeaseRelease;
  try {
    release = await releaser(chainId);
  } catch (error: unknown) {
    release = { outcome: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  }
  reportMergeLeaseAnomaly(chainId, release);
};

export type ReleaseMergeLease = (chainId: string | null) => Promise<void>;

export const releaseMergeLease: ReleaseMergeLease = async (chainId) => {
  await releaseMergeLeaseWith(releaseMergeLeaseAdapter, chainId);
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
 * only the mechanical merge step, the Regression step, and the merge-tail
 * auxiliary tasks (automatic repair attempts) ever run under the lease, and an
 * auxiliary task answers for the lease of the Regression
 * chain it serves rather than for a chain of its own. It reads the same marker
 * window the completion path reads because it is the same question, which is
 * why the window no longer needs restating here.
 */
export type LeaseHolder = {
  chainId: string;
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
  if (directRole) return task.chainId ? { chainId: task.chainId, taskId, role: directRole } : null;
  const markers = await readMarkers(tx, taskId);
  const auxiliaryRegressionTaskId = latestMarker(markers, "repairAttempt")?.regressionTaskId ?? null;
  if (!auxiliaryRegressionTaskId) return null;
  const regression = await tx.task.findUnique({
    where: { id: auxiliaryRegressionTaskId },
    select: { chainId: true },
  });
  return regression?.chainId
    ? { chainId: regression.chainId, taskId, role: "auxiliary" }
    : null;
};

export type LeaseSettlementOutcome = "continue" | "stop";
export type LeaseSettlement = {
  disposition: "retain" | "release";
  leaseToRelease: string | null;
};

/** Decide the Lease disposition from one terminal-control outcome. */
export const settleLease = async (
  tx: Prisma.TransactionClient,
  input: { taskId: string | null; outcome: LeaseSettlementOutcome },
): Promise<LeaseSettlement> => {
  if (input.outcome === "continue") return { disposition: "retain", leaseToRelease: null };
  const holder = await leaseHolderFor(tx, input.taskId);
  return { disposition: "release", leaseToRelease: holder?.chainId ?? null };
};

const LEASE_HANDOFF_GRACE_MS = 60_000;

/** Persist the queued Run that must consume a retained Chain Lease. */
export const noteLeaseHandoff = async (
  tx: Prisma.TransactionClient,
  input: { chainId: string; toRunId: string; at: Date },
): Promise<void> => {
  const run = await tx.run.findUnique({ where: { id: input.toRunId }, select: { taskId: true } });
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
    },
  } });
};

/** Find retained handoffs whose queued Run never became a Lease consumer. */
export const leaseHandoffsWithoutConsumer = async (
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<Array<{ chainId: string; toRunId: string; taskId: string }>> => {
  const rows = await tx.taskActivity.findMany({
    where: {
      metadata: { path: ["kind"], equals: MERGE_TAIL_KIND.leaseHandoff },
    },
    select: { taskId: true, metadata: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const pending = new Map<string, { chainId: string; toRunId: string; taskId: string }>();
  const settled = new Set<string>();
  for (const row of rows) {
    const raw = row.metadata;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const metadata = raw as Record<string, unknown>;
    if (typeof metadata.toRunId !== "string") continue;
    if (metadata.state === "released") {
      settled.add(metadata.toRunId);
      continue;
    }
    const handedOffAt = typeof metadata.handedOffAt === "string" ? Date.parse(metadata.handedOffAt) : Number.NaN;
    if (metadata.state === "pending" && typeof metadata.chainId === "string"
      && Number.isFinite(handedOffAt) && handedOffAt < now.getTime() - LEASE_HANDOFF_GRACE_MS
      && !settled.has(metadata.toRunId) && !pending.has(metadata.toRunId)) {
      pending.set(metadata.toRunId, { chainId: metadata.chainId, toRunId: metadata.toRunId, taskId: row.taskId });
    }
  }
  if (pending.size === 0) return [];
  const queued = await tx.run.findMany({
    where: { id: { in: [...pending.keys()] }, status: RunStatus.QUEUED, claimedAt: null, startedAt: null },
    select: { id: true },
  });
  return queued.flatMap((run) => {
    const handoff = pending.get(run.id);
    return handoff ? [handoff] : [];
  });
};

/** Record a completed orphan-handoff release after the external release attempt. */
export const noteLeaseHandoffReleased = async (
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

export type TransactionLeaseDisposition<T> = {
  value: T;
  lease: LeaseSettlement;
};

/** Commit database state before carrying out its post-commit Lease release. */
export const commitWithLeaseDisposition = async <T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<TransactionLeaseDisposition<T> | null>,
  release: ReleaseMergeLease = releaseMergeLease,
  options?: { isolationLevel: Prisma.TransactionIsolationLevel },
): Promise<T | null> => {
  const committed = await db.$transaction(fn, options);
  if (committed === null) return null;
  if (committed.lease.disposition === "release") await release(committed.lease.leaseToRelease);
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

export type LeaseDisposition =
  | { kind: "release" }
  | { kind: "retain"; handoffRunId: string };

export type MergeLeaseDependencies = {
  acquire: MergeLeaseAcquirer;
  release: MergeLeaseReleaser;
};

export type WithMergeLease = <T>(
  chainId: string | null,
  fn: () => Promise<{ disposition: LeaseDisposition; value: T }>,
) => Promise<{ outcome: "contended" } | { outcome: "ran"; value: T }>;

/**
 * Run one authorization attempt under the Chain's merge Lease. A successful
 * authorization explicitly hands the Lease to mechanical merge with `retain`;
 * every other completed or exceptional callback path gives it back here.
 * A Task without a Chain has no Lease to acquire or release, but still runs the
 * callback through the same interface.
 */
export const withMergeLease = async <T>(
  chainId: string | null,
  fn: () => Promise<{ disposition: LeaseDisposition; value: T }>,
  dependencies: MergeLeaseDependencies = {
    acquire: acquireMergeLease,
    release: releaseMergeLeaseAdapter,
  },
): Promise<{ outcome: "contended" } | { outcome: "ran"; value: T }> => {
  if (chainId === null) {
    const result = await fn();
    return { outcome: "ran", value: result.value };
  }

  const acquisition = await dependencies.acquire(chainId);
  if (acquisition.outcome === "contended") return { outcome: "contended" };
  if (acquisition.outcome === "unreachable") {
    throw new Error(`merge lease acquire is unreachable: ${acquisition.detail}`);
  }

  let disposition: LeaseDisposition = { kind: "release" };
  try {
    const result = await fn();
    disposition = result.disposition;
    return { outcome: "ran", value: result.value };
  } finally {
    if (disposition.kind === "release") {
      await releaseMergeLeaseWith(dependencies.release, chainId);
    }
  }
};
