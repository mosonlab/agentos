import { config as loadEnvironment } from "dotenv";

loadEnvironment({
  path: new URL("../../../.env", import.meta.url),
  quiet: true,
});

type RunnerConfig = {
  apiUrl: string;
  token: string;
  pollIntervalMs: number;
};

const config: RunnerConfig = {
  apiUrl: process.env.RUNNER_API_URL ?? "http://localhost:3000",
  token: process.env.RUNNER_TOKEN ?? "",
  pollIntervalMs: Number.parseInt(
    process.env.RUNNER_POLL_INTERVAL_MS ?? "5000",
    10,
  ),
};

let stopping = false;

const pollForTask = async (_config: RunnerConfig): Promise<void> => {
  // Phase 0 boundary: Phase 1 will claim one task from the control-plane API
  // and dispatch it to a locally installed claude, codex, or pi CLI.
  await Promise.resolve();
};

const runPollingLoop = async (): Promise<void> => {
  console.log(
    `AgentOS local runner polling ${config.apiUrl} every ${config.pollIntervalMs}ms`,
  );

  while (!stopping) {
    try {
      await pollForTask(config);
    } catch (error: unknown) {
      console.error("Runner poll failed", error);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, config.pollIntervalMs);
    });
  }
};

const stop = (signal: string): void => {
  console.log(`Received ${signal}; stopping local runner`);
  stopping = true;
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

void runPollingLoop();
