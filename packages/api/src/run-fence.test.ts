import assert from "node:assert/strict";
import { test } from "node:test";

import { type Prisma, RunStatus } from "@agentos/db";

import { explainFenceRefusal, fencedRunWhere, type RunFence } from "./run-fence.js";

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

test("one fence is one instant, however many predicates a request builds from it", async () => {
  const first = fencedRunWhere(fence);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = fencedRunWhere(fence);
  // The defect this module exists for: a request that built one predicate from
  // a captured `now` and another from `new Date()` could call the same lease
  // live in one and expired in the other.
  assert.deepEqual(first.leaseExpiresAt, { gt: fence.at });
  assert.deepEqual(second.leaseExpiresAt, first.leaseExpiresAt);
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
