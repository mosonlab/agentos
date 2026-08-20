import assert from "node:assert/strict";
import test from "node:test";

import type { ExitEvidence } from "./adapters.js";
import { buildFailureEnvelope, FAILURE_EVIDENCE_LIMIT, summarizeEvidence } from "./envelope.js";
import { CommandTimeoutError } from "./exec.js";

const evidence = (overrides: Partial<ExitEvidence> = {}): ExitEvidence => ({
  exitCode: 1,
  signal: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  terminationReason: null,
  finalOutput: null,
  providerError: null,
  stdout: "",
  stderr: "",
  ...overrides,
});

test("the envelope keeps each stream on its own channel", () => {
  const envelope = buildFailureEnvelope({
    phase: "EXECUTE",
    agentExited: true,
    runnerClass: "TASK_FAILED",
    evidence: evidence({ stdout: "  wrote the 401 handler  ", stderr: " connection lost ", providerError: " server_error " }),
  });
  assert.equal(envelope.stdoutSummary, "wrote the 401 handler");
  assert.equal(envelope.stderrSummary, "connection lost");
  assert.equal(envelope.providerError, "server_error");
  // The runner's own guess rides along as evidence and nothing more.
  assert.equal(envelope.runnerClass, "TASK_FAILED");
  assert.equal(envelope.agentExited, true);
  assert.equal(envelope.phase, "EXECUTE");
});

test("empty and whitespace-only streams become null rather than empty strings", () => {
  const envelope = buildFailureEnvelope({ phase: "PROVISION", agentExited: false, evidence: evidence({ stderr: "   \n " }) });
  assert.equal(envelope.stderrSummary, null);
  assert.equal(envelope.stdoutSummary, null);
  assert.equal(envelope.providerError, null);
  assert.equal(envelope.runnerClass, null);
});

test("truncation keeps the tail, where a CLI states its verdict", () => {
  const noise = "progress\n".repeat(2_000);
  const summary = summarizeEvidence(`${noise}fatal: Authentication failed`);
  assert.ok(summary);
  assert.ok(summary.endsWith("fatal: Authentication failed"), "the verdict at the end of the stream must survive");
  assert.match(summary, /^…\[\d+ earlier characters truncated\]\n/u);
  assert.ok(summary.length <= FAILURE_EVIDENCE_LIMIT + 64);
});

test("a typed CommandTimeoutError marks the envelope timed out and transient", () => {
  const envelope = buildFailureEnvelope({
    phase: "DELIVER",
    agentExited: true,
    evidence: evidence(),
    error: new CommandTimeoutError("git", ["push"], 20_000),
  });
  assert.equal(envelope.timedOut, true);
  assert.equal(envelope.transient, true);
  assert.equal(envelope.timeoutMs, 20_000);
});

test("the CLI's own 'timed out' wording is not this runner's command timeout", () => {
  // adapters.ts emits exactly this for a missing or broken binary. It is a
  // deterministic failure; reading it as a timeout would make it retryable.
  const preflight = "preflight timed out after 15 seconds";
  const envelope = buildFailureEnvelope({
    phase: "PROVISION",
    agentExited: false,
    evidence: evidence({ stderr: preflight }),
    error: new Error(preflight),
  });
  assert.equal(envelope.timedOut, false);
  assert.equal(envelope.transient, false);
  assert.equal(envelope.timeoutMs, null);
  assert.equal(envelope.stderrSummary, preflight);
});

test("no error at all leaves the typed markers clear", () => {
  const envelope = buildFailureEnvelope({ phase: "EXECUTE", agentExited: true, evidence: evidence({ stderr: "ECONNRESET" }) });
  // The text says transient, but nothing typed was observed: the API decides
  // what that text means, this module does not.
  assert.equal(envelope.transient, false);
  assert.equal(envelope.timedOut, false);
});

test("an ordered kill overrides the reason the dead process never got to give", () => {
  const envelope = buildFailureEnvelope({
    phase: "EXECUTE",
    agentExited: true,
    evidence: evidence({ signal: "SIGKILL", terminationReason: null }),
    terminationReason: "walltime: exceeded 120 minutes",
  });
  assert.equal(envelope.terminationReason, "walltime: exceeded 120 minutes");
  assert.equal(envelope.signal, "SIGKILL");
});
