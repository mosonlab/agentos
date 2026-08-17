import { spawn } from "node:child_process";

import { acquireControlPlaneOwnership } from "./control-plane-ownership.js";

const ownership = await acquireControlPlaneOwnership({
  ...(process.env.RUNNER_WORKSPACE_ROOT ? { workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT } : {}),
  ...(process.env.FILES_ROOT ? { filesRoot: process.env.FILES_ROOT } : {}),
  ...(process.env.CONTROL_PLANE_STATE_DIR ? { stateDir: process.env.CONTROL_PLANE_STATE_DIR } : {}),
});

let descendant: ReturnType<typeof spawn> | undefined;
const keepAlive = setInterval(() => undefined, 1_000);
if (process.env.OWNERSHIP_PROBE_DESCENDANT === "1") {
  descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: false,
  });
  console.log(`OWNERSHIP_PROBE_DESCENDANT_PID ${descendant.pid}`);
}
console.log("OWNERSHIP_PROBE_READY");

const stop = async (): Promise<void> => {
  clearInterval(keepAlive);
  await ownership.release();
  if (descendant?.pid) descendant.kill("SIGTERM");
  process.exitCode = 0;
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
