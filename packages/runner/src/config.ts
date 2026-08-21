import { createRequire } from "node:module";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireLocalApiDestination } from "./local-origin.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version: string };

/** The loopback literal, not `localhost`: the name resolves through DNS and a
 *  hosts file, and this process attaches the runner bearer token to every call
 *  it makes to that address. */
export const DEFAULT_API_URL = "http://127.0.0.1:3000";

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
  /** Proxy variables captured once, when the daemon starts. */
  proxyEnvironment?: NodeJS.ProcessEnv;
  /** Repository-owned baseline used to provision Codex session config roots. */
  sessionConfigBaselineRoot?: string;
  workspaceRoot: string;
  failedWorkspaceRetention: number;
  workspaceReclaimIntervalMs: number;
  toolDeadlineMs: number;
  apiTimeoutMs: number;
  runAsPrefix: string[];
  binaries: Record<RunnerKind, string>;
};

export const defaultSessionConfigBaselineRoot = (): string =>
  fileURLToPath(new URL("../assets/session-config-baseline", import.meta.url));

export const runnerProxyEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(
  ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]
    .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]),
);

const splitPrefix = (value: string): string[] => value.trim() ? value.trim().split(/\s+/u) : [];

const positiveInteger = (name: string, value: string): number => {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export const loadRunnerConfig = (): RunnerConfig => {
  const leaseSeconds = Number.parseInt(process.env.RUNNER_LEASE_SECONDS ?? "60", 10);
  const runAsPrefix = splitPrefix(process.env.RUNNER_RUN_AS_PREFIX ?? "");
  // First, and before this function returns anything a caller could dial: the
  // runner's own index.ts builds the client, the preflight and the poll loop out
  // of this object, so a destination refused here is refused before any DNS
  // lookup, socket or bearer header exists.
  const apiUrl = requireLocalApiDestination("RUNNER_API_URL", process.env.RUNNER_API_URL, DEFAULT_API_URL);
  return {
    apiUrl,
    runnerToken: process.env.RUNNER_TOKEN ?? "",
    runnerId: process.env.RUNNER_ID ?? `${hostname()}-${process.pid}`,
    daemonVersion: packageMetadata.version,
    pollIntervalMs: Number.parseInt(process.env.RUNNER_POLL_INTERVAL_MS ?? "5000", 10),
    leaseSeconds,
    heartbeatIntervalMs: Number.parseInt(process.env.RUNNER_HEARTBEAT_INTERVAL_MS ?? String(Math.max(5_000, leaseSeconds * 500)), 10),
    path: process.env.RUNNER_PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    home: process.env.RUNNER_HOME ?? process.env.HOME ?? "/var/empty",
    proxyEnvironment: runnerProxyEnvironment(),
    sessionConfigBaselineRoot: process.env.RUNNER_SESSION_CONFIG_BASELINE_ROOT ?? defaultSessionConfigBaselineRoot(),
    workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT ?? join(homedir(), ".agentos", "runs"),
    failedWorkspaceRetention: Number.parseInt(process.env.RUNNER_FAILED_WORKSPACE_RETENTION ?? "2", 10),
    // How often this runner asks the control plane which of its directories may
    // be reclaimed (issue #115). Workspace disposal is not urgent — the runner
    // already removes its own workspace when a run ends, and this sweep only
    // catches what a crash or a failed cleanup left behind — so the default is
    // deliberately slow enough to be invisible next to a poll interval.
    workspaceReclaimIntervalMs: positiveInteger(
      "RUNNER_WORKSPACE_RECLAIM_INTERVAL_MS", process.env.RUNNER_WORKSPACE_RECLAIM_INTERVAL_MS ?? "300000",
    ),
    toolDeadlineMs: positiveInteger("RUNNER_TOOL_DEADLINE_MS", process.env.RUNNER_TOOL_DEADLINE_MS ?? "1800000"),
    // Every control-plane call is a lease-critical operation: a heartbeat that
    // never returns stops renewing the lease, and a completion that never
    // returns loses a finished run to reconciliation just as surely as a
    // crash. None of these routes long-poll — claim returns 204 when there is
    // no work — so a flat ceiling is safe.
    apiTimeoutMs: positiveInteger("RUNNER_API_TIMEOUT_MS", process.env.RUNNER_API_TIMEOUT_MS ?? "10000"),
    runAsPrefix,
    binaries: {
      CLAUDE: process.env.CLAUDE_BINARY ?? "claude",
      CODEX: process.env.CODEX_BINARY ?? "codex",
      PI: process.env.PI_BINARY ?? "pi",
    },
  };
};
