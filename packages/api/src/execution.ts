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

export const retryDelayMs = (runNumber: number, failureClass: FailureClass): number => {
  const base = failureClass === FailureClass.RATE_LIMITED ? 60_000 : 30_000;
  return Math.min(base * (2 ** Math.max(0, runNumber - 1)), 15 * 60_000);
};

export const jsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
