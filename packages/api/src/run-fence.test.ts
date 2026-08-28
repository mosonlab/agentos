import assert from "node:assert/strict";
import { test } from "node:test";

import { type Prisma, RunStatus } from "@anneal/db";

import { explainFenceRefusal, fencedRunWhere, type RunFence, withFencedRun } from "./run-fence.js";

const fence: RunFence = {
  runId: "run-1",
  runnerId: "runner-1",
  fencingToken: "3:run-1:current",
  at: new Date("2026-08-25T12:00:00.000Z"),
};

type Row = {
  runnerId: string | null;
  fencingToken: string | null;
  cancelRequestedAt: Date | null;
  leaseExpiresAt: Date | null;
  status: RunStatus;
};

const live: Row = {
  runnerId: "runner-1",
  fencingToken: "3:run-1:current",
  cancelRequestedAt: null,
  leaseExpiresAt: new Date("2026-08-25T12:05:00.000Z"),
  status: RunStatus.RUNNING,
};

const explain = (row: Row | null, asked: RunFence = fence) => explainFenceRefusal(
  { run: { findUnique: async () => row } } as unknown as Prisma.TransactionClient,
  asked,
);

test("one fenced read owns its clock and Run -> Task lock order", async () => {
  const calls: string[] = [];
  const predicates: Prisma.RunWhereInput[] = [];
  let read = 0;
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) => {
      if (query.join("?").includes('FROM "Run"')) {
        calls.push("lock.run");
        return [{ id: "run-1" }];
      }
      calls.push("lock.task");
      return [{ id: "task-1", archivedAt: null }];
    },
    run: {
      findFirst: async ({ where }: { where: Prisma.RunWhereInput }) => {
        predicates.push(where);
        calls.push(`read.${++read}`);
        return read === 1 ? { taskId: "task-1" } : { id: "run-1" };
      },
    },
  } as unknown as Prisma.TransactionClient;

  const result = await withFencedRun(tx, fence, { id: true }, (run) => {
    calls.push("body");
    return run.id;
  });

  assert.equal(result, "run-1");
  assert.deepEqual(calls, ["lock.run", "read.1", "lock.task", "read.2", "body"]);
  assert.equal(predicates.length, 2);
  assert.equal((predicates[0]?.leaseExpiresAt as { gt: Date }).gt, fence.at);
  assert.equal((predicates[1]?.leaseExpiresAt as { gt: Date }).gt, fence.at);
});

test("the predicate carries the six clauses that make a run this request's to write", () => {
  assert.deepEqual(fencedRunWhere(fence), {
    id: "run-1",
    runnerId: "runner-1",
    fencingToken: "3:run-1:current",
    cancelRequestedAt: null,
    leaseExpiresAt: { gt: fence.at },
    status: { in: [RunStatus.CLAIMED, RunStatus.PROVISIONING, RunStatus.RUNNING, RunStatus.WAITING_INBOX] },
  });
});

test("a session-principal fence asks nothing about a runner", () => {
  const sessionFence: RunFence = { runId: "run-1", fencingToken: "3:run-1:current", at: fence.at };
  assert.equal("runnerId" in fencedRunWhere(sessionFence), false);
});

test("a narrowed fence narrows the predicate and its explanation together", async () => {
  const startFence: RunFence = { ...fence, statuses: [RunStatus.CLAIMED, RunStatus.PROVISIONING] };
  assert.deepEqual(fencedRunWhere(startFence).status, { in: [RunStatus.CLAIMED, RunStatus.PROVISIONING] });
  assert.equal(await explain(live, startFence), "not-active");
});

test("every refusal cause is named rather than guessed", async () => {
  assert.equal(await explain(null), "unknown-run");
  assert.equal(await explain({ ...live, runnerId: "runner-2" }), "wrong-runner");
  assert.equal(await explain({ ...live, fencingToken: "2:run-1:superseded" }), "stale-fence");
  assert.equal(await explain({ ...live, cancelRequestedAt: new Date("2026-08-25T11:59:00.000Z") }), "cancel-requested");
  assert.equal(await explain({ ...live, leaseExpiresAt: new Date("2026-08-25T11:59:00.000Z") }), "lease-expired");
  assert.equal(await explain({ ...live, leaseExpiresAt: null }), "lease-expired");
  assert.equal(await explain({ ...live, status: RunStatus.CANCELLED }), "not-active");
});

test("an unowned run is wrong-runner before it is stale-fence", async () => {
  // Both clauses fail here. The more specific cause is the useful one: an
  // operator reading `wrong-runner` knows a second runner is alive on the run.
  assert.equal(
    await explain({ ...live, runnerId: "runner-2", fencingToken: "2:run-1:superseded" }),
    "wrong-runner",
  );
});
