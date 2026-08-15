import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, RunnerKind, RunnerPreference, type PrismaClient } from "@agentos/db";

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
    approvalGate: [0, 1, 8].includes(offset),
    runner: offset < 2 ? RunnerKind.CLAUDE : RunnerKind.CODEX,
  }));
  const tx = {
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
    },
    run: {
      create: async ({ data }: { data: Record<string, any> }) => { const run = { id: "run-1", ...data }; runs.push(run); return run; },
      update: async ({ data }: { data: Record<string, any> }) => { Object.assign(runs[0]!, data); return runs[0]; },
    },
    taskActivity: { createMany: async () => ({ count: 9 }) },
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
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.runner, RunnerKind.CLAUDE);
  assert.equal(runs[0]!.branch, "feature/nine-steps");
});

