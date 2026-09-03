import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_FAILURE_REFUND_CAP,
  FailureClass,
  type FailureEnvelope,
  type RunOutcome,
  runOutcomeVerdict,
} from "@anneal/db";

import { classifyEnvelope } from "./execution.js";
import {
  completionEvidenceRefusal,
  completionOutputFailurePolicy,
  externalFailureRefundDecision,
} from "./run-completion.js";

const baseSha = "5".repeat(40);

const implementationStep = {
  outputKind: "implementation",
  requiresCommit: true,
  taskTemplate: { name: "direct-engineer-workflow" },
};

const continuation = (overrides: Record<string, unknown> = {}) => ({
  id: "run-2",
  runNumber: 2,
  maxRunsPerTask: 2,
  requiresCommit: false,
  opensPullRequest: true,
  baseSha,
  task: { templateStep: implementationStep },
  ...overrides,
});

const implementationOutput = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-2",
  kind: "implementation",
  body: JSON.stringify({
    schemaVersion: 1,
    headSha: baseSha,
    baseSha,
    summary: "The salvaged base already delivers the brief.",
    testsRun: ["focused"],
  }),
  commitSha: baseSha,
  metadata: {},
  ...overrides,
});

test("an unchanged relaxed Run completes SUCCEEDED only with canonical implementation evidence", () => {
  const run = continuation();

  assert.equal(completionEvidenceRefusal(run, true, baseSha, implementationOutput()), null);
  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, null),
    "missing implementation task output for current Run run-2",
  );
});

test("a manual own-publication continuation cannot clean-exit without implementation evidence", () => {
  const run = continuation({ task: { templateStep: null } });

  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, null),
    "missing implementation task output for current Run run-2",
  );
  assert.equal(
    completionEvidenceRefusal(run, true, baseSha, implementationOutput({ kind: "result" })),
    "task output kind result does not match canonical kind implementation",
  );
});

test("a configured non-committing Step keeps its ordinary completion semantics", () => {
  const run = continuation({
    opensPullRequest: false,
    task: {
      templateStep: {
        outputKind: "regression-verification-v2",
        requiresCommit: false,
        taskTemplate: { name: "direct-engineer-workflow" },
      },
    },
  });

  assert.equal(completionEvidenceRefusal(run, true, baseSha, null), null);
});

test("three capped external failures refund the task and the fourth records the cap", () => {
  let cappedRefunds = 0;
  let budgetGrants = 0;

  for (let runNumber = 1; runNumber <= EXTERNAL_FAILURE_REFUND_CAP; runNumber += 1) {
    const decision = externalFailureRefundDecision({
      runNumber,
      external: true,
      refundable: true,
      mechanical: false,
      capped: true,
      priorCappedRefunds: cappedRefunds,
    });
    assert.equal(decision.refunded, 1);
    assert.equal(decision.capReached, false);
    assert.match(decision.activity?.body ?? "", new RegExp(`${runNumber} of ${EXTERNAL_FAILURE_REFUND_CAP}`));
    cappedRefunds += decision.refunded;
    budgetGrants += decision.refunded;
  }

  assert.equal(budgetGrants, EXTERNAL_FAILURE_REFUND_CAP);
  const fourth = externalFailureRefundDecision({
    runNumber: EXTERNAL_FAILURE_REFUND_CAP + 1,
    external: true,
    refundable: true,
    mechanical: false,
    capped: true,
    priorCappedRefunds: cappedRefunds,
  });
  assert.equal(fourth.refunded, 0);
  assert.equal(fourth.capReached, true);
  assert.match(fourth.activity?.body ?? "", /external-failure refund cap was reached/i);
});

test("legacy external refunds do not consume the capped allowance", () => {
  const decision = externalFailureRefundDecision({
    runNumber: 8,
    external: true,
    refundable: true,
    mechanical: false,
    capped: false,
    priorCappedRefunds: EXTERNAL_FAILURE_REFUND_CAP,
  });
  assert.equal(decision.refunded, 1);
  assert.equal(decision.capReached, false);
  assert.equal(decision.activity?.metadata.policy, "uncapped");
});

test("ineligible and mechanical failures never receive a refund", () => {
  for (const input of [
    { refundable: false, mechanical: false },
    { refundable: true, mechanical: true },
  ]) {
    const decision = externalFailureRefundDecision({
      runNumber: 2,
      external: true,
      capped: false,
      priorCappedRefunds: 0,
      ...input,
    });
    assert.equal(decision.refunded, 0);
    assert.equal(decision.activity?.metadata.granted, false);
  }
});

test("a Regression target-fetch block keeps its git diagnostic and is externally refundable", () => {
  const policy = completionOutputFailurePolicy({
    outputKind: "regression-verification-v2",
    missingOutputReason: null,
    outcome: {
      case: "required-output-unsatisfied",
      reason: "A step finished without a handoff [target-fetch-failed]: fatal: could not read Username for 'https://github.com'",
    },
  });
  assert.equal(policy.externalFailure, true);
  assert.equal(policy.cappedExternalFailure, true);
  assert.match(policy.failureReason ?? "", /target-fetch-failed/);
  assert.match(policy.failureReason ?? "", /could not read Username/);
});

test("an ordinary missing-output refusal remains non-external and byte-for-byte unchanged", () => {
  const missingOutputReason = "missing implementation task output for current Run run-2";
  const policy = completionOutputFailurePolicy({
    outputKind: "implementation",
    missingOutputReason,
    outcome: {
      case: "required-output-unsatisfied",
      reason: "A step finished without a handoff",
    },
  });
  assert.equal(policy.externalFailure, false);
  assert.equal(policy.cappedExternalFailure, false);
  assert.equal(policy.failureReason, missingOutputReason);
});

// --- Run outcome -----------------------------------------------------------
//
// One row per case. No git remote, no shell agent, no control-plane double:
// the sentence "this Run's outcome is X" is decided by the runner and read
// here, so reading it is a pure function and its table is the whole contract.
// Before this, the same verdict was assembled from thirteen locals in
// `executeClaim`, encoded as seven wire fields, and re-derived by roughly
// thirty branch sites in `completeRun` — and the only way to test any of it was
// to boot a real agent and assert `completions.at(-1).failureClass`.

const envelope = (overrides: Partial<FailureEnvelope> = {}): FailureEnvelope => ({
  version: 1,
  phase: "EXECUTE",
  runnerClass: null,
  exitCode: 1,
  signal: null,
  terminationReason: null,
  terminalEventSeen: true,
  terminalSuccess: false,
  agentExited: true,
  providerError: null,
  stderrSummary: "the agent reported a failure",
  stdoutSummary: null,
  timedOut: false,
  transient: false,
  timeoutMs: null,
  ...overrides,
});

const verdictOf = (outcome: RunOutcome) => runOutcomeVerdict(outcome, classifyEnvelope);

const outcomeRows: ReadonlyArray<{
  name: string;
  outcome: RunOutcome;
  succeeded: boolean;
  failureClass: FailureClass | null;
  retryable: boolean;
  externalFailure: boolean;
  timedOut: boolean;
}> = [
  {
    name: "an agent that exited cleanly",
    outcome: { case: "succeeded" },
    succeeded: true, failureClass: null, retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "a Regression whose fenced mechanical handoff is the step's product",
    outcome: { case: "regression-mechanically-settled" },
    succeeded: true, failureClass: null, retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "a provider that dropped after the server already held this Run's output",
    outcome: { case: "delivered-then-disconnected" },
    succeeded: true, failureClass: null, retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "a walltime budget kill",
    outcome: { case: "budget-exhausted", gate: "walltime", reason: "walltime: walltime budget exceeded" },
    succeeded: false,
    failureClass: FailureClass.BUDGET_EXCEEDED,
    // Retrying into the ceiling, or raising it for exceeding it, is an
    // unbounded loop either way.
    retryable: false, externalFailure: false, timedOut: true,
  },
  {
    name: "a run-count budget refusal before launch",
    outcome: { case: "budget-exhausted", gate: "max-runs", reason: "Maximum run budget exceeded before launch" },
    succeeded: false,
    failureClass: FailureClass.BUDGET_EXCEEDED,
    retryable: false, externalFailure: false,
    // Not a clock, so not TIMED_OUT. This used to be decided by looking for the
    // substrings "walltime" and "stall" inside the runner's own prose.
    timedOut: false,
  },
  {
    name: "a required deliverable the Run never persisted",
    outcome: { case: "required-output-unsatisfied", reason: "finished without persisting implementation output" },
    succeeded: false,
    failureClass: FailureClass.PROTOCOL_ERROR,
    // The next attempt can still author it, and the absent deliverable is the
    // agent's own attempt, so it spends the attempt.
    retryable: true, externalFailure: false, timedOut: false,
  },
  {
    name: "an output status the control plane could not establish",
    outcome: { case: "terminal-protocol-failure", reason: "Task output status could not be established" },
    succeeded: false,
    failureClass: FailureClass.PROTOCOL_ERROR,
    // Re-asking a question that did not answer is not a repair. The runner used
    // to spell this by omitting the failure envelope entirely.
    retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "an agent failure classified from its envelope",
    outcome: { case: "provider-failure", reason: "the agent reported a failure", envelope: envelope() },
    succeeded: false,
    failureClass: FailureClass.TASK_FAILED,
    retryable: false, externalFailure: false, timedOut: false,
  },
  {
    name: "a clone that failed before the agent started",
    outcome: {
      case: "provider-failure",
      reason: "git failed (128)",
      envelope: envelope({ phase: "PROVISION", agentExited: false, terminationReason: "runner exception" }),
    },
    succeeded: false,
    failureClass: FailureClass.TASK_FAILED,
    // The runner's plumbing failed, so the attempt buys the task one instead of
    // spending one. `agentExited` says that, not a flag the runner asserts.
    retryable: false, externalFailure: true, timedOut: false,
  },
  {
    name: "a hung push, which the envelope types as a timeout its text does not name",
    outcome: {
      case: "provider-failure",
      reason: "git push timed out after 6000ms",
      envelope: envelope({
        phase: "DELIVER",
        runnerClass: FailureClass.TOOL_FAILED,
        exitCode: 0,
        terminalSuccess: true,
        timedOut: true,
        transient: true,
        timeoutMs: 6000,
        stderrSummary: "git push timed out after 6000ms; its process group was killed",
      }),
    },
    succeeded: false,
    failureClass: FailureClass.TRANSIENT_PROVIDER,
    retryable: true, externalFailure: true, timedOut: false,
  },
];

for (const row of outcomeRows) {
  test(`the outcome of ${row.name}`, () => {
    const verdict = verdictOf(row.outcome);
    assert.equal(verdict.succeeded, row.succeeded);
    assert.equal(verdict.failureClass, row.failureClass);
    assert.equal(verdict.retryable, row.retryable);
    assert.equal(verdict.externalFailure, row.externalFailure);
    assert.equal(verdict.timedOut, row.timedOut);
    assert.equal(
      verdict.failureReason === null,
      row.succeeded,
      "a reason is present exactly when the Run failed",
    );
  });
}

test("a delivery failure is not read as an agent that exited without finishing", () => {
  // The agent's own clean exit rides on a DELIVER envelope, and "exit 0 with no
  // successful terminal event" is a statement about the agent process. Reading
  // it here is what forced the runner to overwrite `terminalEventSeen` and
  // `terminalSuccess` on a mechanically settled or post-delivery-disconnect run
  // before handing the envelope over.
  const verdict = verdictOf({
    case: "provider-failure",
    reason: "remote rejected the push",
    envelope: envelope({
      phase: "DELIVER",
      exitCode: 0,
      terminalEventSeen: false,
      terminalSuccess: false,
      stderrSummary: "remote rejected the push",
    }),
  });
  assert.equal(verdict.failureClass, FailureClass.TASK_FAILED);
  assert.equal(verdict.externalFailure, true, "the agent finished; the push is the runner's plumbing");
});

test("the same envelope in EXECUTE is still the protocol drift it was", () => {
  const verdict = verdictOf({
    case: "provider-failure",
    reason: "the provider stream ended without a terminal event",
    envelope: envelope({
      exitCode: 0,
      terminalEventSeen: false,
      terminalSuccess: false,
      stderrSummary: null,
    }),
  });
  assert.equal(verdict.failureClass, FailureClass.PROTOCOL_ERROR);
  assert.equal(verdict.retryable, true);
});
