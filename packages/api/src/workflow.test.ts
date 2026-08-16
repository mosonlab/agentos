import assert from "node:assert/strict";
import test from "node:test";

import { activateChainSuccessor, advanceTemplateTask, applyInboxDecisionTx, AssigneeType, enqueueTaskRun, InboxKind, RunStatus, RunnerPreference } from "@agentos/db";

test("chain successor lookup is project-scoped, gap tolerant, and CAS claimed before queueing", async () => {
  const queued: Record<string, unknown>[] = [];
  let lookup: Record<string, unknown> | undefined;
  const successor = {
    id: "task-3", projectId: "project-1", name: "Ship", description: "ship", chainId: "chain-1", chainIndex: 3,
    updatedAt: new Date(), assigneeType: AssigneeType.AGENT, assigneeAgentId: "agent-1", repoId: "repo-1",
    templateId: null, targetBranch: "main", maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 5, runs: [],
    assigneeAgent: { id: "agent-1", model: "claude", runnerPreference: RunnerPreference.CLAUDE, foundationalPrompt: "f", rolePrompt: "r" },
    repo: { id: "repo-1", defaultBranch: "main" }, templateStep: null,
  };
  const tx = {
    task: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { lookup = where; return successor; },
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => successor,
    },
    run: { create: async ({ data }: { data: Record<string, unknown> }) => { queued.push(data); return { id: "run-1" }; } },
    taskActivity: { create: async () => ({}) },
  } as any;
  const result = await activateChainSuccessor(tx, {
    id: "task-1", projectId: "project-1", name: "Build", chainId: "chain-1", chainIndex: 0, followUpTaskId: null,
  });
  assert.deepEqual(lookup, { projectId: "project-1", chainId: "chain-1", chainIndex: { gt: 0 } });
  assert.equal(result.nextTaskId, "task-3");
  assert.equal(queued.length, 1);
});

test("chain activation skips an already-active successor and marks the final step complete", async () => {
  const activities: string[] = [];
  let successor: any = { id: "task-2", runs: [{ status: RunStatus.RUNNING }] };
  const tx = {
    task: { findFirst: async () => successor },
    taskActivity: { create: async ({ data }: { data: { body: string } }) => { activities.push(data.body); return {}; } },
  } as any;
  const task = { id: "task-1", projectId: "project-1", name: "One", chainId: "chain-1", chainIndex: 0, followUpTaskId: null };
  assert.equal((await activateChainSuccessor(tx, task)).nextTaskId, "task-2");
  successor = null;
  assert.deepEqual(await activateChainSuccessor(tx, task), { nextTaskId: null, gated: false });
  assert.deepEqual(activities, ["Predecessor completed; successor already active", "Chain complete"]);
});

test("a malformed chain row records an activity and falls back to followUpTaskId", async () => {
  const activities: string[] = [];
  const successor = { id: "fallback", updatedAt: new Date(), assigneeType: AssigneeType.HUMAN, assigneeAgentId: null, repoId: null, runs: [] };
  const tx = {
    task: { findUnique: async () => successor, updateMany: async () => ({ count: 1 }) },
    taskActivity: { create: async ({ data }: { data: { body: string } }) => { activities.push(data.body); return {}; } },
  } as any;
  await activateChainSuccessor(tx, {
    id: "broken", projectId: "project-1", name: "Broken", chainId: "chain-1", chainIndex: null, followUpTaskId: "fallback",
  });
  assert.deepEqual(activities, ["Chain row missing chainIndex; auto-advance skipped", "Predecessor completed; successor awaits operator"]);
});

test("a later chain step runs on the chain's shared branch so the chain lands in one PR", async () => {
  const queued: Record<string, unknown>[] = [];
  const tx = {
    task: {
      findUniqueOrThrow: async () => ({
        id: "task-2", projectId: "project-1", name: "Plan", description: "plan", assigneeType: AssigneeType.AGENT,
        assigneeAgentId: "agent-1", templateId: "template-1", targetBranch: "feat/lines", maxDurationMin: 120,
        stallTimeoutMin: 10, maxSessionsPerTask: 5, runs: [],
        assigneeAgent: { id: "agent-1", model: "claude", runnerPreference: RunnerPreference.CLAUDE, foundationalPrompt: "f", rolePrompt: "r" },
        repo: { id: "repo-1", defaultBranch: "main" }, templateStep: { runner: null },
      }),
    },
    run: { create: async ({ data }: { data: Record<string, unknown> }) => { queued.push(data); return { id: "run-1", ...data }; } },
  } as any;
  await enqueueTaskRun(tx, "task-2");
  assert.equal(queued[0]!.branch, "feat/lines");
  assert.equal(queued[0]!.targetBranch, "feat/lines");
});

test("a template approval gate persists an outbox card and leaves the task in review", async () => {
  const updates: unknown[] = [];
  let gate: Record<string, unknown> | undefined;
  const task = { id: "task-1", name: "Write spec", templateId: "template-1", approvalGate: true, followUpTaskId: "task-2", followUpTask: { id: "task-2" } };
  const tx = {
    task: {
      findUniqueOrThrow: async () => task,
      update: async ({ data }: { data: unknown }) => { updates.push(data); return task; },
    },
    run: { findUniqueOrThrow: async () => ({ id: "run-1", taskId: task.id, agentId: "agent-1", pullRequestUrl: "https://github.com/acme/app/pull/7", session: { id: "session-1" } }) },
    inboxThread: { upsert: async () => ({ id: "thread-1" }) },
    inboxMessage: { create: async ({ data }: { data: Record<string, unknown> }) => { gate = data; return { id: "gate-1", ...data }; } },
    taskStepOutput: { findUnique: async () => ({ kind: "spec", body: "S".repeat(1_500) }) },
  } as any;
  const result = await advanceTemplateTask(tx, task.id, "run-1", "chat-1");
  assert.equal(result.gated, true);
  assert.deepEqual(updates[0], { status: "REVIEW" });
  assert.equal(gate?.gateTaskId, task.id);
  // The approver decides from the card: PR link plus a truncated artifact preview.
  assert.match(String(gate?.body), /pull\/7/);
  assert.match(String(gate?.body), /产物（spec）/);
  assert.match(String(gate?.body), /已截断/);
  assert.ok(String(gate?.body).length < 1_500);
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

test("a multiple-choice Inbox decision accepts an option id and persists the human reply", async () => {
  let reply: Record<string, unknown> | undefined;
  let resumeInput: unknown;
  const tx = {
    inboxMessage: {
      findUnique: async () => ({
        id: "question-1", kind: InboxKind.MULTIPLE_CHOICE,
        choices: [{ id: "ship", label: "Ship it" }, { id: "wait", label: "Wait" }],
        gateTaskId: null, agentId: "agent-1", sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status: RunStatus.WAITING_INBOX } }, gateTask: null,
      }),
      updateMany: async () => ({ count: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => { reply = data; return { id: "reply-1" }; },
    },
    inboxDecision: { create: async () => ({}) },
    run: { updateMany: async () => ({ count: 1 }) },
    session: { update: async ({ data }: { data: { resumeInput: unknown } }) => { resumeInput = data.resumeInput; return {}; } },
  } as any;
  const result = await applyInboxDecisionTx(tx, {
    inboxMessageId: "question-1", externalEventId: "web:ship", decision: "ship", actorOpenId: "web-operator",
  });
  assert.equal(result.resumed, true);
  assert.equal(reply?.from, "HUMAN");
  assert.equal(reply?.selectedChoiceId, "ship");
  assert.equal(resumeInput, "ship");
  await assert.rejects(() => applyInboxDecisionTx(tx, {
    inboxMessageId: "question-1", externalEventId: "web:unknown", decision: "unknown",
  }), /must match an Inbox choice id/);
});
