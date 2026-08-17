import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@agentos/db";

const defaultTestDatabaseUrl = new URL("postgresql://agentos:agentos@localhost:5432/agentos?schema=agentos_test");
// Every AgentOS workspace used to drop the same host-wide schema. The package's
// concurrency=1 flag serializes files only inside one workspace, so a sibling
// test process could still drop our tables mid-suite. Derive a stable,
// PostgreSQL-safe private schema unless the caller explicitly supplies one.
defaultTestDatabaseUrl.searchParams.set(
  "schema",
  `agentos_test_${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)}`,
);
export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? defaultTestDatabaseUrl.toString();

const parsedTestDatabaseUrl = new URL(testDatabaseUrl);
export const testDatabaseSchema = parsedTestDatabaseUrl.searchParams.get("schema") ?? "public";

if (testDatabaseSchema === "public") {
  throw new Error("TEST_DATABASE_URL must name a dedicated non-public schema because the DB harness resets it");
}

let migrationsApplied = false;

/**
 * Drops and re-applies the dedicated test schema.
 *
 * This is what `prisma migrate reset` did, spelled out: drop the schema named in
 * TEST_DATABASE_URL, recreate it, then `migrate deploy`. It is written this way
 * because `migrate reset` refuses to run under an AI coding agent, which would
 * otherwise make every *.dbtest.ts unrunnable in an agent session. `deploy` is
 * non-interactive, needs no shadow database, and applies exactly the committed
 * migration folders — so this is the same reset with one fewer dependency.
 *
 * The blast radius is bounded above: the module refuses a `public` schema, so
 * the only thing this can drop is a schema created for these tests.
 */
const resetSchema = (): void => {
  const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));
  const quoted = `"${testDatabaseSchema.replaceAll('"', '""')}"`;
  execSync(
    `npx prisma db execute --url ${JSON.stringify(testDatabaseUrl)} --stdin`,
    {
      cwd: dbDirectory,
      input: `DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted};`,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  execSync("npx prisma migrate deploy", {
    cwd: dbDirectory,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });
};

export const setupTestDb = (): PrismaClient => {
  if (!migrationsApplied) {
    resetSchema();
    migrationsApplied = true;
  }
  return new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
};

export const resetTestDb = async (db: PrismaClient): Promise<void> => {
  const url = new URL(testDatabaseUrl);
  const schema = url.searchParams.get("schema") ?? "public";
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = ${schema} AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const quoted = tables.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
};
