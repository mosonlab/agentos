import assert from "node:assert/strict";
import test from "node:test";

import {
  AssigneeType,
  CodexServiceTier,
  RunnerKind,
  RunnerPreference,
} from "@prisma/client";

import {
  type OpenRunIntent,
  openRun,
  runBudgetCeiling,
} from "./workflow.js";

const now = new Date("2026-08-26T12:00:00.000Z");

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "agent-1",
  projectId: "project-1",
  environmentId: null,
  name: "senior-dev",
  title: "Senior Developer",
  model: "claude-sonnet",
  codexServiceTier: CodexServiceTier.DEFAULT,
  runnerPreference: RunnerPreference.CLAUDE,
  foundationalPrompt: "foundation",
  rolePrompt: "role",
  inboxAccess: false,
  disabledTools: [],
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const priorRun = (overrides: Record<string, unknown> = {}) => ({
  id: "run-3",
  projectId: "project-1",
  taskId: "task-1",
  goalId: "goal-1",
  agentId: "agent-1",
  repoId: null,
  runNumber: 3,
  runner: RunnerKind.CLAUDE,
  model: "snapshot-model",
  codexServiceTier: CodexServiceTier.DEFAULT,
  subagentModel: null,
  subagentMaxConcurrent: null,
  targetBranch: "main",
  branch: "agentos/task-1/run-3",
  promptHash: "snapshot-hash",
  maxDurationMin: 90,
  stallTimeoutMin: 12,
  maxRunsPerTask: 5,
  budgetGrants: 1,
  ...overrides,
});

const taskRow = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1",
  projectId: "project-1",
  name: "Implement seam",
  description: "Create the Run once",
  assigneeType: AssigneeType.AGENT,
  assigneeAgentId: "agent-1",
  assigneeAgent: agent(),
  repoId: null,
  repo: null,
  templateId: null,
  templateStepId: null,
  templateStep: null,
  chainId: null,
  chainIndex: null,
  targetBranch: "main",
  opensPullRequest: true,
  maxDurationMin: 120,
  stallTimeoutMin: 10,
  maxSessionsPerTask: 5,
  archivedAt: null,
  runs: [],
  ...overrides,
});

const intents = (): OpenRunIntent[] => [
  { kind: "enqueue", readyAt: now },
  { kind: "task-created", readyAt: now },
  { kind: "retry", readyAt: now },
  { kind: "integrator-authorized", readyAt: now },
  {
    kind: "retry-after-completion",
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
    budgetGrant: 1,
  },
  {
    kind: "retry-after-lease-loss",
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
  },
];

const fakeTx = (
  task: ReturnType<typeof taskRow> | null,
  options: {
    lockedAgent?: ReturnType<typeof agent> | null;
    stopRows?: Array<Record<string, unknown>>;
  } = {},
) => {
  const creates: Array<Record<string, unknown>> = [];
  let agentLocks = 0;
  const tx = {
    $queryRaw: async () => {
      agentLocks += 1;
      return options.lockedAgent === null ? [] : [{ id: task?.assigneeAgentId ?? "agent-1" }];
    },
    agent: {
      findUnique: async () => options.lockedAgent === undefined ? task?.assigneeAgent ?? null : options.lockedAgent,
    },
    task: {
      findUnique: async () => task,
      findFirst: async () => null,
    },
    taskActivity: {
      findMany: async () => options.stopRows ?? [],
      create: async () => ({ id: "activity-1" }),
    },
    taskTemplateStep: { findUnique: async () => null },
    run: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: "opened-run", ...data };
      },
    },
  };
  return { tx: tx as never, creates, agentLocks: () => agentLocks };
};

const integratorStep = {
  id: "integrator-step",
  stepIndex: 12,
  outputKind: "merge-result",
  baseFromStepIndex: null,
  taskTemplate: { name: "compound-engineer-workflow" },
};

test("every OpenRunIntent applies the shared Run-birth invariants", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const stopRows = [{
    id: "stop-1",
    createdAt: now,
    metadata: {
      kind: "mergeIntegrator.result",
      schemaVersion: 1,
      outcome: "stopped",
      condition: "head-drift",
      evidence: "head moved",
      sourceRunId: "run-3",
    },
  }];
  const cases = [
    {
      name: "archived Task",
      task: taskRow({ archivedAt: now, repoId: repo.id, repo }),
      options: {},
      reason: "archived-task",
    },
    {
      name: "integrator stop state",
      task: taskRow({
        assigneeAgent: agent({ name: "merge-integrator" }),
        repoId: repo.id,
        repo,
        templateStepId: integratorStep.id,
        templateStep: integratorStep,
      }),
      options: { stopRows },
      reason: "integrator-stopped",
    },
    {
      name: "archived Agent under the shared row mutex",
      task: taskRow({ repoId: repo.id, repo }),
      options: { lockedAgent: agent({ archivedAt: now }) },
      reason: "archived-assignee",
    },
    {
      name: "compound implementation assignee",
      task: taskRow({
        repoId: repo.id,
        repo,
        templateStepId: "implementation-step",
        templateStep: {
          id: "implementation-step",
          stepIndex: 5,
          outputKind: "implementation",
          baseFromStepIndex: null,
          taskTemplate: { name: "compound-engineer-workflow" },
        },
      }),
      options: {},
      reason: "compound-implementation-assignee",
    },
    {
      name: "integrator binding",
      task: taskRow({ repoId: repo.id, repo, assigneeAgent: agent({ name: "merge-integrator" }) }),
      options: { lockedAgent: agent({ name: "merge-integrator" }) },
      reason: "invalid-request",
    },
  ] as const;

  for (const intent of intents()) {
    for (const invariant of cases) {
      const { tx, creates } = fakeTx(invariant.task, invariant.options);
      const opened = await openRun(tx, invariant.task.id, intent);
      assert.equal(opened.ok, false, `${intent.kind} must refuse ${invariant.name}`);
      if (!opened.ok) assert.equal(opened.refusal.reason, invariant.reason, `${intent.kind}: ${invariant.name}`);
      assert.equal(creates.length, 0, `${intent.kind} must not create after ${invariant.name}`);
    }
  }
});

test("openRun names every intent-specific refusal exit", async () => {
  const missing = await openRun(fakeTx(null).tx, "missing", { kind: "enqueue", readyAt: now });
  assert.deepEqual(missing, { ok: false, refusal: { reason: "not-found", message: "Task not found" } });

  const noAgentTask = taskRow({ assigneeType: AssigneeType.HUMAN, assigneeAgent: null, assigneeAgentId: null });
  const noAgent = await openRun(fakeTx(noAgentTask).tx, noAgentTask.id, { kind: "retry", readyAt: now });
  assert.equal(noAgent.ok ? null : noAgent.refusal.reason, "invalid-request");

  const noRepo = taskRow();
  const repoRequired = await openRun(fakeTx(noRepo).tx, noRepo.id, { kind: "enqueue", readyAt: now });
  assert.equal(repoRequired.ok ? null : repoRequired.refusal.reason, "invalid-request");

  const noPrior = await openRun(fakeTx(taskRow()).tx, "task-1", { kind: "retry", readyAt: now });
  assert.equal(noPrior.ok ? null : noPrior.refusal.reason, "conflict");

  const repo = { id: "repo-1", defaultBranch: "main" };
  const alreadyOpenedTask = taskRow({ repoId: repo.id, repo, runs: [priorRun()] });
  const duplicateFirst = await openRun(fakeTx(alreadyOpenedTask).tx, alreadyOpenedTask.id, { kind: "task-created", readyAt: now });
  assert.equal(duplicateFirst.ok ? null : duplicateFirst.refusal.reason, "conflict");

  const staleSourceTask = taskRow({ runs: [priorRun({ id: "newer-run" })] });
  const staleSource = await openRun(fakeTx(staleSourceTask).tx, staleSourceTask.id, {
    kind: "retry-after-completion",
    readyAt: now,
    sourceRunId: "run-3",
    sourceMaxRunsPerTask: 5,
    sourceBudgetGrants: 1,
    budgetGrant: 0,
  });
  assert.equal(staleSource.ok ? null : staleSource.refusal.reason, "conflict");

  const ordinaryPriorTask = taskRow({ repoId: "repo-1", repo: { id: "repo-1", defaultBranch: "main" }, runs: [priorRun()] });
  const notIntegrator = await openRun(fakeTx(ordinaryPriorTask).tx, ordinaryPriorTask.id, {
    kind: "integrator-authorized",
    readyAt: now,
  });
  assert.equal(notIntegrator.ok ? null : notIntegrator.refusal.reason, "invalid-request");

  const exhaustedTask = taskRow({ maxSessionsPerTask: 2, runs: [priorRun({ runNumber: 3, budgetGrants: 1 })] });
  const exhausted = await openRun(fakeTx(exhaustedTask).tx, exhaustedTask.id, { kind: "retry", readyAt: now });
  assert.deepEqual(exhausted, { ok: false, refusal: { reason: "conflict", message: "Run budget exhausted" } });
});

test("each OpenRunIntent creates through one seam with its named budget rule", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const cases: Array<{
    intent: OpenRunIntent;
    task: ReturnType<typeof taskRow>;
    expected: { runNumber: number; maxRunsPerTask: number; budgetGrants: number };
  }> = [
    {
      intent: { kind: "task-created", readyAt: now },
      task: taskRow({ repoId: repo.id, repo }),
      expected: { runNumber: 1, maxRunsPerTask: 5, budgetGrants: 0 },
    },
    {
      intent: { kind: "enqueue", readyAt: now },
      task: taskRow({ repoId: repo.id, repo, runs: [priorRun({ budgetGrants: 2 })] }),
      expected: { runNumber: 4, maxRunsPerTask: 7, budgetGrants: 2 },
    },
    {
      intent: { kind: "retry", readyAt: now },
      task: taskRow({ maxSessionsPerTask: 5, runs: [priorRun({ runNumber: 2, budgetGrants: 2 })] }),
      expected: { runNumber: 3, maxRunsPerTask: 7, budgetGrants: 2 },
    },
    {
      intent: { kind: "integrator-authorized", readyAt: now },
      task: taskRow({
        assigneeAgent: agent({ name: "merge-integrator" }),
        repoId: repo.id,
        repo,
        templateStepId: integratorStep.id,
        templateStep: integratorStep,
        maxSessionsPerTask: 3,
        // A historical absolute ceiling of 10 came from an old Task budget.
        // Authorization grants only the next Run against the current budget;
        // it must not carry that opaque old sum forward.
        runs: [priorRun({ runNumber: 3, maxRunsPerTask: 10, budgetGrants: 0 })],
      }),
      expected: { runNumber: 4, maxRunsPerTask: 4, budgetGrants: 1 },
    },
    {
      intent: {
        kind: "retry-after-completion",
        readyAt: now,
        sourceRunId: "run-3",
        sourceMaxRunsPerTask: 5,
        sourceBudgetGrants: 1,
        budgetGrant: 1,
      },
      task: taskRow({ runs: [priorRun()] }),
      expected: { runNumber: 4, maxRunsPerTask: 6, budgetGrants: 2 },
    },
    {
      intent: {
        kind: "retry-after-lease-loss",
        readyAt: now,
        sourceRunId: "run-3",
        sourceMaxRunsPerTask: 5,
        sourceBudgetGrants: 1,
      },
      task: taskRow({ runs: [priorRun()] }),
      expected: { runNumber: 4, maxRunsPerTask: 6, budgetGrants: 2 },
    },
  ];

  for (const item of cases) {
    const locked = item.task.assigneeAgent as ReturnType<typeof agent>;
    const { tx, creates, agentLocks } = fakeTx(item.task, { lockedAgent: locked });
    const opened = await openRun(tx, item.task.id, item.intent);
    assert.equal(opened.ok, true, item.intent.kind);
    assert.equal(agentLocks(), 1, `${item.intent.kind} must take the Agent-row mutex`);
    assert.equal(creates.length, 1, `${item.intent.kind} must create exactly once`);
    assert.deepEqual(
      {
        runNumber: creates[0]?.runNumber,
        maxRunsPerTask: creates[0]?.maxRunsPerTask,
        budgetGrants: creates[0]?.budgetGrants,
      },
      item.expected,
      item.intent.kind,
    );
  }
});

test("runBudgetCeiling is the only ceiling algorithm and clamps negative grants", () => {
  assert.equal(runBudgetCeiling(5, undefined), 5);
  assert.equal(runBudgetCeiling(5, null), 5);
  assert.equal(runBudgetCeiling(5, -2), 5);
  assert.equal(runBudgetCeiling(5, 3), 8);
});
