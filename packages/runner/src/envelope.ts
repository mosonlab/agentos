import type { ExitEvidence } from "./adapters.js";
import type { FailureClass } from "./api.js";
import type { DeliveryFailure } from "./delivery.js";
import { isCommandTimeout } from "./exec.js";
import { isTransientNetworkError } from "./network-retry.js";

/**
 * The runner half of the structured failure envelope.
 *
 * `packages/db/src/failure-envelope.ts` is the canonical definition; this is a
 * hand-kept mirror, for the same reason `FailureClass` and `CleanupStatus` are
 * mirrored in api.ts — this package deliberately has no `@agentos/db`
 * dependency, so a compromised or buggy runner cannot reach a database. The
 * API's zod schema for the complete route is the boundary that catches drift.
 *
 * What this module does *not* do is decide anything. It reports facts: which
 * phase the run was in, what exited with what, which channel each piece of text
 * came off, and whether the runner's own typed `CommandTimeoutError` fired. The
 * API classifies. `adapters.classifyError` still runs and its verdict still
 * rides along as `runnerClass`, but only as a first guess to be recorded — the
 * regex sweep that produced it is precisely what misread an agent's stdout as
 * an auth failure.
 */
export type FailureEnvelope = {
  version: number;
  phase: FailurePhase;
  runnerClass: FailureClass | null;
  exitCode: number | null;
  signal: string | null;
  terminationReason: string | null;
  terminalEventSeen: boolean;
  terminalSuccess: boolean;
  agentExited: boolean;
  providerError: string | null;
  stderrSummary: string | null;
  stdoutSummary: string | null;
  timedOut: boolean;
  transient: boolean;
  timeoutMs: number | null;
};

export type FailurePhase = "PROVISION" | "EXECUTE" | "DELIVER" | "COMPLETE";

export const FAILURE_ENVELOPE_VERSION = 1;

export const FAILURE_EVIDENCE_LIMIT = 4_000;

/** Keeps the tail: a CLI states its verdict last, and a head-truncated stderr is
 *  a progress log with the error cut off. */
export const summarizeEvidence = (
  value: string | null | undefined,
  limit: number = FAILURE_EVIDENCE_LIMIT,
): string | null => {
  const text = value?.trim();
  if (!text) return null;
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `…[${dropped} earlier characters truncated]\n${text.slice(text.length - limit)}`;
};

export const buildFailureEnvelope = (input: {
  phase: FailurePhase;
  evidence: ExitEvidence;
  /** True only if the agent process ran and reported its own exit. False for
   *  provisioning, preflight and any exception thrown by runner code. */
  agentExited: boolean;
  runnerClass?: FailureClass | null;
  /** Overrides the evidence's own reason, for a kill the runner ordered (a
   *  budget gate) where the CLI never got to say why it died. */
  terminationReason?: string | null;
  /** The error that ended the phase, when there is one. Read by *type* only —
   *  `CommandTimeoutError` and the transient-network predicate — so the CLI's
   *  unrelated "preflight timed out after 15 seconds" text can never be
   *  mistaken for this runner's own command timeout. */
  error?: unknown;
}): FailureEnvelope => {
  const timeout = isCommandTimeout(input.error) ? input.error : null;
  return {
    version: FAILURE_ENVELOPE_VERSION,
    phase: input.phase,
    runnerClass: input.runnerClass ?? null,
    exitCode: input.evidence.exitCode,
    signal: input.evidence.signal,
    terminationReason: input.terminationReason ?? input.evidence.terminationReason,
    terminalEventSeen: input.evidence.terminalEventSeen,
    terminalSuccess: input.evidence.terminalSuccess,
    agentExited: input.agentExited,
    providerError: summarizeEvidence(input.evidence.providerError),
    stderrSummary: summarizeEvidence(input.evidence.stderr),
    stdoutSummary: summarizeEvidence(input.evidence.stdout),
    timedOut: timeout !== null,
    transient: timeout !== null || (input.error !== undefined && isTransientNetworkError(input.error)),
    timeoutMs: timeout?.timeoutMs ?? null,
  };
};

/**
 * The envelope for an exception that escaped `executeClaim`'s try block.
 *
 * Its own function for the same reason `completionEnvelope` is: the production
 * catch and the test that proves what the API receives share one
 * implementation, so a test cannot assert a shape the runner never sends. The
 * previous #113 regression test hand-wrote `terminationReason: null` for a
 * clone failure and passed while the real path — which stamps `"runner
 * exception"` on every escaped error — was classified CANCELLED_OR_TIMED_OUT
 * and never retried.
 *
 * `agentExited: false` whatever the phase: control reached the catch because
 * runner code threw, so the agent never got to report its own verdict. `error`
 * travels by reference, not stringified, so `CommandTimeoutError` and the
 * transient-network predicate see a type rather than a phrase.
 */
export const runnerExceptionEnvelope = (input: {
  phase: FailurePhase;
  evidence: ExitEvidence;
  runnerClass?: FailureClass | null;
  error: unknown;
}): FailureEnvelope => buildFailureEnvelope({
  phase: input.phase,
  evidence: input.evidence,
  agentExited: false,
  runnerClass: input.runnerClass ?? null,
  terminationReason: RUNNER_EXCEPTION_REASON,
  error: input.error,
});

/** What the runner records as the reason a run ended when its own code threw.
 *  Exported so the runner, its tests and the API fixtures name it once. */
export const RUNNER_EXCEPTION_REASON = "runner exception";

/**
 * The envelope for a run that reached terminal completion, built from whichever
 * phase actually failed.
 *
 * This exists as its own function so the production path and the test that
 * proves it share one implementation: `delivery.test.ts` drives a real
 * `deliverWorkspace` against a hung `git push` and feeds the real
 * `DeliveryResult` through here, so the envelope it asserts is the one a runner
 * would send — not a hand-written shape that happens to agree.
 */
export const completionEnvelope = (input: {
  /** Whether the agent process itself succeeded. When it did and the run still
   *  failed, the failure is delivery's. */
  executionSucceeded: boolean;
  evidence: ExitEvidence;
  deliveryFailure?: DeliveryFailure | undefined;
  runnerClass?: FailureClass | null;
  terminationReason?: string | null;
}): FailureEnvelope => {
  const failure = input.executionSucceeded ? input.deliveryFailure : undefined;
  return buildFailureEnvelope({
    phase: input.executionSucceeded ? "DELIVER" : "EXECUTE",
    // A delivery failure's evidence is the delivery command's, not the agent's.
    // The agent's stderr belongs to a process that *succeeded*; classifying a
    // hung `git push` off it is how a CommandTimeoutError reached the API as an
    // ordinary TASK_FAILED. stdout is dropped rather than carried over for the
    // same reason — it is the agent's work product and says nothing about the
    // push. It is not lost: the completion payload reports it as `output`.
    evidence: failure
      ? { ...input.evidence, providerError: null, stderr: failure.message, stdout: "" }
      : input.evidence,
    agentExited: true,
    runnerClass: input.runnerClass ?? null,
    terminationReason: input.terminationReason ?? input.evidence.terminationReason,
    // By reference, so `isCommandTimeout` sees a type and not a phrase.
    ...(failure ? { error: failure.error } : {}),
  });
};
