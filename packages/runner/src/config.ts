import { hostname } from "node:os";

export type RunnerKind = "CLAUDE" | "CODEX" | "PI";

export type RunnerConfig = {
  apiUrl: string;
  token: string;
  runnerId: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  commands: Record<RunnerKind, string>;
};

export const loadRunnerConfig = (): RunnerConfig => ({
  apiUrl: process.env.RUNNER_API_URL ?? "http://localhost:3000",
  token: process.env.AGENTOS_API_TOKEN ?? process.env.RUNNER_TOKEN ?? "",
  runnerId: process.env.RUNNER_ID ?? `${hostname()}-${process.pid}`,
  pollIntervalMs: Number.parseInt(process.env.RUNNER_POLL_INTERVAL_MS ?? "5000", 10),
  leaseSeconds: Number.parseInt(process.env.RUNNER_LEASE_SECONDS ?? "60", 10),
  commands: {
    CLAUDE: process.env.CLAUDE_COMMAND_TEMPLATE ?? "claude --dangerously-skip-permissions --print",
    CODEX: process.env.CODEX_COMMAND_TEMPLATE ?? "codex exec --dangerously-bypass-approvals-and-sandbox -",
    PI: process.env.PI_COMMAND_TEMPLATE ?? "pi",
  },
});
