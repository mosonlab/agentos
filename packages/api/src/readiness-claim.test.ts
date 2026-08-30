import assert from "node:assert/strict";
import test from "node:test";

import {
  RunStatus,
  TaskStatus,
  type Prisma,
  type PrismaClient,
} from "@anneal/db";

import {
  claimReadinessStep,
  READINESS_CLAIM_LEASE_MS,
} from "./readiness-claim.js";

type TaskRow = {
  id: string;
  projectId: string;
  chainId: string | null;
  chainIndex: number | null;
  status: TaskStatus;
  failureReason: string | null;
  readinessClaimToken: string | null;
  readinessClaimExpiresAt: Date | null;
};

type TaskWhere = Partial<TaskRow> & { id: string };
type TaskWrite = Partial<Pick<
  TaskRow,
  "status" | "failureReason" | "readinessClaimToken" | "readinessClaimExpiresAt"
>>;

const same = (left: unknown, right: unknown): boolean => (
  left instanceof Date && right instanceof Date
    ? left.getTime() === right.getTime()
    : left === right
);

const fakeDatabase = (overrides: Partial<TaskRow> = {}) => {
  const task: TaskRow = {
    id: "readiness-1",
    projectId: "project-1",
    chainId: null,
    chainIndex: 2,
    status: TaskStatus.TODO,
    failureReason: "prior human-readable failure",
    readinessClaimToken: null,
    readinessClaimExpiresAt: null,
    ...overrides,
  };
  const events: string[] = [];
  let successor: { id: string; taskId: string; status: RunStatus } | null = null;

  const matches = (where: TaskWhere): boolean => Object.entries(where)
    .every(([field, value]) => same(task[field as keyof TaskRow], value));
  const write = (data: TaskWrite): TaskRow => {
    if (data.readinessClaimToken === null && task.readinessClaimToken !== null) events.push("claim-cleared");
    Object.assign(task, data);
    return { ...task };
  };
  const tx = {
    $queryRaw: async (..._input: unknown[]) => [{ id: task.id }],
    task: {
      findUnique: async (_input: unknown) => ({ ...task }),
      findUniqueOrThrow: async (_input: unknown) => ({ ...task }),
      updateMany: async (input: { where: TaskWhere; data: TaskWrite }) => {
        if (!matches(input.where)) return { count: 0 };
        write(input.data);
        return { count: 1 };
      },
      update: async (input: { where: { id: string }; data: TaskWrite }) => {
        assert.equal(input.where.id, task.id);
        return write(input.data);
      },
    },
    run: {
      findFirst: async (_input: unknown) => successor ? { id: successor.id } : null,
      findUnique: async (input: { where: { id: string } }) => (
        successor?.id === input.where.id ? { taskId: successor.taskId } : null
      ),
    },
    taskActivity: {
      create: async (input: { data: { body: string } }) => {
        if (input.data.body.includes("handed to queued Run")) events.push("handoff-recorded");
        return { id: "activity-1" };
      },
    },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  const db = {
    ...tx,
    $transaction: async <T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> => (
      operation(client)
    ),
  } as unknown as PrismaClient;

  return {
    db,
    client,
    task,
    events,
    setSuccessor(run: { id: string; taskId: string; status: RunStatus } | null) {
      successor = run;
    },
  };
};

const NOW = new Date("2026-08-29T12:00:00.000Z");

test("a Handle acquires, renews, and settles the readiness Step claim", async () => {
  const fake = fakeDatabase();
  const handle = await claimReadinessStep(fake.db, fake.task.id, NOW);
  assert.ok(handle);
  assert.equal(fake.task.status, TaskStatus.DOING);
  assert.equal(fake.task.failureReason, null);
  assert.notEqual(fake.task.readinessClaimToken, null);
  assert.equal(
    fake.task.readinessClaimExpiresAt?.getTime(),
    NOW.getTime() + READINESS_CLAIM_LEASE_MS,
  );

  const acquiredToken = fake.task.readinessClaimToken;
  assert.equal(await handle.renew(), true);
  assert.notEqual(fake.task.readinessClaimToken, acquiredToken);

  const settlement = await fake.db.$transaction((tx) => handle.settle(tx, {
    kind: "finish",
    at: NOW,
    apply: async (client) => {
      await client.task.update({
        where: { id: fake.task.id },
        data: { status: TaskStatus.TODO },
      });
      return { value: "deferred" as const, ownership: "released" as const };
    },
  }));
  assert.deepEqual(settlement, {
    settled: true,
    claim: "released",
    value: "deferred",
    ownership: "released",
  });
  assert.equal(fake.task.status, TaskStatus.TODO);
  assert.equal(fake.task.readinessClaimToken, null);
  assert.equal(fake.task.readinessClaimExpiresAt, null);
});

test("only an expired readiness claim can be reclaimed", async () => {
  const fake = fakeDatabase();
  const first = await claimReadinessStep(fake.db, fake.task.id, NOW);
  assert.ok(first);
  assert.equal(await claimReadinessStep(fake.db, fake.task.id, NOW), null);

  const firstToken = fake.task.readinessClaimToken;
  const afterExpiry = new Date(NOW.getTime() + READINESS_CLAIM_LEASE_MS + 1);
  const successor = await claimReadinessStep(fake.db, fake.task.id, afterExpiry);
  assert.ok(successor);
  assert.notEqual(fake.task.readinessClaimToken, firstToken);
  assert.equal(await first.renew(), false);
  assert.equal(await successor.renew(), true);
});

test("claim loss classifies a concrete active successor as retained ownership", async () => {
  const fake = fakeDatabase({ chainId: "chain-1" });
  const handle = await claimReadinessStep(fake.db, fake.task.id, NOW);
  assert.ok(handle);
  fake.task.status = TaskStatus.DONE;
  fake.task.readinessClaimToken = null;
  fake.setSuccessor({ id: "run-2", taskId: "integrator-1", status: RunStatus.QUEUED });

  let applied = false;
  const settlement = await fake.db.$transaction((tx) => handle.settle(tx, {
    kind: "finish",
    at: NOW,
    apply: async () => {
      applied = true;
      return { value: undefined, ownership: "released" as const };
    },
  }));
  assert.equal(applied, false);
  assert.deepEqual(settlement, { settled: false, ownership: { retainFor: "run-2" } });
  assert.deepEqual(await handle.ownershipAfterLoss(fake.client), { retainFor: "run-2" });

  fake.setSuccessor(null);
  assert.equal(await handle.ownershipAfterLoss(fake.db), "released");
});

test("retained settlement returns ownership before clearing the claim", async () => {
  const fake = fakeDatabase({ chainId: "chain-1" });
  const handle = await claimReadinessStep(fake.db, fake.task.id, NOW);
  assert.ok(handle);
  fake.setSuccessor({ id: "run-2", taskId: "integrator-1", status: RunStatus.QUEUED });

  const settlement = await fake.db.$transaction((tx) => handle.settle(tx, {
    kind: "finish",
    at: NOW,
    apply: async (client) => {
      fake.events.push("transition-applied");
      await client.task.update({
        where: { id: fake.task.id },
        data: { status: TaskStatus.DONE },
      });
      return { value: "authorized" as const, ownership: { retainFor: "run-2" } };
    },
  }));
  assert.deepEqual(settlement, {
    settled: true,
    claim: "released",
    value: "authorized",
    ownership: { retainFor: "run-2" },
  });
  assert.deepEqual(fake.events, ["transition-applied", "claim-cleared"]);
});
