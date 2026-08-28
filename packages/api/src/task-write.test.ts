import assert from "node:assert/strict";
import test from "node:test";

import { AssigneeType, type Prisma, TaskStatus } from "@anneal/db";

import { writeTask } from "./task-write.js";

type TaskRow = {
  id: string;
  projectId: string;
  chainId: string | null;
  status: TaskStatus;
  archivedAt: Date | null;
  assigneeType: AssigneeType;
  assigneeAgentId: string | null;
  templateStep: null;
};

type AgentRow = { id: string; name: string; projectId: string; archivedAt: Date | null };

const task = (overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: "task-1",
  projectId: "project-1",
  chainId: null,
  status: TaskStatus.TODO,
  archivedAt: null,
  assigneeType: AssigneeType.AGENT,
  assigneeAgentId: null,
  templateStep: null,
  ...overrides,
});

/**
 * A transaction that records which rows were locked and in what order.
 *
 * The lock order is the whole point of the module, and it is invisible to the
 * HTTP tests: `app.test.ts` stubs `$queryRaw` to succeed unconditionally, so a
 * writer that took the Agent row before the Task row would pass there. Here the
 * `FOR UPDATE` statements are the observable.
 */
const recordingTx = (state: { task: TaskRow | null; agents?: AgentRow[]; siblings?: string[] }) => {
  const locks: string[] = [];
  const writes: Array<{ kind: string; data: unknown }> = [];
  const agents = state.agents ?? [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "Agent"')) {
        locks.push("agent-row");
        return agents.length > 0 ? [{ id: agents[0]!.id }] : [];
      }
      if (sql.includes('"chainId" = ')) {
        locks.push("chain-rows");
        return (state.siblings ?? [state.task?.id ?? ""]).map((id) => ({ id }));
      }
      locks.push("task-row");
      return state.task ? [{ id: state.task.id }] : [];
    },
    task: {
      findUnique: async () => state.task,
      findUniqueOrThrow: async () => {
        if (!state.task) throw new Error("task is absent");
        return state.task;
      },
      update: async ({ data }: { data: unknown }) => {
        writes.push({ kind: "task.update", data });
        return { ...state.task, ...(data as object) };
      },
    },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => (
        agents.find((agent) => agent.id === where.id) ?? null
      ),
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) => (
        agents.find((agent) => agent.id === where.id && agent.projectId === where.projectId) ?? null
      ),
    },
    taskActivity: {
      create: async ({ data }: { data: unknown }) => {
        writes.push({ kind: "taskActivity.create", data });
        return { id: "activity-1" };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, locks, writes };
};

const plainWrite = async () => ({
  update: { status: TaskStatus.BACKLOG },
  activity: { actorType: "control-plane", body: "parked" },
  value: "planned" as const,
});

test("a task that is gone is refused as absent, before anything is locked", async () => {
  const { tx, locks, writes } = recordingTx({ task: null });
  const result = await writeTask(tx, "task-1", plainWrite);
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? null : result.refusal, { kind: "absent" });
  assert.deepEqual(locks, []);
  assert.deepEqual(writes, []);
});

test("an unchained write locks the Task row, then the Agent row, and writes once", async () => {
  const { tx, locks, writes } = recordingTx({
    task: task({ assigneeAgentId: "agent-1" }),
    agents: [{ id: "agent-1", name: "engineer", projectId: "project-1", archivedAt: null }],
  });
  const result = await writeTask(tx, "task-1", async () => ({
    update: { status: TaskStatus.DOING, assigneeAgentId: "agent-1" },
    activity: { actorType: "operator", body: "Status changed: todo → doing" },
    value: 7,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(locks, ["task-row", "agent-row"]);
  assert.deepEqual(writes.map((write) => write.kind), ["task.update", "taskActivity.create"]);
  assert.equal(result.ok && result.value, 7);
  assert.equal(result.ok && result.activityId, "activity-1");
  assert.equal(result.ok && result.chainLocked, false);
});

test("a chained write takes the whole chain and reports that the transaction is chain-locked", async () => {
  const { tx, locks } = recordingTx({
    task: task({ chainId: "chain-1" }),
    siblings: ["task-0", "task-1", "task-2"],
  });
  const result = await writeTask(tx, "task-1", plainWrite);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.chainLocked, true);
  assert.deepEqual(locks, ["chain-rows"]);
});

test("an archived assignee is refused and nothing is written", async () => {
  const { tx, locks, writes } = recordingTx({
    task: task(),
    agents: [{ id: "agent-1", name: "engineer", projectId: "project-1", archivedAt: new Date() }],
  });
  const result = await writeTask(tx, "task-1", async () => ({
    update: { assigneeAgentId: "agent-1" },
    activity: { actorType: "operator", body: "reassigned" },
    value: null,
  }));
  assert.deepEqual(result.ok ? null : result.refusal, {
    kind: "assignment-blocked",
    reason: "Assignee engineer is archived",
  });
  assert.deepEqual(locks, ["task-row", "agent-row"]);
  assert.deepEqual(writes, []);
});

test("an assignee from another project is refused before the Agent row is locked", async () => {
  const { tx, locks, writes } = recordingTx({
    task: task(),
    agents: [{ id: "agent-1", name: "engineer", projectId: "project-2", archivedAt: null }],
  });
  const result = await writeTask(tx, "task-1", async () => ({
    update: { assigneeAgentId: "agent-1" },
    activity: null,
    value: null,
  }));
  assert.deepEqual(result.ok ? null : result.refusal, {
    kind: "assignment-blocked",
    reason: "Assignee does not belong to this project",
  });
  assert.deepEqual(locks, ["task-row"]);
  assert.deepEqual(writes, []);
});

test("a write that names no assignee never reaches the Agent row", async () => {
  const { tx, locks, writes } = recordingTx({ task: task() });
  const result = await writeTask(tx, "task-1", plainWrite);
  assert.equal(result.ok, true);
  assert.deepEqual(locks, ["task-row"]);
  assert.deepEqual(writes.map((write) => write.kind), ["task.update", "taskActivity.create"]);
});

test("a caller that decides under the lock not to write still gets its value back", async () => {
  const { tx, locks, writes } = recordingTx({ task: task() });
  const result = await writeTask(tx, "task-1", async () => ({
    update: null,
    activity: null,
    value: { refused: "already decided" },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, { refused: "already decided" });
  assert.equal(result.ok && result.written, null);
  assert.equal(result.ok && result.activityId, null);
  assert.deepEqual(locks, ["task-row"]);
  assert.deepEqual(writes, []);
});
