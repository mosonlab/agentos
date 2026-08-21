import assert from "node:assert/strict";
import test from "node:test";

import {
  AssigneeType,
  CANONICAL_AGENT_DEFAULTS,
  executionModeFor,
  INTEGRATOR_AGENT_NAME,
  INTEGRATOR_SENTINEL_MODEL,
  INTEGRATOR_TEMPLATE_NAME,
  Prisma,
  RunnerKind,
  RunnerPreference,
  loadTemplateStepSources,
  type PrismaClient,
} from "@agentos/db";

import { instantiateTemplate } from "./templates.js";

test("instantiating the canonical feature template creates twelve tasks including the mechanical integrator", async () => {
  const canonicalTemplateSteps = await loadTemplateStepSources(INTEGRATOR_TEMPLATE_NAME);
  const created: Array<Record<string, any>> = [];
  const runs: Array<Record<string, any>> = [];
  const agents = new Map<string, {
    id: string;
    name: string;
    model: string;
    runnerPreference: RunnerPreference;
    foundationalPrompt: string;
    rolePrompt: string;
  }>(CANONICAL_AGENT_DEFAULTS.map((contract, index) => [contract.name, {
    id: `agent-${index + 1}`,
    name: contract.name,
    model: contract.model,
    runnerPreference: contract.runner,
    foundationalPrompt: "foundation",
    rolePrompt: "role",
  }]));
  const steps = canonicalTemplateSteps.map((contract) => {
    const agent = contract.agentName ? agents.get(contract.agentName)! : null;
    return {
      id: `step-${contract.stepIndex}`,
      stepIndex: contract.stepIndex,
      name: `Step ${contract.stepIndex}`,
      prompt: `Work on {{branchName}} step ${contract.stepIndex}`,
      outputKind: contract.outputKind,
      attachmentsFromPrevious: contract.attachmentsFromPrevious,
      assigneeType: agent ? AssigneeType.AGENT : AssigneeType.HUMAN,
      assigneeAgentId: agent?.id ?? null,
      assigneeAgent: agent,
      approvalGate: contract.approvalGate,
      opensPullRequest: contract.opensPullRequest,
      baseFromStepIndex: contract.baseFromStepIndex,
      runner: null,
      taskTemplate: { name: "compound-engineer-workflow" },
    };
  });
  const tx = {
    // The Agent-row mutex and each exact Repo-grant mutex are acquired before
    // the first task write. Returning both row shapes lets the shared lock
    // helpers exercise their normal paths.
    $queryRaw: async () => [...agents.values()].map((agent) => ({
      id: agent.id, archivedAt: null, agentId: agent.id, repoId: "repo-1",
    })),
    task: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const task = {
          id: `task-${created.length + 1}`,
          ...data,
          followUpTaskId: null,
          assigneeAgent: data.assigneeAgentId
            ? [...agents.values()].find((agent) => agent.id === data.assigneeAgentId)
            : null,
          repo: { id: "repo-1", defaultBranch: "main" },
          templateStep: steps[created.length],
          runs: [],
        };
        created.push(task);
        return task;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const task = created.find((item) => item.id === where.id)!;
        Object.assign(task, data);
        return task;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => created.find((item) => item.id === where.id),
      findUnique: async ({ where }: { where: { id: string } }) => created.find((item) => item.id === where.id) ?? null,
      findFirst: async () => created.find((item) => item.targetBranch !== "main") ?? null,
    },
    run: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, any> }) => { const run = { id: "run-1", ...data }; runs.push(run); return run; },
      update: async ({ data }: { data: Record<string, any> }) => { Object.assign(runs[0]!, data); return runs[0]; },
    },
    taskActivity: { createMany: async () => ({ count: 12 }) },
    taskTemplateStep: {
      findUnique: async ({ where }: { where: { id: string } }) => steps.find((step) => step.id === where.id) ?? null,
    },
    agentRepoAccess: { count: async () => 1 },
  };
  const db = {
    taskTemplate: { findFirst: async () => ({ id: "template-1", name: "compound-engineer-workflow", variables: ["branchName"], steps }) },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: "granted-agent" }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const result = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: { branchName: "feature/twelve-steps" }, autoStart: true, description: "Build it",
  });
  assert.equal(result.tasks.length, 12);
  assert.equal(new Set(created.map((task) => task.chainId)).size, 1);
  assert.equal(created[0]!.followUpTaskId, "task-2");
  assert.equal(created[10]!.assigneeType, AssigneeType.AGENT);
  assert.equal(created[10]!.approvalGate, false);
  assert.equal(created[10]!.templateStep.outputKind, "merge-authorization");
  assert.equal(created[11]!.assigneeAgent?.name, INTEGRATOR_AGENT_NAME);
  assert.equal(created[11]!.assigneeAgent?.model, INTEGRATOR_SENTINEL_MODEL);
  assert.equal(created[11]!.assigneeAgent?.runnerPreference, RunnerPreference.INHERIT);
  assert.equal(created[11]!.opensPullRequest, false);
  assert.equal(executionModeFor(created[11]!.templateStep), "mechanical");
  assert.deepEqual(created.map((task) => task.outputKind ?? task.templateStep.outputKind), canonicalTemplateSteps.map((step) => step.outputKind));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runner, RunnerKind.CLAUDE);
  assert.equal(runs[0]!.branch, "feature/twelve-steps");
  assert.equal(runs.some((run) => run.taskId === created[11]!.id), false, "step 12 waits for server-side readiness and never queues at instantiation");
  assert.doesNotMatch(
    created[6]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "blind-review step 7 materializes without an upstream-read instruction",
  );
  assert.match(
    created[8]!.description,
    /Read the prior template steps' persisted outputs before working/u,
    "regression-verification step 9 still consumes prior outputs",
  );

  const inert = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: { branchName: "feature/inert-chain" }, description: "Build it later",
  });
  assert.equal(inert.tasks.length, 12);
  assert.equal(runs.length, 1, "omitting autoStart defaults to an inert chain with no queued run");
});

test("the lower-level materializer rejects blank variables and invalid branches before a transaction", async () => {
  const db = {
    taskTemplate: { findFirst: async () => ({
      id: "template-1",
      name: "Template",
      variables: ["branchName"],
      steps: [{
        id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
        outputKind: "result", attachmentsFromPrevious: false, assigneeType: AssigneeType.AGENT,
        assigneeAgentId: "agent-1", assigneeAgent: { id: "agent-1", name: "Agent", archivedAt: null },
        approvalGate: false, opensPullRequest: true, runner: null,
      }],
    }) },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    $transaction: async () => { throw new Error("transaction must not start"); },
  } as unknown as PrismaClient;
  for (const branchName of ["", "   ", "bad..branch", "refs/heads/main", "feature/.hidden", "feature/main.lock", "bad\nbranch"]) {
    await assert.rejects(
      () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: { branchName }, autoStart: false }),
      /Missing template variables|Invalid template branch name/,
      branchName,
    );
  }
});

test("the lower-level materializer rejects self and forward baseFromStepIndex references", async () => {
  const step = (stepIndex: number, baseFromStepIndex: number | null) => ({
    id: `step-${stepIndex}`,
    stepIndex,
    baseFromStepIndex,
    name: `Step ${stepIndex}`,
    prompt: "work",
    outputKind: "result",
    attachmentsFromPrevious: false,
    assigneeType: AssigneeType.AGENT,
    assigneeAgentId: "agent-1",
    assigneeAgent: { id: "agent-1", name: "Agent", archivedAt: null },
    approvalGate: false,
    opensPullRequest: true,
    runner: null,
  });
  for (const steps of [
    [step(1, 1)],
    [step(1, 2), step(2, null)],
  ]) {
    const db = {
      taskTemplate: { findFirst: async () => ({ id: "template-1", name: "Template", variables: [], steps }) },
      repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
      $transaction: async () => { throw new Error("transaction must not start"); },
    } as unknown as PrismaClient;
    await assert.rejects(
      () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {} }),
      /baseFromStepIndex must reference a strictly earlier stepIndex/u,
    );
  }
});

test("an agent archived after the step check still loses to the locked re-read", async () => {
  // The pre-transaction validation sees a live agent; the archive commits; the
  // locked re-read is what decides. Without it the whole chain — and its first
  // run — would be written for an agent no runner ever claims for.
  const agent = {
    id: "agent-1", name: "Racing Agent", archivedAt: null, model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  let taskCreates = 0;
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: agent.id }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
      $queryRaw: async () => [{ id: agent.id, archivedAt: new Date() }],
      task: { create: async () => { taskCreates += 1; return { id: "task-1" }; } },
      run: { create: async () => { throw new Error("must not create run"); } },
      taskActivity: { createMany: async () => ({ count: 0 }) },
    }),
  } as unknown as PrismaClient;
  await assert.rejects(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, autoStart: false }),
    /Template step Implementation agent Racing Agent is archived/,
  );
  assert.equal(taskCreates, 0, "no chain row is written once the lock says archived");
});

test("a serializable conflict raised by the raw Agent lock is retried, not surfaced", async () => {
  // The lock is a raw statement, so Postgres reports the conflict as P2010 with
  // the SQLSTATE in meta. Treating that as fatal turned an archive race into a
  // 500 instead of the named archive rejection the caller can act on.
  const agent = {
    id: "agent-1", name: "Racing Agent", archivedAt: null, model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  let attempts = 0;
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: agent.id }) },
    $transaction: async (operation: (client: unknown) => Promise<unknown>) => operation({
      $queryRaw: async () => {
        attempts += 1;
        // First attempt: the archive holds the row and commits under us.
        if (attempts === 1) {
          throw new Prisma.PrismaClientKnownRequestError("Raw query failed", {
            code: "P2010",
            clientVersion: "test",
            meta: { code: "40001", message: "could not serialize access due to concurrent update" },
          });
        }
        return [{ id: agent.id, archivedAt: new Date() }];
      },
      task: { create: async () => { throw new Error("must not create task"); } },
      run: { create: async () => { throw new Error("must not create run"); } },
      taskActivity: { createMany: async () => ({ count: 0 }) },
    }),
  } as unknown as PrismaClient;
  await assert.rejects(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, autoStart: false }),
    /Template step Implementation agent Racing Agent is archived/,
  );
  assert.equal(attempts, 2, "the conflicting attempt is retried once and then decides on the re-read");
});

test("template instantiation rejects an archived step agent and names the step", async () => {
  const agent = {
    id: "agent-1", name: "Archived Agent", archivedAt: new Date(), model: "codex",
    runnerPreference: RunnerPreference.CODEX, foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const db = {
    taskTemplate: {
      findFirst: async () => ({
        id: "template-1",
        variables: [],
        steps: [{
          id: "step-1", stepIndex: 1, name: "Implementation", prompt: "work",
          outputKind: "result", attachmentsFromPrevious: false, assigneeType: AssigneeType.AGENT,
          assigneeAgentId: agent.id, assigneeAgent: agent, approvalGate: false, runner: null,
        }],
      }),
    },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
  } as unknown as PrismaClient;
  await assert.rejects(
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {}, autoStart: false }),
    /Template step Implementation agent Archived Agent is archived/,
  );
});
