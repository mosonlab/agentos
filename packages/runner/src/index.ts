import { config as loadEnvironment } from "dotenv";

loadEnvironment({ path: new URL("../../../.env", import.meta.url), quiet: true });

const [{ loadRunnerConfig }, { pollForTask, runStartupPreflight }] = await Promise.all([
  import("./config.js"),
  import("./runner.js"),
]);

const config = loadRunnerConfig();
if (!config.runnerToken) throw new Error("RUNNER_TOKEN is required; operator credentials must never be used by the runner");
const preflight = await runStartupPreflight(config);
console.log(`CLI preflight: ${Object.entries(preflight).map(([runner, ok]) => `${runner.toLowerCase()}=${ok ? "ok" : "blocked"}`).join(" ")}`);
let stopping = false;
const stop = (signal: string): void => {
  console.log(`Received ${signal}; stopping local runner after the current task`);
  stopping = true;
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

console.log(`AgentOS local runner ${config.runnerId} polling ${config.apiUrl}`);
while (!stopping) {
  try {
    const ranTask = await pollForTask(config);
    if (ranTask) continue;
  } catch (error: unknown) {
    console.error("Runner poll failed", error);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, config.pollIntervalMs));
}
