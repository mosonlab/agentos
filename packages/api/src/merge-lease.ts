import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  executionModeFor,
  isRegressionVerificationOutputKind,
  latestMarker,
  openReviewObligation,
  readMarkers,
  type Prisma,
} from "@agentos/db";

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
 * auxiliary tasks (automatic repair attempts and independent reviews) ever run
 * under the lease, and an auxiliary task answers for the lease of the Regression
 * chain it serves rather than for a chain of its own. It reads the same marker
 * window the completion path reads because it is the same question, which is
 * why the window no longer needs restating here.
 */
export const mergeTailLeaseChainId = async (
  tx: Prisma.TransactionClient,
  taskId: string | null,
): Promise<string | null> => {
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
  const markers = await readMarkers(tx, taskId);
  const auxiliaryRegressionTaskId = latestMarker(markers, "repairAttempt")?.regressionTaskId
    ?? openReviewObligation(markers)?.regressionTaskId
    ?? null;
  const tail = executionModeFor(task.templateStep) === "mechanical"
    || isRegressionVerificationOutputKind(task.templateStep?.outputKind)
    || auxiliaryRegressionTaskId !== null;
  if (!tail) return null;
  if (task.chainId) return task.chainId;
  if (!auxiliaryRegressionTaskId) return null;
  const regression = await tx.task.findUnique({
    where: { id: auxiliaryRegressionTaskId },
    select: { chainId: true },
  });
  return regression?.chainId ?? null;
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

export type LeaseDisposition = "release" | "retain";

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

  let disposition: LeaseDisposition = "release";
  try {
    const result = await fn();
    disposition = result.disposition;
    return { outcome: "ran", value: result.value };
  } finally {
    if (disposition === "release") {
      await releaseMergeLeaseWith(dependencies.release, chainId);
    }
  }
};
