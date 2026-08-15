import type { RunnerConfig, RunnerKind } from "./config.js";

export type ClaimedTask = {
  task: { id: string; name: string; description: string; workingDirectory: string | null };
  agent: { id: string; name: string; foundationalPrompt: string; rolePrompt: string };
  session: { id: string };
  runner: RunnerKind;
};

const request = async (config: RunnerConfig, path: string, init: RequestInit): Promise<Response> => {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok && response.status !== 204) {
    throw new Error(`AgentOS API ${response.status}: ${await response.text()}`);
  }
  return response;
};

export const claimTask = async (config: RunnerConfig): Promise<ClaimedTask | null> => {
  const response = await request(config, "/runner/tasks/claim", {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, leaseSeconds: config.leaseSeconds }),
  });
  return response.status === 204 ? null : await response.json() as ClaimedTask;
};

export const heartbeat = async (config: RunnerConfig, sessionId: string): Promise<void> => {
  await request(config, `/runner/sessions/${sessionId}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, leaseSeconds: config.leaseSeconds }),
  });
};

export const appendActivity = async (
  config: RunnerConfig,
  taskId: string,
  body: string,
  stream: "stdout" | "stderr",
): Promise<void> => {
  if (body.length === 0) return;
  await request(config, `/tasks/${taskId}/activity`, {
    method: "POST",
    body: JSON.stringify({ actorType: "runner", actorId: config.runnerId, body, metadata: { stream } }),
  });
};

export const completeSession = async (
  config: RunnerConfig,
  sessionId: string,
  exitCode: number,
  failureReason?: string,
): Promise<void> => {
  await request(config, `/runner/sessions/${sessionId}/complete`, {
    method: "POST",
    body: JSON.stringify({ runnerId: config.runnerId, exitCode, ...(failureReason ? { failureReason } : {}) }),
  });
};
