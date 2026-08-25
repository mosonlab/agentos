import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { asJsonObject, executionModeFor, MERGE_TAIL_KIND, type Prisma } from "@agentos/db";

const mergeLeaseScript = fileURLToPath(new URL("../../../scripts/merge-lease.sh", import.meta.url));

/** How far back the merge-tail markers are read, matching the completion path. */
const mergeTailMarkerScan = 20;

const markerRegressionTaskId = (
  markers: Array<Record<string, unknown> | null>,
  kind: string,
  state?: string,
): string | null => {
  for (const metadata of markers) {
    if (metadata?.kind !== kind) continue;
    if (state !== undefined && metadata.state !== state) continue;
    if (typeof metadata.regressionTaskId === "string") return metadata.regressionTaskId;
  }
  return null;
};

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
 * chain it serves rather than for a chain of its own.
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
  const markers = (await tx.taskActivity.findMany({
    where: { taskId },
    select: { metadata: true },
    orderBy: { createdAt: "desc" },
    take: mergeTailMarkerScan,
  })).map((row) => asJsonObject(row.metadata));
  const auxiliaryRegressionTaskId = markerRegressionTaskId(markers, MERGE_TAIL_KIND.repairAttempt)
    ?? markerRegressionTaskId(markers, MERGE_TAIL_KIND.reviewObligation, "open");
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
