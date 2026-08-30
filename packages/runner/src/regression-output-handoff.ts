import { join } from "node:path";

import {
  parseRegressionVerdict,
  REGRESSION_VERIFICATION_OUTPUT_KIND,
} from "@anneal/db";

import type { ClaimedTask } from "./api.js";
import type { RunnerConfig } from "./config.js";
import { runCommand } from "./exec.js";
import { workspaceEnvironment, type Workspace } from "./workspace.js";

const HANDOFF_SCHEMA_VERSION = 1;
const MAX_HANDOFF_BYTES = 32 * 1024;
const SHA = /^[0-9a-f]{40}$/u;

export type RegressionOutputHandoff = {
  kind: typeof REGRESSION_VERIFICATION_OUTPUT_KIND;
  body: string;
  commitSha: string;
};

/** The exact Run and output contract used to qualify a Regression handoff. */
export type RegressionHandoffClaim = {
  task: { templateStep: Pick<NonNullable<ClaimedTask["task"]["templateStep"]>, "outputKind"> | null };
  run: Pick<ClaimedTask["run"], "id">;
};

const handoffPath = (workspace: Workspace): string =>
  join(workspace.path, ".agentos", "regression-output.json");

const readHandoffFile = async (
  config: RunnerConfig,
  workspace: Workspace,
): Promise<string | null> => {
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
if [ "$size" -gt "${MAX_HANDOFF_BYTES}" ]; then
  printf 'INVALID:too-large'
  exit 0
fi
printf 'PRESENT\n'
cat -- "$path"
`, "agentos-regression-output", handoffPath(workspace)],
    workspace.path,
    workspaceEnvironment(config),
  );
  if (output === "ABSENT") return null;
  if (output.startsWith("INVALID:")) {
    throw new Error(`Regression output handoff is invalid: ${output.slice("INVALID:".length)}`);
  }
  if (!output.startsWith("PRESENT\n")) throw new Error("Regression output handoff reader returned an unknown result");
  return output.slice("PRESENT\n".length);
};

/**
 * Qualify the script-authored Regression output before it crosses the Runner's
 * control-plane seam. The handoff is useful only for the exact current Run and
 * workspace HEAD; stale files remain inert rather than becoming retry evidence.
 */
export const readRegressionOutputHandoff = async (
  config: RunnerConfig,
  claim: RegressionHandoffClaim,
  workspace: Workspace,
): Promise<RegressionOutputHandoff | null> => {
  if (claim.task.templateStep?.outputKind !== REGRESSION_VERIFICATION_OUTPUT_KIND) return null;
  const raw = await readHandoffFile(config, workspace);
  if (raw === null) return null;

  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    value = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Regression output handoff is not valid JSON");
  }
  if (value.schemaVersion !== HANDOFF_SCHEMA_VERSION) throw new Error("Regression output handoff has an unsupported schemaVersion");
  if (value.runId !== claim.run.id) throw new Error(`Regression output handoff belongs to Run ${String(value.runId)}, not ${claim.run.id}`);
  if (value.kind !== REGRESSION_VERIFICATION_OUTPUT_KIND) throw new Error(`Regression output handoff has unexpected kind ${String(value.kind)}`);
  if (typeof value.body !== "string") throw new Error("Regression output handoff body is not a string");
  if (typeof value.commitSha !== "string" || !SHA.test(value.commitSha)) {
    throw new Error("Regression output handoff commitSha is invalid");
  }

  const headSha = await runCommand(
    config.runAsPrefix,
    "git",
    ["rev-parse", "HEAD"],
    workspace.path,
    workspaceEnvironment(config),
  );
  if (value.commitSha !== headSha) {
    throw new Error(`Regression output handoff is stale: handoff ${value.commitSha}, workspace ${headSha}`);
  }
  const verdict = parseRegressionVerdict(value.body, REGRESSION_VERIFICATION_OUTPUT_KIND);
  if (verdict.status === "invalid") throw new Error(`Regression output handoff verdict is invalid: ${verdict.reason}`);
  if (verdict.verdict.headSha !== headSha) {
    throw new Error(`Regression output handoff verdict is stale: verdict ${verdict.verdict.headSha}, workspace ${headSha}`);
  }
  return {
    kind: REGRESSION_VERIFICATION_OUTPUT_KIND,
    body: value.body,
    commitSha: headSha,
  };
};
