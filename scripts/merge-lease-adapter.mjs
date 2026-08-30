import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTENDED_EXIT = 75;
const MACHINE_LINE = /^MERGE LEASE: (.+)$/gmu;

export const resolveMergeLeaseScriptPath = ({ environment = process.env, repoRoot } = {}) => {
  if (environment.AGENTOS_RELEASE_ROOT) {
    return path.join(path.resolve(environment.AGENTOS_RELEASE_ROOT), "scripts/merge-lease.sh");
  }
  return repoRoot
    ? path.join(path.resolve(repoRoot), "scripts/merge-lease.sh")
    : fileURLToPath(new URL("./merge-lease.sh", import.meta.url));
};

export const buildMergeLeaseArgv = ({ operation, scriptPath, task, reason, timeoutMinutes }) => {
  if (operation === "release") return [scriptPath, "release", "--task", task];
  if (operation === "acquire") {
    return [
      scriptPath,
      "acquire",
      "--task",
      task,
      "--reason",
      reason,
      "--timeout-minutes",
      String(timeoutMinutes),
    ];
  }
  throw new Error(`Unsupported merge lease operation: ${operation}`);
};

export const parseMergeLeaseRelease = (output) => {
  const lines = [...output.matchAll(MACHINE_LINE)];
  if (lines.length !== 1) return null;
  const spoken = lines[0][1]?.trim();
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
      return tokens.length === 1 && tokens[0] ? { outcome: "skipped", heldFor: tokens[0] } : null;
    case "refused":
      return tokens.length === 1 && tokens[0] ? { outcome: "refused", heldBy: tokens[0] } : null;
    default:
      return null;
  }
};

const outputDetail = ({ stdout = "", stderr = "" }) => `${stdout}${stderr}`.trim();

export const classifyMergeLeaseExecution = ({ operation, code, stdout = "", stderr = "", error }) => {
  const detail = outputDetail({ stdout, stderr });
  if (operation === "acquire") {
    if (code === 0) return { outcome: "acquired", detail };
    if (code === CONTENDED_EXIT) return { outcome: "contended", detail };
    return {
      outcome: "unreachable",
      detail: detail || (error instanceof Error ? error.message : `merge-lease.sh acquire exited ${String(code)}`),
    };
  }

  if (operation !== "release") throw new Error(`Unsupported merge lease operation: ${operation}`);
  const parsed = parseMergeLeaseRelease(detail);
  if (code === 0 && parsed && parsed.outcome !== "refused") return { ...parsed, detail };
  if (code === 1 && parsed?.outcome === "refused") return { ...parsed, detail };
  return {
    outcome: "unreachable",
    detail: detail || (error instanceof Error ? error.message : `merge-lease.sh release exited ${String(code)}`),
  };
};

export const isMergeLeaseReleaseAnomaly = (release) =>
  release.outcome === "skipped" || release.outcome === "refused" || release.outcome === "unreachable";

const defaultRunner = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.environment,
      timeout: options.processTimeoutMs,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : null,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error,
    };
  }
};

const execute = async ({ operation, repoRoot, environment, processTimeoutMs, task, reason, timeoutMinutes, runner }) => {
  const effectiveEnvironment = environment ?? process.env;
  const scriptPath = resolveMergeLeaseScriptPath({ environment: effectiveEnvironment, repoRoot });
  const argv = buildMergeLeaseArgv({ operation, scriptPath, task, reason, timeoutMinutes });
  const execution = await (runner ?? defaultRunner)("bash", argv, {
    cwd: repoRoot,
    environment: effectiveEnvironment,
    processTimeoutMs,
  });
  return classifyMergeLeaseExecution({ operation, ...execution });
};

export const acquireMergeLease = (options) => execute({ operation: "acquire", ...options });

export const releaseMergeLease = (options) => execute({ operation: "release", ...options });
