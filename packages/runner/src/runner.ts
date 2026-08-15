import { appendActivity, claimTask, completeSession, heartbeat, type ClaimedTask } from "./api.js";
import { assertWorkingDirectory, runAdapter } from "./adapters.js";
import type { RunnerConfig } from "./config.js";

export const executeClaim = async (config: RunnerConfig, claim: ClaimedTask): Promise<void> => {
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let writes = Promise.resolve();
  const queueActivity = (body: string, stream: "stdout" | "stderr"): void => {
    writes = writes.then(() => appendActivity(config, claim.task.id, body, stream)).catch((error: unknown) => {
      console.error("Failed to append task activity", error);
    });
  };

  try {
    const workingDirectory = await assertWorkingDirectory(claim.task.workingDirectory);
    heartbeatTimer = setInterval(() => {
      void heartbeat(config, claim.session.id).catch((error: unknown) => console.error("Lease heartbeat failed", error));
    }, Math.max(5_000, Math.floor(config.leaseSeconds * 500)));
    const exitCode = await runAdapter(config, claim, workingDirectory, {
      onStdout: (chunk) => queueActivity(chunk, "stdout"),
      onStderr: (chunk) => queueActivity(chunk, "stderr"),
    });
    await writes;
    await completeSession(config, claim.session.id, exitCode, exitCode === 0 ? undefined : `CLI exited with code ${exitCode}`);
  } catch (error: unknown) {
    await writes;
    const message = error instanceof Error ? error.message : String(error);
    await appendActivity(config, claim.task.id, message, "stderr").catch(() => undefined);
    await completeSession(config, claim.session.id, 1, message);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
};

export const pollForTask = async (config: RunnerConfig): Promise<boolean> => {
  const claim = await claimTask(config);
  if (!claim) return false;
  console.log(`Claimed task ${claim.task.id} for ${claim.agent.name} via ${claim.runner.toLowerCase()}`);
  await executeClaim(config, claim);
  return true;
};
