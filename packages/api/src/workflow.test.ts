import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  activateChainSuccessor,
  advanceTemplateTask,
  applyInboxDecisionTx,
  ArchivedAssigneeError,
  AssigneeType,
  deriveRunConfig,
  enqueueTaskRun,
  InboxKind,
  isArchivedAssigneeError,
  isArchivedTaskError,
  RunStatus,
  runnerFor,
  RunnerKind,
  RunnerPreference,
  type PrismaClient,
} from "@agentos/db";

import { createApp } from "./app.js";
import { noteArchivedQueuedRuns } from "./reconcile.js";

test("runnerFor preserves explicit preferences and every inherited model heuristic", () => {
  const cases: [RunnerPreference, string, RunnerKind][] = [
    [RunnerPreference.CLAUDE, "openai-codex", RunnerKind.CLAUDE],
    [RunnerPreference.CODEX, "deepseek-r1", RunnerKind.CODEX],
    [RunnerPreference.PI, "claude-opus-5", RunnerKind.PI],
    [RunnerPreference.INHERIT, "openai-codex/gpt", RunnerKind.CODEX],
    [RunnerPreference.INHERIT, "deepseek-r1", RunnerKind.PI],
    [RunnerPreference.INHERIT, "agent-pi-v2", RunnerKind.PI],
    [RunnerPreference.AUTO, "agent/pi-v2", RunnerKind.PI],
    [RunnerPreference.INHERIT, "OpenAI-CoDeX/GPT", RunnerKind.CODEX],
    [RunnerPreference.INHERIT, "claude-opus-5", RunnerKind.CLAUDE],
    [RunnerPreference.INHERIT, "anthropic/claude-opus-5", RunnerKind.CLAUDE],
    [RunnerPreference.AUTO, "openrouter/anthropic/claude-opus-5", RunnerKind.CLAUDE],
    [RunnerPreference.AUTO, "apiary/model", RunnerKind.CLAUDE],
  ];
  for (const [preference, model, expected] of cases) {
    assert.equal(runnerFor(preference, model), expected, `${preference} / ${model}`);
  }
});

test("deriveRunConfig preserves model, template override, and exact prompt hash", () => {
  const agent = {
    runnerPreference: RunnerPreference.PI,
    model: "current-model",
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  };
  const task = { name: "Task name", description: "Task description" };
  assert.deepEqual(deriveRunConfig(agent, { runner: RunnerKind.CODEX }, task), {
    runner: RunnerKind.CODEX,
    model: "current-model",
    promptHash: createHash("sha256").update("foundation\nrole\nTask name\nTask description").digest("hex"),
  });
});

test("task creation keeps its runner, model, and promptHash output while derivation is shared", async () => {
  const previousToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "operator-workflow-test";
  try {
    let runData: Record<string, unknown> | undefined;
    const agent = {
      id: "agent-1",
      model: "OpenAI-CoDeX/GPT",
      runnerPreference: RunnerPreference.INHERIT,
      foundationalPrompt: "foundation",
      rolePrompt: "role",
    };
    const database = {
      agent: { findFirst: async () => agent },
      repo: { findFirst: async () => ({ id: "repo-1", defaultBranch: "main" }) },
      agentRepoAccess: { findFirst: async () => ({ id: "grant-1" }) },
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
        task: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "task-1", ...data }) },
        taskActivity: { create: async () => ({ id: "activity-1" }) },
        run: { create: async ({ data }: { data: Record<string, unknown> }) => { runData = data; return { id: "run-1", ...data }; } },
      }),
    } as unknown as PrismaClient;
    const response = await createApp(database).request("/projects/project-1/tasks", {
      method: "POST",
      headers: { Authorization: "Bearer operator-workflow-test", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Task name",
        description: "Task description",
        repoId: "repo-1",
        assigneeAgentId: "agent-1",
      }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual({
      runner: runData?.runner,
      model: runData?.model,
      promptHash: runData?.promptHash,
    }, {
      runner: RunnerKind.CODEX,
      model: agent.model,
      promptHash: createHash("sha256").update("foundation\nrole\nTask name\nTask description").digest("hex"),
    });
  } finally {
    if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousToken;
  }
});

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
    run: {
      create: async ({ data }: { data: Record<string, unknown> }) => { queued.push(data); return { id: "run-1" }; },
      // resolveRunBranches asks whether any run of this chain has published the
      // shared branch on this repo. Nothing has here, so the successor bases on
      // the repo default.
      findFirst: async () => null,
    },
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
  const events: string[] = [];
  const tx = {
    $queryRaw: async () => { events.push("task-lock"); return [{ id: "task-1", archivedAt: null }]; },
    inboxMessage: {
      findUnique: async () => ({ id: "gate-1", gateTaskId: "task-1", session: { id: "session-1", run: { id: "run-1", status: RunStatus.SUCCEEDED } }, gateTask: { id: "task-1" } }),
      updateMany: async () => { events.push("open-cas"); return { count: 0 }; },
      create: async () => { throw new Error("must not create reply"); },
    },
    inboxDecision: { create: async () => { decisionWrites += 1; } },
  } as any;
  assert.deepEqual(await applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "web:req-2", decision: "approve" }), {
    duplicate: true, resumed: false,
  });
  assert.equal(decisionWrites, 0);
  assert.deepEqual(events, ["task-lock", "open-cas"]);
});

const rejectionTx = (options: { redoArchivedAt?: Date | null } = {}) => {
  const queued: Record<string, unknown>[] = [];
  const locks: string[] = [];
  const executable = {
    id: "task-1", projectId: "project-1", name: "Write spec", description: "spec", assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1", repoId: "repo-1", targetBranch: "main", maxDurationMin: 120, stallTimeoutMin: 10,
    maxSessionsPerTask: 3, archivedAt: null,
    assigneeAgent: { id: "agent-1", model: "claude", runnerPreference: RunnerPreference.CLAUDE, foundationalPrompt: "f", rolePrompt: "r" },
    repo: { id: "repo-1", defaultBranch: "main" }, templateStep: { runner: null }, runs: [{ runNumber: 1, branch: "feature/x" }],
  };
  let lookup = 0;
  const tx = {
    // The Task-row mutex the reject path now takes before queueing the redo.
    // Returning the archive state from *this* read, not from the row that
    // travelled with the Inbox message, is the point of the lock.
    $queryRaw: async (_strings: unknown, taskId: string) => {
      locks.push(taskId);
      return [{ id: taskId, archivedAt: options.redoArchivedAt ?? null }];
    },
    inboxMessage: {
      findUnique: async () => ({
        id: "gate-1", gateTaskId: "task-1", agentId: "agent-1", sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status: RunStatus.SUCCEEDED } },
        gateTask: { id: "task-1", name: "Write spec", assigneeType: AssigneeType.AGENT, previousTask: null },
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
  return { tx, queued, locks, lookups: () => lookup };
};

test("rejecting a gate transactionally returns the producing step to the queue", async () => {
  const { tx, queued, locks, lookups } = rejectionTx();
  const result = await applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "feishu:evt-1", decision: "reject" });
  assert.equal(result.gateAction, "rejected");
  assert.equal(lookups(), 1);
  assert.deepEqual(locks, ["task-1"]);
  assert.equal(queued[0]!.runNumber, 2);
  assert.equal(queued[0]!.branch, "feature/x");
});

test("rejecting a gate onto an archived predecessor throws rather than queueing a run nothing will claim", async () => {
  // The runner claims only unarchived TODO/DOING tasks, so a run queued here
  // would sit forever. Throwing rolls the transaction back, which leaves the
  // Inbox decision OPEN for the human to make again after unarchiving.
  const { tx, queued } = rejectionTx({ redoArchivedAt: new Date("2026-08-16T00:00:00.000Z") });
  await assert.rejects(
    () => applyInboxDecisionTx(tx, { inboxMessageId: "gate-1", externalEventId: "feishu:evt-2", decision: "reject" }),
    (error: unknown) => isArchivedTaskError(error) && /archived/.test((error as Error).message),
  );
  assert.equal(queued.length, 0);
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

test("enqueueTaskRun rejects archived agents with a name-recognisable typed error", async () => {
  const tx = {
    task: {
      findUniqueOrThrow: async () => ({
        id: "task-archived", projectId: "project-1", name: "Archived work", description: "work",
        assigneeType: AssigneeType.AGENT, templateId: null, targetBranch: "main",
        maxDurationMin: 120, stallTimeoutMin: 10, maxSessionsPerTask: 3, runs: [],
        assigneeAgent: {
          id: "agent-1", name: "Ada", archivedAt: new Date(), model: "claude",
          runnerPreference: RunnerPreference.CLAUDE, foundationalPrompt: "f", rolePrompt: "r",
        },
        repo: { id: "repo-1", defaultBranch: "main" },
        templateStep: null,
      }),
    },
    run: { create: async () => { throw new Error("must not create run"); } },
  } as any;
  const error = await enqueueTaskRun(tx, "task-archived").then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof ArchivedAssigneeError);
  assert.equal(isArchivedAssigneeError(error), true);
  assert.equal(isArchivedAssigneeError({ name: "ArchivedAssigneeError" }), false);
});

test("chain advancement parks an archived successor without throwing or enqueueing", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  let creates = 0;
  const next = {
    id: "task-2", assigneeType: AssigneeType.AGENT, assigneeAgentId: "agent-2", approvalGate: false,
    repoId: "repo-1", updatedAt: new Date(), runs: [],
    assigneeAgent: { id: "agent-2", name: "Archived Successor", archivedAt: new Date() },
  };
  const tx = {
    task: {
      findUniqueOrThrow: async () => ({
        id: "task-1", name: "Completed predecessor", templateId: "template-1", approvalGate: false,
        followUpTaskId: next.id, followUpTask: next,
      }),
      // advanceTemplateTask now delegates to the shared activateChainSuccessor,
      // which re-reads the successor itself and CAS-claims it before enqueueing.
      findUnique: async () => next,
      updateMany: async () => ({ count: 1 }),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, ...data });
        return {};
      },
    },
    run: { create: async () => { creates += 1; return {}; } },
    taskActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => { activities.push(data); return {}; },
    },
  } as any;
  assert.deepEqual(await advanceTemplateTask(tx, "task-1", "run-1", null), {
    gated: false,
    nextTaskId: "task-2",
  });
  assert.equal(creates, 0);
  assert.equal(updates[1]?.status, "REVIEW");
  assert.match(String(updates[1]?.failureReason), /Archived Successor/);
  assert.match(String(activities[0]?.body), /Archived Successor.*not queued/);
});

test("an Inbox-resumed queued run for an archived agent is surfaced by the sweep", async () => {
  let status: RunStatus = RunStatus.WAITING_INBOX;
  const archivedAt = new Date("2026-08-16T06:00:00.000Z");
  const tx = {
    inboxMessage: {
      findUnique: async () => ({
        id: "question-1", kind: InboxKind.TEXT, gateTaskId: null, agentId: "agent-1",
        sessionId: "session-1", taskId: "task-1", goalId: null, threadId: "thread-1",
        session: { id: "session-1", run: { id: "run-1", status } }, gateTask: null,
      }),
      updateMany: async () => ({ count: 1 }),
      create: async () => ({ id: "reply-1" }),
    },
    inboxDecision: { create: async () => ({}) },
    run: { updateMany: async () => { status = RunStatus.QUEUED; return { count: 1 }; } },
    session: { update: async () => ({}) },
  } as any;
  await applyInboxDecisionTx(tx, {
    inboxMessageId: "question-1", externalEventId: "web:resume", decision: "continue",
  });
  const notices: Record<string, unknown>[] = [];
  const db = {
    run: {
      findMany: async () => status === RunStatus.QUEUED
        ? [{ id: "run-1", taskId: "task-1", runNumber: 1, agent: { name: "Archived", archivedAt } }]
        : [],
    },
    taskActivity: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => { notices.push(...data); return { count: data.length }; },
    },
  } as unknown as PrismaClient;
  assert.equal(await noteArchivedQueuedRuns(db), 1);
  assert.match(String(notices[0]?.body), /Archived.*run 1/);
});
