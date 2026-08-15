import { config as loadEnvironment } from "dotenv";

loadEnvironment({ path: new URL("../../../.env", import.meta.url), quiet: true });

const [{ loadRunnerConfig }, { pollForTask }] = await Promise.all([
  import("./config.js"),
  import("./runner.js"),
]);

const config = loadRunnerConfig();
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
