import assert from "node:assert/strict";
import test from "node:test";

import { advanceTemplateTask, applyInboxDecisionTx, AssigneeType, RunStatus, RunnerPreference } from "@agentos/db";

test("a template approval gate persists an outbox card and leaves the task in review", async () => {
  const updates: unknown[] = [];
  let gate: Record<string, unknown> | undefined;
  const task = { id: "task-1", name: "Write spec", templateId: "template-1", approvalGate: true, followUpTaskId: "task-2", followUpTask: { id: "task-2" } };
  const tx = {
    task: {
      findUniqueOrThrow: async () => task,
      update: async ({ data }: { data: unknown }) => { updates.push(data); return task; },
    },
    run: { findUniqueOrThrow: async () => ({ id: "run-1", agentId: "agent-1", session: { id: "session-1" } }) },
    inboxThread: { upsert: async () => ({ id: "thread-1" }) },
    inboxMessage: { create: async ({ data }: { data: Record<string, unknown> }) => { gate = data; return { id: "gate-1", ...data }; } },
  } as any;
  const result = await advanceTemplateTask(tx, task.id, "run-1", "chat-1");
  assert.equal(result.gated, true);
  assert.deepEqual(updates[0], { status: "REVIEW" });
  assert.equal(gate?.gateTaskId, task.id);
  assert.deepEqual(gate?.choices, [{ id: "approve", label: "批准并继续" }, { id: "reject", label: "打回上一步" }]);
});

test("the shared decision compare-and-set makes a second Web or Feishu click a no-op", async () => {
  let decisionWrites = 0;
  const tx = {
    inboxMessage: {
      findUnique: async () => ({ id: "gate-1", gateTaskId: "task-1", session: { id: "session-1", run: { id: "run-1", status: RunStatus.SUCCEEDED } }, gateTask: { id: "task-1" } }),
      updateMany: async () => ({ count: 0 }),
      create: async () => { throw new Error("must not create reply"); },
    },
    inboxDecision: { create: async () => { decisionWrites += 1; } },
  } as any;
  assert.deepEqual(await applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "web:req-2", decision: "approve" }), {
    duplicate: true, resumed: false,
  });
  assert.equal(decisionWrites, 0);
});

test("rejecting a gate transactionally returns the producing step to the queue", async () => {
  const queued: Record<string, unknown>[] = [];
  const executable = {
    id: "task-1", projectId: "project-1", name: "Write spec", description: "spec", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1", repoId: "repo-1", targetBranch: "main", maxDurationMin: 120, stallTimeoutMin: 10,
    maxSessionsPerTask: 3, assigneeAgent: { id: "agent-1", model: "claude", runnerPreference: RunnerPreference.CLAUDE, foundationalPrompt: "f", rolePrompt: "r" },
    repo: { id: "repo-1", defaultBranch: "main" }, templateStep: { runner: null }, runs: [{ runNumber: 1, branch: "feature/x" }],
  };
  let lookup = 0;
  const tx = {
    inboxMessage: {
      findUnique: async () => ({
        id: "gate-1", gateTaskId: "task-1", agentId: "agent-1", sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status: RunStatus.SUCCEEDED } },
        gateTask: { id: "task-1", assigneeType: AssigneeType.AGENT, previousTask: null },
      }),
      updateMany: async () => ({ count: 1 }),
      create: async () => ({ id: "reply-1" }),
    },
    inboxDecision: { create: async () => ({}) },
    task: {
      update: async () => ({}),
      findUniqueOrThrow: async () => { lookup += 1; return executable; },
    },
    taskActivity: { create: async () => ({}) },
    run: { create: async ({ data }: { data: Record<string, unknown> }) => { queued.push(data); return { id: "run-2", ...data }; } },
  } as any;
  const result = await applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "feishu:evt-1", decision: "reject" });
  assert.equal(result.gateAction, "rejected");
  assert.equal(lookup, 1);
  assert.equal(queued[0]!.runNumber, 2);
  assert.equal(queued[0]!.branch, "feature/x");
});
