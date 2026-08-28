import assert from "node:assert/strict";
import test from "node:test";

import { Prisma, type PrismaClient } from "@anneal/db";

import {
  isSerializationConflict,
  readCommitted,
  serializable,
  SerializableTransactionExhaustedError,
} from "./transaction.js";

const knownRequestError = (code: string, meta?: Record<string, unknown>) => (
  new Prisma.PrismaClientKnownRequestError("Raw query failed", meta
    ? { code, clientVersion: "test", meta }
    : { code, clientVersion: "test" })
);

test("a raw-statement serialization failure is a retryable conflict, not a 500", () => {
  // The chain mutex is `SELECT ... FOR UPDATE`, so Postgres reports its loss as
  // SQLSTATE 40001 wrapped in P2010 rather than as Prisma's own P2034. A caller
  // that matches only P2034 turns a lost race into a failed claim.
  assert.equal(isSerializationConflict(knownRequestError("P2010", {
    code: "40001",
    message: "could not serialize access due to read/write dependencies among transactions",
  })), true);
  assert.equal(isSerializationConflict(knownRequestError("P2010", {
    code: "40P01",
    message: "deadlock detected",
  })), true);
  assert.equal(isSerializationConflict(knownRequestError("P2034")), true);
});

test("an ordinary failure is not retried as a serialization conflict", () => {
  assert.equal(isSerializationConflict(knownRequestError("P2010", {
    code: "23505",
    message: "duplicate key value violates unique constraint",
  })), false);
  assert.equal(isSerializationConflict(knownRequestError("P2010")), false);
  assert.equal(isSerializationConflict(knownRequestError("P2002")), false);
  assert.equal(isSerializationConflict(new Error("connection reset")), false);
});

test("serializable owns the isolation level, retry loop, and exhaustion result", async () => {
  const conflict = knownRequestError("P2010", { code: "40001" });
  const isolationLevels: Prisma.TransactionIsolationLevel[] = [];
  let attempts = 0;
  const db = {
    $transaction: async (
      operation: (tx: Prisma.TransactionClient) => Promise<string>,
      options: { isolationLevel: Prisma.TransactionIsolationLevel },
    ) => {
      attempts += 1;
      isolationLevels.push(options.isolationLevel);
      if (attempts < 3) throw conflict;
      return operation({} as Prisma.TransactionClient);
    },
  } as unknown as PrismaClient;

  assert.equal(await serializable(db, async () => "stored", { attempts: 3 }), "stored");
  assert.equal(attempts, 3);
  assert.deepEqual(isolationLevels, Array.from({ length: 3 }, () => Prisma.TransactionIsolationLevel.Serializable));

  attempts = 0;
  await assert.rejects(
    serializable(db, async () => "unreachable", { attempts: 2 }),
    (error: unknown) => error instanceof SerializableTransactionExhaustedError && error.conflict === conflict,
  );
  assert.equal(attempts, 2);

  const mapped = new Error("caller-specific exhaustion");
  attempts = 0;
  await assert.rejects(
    serializable(db, async () => "unreachable", { attempts: 1, onExhausted: () => mapped }),
    (error: unknown) => error === mapped,
  );
  assert.equal(attempts, 1);
});

test("serializable accepts a domain conflict without broadening its SQLSTATE table", async () => {
  const uniqueConflict = knownRequestError("P2002");
  let attempts = 0;
  const db = {
    $transaction: async (operation: (tx: Prisma.TransactionClient) => Promise<string>) => {
      attempts += 1;
      if (attempts === 1) throw uniqueConflict;
      return operation({} as Prisma.TransactionClient);
    },
  } as unknown as PrismaClient;

  assert.equal(await serializable(db, async () => "stored", {
    alsoRetry: (error) => error === uniqueConflict,
  }), "stored");
  assert.equal(attempts, 2);
});

test("readCommitted owns its isolation level and never retries", async () => {
  let isolationLevel: Prisma.TransactionIsolationLevel | undefined;
  const db = {
    $transaction: async (
      operation: (tx: Prisma.TransactionClient) => Promise<string>,
      options: { isolationLevel: Prisma.TransactionIsolationLevel },
    ) => {
      isolationLevel = options.isolationLevel;
      return operation({} as Prisma.TransactionClient);
    },
  } as unknown as PrismaClient;

  assert.equal(await readCommitted(db, async () => "stored"), "stored");
  assert.equal(isolationLevel, Prisma.TransactionIsolationLevel.ReadCommitted);
});
