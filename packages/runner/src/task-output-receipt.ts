import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type TaskOutputReceipt = {
  runId: string;
  kind: string;
  commitSha: string;
};

export const taskOutputReceiptPath = (workspacePath: string): string =>
  join(workspacePath, ".agentos", "task-output-receipt.json");

const receipt = (value: unknown): TaskOutputReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Task output receipt is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.runId !== "string"
    || typeof candidate.kind !== "string"
    || typeof candidate.commitSha !== "string") {
    throw new Error("Task output receipt is missing runId, kind, or commitSha");
  }
  return { runId: candidate.runId, kind: candidate.kind, commitSha: candidate.commitSha };
};

/**
 * Record the exact output binding only after the session output request has
 * succeeded. The runner later combines this local receipt with the API's
 * current-Run `outputPersisted` fact; neither is sufficient on its own.
 */
export const writeTaskOutputReceipt = async (
  workspacePath: string,
  output: TaskOutputReceipt,
): Promise<void> => {
  const path = taskOutputReceiptPath(workspacePath);
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(output)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const readTaskOutputReceipt = async (workspacePath: string): Promise<TaskOutputReceipt | null> => {
  try {
    return receipt(JSON.parse(await readFile(taskOutputReceiptPath(workspacePath), "utf8")));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
