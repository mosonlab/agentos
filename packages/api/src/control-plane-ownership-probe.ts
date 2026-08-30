import { spawn, type ChildProcess } from "node:child_process";

import { acquireControlPlaneOwnership } from "./control-plane-ownership.js";

const ownership = await acquireControlPlaneOwnership({
  ...(process.env.RUNNER_WORKSPACE_ROOT ? { workspaceRoot: process.env.RUNNER_WORKSPACE_ROOT } : {}),
  ...(process.env.FILES_ROOT ? { filesRoot: process.env.FILES_ROOT } : {}),
  ...(process.env.CONTROL_PLANE_STATE_DIR ? { stateDir: process.env.CONTROL_PLANE_STATE_DIR } : {}),
});

let descendant: ReturnType<typeof spawn> | undefined;
const keepAlive = setInterval(() => undefined, 1_000);
const waitForExit = (child: ChildProcess, timeoutMs = 5_000): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for descendant ${child.pid ?? "unknown"} to exit`));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
};

const stopDescendant = async (): Promise<void> => {
  if (!descendant || descendant.exitCode !== null || descendant.signalCode !== null) return;
  descendant.kill("SIGTERM");
  try {
    await waitForExit(descendant);
  } catch (error) {
    descendant.kill("SIGKILL");
    await waitForExit(descendant).catch((killError: unknown) => {
      throw new AggregateError([error, killError], `Failed to stop descendant ${descendant?.pid ?? "unknown"}`);
    });
  }
};

let stopping: Promise<void> | undefined;
const stop = (): Promise<void> => stopping ??= (async () => {
  clearInterval(keepAlive);
  const failures: unknown[] = [];
  await ownership.release().catch((error: unknown) => { failures.push(error); });
  await stopDescendant().catch((error: unknown) => { failures.push(error); });
  if (failures.length > 0) throw new AggregateError(failures, "Ownership probe cleanup failed");
})();

const stopForSignal = (): void => {
  void stop().then(
    () => { process.exitCode = 0; },
    (error: unknown) => {
      console.error("OWNERSHIP_PROBE_CLEANUP_FAILED", error);
      process.exitCode = 1;
    },
  );
};
process.once("SIGTERM", stopForSignal);
process.once("SIGINT", stopForSignal);

if (process.env.OWNERSHIP_PROBE_DESCENDANT === "1") {
  descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: false,
  });
  console.log(`OWNERSHIP_PROBE_DESCENDANT_PID ${descendant.pid}`);
}
if (process.env.OWNERSHIP_PROBE_SUPPRESS_READY !== "1") console.log("OWNERSHIP_PROBE_READY");
