import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { PrismaClient } from "@agentos/db";

import { createApp } from "./test-app.js";
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
    VALUES (
      'a-untouched', 'p-untouched', 'e-untouched', 'senior-dev-luna', 'Untouched',
      'gpt-5.6-luna:max', 'fast', 'codex', '', '',
      (SELECT "finished_at" - INTERVAL '1 second' FROM "_prisma_migrations"
       WHERE "migration_name" = '${serviceTierMigration}' AND "finished_at" IS NOT NULL),
      NULL
    ), (
      'a-explicit', 'p-explicit', 'e-explicit', 'senior-dev-luna', 'Explicit',
      'gpt-5.6-luna:max', 'fast', 'codex', '', '',
      (SELECT "finished_at" + INTERVAL '1 second' FROM "_prisma_migrations"
       WHERE "migration_name" = '${serviceTierMigration}' AND "finished_at" IS NOT NULL),
      NULL
    ), (
      'a-archived', 'p-archived', 'e-archived', 'senior-dev-luna', 'Archived',
      'gpt-5.6-luna:max', 'fast', 'codex', '', '',
      (SELECT "finished_at" - INTERVAL '1 second' FROM "_prisma_migrations"
       WHERE "migration_name" = '${serviceTierMigration}' AND "finished_at" IS NOT NULL),
      NOW()
    ), (
      'a-unrelated', 'p-unrelated', 'e-unrelated', 'senior-dev-high', 'Unrelated',
      'gpt-5.6-sol:high', 'fast', 'codex', '', '',
      (SELECT "finished_at" - INTERVAL '1 second' FROM "_prisma_migrations"
       WHERE "migration_name" = '${serviceTierMigration}' AND "finished_at" IS NOT NULL),
      NULL
    );
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

test("a pre-migration executioner Run stays historical while operator retry snapshots both current profiles", async () => {
  fixture.cleanup();
  fixture = stageBeforeTargetMigration();
  fixture.execute(`
    INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
    VALUES ('p-run', 'run upgrade', 'run-upgrade', NOW());

    INSERT INTO "Environment" ("id", "projectId", "name", "updatedAt")
    VALUES ('e-run', 'p-run', 'env', NOW());

    INSERT INTO "Agent" ("id", "projectId", "environmentId", "name", "title", "model",
                         "codexServiceTier", "runnerPreference", "foundationalPrompt", "rolePrompt",
                         "updatedAt")
    VALUES (
      'a-run', 'p-run', 'e-run', 'implementation-plan-executioner', 'Executioner',
      'gpt-5.6-sol:medium', 'default', 'codex', 'foundation', 'role', NOW()
    );

    INSERT INTO "Task" ("id", "projectId", "assigneeAgentId", "name", "description", "status", "updatedAt")
    VALUES ('t-run', 'p-run', 'a-run', 'Execution', 'work', 'doing', NOW());

    INSERT INTO "Run" (
      "id", "projectId", "taskId", "agentId", "runNumber", "dedupeKey", "status",
      "runner", "model", "codexServiceTier", "subprocessModel", "subprocessCodexServiceTier",
      "promptHash", "updatedAt"
    ) VALUES (
      'r-old', 'p-run', 't-run', 'a-run', 1, 'task:t-run:run:1', 'queued',
      'codex', 'gpt-5.6-sol:medium', 'default', 'gpt-5.6-luna:max', 'default',
      'historical-prompt', NOW()
    );
  `);

  fixture.applyTargetMigration();

  const historical = await query((client) => client.run.findUniqueOrThrow({ where: { id: "r-old" } }));
  assert.equal(historical.subprocessModel, "gpt-5.6-luna:max");
  assert.equal(historical.subprocessCodexServiceTier, "DEFAULT");
  assert.equal(historical.elevatedSubprocessModel, null);
  assert.equal(historical.elevatedSubprocessCodexServiceTier, null);

  await query(async (client) => {
    await client.run.update({
      where: { id: "r-old" },
      data: { status: "FAILED", failureClass: "TASK_FAILED", retryable: false, endedAt: new Date() },
    });
    await client.task.update({ where: { id: "t-run" }, data: { status: "REVIEW" } });
  });

  const workspaceRoot = mkdtempSync(join(tmpdir(), "subprocess-upgrade-workspace."));
  const priorToken = process.env.OPERATOR_TOKEN;
  process.env.OPERATOR_TOKEN = "subprocess-upgrade-operator-token";
  try {
    const response = await query(async (client) => await createApp(client, { workspaceRoot }).request(
      "/tasks/t-run/retry",
      {
        method: "POST",
        headers: { Authorization: "Bearer subprocess-upgrade-operator-token" },
      },
    ));
    assert.equal(response.status, 201, await response.text());
  } finally {
    if (priorToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = priorToken;
    rmSync(workspaceRoot, { recursive: true, force: true });
  }

  const retried = await query((client) => client.run.findFirstOrThrow({
    where: { taskId: "t-run", runNumber: 2 },
  }));
  assert.equal(retried.runner, "CODEX");
  assert.equal(retried.model, "gpt-5.6-sol:medium");
  assert.equal(retried.codexServiceTier, "DEFAULT");
  assert.equal(retried.subprocessModel, "gpt-5.6-luna:max");
  assert.equal(retried.subprocessCodexServiceTier, "DEFAULT");
  assert.equal(retried.elevatedSubprocessModel, "gpt-5.6-sol:high");
  assert.equal(retried.elevatedSubprocessCodexServiceTier, "DEFAULT");
});
