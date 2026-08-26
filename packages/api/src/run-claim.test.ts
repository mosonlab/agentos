import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@agentos/db";

import { claimRun } from "./run-claim.js";

/**
 * The retry loop, which was untestable while it was welded to the route: it
 * only ever ran with a real Serializable transaction underneath it, so the
 * behaviour it exists for — a lost conflict is not a claim failure — could not
 * be observed without provoking a real conflict.
 *
 * `$transaction` is the only thing these tests stub. The transaction body
 * never runs, which is the point: what is under test is what the module does
 * with a transaction that lost.
 */

const conflict = (code: string, sqlstate?: string) => new Prisma.PrismaClientKnownRequestError(
  "serialization failure",
  { code, clientVersion: "test", ...(sqlstate ? { meta: { code: sqlstate } } : {}) },
);

const dbThatFails = (errors: unknown[]) => {
  let attempts = 0;
  const db = {
    $transaction: async () => {
      attempts += 1;
      const error = errors[attempts - 1];
      if (error) throw error;
      return null;
    },
  } as unknown as PrismaClient;
  return { db, attempts: () => attempts };
};

const input = {
  body: { runnerId: "runner-1", leaseSeconds: 60 },
  claimantClass: "runner" as const,
  now: new Date("2026-08-26T00:00:00.000Z"),
};

test("a lost serialization conflict is retried rather than surfaced", async () => {
  const { db, attempts } = dbThatFails([conflict("P2034")]);
  assert.equal(await claimRun(db, input), null);
  assert.equal(attempts(), 2);
});

test("a raw-statement conflict arrives as P2010 and is retried too", async () => {
  const { db, attempts } = dbThatFails([conflict("P2010", "40001")]);
  assert.equal(await claimRun(db, input), null);
  assert.equal(attempts(), 2);
});

test("six attempts is the ceiling; the sixth loss is thrown", async () => {
  const { db, attempts } = dbThatFails(Array.from({ length: 6 }, () => conflict("P2034")));
  await assert.rejects(claimRun(db, input), (error: unknown) => (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
  ));
  assert.equal(attempts(), 6);
});

test("an error that is not a serialization conflict is not retried", async () => {
  const { db, attempts } = dbThatFails([new Error("boom")]);
  await assert.rejects(claimRun(db, input), /boom/);
  assert.equal(attempts(), 1);
});
