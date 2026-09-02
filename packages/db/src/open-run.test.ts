import assert from "node:assert/strict";
import test from "node:test";

import {
  AssigneeType,
  ChainControlState,
  CodexServiceTier,
  RunnerKind,
  RunnerPreference,
} from "@prisma/client";

import {
  type OpenRunIntent,
  type OpenRunDisposition,
  type OpenRunRefusal,
  enqueueTaskRun,
  openRun,
  pinnedImplementationRange,
  runBudgetCeiling,
} from "./run-open.js";

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
  pushedBranch: null,
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
  { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1 },
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
    chainControlRows?: Array<Record<string, unknown>>;
    lockedAgent?: ReturnType<typeof agent> | null;
    publishedRuns?: Array<{ taskId: string; repoId: string; pushedBranch: string | null }>;
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
    chainControl: {
      findMany: async () => options.chainControlRows ?? [],
    },
    taskTemplateStep: { findUnique: async () => null },
    run: {
      findFirst: async ({ where }: { where: Record<string, any> }) => {
        const rows = options.publishedRuns ?? [];
        return rows.find((row) => (
          (typeof where.taskId !== "string" || row.taskId === where.taskId)
          && (typeof where.repoId !== "string" || row.repoId === where.repoId)
          && (typeof where.pushedBranch !== "string" || row.pushedBranch === where.pushedBranch)
          && (typeof where.task?.id !== "string" || row.taskId === where.task.id)
        )) ?? null;
      },
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

const outputOnlyStep = {
  id: "regression-step",
  stepIndex: 6,
  outputKind: "regression-verification-v2",
  requiresCommit: false,
  baseFromStepIndex: null,
  taskTemplate: { name: "direct-engineer-workflow" },
};

test("Run birth derives a manual commit policy from delivery shape and snapshots a template Step", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const fixtures = [
    {
      name: "manual pull-request Task",
      task: taskRow({ repoId: repo.id, repo }),
      expected: true,
    },
    {
      name: "manual branch-only Task",
      task: taskRow({ repoId: repo.id, repo, opensPullRequest: false }),
      expected: false,
    },
    {
      name: "output-only template Step",
      task: taskRow({
        repoId: repo.id,
        repo,
        templateId: "template-1",
        templateStepId: outputOnlyStep.id,
        templateStep: outputOnlyStep,
      }),
      expected: false,
    },
  ] as const;

  for (const fixture of fixtures) {
    const { tx, creates } = fakeTx(fixture.task);
    const opened = await openRun(tx, fixture.task.id, { kind: "task-created", readyAt: now });
    assert.equal(opened.ok, true, fixture.name);
    assert.equal(creates[0]?.requiresCommit, fixture.expected, fixture.name);
  }
});

test("a retry snapshots the current Step commit contract instead of inheriting its prior Run", async () => {
  const task = taskRow({
    templateId: "template-1",
    templateStepId: outputOnlyStep.id,
    templateStep: outputOnlyStep,
    runs: [priorRun({ requiresCommit: true })],
  });
  const { tx, creates } = fakeTx(task);

  const opened = await openRun(tx, task.id, { kind: "retry", readyAt: now });

  assert.equal(opened.ok, true);
  assert.equal(creates[0]?.requiresCommit, false);
});

test("a Run based on its own Task's prior publication does not require another commit", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const salvage = "agentos/task-1/run-1";
  const publishedRuns = [{ taskId: "task-1", repoId: repo.id, pushedBranch: salvage }];
  const task = taskRow({
    repoId: repo.id,
    repo,
    runs: [priorRun({ repoId: repo.id, branch: salvage, pushedBranch: salvage })],
  });
  const { tx, creates } = fakeTx(task, { publishedRuns });

  const opened = await openRun(tx, task.id, { kind: "retry", readyAt: now });

  assert.equal(opened.ok, true);
  assert.equal(creates[0]?.targetBranch, salvage);
  assert.equal(creates[0]?.requiresCommit, false);
});

test("ordinary and other-Task bases keep the configured commit contract", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const otherTaskBranch = "agentos/task-2/run-1";
  const fixtures = [
    { name: "target branch", targetBranch: repo.defaultBranch, publishedRuns: [] },
    {
      name: "another Task's publication",
      targetBranch: otherTaskBranch,
      publishedRuns: [{ taskId: "task-2", repoId: repo.id, pushedBranch: otherTaskBranch }],
    },
  ];

  for (const fixture of fixtures) {
    const task = taskRow({ repoId: repo.id, repo, targetBranch: fixture.targetBranch });
    const { tx, creates } = fakeTx(task, { publishedRuns: fixture.publishedRuns });
    const opened = await openRun(tx, task.id, { kind: "task-created", readyAt: now });
    assert.equal(opened.ok, true, fixture.name);
    assert.equal(creates[0]?.targetBranch, fixture.targetBranch, fixture.name);
    assert.equal(creates[0]?.requiresCommit, true, fixture.name);
  }
});

test("a null resolved base cannot match an unpublished prior Run", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const prior = priorRun({ repoId: repo.id, branch: null, targetBranch: null });
  const task = taskRow({
    repoId: repo.id,
    repo,
    targetBranch: null,
    runs: [prior],
  });
  const { tx, creates } = fakeTx(task, {
    publishedRuns: [{ taskId: task.id, repoId: repo.id, pushedBranch: null }],
  });

  const opened = await openRun(tx, task.id, {
    kind: "retry-after-completion",
    readyAt: now,
    sourceRunId: prior.id,
    sourceMaxRunsPerTask: prior.maxRunsPerTask,
    sourceBudgetGrants: prior.budgetGrants,
    budgetGrant: 1,
  });

  assert.equal(opened.ok, true);
  assert.equal(creates[0]?.targetBranch, null);
  assert.equal(creates[0]?.requiresCommit, true);
});

test("a pinned base follows the template Step when conditional tasks use dense chain ordinals", async () => {
  const headSha = "2".repeat(40);
  let where: unknown;
  const range = await pinnedImplementationRange({
    taskStepOutput: {
      findFirst: async (query: { where: unknown }) => {
        where = query.where;
        return {
          kind: "implementation",
          commitSha: headSha,
          body: JSON.stringify({
            schemaVersion: 1,
            baseSha: "1".repeat(40),
            headSha,
          }),
        };
      },
    },
  } as never, {
    id: "review-task",
    projectId: "project-1",
    templateId: "direct-template",
    chainId: "direct-chain",
    templateStep: { baseFromStepIndex: 2 },
  });

  assert.deepEqual(range, {
    implementationBaseSha: "1".repeat(40),
    implementationHeadSha: headSha,
  });
  assert.deepEqual(where, {
    task: {
      projectId: "project-1",
      templateId: "direct-template",
      chainId: "direct-chain",
      templateStep: { stepIndex: 2 },
    },
  });
});

test("every OpenRunIntent applies shared Run-birth invariants unless its branch names the exception", async () => {
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
      if (intent.kind === "integrator-authorized" && invariant.name === "integrator stop state") continue;
      const { tx, creates } = fakeTx(invariant.task, invariant.options);
      const opened = await openRun(tx, invariant.task.id, intent);
      assert.equal(opened.ok, false, `${intent.kind} must refuse ${invariant.name}`);
      if (!opened.ok) assert.equal(opened.refusal.reason, invariant.reason, `${intent.kind}: ${invariant.name}`);
      assert.equal(creates.length, 0, `${intent.kind} must not create after ${invariant.name}`);
    }
  }
});

test("integrator-authorized is the named human reauthorization exit from an unresolved stop", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const integrator = agent({ name: "merge-integrator" });
  const task = taskRow({
    assigneeAgent: integrator,
    repoId: repo.id,
    repo,
    templateStepId: integratorStep.id,
    templateStep: integratorStep,
    maxSessionsPerTask: 3,
    runs: [priorRun({ runNumber: 3, maxRunsPerTask: 3, budgetGrants: 0 })],
  });
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
  const { tx, creates } = fakeTx(task, { lockedAgent: integrator, stopRows });
  const opened = await openRun(tx, task.id, { kind: "integrator-authorized", readyAt: now });
  assert.equal(opened.ok, true);
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.runNumber, 4);
  assert.equal(creates[0]?.maxRunsPerTask, 4);
});

test("every OpenRunRefusal code comes from a real guard, carries a disposition, and creates no Run", async () => {
  type RefusalFixtures = {
    [Code in OpenRunRefusal["code"]]: {
      task: ReturnType<typeof taskRow> | null;
      intent: OpenRunIntent;
      options?: Parameters<typeof fakeTx>[1];
      reason: Extract<OpenRunRefusal, { code: Code }>["reason"];
      disposition: OpenRunDisposition;
      message: string;
      detail?: OpenRunRefusal["detail"];
      context?: OpenRunRefusal["context"];
    };
  };

  const repo = { id: "repo-1", defaultBranch: "main" };
  const integrator = agent({ name: "merge-integrator" });
  const cases: RefusalFixtures = {
    "task-not-found": {
      task: null,
      intent: { kind: "enqueue", readyAt: now },
      reason: "not-found",
      disposition: "fault",
      message: "Task not found",
    },
    "task-assignee-type-invalid": {
      task: taskRow({ assigneeType: AssigneeType.HUMAN, assigneeAgent: null, assigneeAgentId: null }),
      intent: { kind: "retry", readyAt: now },
      reason: "invalid-request",
      disposition: "fault",
      message: "Task task-1 cannot open a Run without an Agent assignee",
    },
    "task-assignee-missing": {
      task: taskRow({ assigneeAgent: null }),
      intent: { kind: "retry", readyAt: now },
      reason: "conflict",
      disposition: "fault",
      message: "Task assignee no longer exists; assign an agent before retrying",
    },
    "repo-required": {
      task: taskRow(),
      intent: { kind: "enqueue", readyAt: now },
      reason: "invalid-request",
      disposition: "fault",
      message: "Task task-1 cannot open a enqueue Run without a Repo",
    },
    "task-archived": {
      task: taskRow({ archivedAt: now, repoId: repo.id, repo }),
      intent: { kind: "enqueue", readyAt: now },
      reason: "archived-task",
      disposition: "fault",
      message: "Task Implement seam is archived; unarchive it before queueing a run",
      context: { taskId: "task-1", taskName: "Implement seam" },
    },
    "integrator-stopped": {
      task: taskRow({
        assigneeAgent: integrator,
        repoId: repo.id,
        repo,
        templateStepId: integratorStep.id,
        templateStep: integratorStep,
      }),
      intent: { kind: "enqueue", readyAt: now },
      options: {
        lockedAgent: integrator,
        stopRows: [{
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
        }],
      },
      reason: "integrator-stopped",
      disposition: "stopped",
      message: "Merge integrator stopped on head-drift; answer the stop question before starting another run",
      context: { taskId: "task-1", condition: "head-drift" },
    },
    "assignee-archived": {
      task: taskRow({ repoId: repo.id, repo }),
      intent: { kind: "enqueue", readyAt: now },
      options: { lockedAgent: agent({ archivedAt: now }) },
      reason: "archived-assignee",
      disposition: "fault",
      message: "Task Implement seam assignee senior-dev is archived; unarchive the agent to queue this step",
      context: { taskId: "task-1", taskName: "Implement seam", agentName: "senior-dev" },
    },
    "compound-implementation-assignee": {
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
      intent: { kind: "enqueue", readyAt: now },
      reason: "compound-implementation-assignee",
      disposition: "fault",
      message: "Compound implementation step must remain assigned to the active in-project Agent implementation-plan-executioner",
      detail: { code: "COMPOUND_IMPLEMENTATION_ASSIGNEE_INVALID" },
    },
    "integrator-binding-invalid": {
      task: taskRow({ assigneeAgent: integrator, repoId: repo.id, repo }),
      intent: { kind: "enqueue", readyAt: now },
      options: { lockedAgent: integrator },
      reason: "invalid-request",
      disposition: "fault",
      message: "Agent merge-integrator may bind only a merge-execution step",
      context: { code: "INTEGRATOR_BINDING_INVALID" },
    },
    "initial-run-already-exists": {
      task: taskRow({ repoId: repo.id, repo, runs: [priorRun()] }),
      intent: { kind: "task-created", readyAt: now },
      reason: "conflict",
      disposition: "fault",
      message: "Task Implement seam already has a Run",
    },
    "prior-run-required": {
      task: taskRow(),
      intent: { kind: "retry", readyAt: now },
      reason: "conflict",
      disposition: "fault",
      message: "Task Implement seam has no Run to continue",
    },
    "source-run-stale": {
      task: taskRow({ runs: [priorRun({ id: "newer-run" })] }),
      intent: {
        kind: "retry-after-completion",
        readyAt: now,
        sourceRunId: "run-3",
        sourceMaxRunsPerTask: 5,
        sourceBudgetGrants: 1,
        budgetGrant: 0,
      },
      reason: "conflict",
      disposition: "fault",
      message: "Run run-3 is no longer the latest Run for task Implement seam",
    },
    "task-not-integrator": {
      task: taskRow({ repoId: repo.id, repo, runs: [priorRun()] }),
      intent: { kind: "integrator-authorized", readyAt: now },
      reason: "invalid-request",
      disposition: "fault",
      message: "Task Implement seam is not an integrator Step",
    },
    "run-budget-exhausted": {
      task: taskRow({ maxSessionsPerTask: 2, runs: [priorRun({ runNumber: 3, budgetGrants: 1 })] }),
      intent: { kind: "retry", readyAt: now },
      reason: "conflict",
      disposition: "fault",
      message: "Run budget exhausted",
    },
    "chain-held": {
      task: taskRow({
        repoId: repo.id,
        repo,
        chainId: "chain-1",
        chainIndex: 2,
        chainLayer: 2,
      }),
      intent: { kind: "enqueue", readyAt: now },
      options: {
        chainControlRows: [{
          projectId: "project-1",
          chainId: "chain-1",
          state: ChainControlState.HELD,
          heldLayer: 1,
          heldAt: now,
          holdRequestId: "hold-1",
          holdReason: "operator hold",
          releasedAt: null,
          releaseRequestId: null,
          holdGeneration: 1,
        }],
      },
      reason: "chain-held",
      disposition: "held",
      message: "Chain chain-1 is held after layer 1; Task task-1 at layer 2 cannot queue a Run",
      detail: { chainId: "chain-1", taskLayer: 2, heldLayer: 1 },
      context: { taskId: "task-1", chainId: "chain-1", taskLayer: 2, heldLayer: 1 },
    },
  };

  for (const code of Object.keys(cases) as Array<OpenRunRefusal["code"]>) {
    const fixture = cases[code];
    const { tx, creates } = fakeTx(fixture.task, fixture.options);
    const opened = await openRun(tx, fixture.task?.id ?? "missing", fixture.intent);
    assert.equal(opened.ok, false, code);
    assert.deepEqual({ ok: opened.ok, code: opened.refusal.code }, { ok: false, code });
    assert.equal(opened.refusal.reason, fixture.reason, code);
    assert.equal(opened.refusal.disposition, fixture.disposition, `${code} disposition`);
    assert.equal(opened.refusal.message, fixture.message, code);
    assert.deepEqual(opened.refusal.detail, fixture.detail, `${code} detail`);
    assert.deepEqual(opened.refusal.context, fixture.context, `${code} context`);
    assert.equal(creates.length, 0, `${code} must not write a Run`);
  }
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
      intent: { kind: "merge-tail-requeue", readyAt: now, budgetGrant: 1 },
      task: taskRow({
        repoId: repo.id,
        repo,
        runs: [priorRun({ runNumber: 5, maxRunsPerTask: 5, budgetGrants: 0 })],
      }),
      expected: { runNumber: 6, maxRunsPerTask: 6, budgetGrants: 1 },
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

test("enqueueTaskRun's merge-tail option grants one attempt and ordinary enqueue does not", async () => {
  const repo = { id: "repo-1", defaultBranch: "main" };
  const task = taskRow({
    repoId: repo.id,
    repo,
    runs: [priorRun({ runNumber: 5, maxRunsPerTask: 5, budgetGrants: 0 })],
  });

  const ordinary = fakeTx(task);
  const ordinaryRun = await enqueueTaskRun(ordinary.tx, task.id, now);
  assert.equal(ordinaryRun.maxRunsPerTask, 5);
  assert.equal(ordinaryRun.budgetGrants, 0);

  const mergeTail = fakeTx(task);
  const mergeTailRun = await enqueueTaskRun(mergeTail.tx, task.id, now, { budgetGrant: 1 });
  assert.equal(mergeTailRun.maxRunsPerTask, 6);
  assert.equal(mergeTailRun.budgetGrants, 1);
});

test("runBudgetCeiling is the only ceiling algorithm and clamps negative grants", () => {
  assert.equal(runBudgetCeiling(5, undefined), 5);
  assert.equal(runBudgetCeiling(5, null), 5);
  assert.equal(runBudgetCeiling(5, -2), 5);
  assert.equal(runBudgetCeiling(5, 3), 8);
});
