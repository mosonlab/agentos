import assert from "node:assert/strict";
import test from "node:test";

import { type Prisma, type PrismaClient } from "@anneal/db";

import {
  createReadinessSettlementRunner,
  readinessSettlement,
  type ReadinessSettlementKind,
} from "./readiness-settlement.js";
import type {
  ReadinessClaimHandle,
  ReadinessClaimSettlement,
  ReadinessClaimTransition,
  ReadinessLeaseOwnership,
} from "./readiness-claim.js";

const transactionClient = {
  task: { findUnique: async () => null },
} as unknown as Prisma.TransactionClient;

const database = {
  $transaction: async (
    transaction: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) => transaction(transactionClient),
} as unknown as PrismaClient;

type ClaimCase = "settles" | "does-not-settle" | "retained";

const claimHandle = (
  claimCase: ClaimCase,
  ownership: ReadinessLeaseOwnership = { retainFor: "successor-run" },
): ReadinessClaimHandle => {
  const settle = async <T>(
    _tx: Prisma.TransactionClient,
    transition: ReadinessClaimTransition<T>,
  ): Promise<ReadinessClaimSettlement<T>> => {
    if (claimCase === "does-not-settle") return { settled: false, ownership };
    if (claimCase === "retained") {
      return { settled: true, claim: "retained", value: undefined as T };
    }
    if (transition.kind === "keep") {
      return { settled: true, claim: "retained", value: await transition.apply(transactionClient) };
    }
    const applied = await transition.apply(transactionClient);
    return {
      settled: true,
      claim: "released",
      value: applied.value,
      ownership: applied.ownership,
    };
  };
  return {
    renew: async () => true,
    settle,
    ownershipAfterLoss: async () => ownership,
  };
};

const kinds: ReadinessSettlementKind[] = ["stop", "requeue", "defer", "authorize"];
const positions = ["pre-acquire", "held"] as const;
const claimCases: ClaimCase[] = ["settles", "does-not-settle", "retained"];

test("the settlement runner owns the outcome, position, and claim-state matrix", async (t) => {
  for (const kind of kinds) {
    for (const position of positions) {
      for (const claimCase of claimCases) {
        await t.test(`${kind} / ${position} / ${claimCase}`, async () => {
          let bodyRuns = 0;
          const settlement = readinessSettlement(kind, {
            taskId: "regression-task",
            at: new Date("2026-08-29T00:00:00.000Z"),
            apply: async () => {
              bodyRuns += 1;
              return {
                ownership: "released",
                leaseOutcome: kind === "authorize"
                  ? { kind: "continue" }
                  : { kind: "stop", taskId: "regression-task" },
              };
            },
          });
          const runner = createReadinessSettlementRunner(database, {
            kind: position,
            release: async () => undefined,
          });

          if (claimCase === "retained" && !(position === "pre-acquire" && kind === "authorize")) {
            await assert.rejects(
              runner.apply(settlement, claimHandle(claimCase)),
              /retained a finished claim/u,
            );
            assert.equal(bodyRuns, 0);
            return;
          }

          const application = await runner.apply(settlement, claimHandle(claimCase));
          if (position === "pre-acquire" && kind === "authorize") {
            assert.deepEqual(application, { kind: "acquire-lease" });
            assert.equal(bodyRuns, 0);
            return;
          }

          assert.equal(application.kind, "settled");
          if (application.kind !== "settled") return;
          assert.deepEqual(application.outcome, {
            value: { applied: claimCase === "settles" },
            leaseOutcome: position === "held" && claimCase === "settles"
              ? { kind: "stop", taskId: "regression-task" }
              : { kind: "continue" },
          });
          assert.equal(bodyRuns, claimCase === "settles" ? 1 : 0);
        });
      }
    }
  }
});

test("a held runner releases when a lost claim reports released ownership", async () => {
  const runner = createReadinessSettlementRunner(database, {
    kind: "held",
    release: async () => undefined,
  });
  const settlement = readinessSettlement("stop", {
    taskId: "regression-task",
    at: new Date("2026-08-29T00:00:00.000Z"),
    apply: async () => ({
      ownership: "released",
      leaseOutcome: { kind: "stop", taskId: "regression-task" },
    }),
  });

  const application = await runner.apply(settlement, claimHandle("does-not-settle", "released"));
  assert.deepEqual(application, {
    kind: "settled",
    outcome: {
      value: { applied: false },
      leaseOutcome: { kind: "stop", taskId: "regression-task" },
    },
  });
});
