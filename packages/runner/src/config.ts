import { createRequire } from "node:module";
import { hostname, homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version: string };

export type RunnerKind = "CLAUDE" | "CODEX" | "PI";

export type RunnerConfig = {
  apiUrl: string;
  runnerToken: string;
  runnerId: string;
  daemonVersion: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  path: string;
  home: string;
  workspaceRoot: string;
  failedWorkspaceRetention: number;
  toolDeadlineMs: number;
  runAsPrefix: string[];
  binaries: Record<RunnerKind, string>;
};

const splitPrefix = (value: string): string[] => value.trim() ? value.trim().split(/\s+/u) : [];

export const loadRunnerConfig = (): RunnerConfig => {
  const leaseSeconds = Number.parseInt(process.env.RUNNER_LEASE_SECONDS ?? "60", 10);
  return {
    apiUrl: process.env.RUNNER_API_URL ?? "http://localhost:3000",
    runnerToken: process.env.RUNNER_TOKEN ?? "",
    runnerId: process.env.RUNNER_ID ?? `${hostname()}-${process.pid}`,
    daemonVersion: packageMetadata.version,
    pollIntervalMs: Number.parseInt(process.env.RUNNER_POLL_INTERVAL_MS ?? "5000", 10),
    leaseSeconds,
    heartbeatIntervalMs: Number.parseInt(process.env.RUNNER_HEARTBEAT_INTERVAL_MS ?? String(Math.max(5_000, leaseSeconds * 500)), 10),
    path: process.env.RUNNER_PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    home: process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty",
    workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT ?? join(homedir(), ".agentos", "runs"),
    failedWorkspaceRetention: Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10),
    toolDeadlineMs: Number.parseInt(process.env.RUNNER_TOOL_DEADLINE_MS ?? "600000", 10),
    runAsPrefix: splitPrefix(process.env.RUNNER_RUN_AS_PREFIX ?? ""),
    binaries: {
      CLAUDE: process.env.CLAUDE_BINARY ?? "claude",
      CODEX: process.env.CODEX_BINARY ?? "codex",
      PI: process.env.PI_BINARY ?? "pi",
    },
  };
};
