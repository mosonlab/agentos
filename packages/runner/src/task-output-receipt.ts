import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RunnerConfig } from "./config.js";
import { runCommand } from "./exec.js";
import { workspaceEnvironment, type Workspace } from "./workspace.js";

const MAX_RECEIPT_BYTES = 8 * 1024;

// AGENT-WRITER-BEGIN
export type TaskOutputReceipt = {
  runId: string;
  kind: string;
  commitSha: string;
};

export const taskOutputReceiptPath = (workspacePath: string): string =>
  join(workspacePath, ".agentos", "task-output-receipt.json");

/**
 * Record the delivered output identity only after the session output request
 * has succeeded. The runner includes this Agent-writable receipt in recovery
 * audit evidence; the server-returned output identity alone authorizes recovery.
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
// AGENT-WRITER-END

export const parseTaskOutputReceipt = (raw: string): TaskOutputReceipt => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`Task output receipt is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
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

const readReceiptFile = async (config: RunnerConfig, workspace: Workspace): Promise<string | null> => {
  const output = await runCommand(
    config.runAsPrefix,
    "/bin/sh",
    ["-c", `
path="$1"
directory="$(dirname "$path")"
if [ -L "$directory" ]; then
  printf 'INVALID:symlinked-parent-directory'
  exit 0
fi
if [ ! -e "$path" ]; then
  printf 'ABSENT'
  exit 0
fi
if [ -L "$path" ] || [ ! -f "$path" ]; then
  printf 'INVALID:not-a-plain-file'
  exit 0
fi
size="$(wc -c < "$path" | tr -d '[:space:]')"
case "$size" in ''|*[!0-9]*) printf 'INVALID:unreadable-size'; exit 0 ;; esac
if [ "$size" -gt "${MAX_RECEIPT_BYTES}" ]; then
  printf 'INVALID:too-large'
  exit 0
fi
printf 'PRESENT\n'
cat -- "$path"
`, "agentos-task-output-receipt", taskOutputReceiptPath(workspace.path)],
    workspace.path,
    workspaceEnvironment(config),
  );
  if (output === "ABSENT") return null;
  if (output.startsWith("INVALID:")) {
    throw new Error(`Task output receipt is invalid: ${output.slice("INVALID:".length)}`);
  }
  if (!output.startsWith("PRESENT\n")) throw new Error("Task output receipt reader returned an unknown result");
  return output.slice("PRESENT\n".length);
};

export const readTaskOutputReceipt = async (
  config: RunnerConfig,
  workspace: Workspace,
): Promise<TaskOutputReceipt | null> => {
  const raw = await readReceiptFile(config, workspace);
  if (raw === null) return null;
  return parseTaskOutputReceipt(raw);
};
