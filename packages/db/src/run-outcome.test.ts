import assert from "node:assert/strict";
import test from "node:test";

import { agentExitVerdict, type AgentExitEvidence, type AgentExitVerdict } from "./run-outcome.js";

const exit = (overrides: Partial<AgentExitEvidence> = {}): AgentExitEvidence => ({
  exitCode: 0,
  signal: null,
  terminalEventSeen: false,
  terminalSuccess: false,
  terminationReason: null,
  ...overrides,
});

// One row per case, plus the record shapes that used to be read field by field
// at each of the four call sites this verdict replaced.
const rows: Array<{ name: string; evidence: AgentExitEvidence; verdict: AgentExitVerdict }> = [
  {
    name: "an agent that reported success and exited cleanly",
    evidence: exit({ terminalEventSeen: true, terminalSuccess: true }),
    verdict: { case: "succeeded" },
  },
  {
    name: "an agent that reported failure",
    evidence: exit({ terminalEventSeen: true, exitCode: 1 }),
    verdict: { case: "refused" },
  },
  {
    name: "an agent that reported failure and still exited zero",
    evidence: exit({ terminalEventSeen: true }),
    verdict: { case: "refused" },
  },
  {
    name: "a rejection the runner then stopped",
    evidence: exit({ terminalEventSeen: true, signal: "SIGKILL" }),
    verdict: { case: "refused" },
  },
  {
    name: "a success claim its process contradicted with a non-zero exit",
    evidence: exit({ terminalEventSeen: true, terminalSuccess: true, exitCode: 1 }),
    verdict: { case: "contradicted" },
  },
  {
    name: "a success claim the runner stopped anyway",
    evidence: exit({ terminalEventSeen: true, terminalSuccess: true, terminationReason: "stall budget" }),
    verdict: { case: "contradicted" },
  },
  {
    name: "a success claim a signal cut short",
    evidence: exit({ terminalEventSeen: true, terminalSuccess: true, signal: "SIGTERM" }),
    verdict: { case: "contradicted" },
  },
  {
    name: "a child the runner killed before it said anything",
    evidence: exit({ terminationReason: "stall budget" }),
    verdict: { case: "stopped" },
  },
  {
    name: "a child a signal killed before it said anything",
    evidence: exit({ signal: "SIGKILL", exitCode: null }),
    verdict: { case: "stopped" },
  },
  {
    name: "a stream that dropped after the CLI shut itself down in order",
    evidence: exit(),
    verdict: { case: "dropped", cleanExit: true },
  },
  {
    name: "a stream that dropped with the CLI itself failing",
    evidence: exit({ exitCode: 1 }),
    verdict: { case: "dropped", cleanExit: false },
  },
  {
    name: "a stream that dropped without the process reporting an exit at all",
    evidence: exit({ exitCode: null }),
    verdict: { case: "dropped", cleanExit: false },
  },
];

for (const row of rows) {
  test(`the exit verdict for ${row.name}`, () => {
    assert.deepEqual(agentExitVerdict(row.evidence), row.verdict);
  });
}

test("the optional exit fields are absent, not null, on evidence that omits them", () => {
  assert.deepEqual(
    agentExitVerdict({ exitCode: 0, terminalEventSeen: true, terminalSuccess: true }),
    { case: "succeeded" },
  );
  assert.deepEqual(agentExitVerdict({ exitCode: 0, terminalEventSeen: false, terminalSuccess: false }), {
    case: "dropped",
    cleanExit: true,
  });
});
