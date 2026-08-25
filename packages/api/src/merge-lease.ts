import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

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
