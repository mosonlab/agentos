/**
 * The dependency-provisioning migration is an upgrade, not just an empty
 * schema assertion. Stage the real history immediately before it, seed the
 * legacy Repo rows, and deploy the exact committed SQL so the expand/backfill/
 * contract ordering is exercised by PostgreSQL itself.
 *
 * Requires a disposable, non-public scratch PostgreSQL:
 *
 *   AGENTOS_ALLOW_SCRATCH_DATABASES=1 \
 *   TEST_DATABASE_URL=postgresql://...:55777/...?schema=... \
 *     npm run test:db -w @anneal/db
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PrismaClient } from "@prisma/client";

const packageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/u, "");
const targetMigration = "20260901000000_repo_dependency_provisioning";

const scratchServer = (): URL => {
  if (process.env["AGENTOS_ALLOW_SCRATCH_DATABASES"] !== "1") throw new Error("scratch-database-opt-in-required");
  const raw = process.env["TEST_DATABASE_URL"];
  if (!raw) throw new Error("scratch-test-database-url-required");
  const url = new URL(raw);
  if (!url.protocol.startsWith("postgres")) throw new Error("scratch-database-postgresql-required");
  if ((url.port || "5432") === "5432") throw new Error("scratch-database-refuses-port-5432");
  return url;
};

interface MigrationFixture {
  schema: string;
  execute(sql: string): Promise<void>;
  query<T>(sql: string): Promise<T[]>;
  applyMigration(): void;
  cleanup(): Promise<void>;
}

const stageBeforeTargetMigration = async (label: string): Promise<MigrationFixture> => {
  const server = scratchServer();
  const schema = `repo_dependency_${label}_${process.pid}_${Date.now().toString(36)}`;
  const databaseUrl = new URL(server.href);
  databaseUrl.searchParams.set("schema", schema);
  const url = databaseUrl.href;
  const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
  const client = new PrismaClient({ datasources: { db: { url } } });
  const execute = async (sql: string): Promise<void> => {
    for (const statement of sql.split(/;\s*/u).map((candidate) => candidate.trim()).filter(Boolean)) {
      await client.$executeRawUnsafe(statement);
    }
  };
  const query = async <T>(sql: string): Promise<T[]> => client.$queryRawUnsafe<T[]>(sql);

  await execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
  await execute(`CREATE SCHEMA ${quotedSchema}`);

  const staging = mkdtempSync(join(tmpdir(), "repo-dependency-migration."));
  cpSync(join(packageRoot, "prisma"), join(staging, "prisma"), { recursive: true });
  const stagedMigrations = join(staging, "prisma", "migrations");
  for (const entry of readdirSync(stagedMigrations, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name >= targetMigration) {
      rmSync(join(stagedMigrations, entry.name), { recursive: true, force: true });
    }
  }

  const deploy = (): void => {
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", join(staging, "prisma", "schema.prisma")], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  deploy();

  return {
    schema,
    execute,
    query,
    applyMigration: () => {
      cpSync(
        join(packageRoot, "prisma", "migrations", targetMigration),
        join(stagedMigrations, targetMigration),
        { recursive: true },
      );
      deploy();
    },
    cleanup: async (): Promise<void> => {
      rmSync(staging, { recursive: true, force: true });
      try {
        await execute(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      } finally {
        await client.$disconnect();
      }
    },
  };
};

test("dependency-provisioning migration backfills legacy Repos and applies to an empty database", async () => {
  const upgrade = await stageBeforeTargetMigration("upgrade");
  try {
    await upgrade.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('dependency-project', 'dependency-project', 'dependency-project', NOW());
      INSERT INTO "Repo" ("id", "projectId", "name", "remoteUrl", "mountPath", "defaultBranch", "updatedAt")
      VALUES
        ('dependency-agentos', 'dependency-project', 'agentos', 'https://github.com/mosonlab/agentos.git', '/agentos', 'main', NOW()),
        ('dependency-anneal', 'dependency-project', 'anneal', 'git@github.com:mosonlab/anneal.git', '/anneal', 'main', NOW()),
        ('dependency-word-factory', 'dependency-project', 'word-factory', 'https://github.com/mosonlab/word-factory.git', '/word-factory', 'main', NOW());
    `);
    upgrade.applyMigration();

    assert.deepEqual(
      await upgrade.query<{ id: string; dependencyProvisioning: string }>(
        'SELECT "id", "dependencyProvisioning" FROM "Repo" ORDER BY "id"',
      ),
      [
        { id: "dependency-agentos", dependencyProvisioning: "NPM_CI" },
        { id: "dependency-anneal", dependencyProvisioning: "NPM_CI" },
        { id: "dependency-word-factory", dependencyProvisioning: "NONE" },
      ],
    );
  } finally {
    await upgrade.cleanup();
  }

  const empty = await stageBeforeTargetMigration("empty");
  try {
    empty.applyMigration();

    assert.deepEqual(
      await empty.query<{ enumlabel: string }>(`
        SELECT e.enumlabel
        FROM pg_enum AS e
        JOIN pg_type AS t ON t.oid = e.enumtypid
        JOIN pg_namespace AS n ON n.oid = t.typnamespace
        WHERE n.nspname = '${empty.schema}' AND t.typname = 'DependencyProvisioning'
        ORDER BY e.enumsortorder
      `),
      [{ enumlabel: "NONE" }, { enumlabel: "NPM_CI" }],
    );

    assert.deepEqual(
      await empty.query<{ is_nullable: string; column_default: string | null }>(`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = '${empty.schema}'
          AND table_name = 'Repo'
          AND column_name = 'dependencyProvisioning'
      `),
      [{ is_nullable: "NO", column_default: null }],
    );
    assert.deepEqual(await empty.query<{ count: string }>('SELECT count(*)::text AS count FROM "Repo"'), [{ count: "0" }]);
  } finally {
    await empty.cleanup();
  }
});
