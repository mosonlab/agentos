import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@agentos/db";

import { runRunnerAvailabilityTransaction } from "./runner-availability-transaction.js";

const conflict = (): Prisma.PrismaClientKnownRequestError => new Prisma.PrismaClientKnownRequestError(
  "concurrent runner availability update",
  { code: "P2034", clientVersion: "6.19.0" },
);

test("runner availability retries two Serializable conflicts with bounded backoff", async () => {
  let attempts = 0;
  const database = {
    $transaction: async (operation: () => Promise<string>) => {
      attempts += 1;
      if (attempts < 3) throw conflict();
      return operation();
    },
  } as unknown as PrismaClient;
  const waits: number[] = [];
  const result = await runRunnerAvailabilityTransaction(
    database,
    async () => "stored",
    async (milliseconds) => { waits.push(milliseconds); },
  );
  assert.equal(result, "stored");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 75]);
});

test("runner availability surfaces a third conflict and never retries other errors", async () => {
  let conflicts = 0;
  const database = {
    $transaction: async () => { conflicts += 1; throw conflict(); },
  } as unknown as PrismaClient;
  await assert.rejects(
    runRunnerAvailabilityTransaction(database, async () => "unreachable", async () => undefined),
    (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034",
  );
  assert.equal(conflicts, 3);

  let failures = 0;
  const other = {
    $transaction: async () => { failures += 1; throw new Error("not retryable"); },
  } as unknown as PrismaClient;
  await assert.rejects(
    runRunnerAvailabilityTransaction(other, async () => "unreachable", async () => undefined),
    /not retryable/u,
  );
  assert.equal(failures, 1);
});
