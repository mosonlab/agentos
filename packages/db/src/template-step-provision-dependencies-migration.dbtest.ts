/**
 * The TaskTemplateStep dependency-provisioning migration is an additive,
 * behaviour-preserving upgrade. Stage the real migration history immediately
 * before it, seed a legacy template step, and deploy the exact committed SQL
 * so PostgreSQL proves both the backfill and the default on new rows.
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
const targetMigration = "20260901010000_task_template_step_dependency_provisioning";

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
  const schema = `template_step_dependencies_${label}_${process.pid}_${Date.now().toString(36)}`;
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

  const staging = mkdtempSync(join(tmpdir(), "template-step-dependencies-migration."));
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

test("TaskTemplateStep dependency provisioning defaults true and backfills legacy rows", async () => {
  const upgrade = await stageBeforeTargetMigration("upgrade");
  try {
    await upgrade.execute(`
      INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
      VALUES ('template-step-project', 'template-step-project', 'template-step-project', NOW());
      INSERT INTO "TaskTemplate" ("id", "projectId", "name", "description", "variables", "updatedAt")
      VALUES ('template-step-template', 'template-step-project', 'template-step', 'legacy', ARRAY[]::TEXT[], NOW());
      INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "stepIndex", "name", "assigneeType", "prompt", "layer")
      VALUES ('template-step-legacy', 'template-step-template', 1, 'Legacy', 'agent', 'legacy prompt', 1);
    `);
    upgrade.applyMigration();

    assert.deepEqual(
      await upgrade.query<{ provisionDependencies: boolean }>(
        'SELECT "provisionDependencies" FROM "TaskTemplateStep" WHERE "id" = \'template-step-legacy\'',
      ),
      [{ provisionDependencies: true }],
    );
    assert.deepEqual(
      await upgrade.query<{ is_nullable: string; column_default: string | null }>(`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = '${upgrade.schema}'
          AND table_name = 'TaskTemplateStep'
          AND column_name = 'provisionDependencies'
      `),
      [{ is_nullable: "NO", column_default: "true" }],
    );

    await upgrade.execute(`
      INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "stepIndex", "name", "assigneeType", "prompt", "layer")
      VALUES ('template-step-default', 'template-step-template', 2, 'Defaulted', 'agent', 'default prompt', 2);
      INSERT INTO "TaskTemplateStep" ("id", "taskTemplateId", "stepIndex", "name", "assigneeType", "prompt", "layer", "provisionDependencies")
      VALUES ('template-step-explicit-false', 'template-step-template', 3, 'Review', 'agent', 'review prompt', 3, false);
    `);
    assert.deepEqual(
      await upgrade.query<{ id: string; provisionDependencies: boolean }>(
        'SELECT "id", "provisionDependencies" FROM "TaskTemplateStep" ORDER BY "id"',
      ),
      [
        { id: "template-step-default", provisionDependencies: true },
        { id: "template-step-explicit-false", provisionDependencies: false },
        { id: "template-step-legacy", provisionDependencies: true },
      ],
    );
  } finally {
    await upgrade.cleanup();
  }

  const empty = await stageBeforeTargetMigration("empty");
  try {
    empty.applyMigration();
    assert.deepEqual(
      await empty.query<{ is_nullable: string; column_default: string | null }>(`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = '${empty.schema}'
          AND table_name = 'TaskTemplateStep'
          AND column_name = 'provisionDependencies'
      `),
      [{ is_nullable: "NO", column_default: "true" }],
    );
    assert.deepEqual(await empty.query<{ count: string }>('SELECT count(*)::text AS count FROM "TaskTemplateStep"'), [{ count: "0" }]);
  } finally {
    await empty.cleanup();
  }
});
