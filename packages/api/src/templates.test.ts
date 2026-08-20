import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, Prisma, RunnerKind, RunnerPreference, type PrismaClient } from "@agentos/db";

import { instantiateTemplate } from "./templates.js";

test("instantiating the feature template creates a nine-task chain and queues only step one", async () => {
  const created: Array<Record<string, any>> = [];
  const runs: Array<Record<string, any>> = [];
  const agent = {
    id: "agent-1", name: "worker", model: "codex", runnerPreference: RunnerPreference.CODEX,
    foundationalPrompt: "foundation", rolePrompt: "role",
  };
  const steps = Array.from({ length: 9 }, (_, offset) => ({
    id: `step-${offset + 1}`,
    stepIndex: offset + 1,
    name: `Step ${offset + 1}`,
    prompt: `Work on {{branchName}} step ${offset + 1}`,
    outputKind: offset === 0 ? "spec" : "result",
    attachmentsFromPrevious: offset > 0,
    assigneeType: offset === 8 ? AssigneeType.HUMAN : AssigneeType.AGENT,
    assigneeAgentId: offset === 8 ? null : agent.id,
    assigneeAgent: offset === 8 ? null : agent,
    approvalGate: [0, 3, 8].includes(offset),
    runner: offset < 2 ? RunnerKind.CLAUDE : RunnerKind.CODEX,
  }));
  const tx = {
    // The Agent-row mutex instantiation takes before it writes the chain.
    $queryRaw: async () => [{ id: agent.id, archivedAt: null }],
    task: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const task = { id: `task-${created.length + 1}`, ...data, followUpTaskId: null, assigneeAgent: data.assigneeAgentId ? agent : null, repo: { id: "repo-1", defaultBranch: "main" }, templateStep: steps[created.length], runs: [] };
        created.push(task);
        return task;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const task = created.find((item) => item.id === where.id)!;
        Object.assign(task, data);
        return task;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => created.find((item) => item.id === where.id),
      // `enqueueTaskRun` asks whether the task it is about to queue is a chain's
      // step-10 task sitting in a recorded stop (§D-P7). A nine-step chain's
      // steps have no integrator step, so the answer is no — but it is asked.
      findUnique: async ({ where }: { where: { id: string } }) => created.find((item) => item.id === where.id) ?? null,
    },
    run: {
      create: async ({ data }: { data: Record<string, any> }) => { const run = { id: "run-1", ...data }; runs.push(run); return run; },
      update: async ({ data }: { data: Record<string, any> }) => { Object.assign(runs[0]!, data); return runs[0]; },
    },
    taskActivity: { createMany: async () => ({ count: 9 }) },
    // §D-P4 resolves the queued task's step to check the (agent, step) binding.
    // None of these nine is an integrator step, so every answer is "valid".
    taskTemplateStep: {
      findUnique: async ({ where }: { where: { id: string } }) => steps.find((step) => step.id === where.id) ?? null,
    },
  };
  const db = {
    taskTemplate: { findFirst: async () => ({ id: "template-1", variables: ["branchName"], steps }) },
    repo: { findFirst: async () => ({ id: "repo-1", name: "Repo", defaultBranch: "main" }) },
    agentRepoAccess: { findFirst: async () => ({ agentId: agent.id }) },
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const result = await instantiateTemplate(db, "project-1", "template-1", {
    repoId: "repo-1", variables: { branchName: "feature/nine-steps" }, description: "Build it",
  });
  assert.equal(result.tasks.length, 9);
  assert.equal(new Set(created.map((task) => task.chainId)).size, 1);
  assert.equal(created[0]!.followUpTaskId, "task-2");
  assert.equal(created[8]!.assigneeType, AssigneeType.HUMAN);
  assert.deepEqual(created.map((task) => task.approvalGate), [true, false, false, true, false, false, false, false, true]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runner, RunnerKind.CLAUDE);
  assert.equal(runs[0]!.branch, "feature/nine-steps");
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
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {} }),
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
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {} }),
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
    () => instantiateTemplate(db, "project-1", "template-1", { repoId: "repo-1", variables: {} }),
    /Template step Implementation agent Archived Agent is archived/,
  );
});
