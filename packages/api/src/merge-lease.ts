import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { executionModeFor, latestMarker, openReviewObligation, readMarkers, type Prisma } from "@agentos/db";

const mergeLeaseScript = fileURLToPath(new URL("../../../scripts/merge-lease.sh", import.meta.url));

export type MergeLeaseReleaser = (chainId: string) => Promise<void>;

export const releaseMergeLease: MergeLeaseReleaser = async (chainId) => {
  await new Promise<void>((resolve) => {
    execFile("bash", [mergeLeaseScript, "release", "--task", chainId], {
      timeout: 90_000,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      const detail = `${stdout}${stderr}`.trim();
      if (error) {
        console.error(`Merge lease release failed for chain ${chainId}${detail ? `: ${detail}` : ""}`);
      } else if (detail) {
        console.log(detail);
      }
      resolve();
    });
  });
};

export const releaseMergeLeaseSafely = async (
  releaser: MergeLeaseReleaser,
  chainId: string | null,
): Promise<void> => {
  if (!chainId) return;
  try {
    await releaser(chainId);
  } catch (error: unknown) {
    console.error(`Merge lease release failed for chain ${chainId}`, error);
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
