// The chain-layer migration harness, shared by the two dbtest files that
// exercise it. It moved out of migration.dbtest.ts when that file was split:
// its five tests each stage the real migration history up to the migration
// before expand — a `prisma migrate deploy` replay — and together they were
// 45 of the 54 seconds that file cost the gate. node:test parallelises across
// files and not within one, so the split is what lets them run beside each
// other; this module is what lets them share the fixture that makes them
// expensive.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@anneal/db";

import { splitSqlStatements } from "./sql-statements.js";
import { testDatabaseUrl } from "./testdb.js";

export const chainLayerExpandMigration = "20260823100000_chain_layer_expand";
export const chainLayerContractMigration = "20260824100000_chain_layer_contract";
export const retiredFollowUpColumn = ["follow", "UpTaskId"].join("");
export const retiredFollowUpIndex = `Task_${retiredFollowUpColumn}_key`;
export const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));

export interface ChainLayerMigrationFixture {
  schema: string;
  url: string;
  quotedSchema: string;
  execute(sql: string): Promise<void>;
  applyExpandMigration(): void;
  applyContractMigration(): void;
  cleanup(): Promise<void>;
}

/**
 * Stage the real migration history immediately before the expand migration.
 * The fixture copies the committed Prisma tree into a temporary directory,
 * removes this migration and every later one, then adds this migration back
 * only when the test is ready to exercise it. A unique schema derived from
 * the explicitly opted-in test URL keeps the fixture away from live data.
 */
export const stageBeforeChainLayerExpand = async (): Promise<ChainLayerMigrationFixture> => {
  const base = new URL(testDatabaseUrl);
  const sourceSchema = base.searchParams.get("schema");
  if (!sourceSchema || sourceSchema === "public") throw new Error("chain-layer migration fixture refuses public schema");
  const schema = `agentos_chain_layer_${process.pid}_${Date.now().toString(36)}`;
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quotedSchema = `"${schema.replaceAll('"', '""')}"`;

  // One connection for the fixture's lifetime rather than a `prisma db execute`
  // per call. The spawned form accepts a multi-statement block, which is why it
  // was used; it also costs about two seconds of npx and engine startup every
  // time, and this fixture is called once per case across five files. The
  // statements are cut here instead — see `splitSqlStatements`.
  const client = new PrismaClient({ datasources: { db: { url } } });
  const execute = async (sql: string): Promise<void> => {
    for (const statement of splitSqlStatements(sql)) await client.$executeRawUnsafe(statement);
  };

  await execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE; CREATE SCHEMA ${quotedSchema};`);
  const staging = mkdtempSync(join(tmpdir(), "chain-layer-expand-fixture."));
  cpSync(join(dbDirectory, "prisma"), join(staging, "prisma"), { recursive: true });
  for (const entry of readdirSync(join(staging, "prisma", "migrations"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name >= chainLayerExpandMigration) {
      rmSync(join(staging, "prisma", "migrations", entry.name), { recursive: true, force: true });
    }
  }

  const deploy = (): void => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(staging, "prisma", "schema.prisma")], {
      cwd: dbDirectory,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  deploy();

  return {
    schema,
    url,
    quotedSchema,
    execute,
    applyExpandMigration: () => {
      cpSync(
        join(dbDirectory, "prisma", "migrations", chainLayerExpandMigration),
        join(staging, "prisma", "migrations", chainLayerExpandMigration),
        { recursive: true },
      );
      deploy();
    },
    applyContractMigration: () => {
      cpSync(
        join(dbDirectory, "prisma", "migrations", chainLayerContractMigration),
        join(staging, "prisma", "migrations", chainLayerContractMigration),
        { recursive: true },
      );
      deploy();
    },
    cleanup: async (): Promise<void> => {
      rmSync(staging, { recursive: true, force: true });
      try {
        await execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE;`);
      } catch {
        // A failed fixture must not leave its private schema behind if the
        // server has already terminated the connection.
      } finally {
        await client.$disconnect();
      }
    },
  };
};

export const migrationQuery = async <T>(fixture: { url: string }, sql: string): Promise<T[]> => {
  const client = new PrismaClient({ datasources: { db: { url: fixture.url } } });
  try {
    return await client.$queryRawUnsafe<T[]>(sql);
  } finally {
    await client.$disconnect();
  }
};

export const migrationSnapshot = async (fixture: ChainLayerMigrationFixture): Promise<{ steps: string[]; tasks: string[] }> => ({
  steps: (await migrationQuery<{ row: string }>(fixture,
    'SELECT row_to_json(step)::text AS row FROM "TaskTemplateStep" AS step ORDER BY step."id"'))
    .map(({ row }) => row),
  tasks: (await migrationQuery<{ row: string }>(fixture,
    'SELECT row_to_json(task)::text AS row FROM "Task" AS task ORDER BY task."id"'))
    .map(({ row }) => row),
});

export const migrationColumns = async (fixture: ChainLayerMigrationFixture): Promise<string[]> => (
  await migrationQuery<{ column_name: string }>(fixture, `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = '${fixture.schema.replaceAll("'", "''")}'
      AND (table_name, column_name) IN (
        ('TaskTemplateStep', 'layer'),
        ('Task', 'chainLayer')
      )
    ORDER BY table_name, column_name
  `)
).map(({ column_name }) => column_name);

export const migrationFailureOutput = (error: unknown): string => {
  const candidate = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  return [candidate.stdout, candidate.stderr, candidate.message]
    .filter((value): value is string | Buffer => value !== undefined)
    .map((value) => value.toString())
    .join("\n");
};

export const migrationHarnessEnabled = (
  process.env.AGENTOS_ALLOW_SCRATCH_DATABASES === "1"
  && Boolean(process.env.TEST_DATABASE_URL)
  && Boolean(process.env.TEST_DATABASE_MAINTENANCE_URL)
);
