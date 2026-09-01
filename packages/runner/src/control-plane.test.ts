import assert from "node:assert/strict";
import test from "node:test";

import {
  authorityAfterHeartbeat,
  authorityFor,
  ControlPlaneError,
  readSessionTaskOutputStatus,
  retriableStartupError,
} from "./api.js";

test("ControlPlaneError classifies Run authority without leaking HTTP casts to callers", () => {
  assert.deepEqual(authorityFor(new ControlPlaneError(409, "stale fence")), {
    held: false,
    reason: "revoked",
  });
  assert.deepEqual(authorityFor(new ControlPlaneError(409, "suspended", "WAITING_INBOX")), {
    held: false,
    reason: "waiting-inbox",
  });
  assert.deepEqual(authorityFor(new ControlPlaneError(503, "unavailable")), { held: true });
  assert.deepEqual(authorityFor(new Error("connection reset")), { held: true });
});

test("heartbeat cancellation is an Authority verdict with its durable request", () => {
  const request = { requestId: "cancel-1", reason: "operator stop", requestedAt: new Date(0).toISOString() };
  assert.deepEqual(authorityAfterHeartbeat({ ok: false, cancellation: request }), {
    held: false,
    reason: "cancelled",
    request,
  });
  assert.deepEqual(authorityAfterHeartbeat({ ok: true, cancellation: null }), { held: true });
});

test("startup retries only transport failures and control-plane server errors", () => {
  assert.equal(retriableStartupError(new Error("connection reset")), true);
  assert.equal(retriableStartupError(new ControlPlaneError(503, "unavailable")), true);
  assert.equal(retriableStartupError(new ControlPlaneError(401, "unauthorized")), false);
  assert.equal(retriableStartupError(new ControlPlaneError(409, "refused")), false);
});

test("session status validates and normalizes the nested PR workflow evidence projection", async () => {
  const originalFetch = globalThis.fetch;
  const output = {
    taskId: "task-implementation",
    chainIndex: 1,
    kind: "implementation",
    body: JSON.stringify({ schemaVersion: 1 }),
    commitSha: "a".repeat(40),
  } as const;
  globalThis.fetch = async () => new Response(JSON.stringify({
    task: {
      outputKind: "implementation",
      outputRequired: true,
      outputRemediationAllowed: true,
      outputSatisfiedByPriorRun: false,
      outputPersisted: true,
      output: { runId: "run-1", kind: "implementation", commitSha: output.commitSha },
      prWorkflowOutputs: [output],
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const status = await readSessionTaskOutputStatus(
      {
        apiUrl: "http://anneal.test",
        runnerToken: "runner-token",
        apiTimeoutMs: 1000,
      } as never,
      { run: { id: "run-1" }, fencingToken: "fence", sessionToken: "session-token" },
    );
    assert.deepEqual(status?.prWorkflowOutputs, [output]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session status rejects malformed PR workflow evidence entries", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    task: {
      outputKind: "fixed-implementation",
      outputRequired: true,
      outputRemediationAllowed: true,
      outputSatisfiedByPriorRun: false,
      outputPersisted: true,
      output: null,
      prWorkflowOutputs: [{
        taskId: "task-fixed",
        chainIndex: "4",
        kind: "fixed-implementation",
        body: "{}",
        commitSha: "b".repeat(40),
      }],
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      readSessionTaskOutputStatus(
        {
          apiUrl: "http://anneal.test",
          runnerToken: "runner-token",
          apiTimeoutMs: 1000,
        } as never,
        { run: { id: "run-1" }, fencingToken: "fence", sessionToken: "session-token" },
      ),
      /invalid task output status/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session status accepts the exact ordered final PR evidence set including SHA-256", async () => {
  const originalFetch = globalThis.fetch;
  const kinds = ["implementation", "sol-findings", "blind-findings", "fixed-implementation"] as const;
  const outputs = kinds.map((kind, index) => ({
    taskId: `task-${kind}`,
    chainIndex: index + 1,
    kind,
    body: JSON.stringify({ schemaVersion: 1, kind }),
    commitSha: index === 3 ? "d".repeat(64) : String(index + 1).repeat(40),
  }));
  globalThis.fetch = async () => new Response(JSON.stringify({
    task: {
      outputKind: "fixed-implementation",
      outputRequired: true,
      outputRemediationAllowed: true,
      outputSatisfiedByPriorRun: false,
      outputPersisted: true,
      output: { runId: "run-1", kind: "fixed-implementation", commitSha: outputs[3]!.commitSha },
      prWorkflowOutputs: outputs,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const status = await readSessionTaskOutputStatus(
      { apiUrl: "http://anneal.test", runnerToken: "runner-token", apiTimeoutMs: 1000 } as never,
      { run: { id: "run-1" }, fencingToken: "fence", sessionToken: "session-token" },
    );
    assert.deepEqual(status?.prWorkflowOutputs, outputs);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const malformed of [
  { name: "nullable commit", mutate: (outputs: any[]) => { outputs[0].commitSha = null; } },
  { name: "duplicate Task identity", mutate: (outputs: any[]) => { outputs[1].taskId = outputs[0].taskId; } },
  { name: "out-of-order chain index", mutate: (outputs: any[]) => { outputs[1].chainIndex = 1; } },
] as const) {
  test(`session status rejects ${malformed.name} in final PR evidence`, async () => {
    const originalFetch = globalThis.fetch;
    const outputs = ["implementation", "sol-findings", "blind-findings", "fixed-implementation"].map((kind, index) => ({
      taskId: `task-${kind}`,
      chainIndex: index + 1,
      kind,
      body: "{}",
      commitSha: String(index + 1).repeat(40),
    }));
    malformed.mutate(outputs);
    globalThis.fetch = async () => new Response(JSON.stringify({
      task: {
        outputKind: "fixed-implementation", outputRequired: true, outputRemediationAllowed: true,
        outputSatisfiedByPriorRun: false, outputPersisted: true, output: null, prWorkflowOutputs: outputs,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      await assert.rejects(
        readSessionTaskOutputStatus(
          { apiUrl: "http://anneal.test", runnerToken: "runner-token", apiTimeoutMs: 1000 } as never,
          { run: { id: "run-1" }, fencingToken: "fence", sessionToken: "session-token" },
        ),
        /invalid task output status/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
