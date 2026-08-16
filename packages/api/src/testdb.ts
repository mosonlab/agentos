import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@agentos/db";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL
  ?? "postgresql://agentos:agentos@localhost:5432/agentos?schema=agentos_test";

let migrationsApplied = false;

export const setupTestDb = (): PrismaClient => {
  if (!migrationsApplied) {
    const schema = fileURLToPath(new URL("../../db/prisma/schema.prisma", import.meta.url));
    execSync(`npx prisma migrate deploy --schema ${JSON.stringify(schema)}`, {
      cwd: fileURLToPath(new URL("../../db", import.meta.url)),
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "inherit",
    });
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
