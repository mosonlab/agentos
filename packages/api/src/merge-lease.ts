import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { executionModeFor, latestMarker, openReviewObligation, readMarkers, type Prisma } from "@agentos/db";

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

export const releaseMergeLease: MergeLeaseReleaser = async (chainId) => {
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

export const releaseMergeLeaseSafely = async (
  releaser: MergeLeaseReleaser,
  chainId: string | null,
): Promise<MergeLeaseRelease | null> => {
  if (!chainId) return null;
  try {
    return await releaser(chainId);
  } catch (error: unknown) {
    console.error(`Merge lease release failed for chain ${chainId}`, error);
    return { outcome: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Say out loud that a release did not free the lock it was asked to free.
 * `released` and `not-held` are the ordinary answers. The other three are
 * anomalies on the lock that serialises the merge window on main -- the lease is
 * still standing, or nobody knows whether it is -- and they arrive on a path
 * that otherwise reports nothing at all. This reports and returns: what the
 * merge tail should do about a stuck lease is not decided here.
 */
export const reportMergeLeaseAnomaly = (chainId: string | null, release: MergeLeaseRelease | null): void => {
  if (!chainId || !release) return;
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
    || task.templateStep?.outputKind === "regression-verification"
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
