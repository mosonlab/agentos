import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@agentos/db";

import { isSerializationConflict } from "./serialization-retry.js";

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
