import { createHash, randomUUID } from "node:crypto";

import { FailureClass, RunnerKind, RunnerPreference, type Prisma } from "@agentos/db";

export type ExitEvidence = {
  exitCode: number | null;
  signal?: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  terminationReason?: string | null;
};

export const completionSucceeded = (evidence: ExitEvidence): boolean =>
  evidence.exitCode === 0
  && !evidence.signal
  && !evidence.terminationReason
  && evidence.terminalEventSeen
  && evidence.terminalSuccess;

export const runnerFor = (preference: RunnerPreference, model: string): RunnerKind => {
  if (preference === RunnerPreference.CLAUDE) return RunnerKind.CLAUDE;
  if (preference === RunnerPreference.CODEX) return RunnerKind.CODEX;
  if (preference === RunnerPreference.PI) return RunnerKind.PI;
  const normalized = model.toLowerCase();
  if (normalized.includes("codex")) return RunnerKind.CODEX;
  if (normalized.includes("deepseek") || normalized.includes("pi")) return RunnerKind.PI;
  return RunnerKind.CLAUDE;
};

export const makeDedupeKey = (taskId: string, runNumber: number): string => `task:${taskId}:run:${runNumber}`;

export const makeFencingToken = (runId: string, generation: number): string =>
  `${generation}:${runId}:${randomUUID()}`;

export const hashPrompt = (parts: string[]): string =>
  createHash("sha256").update(parts.join("\n")).digest("hex");

const retryableFailureClasses: readonly FailureClass[] = [
  FailureClass.RATE_LIMITED,
  FailureClass.TRANSIENT_PROVIDER,
  FailureClass.PROTOCOL_ERROR,
];

export const failureIsRetryable = (failureClass: FailureClass): boolean => retryableFailureClasses.includes(failureClass);

// Failures caused by the environment rather than the agent's own work: the CLI
// never got to decide anything, so the attempt must not eat the task's budget.
// The task's ceiling is raised by one instead of the run number being reused,
// which would collide with the (taskId, runNumber) dedupe key.
export const externalFailure = (evidence: {
  succeeded: boolean;
  signal?: string | null;
  reported?: boolean;
  failureClass?: FailureClass | null;
}): boolean => {
  if (evidence.succeeded) return false;
  // A signal the runner did not ask for (budget kills carry a terminationReason
  // and are reported as CANCELLED_OR_TIMED_OUT) means the process was shot from
  // outside the session.
  if (evidence.signal && evidence.failureClass !== FailureClass.CANCELLED_OR_TIMED_OUT) return true;
  if (evidence.failureClass === FailureClass.BINARY_NOT_FOUND) return true;
  if (evidence.failureClass === FailureClass.AUTH_REQUIRED) return true;
  return evidence.reported === true;
};

export const retryDelayMs = (runNumber: number, failureClass: FailureClass): number => {
  const base = failureClass === FailureClass.RATE_LIMITED ? 60_000 : 30_000;
  return Math.min(base * (2 ** Math.max(0, runNumber - 1)), 15 * 60_000);
};

export const jsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
