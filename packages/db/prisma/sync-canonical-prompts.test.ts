import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrismaClient } from "@prisma/client";

import { main, parseInstallFullProjectId } from "./sync-canonical-prompts.js";

const asPrisma = (value: unknown): PrismaClient => value as PrismaClient;

test("--install-full parsing accepts only the exact optional argument pair", () => {
  assert.equal(parseInstallFullProjectId([]), null);
  assert.equal(parseInstallFullProjectId(["--install-full", "project-1"]), "project-1");
  assert.throws(() => parseInstallFullProjectId(["--install-full"]), /requires exactly one Project id/u);
  assert.throws(() => parseInstallFullProjectId(["--install-full", "project-1", "extra"]), /requires exactly one Project id/u);
  assert.throws(() => parseInstallFullProjectId(["extra", "--install-full", "project-1"]), /Unknown argument extra/u);
});

test("an unknown full-install target is refused before a transaction opens", async () => {
  let transactions = 0;
  const database = asPrisma({
    project: { findUnique: async () => null },
    $transaction: async () => {
      transactions += 1;
      throw new Error("transaction-must-not-open");
    },
  });

  await assert.rejects(main(database, "missing-project"), /Project missing-project was not found/u);
  assert.equal(transactions, 0);
});

test("ordinary synchronization opens one 120-second transaction per discovered Project without an isolation override", async () => {
  let transactions = 0;
  let transactionOptions: unknown;
  const transactionClient = {
    project: { findUnique: async () => null },
  };
  const database = asPrisma({
    project: { findMany: async () => [{ id: "canonical-project", slug: "agentos-example" }] },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>, options: unknown) => {
      transactions += 1;
      transactionOptions = options;
      return callback(transactionClient);
    },
  });

  await assert.rejects(main(database, null), /Project agentos-example: Project was not found/u);
  assert.equal(transactions, 1);
  assert.deepEqual(transactionOptions, { timeout: 120_000 });
  assert.equal(Object.hasOwn(transactionOptions as object, "isolationLevel"), false);
});

test("full installation re-reads the target inside the transaction before any mutation", async () => {
  const events: string[] = [];
  const transactionClient = {
    project: {
      findUnique: async () => {
        events.push("tx.project.findUnique");
        return null;
      },
    },
  };
  const database = asPrisma({
    project: {
      findUnique: async () => {
        events.push("outer.project.findUnique");
        return { id: "deleted-project" };
      },
      findMany: async () => {
        events.push("outer.project.findMany");
        return [{ id: "deleted-project", slug: "agentos-example" }];
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      events.push("transaction");
      return callback(transactionClient);
    },
  });

  await assert.rejects(main(database, "deleted-project"), /Project deleted-project was not found/u);
  assert.deepEqual(events, ["outer.project.findUnique", "outer.project.findMany", "transaction", "tx.project.findUnique"]);
});

for (const fixture of [
  { name: "zero Environments", environments: [] },
  { name: "multiple Environments", environments: [{ id: "environment-1", name: "one" }, { id: "environment-2", name: "two" }] },
] as const) {
  test(`full installation refuses ${fixture.name} before observing a mutation`, async () => {
    const events: string[] = [];
    const database = asPrisma({
      project: {
        findUnique: async () => ({ id: "project-1" }),
        findMany: async () => [{ id: "project-1", slug: "agentos-example" }],
      },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        project: {
          findUnique: async () => {
            events.push("project-read");
            return { id: "project-1", slug: "agentos-example", environments: fixture.environments };
          },
        },
      }),
    });

    await assert.rejects(main(database, "project-1"), /Project agentos-example: Project has .*Environment/u);
    assert.deepEqual(events, ["project-read"]);
  });
}

test("full installation refuses an archived canonical Agent before observing a mutation", async () => {
  const events: string[] = [];
  const database = asPrisma({
    project: {
      findUnique: async () => ({ id: "project-1" }),
      findMany: async () => [{ id: "project-1", slug: "agentos-example" }],
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      project: {
        findUnique: async () => {
          events.push("project-read");
          return {
            id: "project-1",
          slug: "agentos-example",
            environments: [{ id: "environment-1", name: "local" }],
          };
        },
      },
      agent: {
        findFirst: async () => {
          events.push("archived-agent-read");
          return { id: "archived-agent-1", name: "senior-dev" };
        },
      },
    }),
  });

  await assert.rejects(main(database, "project-1"), /Project agentos-example: Agent senior-dev \(archived-agent-1\) is archived/u);
  assert.deepEqual(events, ["project-read", "archived-agent-read"]);
});
