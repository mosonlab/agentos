import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

import { PrismaClient } from "@anneal/db";

import { preKernelRun, preKernelSeed, stageAtPreviousMigration } from "./goal-execution-fixture.js";

/**
 * The Goal 5a0 migration is an *upgrade*, and an upgrade is only proved by
 * running it against a database that already holds pre-kernel rows.
 *
 * `migration.dbtest.ts` asserts the post-migration catalog and inserts its
 * fixtures after every migration has been applied, so it cannot see an ordering
 * defect between a constraint and the backfill that fills the columns the
 * constraint governs. This file applies the thirteen migrations that precede the
 * kernel, seeds closed history exactly as it exists on a pre-kernel database,
 * and only then runs `prisma migrate deploy` for the kernel migration itself —
 * the real code path, in Prisma's own transaction.
 */

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

let fixture: ReturnType<typeof stageAtPreviousMigration>;
const quotedSchema = (): string => fixture.quoted;

const query = async <T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> => {
  const client = new PrismaClient({ datasources: { db: { url: fixture.url } } });
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
};

after(() => fixture?.cleanup());

test("the kernel migration upgrades a database that already holds Goal-linked Runs", async () => {
  fixture = stageAtPreviousMigration("upgrade");
  // Two closed Tasks on one Goal, each with a Goal-linked Run: the ordinary
  // pre-kernel shape. Before the ordering fix this alone failed the migration,
  // because Run_goal_lineage_all_or_none_check was validated while every
  // freshly added goalGeneration/goalIteration was still null.
  fixture.execute(preKernelSeed + [
    preKernelRun("r-old", "t-old", "g-up", 1),
    preKernelRun("r-old-2", "t-old", "g-up", 2),
    preKernelRun("r-new", "t-new", "g-up", 1),
  ].join("\n"));

  fixture.applyKernelMigration();

  const tasks = await query((client) => client.$queryRawUnsafe<Array<{
    id: string; goalId: string | null; goalGeneration: number | null; goalIteration: number | null;
    goalDispatchState: string | null; goalDispatchKey: string | null; goalDispatchRequestHash: string | null;
    goalPredecessorTaskId: string | null;
  }>>(`SELECT "id", "goalId", "goalGeneration", "goalIteration", "goalDispatchState",
              "goalDispatchKey", "goalDispatchRequestHash", "goalPredecessorTaskId"
       FROM ${quotedSchema()}."Task" ORDER BY "createdAt", "id"`));

  assert.deepEqual(tasks, [
    {
      id: "t-old", goalId: "g-up", goalGeneration: 0, goalIteration: 1,
      goalDispatchState: "migrated-closed", goalDispatchKey: "migration:t-old",
      // Computed by pgcrypto inside the migration; compared against Node's own
      // SHA-256 so the two implementations are proved to agree.
      goalDispatchRequestHash: sha256("migration:t-old"),
      goalPredecessorTaskId: null,
    },
    {
      id: "t-new", goalId: "g-up", goalGeneration: 0, goalIteration: 2,
      goalDispatchState: "migrated-closed", goalDispatchKey: "migration:t-new",
      goalDispatchRequestHash: sha256("migration:t-new"),
      goalPredecessorTaskId: "t-old",
    },
  ]);

  const runs = await query((client) => client.$queryRawUnsafe<Array<{
    id: string; goalGeneration: number | null; goalIteration: number | null;
  }>>(`SELECT "id", "goalGeneration", "goalIteration" FROM ${quotedSchema()}."Run" ORDER BY "id"`));
  assert.deepEqual(runs, [
    { id: "r-new", goalGeneration: 0, goalIteration: 2 },
    { id: "r-old", goalGeneration: 0, goalIteration: 1 },
    { id: "r-old-2", goalGeneration: 0, goalIteration: 1 },
  ]);

  // The deferred constraint is not merely present: it is validated, so it now
  // covers the pre-existing rows and not only future writes.
  const validated = await query((client) => client.$queryRawUnsafe<Array<{ conname: string; convalidated: boolean }>>(
    `SELECT c.conname, c.convalidated FROM pg_constraint c
     JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = '${fixture.schema}' AND c.conname LIKE '%goal_lineage%' ORDER BY c.conname`,
  ));
  assert.ok(validated.length >= 3);
  assert.ok(validated.every((row) => row.convalidated), `every lineage constraint is validated: ${JSON.stringify(validated)}`);
});

test("an ambiguous pre-kernel Run aborts the migration with schema and data unchanged", async () => {
  fixture.cleanup();
  fixture = stageAtPreviousMigration("upgrade");
  // One Task whose Runs disagree: one carries the Goal, one does not. The
  // backfill refuses to fill a null Run from its sibling, so the deferred
  // VALIDATE is what must reject this — and reject it atomically.
  fixture.execute(preKernelSeed + [
    preKernelRun("r-mixed", "t-old", "g-up", 1),
    preKernelRun("r-null", "t-old", null, 2),
  ].join("\n"));

  assert.throws(() => fixture.applyKernelMigration(), /Run_goal_lineage_all_or_none_check|migration/u);

  const columns = await query((client) => client.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = '${fixture.schema}' AND table_name = 'Run' AND column_name = 'goalGeneration'`,
  ));
  assert.deepEqual(columns, [], "the failed migration rolled back its schema change");

  const types = await query((client) => client.$queryRawUnsafe<Array<{ typname: string }>>(
    `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = '${fixture.schema}' AND t.typname = 'GoalDispatchState'`,
  ));
  assert.deepEqual(types, [], "the failed migration rolled back its enum");

  const runs = await query((client) => client.$queryRawUnsafe<Array<{ id: string; goalId: string | null }>>(
    `SELECT "id", "goalId" FROM ${quotedSchema()}."Run" ORDER BY "id"`,
  ));
  assert.deepEqual(runs, [{ id: "r-mixed", goalId: "g-up" }, { id: "r-null", goalId: null }], "the data is unchanged");
});
