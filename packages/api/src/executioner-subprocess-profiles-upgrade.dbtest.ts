import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { testDatabaseUrl } from "./testdb.js";

/**
 * The subprocess-profile migration repairs the service tier only for an
 * untouched Luna row inherited from the earlier service-tier migration. A
 * fresh-schema deploy cannot prove that distinction, so this fixture stages
 * the real migration history immediately before the repair, seeds both sides
 * of its recorded completion time, and then deploys the forward migration.
 */

const targetMigration = "20260823033000_executioner_subprocess_profiles";
const serviceTierMigration = "20260823010000_codex_service_tier";
const dbDirectory = fileURLToPath(new URL("../../db", import.meta.url));

interface UpgradeFixture {
  url: string;
  quoted: string;
  execute: (sql: string) => void;
  applyTargetMigration: () => void;
  cleanup: () => void;
}

const stageBeforeTargetMigration = (): UpgradeFixture => {
  const base = new URL(testDatabaseUrl);
  const schema = `${base.searchParams.get("schema") ?? "public"}_subprocess_upgrade`;
  if (schema.startsWith("public")) throw new Error("the subprocess upgrade fixture refuses to touch the public schema");
  base.searchParams.set("schema", schema);
  const url = base.toString();
  const quoted = `"${schema.replaceAll('"', '""')}"`;

  const execute = (sql: string): void => {
    execFileSync("npx", ["prisma", "db", "execute", "--url", url, "--stdin"], {
      cwd: dbDirectory,
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };

  execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted};`);
  const staging = mkdtempSync(join(tmpdir(), "subprocess-upgrade-fixture."));
  cpSync(join(dbDirectory, "prisma"), join(staging, "prisma"), { recursive: true });
  rmSync(join(staging, "prisma", "migrations", targetMigration), { recursive: true, force: true });

  const deploy = (): void => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(staging, "prisma", "schema.prisma")], {
      cwd: dbDirectory,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  deploy();

  return {
    url,
    quoted,
    execute,
    applyTargetMigration: () => {
      cpSync(
        join(dbDirectory, "prisma", "migrations", targetMigration),
        join(staging, "prisma", "migrations", targetMigration),
        { recursive: true },
      );
      deploy();
    },
    cleanup: () => {
      rmSync(staging, { recursive: true, force: true });
      try {
        execute(`DROP SCHEMA IF EXISTS ${quoted} CASCADE;`);
      } catch {
        // A test schema that will not drop must not fail the suite.
      }
    },
  };
};

let fixture: UpgradeFixture;

const query = async <T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> => {
  const client = new PrismaClient({ datasources: { db: { url: fixture.url } } });
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
};

after(() => fixture?.cleanup());

test("the subprocess-profile migration repairs only untouched inherited Luna Fast state", async () => {
  fixture = stageBeforeTargetMigration();
  fixture.execute(`
    INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
    VALUES ('p-untouched', 'untouched', 'untouched', NOW()),
           ('p-explicit', 'explicit', 'explicit', NOW()),
           ('p-archived', 'archived', 'archived', NOW()),
           ('p-unrelated', 'unrelated', 'unrelated', NOW());

    INSERT INTO "Environment" ("id", "projectId", "name", "updatedAt")
    VALUES ('e-untouched', 'p-untouched', 'env', NOW()),
           ('e-explicit', 'p-explicit', 'env', NOW()),
           ('e-archived', 'p-archived', 'env', NOW()),
           ('e-unrelated', 'p-unrelated', 'env', NOW());

    INSERT INTO "Agent" ("id", "projectId", "environmentId", "name", "title", "model",
                         "codexServiceTier", "runnerPreference", "foundationalPrompt", "rolePrompt",
                         "updatedAt", "archivedAt")
    SELECT 'a-untouched', 'p-untouched', 'e-untouched', 'senior-dev-luna', 'Untouched',
           'gpt-5.6-luna:max', 'fast', 'codex', '', '', migration."finished_at" - INTERVAL '1 second', NULL
    FROM "_prisma_migrations" AS migration
    WHERE migration."migration_name" = '${serviceTierMigration}' AND migration."finished_at" IS NOT NULL
    UNION ALL
    SELECT 'a-explicit', 'p-explicit', 'e-explicit', 'senior-dev-luna', 'Explicit',
           'gpt-5.6-luna:max', 'fast', 'codex', '', '', migration."finished_at" + INTERVAL '1 second', NULL
    FROM "_prisma_migrations" AS migration
    WHERE migration."migration_name" = '${serviceTierMigration}' AND migration."finished_at" IS NOT NULL
    UNION ALL
    SELECT 'a-archived', 'p-archived', 'e-archived', 'senior-dev-luna', 'Archived',
           'gpt-5.6-luna:max', 'fast', 'codex', '', '', migration."finished_at" - INTERVAL '1 second', NOW()
    FROM "_prisma_migrations" AS migration
    WHERE migration."migration_name" = '${serviceTierMigration}' AND migration."finished_at" IS NOT NULL
    UNION ALL
    SELECT 'a-unrelated', 'p-unrelated', 'e-unrelated', 'senior-dev-high', 'Unrelated',
           'gpt-5.6-sol:high', 'fast', 'codex', '', '', migration."finished_at" - INTERVAL '1 second', NULL
    FROM "_prisma_migrations" AS migration
    WHERE migration."migration_name" = '${serviceTierMigration}' AND migration."finished_at" IS NOT NULL;
  `);

  const before = await query((client) => client.$queryRawUnsafe<Array<{ id: string; tier: string }>>(
    `SELECT "id", "codexServiceTier"::text AS tier FROM ${fixture.quoted}."Agent" ORDER BY "id"`,
  ));
  assert.deepEqual(before, [
    { id: "a-archived", tier: "fast" },
    { id: "a-explicit", tier: "fast" },
    { id: "a-unrelated", tier: "fast" },
    { id: "a-untouched", tier: "fast" },
  ]);

  fixture.applyTargetMigration();

  const afterMigration = await query((client) => client.$queryRawUnsafe<Array<{ id: string; tier: string }>>(
    `SELECT "id", "codexServiceTier"::text AS tier FROM ${fixture.quoted}."Agent" ORDER BY "id"`,
  ));
  assert.deepEqual(afterMigration, [
    { id: "a-archived", tier: "fast" },
    { id: "a-explicit", tier: "fast" },
    { id: "a-unrelated", tier: "fast" },
    { id: "a-untouched", tier: "default" },
  ]);
});
